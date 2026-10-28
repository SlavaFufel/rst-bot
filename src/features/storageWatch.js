import { log } from '../logger.js';
import { EVENTS } from '../core/eventbus.js';
import { getDevice, watchedStorage } from '../devices/store.js';

const SETTLE_MS = 30_000; // let a looting/stashing burst settle, then send one net summary

// "itemId" or "bp:itemId" → quantity. Blueprints are counted apart from the items.
function countItems(items) {
  const out = new Map();
  for (const it of items ?? []) {
    const key = it.itemIsBlueprint ? `bp:${it.itemId}` : String(it.itemId);
    out.set(key, (out.get(key) ?? 0) + (it.quantity ?? 0));
  }
  return out;
}

// Net change between two snapshots → [{ itemId, bp, delta }], biggest first.
function diffItems(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const out = [];
  for (const key of keys) {
    const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (!delta) continue;
    const bp = key.startsWith('bp:');
    out.push({ itemId: Number(bp ? key.slice(3) : key), bp, delta });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// Watches one owner's Storage Monitors (those with /boxwatch on) and reports what
// was put in or taken out. Rust+ only broadcasts a container's changes to a
// connection that has requested that entity, so sync() reads every watched
// monitor after each (re)connect — that also gives the baseline to diff against.
export class StorageWatch {
  constructor(session) {
    this.session = session;
    this.snapshots = new Map(); // entityId -> Map(key -> qty), last reported state
    this.latest = new Map(); // entityId -> Map(key -> qty), newest unreported state
    this.pending = new Map(); // entityId -> settle timer

    const bus = session.bus;
    bus.on('rust:connected', () => this.reset());
    bus.on('entity:changed', (change) => this.onChanged(change));
  }

  reset() {
    this.pending.forEach(clearTimeout);
    this.pending.clear();
    this.snapshots.clear();
    this.latest.clear();
  }

  async sync() {
    for (const m of watchedStorage(this.session.ownerUserId)) await this.watch(m.entity_id);
  }

  // Subscribe to a monitor's broadcasts and take its current contents as baseline.
  async watch(entityId) {
    try {
      const info = await this.session.getEntityInfo(entityId);
      this.snapshots.set(entityId, countItems(info?.payload?.items));
    } catch (e) {
      log.warn(`storage watch ${entityId}:`, e.message);
    }
  }

  unwatch(entityId) {
    clearTimeout(this.pending.get(entityId));
    this.pending.delete(entityId);
    this.snapshots.delete(entityId);
    this.latest.delete(entityId);
  }

  onChanged({ entityId, items }) {
    if (!Array.isArray(items)) return; // not a container update
    const device = getDevice(this.session.ownerUserId, entityId);
    if (device?.type !== 3) return;
    if (!this.snapshots.has(entityId)) return; // not watched (or baseline not taken yet)
    this.latest.set(entityId, countItems(items));
    if (this.pending.has(entityId)) return;
    const timer = setTimeout(() => this.flush(entityId), SETTLE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.pending.set(entityId, timer);
  }

  flush(entityId) {
    this.pending.delete(entityId);
    const before = this.snapshots.get(entityId);
    const after = this.latest.get(entityId);
    if (!before || !after) return; // unwatched meanwhile
    this.snapshots.set(entityId, after);
    this.latest.delete(entityId);
    const changes = diffItems(before, after);
    if (!changes.length) return; // moved around and back — nothing to report
    const device = getDevice(this.session.ownerUserId, entityId);
    this.session.bus.emit(EVENTS.STORAGE_CHANGE, { name: device?.name || `Storage ${entityId}`, changes });
  }
}
