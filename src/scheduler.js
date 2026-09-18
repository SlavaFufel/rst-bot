import { log } from './logger.js';
import { bus, EVENTS } from './core/eventbus.js';
import { allStorageMonitors } from './devices/store.js';
import { recordPrices, prunePrices } from './features/economy.js';

// Time-driven checks. Currently: Storage Monitor upkeep — warns the owner once
// when a base's protection (upkeep) is about to run out and it will start to decay.
// (Day/night alerts live in the per-session poller; wipe countdown needs a server
// schedule the API does not expose, so it's intentionally omitted.)
const TICK_MS = 30 * 60_000; // every 30 min
const DECAY_WARN_MS = 24 * 3600_000; // warn when < 24h of upkeep remains

export class Scheduler {
  constructor(sessionManager) {
    this.sessions = sessionManager;
    this.timer = null;
    this.warned = new Set(); // "ownerId:entityId" already warned this low-period
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => log.warn('scheduler tick:', e.message)), TICK_MS);
    log.info('Scheduler started (upkeep monitor)');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    for (const sm of allStorageMonitors()) {
      const session = this.sessions.byOwner?.get(sm.owner_user_id);
      if (!session || !session.isConnected()) continue;

      let info;
      try {
        info = await session.getEntityInfo(sm.entity_id);
      } catch {
        continue;
      }
      const expiry = info?.payload?.protectionExpiry; // epoch seconds (0/undefined = none)
      const key = `${sm.owner_user_id}:${sm.entity_id}`;
      const remainingMs = expiry ? expiry * 1000 - Date.now() : 0;

      if (expiry && remainingMs > 0 && remainingMs < DECAY_WARN_MS) {
        if (!this.warned.has(key)) {
          this.warned.add(key);
          bus.emit(EVENTS.DECAY_WARNING, {
            ownerId: sm.owner_user_id,
            name: sm.name || `Storage ${sm.entity_id}`,
            hours: Math.max(0, Math.round(remainingMs / 3600_000)),
          });
        }
      } else {
        this.warned.delete(key); // upkeep refilled — re-arm
      }
    }

    // Snapshot vending prices for each connected session (for /pricehistory).
    for (const [ownerId, session] of this.sessions.byOwner ?? []) {
      if (!session.isConnected()) continue;
      try {
        recordPrices(ownerId, session.shops());
      } catch {
        // ignore — best effort
      }
    }
    prunePrices();
  }
}
