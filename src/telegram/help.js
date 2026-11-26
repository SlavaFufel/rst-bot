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
    ['/map', 'тактическая карта _(тима, нефтянки, смерти, метки)_', 'tactical map _(team, oil rigs, deaths, pins)_'],
    ['/rustmap', 'детальная карта сервера (RustMaps)', 'detailed server map (RustMaps)'],
    ['/pin «грид» «текст»', 'поставить метку на карту _(видно в /map)_', 'drop a labelled map pin _(shown in /map)_'],
    ['/deaths', 'последние 5 мест смерти тимы (гриды)', 'last 5 team death spots (grids)'],
    ['/whereis «монумент»', 'где монумент _(напр. /whereis аэропорт)_', 'where a monument is _(e.g. /whereis airfield)_'],
    ['/cam «имя» · /cams', 'камеры', 'cameras'],
  ] },
  { icon: '🧨', ru: 'Рейд и RustLabs', en: 'Raid & RustLabs', cmds: [
    ['/raid «объект» [кол-во]', 'сырьё на слом _(напр. /raid стена · /raid мвк 4)_', 'raw cost to break _(e.g. /raid wall · /raid armored 4)_'],
    ['/durability «объект»', 'топ методов рейда (по сере)', 'top raid methods (by sulfur)'],
    ['/craft [кол-во] «предмет»', 'рецепт + время крафта _(напр. /craft 10 ракета)_', 'recipe + craft time _(e.g. /craft 10 rocket)_'],
    ['/recycle [кол-во] «предмет»', 'что даст переработчик', 'recycler output'],
    ['/decay [hp] «объект»', 'время распада объекта', 'structure decay time'],
  ] },
  { icon: '🎯', ru: 'Игроки', en: 'Players', cmds: [
    ['/players · /seen «ник»', 'кто сейчас на сервере · когда заходил ник _(30 дней)_', 'who is on the server now · when a name played _(30 days)_'],
    ['/enemy nick «ник» · /enemy add «SteamID»', 'следить за врагом: вход/выход, когда играет, окно для рейда', 'track an enemy: join/leave, when they play, raid window'],
    ['/enemy team «ник» [add]', 'найти тиммейтов врага по заходам на сервер _(add — следить за всей тимой)_', 'find an enemy\'s teammates from server joins _(add — track the whole team)_'],
    ['/enemy list|stats|group|remove', 'список, досье, тима врагов _(сообщу, когда выйдут все)_', 'list, dossier, enemy team _(alert when all are offline)_'],
    ['/check «SteamID|ссылка»', 'VAC / смурф-чек', 'VAC / smurf check'],
    ['/track «steamId» «имя» · /online', 'друзья + живой статус (🎮 в Rust/🟢/⚪)', 'friends + live status (🎮 in Rust/🟢/⚪)'],
  ] },
  { icon: '🏠', ru: 'База (умный дом)', en: 'Base (smart home)', cmds: [
    ['/devices · /switch «id» on|off · /storage «id»', 'устройства', 'devices'],
    ['/find «предмет»', 'в каких ящиках лежит _(по всем Storage Monitor)_', 'which containers hold it _(all Storage Monitors)_'],
    ['/recyclebox «ящик|all» [сейф]', 'что даст переработка содержимого ящика', 'what recycling a container\'s contents gives'],
    ['/boxwatch «ящик» [off]', 'сообщать, что положили/забрали из ящика', 'report what was put in / taken out of a container'],
    ['/allon · /alloff', 'все свитчи', 'all switches'],
    ['/scene save|«имя» · /scenes · /onraid «сцена»', 'сцены', 'scenes'],
    ['/auto', 'автоматизации _(свет ночью, SAM при оффлайне тимы, таймер полива)_', 'automations _(lights at night, SAM when team offline, watering timer)_'],
  ] },
  { icon: '📝', ru: 'Журнал', en: 'Journal', cmds: [
    ['/note «текст» · /notes · /delnote «id»', 'заметки', 'notes'],
    ['/pin «грид» «текст» · /pins · /unpin «id»', 'нычки/пины', 'pins/stashes'],
    ['/stats', 'события сессии', 'session events'],
  ] },
  { icon: '🔑', ru: 'Подписка и привязка', en: 'Subscription & pairing', cmds: [
    ['/trial', 'пробный период _(один раз)_', 'free trial _(once)_'],
    ['/buy', 'купить или продлить подписку за ⭐ Stars', 'buy or extend the subscription with ⭐ Stars'],
    ['/redeem «ключ» · /pair · /rebind · /repair', 'доступ и привязка _(только владелец)_', 'access & pairing _(owner only)_'],
    ['/family · /join «код» · /leave', 'семья: владелец + до 4 наблюдателей в TG', 'family: owner + up to 4 TG viewers'],
  ] },
];

const INGAME = {
  ru: '!pop · !time · !online · !team\n!locate [ник] · !nearby · !whereis «монумент» · !find «предмет»\n!teamstats · !playtime-all · !afktime-all · !deaths\n!promote [ник] · !wipe\n!raid «объект» · !durability «объект»\n!craft «n» «предмет» · !recycle «n» «предмет»\n!rbox «ящик» · !decay «hp» «объект»\n!check «SteamID»',
  en: '!pop · !time · !online · !team\n!locate [name] · !nearby · !whereis «monument» · !find «item»\n!teamstats · !playtime-all · !afktime-all · !deaths\n!promote [name] · !wipe\n!raid «structure» · !durability «structure»\n!craft «n» «item» · !recycle «n» «item»\n!rbox «container» · !decay «hp» «structure»\n!check «SteamID»',
};

// Shown at the bottom of /help so users don't hunt for removed commands.
const REMOVED = {
  ru: 'Рынок (/market, /price, /deals, /watch), карго, хели и другие события карты больше недоступны: 6 августа 2026 Facepunch убрали маркеры карты из Rust+.',
  en: 'Market (/market, /price, /deals, /watch), cargo, heli and other map events are no longer available: on August 6, 2026 Facepunch removed map markers from Rust+.',
};

// English placeholder translations for the shared usage strings (the first
// tuple element is written RU-side with «предмет»/[валюта] etc.). For the EN
// card we swap each Cyrillic token for its English label so the usage line
// isn't half-Russian. Latin tokens (id, on|off, SteamID, steamId) pass through.
const PLACEHOLDER_EN = {
  'текст': 'text', 'предмет': 'item', 'валюта': 'currency', 'имя': 'name',
  'ссылка': 'link', 'объект': 'structure', 'кол-во': 'qty', 'сцена': 'scene',
  'ключ': 'key', 'грид': 'grid', 'клетка': 'cell', 'дней': 'days', 'план': 'plan',
  'цена': 'price', 'монумент': 'monument', 'ник': 'name',
};
const usageFor = (u, en) =>
  en ? u.replace(/[А-Яа-яЁё][А-Яа-яЁё-]*/g, (w) => PLACEHOLDER_EN[w.toLowerCase()] ?? w) : u;

const ADMIN = {
  ru: '/genkey [дней] [план] — создать ключ подписки\n/keys — список ключей\n/revoke «ключ» — отозвать ключ\n/payments — последние оплаты Stars\n/refund «charge_id» — вернуть оплату',
  en: '/genkey [days] [plan] — create a subscription key\n/keys — list keys\n/revoke «key» — revoke a key\n/payments — recent Stars payments\n/refund «charge_id» — refund a payment',
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
  parts.push(`ℹ️ <i>${esc(en ? REMOVED.en : REMOVED.ru)}</i>`);
  if (isAdmin) {
    parts.push(`🔧 <b>${esc(t(lang, 'help_admin'))}</b>\n<blockquote expandable>${esc(en ? ADMIN.en : ADMIN.ru)}</blockquote>`);
  }
  parts.push(`<i>${esc(t(lang, 'change_lang_hint'))}</i>`);
  return parts.join('\n\n');
}
