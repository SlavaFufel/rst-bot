import { db } from '../store/db.js';
import { config } from '../config.js';

// Telegram Stars subscription sales. Invoice payload = "sub:<days>:<stars>", checked
// against the current STARS_PLANS at pre-checkout so a stale invoice (price
// changed since it was sent) can't be paid.

const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO payments (charge_id, telegram_id, stars, days, status, created_at) VALUES (?, ?, ?, ?, \'paid\', ?)',
);
const getStmt = db.prepare('SELECT * FROM payments WHERE charge_id = ?');
const refundStmt = db.prepare("UPDATE payments SET status = 'refunded' WHERE charge_id = ?");
const recentStmt = db.prepare('SELECT * FROM payments ORDER BY created_at DESC LIMIT ?');

export const plans = () => config.stars.plans;

export const invoicePayload = (plan) => `sub:${plan.days}:${plan.stars}`;

// Payload → plan if it matches a currently offered plan, else null.
export function planFromPayload(payload) {
  const m = /^sub:(\d+):(\d+)$/.exec(String(payload ?? ''));
  if (!m) return null;
  const [days, stars] = [Number(m[1]), Number(m[2])];
  return plans().find((p) => p.days === days && p.stars === stars) ?? null;
}

// Record a payment once. Returns false if this charge was already recorded.
export function recordPayment(chargeId, telegramId, stars, days) {
  return insertStmt.run(chargeId, telegramId, stars, days, Date.now()).changes > 0;
}
export function getPayment(chargeId) {
  return getStmt.get(chargeId) ?? null;
}
export function markRefunded(chargeId) {
  refundStmt.run(chargeId);
}
export function recentPayments(limit = 15) {
  return recentStmt.all(limit);
}
