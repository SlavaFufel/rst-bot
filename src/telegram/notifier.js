import { bus, EVENTS } from '../core/eventbus.js';
import { db } from '../store/db.js';
import { log } from '../logger.js';
import { fmt } from './format.js';
import { matchOrders } from '../features/watchlist.js';
import { itemName } from '../util/items.js';
import { getScene, getRaidScene } from '../devices/scenes.js';
import { mirrorEnabled, langOf } from '../access/users.js';
import { L } from './i18n.js';

// event -> { type: subscription key, toGame: mirror into in-game team chat }
const ROUTES = {
  [EVENTS.CARGO_SPAWNED]: { type: 'cargo', toGame: true },
  [EVENTS.CARGO_LEFT]: { type: 'cargo', toGame: false },
  [EVENTS.CARGO_CRATE_SPAWNED]: { type: 'cargo', toGame: true },
  [EVENTS.CARGO_CRATE_LOOTED]: { type: 'cargo', toGame: true },
  [EVENTS.HELI_SPAWNED]: { type: 'heli', toGame: true },
  [EVENTS.HELI_DOWN]: { type: 'heli', toGame: true },
  [EVENTS.CH47_SPAWNED]: { type: 'ch47', toGame: true },
  [EVENTS.OILRIG_TRIGGERED]: { type: 'oilrig', toGame: true },
  [EVENTS.OILRIG_CRATE_READY]: { type: 'oilrig', toGame: true },
  [EVENTS.BRADLEY_DESTROYED]: { type: 'bradley', toGame: false },
  [EVENTS.SHOP_NEW]: { type: 'shop', toGame: false },
  [EVENTS.SHOP_GONE]: { type: 'shop', toGame: false },
  [EVENTS.TEAM_JOIN]: { type: 'team', toGame: false },
  [EVENTS.TEAM_LEAVE]: { type: 'team', toGame: false },
  [EVENTS.TEAM_DEATH]: { type: 'team', toGame: false },
  [EVENTS.TEAM_RESPAWN]: { type: 'team', toGame: false },
  [EVENTS.TEAM_AFK]: { type: 'team', toGame: false },
  [EVENTS.VENDOR_SPAWNED]: { type: 'vendor', toGame: false },
  [EVENTS.FRIEND_ONLINE]: { type: 'friend', toGame: false },
  [EVENTS.FRIEND_OFFLINE]: { type: 'friend', toGame: false },
  [EVENTS.ENEMY_ONLINE]: { type: 'enemy', toGame: true },
  [EVENTS.ENEMY_OFFLINE]: { type: 'enemy', toGame: true },
  [EVENTS.WIPE_DETECTED]: { type: 'server', toGame: false },
  [EVENTS.SERVER_DOWN]: { type: 'server', toGame: false },
  [EVENTS.SERVER_UP]: { type: 'server', toGame: false },
  [EVENTS.ALARM]: { type: 'alarm', toGame: false },
  [EVENTS.TIME_DAY]: { type: 'time', toGame: false },
  [EVENTS.TIME_NIGHT]: { type: 'time', toGame: false },
  [EVENTS.TIME_DAY_SOON]: { type: 'time', toGame: false },
  [EVENTS.TIME_NIGHT_SOON]: { type: 'time', toGame: false },
};

const subStmt = db.prepare('SELECT enabled FROM subscriptions WHERE user_id = ? AND event_type = ?');
const userStmt = db.prepare('SELECT quiet_from, quiet_to FROM users WHERE telegram_id = ?');
const allUsersStmt = db.prepare('SELECT telegram_id FROM users');

function wants(userId, type) {
  const row = subStmt.get(userId, type);
  return row ? row.enabled === 1 : true; // default ON
}

function inQuietHours(user) {
  if (!user || user.quiet_from == null || user.quiet_to == null) return false;
  const hour = new Date().getHours();
  const { quiet_from: from, quiet_to: to } = user;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

// text can be a string or a (lang) => string builder, so each recipient gets
// their own language without the caller pre-rendering.
function deliver(bot, userId, type, text) {
  if (!wants(userId, type)) return;
  if (inQuietHours(userStmt.get(userId))) return;
  const msg = typeof text === 'function' ? text(langOf(userId)) : text;
  if (!msg) return;
  bot.api.sendMessage(userId, msg).catch((err) => log.warn('tg send:', err.message));
}

export function createNotifier(bot, sessionManager) {
  // Per-session funnel: an event from session S reaches S's owner (+ viewers).
  sessionManager.onEvent = (session, event, payload) => {
    const recipients = sessionManager.recipientsOf(session);

    if (event === 'chat:fromGame') {
      const text = `💬 ${payload.name}: ${payload.message}`;
      for (const uid of recipients) bot.api.sendMessage(uid, text).catch(() => {});
      return;
    }

    const route = ROUTES[event];
    if (!route) return;
    const ruText = fmt(event, payload, 'ru'); // for the guard + in-game mirror
    if (!ruText) return;
    for (const uid of recipients) deliver(bot, uid, route.type, (lang) => fmt(event, payload, lang));
    // Mirror the alert into the in-game team chat when the owner has it enabled.
    if (mirrorEnabled(session.ownerUserId)) session.sendToGame(ruText);

    // Smart-home PRO: auto-apply a scene when the owner's Smart Alarm triggers.
    if (event === EVENTS.ALARM) {
      const sceneName = getRaidScene(session.ownerUserId);
      if (sceneName) {
        const scene = getScene(session.ownerUserId, sceneName);
        if (scene) session.applySwitches(scene).catch(() => {});
      }
    }

    // Watchlist: a new shop's sell orders may match someone's tracked items.
    if (event === EVENTS.SHOP_NEW && payload.sellOrders?.length) {
      for (const uid of recipients) {
        const lang = langOf(uid);
        for (const h of matchOrders(uid, payload.sellOrders)) {
          const line = L(
            lang,
            `🔔 Watchlist: ${itemName(h.itemId)} за ${h.price} ${itemName(h.currencyId)} (сток ${h.stock}) — ${payload.grid}`,
            `🔔 Watchlist: ${itemName(h.itemId)} for ${h.price} ${itemName(h.currencyId)} (stock ${h.stock}) — ${payload.grid}`,
          );
          bot.api.sendMessage(uid, line).catch(() => {});
        }
      }
    }
  };

  // SteamTracker is still global (friends are global and disabled without an API
  // key); deliver FRIEND events to all users until per-owner friends land (phase 7).
  for (const event of [EVENTS.FRIEND_ONLINE, EVENTS.FRIEND_OFFLINE]) {
    bus.on(event, (payload) => {
      if (!fmt(event, payload, 'ru')) return;
      for (const u of allUsersStmt.all()) deliver(bot, u.telegram_id, 'friend', (lang) => fmt(event, payload, lang));
    });
  }

  // Per-owner events emitted on the global bus (carry ownerId) — deliver to the
  // owner + their family viewers, and mirror to team chat like session events do.
  const ownerEvents = [
    [EVENTS.ENEMY_ONLINE, 'enemy'],
    [EVENTS.ENEMY_OFFLINE, 'enemy'],
    [EVENTS.DECAY_WARNING, 'decay'],
  ];
  for (const [event, type] of ownerEvents) {
    bus.on(event, (payload) => {
      if (!payload?.ownerId) return;
      const ruText = fmt(event, payload, 'ru');
      if (!ruText) return;
      const session = sessionManager.byOwner.get(payload.ownerId);
      const recipients = session ? sessionManager.recipientsOf(session) : [payload.ownerId];
      for (const uid of recipients) deliver(bot, uid, type, (lang) => fmt(event, payload, lang));
      // Mirror to the owner's in-game team chat (same rule as session-funnel events).
      if (ROUTES[event]?.toGame && session && mirrorEnabled(payload.ownerId)) session.sendToGame(ruText);
    });
  }
}
