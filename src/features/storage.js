import { listDevices, storageMonitors } from '../devices/store.js';
import { resolveItemId } from '../util/items.js';
import { recycleInfo } from '../util/rustlabs.js';

const MAX_MONITORS = 25; // each one is a Rust+ request — keep a search bounded

// Search every paired Storage Monitor of the session owner for an item.
// → { itemId, hits: [{ name, entityId, qty }], total, checked, failed } or null
// if the query doesn't resolve to an item.
export async function findInStorage(session, query) {
  const q = String(query ?? '').trim();
  if (!q) return null; // resolveItemId('') would substring-match the first item
  const resolved = resolveItemId(q);
  if (resolved == null) return null;
  const itemId = Number(resolved);
  const monitors = listDevices(session.ownerUserId).filter((d) => d.type === 3).slice(0, MAX_MONITORS);
  const hits = [];
  let failed = 0;
  for (const m of monitors) {
    let info;
    try {
      info = await session.getEntityInfo(m.entity_id);
    } catch {
      failed += 1;
      continue;
    }
    const qty = (info?.payload?.items ?? [])
      .filter((it) => Number(it.itemId) === itemId)
      .reduce((sum, it) => sum + (it.quantity ?? 0), 0);
    if (qty > 0) hits.push({ name: m.name || `Storage ${m.entity_id}`, entityId: m.entity_id, qty });
  }
  hits.sort((a, b) => b.qty - a.qty);
  return { itemId, hits, total: hits.reduce((s, h) => s + h.qty, 0), checked: monitors.length, failed };
}

// Owner's Storage Monitors matching a target: an entity id, a name (every monitor
// paired under it), or "all"/"все".
export function resolveMonitors(ownerId, target) {
  const monitors = storageMonitors(ownerId);
  const t = String(target ?? '').trim().toLowerCase();
  if (t === 'all' || t === 'все') return monitors;
  return monitors.filter((m) => String(m.entity_id) === t || (m.name ?? '').trim().toLowerCase() === t);
}

// What recycling the contents of these monitors would give. Blueprints and items
// without a recycle recipe are left out. Chance-based outputs are summed as their
// expected amount and flagged `approx`.
// → { inputs: [{ itemId, qty }], yields: [{ itemId, qty, approx }], skipped, checked, failed }
export async function recycleStorage(session, monitors, safe = false) {
  const contents = new Map(); // itemId -> qty
  let failed = 0;
  for (const m of monitors.slice(0, MAX_MONITORS)) {
    let info;
    try {
      info = await session.getEntityInfo(m.entity_id);
    } catch {
      failed += 1;
      continue;
    }
    for (const it of info?.payload?.items ?? []) {
      if (it.itemIsBlueprint) continue;
      contents.set(Number(it.itemId), (contents.get(Number(it.itemId)) ?? 0) + (it.quantity ?? 0));
    }
  }

  const inputs = [];
  const yields = new Map(); // itemId -> { qty, approx }
  let skipped = 0;
  for (const [itemId, qty] of contents) {
    const r = qty > 0 ? recycleInfo(String(itemId), qty, safe) : null;
    if (!r) {
      skipped += 1;
      continue;
    }
    inputs.push({ itemId, qty });
    for (const y of r.yields) {
      const cur = yields.get(Number(y.id)) ?? { qty: 0, approx: false };
      cur.qty += y.qty * y.prob;
      cur.approx ||= y.prob < 1;
      yields.set(Number(y.id), cur);
    }
  }
  return {
    inputs: inputs.sort((a, b) => b.qty - a.qty),
    yields: [...yields]
      .map(([itemId, y]) => ({ itemId, qty: Math.floor(y.qty), approx: y.approx }))
      .filter((y) => y.qty > 0)
      .sort((a, b) => b.qty - a.qty),
    skipped,
    checked: Math.min(monitors.length, MAX_MONITORS),
    failed,
  };
}
