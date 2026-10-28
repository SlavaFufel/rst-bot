import { listDevices } from '../devices/store.js';
import { resolveItemId } from '../util/items.js';

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
