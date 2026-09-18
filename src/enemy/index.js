import { log } from '../logger.js';
import { config } from '../config.js';
import { bus, EVENTS } from '../core/eventbus.js';
import { getSummaries } from './steamstats.js';
import { trackedWithSteam, openSession, closeSession } from './store.js';

// Tracks enemies' "in Rust right now" status via Steam presence (one batched
// GetPlayerSummaries call for all enemies), emitting per-owner ENEMY_ONLINE /
// ENEMY_OFFLINE with the current server. Works on ALL servers (incl. official),
// near-realtime. Needs STEAM_API_KEY and the target's profile to be public.
const POLL_MS = 60_000;
const BATCH = 100; // GetPlayerSummaries cap per call

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class EnemyTracker {
  constructor() {
    this.timer = null;
    this.state = new Map(); // enemyId -> inRust bool
  }

  start() {
    if (!config.steam.apiKey) {
      log.info('EnemyTracker: STEAM_API_KEY не задан — онлайн-трекинг врагов выключен (/enemy stats работает по запросу).');
      return;
    }
    this.timer = setInterval(() => this.poll().catch((e) => log.warn('enemy poll:', e.message)), POLL_MS);
    log.info('EnemyTracker started (Steam presence)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    const enemies = trackedWithSteam();
    if (!enemies.length) return;
    const summaries = {};
    for (const ids of chunk(enemies.map((e) => e.steam_id), BATCH)) {
      Object.assign(summaries, await getSummaries(ids));
    }
    for (const enemy of enemies) {
      const online = !!summaries[enemy.steam_id]?.inRust;
      const prev = this.state.get(enemy.id);
      if (prev !== undefined && online !== prev) {
        bus.emit(online ? EVENTS.ENEMY_ONLINE : EVENTS.ENEMY_OFFLINE, {
          label: enemy.label,
          ownerId: enemy.owner_user_id,
          server: summaries[enemy.steam_id]?.server ?? null,
        });
      }
      // Record presence sessions for the activity heatmap (idempotent).
      if (online) openSession(enemy.id, enemy.owner_user_id);
      else closeSession(enemy.id);
      this.state.set(enemy.id, online);
    }
  }
}
