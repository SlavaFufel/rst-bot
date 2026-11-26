import { db } from '../store/db.js';

// Finds a player's likely teammates from the server player-list log
// (server_presence): teams join and leave together and play the same hours.
//
// Signals, per other player, over the last `days`:
// - joins/leaves within SYNC_MS of the target's own join/leave;
// - overlap: share of the target's online time the other was online too,
//   and Jaccard (overlap / union) so that 24/7 players don't match everyone.
// Server restarts, wipes and bot outages make many players join or leave at
// once; such burst moments are ignored for the sync signal.

const SYNC_MS = 3 * 60_000;
const BUCKET_MS = 2 * 60_000;
const MIN_BURST = 6;

const staysStmt = db.prepare(
  'SELECT name, started_at AS start, COALESCE(ended_at, last_seen) AS end, ended_at IS NULL AS open FROM server_presence WHERE server = ? AND COALESCE(ended_at, last_seen) >= ? ORDER BY started_at',
);

// Moments when unusually many players joined (or left) at once.
function burstChecker(times) {
  const buckets = new Map();
  for (const t of times) {
    const b = Math.floor(t / BUCKET_MS);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  if (!times.length) return () => false;
  const span = Math.max(1, (Math.max(...times) - Math.min(...times)) / BUCKET_MS);
  // The check spans 3 buckets; call it a burst at 3x the usual count for 3 buckets.
  const threshold = Math.max(MIN_BURST, Math.ceil((9 * times.length) / span));
  return (t) => {
    const b = Math.floor(t / BUCKET_MS);
    return (buckets.get(b - 1) ?? 0) + (buckets.get(b) ?? 0) + (buckets.get(b + 1) ?? 0) >= threshold;
  };
}

const minutes = (ms) => Math.round(ms / 60000);

// Total time covered by a set of stays, counting overlaps once.
function coveredMs(stays) {
  const sorted = [...stays].sort((a, b) => a.start - b.start);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const s of sorted) {
    if (curE === null || s.start > curE) {
      if (curE !== null) total += curE - curS;
      curS = s.start;
      curE = s.end;
    } else curE = Math.max(curE, s.end);
  }
  if (curE !== null) total += curE - curS;
  return total;
}

// Time both sets of stays were online at once.
function overlapMs(a, b) {
  const parts = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start, y.start);
      const e = Math.min(x.end, y.end);
      if (e > s) parts.push({ start: s, end: e });
    }
  }
  return coveredMs(parts);
}

// { target: { name, stays, minutes }, mates: [...], enough } or null if the
// name was never seen. mates: [{ name, joins, leaves, overlapMin, share, jaccard, score, level }]
// sorted best first; level 'high' | 'medium'.
export function findTeammates(serverKey, name, { days = 14, now = Date.now() } = {}) {
  const rows = staysStmt.all(serverKey, now - days * 86_400_000);
  const lower = name.toLowerCase();
  const mine = rows.filter((r) => r.name.toLowerCase() === lower);
  if (!mine.length) return null;

  const isJoinBurst = burstChecker(rows.map((r) => r.start));
  const isLeaveBurst = burstChecker(rows.filter((r) => !r.open).map((r) => r.end));

  const myMs = coveredMs(mine);
  const myJoins = mine.filter((r) => !isJoinBurst(r.start));
  const myLeaves = mine.filter((r) => !r.open && !isLeaveBurst(r.end));
  const possible = myJoins.length + myLeaves.length;

  const others = new Map(); // lower name -> { name, stays: [] }
  for (const r of rows) {
    const k = r.name.toLowerCase();
    if (k === lower) continue;
    if (!others.has(k)) others.set(k, { name: r.name, stays: [] });
    others.get(k).stays.push(r);
  }

  const mates = [];
  for (const o of others.values()) {
    const overlap = overlapMs(mine, o.stays);
    if (!overlap) continue;
    const joins = myJoins.filter((a) => o.stays.some((b) => Math.abs(b.start - a.start) <= SYNC_MS && !isJoinBurst(b.start))).length;
    const leaves = myLeaves.filter((a) => o.stays.some((b) => !b.open && Math.abs(b.end - a.end) <= SYNC_MS && !isLeaveBurst(b.end))).length;
    const otherMs = coveredMs(o.stays);
    const share = overlap / myMs;
    const jaccard = overlap / (myMs + otherMs - overlap);
    const sync = possible ? (joins + leaves) / possible : 0;
    const score = 0.6 * sync + 0.4 * jaccard;
    let level = null;
    if (joins + leaves >= 3 && sync >= 0.5 && jaccard >= 0.4) level = 'high';
    else if (joins + leaves >= 2 && sync >= 0.3 && jaccard >= 0.25) level = 'medium';
    if (level) mates.push({ name: o.name, joins, leaves, overlapMin: minutes(overlap), share, jaccard, score, level });
  }
  mates.sort((a, b) => b.score - a.score);

  return {
    target: { name: mine[mine.length - 1].name, stays: mine.length, minutes: minutes(myMs) },
    mates: mates.slice(0, 8),
    // A team pattern needs a few separate sessions to be told apart from chance.
    enough: possible >= 4,
  };
}
