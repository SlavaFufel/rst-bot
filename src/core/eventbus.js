import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

// World/server/team events emitted across the app. Map-marker events (cargo,
// heli, CH47/oil rig, Bradley, shops, travelling vendor) were removed after
// Facepunch stopped sending markers over Rust+ on 2026-08-06.
export const EVENTS = Object.freeze({
  TEAM_JOIN: 'team_join',
  TEAM_LEAVE: 'team_leave',
  TEAM_DEATH: 'team_death',
  TEAM_RESPAWN: 'team_respawn',
  TEAM_AFK: 'team_afk',
  TEAM_CHAT_IN: 'team_chat_in',
  DECAY_WARNING: 'decay_warning',
  FRIEND_ONLINE: 'friend_online',
  FRIEND_OFFLINE: 'friend_offline',
  ENEMY_ONLINE: 'enemy_online',
  ENEMY_OFFLINE: 'enemy_offline',
  ENEMY_GROUP_OFFLINE: 'enemy_group_offline',
  WIPE_DETECTED: 'wipe_detected',
  SERVER_DOWN: 'server_down',
  SERVER_UP: 'server_up',
  ALARM: 'alarm',
  AUTOMATION: 'automation',
  STORAGE_CHANGE: 'storage_change',
  TIME_DAY: 'time_day',
  TIME_NIGHT: 'time_night',
  TIME_DAY_SOON: 'time_day_soon',
  TIME_NIGHT_SOON: 'time_night_soon',
});

// Event types a user can subscribe to (key = subscription type stored in DB).
export const SUBSCRIBABLE = Object.freeze([
  { type: 'team', label: 'Тима (вход/смерть)' },
  { type: 'friend', label: 'Друзья онлайн' },
  { type: 'enemy', label: 'Враги онлайн' },
  { type: 'server', label: 'Сервер/вайп' },
  { type: 'alarm', label: 'Рейд-сигналка' },
  { type: 'auto', label: 'Автоматизации' },
  { type: 'storage', label: 'Ящики (/boxwatch)' },
  { type: 'time', label: 'День/ночь' },
  { type: 'decay', label: 'Upkeep/декей базы' },
]);
