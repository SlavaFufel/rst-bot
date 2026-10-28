import { config } from '../config.js';
import { log } from '../logger.js';
import { bus, EVENTS } from '../core/eventbus.js';
import { logEvent } from '../store/db.js';
import { gridFromXY } from '../util/grid.js';
import { loadTeamStats, saveTeamStats, clearOtherWipes } from '../store/teamStats.js';

// Map markers (cargo, heli, CH47, crates, vending machines, travelling vendor)
// are no longer polled: Facepunch stopped sending them over Rust+ on 2026-08-06,
// so every event built on them is gone. Team, time, server info, devices and
// cameras are unaffected.

const SERVER_DOWN_THRESHOLD = 3;
const AFK_THRESHOLD_MS = 5 * 60_000; // online + unmoved this long → AFK
const TIME_LEAD_MINUTES = 10; // fire "night/dawn soon" ~10 real-world minutes ahead
const STATS_DT_CAP_MS = 30_000; // cap per-poll time delta (protect against reconnect gaps)
const STATS_DIST_CAP_M = 2_000; // ignore per-poll position jumps above this (teleport/respawn)
const STATS_FLUSH_MS = 60_000; // persist accumulated team stats at most this often
const MAX_DEATHS = 5; // recent team death spots kept for !deaths / /deaths

// In-game hour float (0..24) → "HH:MM".
function hhmm(h) {
  const total = Math.round(((h % 24) + 24) % 24 * 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// In-game hours forward from `now` to the next occurrence of hour-of-day `target`.
function hoursForward(now, target) {
  return (((target - now) % 24) + 24) % 24;
}

export class Poller {
  constructor(client, busArg = null, sessionId = null) {
    this.client = client;
    this.bus = busArg ?? bus;
    this.sessionId = sessionId;
    this.monuments = []; // static, from getMap() — still available
    this.mapSize = 0;
    this.lastSeed = null;
    this.lastWipe = null;
    this.team = new Map(); // String(steamId) -> { isOnline, isAlive, x, y, afkSince, afkNotified }
    this.stats = new Map(); // String(steamId) -> { name, playtimeMs, afkMs, deaths, distanceM }
    this.statsWipe = 0; // current wipe id the stats belong to
    this.lastTeamPollAt = null; // timestamp of previous pollTeam (for time deltas)
    this.lastStatsFlush = 0;
    this.deaths = []; // newest-first ring of last MAX_DEATHS deaths { name, grid, at, x, y }
    this.failCount = 0;
    this.serverDown = false;
    this.lastIsDay = null; // day/night transition tracking
    this.nightSoonFired = false; // edge-trigger for "night soon" (reset each night)
    this.dawnSoonFired = false; // edge-trigger for "dawn soon" (reset each day)
    this.intervals = [];
  }

  async init() {
    try {
      const info = await this.client.getInfo();
      this.mapSize = info.mapSize;
      this.lastSeed = info.seed;
      this.lastWipe = info.wipeTime;
      this.statsWipe = Number(info.wipeTime) || 0;
      this.stats = loadTeamStats(this.sessionId, this.statsWipe); // resume mid-wipe after a restart
      log.info(`Server info loaded: size=${this.mapSize}, seed=${this.lastSeed}`);
    } catch (err) {
      log.warn('Poller.init failed (will retry on next poll):', err.message);
      return;
    }

    try {
      const map = await this.client.getMap();
      this.monuments = (map.monuments ?? []).map((m) => ({ token: m.token, x: m.x, y: m.y }));
      log.info(`Monuments loaded: ${this.monuments.length}`);
    } catch (err) {
      log.warn('getMap failed — monuments unavailable until reconnect:', err.message);
    }
  }

  start() {
    const { teamMs, infoMs, timeMs } = config.poll;
    this.every(teamMs, () => this.pollTeam());
    this.every(infoMs, () => this.pollInfo());
    this.every(timeMs, () => this.pollTime());
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    // Persist whatever we accumulated since the last throttled flush.
    if (this.sessionId != null) {
      try { saveTeamStats(this.sessionId, this.statsWipe, this.stats); } catch { /* ignore */ }
    }
  }

  every(ms, fn) {
    const id = setInterval(() => {
      fn()
        .then(() => this.bus.emit('rust:poll_ok'))
        .catch((err) => {
          log.warn('poll error:', err.message);
          // Invalid/expired token symptom (e.g. after a wipe) → signal repair.
          if (/not_found|invalid|unauthorized|token/i.test(err.message)) {
            this.bus.emit('rust:auth_error', { message: err.message });
          }
        });
    }, ms);
    this.intervals.push(id);
  }

  fire(type, payload) {
    logEvent(type, payload, this.sessionId);
    this.bus.emit(type, payload);
  }

  async pollTeam() {
    const team = await this.client.getTeamInfo();
    const now = Date.now();
    // steamId is a protobuf Long object — String() it for a stable Map key, or
    // every poll's fresh Long instance misses lookup and no transitions fire.
    const dt = this.lastTeamPollAt ? Math.min(now - this.lastTeamPollAt, STATS_DT_CAP_MS) : 0;
    for (const member of team.members ?? []) {
      const sid = String(member.steamId);
      const prev = this.team.get(sid);
      const grid = () => gridFromXY(member.x, member.y, this.mapSize) ?? '??';
      if (prev) {
        if (!prev.isOnline && member.isOnline) this.fire(EVENTS.TEAM_JOIN, { name: member.name });
        if (prev.isOnline && !member.isOnline) this.fire(EVENTS.TEAM_LEAVE, { name: member.name });
        if (prev.isAlive && !member.isAlive) {
          const g = grid();
          this.fire(EVENTS.TEAM_DEATH, { name: member.name, grid: g });
          this.recordDeath(member.name, g, now, member.x, member.y);
        }
        if (!prev.isAlive && member.isAlive) this.fire(EVENTS.TEAM_RESPAWN, { name: member.name, grid: grid() });
      }

      // AFK: online + alive + position unchanged for AFK_THRESHOLD_MS (notify once).
      const unmoved = prev && prev.x === member.x && prev.y === member.y;
      let afkSince = prev?.afkSince ?? null;
      let afkNotified = prev?.afkNotified ?? false;
      if (member.isOnline && member.isAlive) {
        if (!unmoved) {
          afkSince = now;
          afkNotified = false;
        } else if (afkSince && !afkNotified && now - afkSince >= AFK_THRESHOLD_MS) {
          this.fire(EVENTS.TEAM_AFK, { name: member.name, minutes: Math.round((now - afkSince) / 60000) });
          afkNotified = true;
        }
      } else {
        afkSince = null;
        afkNotified = false;
      }

      this.accumulate(sid, member, prev, dt, unmoved);

      this.team.set(sid, {
        isOnline: member.isOnline,
        isAlive: member.isAlive,
        x: member.x,
        y: member.y,
        afkSince,
        afkNotified,
      });
    }
    this.lastTeamPollAt = now;
    // Level signal for automations (team offline/online rules).
    const members = team.members ?? [];
    this.bus.emit('team:state', { online: members.filter((m) => m.isOnline).length, total: members.length });
    if (this.sessionId != null && now - this.lastStatsFlush >= STATS_FLUSH_MS) {
      this.lastStatsFlush = now;
      saveTeamStats(this.sessionId, this.statsWipe, this.stats);
    }
  }

  // Accumulate this wipe's playtime / AFK / deaths / distance for one member.
  accumulate(sid, member, prev, dt, unmoved) {
    const st = this.stats.get(sid) ?? { name: member.name, playtimeMs: 0, afkMs: 0, deaths: 0, distanceM: 0 };
    if (member.name) st.name = member.name;
    if (prev) {
      if (dt > 0 && member.isOnline) st.playtimeMs += dt;
      if (dt > 0 && member.isOnline && member.isAlive && unmoved) st.afkMs += dt;
      // Distance only between two alive snapshots (skips respawn teleports), capped.
      if (member.isOnline && prev.isAlive && member.isAlive && !unmoved) {
        const d = Math.hypot(member.x - prev.x, member.y - prev.y);
        if (d > 0 && d <= STATS_DIST_CAP_M) st.distanceM += d;
      }
      if (prev.isAlive && !member.isAlive) st.deaths += 1;
    }
    this.stats.set(sid, st);
  }

  // Snapshot of accumulated per-member stats (commands read this — always live).
  teamStatsList() {
    return [...this.stats.entries()].map(([steamId, s]) => ({ steamId, ...s }));
  }

  // Push a death spot onto the newest-first ring (capped at MAX_DEATHS).
  recordDeath(name, grid, at, x = null, y = null) {
    this.deaths.unshift({ name: name || '?', grid, at, x, y });
    if (this.deaths.length > MAX_DEATHS) this.deaths.length = MAX_DEATHS;
  }

  // Last few team death spots, newest first (for !deaths / /deaths).
  recentDeaths() {
    return [...this.deaths];
  }

  async pollInfo() {
    try {
      const info = await this.client.getInfo();
      if (this.serverDown) {
        this.serverDown = false;
        this.failCount = 0;
        this.fire(EVENTS.SERVER_UP, {});
      }
      if (this.lastSeed !== null && (info.seed !== this.lastSeed || info.wipeTime !== this.lastWipe)) {
        this.fire(EVENTS.WIPE_DETECTED, { seed: info.seed, wipeTime: info.wipeTime });
        // New wipe → team stats start fresh; drop the old wipe's rows.
        this.stats = new Map();
        this.statsWipe = Number(info.wipeTime) || 0;
        this.lastTeamPollAt = null;
        this.deaths = [];
        clearOtherWipes(this.sessionId, this.statsWipe);
      }
      this.lastSeed = info.seed;
      this.lastWipe = info.wipeTime;
      this.bus.emit('server:info', {
        players: info.players,
        maxPlayers: info.maxPlayers,
        queued: info.queuedPlayers,
        name: info.name,
      });
    } catch (err) {
      this.failCount += 1;
      if (this.failCount >= SERVER_DOWN_THRESHOLD && !this.serverDown) {
        this.serverDown = true;
        this.fire(EVENTS.SERVER_DOWN, {});
      }
      throw err;
    }
  }

  async pollTime() {
    const time = await this.client.getTime();
    this.bus.emit('server:time', time);
    if (!time || !Number.isFinite(time.time) || !Number.isFinite(time.sunrise) || !Number.isFinite(time.sunset)) return;

    const isDay = time.time >= time.sunrise && time.time < time.sunset;
    if (this.lastIsDay !== null && isDay !== this.lastIsDay) {
      this.fire(isDay ? EVENTS.TIME_DAY : EVENTS.TIME_NIGHT, { time: hhmm(time.time) });
    }
    this.lastIsDay = isDay;

    // Pre-warnings ~10 real-world minutes ahead, edge-triggered once per cycle.
    // We convert in-game hours-until to real minutes via the server's
    // dayLengthMinutes (a full in-game day in real minutes); if the server
    // doesn't report it, fall back to ~1 in-game hour of lead. Poll-based (not a
    // one-shot timer) since servers can tick day/night at uneven real rates;
    // reset the flag once the opposite phase begins.
    const perHourMin =
      Number.isFinite(time.dayLengthMinutes) && time.dayLengthMinutes > 0 ? time.dayLengthMinutes / 24 : null;
    // Real minutes left until in-game hour `target` (null if rate unknown).
    const realMinTo = (target) => (perHourMin ? hoursForward(time.time, target) * perHourMin : null);
    const soonNow = (target) => {
      const r = realMinTo(target);
      return r != null ? r <= TIME_LEAD_MINUTES : hoursForward(time.time, target) <= 1;
    };
    const minsPayload = (target) => {
      const r = realMinTo(target);
      return r != null ? Math.max(1, Math.round(r)) : null;
    };
    if (isDay) {
      this.dawnSoonFired = false;
      if (!this.nightSoonFired && soonNow(time.sunset)) {
        this.fire(EVENTS.TIME_NIGHT_SOON, { at: hhmm(time.sunset), mins: minsPayload(time.sunset) });
        this.nightSoonFired = true;
      }
    } else {
      this.nightSoonFired = false;
      if (!this.dawnSoonFired && soonNow(time.sunrise)) {
        this.fire(EVENTS.TIME_DAY_SOON, { at: hhmm(time.sunrise), mins: minsPayload(time.sunrise) });
        this.dawnSoonFired = true;
      }
    }
  }
}
