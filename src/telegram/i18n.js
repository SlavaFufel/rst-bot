// Tiny i18n layer. t(lang, key, vars?) → string. Falls back to RU (the bot's
// first language) for any missing key. Deep command replies are localised
// incrementally; the core surface (start, picker, help, raid) is bilingual.

export const LANGS = ['ru', 'en'];
export const langName = { ru: '🇷🇺 Русский', en: '🇬🇧 English' };

const DICT = {
  pick_prompt: {
    ru: '🌐 Выберите язык интерфейса:',
    en: '🌐 Choose your language:',
  },
  pick_done: { ru: 'Готово — язык: Русский 🇷🇺', en: 'Done — language: English 🇬🇧' },

  start_title: { ru: 'Rust+ бот', en: 'Rust+ Bot' },
  start_tagline: {
    ru: 'Мониторинг сервера, рейд-калькулятор, магазины, камеры и трекинг игроков — прямо в Telegram.',
    en: 'Server monitoring, raid calculator, shops, cameras and player tracking — right inside Telegram.',
  },
  start_redeem: { ru: 'Есть ключ? Активируй:', en: 'Have a key? Redeem it:' },
  start_help: { ru: 'Все команды:', en: 'All commands:' },
  start_disclaimer: {
    ru: 'Неофициальный инструмент на базе Rust+ Companion API. Используя бота, ты действуешь на свой риск.',
    en: 'Unofficial tool built on the Rust+ Companion API. By using the bot you do so at your own risk.',
  },
  change_lang_hint: { ru: 'Сменить язык: /lang', en: 'Change language: /lang' },

  help_title: { ru: 'Команды', en: 'Commands' },
  help_intro: {
    ru: 'Тапни раздел, чтобы развернуть. Примеры — серым.',
    en: 'Tap a section to expand. Examples are greyed out.',
  },
  help_ingame: { ru: 'В игре (тим-чат)', en: 'In-game (team chat)' },
  help_admin: { ru: 'Админ', en: 'Admin' },

  // raid
  raid_softside: { ru: 'есть мягкая сторона', en: 'has a soft side' },
  raid_cheapest: { ru: 'Выгоднее всего', en: 'Most cost-effective' },
  raid_method: { ru: 'Способ', en: 'Method' },
  raid_count: { ru: 'Кол-во', en: 'Qty' },
  raid_raw: { ru: 'Сырьё', en: 'Raw' },
  raid_tipsrc: { ru: 'по версии rustexplore', en: 'per rustexplore' },
  raid_usage: {
    ru: 'Использование: /raid «объект» [кол-во] — напр. /raid стена · /raid мвк 4',
    en: 'Usage: /raid «structure» [qty] — e.g. /raid wall · /raid armored 4',
  },
  raid_unknown: { ru: 'Не знаю такой объект. /raid — список.', en: 'Unknown structure. /raid for the list.' },

  no_session: { ru: 'Нет активной сессии.', en: 'No active session.' },
};

// Inline bilingual helper for one-off command replies that don't warrant a DICT
// key. L('en', 'Привет', 'Hi') → 'Hi'. Keeps RU+EN side-by-side at the call site.
export const L = (lang, ru, en) => (normLang(lang) === 'en' ? en : ru);

export function t(lang, key, vars) {
  const entry = DICT[key];
  let s = (entry && (entry[lang] ?? entry.ru)) ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// Normalise any stored value to a supported lang (default ru).
export const normLang = (lang) => (lang === 'en' ? 'en' : 'ru');
