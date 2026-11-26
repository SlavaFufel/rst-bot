import { log } from '../logger.js';
import { config } from '../config.js';
import { bus, EVENTS } from '../core/eventbus.js';
import { getSummaries } from './steamstats.js';
import { trackedEnemies, openSession, closeSession } from './store.js';
import { ServerPresence } from './presence.js';

// Tracks enemies' online status from two sources, polled together every minute:
// - the owner's server player list (A2S, enemy/presence.js): matches the enemy's
//   in-game nickname — /enemy nick, or the Steam name of a SteamID enemy;
// - Steam presence (GetPlayerSummaries): "in Rust" on any server, needs
//   STEAM_API_KEY and a public profile.
// Emits per-owner ENEMY_ONLINE / ENEMY_OFFLINE, and ENEMY_GROUP_OFFLINE when every
// member of an enemy group has left.
const POLL_MS = 60_000;
const BATCH = 100; // GetPlayerSummaries cap per call

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class EnemyTracker {
  // ownerOf(userId) -> owner of the session that user follows (a family viewer
  // tracks enemies on the owner's server).
  constructor({ ownerOf = (id) => id } = {}) {
    this.ownerOf = ownerOf;
    this.timer = null;
    this.running = false;
    this.presence = new ServerPresence();
    this.state = new Map(); // enemyId -> online bool
    this.names = new Map(); // enemyId -> last known Steam name
  }

  start() {
    this.presence.init();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    setTimeout(() => this.tick(), 5_000);
    log.info(`EnemyTracker started (server player lists${config.steam.apiKey ? ' + Steam presence' : ''})`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return; // a slow poll must not overlap the next one
    this.running = true;
    try {
      await this.presence.pollAll().catch((e) => log.warn('presence poll:', e.message));
      await this.poll().catch((e) => log.warn('enemy poll:', e.message));
    } finally {
      this.running = false;
    }
  }

  // Nickname to look for in the server list.
  matchName(enemy) {
    return enemy.nick || this.names.get(enemy.id) || enemy.label;
  }

  async poll() {
    const enemies = trackedEnemies();
    if (!enemies.length) return;

    let summaries = {};
    const withSteam = enemies.filter((e) => e.steam_id);
    if (config.steam.apiKey && withSteam.length) {
      try {
        for (const ids of chunk(withSteam.map((e) => e.steam_id), BATCH)) {
          Object.assign(summaries, await getSummaries(ids));
        }
      } catch (e) {
        log.warn('enemy steam poll:', e.message);
        summaries = null; // Steam down: don't flip anyone offline because of it
      }
    }

    const groups = new Map(); // `${owner}\n${grp}` -> { ownerId, grp, before, after, size }
    for (const enemy of enemies) {
      const steam = enemy.steam_id ? summaries?.[enemy.steam_id] : null;
      if (steam?.name) this.names.set(enemy.id, steam.name);
      const key = this.presence.keyForOwner(this.ownerOf(enemy.owner_user_id));
      const onServer = this.presence.isOnline(key, this.matchName(enemy));
      const prev = this.state.get(enemy.id);
      let online = onServer || !!steam?.inRust;
      if (!onServer && enemy.steam_id && summaries === null && prev !== undefined) online = prev;

      if (prev !== undefined && online !== prev) {
        bus.emit(online ? EVENTS.ENEMY_ONLINE : EVENTS.ENEMY_OFFLINE, {
          label: enemy.label,
          ownerId: enemy.owner_user_id,
          server: onServer ? this.presence.serverName(key) : (steam?.server ?? null),
        });
      }
      // Presence sessions for the activity heatmap (idempotent).
      if (online) openSession(enemy.id, enemy.owner_user_id);
      else closeSession(enemy.id);
      this.state.set(enemy.id, online);

      if (enemy.grp) {
        const gk = `${enemy.owner_user_id}\n${enemy.grp.toLowerCase()}`;
        const g = groups.get(gk) ?? { ownerId: enemy.owner_user_id, grp: enemy.grp, before: false, after: false, known: true, size: 0 };
        g.size += 1;
        if (prev === undefined) g.known = false;
        g.before ||= !!prev;
        g.after ||= online;
        groups.set(gk, g);
      }
    }

    for (const g of groups.values()) {
      if (g.known && g.size > 1 && g.before && !g.after) {
        bus.emit(EVENTS.ENEMY_GROUP_OFFLINE, { ownerId: g.ownerId, group: g.grp, count: g.size });
      }
    }
  }
}
