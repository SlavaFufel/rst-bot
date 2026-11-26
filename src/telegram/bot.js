import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config.js';
import { log } from '../logger.js';
import { db } from '../store/db.js';
import { SUBSCRIBABLE } from '../core/eventbus.js';
import { createGate } from '../access/gate.js';
import { isAdmin, displayName, mirrorEnabled, setMirror, getLang, setLang, getUser, ensureUser, langOf } from '../access/users.js';
import { genKey, redeem, revoke, rebind, activeLicenseByUser, listKeys, grantDays, revokeDays, trialAvailable, startTrial } from '../billing/licenses.js';
import { plans as starPlans, invoicePayload, planFromPayload, recordPayment, getPayment, markRefunded, recentPayments } from '../billing/payments.js';
import { issueCode } from '../pair/codes.js';
import {
  addMember, removeMember, listMembers, countMembers, ownerForViewer,
  createInvite, getActiveInvite, resolveInvite, MAX_FAMILY_VIEWERS,
} from '../store/members.js';
import { raidCost, structureList, structureCount } from '../util/raidcalc.js';
import { craftInfo, recycleInfo, decayInfo, durabilityInfo, fmtDuration } from '../util/rustlabs.js';
import { addNote, listNotes, deleteNote, addPin, listPins, deletePin, sessionStats } from '../features/journal.js';
import { quickMatchSteamId, fetchSessions, playerServers } from '../enemy/battlemetrics.js';
import { renderProfile } from '../enemy/analytics.js';
import { findTeammates } from '../enemy/teamfinder.js';
import { addEnemy, listEnemies, removeEnemy, findEnemy, getEnemy, getEnemySessions, setEnemyGroup } from '../enemy/store.js';
import { resolveBmServerId } from '../enemy/resolve.js';
import { resolveSteamId, getSummary, getSummaries, getRustStats, getPlaytimeMinutes, renderSteamProfile, getBans, renderTrust } from '../enemy/steamstats.js';
import { listDevices, typeName, storageMonitors, setStorageWatch } from '../devices/store.js';
import { saveScene, getScene, listScenes, deleteScene, setRaidScene, getRaidScene } from '../devices/scenes.js';
import { addRule, listRules, countRules, deleteRule, setRuleEnabled, resolveTarget, MAX_RULES } from '../devices/automations.js';
import { itemName, itemNameRu } from '../util/items.js';
import { findMonuments } from '../util/monuments.js';
import { findInStorage, resolveMonitors, recycleStorage } from '../features/storage.js';
import { gridCenterXY } from '../util/grid.js';
import { dayNight, dayNightLabel } from '../util/daynight.js';
import { addCamera, listCameras, removeCamera, resolveCamera } from '../features/cameras.js';
import { HTML, esc, panel, expand } from './ui.js';
import { t, L, normLang, LANGS, langName } from './i18n.js';
import { buildHelp } from './help.js';

function numFmt(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

// Raid category key → bilingual section title + icon (used by /raid tables).
const RAID_SECTIONS = {
  boom: { ru: 'Взрывчатка', en: 'Explosives', icon: '💣' },
  fire: { ru: 'Огонь', en: 'Fire', icon: '🔥' },
  tool: { ru: 'Инструменты', en: 'Tools', icon: '🔨' },
  gun: { ru: 'Оружие', en: 'Guns', icon: '🔫' },
};

// Chosen UI language for a context (falls back to ru until the user picks).
const uiLang = (ctx) => normLang(getLang(ctx.from?.id));

// Inline reply translation: tl(ctx, 'РУ', 'EN') → string in the user's language.
const tl = (ctx, ru, en) => L(uiLang(ctx), ru, en);

// Friendly display name for a stored telegram id (falls back to #id).
const nameOf = (id) => getUser(id)?.name || `#${id}`;

// Owner-only guard: a family viewer cannot pair/unpair or manage the family.
// Returns true (and replies) if the caller is a viewer, so handlers can bail.
const blockViewer = (ctx) => {
  if (ownerForViewer(ctx.from.id) == null) return false;
  ctx.reply(tl(ctx, '⛔ Это может только владелец подписки (главный в семье).', '⛔ Only the subscription owner (family head) can do this.'));
  return true;
};

// First-run language picker, shown in both languages so anyone can read it.
const langKeyboard = () => {
  const kb = new InlineKeyboard();
  for (const l of LANGS) kb.text(langName[l], `lang:${l}`);
  return kb;
};
const sendLangPicker = (ctx) =>
  ctx.reply(`${t('ru', 'pick_prompt')}\n${t('en', 'pick_prompt')}`, { reply_markup: langKeyboard() });

// Russian plural for "day": 1 день, 3 дня, 5 дней.
const dniRu = (n) => {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return 'день';
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return 'дня';
  return 'дней';
};
// Human name of a license plan for /sub.
const PLAN_NAMES = {
  trial: ['пробный период 🎁', 'trial 🎁'],
  stars: ['подписка ⭐', 'subscription ⭐'],
  standard: ['ключ', 'key'],
};
const planName = (plan, lang) => PLAN_NAMES[plan]?.[lang === 'ru' ? 0 : 1] ?? plan;

// Localised welcome screen (HTML).
const startText = (lang) =>
  `🤖 <b>${t(lang, 'start_title')}</b>\n${t(lang, 'start_tagline')}\n\n` +
  (config.trial.days ? `🎁 ${L(lang, `${config.trial.days} ${dniRu(config.trial.days)} бесплатно, без оплаты:`, `${config.trial.days} days free, no payment:`)} /trial\n` : '') +
  (starPlans().length ? `💳 ${t(lang, 'start_buy')} /buy\n` : '') +
  `▶️ ${t(lang, 'start_redeem')} /redeem «key»\n` +
  `📋 ${t(lang, 'start_help')} /help\n\n` +
  `ℹ️ ${t(lang, 'start_disclaimer')}`;
const sendStart = (ctx, lang) => ctx.reply(startText(lang), HTML);

const getSubStmt = db.prepare('SELECT enabled FROM subscriptions WHERE user_id = ? AND event_type = ?');
const setSubStmt = db.prepare(
  'INSERT INTO subscriptions (user_id, event_type, enabled) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id, event_type) DO UPDATE SET enabled = excluded.enabled',
);
const friendsStmt = db.prepare('SELECT steam_id, label FROM tracked_friends');
const addFriendStmt = db.prepare(
  'INSERT OR REPLACE INTO tracked_friends (steam_id, label, notify) VALUES (?, ?, 1)',
);

function isEnabled(userId, type) {
  const row = getSubStmt.get(userId, type);
  return row ? row.enabled === 1 : true; // default ON
}

function buildSubsKeyboard(userId) {
  const keyboard = new InlineKeyboard();
  SUBSCRIBABLE.forEach((sub, index) => {
    const on = isEnabled(userId, sub.type);
    keyboard.text(`${on ? '✅' : '❌'} ${sub.label}`, `sub:${sub.type}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}

function formatExpiry(ms, lang = 'ru') {
  if (ms == null) return L(lang, 'бессрочно', 'lifetime');
  return new Date(ms).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ru-RU');
}

export function createBot({ sessions, enemies }) {
  const presence = enemies?.presence;
  // ip:queryPort of the server this user follows (their own, or the family owner's).
  const serverKeyOf = (userId) => presence?.keyForOwner(sessions.sessionForUser(userId)?.ownerUserId ?? userId) ?? null;
  const bot = new Bot(config.telegram.token);

  // Force a one-time language choice before anything else. The picker callback
  // is exempt so the user can actually answer; runs before the access gate so
  // even not-yet-subscribed users pick a language first.
  bot.use((ctx, next) => {
    if (ctx.callbackQuery?.data?.startsWith('lang:')) return next();
    if (ctx.preCheckoutQuery || ctx.message?.successful_payment) return next(); // never block a payment
    const id = ctx.from?.id;
    if (id && !getLang(id)) return sendLangPicker(ctx);
    return next();
  });

  // Access gate: admins + active subscribers pass; others get public commands only.
  bot.use(createGate());

  bot.command('start', (ctx) => {
    const chosen = getLang(ctx.from.id);
    return chosen ? sendStart(ctx, normLang(chosen)) : sendLangPicker(ctx);
  });

  bot.command('lang', (ctx) => sendLangPicker(ctx));

  bot.command('help', (ctx) => ctx.reply(buildHelp(uiLang(ctx), isAdmin(ctx.from.id)), HTML));

  // --- Subscription / licensing ---
  bot.command('redeem', (ctx) => {
    const key = ctx.match?.trim();
    if (!key) return ctx.reply(tl(ctx, 'Использование: /redeem <ключ>', 'Usage: /redeem <key>'));
    const res = redeem(key, ctx.from.id, displayName(ctx));
    if (!res.ok) return ctx.reply('❌ ' + tl(ctx, res.reason, res.reasonEn || res.reason));
    sessions.resume(ctx.from.id); // un-freeze if this is a renewal
    return ctx.reply(
      tl(
        ctx,
        `✅ Подписка активна (до ${formatExpiry(res.license.expires_at, 'ru')}).\n` +
          'Дальше: /pair — привязать Rust+, затем зайди на сервер и нажми «Pair with Server».',
        `✅ Subscription active (until ${formatExpiry(res.license.expires_at, 'en')}).\n` +
          'Next: /pair — pair Rust+, then join the server and press "Pair with Server".',
      ),
    );
  });

  // --- Sales: subscription for Telegram Stars (XTR, no payment provider needed) ---
  const planLabel = (ctx, p) => tl(ctx, `${p.days} дн. — ${p.stars} ⭐`, `${p.days} days — ${p.stars} ⭐`);

  bot.command('buy', (ctx) => {
    const list = starPlans();
    if (!list.length) return ctx.reply(tl(ctx, 'Оплата сейчас недоступна. Ключ можно получить у админа: /redeem <ключ>', 'Payments are unavailable right now. Get a key from the admin: /redeem <key>'));
    const lic = activeLicenseByUser(ctx.from.id);
    if (lic && lic.expires_at == null) return ctx.reply(tl(ctx, '✅ У тебя бессрочная подписка — продлевать не нужно.', '✅ You have a lifetime subscription — nothing to renew.'));
    const kb = new InlineKeyboard();
    if (trialAvailable(ctx.from.id, config.trial.days)) {
      kb.text(tl(ctx, `🎁 ${config.trial.days} ${dniRu(config.trial.days)} бесплатно`, `🎁 ${config.trial.days} days free`), 'buy:trial').row();
    }
    for (const p of list) kb.text(planLabel(ctx, p), `buy:${p.days}`).row();
    const head = lic
      ? tl(ctx, `Подписка активна до ${formatExpiry(lic.expires_at, 'ru')}. Купленные дни добавятся к ней.`, `Subscription active until ${formatExpiry(lic.expires_at, 'en')}. Bought days are added on top.`)
      : tl(ctx, 'Выбери срок подписки. Оплата — Telegram Stars прямо в чате.', 'Pick a subscription length. Pay with Telegram Stars right in the chat.');
    const family = tl(ctx, '👥 Одна подписка — на всю тиму: ты + до 4 тиммейтов в Telegram (/family).', '👥 One subscription covers your team: you + up to 4 teammates in Telegram (/family).');
    return ctx.reply(`💳 ${head}\n${family}`, { reply_markup: kb });
  });

  // Free trial: same access as a paid subscription for config.trial.days.
  const trial = async (ctx) => {
    const days = config.trial.days;
    if (!days) return ctx.reply(tl(ctx, 'Пробного периода сейчас нет. Подписка: /buy', 'There is no trial right now. Subscription: /buy'));
    const lic = startTrial(ctx.from.id, days, displayName(ctx));
    if (!lic) {
      return ctx.reply(tl(
        ctx,
        'Пробный период доступен один раз и только тем, у кого ещё не было подписки. Оформить: /buy',
        'The trial is available once, and only if you never had a subscription. Subscribe: /buy',
      ));
    }
    log.info(`Trial started: ${ctx.from.id} (${days}d)`);
    if (config.telegram.adminId && config.telegram.adminId !== ctx.from.id) {
      bot.api.sendMessage(config.telegram.adminId, `🎁 Trial: ${displayName(ctx)} (${ctx.from.id}), ${days} дн.`).catch(() => {});
    }
    sessions.resume(ctx.from.id);
    return ctx.reply(tl(
      ctx,
      `🎁 Пробный период активен до ${formatExpiry(lic.expires_at, 'ru')} — всё как в платной подписке.\n` +
        'Дальше: /pair — привязать Rust+, затем зайди на сервер и нажми «Pair with Server».',
      `🎁 Trial active until ${formatExpiry(lic.expires_at, 'en')} — everything a paid subscription has.\n` +
        'Next: /pair — pair Rust+, then join the server and press "Pair with Server".',
    ));
  };
  bot.command('trial', trial);
  bot.callbackQuery('buy:trial', async (ctx) => {
    await ctx.answerCallbackQuery();
    return trial(ctx);
  });

  bot.callbackQuery(/^buy:(\d+)$/, async (ctx) => {
    const plan = starPlans().find((p) => p.days === Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    if (!plan) return ctx.reply(tl(ctx, 'Этот тариф больше не продаётся. /buy — актуальные.', 'This plan is no longer sold. /buy — current plans.'));
    return ctx.replyWithInvoice(
      tl(ctx, `Rust+ бот — ${plan.days} дн.`, `Rust+ Bot — ${plan.days} days`),
      tl(ctx, 'Подписка: уведомления, тим-чат, умный дом, автоматизации, разведка. Дни добавляются к текущей подписке.', 'Subscription: alerts, team chat, smart home, automations, recon. Days are added to your current subscription.'),
      invoicePayload(plan),
      'XTR',
      [{ label: planLabel(ctx, plan), amount: plan.stars }],
    );
  });

  // Last check before Telegram charges: the plan must still exist at this price.
  bot.on('pre_checkout_query', (ctx) => {
    const q = ctx.preCheckoutQuery;
    const plan = planFromPayload(q.invoice_payload);
    if (plan && q.currency === 'XTR' && q.total_amount === plan.stars) return ctx.answerPreCheckoutQuery(true);
    return ctx.answerPreCheckoutQuery(false, {
      error_message: tl(ctx, 'Тариф изменился — открой /buy заново.', 'The plan has changed — open /buy again.'),
    });
  });

  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    // Days come from what was actually paid for, not the current config.
    const days = Number(/^sub:(\d+):/.exec(sp.invoice_payload)?.[1]);
    if (!days) return log.warn(`Unknown payment payload: ${sp.invoice_payload}`);
    if (!recordPayment(sp.telegram_payment_charge_id, ctx.from.id, sp.total_amount, days)) return undefined; // duplicate
    const lic = grantDays(ctx.from.id, days, displayName(ctx));
    log.info(`Stars payment: ${ctx.from.id} paid ${sp.total_amount}⭐ for ${days}d (${sp.telegram_payment_charge_id})`);
    if (config.telegram.adminId && config.telegram.adminId !== ctx.from.id) {
      bot.api
        .sendMessage(config.telegram.adminId, `💰 ${displayName(ctx)} (${ctx.from.id}): ${sp.total_amount}⭐ → ${days} дн.\n<code>${esc(sp.telegram_payment_charge_id)}</code>`, HTML)
        .catch(() => {});
    }
    if (!lic) {
      return ctx.reply(tl(ctx, 'Оплата получена, но у тебя бессрочная подписка. Напиши /paysupport — вернём звёзды.', 'Payment received, but you already have a lifetime subscription. Use /paysupport and we will refund the Stars.'));
    }
    sessions.resume(ctx.from.id); // renewal after a lapse un-freezes the session
    const paired = sessions.byOwner.has(ctx.from.id);
    return ctx.reply(
      tl(
        ctx,
        `✅ Спасибо! Подписка активна до ${formatExpiry(lic.expires_at, 'ru')}.` + (paired ? '' : '\nДальше: /pair — привязать Rust+, затем зайди на сервер и нажми «Pair with Server».'),
        `✅ Thank you! Subscription active until ${formatExpiry(lic.expires_at, 'en')}.` + (paired ? '' : '\nNext: /pair — pair Rust+, then join the server and press "Pair with Server".'),
      ),
    );
  });

  // Telegram requires bots that sell for Stars to answer /paysupport.
  bot.command('paysupport', (ctx) =>
    ctx.reply(
      tl(
        ctx,
        `💬 Вопросы по оплате и возвраты: напиши админу${config.telegram.adminId ? ` (tg://user?id=${config.telegram.adminId})` : ''}. Укажи дату оплаты — возврат делаем в Stars.`,
        `💬 Payment questions and refunds: contact the admin${config.telegram.adminId ? ` (tg://user?id=${config.telegram.adminId})` : ''}. Include the payment date — refunds are made in Stars.`,
      ),
    ),
  );

  bot.command('payments', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(tl(ctx, 'Только для админа.', 'Admins only.'));
    const rows = recentPayments();
    if (!rows.length) return ctx.reply(tl(ctx, 'Оплат пока нет.', 'No payments yet.'));
    const lines = rows.map((p) => `${p.status === 'refunded' ? '↩️' : '💰'} ${new Date(p.created_at).toLocaleDateString('ru-RU')} ${p.telegram_id} — ${p.stars}⭐ / ${p.days}d\n<code>${esc(p.charge_id)}</code>`);
    return ctx.reply(lines.join('\n'), HTML);
  });

  bot.command('refund', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(tl(ctx, 'Только для админа.', 'Admins only.'));
    const chargeId = ctx.match?.trim();
    if (!chargeId) return ctx.reply(tl(ctx, 'Использование: /refund <charge_id> (из /payments)', 'Usage: /refund <charge_id> (from /payments)'));
    const p = getPayment(chargeId);
    if (!p) return ctx.reply(tl(ctx, 'Оплата не найдена.', 'Payment not found.'));
    if (p.status === 'refunded') return ctx.reply(tl(ctx, 'Уже возвращено.', 'Already refunded.'));
    try {
      await bot.api.refundStarPayment(p.telegram_id, chargeId);
    } catch (err) {
      return ctx.reply(tl(ctx, 'Telegram отказал в возврате: ', 'Telegram rejected the refund: ') + err.message);
    }
    markRefunded(chargeId);
    revokeDays(p.telegram_id, p.days);
    bot.api.sendMessage(p.telegram_id, L(langOf(p.telegram_id), `↩️ Возврат ${p.stars}⭐ выполнен, ${p.days} дн. сняты с подписки.`, `↩️ Refunded ${p.stars}⭐, ${p.days} days removed from your subscription.`)).catch(() => {});
    return ctx.reply(tl(ctx, `↩️ Возвращено ${p.stars}⭐ пользователю ${p.telegram_id}.`, `↩️ Refunded ${p.stars}⭐ to ${p.telegram_id}.`));
  });

  bot.command('sub', (ctx) => {
    const lic = activeLicenseByUser(ctx.from.id);
    if (!lic) return ctx.reply(tl(ctx, 'Активной подписки нет. Купить: /buy · активировать ключ: /redeem <ключ>', 'No active subscription. Buy: /buy · activate a key: /redeem <key>'));
    const left = lic.expires_at
      ? `${Math.max(0, Math.ceil((lic.expires_at - Date.now()) / 86_400_000))} ${tl(ctx, 'дн.', 'd.')}`
      : '∞';
    const account = lic.account_player_id
      ? `<code>${esc(lic.account_player_id)}</code>`
      : tl(ctx, 'не привязан', 'not linked');
    return ctx.reply(
      tl(
        ctx,
        `🔑 <b>Моя подписка</b>\n` +
          panel(
            `📜 План: <b>${esc(planName(lic.plan, 'ru'))}</b>\n` +
              `📅 До: <b>${esc(formatExpiry(lic.expires_at, 'ru'))}</b> · осталось ${left}\n` +
              `🎮 Аккаунт: ${account}`,
          ),
        `🔑 <b>My subscription</b>\n` +
          panel(
            `📜 Plan: <b>${esc(planName(lic.plan, 'en'))}</b>\n` +
              `📅 Until: <b>${esc(formatExpiry(lic.expires_at, 'en'))}</b> · ${left} left\n` +
              `🎮 Account: ${account}`,
          ),
      ),
      HTML,
    );
  });

  // --- Family (seat sharing): owner + up to MAX_FAMILY_VIEWERS viewers, TG-only ---
  bot.command('family', (ctx) => {
    const id = ctx.from.id;
    const viewerOwner = ownerForViewer(id);
    if (viewerOwner != null) {
      // A viewer: status only, no management.
      return ctx.reply(
        tl(
          ctx,
          `👨‍👩‍👧 Ты наблюдатель в семье <b>${esc(nameOf(viewerOwner))}</b>.\n` +
            'Команды бота работают здесь, в этом чате. Привязку сервера меняет только владелец.\n\nВыйти: /leave',
          `👨‍👩‍👧 You're a viewer in <b>${esc(nameOf(viewerOwner))}</b>'s family.\n` +
            'Bot commands work here in this chat. Only the owner manages the server pairing.\n\nLeave: /leave',
        ),
        HTML,
      );
    }

    const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'new' || sub === 'code' || sub === 'код') {
      const code = createInvite(id);
      return ctx.reply(tl(ctx, `🔁 Новый код приглашения: <code>${code}</code>`, `🔁 New invite code: <code>${code}</code>`), HTML);
    }

    if (sub === 'kick' || sub === 'remove' || sub === 'удалить') {
      const raw = args.slice(1).join(' ');
      const target = raw.toLowerCase();
      if (!target) return ctx.reply(tl(ctx, 'Использование: /family kick «id или имя»', 'Usage: /family kick «id or name»'));
      const members = listMembers(id);
      const hit = members.find((m) => String(m.user_id) === target)
        || members.find((m) => nameOf(m.user_id).toLowerCase().includes(target));
      if (!hit) return ctx.reply(tl(ctx, `В семье нет «${raw}».`, `No family member matching “${raw}”.`));
      removeMember(id, hit.user_id);
      bot.api.sendMessage(hit.user_id, L(langOf(hit.user_id), 'Тебя удалили из семьи.', 'You were removed from the family.')).catch(() => {});
      return ctx.reply(tl(ctx, `➖ ${nameOf(hit.user_id)} удалён из семьи.`, `➖ ${nameOf(hit.user_id)} removed.`));
    }

    // Default: family panel (members + invite code).
    const members = listMembers(id);
    const code = getActiveInvite(id) || createInvite(id);
    const memberLines = members.length
      ? members.map((m, i) => `${i + 1}. ${esc(nameOf(m.user_id))}`).join('\n')
      : tl(ctx, '<i>пока никого</i>', '<i>nobody yet</i>');
    return ctx.reply(
      tl(
        ctx,
        `👨‍👩‍👧 <b>Моя семья</b> <i>(мест: ${members.length}/${MAX_FAMILY_VIEWERS})</i>\n` +
          panel(memberLines) +
          `\n🔗 Код приглашения: <code>${code}</code>\n` +
          `<i>Тиммейт вводит у себя:</i> <code>/join ${code}</code>\n\n` +
          'Новый код: /family new · Удалить: /family kick «id|имя»',
        `👨‍👩‍👧 <b>My family</b> <i>(seats: ${members.length}/${MAX_FAMILY_VIEWERS})</i>\n` +
          panel(memberLines) +
          `\n🔗 Invite code: <code>${code}</code>\n` +
          `<i>A teammate runs:</i> <code>/join ${code}</code>\n\n` +
          'New code: /family new · Remove: /family kick «id|name»',
      ),
      HTML,
    );
  });

  bot.command('join', (ctx) => {
    const id = ctx.from.id;
    const code = ctx.match?.trim();
    if (!code) return ctx.reply(tl(ctx, 'Использование: /join «код приглашения»', 'Usage: /join «invite code»'));
    if (sessions.byOwner.has(id) || activeLicenseByUser(id)) {
      return ctx.reply(tl(ctx, 'У тебя своя подписка — ты владелец, а не наблюдатель.', 'You have your own subscription — you are an owner, not a viewer.'));
    }
    const ownerId = resolveInvite(code);
    if (ownerId == null) return ctx.reply(tl(ctx, 'Код недействителен или истёк.', 'Invalid or expired code.'));
    if (ownerId === id) return ctx.reply(tl(ctx, 'Это твой собственный код.', "That's your own code."));
    if (!activeLicenseByUser(ownerId)) return ctx.reply(tl(ctx, 'У владельца кода нет активной подписки.', 'The code owner has no active subscription.'));
    const current = ownerForViewer(id);
    if (current === ownerId) return ctx.reply(tl(ctx, 'Ты уже в этой семье.', "You're already in this family."));
    if (current != null) return ctx.reply(tl(ctx, 'Ты уже в другой семье. Сначала /leave.', "You're already in another family. /leave first."));
    if (countMembers(ownerId) >= MAX_FAMILY_VIEWERS) {
      return ctx.reply(tl(ctx, `В семье уже максимум участников (${MAX_FAMILY_VIEWERS}).`, `This family is full (${MAX_FAMILY_VIEWERS}).`));
    }
    addMember(ownerId, id);
    ensureUser(id, displayName(ctx));
    bot.api.sendMessage(ownerId, `➕ ${displayName(ctx)} ${L(langOf(ownerId), 'присоединился к твоей семье.', 'joined your family.')}`).catch(() => {});
    return ctx.reply(tl(ctx, '✅ Ты в семье! Команды бота теперь работают в этом чате. /help — список.', '✅ Joined! Bot commands now work in this chat. /help for the list.'));
  });

  bot.command('leave', (ctx) => {
    const ownerId = ownerForViewer(ctx.from.id);
    if (ownerId == null) return ctx.reply(tl(ctx, 'Ты не состоишь в семье.', "You're not in a family."));
    removeMember(ownerId, ctx.from.id);
    bot.api.sendMessage(ownerId, `➖ ${displayName(ctx)} ${L(langOf(ownerId), 'вышел из твоей семьи.', 'left your family.')}`).catch(() => {});
    return ctx.reply(tl(ctx, 'Ты вышел из семьи.', "You've left the family."));
  });

  bot.command('rebind', (ctx) => {
    if (blockViewer(ctx)) return;
    const lic = activeLicenseByUser(ctx.from.id);
    if (!lic) return ctx.reply(tl(ctx, 'Нет активной подписки.', 'No active subscription.'));
    rebind(ctx.from.id);
    return ctx.reply(tl(ctx, '🔓 Привязка к аккаунту сброшена. Зайди на сервер нужным аккаунтом и нажми Pair.', '🔓 Account pairing reset. Join the server with the right account and press Pair.'));
  });

  bot.command('pair', (ctx) => {
    if (blockViewer(ctx)) return;
    if (!isAdmin(ctx.from.id) && !activeLicenseByUser(ctx.from.id)) {
      return ctx.reply(tl(ctx, 'Сначала оформи подписку: /buy или /redeem <ключ>', 'Get a subscription first: /buy or /redeem <key>'));
    }
    const code = issueCode(ctx.from.id);
    const download = config.helper.url || tl(ctx, '(ссылка на помощник появится позже)', '(helper link coming soon)');
    return ctx.reply(
      tl(
        ctx,
        `🔗 Код привязки: <code>${code}</code> (действует 10 минут)\n\n` +
          `1. Скачай помощник: ${download}\n` +
          '2. Запусти его и введи код\n' +
          '3. Войди в Steam, затем зайди на сервер и нажми «Pair with Server»',
        `🔗 Pairing code: <code>${code}</code> (valid for 10 minutes)\n\n` +
          `1. Download the helper: ${download}\n` +
          '2. Run it and enter the code\n' +
          '3. Sign in to Steam, then join the server and press "Pair with Server"',
      ),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('genkey', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(tl(ctx, 'Только для админа.', 'Admins only.'));
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const days = parts[0] ? Number(parts[0]) : null; // null = lifetime
    if (parts[0] && !Number.isFinite(days)) return ctx.reply(tl(ctx, 'Использование: /genkey [дней] [план]\nНапр.: /genkey 30', 'Usage: /genkey [days] [plan]\nE.g.: /genkey 30'));
    const plan = parts[1] ?? 'standard';
    const key = genKey({ plan, durationDays: days, createdBy: ctx.from.id });
    return ctx.reply(
      tl(
        ctx,
        `🔑 Ключ (${days ? days + ' дн.' : 'бессрочно'}, план ${plan}):\n<code>${key}</code>`,
        `🔑 Key (${days ? days + ' d.' : 'lifetime'}, plan ${plan}):\n<code>${key}</code>`,
      ),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('revoke', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(tl(ctx, 'Только для админа.', 'Admins only.'));
    const key = ctx.match?.trim();
    if (!key) return ctx.reply(tl(ctx, 'Использование: /revoke <ключ>', 'Usage: /revoke <key>'));
    const affected = revoke(key);
    if (affected) sessions.freeze(affected, 'expired');
    return ctx.reply(affected ? tl(ctx, `Ключ отозван, сессия ${affected} заморожена.`, `Key revoked, session ${affected} frozen.`) : tl(ctx, 'Ключ отозван (не был активирован).', 'Key revoked (was never activated).'));
  });

  bot.command('keys', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply(tl(ctx, 'Только для админа.', 'Admins only.'));
    const keys = listKeys();
    if (!keys.length) return ctx.reply(tl(ctx, 'Ключей нет. Создай: /genkey [дней]', 'No keys. Create one: /genkey [days]'));
    const icon = { active: '🟢', unused: '⚪', revoked: '🔴', expired: '⚫' };
    const lines = keys.slice(0, 30).map((k) => {
      const who = k.redeemed_by ? `→ ${k.redeemed_by}` : '';
      const exp = k.expires_at ? `(${tl(ctx, 'до', 'until')} ${formatExpiry(k.expires_at, uiLang(ctx))})` : '';
      return `${icon[k.status] ?? '⚪'} <code>${k.key}</code> ${k.status} ${who} ${exp}`.trim();
    });
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // --- Rust+ session commands ---
  bot.command('status', async (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) {
      return ctx.reply(tl(ctx, 'Нет активной сессии. Привяжи Rust+ (/pair) или дождись активации подписки.', 'No active session. Pair Rust+ (/pair) or wait for your subscription to activate.'));
    }
    if (session.state?.startsWith('frozen')) {
      const why = session.state === 'frozen:expired' ? tl(ctx, 'подписка истекла', 'subscription expired') : tl(ctx, 'связь потеряна — нажми Pair в игре', 'connection lost — press Pair in game');
      return ctx.reply(tl(ctx, `⏸️ Сессия заморожена (${why}).`, `⏸️ Session frozen (${why}).`));
    }
    try {
      const [info, time] = await Promise.all([session.getInfo(), session.getTime()]);
      const queue = info.queuedPlayers ? tl(ctx, ` · очередь ${info.queuedPlayers}`, ` · queue ${info.queuedPlayers}`) : '';
      await ctx.reply(
        tl(
          ctx,
          `🖥️ <b>${esc(info.name)}</b>\n` +
            panel(
              `👥 Онлайн: <b>${info.players}/${info.maxPlayers}</b>${queue}\n` +
                `🕒 ${dayNightLabel(time, 'ru')}`,
            ),
          `🖥️ <b>${esc(info.name)}</b>\n` +
            panel(
              `👥 Online: <b>${info.players}/${info.maxPlayers}</b>${queue}\n` +
                `🕒 ${dayNightLabel(time, 'en')}`,
            ),
        ),
        HTML,
      );
    } catch (err) {
      await ctx.reply(tl(ctx, 'Сервер недоступен: ', 'Server unavailable: ') + err.message);
    }
  });

  bot.command('say', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) return ctx.reply(tl(ctx, 'Использование: /say <текст>', 'Usage: /say <text>'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    session.sendToGame(`${ctx.from.first_name}: ${text}`);
    return ctx.reply(tl(ctx, 'Отправлено в тимчат ✅', 'Sent to team chat ✅'));
  });

  bot.command('promote', async (ctx) => {
    const name = ctx.match?.trim();
    if (!name) return ctx.reply(tl(ctx, 'Использование: /promote «ник участника тимы»', 'Usage: /promote «team member name»'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    try {
      const team = await session.getTeamInfo();
      const members = team.members ?? [];
      // Rust only lets the current leader transfer leadership → the bot must be it.
      if (String(team.leaderSteamId) !== String(session.creds?.playerId)) {
        return ctx.reply(tl(ctx, '⚠️ Бот не лидер тимы. Передай ему лидерку в игре — тогда сможет назначать.', '⚠️ The bot is not the team leader. Hand it leadership in-game first.'));
      }
      const q = name.toLowerCase();
      const target = members.find((m) => (m.name || '').toLowerCase() === q) || members.find((m) => (m.name || '').toLowerCase().includes(q));
      if (!target) return ctx.reply(tl(ctx, `Не нашёл «${name}» в тиме.`, `No team member matching “${name}”.`));
      if (String(target.steamId) === String(team.leaderSteamId)) return ctx.reply(tl(ctx, `${target.name} уже лидер.`, `${target.name} is already the leader.`));
      await session.promoteToLeader(target.steamId);
      return ctx.reply(tl(ctx, `👑 ${target.name} назначен лидером тимы.`, `👑 ${target.name} promoted to team leader.`));
    } catch (err) {
      return ctx.reply(tl(ctx, 'Не удалось назначить лидера: ', 'Could not promote: ') + err.message);
    }
  });

  bot.command('teamstats', (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const list = session.teamStats();
    if (!list.length) return ctx.reply(tl(ctx, 'Пока нет статистики тимы за этот вайп.', 'No team stats for this wipe yet.'));
    const lang = uiLang(ctx);
    const play = list.reduce((a, s) => a + s.playtimeMs, 0);
    const afk = list.reduce((a, s) => a + s.afkMs, 0);
    const deaths = list.reduce((a, s) => a + s.deaths, 0);
    const dist = list.reduce((a, s) => a + s.distanceM, 0);
    const rows = list
      .filter((s) => s.playtimeMs > 0)
      .sort((a, b) => b.playtimeMs - a.playtimeMs)
      .map((s) => `${esc(s.name || '?')} — ${fmtDuration(s.playtimeMs / 1000, lang)} · AFK ${fmtDuration(s.afkMs / 1000, lang)} · ☠ ${s.deaths}`);
    const head = tl(
      ctx,
      `👥 <b>Статистика тимы</b> <i>(за вайп)</i>\n` +
        panel(
          `Σ в игре <b>${fmtDuration(play / 1000, 'ru')}</b> · AFK <b>${fmtDuration(afk / 1000, 'ru')}</b>\n` +
            `Σ смертей <b>${deaths}</b> · пройдено <b>${numFmt(Math.round(dist))} м</b>`,
        ),
      `👥 <b>Team stats</b> <i>(this wipe)</i>\n` +
        panel(
          `Σ played <b>${fmtDuration(play / 1000, 'en')}</b> · AFK <b>${fmtDuration(afk / 1000, 'en')}</b>\n` +
            `Σ deaths <b>${deaths}</b> · traveled <b>${numFmt(Math.round(dist))} m</b>`,
        ),
    );
    return ctx.reply(rows.length ? head + '\n' + expand(rows.join('\n')) : head, HTML);
  });

  bot.command('deaths', (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const list = session.recentDeaths();
    if (!list.length) return ctx.reply(tl(ctx, 'Смертей тимы пока не зафиксировано.', 'No team deaths recorded yet.'));
    const lang = uiLang(ctx);
    const now = Date.now();
    const ago = (ms) =>
      ms < 60_000 ? tl(ctx, 'только что', 'just now') : `${fmtDuration(ms / 1000, lang)} ${tl(ctx, 'назад', 'ago')}`;
    const rows = list.map((d, i) => `${i + 1}. <b>${esc(d.name)}</b> — ${esc(d.grid)} <i>(${ago(now - d.at)})</i>`);
    const title = tl(ctx, '💀 <b>Последние смерти тимы</b>', '💀 <b>Recent team deaths</b>');
    return ctx.reply(title + '\n' + panel(rows.join('\n')), HTML);
  });

  bot.command('subscribe', (ctx) =>
    ctx.reply(tl(ctx, '🔔 Что присылать? Нажми, чтобы включить/выключить:', '🔔 What to send? Tap to toggle on/off:'), {
      reply_markup: buildSubsKeyboard(ctx.from.id),
    }),
  );

  bot.command('mirror', (ctx) => {
    const arg = (ctx.match || '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      setMirror(ctx.from.id, arg === 'on');
      return ctx.reply(arg === 'on' ? tl(ctx, '✅ Алерты дублируются в игровой тим-чат.', '✅ Alerts are mirrored to the in-game team chat.') : tl(ctx, '🔕 Дублирование алертов в тим-чат выключено.', '🔕 Mirroring alerts to team chat is off.'));
    }
    return ctx.reply(tl(ctx, `Зеркалирование алертов в тим-чат: ${mirrorEnabled(ctx.from.id) ? 'ВКЛ' : 'ВЫКЛ'}\nПереключить: /mirror on | /mirror off`, `Mirroring alerts to team chat: ${mirrorEnabled(ctx.from.id) ? 'ON' : 'OFF'}\nToggle: /mirror on | /mirror off`));
  });

  bot.callbackQuery(/^sub:(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    const next = isEnabled(ctx.from.id, type) ? 0 : 1;
    setSubStmt.run(ctx.from.id, type, next);
    await ctx.editMessageReplyMarkup({ reply_markup: buildSubsKeyboard(ctx.from.id) });
    await ctx.answerCallbackQuery(next ? tl(ctx, 'Включено', 'Enabled') : tl(ctx, 'Выключено', 'Disabled'));
  });

  bot.callbackQuery(/^lang:(ru|en)$/, async (ctx) => {
    const lang = ctx.match[1];
    setLang(ctx.from.id, lang);
    await ctx.answerCallbackQuery(t(lang, 'pick_done'));
    await ctx.editMessageText(t(lang, 'pick_done')).catch(() => {});
    await sendStart(ctx, lang);
  });

  bot.command('track', (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const [steamId, ...labelParts] = parts;
    if (!steamId) return ctx.reply(tl(ctx, 'Использование: /track <steamId> <label>', 'Usage: /track <steamId> <label>'));
    const label = labelParts.join(' ') || steamId;
    addFriendStmt.run(steamId, label);
    return ctx.reply(tl(ctx, `Отслеживаю ${label} ✅`, `Tracking ${label} ✅`));
  });

  bot.command('online', async (ctx) => {
    const friends = friendsStmt.all();
    if (!friends.length) return ctx.reply(tl(ctx, 'Список пуст. Добавь: /track <steamId> <имя>', 'List is empty. Add one: /track <steamId> <name>'));
    let summaries;
    try {
      summaries = await getSummaries(friends.map((f) => f.steam_id));
    } catch (err) {
      return ctx.reply(tl(ctx, '⚠️ Статусы недоступны: ', '⚠️ Statuses unavailable: ') + err.message);
    }
    // in Rust → online → offline/unknown
    const rank = (s) => (s?.inRust ? 0 : s?.online ? 1 : 2);
    const rows = friends
      .map((f) => ({ f, s: summaries[f.steam_id] }))
      .sort((a, b) => rank(a.s) - rank(b.s))
      .map(({ f, s }) => {
        let st;
        if (!s) st = '⚪ ?';
        else if (s.inRust) st = tl(ctx, '🎮 в Rust', '🎮 in Rust') + (s.server ? ` <i>${esc(s.server)}</i>` : '');
        else if (s.online) st = tl(ctx, '🟢 в сети', '🟢 online');
        else st = tl(ctx, '⚪ не в сети', '⚪ offline');
        return `${st} — <b>${esc(f.label)}</b>`;
      });
    const onCount = friends.filter((f) => summaries[f.steam_id]?.online || summaries[f.steam_id]?.inRust).length;
    const head = tl(
      ctx,
      `👥 <b>Друзья</b> <i>(${onCount}/${friends.length} в сети)</i>`,
      `👥 <b>Friends</b> <i>(${onCount}/${friends.length} online)</i>`,
    );
    return ctx.reply(head + '\n' + panel(rows.join('\n')), HTML);
  });

  bot.command('enemy', async (ctx) => {
    const args = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const sub = (args.shift() || '').toLowerCase();
    const rest = args.join(' ');

    if (sub === 'add') {
      if (!rest) return ctx.reply(tl(ctx, 'Использование: /enemy add <SteamID | ссылка на профиль | vanity>', 'Usage: /enemy add <SteamID | profile link | vanity>'));
      let steamId;
      try {
        steamId = await resolveSteamId(rest);
      } catch (err) {
        return ctx.reply('❌ ' + err.message);
      }
      if (!steamId) {
        return ctx.reply(tl(ctx, 'Не удалось определить SteamID. Дай SteamID64, ссылку steamcommunity.com/profiles/… или /id/…', 'Could not resolve SteamID. Provide a SteamID64, a steamcommunity.com/profiles/… link or /id/…'));
      }
      const summary = await getSummary(steamId).catch(() => null);
      const label = summary?.name ?? steamId;
      const id = addEnemy(ctx.from.id, { label, steamId });
      return ctx.reply(tl(ctx, `🎯 Добавлен враг #${id}: ${label}\nСтатистика: /enemy stats ${steamId}`, `🎯 Enemy #${id} added: ${label}\nStats: /enemy stats ${steamId}`));
    }

    if (sub === 'nick') {
      if (!rest) return ctx.reply(tl(ctx, 'Использование: /enemy nick «ник в игре»', 'Usage: /enemy nick «in-game name»'));
      const nick = rest.slice(0, 64);
      const dup = findEnemy(ctx.from.id, nick);
      if (dup) return ctx.reply(tl(ctx, `Уже в списке: #${dup.id} ${dup.label}`, `Already tracked: #${dup.id} ${dup.label}`));
      const id = addEnemy(ctx.from.id, { label: nick, nick });
      const key = serverKeyOf(ctx.from.id);
      const seen = key ? presence.history(key, nick).length : 0;
      const status = presence?.isOnline(key, nick)
        ? tl(ctx, '🟢 сейчас на сервере', '🟢 on the server now')
        : seen
          ? tl(ctx, `уже видели на сервере (${seen} заход.)`, `seen on the server before (${seen} stays)`)
          : tl(ctx, 'на сервере пока не видели — проверь ник: /seen «часть ника»', 'not seen on the server yet — check the name: /seen «part of name»');
      return ctx.reply(tl(
        ctx,
        `🎯 Добавлен враг #${id}: ${nick} (${status})\nБот следит за ним по списку игроков сервера. Группа: /enemy group «название» ${id}`,
        `🎯 Enemy #${id} added: ${nick} (${status})\nTracked via the server player list. Group: /enemy group «name» ${id}`,
      ));
    }

    if (sub === 'group' || sub === 'ungroup') {
      const grp = sub === 'group' ? args.shift() : null;
      const ids = args.map((a) => Number(a.replace(/^#/, ''))).filter(Boolean);
      if ((sub === 'group' && !grp) || !ids.length) {
        return ctx.reply(tl(
          ctx,
          'Группа = тима врагов. Когда выйдут все — придёт уведомление.\n/enemy group «название» «id» [id…]\n/enemy ungroup «id» [id…]',
          'A group is an enemy team. You get a notification when all of them go offline.\n/enemy group «name» «id» [id…]\n/enemy ungroup «id» [id…]',
        ));
      }
      const done = ids.filter((id) => setEnemyGroup(id, ctx.from.id, grp?.slice(0, 32) ?? null));
      if (!done.length) return ctx.reply(tl(ctx, 'Не найдено. Номера — из /enemy list.', 'Not found. Numbers are from /enemy list.'));
      return ctx.reply(grp
        ? tl(ctx, `👥 В группе «${grp}»: #${done.join(', #')}`, `👥 In group "${grp}": #${done.join(', #')}`)
        : tl(ctx, `Убраны из групп: #${done.join(', #')}`, `Removed from groups: #${done.join(', #')}`));
    }

    if (sub === 'team') {
      const wantAdd = args[args.length - 1]?.toLowerCase() === 'add';
      if (wantAdd) args.pop();
      const q = args.join(' ');
      if (!q) {
        return ctx.reply(tl(
          ctx,
          'Кто играет вместе с игроком — по тому, как они заходят и выходят на твоём сервере.\n/enemy team «#id | ник» — показать тиммейтов\n/enemy team «#id | ник» add — следить за всей тимой (группа + уведомление, когда выйдут все)',
          'Who plays with a player, from how they join and leave your server.\n/enemy team «#id | name» — show teammates\n/enemy team «#id | name» add — track the whole team (a group + alert when all are offline)',
        ));
      }
      const key = serverKeyOf(ctx.from.id);
      if (!key) return ctx.reply(tl(ctx, 'Сервер ещё не подключён к сбору списка игроков.', 'The server is not connected to player-list tracking yet.'));
      const id0 = Number(q.replace(/^#/, ''));
      const tracked = (id0 ? getEnemy(id0, ctx.from.id) : null) || findEnemy(ctx.from.id, q);
      const nick = tracked ? tracked.nick || enemies?.names.get(tracked.id) || tracked.label : q;
      const res = findTeammates(key, nick);
      if (!res) return ctx.reply(tl(ctx, `«${nick}» на сервере не видели. Поиск ника: /seen «часть ника»`, `"${nick}" has not been seen on the server. Search names: /seen «part of name»`));

      const { target, mates } = res;
      const hours = (m) => (m < 60 ? `${m} мин` : `${(m / 60).toFixed(1)} ч`);
      const hoursEn = (m) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
      const lines = [tl(
        ctx,
        `👥 Тима игрока «${target.name}» (за 14 дней: ${target.stays} заход., ${hours(target.minutes)})`,
        `👥 "${target.name}"'s team (14 days: ${target.stays} stays, ${hoursEn(target.minutes)})`,
      )];
      for (const m of mates) {
        const pct = Math.round(m.share * 100);
        lines.push(`${m.level === 'high' ? '🟥' : '🟧'} ${m.name} — ` + tl(
          ctx,
          `заходили вместе ${m.joins}, выходили ${m.leaves}, вместе ${pct}% времени`,
          `joined together ${m.joins}, left ${m.leaves}, together ${pct}% of the time`,
        ));
      }
      if (!mates.length) {
        lines.push(res.enough
          ? tl(ctx, 'Постоянных напарников не видно — похоже, играет один.', 'No regular partners — looks like a solo player.')
          : tl(ctx, 'Пока мало данных: нужно ещё несколько заходов. Загляни через день-два.', 'Not enough data yet: a few more sessions are needed. Check back in a day or two.'));
        return ctx.reply(lines.join('\n'));
      }
      lines.push(res.enough
        ? tl(ctx, '🟥 почти наверняка · 🟧 вероятно', '🟥 almost certain · 🟧 likely')
        : tl(ctx, '⚠️ Данных пока мало, результат может поменяться.', '⚠️ Little data so far, this may change.'));

      if (!wantAdd) {
        lines.push(tl(ctx, `Следить за всей тимой: /enemy team ${q} add`, `Track the whole team: /enemy team ${q} add`));
        return ctx.reply(lines.join('\n'));
      }

      // Track the target and every teammate as one group.
      const owner = ctx.from.id;
      const group = (tracked?.grp || target.name).replace(/\s+/g, '_').slice(0, 32);
      const ensure = (name) => findEnemy(owner, name)?.id ?? addEnemy(owner, { label: name, nick: name });
      const ids = [tracked?.id ?? ensure(target.name), ...mates.map((m) => ensure(m.name))];
      for (const id of ids) setEnemyGroup(id, owner, group);
      lines.push('', tl(
        ctx,
        `✅ Группа «${group}», игроков в ней: ${ids.length}. Сообщу, когда зайдут и когда выйдет вся тима. Список: /enemy list`,
        `✅ Group "${group}", players in it: ${ids.length}. I'll tell you when they join and when the whole team is offline. List: /enemy list`,
      ));
      return ctx.reply(lines.join('\n'));
    }

    if (sub === 'list') {
      const list = listEnemies(ctx.from.id);
      if (!list.length) return ctx.reply(tl(ctx, 'Список врагов пуст. /enemy add <SteamID|ссылка> или /enemy nick «ник»', 'Enemy list is empty. /enemy add <SteamID|link> or /enemy nick «name»'));
      const rows = [];
      let lastGrp;
      for (const e of list) {
        if (e.grp && e.grp !== lastGrp) rows.push(`👥 ${e.grp}:`);
        lastGrp = e.grp;
        const online = enemies?.state.get(e.id);
        const dot = online === undefined ? '·' : online ? '🟢' : '⚪';
        const how = e.steam_id ? 'Steam' : tl(ctx, 'ник', 'name');
        rows.push(`${e.grp ? '  ' : ''}${dot} #${e.id} ${e.label} (${how})`);
      }
      return ctx.reply(tl(ctx, '🎯 Враги:', '🎯 Enemies:') + '\n' + rows.join('\n'));
    }

    if (sub === 'remove' || sub === 'rm') {
      const id = Number(rest);
      if (!id) return ctx.reply(tl(ctx, 'Использование: /enemy remove <id>', 'Usage: /enemy remove <id>'));
      return ctx.reply(removeEnemy(id, ctx.from.id) ? tl(ctx, `Удалён враг #${id}`, `Enemy #${id} removed`) : tl(ctx, 'Не найдено.', 'Not found.'));
    }

    if (sub === 'stats') {
      if (!rest) return ctx.reply(tl(ctx, 'Использование: /enemy stats <#id | ник | SteamID | ссылка>', 'Usage: /enemy stats <#id | name | SteamID | link>'));
      const key = serverKeyOf(ctx.from.id);
      // Who: a tracked enemy (#id/label), a SteamID/link, or a nickname seen on the server.
      const tracked = (Number(rest.replace(/^#/, '')) ? getEnemy(Number(rest.replace(/^#/, '')), ctx.from.id) : null) || findEnemy(ctx.from.id, rest);
      let steamId = tracked?.steam_id ?? null;
      let nick = tracked?.nick ?? null;
      if (!tracked) {
        const looksLikeSteam = /^7656119\d{10}$/.test(rest) || /steamcommunity\.com\//.test(rest);
        if (!looksLikeSteam && key && presence.history(key, rest).length) nick = rest;
        else {
          try {
            steamId = await resolveSteamId(rest);
          } catch (err) {
            return ctx.reply('❌ ' + err.message);
          }
        }
      }
      if (!steamId && !nick) {
        return ctx.reply(tl(
          ctx,
          'Игрок не найден: ни в /enemy list, ни на твоём сервере, ни в Steam. Ник можно поискать: /seen «часть ника»',
          'Player not found: not in /enemy list, not on your server, not on Steam. Search names: /seen «part of name»',
        ));
      }

      await ctx.reply(tl(ctx, 'Считаю статистику…', 'Crunching stats…'));
      const tz = config.analytics.tzOffset;
      let text = '';
      let summary = null;
      if (steamId) {
        let stats, playtime, bans;
        [summary, stats, playtime, bans] = await Promise.all([
          getSummary(steamId).catch(() => null),
          getRustStats(steamId).catch(() => ({ private: true })),
          getPlaytimeMinutes(steamId).catch(() => null),
          getBans(steamId).catch(() => null),
        ]);
        text = renderSteamProfile(summary, stats, playtime, uiLang(ctx));
        text += '\n\n———\n' + renderTrust(summary, bans, stats, playtime, uiLang(ctx));
      }
      const name = summary?.name ?? tracked?.label ?? nick ?? steamId;
      let activity = '';
      let source = '';
      let bmServers = [];

      // 1. Our own log of the server's player list (A2S): any server that publishes it.
      const serverName = nick ?? (tracked ? enemies?.names.get(tracked.id) : null) ?? summary?.name ?? tracked?.label;
      const hist = key && serverName ? presence.history(key, serverName) : [];
      if (hist.length) {
        activity = renderProfile(hist[0].name, hist, tz);
        source = tl(
          ctx,
          `по списку игроков сервера, с ${new Date(hist[0].start).toLocaleDateString('ru-RU')}`,
          `from the server player list, since ${new Date(hist[0].start).toLocaleDateString('en-GB')}`,
        );
      }

      // 2. BattleMetrics, if the operator has a paid token: older history + other servers.
      if (steamId && config.battlemetrics.token) {
        try {
          const matches = await quickMatchSteamId(steamId, { token: config.battlemetrics.token });
          if (matches.length) {
            const bmId = matches[0].id;
            const serverId = await resolveBmServerId(ctx.from.id);
            const [ses, servers] = await Promise.all([
              fetchSessions(bmId, { token: config.battlemetrics.token, serverId }).catch(() => []),
              playerServers(bmId, { token: config.battlemetrics.token }).catch(() => []),
            ]);
            if (!activity && ses.length) {
              activity = renderProfile(name, ses, tz);
              source = 'BattleMetrics';
            }
            bmServers = servers;
          }
        } catch {
          // optional source — ignore failures
        }
      }

      // 3. Steam presence observed by the bot ("in Rust" on any server).
      if (!activity && tracked) {
        const obs = getEnemySessions(tracked.id).map((s) => ({
          start: new Date(s.started_at).toISOString(),
          stop: s.ended_at ? new Date(s.ended_at).toISOString() : null,
        }));
        if (obs.length >= 3) {
          activity = renderProfile(name, obs, tz);
          source = tl(ctx, 'по статусу «в Rust» в Steam', 'from the Steam "in Rust" status');
        }
      }

      if (text) text += '\n\n———\n';
      if (activity) {
        text += tl(ctx, '📈 Активность', '📈 Activity') + ` (${source}):\n` + activity;
      } else {
        text += tl(
          ctx,
          `🎯 ${name}\n📈 Когда онлайн: пока нет данных.\n` +
            (key
              ? 'Бот каждую минуту записывает, кто играет на твоём сервере. Если ник в игре другой, чем в Steam, добавь врага по нику: /enemy nick «ник».'
              : 'Сбор по серверу начнётся, когда бот подключится к твоему серверу (привязка Rust+).'),
          `🎯 ${name}\n📈 When online: no data yet.\n` +
            (key
              ? 'The bot records who plays on your server every minute. If the in-game name differs from Steam, add the enemy by name: /enemy nick «name».'
              : 'Server tracking starts once the bot is connected to your server (Rust+ pairing).'),
        );
      }

      if (bmServers.length >= 2) {
        text += '\n\n' + tl(ctx, '🌐 Замечен на серверах:', '🌐 Seen on servers:') + '\n' + bmServers.slice(0, 6).map((s) => `• ${s.name} (${s.sessions})`).join('\n');
      }
      return ctx.reply(text);
    }

    return ctx.reply(
      tl(
        ctx,
        '🎯 Враги:\n' +
          '/enemy nick «ник» — следить по нику на твоём сервере\n' +
          '/enemy add <SteamID|ссылка|vanity> — следить по Steam\n' +
          '/enemy list — список и кто онлайн\n' +
          '/enemy team «#id|ник» [add] — найти тиммейтов врага (и следить за всеми)\n' +
          '/enemy group «название» «id…» — тима врагов: сообщу, когда выйдут все\n' +
          '/enemy stats <#id|ник|SteamID> — когда играет, лучшее окно для рейда, K/D\n' +
          '/enemy remove <id> — удалить\n' +
          '/players — кто сейчас на сервере · /seen «ник» — когда заходил',
        '🎯 Enemies:\n' +
          '/enemy nick «name» — track by name on your server\n' +
          '/enemy add <SteamID|link|vanity> — track via Steam\n' +
          '/enemy list — list and who is online\n' +
          '/enemy team «#id|name» [add] — find an enemy\'s teammates (and track them all)\n' +
          '/enemy group «name» «id…» — an enemy team: alert when all are offline\n' +
          '/enemy stats <#id|name|SteamID> — when they play, best raid window, K/D\n' +
          '/enemy remove <id> — remove\n' +
          '/players — who is on the server now · /seen «name» — when they played',
      ),
    );
  });

  // Who is on the paired server right now (A2S player list), longest stay first.
  bot.command('players', (ctx) => {
    const key = serverKeyOf(ctx.from.id);
    const snap = presence?.snapshot(key);
    if (!key || !snap?.lastOk) {
      if (snap?.hidden) return ctx.reply(tl(ctx, '🙈 Этот сервер скрывает список игроков.', '🙈 This server hides its player list.'));
      return ctx.reply(tl(
        ctx,
        'Список игроков пока недоступен: бот ещё не опросил сервер (раз в минуту) или сервер не привязан.',
        'The player list is not available yet: the bot has not polled the server (once a minute) or no server is paired.',
      ));
    }
    const q = ctx.match?.trim().toLowerCase();
    const now = Date.now();
    const list = snap.players
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.since - b.since);
    const dur = (ms) => {
      const m = Math.round(ms / 60000);
      return m < 60 ? `${m}м` : `${Math.floor(m / 60)}ч ${String(m % 60).padStart(2, '0')}м`;
    };
    const head = `👥 <b>${esc(snap.name ?? key)}</b> — ${snap.players.length}${snap.maxPlayers ? `/${snap.maxPlayers}` : ''}`;
    const rows = list.slice(0, 60).map((p) => `${esc(p.name)} · ${dur(now - p.since)}`);
    if (list.length > 60) rows.push(tl(ctx, `…и ещё ${list.length - 60}. Фильтр: /players «часть ника»`, `…and ${list.length - 60} more. Filter: /players «part of name»`));
    if (!rows.length) rows.push(tl(ctx, 'Никого с таким ником.', 'Nobody with that name.'));
    return ctx.reply(head + '\n' + panel(rows.join('\n')), HTML);
  });

  // When a nickname was on the paired server (our own A2S log, up to 30 days).
  bot.command('seen', (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply(tl(ctx, 'Использование: /seen «ник или часть ника»', 'Usage: /seen «name or part of it»'));
    const key = serverKeyOf(ctx.from.id);
    if (!key) return ctx.reply(tl(ctx, 'Сервер ещё не подключён к сбору списка игроков.', 'The server is not connected to player-list tracking yet.'));
    const found = presence.search(key, q, 8);
    if (!found.length) return ctx.reply(tl(ctx, `«${q}» на сервере не видели (история хранится 30 дней).`, `"${q}" has not been seen on the server (history is kept for 30 days).`));
    const now = Date.now();
    const ago = (t) => {
      const m = Math.round((now - t) / 60000);
      return m < 2 ? tl(ctx, 'сейчас', 'now') : m < 60 ? tl(ctx, `${m} мин назад`, `${m} min ago`) : m < 1440 ? tl(ctx, `${Math.round(m / 60)} ч назад`, `${Math.round(m / 60)} h ago`) : tl(ctx, `${Math.round(m / 1440)} дн назад`, `${Math.round(m / 1440)} d ago`);
    };
    const rows = found.map((f) => {
      const on = presence.isOnline(key, f.name);
      return `${on ? '🟢' : '⚪'} ${esc(f.name)} · ${on ? tl(ctx, 'на сервере', 'online') : ago(f.seen)} · ${tl(ctx, 'заходов', 'stays')}: ${f.stays}`;
    });
    const hint = tl(ctx, 'Подробнее: /enemy stats «ник» · следить: /enemy nick «ник»', 'Details: /enemy stats «name» · track: /enemy nick «name»');
    return ctx.reply(panel(rows.join('\n')) + '\n' + hint, HTML);
  });

  // Quick trust/ban check by SteamID (smurf/cheat heuristic).
  bot.command('check', async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply(tl(ctx, 'Использование: /check <SteamID | ссылка на профиль>', 'Usage: /check <SteamID | profile link>'));
    let steamId;
    try {
      steamId = await resolveSteamId(q);
    } catch (err) {
      return ctx.reply('❌ ' + err.message);
    }
    if (!steamId) return ctx.reply(tl(ctx, 'Не удалось определить SteamID.', 'Could not resolve SteamID.'));
    const [summary, stats, playtime, bans] = await Promise.all([
      getSummary(steamId).catch(() => null),
      getRustStats(steamId).catch(() => ({ private: true })),
      getPlaytimeMinutes(steamId).catch(() => null),
      getBans(steamId).catch(() => null),
    ]);
    if (!summary) return ctx.reply(tl(ctx, 'Игрок не найден в Steam.', 'Player not found on Steam.'));
    return ctx.reply(`🎯 ${summary.name}\n\n${renderTrust(summary, bans, stats, playtime, uiLang(ctx))}`);
  });

  bot.command('repair', (ctx) => {
    if (blockViewer(ctx)) return;
    return ctx.reply(
      tl(
        ctx,
        'После вайпа или потери связи:\n' +
          '1. Зайди на сервер в игре\n' +
          '2. Меню (Esc) → Rust+ → Pair with Server\n' +
          'Бот сам подхватит новый токен и продолжит работу — перезапускать ничего не нужно.',
        'After a wipe or lost connection:\n' +
          '1. Join the server in game\n' +
          '2. Menu (Esc) → Rust+ → Pair with Server\n' +
          'The bot picks up the new token and keeps working — no restart needed.',
      ),
    );
  });

  // --- Utilities ---
  bot.command('raid', (ctx) => {
    const lang = uiLang(ctx);
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (!parts.length) {
      const list = structureList().map((s) => `• ${s.alias} — ${esc(s.label)}`).join('\n');
      return ctx.reply(`${t(lang, 'raid_usage')}\n\n<blockquote>${list}</blockquote>`, HTML);
    }
    const qty = parts.length > 1 && Number.isFinite(Number(parts[parts.length - 1])) ? Number(parts.pop()) : 1;
    const cost = raidCost(parts.join(' '), qty);
    if (!cost) return ctx.reply(t(lang, 'raid_unknown'));

    // Per method: total RAW resources (recursively rolled up to сера/металл/
    // уголь/топливо), which is what you actually farm. Recipe-less items (guns,
    // handmade shell) show just the count.
    const costOf = (m) => (m.raw ? m.raw.map((x) => `${numFmt(x.amt)} ${x.ru}`).join(' + ') : '');
    const line = (m) => {
      const c = costOf(m);
      return `• <b>${esc(m.name)}</b> ×${numFmt(m.count)}${c ? `\n   ${c}` : ''}`;
    };
    const group = (catKey) =>
      cost.methods
        .filter((m) => m.cat === catKey)
        .sort((a, b) => a.sortSulfur - b.sortSulfur || a.count - b.count);

    let out = `🧨 <b>${esc(cost.label)}</b> ×${cost.qty}${cost.softside ? ` · 🪵 ${t(lang, 'raid_softside')}` : ''}`;

    // Headline: full raw cost of the most cost-effective method. Prefer prostoj's
    // own recommendation (its tip names a method) so we don't surface an
    // impractical least-sulfur pick; else the cheapest explosive by raw sulfur.
    let head = null;
    let headFromTip = false;
    const tipName = cost.tip ? /Дешевле:\s*(.+)$/i.exec(cost.tip)?.[1]?.trim() : null;
    if (tipName) {
      const m = cost.methods.find((x) => x.name.toLowerCase() === tipName.toLowerCase());
      if (m) {
        head = m;
        headFromTip = true;
      }
    }
    if (!head) head = group('boom')[0] || cost.methods[0];
    if (head?.raw) {
      out += `\n\n📦 <b>${t(lang, 'raid_cheapest')}</b> — ${esc(head.name)} ×${numFmt(head.count)}\n` + panel(costOf(head));
    }

    for (const key of ['boom', 'fire', 'tool', 'gun']) {
      const listg = group(key);
      if (!listg.length) continue;
      const s = RAID_SECTIONS[key];
      out += `\n\n${s.icon} ${s[lang]}\n${expand(listg.map(line).join('\n'))}`;
    }
    if (cost.tip && !headFromTip) out += `\n\n✅ ${esc(cost.tip)} <i>(${t(lang, 'raid_tipsrc')})</i>`;
    return ctx.reply(out, HTML);
  });

  // --- RustLabs toolkit (Telegram twins of the in-game !craft/!recycle/etc.) ---
  // Split a "10 rocket" / "350 armored wall" argument into leading number + rest.
  const splitNum = (s) => {
    const m = (s ?? '').trim().match(/^(\d+)\s+(.+)$/);
    return m ? { n: Number(m[1]), rest: m[2] } : { n: null, rest: (s ?? '').trim() };
  };

  bot.command('craft', (ctx) => {
    const lang = uiLang(ctx);
    const nm = (o) => esc(lang === 'en' ? o.name : o.nameRu);
    const { n, rest } = splitNum(ctx.match);
    if (!rest) return ctx.reply(tl(ctx, 'Использование: /craft [кол-во] <предмет>\nНапр.: /craft 10 ракета', 'Usage: /craft [qty] <item>\nE.g.: /craft 10 rocket'));
    const c = craftInfo(rest, n ?? 1);
    if (!c) return ctx.reply(tl(ctx, 'Не знаю рецепт этого предмета.', 'I do not know that item\'s recipe.'));
    const ing = c.ingredients.map((x) => `• ${nm(x)} ×${numFmt(x.qty)}`).join('\n');
    const wb = c.wb ? ` · ${tl(ctx, 'верстак', 'workbench')} ${c.wb}` : '';
    return ctx.reply(
      `🔨 <b>${nm(c)}</b> ×${c.qty}\n${panel(ing)}\n⏱ ${fmtDuration(c.timeSec, lang)}${wb}`,
      HTML,
    );
  });

  bot.command('recycle', (ctx) => {
    const lang = uiLang(ctx);
    const nm = (o) => esc(lang === 'en' ? o.name : o.nameRu);
    let { n, rest } = splitNum(ctx.match);
    if (!rest) return ctx.reply(tl(ctx, 'Использование: /recycle [кол-во] <предмет> [сейф]\nНапр.: /recycle 20 тех мусор', 'Usage: /recycle [qty] <item> [safe]\nE.g.: /recycle 20 tech trash'));
    const safe = /\b(safe|сейф|мирка|мирн\w*)\b/i.test(rest);
    rest = rest.replace(/\b(safe|сейф|мирка|мирн\w*)\b/gi, '').trim();
    const r = recycleInfo(rest, n ?? 1, safe);
    if (!r) return ctx.reply(tl(ctx, 'Этот предмет не перерабатывается.', 'This item is not recyclable.'));
    const out = r.yields.map((y) => `• ${nm(y)} ×${numFmt(y.qty)}${y.prob < 1 ? ` <i>(${Math.round(y.prob * 100)}%)</i>` : ''}`).join('\n');
    const which = r.safe ? tl(ctx, 'переработчик в мирной зоне', 'safe-zone recycler') : tl(ctx, 'обычный переработчик', 'standard recycler');
    const hint = !r.safe && r.hasSafe ? tl(ctx, '\n<i>в мирке меньше — добавь «сейф»</i>', '\n<i>safe-zone yields less — add "safe"</i>') : '';
    return ctx.reply(`♻️ <b>${nm(r)}</b> ×${r.qty} → <i>${which}</i>\n${panel(out)}${hint}`, HTML);
  });

  bot.command('decay', (ctx) => {
    const lang = uiLang(ctx);
    const { n, rest } = splitNum(ctx.match);
    if (!rest) return ctx.reply(tl(ctx, 'Использование: /decay [текущее HP] <объект>\nНапр.: /decay 350 каменная стена', 'Usage: /decay [current HP] <structure>\nE.g.: /decay 350 stone wall'));
    const d = decayInfo(rest, n);
    if (!d) return ctx.reply(tl(ctx, 'Не знаю распад этого объекта.', 'I do not know that structure\'s decay.'));
    const name = esc(lang === 'en' ? d.name : d.nameRu || d.name);
    const at = d.hp != null ? `${d.hp}/${d.maxHp} HP` : `${d.maxHp} HP (${tl(ctx, 'полное', 'full')})`;
    let body = `${tl(ctx, 'распад', 'decay')}: <b>${fmtDuration(d.atSec, lang)}</b>`;
    if (d.kind === 'vehicle' && d.insideSec != null) {
      body += `\n${tl(ctx, 'снаружи', 'outside')} ↑ · ${tl(ctx, 'в здании', 'inside')}: ${fmtDuration(d.insideSec, lang)}`;
    }
    return ctx.reply(`⏳ <b>${name}</b> · ${at}\n${panel(body)}`, HTML);
  });

  bot.command('durability', (ctx) => {
    const lang = uiLang(ctx);
    const nm = (o) => esc(lang === 'en' ? o.name : o.nameRu);
    const q = ctx.match?.trim();
    if (!q) return ctx.reply(tl(ctx, 'Использование: /durability <объект>\nНапр.: /durability бронедверь', 'Usage: /durability <structure>\nE.g.: /durability armored door'));
    const u = durabilityInfo(q);
    if (!u || !u.methods.length) return ctx.reply(tl(ctx, 'Не знаю прочность этого объекта.', 'I do not know that structure.'));
    const rows = u.methods.slice(0, 8).map((m, idx) => {
      const fuel = m.fuel ? ` · ${tl(ctx, 'топл', 'fuel')} ${numFmt(m.fuel)}` : '';
      return `${idx + 1}. <b>${nm(m)}</b> ×${numFmt(m.qty)} — 🔥 ${numFmt(m.sulfur)} · ⏱ ${fmtDuration(m.timeSec, lang)}${fuel}`;
    });
    const uTitle = esc(lang === 'en' || !u.nameRu ? u.name : u.nameRu);
    const title = tl(ctx, `🏚️ ${uTitle} — топ по сере`, `🏚️ ${esc(u.name)} — cheapest by sulfur`);
    return ctx.reply(`${title}\n${expand(rows.join('\n'))}`, HTML);
  });

  // --- Journal: notes + pins (stash journal) ---
  bot.command('note', (ctx) => {
    const text = ctx.match?.trim();
    if (!text) return ctx.reply(tl(ctx, 'Использование: /note <текст>', 'Usage: /note <text>'));
    const id = addNote(ctx.from.id, text);
    return ctx.reply(tl(ctx, `📝 Заметка #${id} сохранена.`, `📝 Note #${id} saved.`));
  });
  bot.command('notes', (ctx) => {
    const notes = listNotes(ctx.from.id);
    if (!notes.length) return ctx.reply(tl(ctx, 'Заметок нет. /note <текст>', 'No notes. /note <text>'));
    return ctx.reply(tl(ctx, '📝 Заметки:', '📝 Notes:') + '\n' + notes.map((n) => `#${n.id} ${n.text}`).join('\n'));
  });
  bot.command('delnote', (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!id) return ctx.reply(tl(ctx, 'Использование: /delnote <id>', 'Usage: /delnote <id>'));
    return ctx.reply(deleteNote(id, ctx.from.id) ? tl(ctx, `Удалено #${id}`, `Deleted #${id}`) : tl(ctx, 'Не найдено.', 'Not found.'));
  });

  bot.command('pin', (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const grid = parts.shift();
    const note = parts.join(' ');
    if (!grid || !note) return ctx.reply(tl(ctx, 'Использование: /pin <грид> <текст>\nНапр.: /pin D7 стэш, патроны', 'Usage: /pin <grid> <text>\nE.g.: /pin D7 stash, ammo'));
    const id = addPin(ctx.from.id, grid.toUpperCase(), note);
    return ctx.reply(tl(ctx, `📌 Пин #${id} на ${grid.toUpperCase()}: ${note}`, `📌 Pin #${id} at ${grid.toUpperCase()}: ${note}`));
  });
  bot.command('pins', (ctx) => {
    const grid = ctx.match?.trim();
    const pins = listPins(ctx.from.id, grid || null);
    if (!pins.length) return ctx.reply(grid ? tl(ctx, `На ${grid} пинов нет.`, `No pins at ${grid}.`) : tl(ctx, 'Пинов нет. /pin <грид> <текст>', 'No pins. /pin <grid> <text>'));
    return ctx.reply(tl(ctx, '📌 Пины:', '📌 Pins:') + '\n' + pins.map((p) => `#${p.id} [${p.grid}] ${p.note}`).join('\n'));
  });
  bot.command('unpin', (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!id) return ctx.reply(tl(ctx, 'Использование: /unpin <id>', 'Usage: /unpin <id>'));
    return ctx.reply(deletePin(id, ctx.from.id) ? tl(ctx, `Удалён пин #${id}`, `Pin #${id} removed`) : tl(ctx, 'Не найдено.', 'Not found.'));
  });

  bot.command('stats', (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const rows = sessionStats(session.id);
    if (!rows.length) return ctx.reply(tl(ctx, 'Событий пока нет.', 'No events yet.'));
    return ctx.reply(tl(ctx, '📊 События этой сессии:', '📊 Events this session:') + '\n' + rows.map((r) => `• ${r.type}: ${r.n}`).join('\n'));
  });

  // --- Smart devices ---
  bot.command('devices', (ctx) => {
    const list = listDevices(ctx.from.id);
    if (!list.length) {
      return ctx.reply(tl(ctx, 'Устройств нет. Привяжи в игре: наведись на Smart Switch/Alarm/Storage → Pair (как сервер).', 'No devices. Pair in game: aim at a Smart Switch/Alarm/Storage → Pair (like a server).'));
    }
    const icon = { 1: '🔌', 2: '🚨', 3: '📦' };
    return ctx.reply(
      tl(ctx, '🔌 Устройства:', '🔌 Devices:') + '\n' + list.map((d) => `${icon[d.type] ?? '•'} ${d.entity_id} — ${d.name || typeName(d.type)}`).join('\n'),
    );
  });

  bot.command('switch', async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const id = Number(parts[0]);
    const state = (parts[1] || '').toLowerCase();
    if (!id || !['on', 'off', 'вкл', 'выкл'].includes(state)) {
      return ctx.reply(tl(ctx, 'Использование: /switch <id> on|off', 'Usage: /switch <id> on|off'));
    }
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const on = state === 'on' || state === 'вкл';
    try {
      await session.setEntityValue(id, on);
      return ctx.reply(`🔌 ${id} → ${on ? tl(ctx, 'ВКЛ ✅', 'ON ✅') : tl(ctx, 'ВЫКЛ ⛔', 'OFF ⛔')}`);
    } catch (err) {
      return ctx.reply(tl(ctx, 'Не удалось: ', 'Failed: ') + err.message);
    }
  });

  bot.command('storage', async (ctx) => {
    const id = Number(ctx.match?.trim());
    if (!id) return ctx.reply(tl(ctx, 'Использование: /storage <id>', 'Usage: /storage <id>'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    try {
      const info = await session.getEntityInfo(id);
      const p = info?.payload;
      if (!p) return ctx.reply(tl(ctx, 'Нет данных по устройству.', 'No data for this device.'));
      const items = (p.items ?? []).slice(0, 25).map((it) => `• ${itemName(it.itemId)} ×${it.quantity}`).join('\n') || tl(ctx, 'пусто', 'empty');
      const upkeep = p.protectionExpiry
        ? tl(ctx, `\n🛡️ Upkeep до: ${new Date(p.protectionExpiry * 1000).toLocaleString('ru-RU')}`, `\n🛡️ Upkeep until: ${new Date(p.protectionExpiry * 1000).toLocaleString('en-US')}`)
        : '';
      return ctx.reply(tl(ctx, `📦 Хранилище ${id}:\n${items}${upkeep}`, `📦 Storage ${id}:\n${items}${upkeep}`));
    } catch (err) {
      return ctx.reply(tl(ctx, 'Не удалось: ', 'Failed: ') + err.message);
    }
  });

  // Item search across every paired Storage Monitor.
  bot.command('find', async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply(tl(ctx, 'Использование: /find <предмет>\nНапр.: /find сера', 'Usage: /find <item>\nE.g.: /find sulfur'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const r = await findInStorage(session, q);
    if (!r) return ctx.reply(tl(ctx, 'Не знаю такой предмет.', 'I do not know that item.'));
    if (!r.checked) return ctx.reply(tl(ctx, 'Нет привязанных Storage Monitor. Привяжи в игре (Pair).', 'No paired Storage Monitors. Pair them in game.'));
    const name = uiLang(ctx) === 'en' ? itemName(r.itemId) : itemNameRu(r.itemId);
    const failed = r.failed ? tl(ctx, `\n⚠️ Не ответили: ${r.failed}`, `\n⚠️ Did not respond: ${r.failed}`) : '';
    if (!r.hits.length) return ctx.reply(tl(ctx, `📦 ${name}: нет ни в одном из ${r.checked} ящиков.`, `📦 ${name}: not in any of ${r.checked} containers.`) + failed);
    const lines = r.hits.map((h) => `• ${h.name} — ${h.qty}`).join('\n');
    return ctx.reply(`📦 ${name} ×${r.total}\n${lines}${failed}`);
  });

  // Storage Monitor contents alerts: "/boxwatch <id|name> [off]". A name matches
  // every monitor paired under it.
  bot.command('boxwatch', async (ctx) => {
    const owner = ctx.from.id;
    const monitors = storageMonitors(owner);
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (!parts.length) {
      if (!monitors.length) return ctx.reply(tl(ctx, 'Нет привязанных Storage Monitor. Привяжи в игре (Pair).', 'No paired Storage Monitors. Pair them in game.'));
      const list = monitors.map((m) => `${m.watch ? '👁️' : '▫️'} ${m.entity_id} — ${m.name || `Storage ${m.entity_id}`}`).join('\n');
      return ctx.reply(
        tl(ctx, '📦 Слежка за ящиками (👁️ = включена):\n', '📦 Container alerts (👁️ = on):\n') +
          list +
          tl(
            ctx,
            '\n\n/boxwatch «id или имя» — сообщать, что положили/забрали\n/boxwatch «id или имя» off — выключить\nНа шкаф (TC) лучше не ставить: апкип списывается постоянно.',
            '\n\n/boxwatch «id or name» — report what was put in / taken out\n/boxwatch «id or name» off — turn off\nBetter not on a TC: upkeep is consumed all the time.',
          ),
      );
    }
    if (blockViewer(ctx)) return undefined;
    const on = !['off', 'выкл'].includes(parts[parts.length - 1].toLowerCase());
    if (!on) parts.pop();
    const hits = resolveMonitors(owner, parts.join(' '));
    if (!hits.length) return ctx.reply(tl(ctx, `Ящик «${parts.join(' ')}» не найден. Список: /boxwatch`, `Container "${parts.join(' ')}" not found. List: /boxwatch`));

    const session = sessions.sessionForUser(owner);
    for (const m of hits) {
      setStorageWatch(owner, m.entity_id, on);
      if (!session) continue;
      if (on) await session.storage.watch(m.entity_id);
      else session.storage.unwatch(m.entity_id);
    }
    const names = hits.map((m) => m.name || `Storage ${m.entity_id}`).join(', ');
    return ctx.reply(
      on
        ? tl(ctx, `👁️ Слежу: ${names}. Сообщу, что положили или забрали (сводка через 30 сек после изменений).`, `👁️ Watching: ${names}. I'll report what was put in or taken out (summary 30 s after changes).`)
        : tl(ctx, `▫️ Больше не слежу: ${names}`, `▫️ Stopped watching: ${names}`),
    );
  });

  // What recycling a container's contents would give: "/recyclebox <id|name|all> [safe]".
  bot.command(['recyclebox', 'rbox'], async (ctx) => {
    const lang = uiLang(ctx);
    const nm = (id) => esc(lang === 'en' ? itemName(id) : itemNameRu(id));
    let arg = ctx.match?.trim() ?? '';
    const safe = /(^|\s)(safe|сейф|мирка)$/i.test(arg);
    arg = arg.replace(/(^|\s)(safe|сейф|мирка)$/i, '').trim();
    if (!arg) return ctx.reply(tl(ctx, 'Использование: /recyclebox «id, имя ящика или all» [сейф]\nНапр.: /recyclebox Компоненты', 'Usage: /recyclebox «id, container name or all» [safe]\nE.g.: /recyclebox Components'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const monitors = resolveMonitors(session.ownerUserId, arg);
    if (!monitors.length) return ctx.reply(tl(ctx, `Ящик «${arg}» не найден. Список: /boxwatch`, `Container "${arg}" not found. List: /boxwatch`));
    const r = await recycleStorage(session, monitors, safe);
    const failed = r.failed ? tl(ctx, `\n⚠️ Не ответили: ${r.failed}`, `\n⚠️ Did not respond: ${r.failed}`) : '';
    if (!r.inputs.length) return ctx.reply(tl(ctx, '♻️ Перерабатывать нечего.', '♻️ Nothing to recycle.') + failed);
    const which = safe ? tl(ctx, 'переработчик в мирной зоне', 'safe-zone recycler') : tl(ctx, 'обычный переработчик', 'standard recycler');
    const ins = r.inputs.slice(0, 8).map((i) => `${nm(i.itemId)} ×${numFmt(i.qty)}`).join(', ') + (r.inputs.length > 8 ? ' …' : '');
    const outs = r.yields.map((y) => `• ${nm(y.itemId)} ${y.approx ? '≈' : '×'}${numFmt(y.qty)}`).join('\n');
    const notes = [
      r.yields.some((y) => y.approx) ? tl(ctx, '≈ — в среднем, выход с шансом', '≈ — average, chance-based output') : '',
      r.skipped ? tl(ctx, `не перерабатывается: ${r.skipped} вид(ов)`, `not recyclable: ${r.skipped} kind(s)`) : '',
    ].filter(Boolean).join(' · ');
    return ctx.reply(
      `♻️ <b>${tl(ctx, 'Переработка', 'Recycling')}</b> → <i>${which}</i>\n` +
        `<i>${ins}</i>\n${panel(outs)}` +
        (notes ? `\n<i>${notes}</i>` : '') +
        failed,
      HTML,
    );
  });

  bot.command('whereis', (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply(tl(ctx, 'Использование: /whereis <монумент>\nНапр.: /whereis аэропорт', 'Usage: /whereis <monument>\nE.g.: /whereis airfield'));
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    if (!session.mapSize()) return ctx.reply(tl(ctx, 'Карта ещё не загружена — попробуй через минуту.', 'Map not loaded yet — try again in a minute.'));
    const found = findMonuments(session.monuments(), q, session.mapSize());
    if (!found.length) return ctx.reply(tl(ctx, `Не нашёл монумент «${q}».`, `No monument matching "${q}".`));
    const en = uiLang(ctx) === 'en';
    return ctx.reply('🏛️ ' + found.map((f) => `${en ? f.en : f.ru} — ${f.grid}`).join('\n🏛️ '));
  });

  // --- Smart-home PRO: bulk control, scenes, raid reaction ---
  const setAllSwitches = async (ctx, on) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const switches = listDevices(ctx.from.id).filter((d) => d.type === 1);
    if (!switches.length) return ctx.reply(tl(ctx, 'Свитчей нет. Привяжи в игре (Pair).', 'No switches. Pair them in game (Pair).'));
    await session.applySwitches(Object.fromEntries(switches.map((d) => [d.entity_id, on])));
    return ctx.reply(tl(ctx, `🔌 Все свитчи (${switches.length}) → ${on ? 'ВКЛ ✅' : 'ВЫКЛ ⛔'}`, `🔌 All switches (${switches.length}) → ${on ? 'ON ✅' : 'OFF ⛔'}`));
  };
  bot.command('allon', (ctx) => setAllSwitches(ctx, true));
  bot.command('alloff', (ctx) => setAllSwitches(ctx, false));

  bot.command('scene', async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const sub = (parts.shift() || '').toLowerCase();
    const session = sessions.sessionForUser(ctx.from.id);

    if (sub === 'save') {
      const name = parts.join(' ');
      if (!name) return ctx.reply(tl(ctx, 'Использование: /scene save <имя>', 'Usage: /scene save <name>'));
      if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
      const switches = listDevices(ctx.from.id).filter((d) => d.type === 1);
      if (!switches.length) return ctx.reply(tl(ctx, 'Свитчей нет.', 'No switches.'));
      const states = await session.switchStates(switches.map((d) => d.entity_id));
      saveScene(ctx.from.id, name, states);
      return ctx.reply(tl(ctx, `🎬 Сцена «${name}» сохранена (${Object.keys(states).length} свитчей).`, `🎬 Scene "${name}" saved (${Object.keys(states).length} switches).`));
    }
    if (sub === 'del') {
      const name = parts.join(' ');
      return ctx.reply(deleteScene(ctx.from.id, name) ? tl(ctx, `Удалена «${name}»`, `Deleted "${name}"`) : tl(ctx, 'Не найдено.', 'Not found.'));
    }
    if (!sub) {
      const list = listScenes(ctx.from.id);
      return ctx.reply(
        list.length
          ? tl(ctx, '🎬 Сцены: ', '🎬 Scenes: ') + list.join(', ') + tl(ctx, '\n/scene <имя> — применить · /scene save <имя> · /scene del <имя>', '\n/scene <name> — apply · /scene save <name> · /scene del <name>')
          : tl(ctx, 'Сцен нет. /scene save <имя> — сохранить текущие свитчи.', 'No scenes. /scene save <name> — save the current switches.'),
      );
    }
    // apply
    const sc = getScene(ctx.from.id, sub + (parts.length ? ' ' + parts.join(' ') : ''));
    if (!sc) return ctx.reply(tl(ctx, 'Сцена не найдена. /scene — список.', 'Scene not found. /scene — list.'));
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    await session.applySwitches(sc);
    return ctx.reply(tl(ctx, `🎬 Сцена применена (${Object.keys(sc).length} свитчей).`, `🎬 Scene applied (${Object.keys(sc).length} switches).`));
  });
  bot.command('scenes', (ctx) => {
    const list = listScenes(ctx.from.id);
    return ctx.reply(list.length ? tl(ctx, '🎬 Сцены: ', '🎬 Scenes: ') + list.join(', ') : tl(ctx, 'Сцен нет. /scene save <имя>', 'No scenes. /scene save <name>'));
  });

  bot.command('onraid', (ctx) => {
    const name = ctx.match?.trim();
    if (!name) {
      const cur = getRaidScene(ctx.from.id);
      return ctx.reply(tl(ctx, `При срабатывании сигналки${cur ? ` применяется сцена «${cur}»` : ' ничего не происходит'}.\n/onraid <сцена> — назначить · /onraid off — выключить`, `When the alarm triggers${cur ? ` scene "${cur}" is applied` : ' nothing happens'}.\n/onraid <scene> — assign · /onraid off — disable`));
    }
    if (name.toLowerCase() === 'off') {
      setRaidScene(ctx.from.id, null);
      return ctx.reply(tl(ctx, '🚨 Авто-реакция на сигналку выключена.', '🚨 Auto-reaction to the alarm disabled.'));
    }
    if (!getScene(ctx.from.id, name)) return ctx.reply(tl(ctx, `Сцена «${name}» не найдена. Создай: /scene save ${name}`, `Scene "${name}" not found. Create it: /scene save ${name}`));
    setRaidScene(ctx.from.id, name);
    return ctx.reply(tl(ctx, `🚨 При сигналке будет применяться сцена «${name}».`, `🚨 Scene "${name}" will be applied on alarm.`));
  });

  // --- Automations: switches driven by night / team offline / team online / timer ---
  const AUTO_TRIGGER = {
    night: 'night', ночь: 'night',
    offline: 'offline', оффлайн: 'offline', офлайн: 'offline',
    online: 'online', онлайн: 'online',
    timer: 'timer', таймер: 'timer',
  };
  const autoUsage = (ctx) =>
    tl(
      ctx,
      '🤖 <b>Автоматизации свитчей</b>\n<blockquote>' +
        '/auto night «свитч» [off] — ВКЛ ночью, ВЫКЛ днём\n' +
        '/auto offline «свитч» [мин] [off] — ВКЛ, когда вся тима вышла (через N мин, по умолч. 1)\n' +
        '/auto online «свитч» [off] — ВКЛ, пока кто-то из тимы онлайн\n' +
        '/auto timer «свитч» «вкл_мин» «выкл_мин» — цикл (полив)\n' +
        '/auto del|pause|resume «id»</blockquote>\n' +
        '<i>«свитч» — id из /devices или имя устройства (все свитчи с этим именем = группа). ' +
        '[off] — наоборот: ВЫКЛ вместо ВКЛ. Если имя кончается цифрой, укажи id.</i>',
      '🤖 <b>Switch automations</b>\n<blockquote>' +
        '/auto night «switch» [off] — ON at night, OFF by day\n' +
        '/auto offline «switch» [min] [off] — ON when the whole team left (after N min, default 1)\n' +
        '/auto online «switch» [off] — ON while anyone in the team is online\n' +
        '/auto timer «switch» «on_min» «off_min» — cycle (watering)\n' +
        '/auto del|pause|resume «id»</blockquote>\n' +
        '<i>«switch» — id from /devices or a device name (all switches with that name = a group). ' +
        '[off] — inverted: OFF instead of ON. If a name ends with a number, use the id.</i>',
    );
  const describeRule = (ctx, r) => {
    const inv = r.params.invert;
    const on = inv ? tl(ctx, 'ВЫКЛ', 'OFF') : tl(ctx, 'ВКЛ', 'ON');
    const what = {
      night: tl(ctx, `${on} ночью`, `${on} at night`),
      offline: tl(ctx, `${on}, когда тима оффлайн (${r.params.delayMin ?? 1} мин)`, `${on} when team offline (${r.params.delayMin ?? 1} min)`),
      online: tl(ctx, `${on}, пока тима онлайн`, `${on} while team online`),
      timer: tl(ctx, `цикл ${r.params.onMin} мин ВКЛ / ${r.params.offMin} мин ВЫКЛ`, `cycle ${r.params.onMin} min ON / ${r.params.offMin} min OFF`),
    }[r.trigger] ?? r.trigger;
    return `${r.enabled ? '🟢' : '⏸️'} #${r.id} ${esc(r.target)} — ${what}`;
  };

  bot.command('auto', (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];
    const sub = (parts.shift() || '').toLowerCase();
    const owner = ctx.from.id;

    if (!sub) {
      const rules = listRules(ownerForViewer(owner) ?? owner); // viewers see the family's rules
      const list = rules.length ? rules.map((r) => describeRule(ctx, r)).join('\n') : tl(ctx, '<i>правил пока нет</i>', '<i>no rules yet</i>');
      return ctx.reply(`${list}\n\n${autoUsage(ctx)}`, HTML);
    }
    if (blockViewer(ctx)) return undefined;

    if (['del', 'удалить', 'pause', 'resume'].includes(sub)) {
      const id = Number(parts[0]);
      if (!id) return ctx.reply(tl(ctx, `Использование: /auto ${sub} <id>`, `Usage: /auto ${sub} <id>`));
      if (sub === 'pause' || sub === 'resume') {
        const ok = setRuleEnabled(owner, id, sub === 'resume');
        if (!ok) return ctx.reply(tl(ctx, 'Не найдено.', 'Not found.'));
        const rule = listRules(owner).find((r) => r.id === id);
        if (sub === 'resume' && rule) sessions.sessionForUser(owner)?.automations.applyNow(rule);
        return ctx.reply(sub === 'resume' ? tl(ctx, `▶️ #${id} включено`, `▶️ #${id} resumed`) : tl(ctx, `⏸️ #${id} на паузе`, `⏸️ #${id} paused`));
      }
      return ctx.reply(deleteRule(owner, id) ? tl(ctx, `Удалено #${id}`, `Deleted #${id}`) : tl(ctx, 'Не найдено.', 'Not found.'));
    }

    const trigger = AUTO_TRIGGER[sub];
    if (!trigger) return ctx.reply(autoUsage(ctx), HTML);
    if (countRules(owner) >= MAX_RULES) {
      return ctx.reply(tl(ctx, `Лимит ${MAX_RULES} правил. Удали лишние: /auto del <id>`, `Limit of ${MAX_RULES} rules. Delete some: /auto del <id>`));
    }

    // Trailing flags/numbers come off the end; whatever is left is the target.
    const params = {};
    if (trigger !== 'timer' && ['off', 'выкл'].includes((parts[parts.length - 1] || '').toLowerCase())) {
      parts.pop();
      params.invert = true;
    }
    const nums = [];
    const want = trigger === 'timer' ? 2 : trigger === 'offline' ? 1 : 0;
    // Keep at least one part: "/auto offline 12345" means switch 12345, not a 12345-min delay.
    while (nums.length < want && parts.length > 1 && /^\d+$/.test(parts[parts.length - 1] || '')) nums.unshift(Number(parts.pop()));
    if (trigger === 'timer') {
      if (nums.length < 2 || nums[0] < 1 || nums[1] < 1) {
        return ctx.reply(tl(ctx, 'Использование: /auto timer <свитч> <вкл_мин> <выкл_мин>\nНапр.: /auto timer Полив 2 10', 'Usage: /auto timer <switch> <on_min> <off_min>\nE.g.: /auto timer Water 2 10'));
      }
      [params.onMin, params.offMin] = nums;
    }
    if (trigger === 'offline' && nums.length) params.delayMin = Math.min(nums[0], 120);

    const target = parts.join(' ');
    if (!target) return ctx.reply(autoUsage(ctx), HTML);
    const ids = resolveTarget(owner, target);
    if (!ids.length) {
      return ctx.reply(tl(ctx, `Свитч «${target}» не найден. Список: /devices`, `Switch "${target}" not found. List: /devices`));
    }

    const id = addRule(owner, trigger, target, params);
    const rule = listRules(owner).find((r) => r.id === id);
    const applied = rule ? sessions.sessionForUser(owner)?.automations.applyNow(rule) : null;
    const now = applied == null ? '' : tl(ctx, '\nПрименено к текущему состоянию.', '\nApplied to the current state.');
    return ctx.reply(
      tl(ctx, `✅ Правило добавлено (${ids.length} свитч.):\n`, `✅ Rule added (${ids.length} switch(es)):\n`) + describeRule(ctx, rule) + now,
      HTML,
    );
  });

  // Vending machine / market commands read map markers, which Facepunch stopped
  // sending over Rust+ on 2026-08-06. Keep the commands registered so old users
  // get an explanation instead of silence.
  bot.command(['market', 'price', 'deals', 'pricehistory', 'watch', 'watchlist', 'unwatch', 'markers'], (ctx) =>
    ctx.reply(
      tl(
        ctx,
        '🚫 Эта функция больше недоступна: 6 августа 2026 Facepunch убрали из Rust+ все маркеры карты — магазины, карго, хели и другие события. Это касается всех Rust+ ботов.',
        '🚫 This feature is no longer available: on August 6, 2026 Facepunch removed all map markers from Rust+ — shops, cargo, heli and other events. This affects every Rust+ bot.',
      ),
    ),
  );

  // Tactical map: rendered PNG with team, oil rigs, recent deaths, in-game map
  // notes and the owner's labelled pins. Gated by MAP_RENDER (jimp is RAM-heavy);
  // when off, point at /rustmap. Pin labels are numbers on the image → spelled out
  // in the caption (the bundled font can't draw Cyrillic).
  bot.command('map', async (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    if (!config.map.render) {
      return ctx.reply(tl(ctx, '🗺️ Рендер карты выключен (MAP_RENDER=off). Детальная карта: /rustmap', '🗺️ Map render is off (MAP_RENDER=off). Detailed map: /rustmap'));
    }
    const mapSize = session.mapSize();
    if (!mapSize) return ctx.reply(tl(ctx, 'Карта ещё не загружена — попробуй через минуту.', 'Map not loaded yet — try again in a minute.'));
    await ctx.reply(tl(ctx, '🗺️ Рисую карту…', '🗺️ Rendering the map…'));
    try {
      const pins = listPins(session.ownerUserId)
        .map((p) => {
          const c = gridCenterXY(p.grid, mapSize);
          return c ? { x: c.x, y: c.y, note: p.note, grid: p.grid } : null;
        })
        .filter(Boolean)
        .slice(0, 20)
        .map((p, i) => ({ ...p, label: String(i + 1) }));
      const png = await session.tacticalMap({ pins });
      const legend = pins.length
        ? '\n📍 ' + pins.map((p) => `${p.label} — ${String(p.note).slice(0, 20)} (${p.grid})`).join(', ')
        : '';
      await ctx.replyWithPhoto(new InputFile(Buffer.from(png), 'map.png'), {
        caption: tl(ctx, '🗺️ Карта: тима, нефтянки, смерти, метки', '🗺️ Map: team, oil rigs, deaths, pins') + legend,
      });
    } catch (err) {
      await ctx.reply(tl(ctx, 'Не удалось нарисовать карту: ', 'Could not render the map: ') + err.message);
    }
  });

  bot.command('rustmap', (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const seed = session.seed();
    const sz = session.mapSize();
    if (!seed || !sz) return ctx.reply(tl(ctx, 'Сид карты ещё не загружен — попробуй через минуту.', 'Map seed not loaded yet — try again in a minute.'));
    return ctx.reply(
      tl(
        ctx,
        `🗺️ Детальная карта сервера (RustMaps):\nhttps://rustmaps.com/map/${sz}_${seed}\n\nМонументы, грид, лут и спавны — всё там.`,
        `🗺️ Detailed server map (RustMaps):\nhttps://rustmaps.com/map/${sz}_${seed}\n\nMonuments, grid, loot and spawns — all there.`,
      ),
    );
  });

  // Capture one camera frame and send it, with friendly errors. Shared by
  // the /cam command and the /cams inline buttons.
  const snapshotTo = async (ctx, session, id) => {
    await ctx.reply(tl(ctx, `📷 Подключаюсь к камере «${id}»…`, `📷 Connecting to camera "${id}"…`));
    try {
      const png = await session.cameraSnapshot(id);
      await ctx.replyWithPhoto(new InputFile(Buffer.from(png), 'cam.png'), { caption: `📷 ${id}` });
    } catch (err) {
      const msg = err.message || String(err);
      if (/player_online/i.test(msg)) {
        await ctx.reply(tl(ctx, '📷 Нельзя смотреть камеры, пока ты сам активно в игре на этом сервере — Rust+ блокирует (конфликт с твоим персонажем). Выйди из игры (оставшись «спать» на сервере) и попробуй снова.', '📷 You cannot view cameras while you are actively in game on this server — Rust+ blocks it (conflict with your character). Leave the game (stay "asleep" on the server) and try again.'));
      } else if (/no_player/i.test(msg)) {
        await ctx.reply(tl(ctx, '📷 На сервере нет твоего «тела». Камеры Rust+ работают, только если твой аккаунт есть на сервере как игрок: зайди хоть раз (оставь спальник/тело), потом смотри камеры оффлайн.', '📷 Your "body" is not on the server. Rust+ cameras only work if your account exists on the server as a player: join at least once (leave a sleeping bag/body), then view cameras offline.'));
      } else if (/access_denied/i.test(msg)) {
        await ctx.reply(
          tl(
            ctx,
            `📷 Доступ к камере «${id}» запрещён (access_denied).\n\n` +
              'Rust+ отдаёт только камеры, на которые авторизован твой аккаунт. Чтобы смотреть свою базу:\n' +
              '1) поставь CCTV-камеру и подай на неё питание (электричество);\n' +
              '2) посмотри на камеру → задай идентификатор в поле на ней — его и пиши в /cam;\n' +
              '3) будь авторизован в зоне базы (твой шкаф/ШИП) — бот смотрит твоим аккаунтом.\n\n' +
              'Камеры монументов (OILRIG, DOME, и т.п.) через Rust+ удалённо недоступны — их видно только с игрового Computer Station.',
            `📷 Access to camera "${id}" denied (access_denied).\n\n` +
              'Rust+ only serves cameras your account is authorized on. To view your own base:\n' +
              '1) place a CCTV camera and supply it with power (electricity);\n' +
              '2) look at the camera → set an identifier in the field on it — that is what you put in /cam;\n' +
              '3) be authorized in the base zone (your tool cupboard) — the bot views as your account.\n\n' +
              'Monument cameras (OILRIG, DOME, etc.) are not available remotely via Rust+ — they are only visible from an in-game Computer Station.',
          ),
        );
      } else if (/not_found/i.test(msg)) {
        await ctx.reply(tl(ctx, `📷 Камера «${id}» не найдена. Проверь идентификатор, заданный на самой камере (например MYBASE), и что камера под питанием.`, `📷 Camera "${id}" not found. Check the identifier set on the camera itself (e.g. MYBASE) and that the camera is powered.`));
      } else {
        await ctx.reply(tl(ctx, 'Не удалось получить кадр: ', 'Could not get a frame: ') + msg);
      }
    }
  };

  bot.command('cam', async (ctx) => {
    const raw = ctx.match?.trim() ?? '';
    const restParts = raw.split(/\s+/).filter(Boolean);
    const sub = restParts[0]?.toLowerCase();

    if (!raw) {
      return ctx.reply(
        tl(
          ctx,
          'Использование:\n' +
            '/cam <имя|идентификатор> — снимок камеры\n' +
            '/cam add <идентификатор> [имя] — сохранить камеру\n' +
            '/cam del <имя|идентификатор> — удалить\n' +
            '/cams — список сохранённых (кнопками)\n\n' +
            'Идентификатор — имя, заданное на самой CCTV-камере (например MYBASE). Нужны питание камеры и твоя авторизация в зоне базы. Камеры монументов (OILRIG/DOME) удалённо недоступны.',
          'Usage:\n' +
            '/cam <name|identifier> — camera snapshot\n' +
            '/cam add <identifier> [name] — save a camera\n' +
            '/cam del <name|identifier> — remove\n' +
            '/cams — list saved (with buttons)\n\n' +
            'The identifier is the name set on the CCTV camera itself (e.g. MYBASE). Camera power and your authorization in the base zone are required. Monument cameras (OILRIG/DOME) are not available remotely.',
        ),
      );
    }

    if (sub === 'add') {
      const identifier = restParts[1];
      if (!identifier) return ctx.reply(tl(ctx, 'Использование: /cam add <идентификатор> [имя]', 'Usage: /cam add <identifier> [name]'));
      const label = restParts.slice(2).join(' ') || null;
      addCamera(ctx.from.id, identifier, label);
      return ctx.reply(tl(ctx, `✅ Камера сохранена: ${label ? `${label} (${identifier})` : identifier}.\nСмотреть: /cam ${label || identifier} · список: /cams`, `✅ Camera saved: ${label ? `${label} (${identifier})` : identifier}.\nView: /cam ${label || identifier} · list: /cams`));
    }

    if (sub === 'del' || sub === 'rm' || sub === 'remove') {
      const target = restParts.slice(1).join(' ');
      if (!target) return ctx.reply(tl(ctx, 'Использование: /cam del <имя|идентификатор>', 'Usage: /cam del <name|identifier>'));
      const identifier = resolveCamera(ctx.from.id, target) || target;
      return ctx.reply(removeCamera(ctx.from.id, identifier) ? tl(ctx, `🗑 Удалена: ${identifier}`, `🗑 Removed: ${identifier}`) : tl(ctx, `Не нашёл сохранённую камеру «${target}».`, `Could not find a saved camera "${target}".`));
    }

    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    const id = resolveCamera(ctx.from.id, raw) || raw;
    await snapshotTo(ctx, session, id);
  });

  bot.command('cams', (ctx) => {
    const cams = listCameras(ctx.from.id);
    if (!cams.length) {
      return ctx.reply(tl(ctx, 'Сохранённых камер нет. Добавь: /cam add <идентификатор> [имя]', 'No saved cameras. Add one: /cam add <identifier> [name]'));
    }
    const kb = new InlineKeyboard();
    for (const c of cams) {
      const title = c.label ? `${c.label} (${c.identifier})` : c.identifier;
      if (`cam:${c.identifier}`.length <= 64) kb.text(`📷 ${title}`, `cam:${c.identifier}`).row();
    }
    return ctx.reply(tl(ctx, '📷 Твои камеры — нажми, чтобы посмотреть:', '📷 Your cameras — tap to view:'), { reply_markup: kb });
  });

  bot.callbackQuery(/^cam:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery();
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    await snapshotTo(ctx, session, id);
  });

  bot.command('time', async (ctx) => {
    const session = sessions.sessionForUser(ctx.from.id);
    if (!session) return ctx.reply(tl(ctx, 'Нет активной сессии.', 'No active session.'));
    try {
      const t = await session.getTime();
      const d = dayNight(t);
      if (!d) return ctx.reply(tl(ctx, 'Время сервера недоступно.', 'Server time unavailable.'));
      const phaseRu = d.isDay ? '☀️ Сейчас день' : '🌙 Сейчас ночь';
      const phaseEn = d.isDay ? '☀️ Daytime now' : '🌙 Nighttime now';
      const toRu = d.mins == null ? '' : `\n⏳ до ${d.isDay ? 'ночи' : 'рассвета'} ~<b>${d.mins} мин</b> реального времени`;
      const toEn = d.mins == null ? '' : `\n⏳ ~<b>${d.mins} min</b> of real time to ${d.isDay ? 'night' : 'dawn'}`;
      return ctx.reply(
        tl(
          ctx,
          `🕒 <b>Время сервера</b>\n` + panel(phaseRu + toRu),
          `🕒 <b>Server time</b>\n` + panel(phaseEn + toEn),
        ),
        HTML,
      );
    } catch (err) {
      return ctx.reply(tl(ctx, 'Не удалось получить время: ', 'Could not get the time: ') + err.message);
    }
  });

  bot.catch((err) => log.error('grammY error:', err.error?.message || err.error));
  return bot;
}
