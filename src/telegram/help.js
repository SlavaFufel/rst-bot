import { t } from './i18n.js';

// Command catalogue. Each entry: [usage, ru-description, en-description].
// Descriptions may use _italic_ markers, rendered to <i> in the HTML cards.
const CATS = [
  { icon: '📡', ru: 'Сервер', en: 'Server', cmds: [
    ['/status', 'состояние сервера', 'server status'],
    ['/time', 'время (день/ночь)', 'server time (day/night)'],
    ['/subscribe', 'что присылать', 'notification toggles'],
    ['/sub', 'моя подписка', 'my subscription'],
    ['/mirror on|off', 'дублировать алерты в тим-чат', 'mirror alerts to team chat'],
    ['/say «текст»', 'написать в тим-чат', 'send to team chat'],
    ['/promote «ник»', 'назначить лидера тимы _(бот должен быть лидером)_', 'promote a teammate to leader _(bot must be leader)_'],
    ['/teamstats', 'статы тимы за вайп _(время/AFK/смерти/дистанция)_', 'team stats this wipe _(playtime/AFK/deaths/distance)_'],
  ] },
  { icon: '🗺️', ru: 'Карта и разведка', en: 'Map & recon', cmds: [
    ['/map', 'тактическая карта _(тима, магазины, карго, нефтянки, смерти, метки)_', 'tactical map _(team, shops, cargo, oil, deaths, pins)_'],
    ['/rustmap', 'детальная карта сервера (RustMaps)', 'detailed server map (RustMaps)'],
    ['/pin «грид» «текст»', 'поставить метку на карту _(видно в /map)_', 'drop a labelled map pin _(shown in /map)_'],
    ['/deaths', 'последние 5 мест смерти тимы (гриды)', 'last 5 team death spots (grids)'],
    ['/cam «имя» · /cams', 'камеры', 'cameras'],
  ] },
  { icon: '🛒', ru: 'Экономика', en: 'Economy', cmds: [
    ['/market', 'все магазины на карте', 'all shops on the map'],
    ['/price «предмет» [валюта]', 'где дешевле _(напр. /price ракета сера)_', 'cheapest shop _(e.g. /price rocket sulfur)_'],
    ['/deals', 'лучшие цены сервера', 'best deals on the server'],
    ['/pricehistory «предмет»', 'динамика цены', 'price trend'],
    ['/watch «предмет» [цена]', 'следить · /watchlist · /unwatch', 'watch · /watchlist · /unwatch'],
  ] },
  { icon: '🧨', ru: 'Рейд и RustLabs', en: 'Raid & RustLabs', cmds: [
    ['/raid «объект» [кол-во]', 'сырьё на слом _(напр. /raid стена · /raid мвк 4)_', 'raw cost to break _(e.g. /raid wall · /raid armored 4)_'],
    ['/durability «объект»', 'топ методов рейда (по сере)', 'top raid methods (by sulfur)'],
    ['/craft [кол-во] «предмет»', 'рецепт + время крафта _(напр. /craft 10 ракета)_', 'recipe + craft time _(e.g. /craft 10 rocket)_'],
    ['/recycle [кол-во] «предмет»', 'что даст переработчик', 'recycler output'],
    ['/decay [hp] «объект»', 'время распада объекта', 'structure decay time'],
  ] },
  { icon: '🎯', ru: 'Игроки', en: 'Players', cmds: [
    ['/enemy add|stats|list|remove', 'досье по SteamID', 'dossier by SteamID'],
    ['/check «SteamID|ссылка»', 'VAC / смурф-чек', 'VAC / smurf check'],
    ['/track «steamId» «имя» · /online', 'друзья + живой статус (🎮 в Rust/🟢/⚪)', 'friends + live status (🎮 in Rust/🟢/⚪)'],
  ] },
  { icon: '🏠', ru: 'База (умный дом)', en: 'Base (smart home)', cmds: [
    ['/devices · /switch «id» on|off · /storage «id»', 'устройства', 'devices'],
    ['/allon · /alloff', 'все свитчи', 'all switches'],
    ['/scene save|«имя» · /scenes · /onraid «сцена»', 'сцены', 'scenes'],
  ] },
  { icon: '📝', ru: 'Журнал', en: 'Journal', cmds: [
    ['/note «текст» · /notes · /delnote «id»', 'заметки', 'notes'],
    ['/pin «грид» «текст» · /pins · /unpin «id»', 'нычки/пины', 'pins/stashes'],
    ['/stats', 'события сессии', 'session events'],
  ] },
  { icon: '🔑', ru: 'Подписка и привязка', en: 'Subscription & pairing', cmds: [
    ['/redeem «ключ» · /pair · /rebind · /repair', 'доступ и привязка _(только владелец)_', 'access & pairing _(owner only)_'],
    ['/family · /join «код» · /leave', 'семья: владелец + до 4 наблюдателей в TG', 'family: owner + up to 4 TG viewers'],
  ] },
];

const INGAME = {
  ru: '!pop · !time · !online · !team\n!teamstats · !playtime-all · !afktime-all · !deaths\n!promote [ник] · !cargo · !heli · !crates · !wipe\n!price «предмет» [валюта] · !deals\n!raid «объект» · !durability «объект»\n!craft «n» «предмет» · !recycle «n» «предмет»\n!decay «hp» «объект»\n!check «SteamID»',
  en: '!pop · !time · !online · !team\n!teamstats · !playtime-all · !afktime-all · !deaths\n!promote [name] · !cargo · !heli · !crates · !wipe\n!price «item» [currency] · !deals\n!raid «structure» · !durability «structure»\n!craft «n» «item» · !recycle «n» «item»\n!decay «hp» «structure»\n!check «SteamID»',
};

// English placeholder translations for the shared usage strings (the first
// tuple element is written RU-side with «предмет»/[валюта] etc.). For the EN
// card we swap each Cyrillic token for its English label so the usage line
// isn't half-Russian. Latin tokens (id, on|off, SteamID, steamId) pass through.
const PLACEHOLDER_EN = {
  'текст': 'text', 'предмет': 'item', 'валюта': 'currency', 'имя': 'name',
  'ссылка': 'link', 'объект': 'structure', 'кол-во': 'qty', 'сцена': 'scene',
  'ключ': 'key', 'грид': 'grid', 'клетка': 'cell', 'дней': 'days', 'план': 'plan',
  'цена': 'price',
};
const usageFor = (u, en) =>
  en ? u.replace(/[А-Яа-яЁё][А-Яа-яЁё-]*/g, (w) => PLACEHOLDER_EN[w.toLowerCase()] ?? w) : u;

const ADMIN = {
  ru: '/genkey [дней] [план] — создать ключ подписки\n/keys — список ключей\n/revoke «ключ» — отозвать ключ',
  en: '/genkey [days] [plan] — create a subscription key\n/keys — list keys\n/revoke «key» — revoke a key',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Escape, then turn _italic_ markers into <i> tags (descriptions only).
const desc = (s) => esc(s).replace(/_([^_]+)_/g, '<i>$1</i>');

// One category as an HTML "card": icon + bold title + a blockquote of commands.
const card = (icon, title, lines) => `${icon} <b>${esc(title)}</b>\n<blockquote>${lines.join('\n')}</blockquote>`;

// Full /help as an HTML document (blockquote cards). Bilingual via `lang`.
export function buildHelp(lang, isAdmin) {
  const en = lang === 'en';
  const parts = [
    `🤖 <b>${esc(t(lang, 'start_title'))}</b> · ${esc(t(lang, 'help_title'))}`,
    ...CATS.map((c) =>
      card(c.icon, en ? c.en : c.ru, c.cmds.map(([u, ru, eng]) => `${esc(usageFor(u, en))} — ${desc(en ? eng : ru)}`)),
    ),
    `💬 <b>${esc(t(lang, 'help_ingame'))}</b>\n<blockquote expandable>${esc(en ? INGAME.en : INGAME.ru)}</blockquote>`,
  ];
  if (isAdmin) {
    parts.push(`🔧 <b>${esc(t(lang, 'help_admin'))}</b>\n<blockquote expandable>${esc(en ? ADMIN.en : ADMIN.ru)}</blockquote>`);
  }
  parts.push(`<i>${esc(t(lang, 'change_lang_hint'))}</i>`);
  return parts.join('\n\n');
}
