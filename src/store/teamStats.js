import { db } from './db.js';

// Persistence for the poller's per-teammate wipe stats. The poller keeps the
// live numbers in memory (commands read from there); these helpers only let it
// survive a restart and keep the DB tidy across wipes. Keyed by
// (session_id, steam_id, wipe). sessionId == null → in-memory-only, skip the DB.

const upsertStmt = db.prepare(`
  INSERT OR REPLACE INTO team_stats
    (session_id, steam_id, wipe, name, playtime_ms, afk_ms, deaths, distance_m, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const loadStmt = db.prepare(
  'SELECT steam_id, name, playtime_ms, afk_ms, deaths, distance_m FROM team_stats WHERE session_id = ? AND wipe = ?',
);
const clearOtherStmt = db.prepare('DELETE FROM team_stats WHERE session_id = ? AND wipe != ?');

// Load one wipe's accumulated stats into a Map keyed by steamId string.
export function loadTeamStats(sessionId, wipe) {
  const map = new Map();
  if (sessionId == null) return map;
  for (const r of loadStmt.all(sessionId, Number(wipe) || 0)) {
    map.set(r.steam_id, {
      name: r.name,
      playtimeMs: r.playtime_ms,
      afkMs: r.afk_ms,
      deaths: r.deaths,
      distanceM: r.distance_m,
    });
  }
  return map;
}

// Persist the in-memory Map for one wipe (called on a throttle + on stop).
export function saveTeamStats(sessionId, wipe, statsMap) {
  if (sessionId == null || !statsMap?.size) return;
  const w = Number(wipe) || 0;
  const now = Date.now();
  for (const [sid, s] of statsMap) {
    upsertStmt.run(
      sessionId, sid, w, s.name ?? null,
      Math.round(s.playtimeMs), Math.round(s.afkMs), s.deaths, Math.round(s.distanceM), now,
    );
  }
}

// Drop rows from previous wipes for this session.
export function clearOtherWipes(sessionId, wipe) {
  if (sessionId == null) return;
  clearOtherStmt.run(sessionId, Number(wipe) || 0);
}
