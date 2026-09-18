import { db } from '../store/db.js';

// Per-user vending-machine watchlist: ping when an item is sold at/below a price.
// Items are referenced by numeric Rust itemId (shown in /market output) — no
// name map needed; /market is the closed loop for discovering ids.

const addStmt = db.prepare('INSERT INTO watchlist (user_id, item_id, max_price, enabled) VALUES (?, ?, ?, 1)');
const listStmt = db.prepare('SELECT id, item_id, max_price FROM watchlist WHERE user_id = ? AND enabled = 1 ORDER BY id');
const delStmt = db.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?');

export function addWatch(userId, itemId, maxPrice = null) {
  return Number(addStmt.run(userId, Number(itemId), maxPrice).lastInsertRowid);
}
export function listWatch(userId) {
  return listStmt.all(userId);
}
export function removeWatch(id, userId) {
  return delStmt.run(id, userId).changes > 0;
}

// Match a user's watchlist against a vending machine's sell orders.
// Returns [{ itemId, price, currencyId, stock }].
export function matchOrders(userId, sellOrders) {
  const hits = [];
  const wl = listStmt.all(userId);
  if (!wl.length) return hits;
  for (const w of wl) {
    for (const o of sellOrders ?? []) {
      const price = o.costPerItem ?? o.cost_per_item;
      if (Number(o.itemId) === Number(w.item_id) && (w.max_price == null || price <= w.max_price)) {
        hits.push({ itemId: Number(o.itemId), price, currencyId: o.currencyId, stock: o.amountInStock });
      }
    }
  }
  return hits;
}
