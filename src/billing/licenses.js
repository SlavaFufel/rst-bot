import { randomBytes } from 'node:crypto';
import { db } from '../store/db.js';
import { ensureUser } from '../access/users.js';

const DAY_MS = 86_400_000;

// Unambiguous alphabet (no 0/O/1/I) for human-typed keys.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeKey() {
  const bytes = randomBytes(16);
  let body = '';
  for (let i = 0; i < 16; i += 1) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `RST-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

const insertStmt = db.prepare(`
  INSERT INTO licenses (key, plan, duration_days, status, created_by, created_at)
  VALUES (?, ?, ?, 'unused', ?, ?)
`);
const getStmt = db.prepare('SELECT * FROM licenses WHERE key = ?');
const activeByUserStmt = db.prepare(`
  SELECT * FROM licenses
  WHERE redeemed_by = ? AND status = 'active'
  ORDER BY COALESCE(expires_at, 9e18) DESC LIMIT 1
`);
const redeemStmt = db.prepare(`
  UPDATE licenses SET status = 'active', redeemed_by = ?, redeemed_at = ?, expires_at = ?
  WHERE key = ?
`);
const revokeStmt = db.prepare("UPDATE licenses SET status = 'revoked' WHERE key = ?");
const bindStmt = db.prepare('UPDATE licenses SET account_player_id = ? WHERE key = ?');
const rebindStmt = db.prepare("UPDATE licenses SET account_player_id = NULL WHERE redeemed_by = ? AND status = 'active'");
const expireDueStmt = db.prepare(`
  SELECT key, redeemed_by FROM licenses
  WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?
`);
const markExpiredStmt = db.prepare("UPDATE licenses SET status = 'expired' WHERE key = ?");
const listStmt = db.prepare('SELECT key, plan, status, duration_days, redeemed_by, expires_at FROM licenses ORDER BY created_at DESC');

export function genKey({ plan = 'standard', durationDays = null, createdBy = null }) {
  const key = makeKey();
  insertStmt.run(key, plan, durationDays, createdBy, Date.now());
  return key;
}

export function getLicense(key) {
  return getStmt.get(key) ?? null;
}

export function activeLicenseByUser(telegramId) {
  const lic = activeByUserStmt.get(telegramId);
  if (!lic) return null;
  if (lic.expires_at != null && lic.expires_at < Date.now()) return null; // lapsed but not yet swept
  return lic;
}

// Redeem a single-use key for a user. Creates/refreshes their access.
export function redeem(key, telegramId, name) {
  const lic = getStmt.get(key);
  if (!lic) return { ok: false, reason: 'Ключ не найден.', reasonEn: 'Key not found.' };
  if (lic.status === 'revoked') return { ok: false, reason: 'Ключ отозван.', reasonEn: 'Key revoked.' };
  if (lic.status === 'active' || lic.status === 'expired') {
    return { ok: false, reason: 'Ключ уже использован.', reasonEn: 'Key already used.' };
  }
  const now = Date.now();
  const expiresAt = lic.duration_days != null ? now + lic.duration_days * DAY_MS : null;
  redeemStmt.run(telegramId, now, expiresAt, key);
  ensureUser(telegramId, name, 'member');
  return { ok: true, license: getStmt.get(key) };
}

export function revoke(key) {
  const lic = getStmt.get(key);
  if (!lic) return null;
  revokeStmt.run(key);
  return lic.redeemed_by ?? null;
}

export function bindAccount(key, playerId) {
  bindStmt.run(String(playerId), key);
}

export function rebind(telegramId) {
  rebindStmt.run(telegramId);
}

// 1 subscription = 1 account. Binds on first pair; blocks a different account.
export function checkAndBind(telegramId, playerId, { isAdmin = false } = {}) {
  if (isAdmin) return { allowed: true };
  const lic = activeLicenseByUser(telegramId);
  if (!lic) return { allowed: false, reason: 'Нет активной подписки. /redeem <ключ>', reasonEn: 'No active subscription. /redeem <key>' };
  if (lic.account_player_id == null) {
    bindAccount(lic.key, playerId);
    return { allowed: true };
  }
  if (String(lic.account_player_id) === String(playerId)) return { allowed: true };
  return { allowed: false, reason: 'Подписка привязана к другому Rust-аккаунту. /rebind чтобы сменить.', reasonEn: 'Subscription is bound to a different Rust account. /rebind to switch.' };
}

// Sweep expired subscriptions. Returns [{ key, redeemed_by }] that just expired.
export function expireDue() {
  const due = expireDueStmt.all(Date.now());
  for (const row of due) markExpiredStmt.run(row.key);
  return due;
}

export function listKeys() {
  return listStmt.all();
}
