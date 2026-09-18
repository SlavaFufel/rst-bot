import { log } from '../logger.js';
import { expireDue } from './licenses.js';
import { langOf } from '../access/users.js';
import { L } from '../telegram/i18n.js';

const TICK_MS = 60_000;

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
    for (const { redeemed_by: userId } of due) {
      if (userId == null) continue;
      log.info(`Subscription expired for user ${userId} — freezing session`);
      this.sessions.freeze(userId, 'expired');
      this.notify(
        userId,
        L(
          langOf(userId),
          '⛔ Подписка истекла. Бот остановлен. Продли подписку, чтобы возобновить работу.',
          '⛔ Subscription expired. The bot has stopped. Renew your subscription to resume.',
        ),
      );
    }
  }
}
