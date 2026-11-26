import { db } from '../store/db.js';
import { log } from '../logger.js';
import * as sessions from '../store/sessions.js';
import { queryInfo, queryPlayers, findQueryPort } from './a2s.js';

// Our own BattleMetrics: every minute, read the A2S player list of each server a
// subscriber is paired to and keep a log of who was online when
// (server_presence). Works on any server that publishes its player list
// (official Facepunch servers do), with no API key. History starts when the bot
// first sees the server.

const PORT_RETRY_MS = 30 * 60_000; // re-probe a server whose query port wasn't found
const DOWN_AFTER_FAILS = 5; // consecutive failed polls before open stays are closed
const KEEP_DAYS = 30;
const INFO_EVERY = 10; // refresh the server name every N polls
const MERGE_GAP_MS = 3 * 60_000; // a stay that ended this recently is continued, not restarted

const insertStmt = db.prepare('INSERT INTO server_presence (server, name, started_at, last_seen) VALUES (?, ?, ?, ?)');
const lastStmt = db.prepare(
  'SELECT id, started_at, ended_at FROM server_presence WHERE server = ? AND name = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1',
);
const reopenStmt = db.prepare('UPDATE server_presence SET ended_at = NULL, last_seen = ? WHERE id = ?');
const touchStmt =db.prepare('UPDATE server_presence SET last_seen = ? WHERE server = ? AND ended_at IS NULL');
const closeStmt = db.prepare('UPDATE server_presence SET ended_at = ? WHERE id = ?');
const closeServerStmt = db.prepare('UPDATE server_presence SET ended_at = last_seen WHERE server = ? AND ended_at IS NULL');
const closeAllStmt = db.prepare('UPDATE server_presence SET ended_at = last_seen WHERE ended_at IS NULL');
const pruneStmt = db.prepare('DELETE FROM server_presence WHERE ended_at IS NOT NULL AND ended_at < ?');
const historyStmt = db.prepare(
  'SELECT name, started_at, ended_at FROM server_presence WHERE server = ? AND name = ? COLLATE NOCASE AND started_at >= ? ORDER BY started_at',
);
const likeStmt = db.prepare(
  "SELECT name, MAX(COALESCE(ended_at, last_seen)) AS seen, COUNT(*) AS stays FROM server_presence WHERE server = ? AND name LIKE ? ESCAPE '\\' GROUP BY name COLLATE NOCASE ORDER BY seen DESC LIMIT ?",
);

export const serverKey = (ip, queryPort) => `${ip}:${queryPort}`;

export class ServerPresence {
  constructor() {
    // key -> { ip, port, name, maxPlayers, online: Map(lowerName -> { id, name, since }), lastOk, fails, hidden, polls }
    this.servers = new Map();
    this.portMisses = new Map(); // 'ip:appPort' -> last failed probe time
    this.lastPrune = 0;
  }

  // Stays left open by a previous run can't be trusted past their last sighting.
  init() {
    closeAllStmt.run();
  }

  // ip:queryPort of an owner's paired server, or null while unknown.
  keyForOwner(ownerId) {
    const row = sessions.getByOwner(ownerId);
    return row?.ip && row.query_port ? serverKey(row.ip, row.query_port) : null;
  }

  // Live view of one server: { name, players: [{ name, since }], lastOk, hidden } or null.
  snapshot(key) {
    const s = key && this.servers.get(key);
    if (!s) return null;
    const players = [...s.online.values()].map((p) => ({ name: p.name, since: p.since }));
    return { name: s.name, maxPlayers: s.maxPlayers, players, lastOk: s.lastOk, hidden: s.hidden };
  }

  isOnline(key, name) {
    const s = key && this.servers.get(key);
    return !!(s && name && s.online.has(name.toLowerCase()));
  }

  serverName(key) {
    return this.servers.get(key)?.name ?? null;
  }

  // Stays of one nickname on a server since sinceMs, as { start, stop } ISO pairs
  // (the shape enemy/analytics.js expects; stop null = online now).
  history(key, name, sinceMs = Date.now() - KEEP_DAYS * 86_400_000) {
    if (!key || !name) return [];
    return historyStmt.all(key, name, sinceMs).map((r) => ({
      name: r.name,
      start: new Date(r.started_at).toISOString(),
      stop: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    }));
  }

  // Nicknames seen on a server that contain `part`, most recent first.
  search(key, part, limit = 10) {
    if (!key || !part) return [];
    const like = `%${part.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return likeStmt.all(key, like, limit);
  }

  // Servers to watch: every paired session whose subscription is live.
  _targets() {
    const out = new Map(); // key -> ip
    for (const row of sessions.listSessions()) {
      if (!row.ip || !row.port || row.state === 'frozen:expired') continue;
      if (row.query_port) out.set(serverKey(row.ip, row.query_port), { ip: row.ip, port: row.query_port });
    }
    return out;
  }

  async _resolvePorts() {
    for (const row of sessions.listSessions()) {
      if (!row.ip || !row.port || row.query_port || row.state === 'frozen:expired') continue;
      const missKey = `${row.ip}:${row.port}`;
      if (Date.now() - (this.portMisses.get(missKey) ?? 0) < PORT_RETRY_MS) continue;
      const found = await findQueryPort(row.ip, row.port);
      if (found) {
        sessions.setQueryPort(row.owner_user_id, found.port);
        this.portMisses.delete(missKey);
        log.info(`A2S: ${found.info.name} → query port ${found.port}`);
      } else {
        this.portMisses.set(missKey, Date.now());
        log.warn(`A2S: no query port answered for ${missKey}`);
      }
    }
  }

  async pollAll() {
    await this._resolvePorts();
    const targets = this._targets();
    // Forget servers nobody is paired to any more.
    for (const key of this.servers.keys()) {
      if (!targets.has(key)) {
        closeServerStmt.run(key);
        this.servers.delete(key);
      }
    }
    await Promise.all([...targets].map(([key, t]) => this._poll(key, t.ip, t.port)));
    if (Date.now() - this.lastPrune > 3_600_000) {
      pruneStmt.run(Date.now() - KEEP_DAYS * 86_400_000);
      this.lastPrune = Date.now();
    }
  }

  async _poll(key, ip, port) {
    let s = this.servers.get(key);
    if (!s) {
      s = { ip, port, name: null, maxPlayers: null, online: new Map(), lastOk: 0, fails: 0, hidden: false, polls: 0 };
      this.servers.set(key, s);
    }
    try {
      if (!s.name || s.polls % INFO_EVERY === 0) {
        const info = await queryInfo(ip, port);
        s.name = info.name;
        s.maxPlayers = info.maxPlayers;
      }
      const players = await queryPlayers(ip, port);
      s.polls += 1;
      s.hidden = false;
      this._apply(key, s, players);
    } catch (err) {
      s.hidden = !!err.hidden;
      s.fails += 1;
      if (s.fails === DOWN_AFTER_FAILS) {
        // Server down or unreachable: end the open stays at their last sighting.
        closeServerStmt.run(key);
        s.online.clear();
        log.warn(`A2S ${key}: ${err.message} (${s.fails} polls in a row)`);
      }
    }
  }

  _apply(key, s, players) {
    const now = Date.now();
    s.fails = 0;
    s.lastOk = now;
    const current = new Map();
    for (const p of players) {
      const k = p.name.toLowerCase();
      const prev = current.get(k);
      if (!prev || p.durationSec > prev.durationSec) current.set(k, p);
    }
    for (const [k, p] of current) {
      if (s.online.has(k)) continue;
      let since = now - p.durationSec * 1000;
      // Continue the previous stay if it ended moments ago (bot restart, a missed
      // poll, a quick reconnect) instead of counting the overlap twice.
      const last = lastStmt.get(key, p.name);
      let id;
      if (last?.ended_at && last.ended_at >= since - MERGE_GAP_MS) {
        reopenStmt.run(now, last.id);
        id = last.id;
        since = last.started_at;
      } else {
        id = Number(insertStmt.run(key, p.name, since, now).lastInsertRowid);
      }
      s.online.set(k, { id, name: p.name, since });
    }
    for (const [k, stay] of s.online) {
      if (current.has(k)) continue;
      closeStmt.run(now, stay.id);
      s.online.delete(k);
    }
    touchStmt.run(now, key);
  }
}
