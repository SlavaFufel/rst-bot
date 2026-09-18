import { db } from '../store/db.js';

// Vending price history: periodic snapshots of the cheapest SCRAP price per item
// across an owner's server shops. Powers /pricehistory.

const SCRAP = -932201673; // Scrap item id (the common shop currency)
const PRUNE_DAYS = 14;

const insertStmt = db.prepare('INSERT INTO price_history (owner_user_id, item_id, price, ts) VALUES (?, ?, ?, ?)');
const histStmt = db.prepare(
  'SELECT price, ts FROM price_history WHERE owner_user_id = ? AND item_id = ? AND ts >= ? ORDER BY ts'
);
const pruneStmt = db.prepare('DELETE FROM price_history WHERE ts < ?');

// Snapshot the cheapest scrap-priced offer per item across the given shops.
export function recordPrices(ownerId, shops) {
  const min = new Map();
  for (const s of shops ?? []) {
    for (const o of s.sellOrders ?? []) {
      if (Number(o.currencyId) !== SCRAP || o.amountInStock <= 0) continue;
      const cur = min.get(o.itemId);
      if (cur == null || o.costPerItem < cur) min.set(o.itemId, o.costPerItem);
    }
  }
  const now = Date.now();
  for (const [itemId, price] of min) insertStmt.run(ownerId, Number(itemId), price, now);
  return min.size;
}

export function priceHistory(ownerId, itemId, days = PRUNE_DAYS) {
  return histStmt.all(ownerId, Number(itemId), Date.now() - days * 86_400_000);
}

export function prunePrices() {
  pruneStmt.run(Date.now() - PRUNE_DAYS * 86_400_000);
}
