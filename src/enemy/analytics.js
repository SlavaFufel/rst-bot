// Activity analytics over a player's session history (from BattleMetrics).
// Each session is { start: ISO string, stop: ISO string | null }. stop=null
// means the player is currently online.

const HOURS = 24;
const DAYS = 7;
const OPEN_SESSION_CAP_MS = 2 * 3600 * 1000; // assume an open session ~2h for weighting
const BARS = '▁▂▃▄▅▆▇█';

// Average minutes played per day, over the span since the first observed session.
export function avgMinutesPerDay(sessions) {
  const starts = sessions.map((s) => Date.parse(s.start)).filter((n) => !Number.isNaN(n));
  if (!starts.length) return 0;
  const first = Math.min(...starts);
  let total = 0;
  for (const s of sessions) {
    if (!s.start) continue;
    const a = Date.parse(s.start);
    const b = s.stop ? Date.parse(s.stop) : a + OPEN_SESSION_CAP_MS;
    total += Math.max(0, (b - a) / 60000);
  }
  const days = Math.max(1, (Date.now() - first) / 86_400_000);
  return Math.round(total / days);
}

// Average finished-session length in minutes.
export function avgSessionMinutes(sessions) {
  const durs = [];
  for (const s of sessions) {
    if (!s.start || !s.stop) continue;
    const ms = Date.parse(s.stop) - Date.parse(s.start);
    if (ms > 0) durs.push(ms / 60000);
  }
  if (!durs.length) return 0;
  return Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
}

// 7x24 grid of online minutes per (weekday Mon=0, hour) in UTC+tzOffsetHours.
export function buildHeatmap(sessions, tzOffsetHours = 0) {
  const tz = tzOffsetHours * 3600000;
  const grid = Array.from({ length: DAYS }, () => new Array(HOURS).fill(0));
  for (const s of sessions) {
    if (!s.start) continue;
    const start = Date.parse(s.start);
    if (Number.isNaN(start)) continue;
    const stop = s.stop ? Date.parse(s.stop) : start + OPEN_SESSION_CAP_MS;
    let t = start;
    while (t < stop) {
      const local = new Date(t + tz);
      const wd = (local.getUTCDay() + 6) % 7; // Mon=0
      const hr = local.getUTCHours();
      const msIntoHour = local.getUTCMinutes() * 60000 + local.getUTCSeconds() * 1000 + local.getUTCMilliseconds();
      const chunkEnd = Math.min(stop, t + (3600000 - msIntoHour));
      grid[wd][hr] += (chunkEnd - t) / 60000;
      t = chunkEnd;
    }
  }
  return grid;
}

export function onlineByHour(heatmap) {
  const byHour = new Array(HOURS).fill(0);
  for (let wd = 0; wd < DAYS; wd += 1) {
    for (let h = 0; h < HOURS; h += 1) byHour[h] += heatmap[wd][h];
  }
  return byHour;
}

// Least-active 3-hour window (cyclic) = best time to raid an empty base.
export function bestRaidWindow(heatmap) {
  const byHour = onlineByHour(heatmap);
  let best = { startHour: 0, total: Infinity };
  let peak = { hour: 0, total: -1 };
  for (let i = 0; i < HOURS; i += 1) {
    const sum = byHour[i] + byHour[(i + 1) % HOURS] + byHour[(i + 2) % HOURS];
    if (sum < best.total) best = { startHour: i, total: sum };
    if (byHour[i] > peak.total) peak = { hour: i, total: byHour[i] };
  }
  return { startHour: best.startHour, endHour: (best.startHour + 3) % HOURS, peakHour: peak.hour };
}

export function sparkline(values) {
  const max = Math.max(...values, 1);
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))]).join('');
}

const pad2 = (n) => String(n).padStart(2, '0');

// Human-readable enemy activity profile for Telegram.
export function renderProfile(name, sessions, tzOffsetHours = 0) {
  if (!sessions.length) return `🎯 ${name}\nНет данных о сессиях (или сервер не отслеживается BattleMetrics).`;
  const heatmap = buildHeatmap(sessions, tzOffsetHours);
  const byHour = onlineByHour(heatmap);
  const avg = avgSessionMinutes(sessions);
  const perDay = avgMinutesPerDay(sessions);
  const raid = bestRaidWindow(heatmap);
  const online = sessions.some((s) => !s.stop);
  const tzLabel = `UTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}`;

  const stops = sessions.map((s) => Date.parse(s.stop)).filter((n) => !Number.isNaN(n));
  const lastSeenMs = stops.length ? Math.max(...stops) : null;
  let ago = null;
  if (!online && lastSeenMs) {
    const m = (Date.now() - lastSeenMs) / 60000;
    ago = m < 60 ? `${Math.round(m)} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
  }

  return [
    `🎯 ${name}${online ? ' — 🟢 сейчас онлайн' : ago ? ` — был ${ago}` : ''}`,
    `Сессий: ${sessions.length} · средняя ~${avg} мин · в день ~${(perDay / 60).toFixed(1)} ч`,
    '',
    `Активность по часам (${tzLabel}):`,
    '0    6    12   18  23',
    sparkline(byHour),
    '',
    `🔴 Чаще всего онлайн: ~${pad2(raid.peakHour)}:00`,
    `🟢 Лучшее окно для рейда: ${pad2(raid.startHour)}:00–${pad2(raid.endHour)}:00 (реже всего онлайн)`,
  ].join('\n');
}
