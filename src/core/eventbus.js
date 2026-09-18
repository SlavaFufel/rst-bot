import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

// World/server/team events emitted across the app.
export const EVENTS = Object.freeze({
  CARGO_SPAWNED: 'cargo_spawned',
  CARGO_LEFT: 'cargo_left',
  CARGO_CRATE_SPAWNED: 'cargo_crate_spawned',
  CARGO_CRATE_LOOTED: 'cargo_crate_looted',
  HELI_SPAWNED: 'heli_spawned',
  HELI_DOWN: 'heli_down',
  CH47_SPAWNED: 'ch47_spawned',
  OILRIG_TRIGGERED: 'oilrig_triggered',
  OILRIG_CRATE_READY: 'oilrig_crate_ready',
  BRADLEY_DESTROYED: 'bradley_destroyed',
  SHOP_NEW: 'shop_new',
  SHOP_GONE: 'shop_gone',
  WATCH_HIT: 'watch_hit',
  TEAM_JOIN: 'team_join',
  TEAM_LEAVE: 'team_leave',
  TEAM_DEATH: 'team_death',
  TEAM_RESPAWN: 'team_respawn',
  TEAM_AFK: 'team_afk',
  TEAM_CHAT_IN: 'team_chat_in',
  VENDOR_SPAWNED: 'vendor_spawned',
  DECAY_WARNING: 'decay_warning',
  FRIEND_ONLINE: 'friend_online',
  FRIEND_OFFLINE: 'friend_offline',
  ENEMY_ONLINE: 'enemy_online',
  ENEMY_OFFLINE: 'enemy_offline',
  WIPE_DETECTED: 'wipe_detected',
  SERVER_DOWN: 'server_down',
  SERVER_UP: 'server_up',
  ALARM: 'alarm',
  TIME_DAY: 'time_day',
  TIME_NIGHT: 'time_night',
  TIME_DAY_SOON: 'time_day_soon',
  TIME_NIGHT_SOON: 'time_night_soon',
});

// Event types a user can subscribe to (key = subscription type stored in DB).
export const SUBSCRIBABLE = Object.freeze([
  { type: 'cargo', label: 'Cargo Ship' },
  { type: 'heli', label: 'Patrol Heli' },
  { type: 'ch47', label: 'Chinook (CH47)' },
  { type: 'oilrig', label: 'Нефтянка' },
  { type: 'bradley', label: 'Bradley' },
  { type: 'shop', label: 'Новые магазины' },
  { type: 'team', label: 'Тима (вход/смерть)' },
  { type: 'friend', label: 'Друзья онлайн' },
  { type: 'enemy', label: 'Враги онлайн' },
  { type: 'server', label: 'Сервер/вайп' },
  { type: 'alarm', label: 'Рейд-сигналка' },
  { type: 'time', label: 'День/ночь' },
  { type: 'vendor', label: 'Бродячий торговец' },
  { type: 'decay', label: 'Upkeep/декей базы' },
]);
