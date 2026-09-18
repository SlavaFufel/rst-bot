import { EVENTS } from '../core/eventbus.js';

const OIL_RIG_RU = { small: 'Малая нефтянка', large: 'Большая нефтянка' };
const OIL_RIG_EN = { small: 'Small Oil Rig', large: 'Large Oil Rig' };

// Bilingual alert formatters: { ru, en }. fmt(event, payload, lang) renders in
// the recipient's language (notifier picks lang per user); the in-game team-chat
// mirror always passes 'ru'.
const FORMATTERS = {
  [EVENTS.CARGO_SPAWNED]: {
    ru: (p) => `🚢 Cargo Ship заспавнился (${p.grid})`,
    en: (p) => `🚢 Cargo Ship spawned (${p.grid})`,
  },
  [EVENTS.CARGO_LEFT]: {
    ru: () => '🚢 Cargo Ship ушёл с карты',
    en: () => '🚢 Cargo Ship left the map',
  },
  [EVENTS.CARGO_CRATE_SPAWNED]: {
    ru: (p) => `📦 Карго: заспавнился крейт #${p.n} (${p.grid})`,
    en: (p) => `📦 Cargo: crate #${p.n} spawned (${p.grid})`,
  },
  [EVENTS.CARGO_CRATE_LOOTED]: {
    ru: (p) => `📭 Карго: крейт слутали${p.left ? ` (осталось ${p.left})` : ''} (${p.grid})`,
    en: (p) => `📭 Cargo: crate looted${p.left ? ` (${p.left} left)` : ''} (${p.grid})`,
  },
  [EVENTS.HELI_SPAWNED]: {
    ru: (p) => `🚁 Патрульный вертолёт (${p.grid})`,
    en: (p) => `🚁 Patrol Helicopter (${p.grid})`,
  },
  [EVENTS.HELI_DOWN]: {
    ru: (p) => `🚁💥 Вертолёт уничтожен${p.grid ? ` (${p.grid})` : ''}`,
    en: (p) => `🚁💥 Helicopter destroyed${p.grid ? ` (${p.grid})` : ''}`,
  },
  [EVENTS.CH47_SPAWNED]: {
    ru: (p) => `🚁 Chinook (CH47) на карте — ${p.grid}`,
    en: (p) => `🚁 Chinook (CH47) on the map — ${p.grid}`,
  },
  [EVENTS.OILRIG_TRIGGERED]: {
    ru: (p) => `🛢️ ${OIL_RIG_RU[p.rig] ?? 'Нефтянка'} активирована — прилетел CH47 с учёными · ящик откроется ~через 15 мин`,
    en: (p) => `🛢️ ${OIL_RIG_EN[p.rig] ?? 'Oil Rig'} triggered — CH47 brought scientists · crate unlocks in ~15 min`,
  },
  [EVENTS.OILRIG_CRATE_READY]: {
    ru: (p) => `🛢️ ${OIL_RIG_RU[p.rig] ?? 'Нефтянка'}: ящик разблокирован — можно лутать (≈таймер)`,
    en: (p) => `🛢️ ${OIL_RIG_EN[p.rig] ?? 'Oil Rig'}: locked crate unlocked — ready to loot (≈timer)`,
  },
  [EVENTS.BRADLEY_DESTROYED]: {
    ru: (p) => `💥 Взрыв у ${p.where} (Bradley / вертолёт)`,
    en: (p) => `💥 Explosion at ${p.where} (Bradley / heli)`,
  },
  [EVENTS.SHOP_NEW]: {
    ru: (p) => `🏪 Новый магазин (${p.grid})`,
    en: (p) => `🏪 New shop (${p.grid})`,
  },
  [EVENTS.SHOP_GONE]: {
    ru: (p) => `🏪❌ Магазин пропал (${p.grid})`,
    en: (p) => `🏪❌ Shop gone (${p.grid})`,
  },
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
  [EVENTS.VENDOR_SPAWNED]: {
    ru: (p) => `🛒 Бродячий торговец (${p.grid})`,
    en: (p) => `🛒 Traveling Vendor (${p.grid})`,
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
