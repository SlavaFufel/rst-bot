import { config } from '../config.js';
import { log } from '../logger.js';
import { bus, EVENTS } from '../core/eventbus.js';
import { logEvent } from '../store/db.js';
import { alreadyHandled, markHandled, cleanupDedup } from '../core/dedup.js';
import { gridFromXY, nearestGrid } from '../util/grid.js';
import { MARKER, indexById, diffMarkers, nearestMonument, distance } from './markers.js';
import { loadTeamStats, saveTeamStats, clearOtherWipes } from '../store/teamStats.js';

const SERVER_DOWN_THRESHOLD = 3;
const MARKER_TTL_SECONDS = 6 * 3600;
const AFK_THRESHOLD_MS = 5 * 60_000; // online + unmoved this long → AFK
const TIME_LEAD_MINUTES = 10; // fire "night/dawn soon" ~10 real-world minutes ahead
const STATS_DT_CAP_MS = 30_000; // cap per-poll time delta (protect against reconnect gaps)
const STATS_DIST_CAP_M = 2_000; // ignore per-poll position jumps above this (teleport/respawn)
const STATS_FLUSH_MS = 60_000; // persist accumulated team stats at most this often
const MAX_DEATHS = 5; // recent team death spots kept for !deaths / /deaths
const CARGO_CRATE_RADIUS = 120; // a crate within this of the cargo marker rides the ship
// Oil rigs aren't detectable via Crate markers (Rust+ doesn't emit them there).
// The reliable signal is the CH47 chinook that flies in to drop heavy scientists:
// a CH47 within this many world-units of an oil monument = that rig's event.
// (rustplusplus constants.js OIL_RIG_CHINOOK_47_MAX_SPAWN_DISTANCE = 550.)
// A CH47 that SPAWNS within this of an oil monument is that rig's heavy-scientist
// delivery (rustplusplus OIL_RIG_CHINOOK_47_MAX_SPAWN_DISTANCE). The crate-drop
// chinook spawns at the map edge instead, so checking the spawn (appear) position
// cleanly separates the two — no per-poll tracking or dwell heuristic needed.
const OIL_RIG_CHINOOK_RADIUS = 550;
const OIL_RIG_REFIRE_MS = 10 * 60_000; // ignore a repeat trigger for the same rig within this window (marker flicker)
const OIL_CRATE_UNLOCK_MS = 15 * 60_000; // self-run estimate: crate unlocks ~15 min after the rig is triggered (the API no longer exposes the real timer — Facepunch removed it 2023-05-04)

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
    this.markers = new Map();
    this.monuments = [];
    this.mapSize = 0;
    this.lastSeed = null;
    this.lastWipe = null;
    this.team = new Map(); // String(steamId) -> { isOnline, isAlive, x, y, afkSince, afkNotified }
    this.stats = new Map(); // String(steamId) -> { name, playtimeMs, afkMs, deaths, distanceM }
    this.statsWipe = 0; // current wipe id the stats belong to
    this.lastTeamPollAt = null; // timestamp of previous pollTeam (for time deltas)
    this.lastStatsFlush = 0;
    this.deaths = []; // newest-first ring of last MAX_DEATHS deaths { name, grid, at, x, y }
    this.cargoCrates = new Set(); // marker ids of crates currently riding the cargo ship
    this.cargoCrateSeq = 0; // #N counter within the current cargo cycle (reset when it leaves)
    this.oilFiredAt = {}; // { small|large: lastFiredMs } — per-rig refire cooldown
    this.oilTimers = []; // pending "crate unlocked" timers (cleared on stop)
    this.failCount = 0;
    this.serverDown = false;
    this.lastIsDay = null; // day/night transition tracking
    this.nightSoonFired = false; // edge-trigger for "night soon" (reset each night)
    this.dawnSoonFired = false; // edge-trigger for "dawn soon" (reset each day)
    this.firstMarkerPoll = true; // seed standing markers silently on (re)connect
    this.intervals = [];
  }

  async init() {
    this.firstMarkerPoll = true; // re-warm after every reconnect
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
      log.warn('getMap failed — oil rig detection disabled until reconnect:', err.message);
    }
  }

  start() {
    const { markersMs, teamMs, infoMs, timeMs } = config.poll;
    this.every(markersMs, () => this.pollMarkers());
    this.every(teamMs, () => this.pollTeam());
    this.every(infoMs, () => this.pollInfo());
    this.every(timeMs, () => this.pollTime());
    this.every(300_000, async () => cleanupDedup());
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.oilTimers.forEach(clearTimeout);
    this.oilTimers = [];
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

  grid(marker) {
    return gridFromXY(marker.x, marker.y, this.mapSize) ?? '??';
  }

  // Grid cell of a marker, or the NEAREST edge cell (~-prefixed) for markers that
  // spawn outside the lettered grid in open water (cargo ship, patrol heli,
  // chinook). '??' only when the map size isn't loaded yet.
  gridNear(marker) {
    const exact = gridFromXY(marker.x, marker.y, this.mapSize);
    if (exact) return exact;
    const near = nearestGrid(marker.x, marker.y, this.mapSize);
    return near ? `~${near}` : '??';
  }

  // Human-readable location of a marker: its grid cell, or — when it sits
  // outside the lettered grid (safe-zone shops) — the monument's name. Avoids
  // the bare "??" that confused users on shop notifications.
  whereOf(marker) {
    let where = this.grid(marker);
    if (where === '??' && this.mapSize) {
      const mon = nearestMonument(marker, this.monuments, 300);
      const token = mon?.token ?? '';
      if (/compound|outpost/i.test(token)) where = '🏛️ Аутпост';
      else if (/bandit/i.test(token)) where = '🏛️ Бандитка';
      else where = '🏛️ Мирная зона';
    }
    return where;
  }

  // Current vending machines on the map (for /market and /price).
  shops() {
    const out = [];
    for (const marker of this.markers.values()) {
      if (marker.type !== MARKER.VENDING) continue;
      out.push({ grid: this.whereOf(marker), id: marker.id, sellOrders: marker.sellOrders ?? [] });
    }
    return out;
  }

  fresh(key) {
    // Scope dedup by session so two sessions seeing the same marker id don't collide.
    const k = this.sessionId != null ? `s${this.sessionId}:${key}` : key;
    if (alreadyHandled(k)) return false;
    markHandled(k, MARKER_TTL_SECONDS);
    return true;
  }

  async pollMarkers() {
    const current = indexById(await this.client.getMapMarkers());
    if (this.firstMarkerPoll) {
      // First poll after (re)connect: these markers already existed before we
      // were watching, so seed them silently instead of announcing every
      // standing shop/cargo as "new" (that burst is what users saw on connect).
      this.markers = current;
      this.firstMarkerPoll = false;
      return;
    }
    const { appeared, disappeared } = diffMarkers(this.markers, current);
    // Cargo positions from the CURRENT poll — used to tell cargo loot crates apart
    // from monument/airdrop crates, order-independently of the diff arrays.
    const cargoNow = [...current.values()].filter((m) => m.type === MARKER.CARGO);
    for (const marker of appeared) this.onAppear(marker, cargoNow);
    for (const marker of disappeared) this.onDisappear(marker, cargoNow);
    this.markers = current;
  }

  onAppear(marker, cargoNow = []) {
    switch (marker.type) {
      case MARKER.CARGO:
        if (this.fresh(`cargo:${marker.id}`)) this.fire(EVENTS.CARGO_SPAWNED, { grid: this.gridNear(marker), id: marker.id });
        break;
      case MARKER.HELI:
        if (this.fresh(`heli:${marker.id}`)) this.fire(EVENTS.HELI_SPAWNED, { grid: this.gridNear(marker), id: marker.id });
        break;
      case MARKER.CH47: {
        // A CH47 that spawns AT an oil rig (within range) is the heavy-scientist
        // delivery = the rig was just activated ("ресается"). The crate-drop
        // chinook spawns at the map edge, so its spawn position is never near a
        // rig — that's what separates them. No per-poll tracking needed.
        const rig = this.nearestOilRig(marker);
        log.info(`CH47 appeared @ ${this.grid(marker)} — ${rig ? `OIL RIG ${rig.token}` : 'open map (crate chinook)'}`);
        if (rig) {
          const which = /large/i.test(rig.token || '') ? 'large' : 'small';
          const now = Date.now();
          if (now - (this.oilFiredAt[which] || 0) > OIL_RIG_REFIRE_MS) {
            this.oilFiredAt[which] = now;
            this.fire(EVENTS.OILRIG_TRIGGERED, { rig: which });
            const timer = setTimeout(() => this.fire(EVENTS.OILRIG_CRATE_READY, { rig: which }), OIL_CRATE_UNLOCK_MS);
            if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
            this.oilTimers.push(timer);
          }
        } else if (this.fresh(`ch47:${marker.id}`)) {
          this.fire(EVENTS.CH47_SPAWNED, { grid: this.gridNear(marker), id: marker.id });
        }
        break;
      }
      case MARKER.VENDOR:
        if (this.fresh(`vendor:${marker.id}`)) this.fire(EVENTS.VENDOR_SPAWNED, { grid: this.gridNear(marker), id: marker.id });
        break;
      case MARKER.CRATE: {
        // Oil-rig crates are NOT emitted as Crate markers (confirmed via live
        // capture + rustplusplus removing this exact handling) — the rig is
        // detected via the CH47 chinook spawn instead (see the CH47 case). Here we
        // only handle crates riding the active cargo ship.
        if (cargoNow.some((c) => distance(marker, c) <= CARGO_CRATE_RADIUS) && !this.cargoCrates.has(marker.id)) {
          this.cargoCrates.add(marker.id);
          this.cargoCrateSeq += 1;
          this.fire(EVENTS.CARGO_CRATE_SPAWNED, { n: this.cargoCrateSeq, grid: this.gridNear(marker), id: marker.id });
        }
        break;
      }
      case MARKER.EXPLOSION: {
        const monument = nearestMonument(marker, this.monuments);
        if (this.fresh(`expl:${marker.id}`)) {
          this.fire(EVENTS.BRADLEY_DESTROYED, { where: monument?.token ?? this.gridNear(marker), id: marker.id });
        }
        break;
      }
      case MARKER.VENDING: {
        // Skip NPC safe-zone vending (Outpost/Bandit/peace zone): they're
        // permanent fixtures, not player shops — announcing them is noise.
        const where = this.whereOf(marker);
        if (!where.startsWith('🏛️') && this.fresh(`shop:${marker.id}`)) {
          this.fire(EVENTS.SHOP_NEW, { grid: where, id: marker.id, sellOrders: marker.sellOrders ?? [] });
        }
        // TODO (M5): scan sellOrders against watchlist and fire WATCH_HIT.
        break;
      }
      default:
        break;
    }
  }

  onDisappear(marker, cargoNow = []) {
    if (marker.type === MARKER.CARGO) {
      this.fire(EVENTS.CARGO_LEFT, { id: marker.id });
      this.cargoCrates.clear(); // ship gone → its crates vanish too; start fresh next cycle
      this.cargoCrateSeq = 0;
      return;
    }
    if (marker.type === MARKER.HELI) this.fire(EVENTS.HELI_DOWN, { grid: this.gridNear(marker), id: marker.id });
    if (marker.type === MARKER.VENDING) {
      // Mirror the SHOP_NEW rule: never announce NPC safe-zone vending
      // (Outpost/Bandit/peace zone) — they're permanent fixtures, and a transient
      // marker blip was spamming "shop gone (🏛️ peace zone)".
      const where = this.whereOf(marker);
      if (!where.startsWith('🏛️')) this.fire(EVENTS.SHOP_GONE, { grid: where, id: marker.id });
    }
    if (marker.type === MARKER.CRATE && this.cargoCrates.has(marker.id)) {
      this.cargoCrates.delete(marker.id);
      // Only a real loot if the ship is still here; if it left this poll, the crate
      // vanished with the ship (handled above) — don't fire a false "looted".
      if (cargoNow.length) {
        this.fire(EVENTS.CARGO_CRATE_LOOTED, { left: this.cargoCrates.size, grid: this.gridNear(marker), id: marker.id });
      }
    }
  }

  fire(type, payload) {
    logEvent(type, payload, this.sessionId);
    this.bus.emit(type, payload);
  }

  // Nearest oil-rig monument within OIL_RIG_CHINOOK_RADIUS of a marker, or null.
  nearestOilRig(marker) {
    let best = null;
    let bestD = OIL_RIG_CHINOOK_RADIUS;
    for (const mon of this.monuments) {
      if (!/oil/i.test(mon.token || '')) continue;
      const d = distance(marker, mon);
      if (d <= bestD) { best = mon; bestD = d; }
    }
    return best;
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

  // Diagnostic snapshot of live markers (type + grid; crates note nearest monument).
  // Used by /markers to debug oil-rig / cargo crate detection on a live server.
  markerDump() {
    const markers = [...this.markers.values()].map((m) => {
      const e = { type: m.type, grid: this.grid(m) };
      if (m.type === MARKER.CRATE) {
        const mon = nearestMonument(m, this.monuments, 800);
        e.near = mon ? `${mon.token} ${Math.round(distance(m, mon))}m` : '—';
      }
      return e;
    });
    return {
      markers,
      monuments: this.monuments.length,
      oil: this.monuments.filter((m) => /oil/i.test(m.token || '')).length,
    };
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
        this.markers = new Map();
        this.firstMarkerPoll = true; // re-seed silently → no "new shop" flood after a wipe
        // New wipe → team stats start fresh; drop the old wipe's rows.
        this.stats = new Map();
        this.statsWipe = Number(info.wipeTime) || 0;
        this.lastTeamPollAt = null;
        this.deaths = [];
        // Oil-rig state must reset too: marker ids restart low after a wipe, so a
        // stale "fired" id could swallow a real new event, and a pending unlock
        // timer would fire a phantom "crate unlocked" into the new wipe.
        this.oilTimers.forEach(clearTimeout);
        this.oilTimers = [];
        this.oilFiredAt = {};
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
