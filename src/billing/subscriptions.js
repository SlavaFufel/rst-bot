import { log } from '../logger.js';
import { expireDue, renewDue, activeLicenseByUser } from './licenses.js';
import { plans } from './payments.js';
import { langOf } from '../access/users.js';
import { L } from '../telegram/i18n.js';

const TICK_MS = 60_000;
const RENEW_WARN_MS = 3 * 86_400_000; // remind 3 days before the end
const TRIAL_WARN_MS = 86_400_000; // a trial is short: remind 1 day before

// Periodically sweeps expired subscriptions: freezes the user's session and
// notifies them. Renewal (re-redeem) resumes the session elsewhere.
export class SubscriptionService {
  constructor({ sessionManager, notify }) {
    this.sessions = sessionManager;
    this.notify = notify ?? (() => {});
    this.timer = null;
  }

  start() {
    this.tick(); // sweep immediately on boot (catches lapses during downtime)
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    let due;
    try {
      due = expireDue();
    } catch (err) {
      log.warn('SubscriptionService tick failed:', err.message);
      return;
    }
    for (const { redeemed_by: userId, plan } of due) {
      if (userId == null) continue;
      if (activeLicenseByUser(userId)) continue; // another license (renewal, new key) still covers them
      log.info(`Subscription expired for user ${userId} — freezing session`);
      this.sessions.freeze(userId, 'expired');
      if (plan === 'trial') {
        this.notify(
          userId,
          L(
            langOf(userId),
            '⛔ Пробный период закончился, бот остановлен. Все настройки и привязка сохранены — после оплаты всё заработает сразу' + (plans().length ? ': /buy' : '.'),
            '⛔ The trial has ended and the bot has stopped. Your settings and pairing are kept — everything resumes right after payment' + (plans().length ? ': /buy' : '.'),
          ),
        );
        continue;
      }
      this.notify(
        userId,
        L(
          langOf(userId),
          '⛔ Подписка истекла. Бот остановлен. Продли подписку, чтобы возобновить работу' + (plans().length ? ': /buy' : '.'),
          '⛔ Subscription expired. The bot has stopped. Renew your subscription to resume' + (plans().length ? ': /buy' : '.'),
        ),
      );
    }

    let soon = [];
    try {
      soon = renewDue(RENEW_WARN_MS, TRIAL_WARN_MS);
    } catch (err) {
      log.warn('SubscriptionService renew check failed:', err.message);
    }
    for (const { redeemed_by: userId, expires_at: expiresAt, plan } of soon) {
      if (userId == null) continue;
      if (activeLicenseByUser(userId)?.expires_at !== expiresAt) continue; // a later / lifetime license covers them
      const days = Math.max(1, Math.ceil((expiresAt - Date.now()) / 86_400_000));
      const how = plans().length ? ' /buy' : '';
      if (plan === 'trial') {
        const hours = Math.max(1, Math.round((expiresAt - Date.now()) / 3_600_000));
        this.notify(
          userId,
          L(
            langOf(userId),
            `🎁 Пробный период закончится через ${hours} ч. Чтобы бот продолжил работать:${how || ' напиши админу.'}`,
            `🎁 Your trial ends in ${hours} h. To keep the bot running:${how || ' contact the admin.'}`,
          ),
        );
        continue;
      }
      this.notify(
        userId,
        L(
          langOf(userId),
          `⏳ Подписка закончится через ${days} дн. Продли заранее, чтобы бот не остановился:${how || ' напиши админу.'}`,
          `⏳ Your subscription ends in ${days} day(s). Renew early so the bot keeps running:${how || ' contact the admin.'}`,
        ),
      );
    }
  }
}
