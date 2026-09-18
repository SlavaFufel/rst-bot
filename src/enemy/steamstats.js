import { config } from '../config.js';
import { L } from '../telegram/i18n.js';

// Rust player stats via the official Steam Web API (like ruststats.io): exact
// lookup by SteamID64, no nickname ambiguity. Requires config.steam.apiKey.
// Stats are only visible when the target's profile (game details) is public.

const STEAM = 'https://api.steampowered.com';
const RUST_APPID = '252490';

function key() {
  if (!config.steam.apiKey) throw new Error('STEAM_API_KEY не задан — статистика по SteamID недоступна.');
  return config.steam.apiKey;
}

// Resolve a SteamID64 from a raw id, a profile URL, or a vanity name/URL.
export async function resolveSteamId(input) {
  const s = String(input ?? '').trim();
  let m = s.match(/^(7656119\d{10})$/);
  if (m) return m[1];
  m = s.match(/steamcommunity\.com\/profiles\/(7656119\d{10})/);
  if (m) return m[1];
  m = s.match(/steamcommunity\.com\/id\/([^/\s?#]+)/);
  const vanity = m ? m[1] : (/^[a-zA-Z0-9_.-]{2,32}$/.test(s) ? s : null);
  if (vanity) {
    const j = await fetch(
      `${STEAM}/ISteamUser/ResolveVanityURL/v1/?key=${key()}&vanityurl=${encodeURIComponent(vanity)}`,
    ).then((r) => r.json());
    if (j?.response?.success === 1) return j.response.steamid;
  }
  return null;
}

// GetPlayerSummaries for up to 100 ids at once. Returns { steamId: summary }.
export async function getSummaries(steamIds) {
  const ids = (Array.isArray(steamIds) ? steamIds : [steamIds]).filter(Boolean).slice(0, 100);
  if (!ids.length) return {};
  const j = await fetch(
    `${STEAM}/ISteamUser/GetPlayerSummaries/v2/?key=${key()}&steamids=${ids.join(',')}`,
  ).then((r) => r.json());
  const out = {};
  for (const p of j?.response?.players ?? []) {
    out[p.steamid] = {
      steamId: p.steamid,
      name: p.personaname,
      avatar: p.avatarfull ?? null,
      online: (p.personastate ?? 0) !== 0,
      inRust: String(p.gameid ?? '') === RUST_APPID,
      server: p.gameserverip ?? null,
      public: (p.communityvisibilitystate ?? 1) === 3,
      created: p.timecreated ?? null, // account creation (public profiles only)
    };
  }
  return out;
}

export async function getSummary(steamId) {
  return (await getSummaries([steamId]))[steamId] ?? null;
}

// Parse a Rust GetUserStatsForGame response into a profile, or { private: true }.
export function parseRustStats(statsArray) {
  if (!Array.isArray(statsArray) || !statsArray.length) return { private: true };
  const m = Object.fromEntries(statsArray.map((s) => [s.name, s.value]));
  const kills = m.kill_player ?? 0;
  const deaths = m.deaths ?? 0;
  const fired = m.bullet_fired ?? 0;
  const hitPlayer = m.bullet_hit_player ?? 0;
  return {
    private: false,
    kills,
    deaths,
    kdr: deaths ? Number((kills / deaths).toFixed(2)) : kills,
    headshots: m.headshots ?? m.headshot ?? 0,
    bulletFired: fired,
    bulletHitPlayer: hitPlayer,
    accuracy: fired ? Number(((hitPlayer / fired) * 100).toFixed(1)) : 0,
    arrowsFired: m.arrow_fired ?? 0,
    rocketsFired: m.rocket_fired ?? 0,
    animalKills:
      (m.kill_bear ?? 0) + (m.kill_boar ?? 0) + (m.kill_wolf ?? 0) +
      (m.kill_stag ?? 0) + (m.kill_chicken ?? 0) + (m.kill_horse ?? 0),
    harvest: {
      wood: m['harvest.wood'] ?? 0,
      stone: m['harvest.stones'] ?? 0,
      metal: m['harvest.metal_ore'] ?? 0,
      sulfur: m['harvest.sulfur_ore'] ?? 0,
    },
  };
}

export async function getRustStats(steamId) {
  const j = await fetch(
    `${STEAM}/ISteamUserStats/GetUserStatsForGame/v2/?appid=${RUST_APPID}&key=${key()}&steamid=${steamId}`,
  ).then((r) => r.json());
  return parseRustStats(j?.playerstats?.stats);
}

// VAC / game / trade bans for a SteamID.
export async function getBans(steamId) {
  const j = await fetch(`${STEAM}/ISteamUser/GetPlayerBans/v1/?key=${key()}&steamids=${steamId}`).then((r) => r.json());
  const p = j?.players?.[0];
  if (!p) return null;
  return {
    vac: p.VACBanned === true,
    vacCount: p.NumberOfVACBans ?? 0,
    gameBans: p.NumberOfGameBans ?? 0,
    daysSinceLastBan: p.DaysSinceLastBan ?? 0,
    community: p.CommunityBanned === true,
    economy: p.EconomyBan && p.EconomyBan !== 'none' ? p.EconomyBan : null,
  };
}

// "Trust" assessment — bans + account age + visibility + hours → verdict.
export function renderTrust(summary, bans, stats, playtimeMin, lang = 'ru') {
  const lines = [L(lang, '🛡️ ПРОВЕРКА', '🛡️ TRUST CHECK')];
  const flags = [];

  if (bans?.vac) {
    lines.push(L(lang,
      `🔴 VAC-бан: ДА (${bans.vacCount} шт, ${bans.daysSinceLastBan} дн назад)`,
      `🔴 VAC ban: YES (${bans.vacCount}, ${bans.daysSinceLastBan}d ago)`));
    flags.push('ban');
  } else {
    lines.push(L(lang, 'VAC: ✅ нет', 'VAC: ✅ none'));
  }
  if (bans?.gameBans) {
    lines.push(L(lang, `🔴 Гейм-баны: ${bans.gameBans}`, `🔴 Game bans: ${bans.gameBans}`));
    flags.push('ban');
  }
  if (bans?.economy) lines.push(L(lang, `⚠️ Trade-бан: ${bans.economy}`, `⚠️ Trade ban: ${bans.economy}`));

  if (summary?.created) {
    const years = (Date.now() - summary.created * 1000) / (365 * 86_400_000);
    const age = years >= 1
      ? `${years.toFixed(1)}${L(lang, ' г', 'y')}`
      : `${Math.max(1, Math.round(years * 12))}${L(lang, ' мес', 'mo')}`;
    lines.push(L(lang,
      `Аккаунт: с ${new Date(summary.created * 1000).getFullYear()} (${age})`,
      `Account: since ${new Date(summary.created * 1000).getFullYear()} (${age})`));
    if (years < 0.25) flags.push('new');
  } else {
    lines.push(L(lang, 'Возраст аккаунта: 🔒 скрыт', 'Account age: 🔒 hidden'));
    flags.push('hidden');
  }

  if (playtimeMin) lines.push(L(lang, `Часов в Rust: ${Math.round(playtimeMin / 60)}`, `Hours in Rust: ${Math.round(playtimeMin / 60)}`));
  else if (stats?.private) {
    lines.push(L(lang, 'Часы/статы: 🔒 скрыты', 'Hours/stats: 🔒 hidden'));
    flags.push('hidden');
  }

  let verdict;
  if (flags.includes('ban')) verdict = L(lang, '🔴 Есть бан в истории', '🔴 Has a ban on record');
  else if (flags.includes('new')) verdict = L(lang, '🟡 Молодой аккаунт — возможно смурф/чит', '🟡 Young account — possible smurf/cheat');
  else if (flags.filter((f) => f === 'hidden').length >= 2) verdict = L(lang, '🟡 Всё скрыто — насторожись', '🟡 Everything hidden — be wary');
  else verdict = L(lang, '✅ Подозрительного не видно', '✅ Nothing suspicious');
  lines.push(`→ ${verdict}`);
  return lines.join('\n');
}

// Lifetime Rust playtime in minutes (needs the target's game list public).
export async function getPlaytimeMinutes(steamId) {
  try {
    const j = await fetch(
      `${STEAM}/IPlayerService/GetOwnedGames/v1/?key=${key()}&steamid=${steamId}&include_played_free_games=1&format=json`,
    ).then((r) => r.json());
    const g = (j?.response?.games ?? []).find((x) => String(x.appid) === RUST_APPID);
    return g ? g.playtime_forever : null;
  } catch {
    return null;
  }
}

const nf = (n) => Number(n).toLocaleString('ru-RU');

// Telegram-ready profile (ruststats-style).
export function renderSteamProfile(summary, stats, playtimeMin, lang = 'ru') {
  if (!summary) return L(lang, 'Игрок не найден в Steam.', 'Player not found on Steam.');
  const lines = [`🎯 ${summary.name}`];
  if (summary.inRust) lines.push(L(lang, `🟢 СЕЙЧАС В RUST${summary.server ? ` — ${summary.server}` : ''}`, `🟢 IN RUST NOW${summary.server ? ` — ${summary.server}` : ''}`));
  else lines.push(summary.online ? L(lang, '🟡 онлайн в Steam', '🟡 online on Steam') : L(lang, '⚪ оффлайн', '⚪ offline'));

  if (stats.private) {
    lines.push('', L(lang, '🔒 Не могу посчитать статистику — профиль Steam закрыт.', '🔒 Cannot read stats — the Steam profile is private.'));
    lines.push(L(lang, '(открой Steam → Профиль → Приватность → «Детали об игре: Открытый»)', '(Steam → Profile → Privacy → "Game details: Public")'));
    if (playtimeMin) lines.push(L(lang, `⏱ Наиграно в Rust: ${Math.round(playtimeMin / 60)} ч`, `⏱ Rust playtime: ${Math.round(playtimeMin / 60)}h`));
    return lines.join('\n');
  }

  lines.push(
    '',
    L(lang, '📊 ОБЩАЯ СТАТИСТИКА', '📊 OVERALL STATS'),
    L(lang,
      `⚔️ K/D: ${stats.kdr} (${nf(stats.kills)} убийств / ${nf(stats.deaths)} смертей)`,
      `⚔️ K/D: ${stats.kdr} (${nf(stats.kills)} kills / ${nf(stats.deaths)} deaths)`),
    L(lang,
      `🎯 Хедшоты: ${nf(stats.headshots)} · точность ${stats.accuracy}%`,
      `🎯 Headshots: ${nf(stats.headshots)} · accuracy ${stats.accuracy}%`),
    L(lang,
      `🔫 Выстрелов: ${nf(stats.bulletFired)} (по игрокам ${nf(stats.bulletHitPlayer)})`,
      `🔫 Shots: ${nf(stats.bulletFired)} (on players ${nf(stats.bulletHitPlayer)})`),
    L(lang,
      `🏹 Стрел: ${nf(stats.arrowsFired)} · 🚀 ракет: ${nf(stats.rocketsFired)}`,
      `🏹 Arrows: ${nf(stats.arrowsFired)} · 🚀 rockets: ${nf(stats.rocketsFired)}`),
    L(lang, `🐻 Животных убито: ${nf(stats.animalKills)}`, `🐻 Animals killed: ${nf(stats.animalKills)}`),
    L(lang,
      `🪓 Добыто: 🪵 ${nf(stats.harvest.wood)} · 🪨 ${nf(stats.harvest.stone)} · ⚙️ ${nf(stats.harvest.metal)} · 🧨 ${nf(stats.harvest.sulfur)}`,
      `🪓 Harvested: 🪵 ${nf(stats.harvest.wood)} · 🪨 ${nf(stats.harvest.stone)} · ⚙️ ${nf(stats.harvest.metal)} · 🧨 ${nf(stats.harvest.sulfur)}`),
  );
  if (playtimeMin) lines.push(L(lang, `⏱ Время в Rust: ${Math.round(playtimeMin / 60)} ч`, `⏱ Rust playtime: ${Math.round(playtimeMin / 60)}h`));
  return lines.join('\n');
}
