import { EVENTS } from '../core/eventbus.js';
import { itemName, itemNameRu } from '../util/items.js';

const STORAGE_MAX_LINES = 10;

// "📦 Склад\n➕ 500 Сера\n➖ 2 C4\n…ещё 3"
function storageChange(p, lang) {
  const name = (c) => (lang === 'en' ? itemName(c.itemId) : itemNameRu(c.itemId)) + (c.bp ? ' (BP)' : '');
  const lines = p.changes.slice(0, STORAGE_MAX_LINES).map((c) => `${c.delta > 0 ? '➕' : '➖'} ${Math.abs(c.delta)} ${name(c)}`);
  const more = p.changes.length - STORAGE_MAX_LINES;
  if (more > 0) lines.push(lang === 'en' ? `…${more} more` : `…ещё ${more}`);
  return `📦 ${p.name}\n${lines.join('\n')}`;
}

const AUTO_REASON_RU = { night: 'ночь', day: 'день', team_offline: 'тима оффлайн', team_online: 'тима онлайн' };
const AUTO_REASON_EN = { night: 'night', day: 'day', team_offline: 'team offline', team_online: 'team online' };

// Bilingual alert formatters: { ru, en }. fmt(event, payload, lang) renders in
// the recipient's language (notifier picks lang per user); the in-game team-chat
// mirror always passes 'ru'.
const FORMATTERS = {
  [EVENTS.TEAM_JOIN]: {
    ru: (p) => `🟢 ${p.name} зашёл на сервер`,
    en: (p) => `🟢 ${p.name} joined the server`,
  },
  [EVENTS.TEAM_LEAVE]: {
    ru: (p) => `⚪ ${p.name} вышел`,
    en: (p) => `⚪ ${p.name} left`,
  },
  [EVENTS.TEAM_DEATH]: {
    ru: (p) => `☠️ ${p.name} умер (${p.grid})`,
    en: (p) => `☠️ ${p.name} died (${p.grid})`,
  },
  [EVENTS.TEAM_RESPAWN]: {
    ru: (p) => `♻️ ${p.name} возродился (${p.grid})`,
    en: (p) => `♻️ ${p.name} respawned (${p.grid})`,
  },
  [EVENTS.TEAM_AFK]: {
    ru: (p) => `😴 ${p.name} AFK уже ${p.minutes} мин`,
    en: (p) => `😴 ${p.name} AFK for ${p.minutes} min`,
  },
  [EVENTS.DECAY_WARNING]: {
    ru: (p) => `🧱 Upkeep заканчивается: ${p.name} — осталось ~${p.hours} ч, база начнёт разрушаться`,
    en: (p) => `🧱 Upkeep running out: ${p.name} — ~${p.hours}h left, base will start decaying`,
  },
  [EVENTS.FRIEND_ONLINE]: {
    ru: (p) => `🟢 ${p.label} ${p.inRust ? 'зашёл в Rust' : 'в сети'}`,
    en: (p) => `🟢 ${p.label} ${p.inRust ? 'joined Rust' : 'online'}`,
  },
  [EVENTS.FRIEND_OFFLINE]: {
    ru: (p) => `⚪ ${p.label} вышел`,
    en: (p) => `⚪ ${p.label} went offline`,
  },
  [EVENTS.ENEMY_ONLINE]: {
    ru: (p) => `🎯 ${p.label} зашёл в Rust${p.server ? ` (${p.server})` : ''}`,
    en: (p) => `🎯 ${p.label} joined Rust${p.server ? ` (${p.server})` : ''}`,
  },
  [EVENTS.ENEMY_OFFLINE]: {
    ru: (p) => `🎯 ${p.label} вышел`,
    en: (p) => `🎯 ${p.label} went offline`,
  },
  [EVENTS.ENEMY_GROUP_OFFLINE]: {
    ru: (p) => `🎯 Вся группа «${p.group}» вышла (${p.count} игроков) — база без присмотра`,
    en: (p) => `🎯 The whole "${p.group}" group went offline (${p.count} players) — their base is unattended`,
  },
  [EVENTS.WIPE_DETECTED]: {
    ru: () => '🧹 ВАЙП! Сервер сменил seed. Бот мог выпасть из тимы → /repair',
    en: () => '🧹 WIPE! The server changed seed. The bot may have dropped from the team → /repair',
  },
  [EVENTS.SERVER_DOWN]: { ru: () => '🔴 Сервер недоступен', en: () => '🔴 Server unreachable' },
  [EVENTS.SERVER_UP]: { ru: () => '🟢 Сервер снова онлайн', en: () => '🟢 Server back online' },
  [EVENTS.ALARM]: {
    ru: (p) => `🚨 РЕЙД-СИГНАЛКА: ${p.title ?? 'Smart Alarm'} — ${p.message ?? ''}`,
    en: (p) => `🚨 RAID ALARM: ${p.title ?? 'Smart Alarm'} — ${p.message ?? ''}`,
  },
  [EVENTS.AUTOMATION]: {
    ru: (p) => `🤖 Авто #${p.id}: ${p.target} → ${p.on ? 'ВКЛ' : 'ВЫКЛ'} (${AUTO_REASON_RU[p.reason] ?? p.reason})`,
    en: (p) => `🤖 Auto #${p.id}: ${p.target} → ${p.on ? 'ON' : 'OFF'} (${AUTO_REASON_EN[p.reason] ?? p.reason})`,
  },
  [EVENTS.STORAGE_CHANGE]: { ru: (p) => storageChange(p, 'ru'), en: (p) => storageChange(p, 'en') },
  [EVENTS.TIME_DAY]: { ru: (p) => `🌅 Рассвет (в игре ${p.time})`, en: (p) => `🌅 Sunrise (in-game ${p.time})` },
  [EVENTS.TIME_NIGHT]: {
    ru: (p) => `🌙 Закат — наступает ночь (в игре ${p.time})`,
    en: (p) => `🌙 Sunset — night is falling (in-game ${p.time})`,
  },
  [EVENTS.TIME_NIGHT_SOON]: {
    ru: (p) => `🌆 Скоро стемнеет — ночь через ~${p.mins ?? 10} мин реал. (в игре ≈${p.at})`,
    en: (p) => `🌆 Getting dark — night in ~${p.mins ?? 10} real min (in-game ≈${p.at})`,
  },
  [EVENTS.TIME_DAY_SOON]: {
    ru: (p) => `🌄 Скоро рассвет — через ~${p.mins ?? 10} мин реал. (в игре ≈${p.at})`,
    en: (p) => `🌄 Dawn in ~${p.mins ?? 10} real min (in-game ≈${p.at})`,
  },
};

export function fmt(event, payload, lang = 'ru') {
  const f = FORMATTERS[event];
  if (!f) return null;
  return (f[lang] ?? f.ru)(payload ?? {});
}
