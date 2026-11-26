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
  SELECT key, plan, redeemed_by FROM licenses
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
  if (!lic) return { allowed: false, reason: 'Нет активной подписки. /buy или /redeem <ключ>', reasonEn: 'No active subscription. /buy or /redeem <key>' };
  if (lic.account_player_id == null) {
    if (lic.plan === 'trial') {
      if (trialAccountUsedStmt.get(String(playerId), telegramId)) {
        return {
          allowed: false,
          reason: 'Пробный период для этого Rust-аккаунта уже использован. Оформи подписку: /buy',
          reasonEn: 'The trial was already used for this Rust account. Get a subscription: /buy',
        };
      }
      trialAccountStmt.run(String(playerId), telegramId, Date.now());
    }
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

const extendStmt = db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?');
const setPlanStmt = db.prepare('UPDATE licenses SET plan = ? WHERE key = ?');
const renewDueStmt = db.prepare(`
  SELECT key, plan, redeemed_by, expires_at FROM licenses
  WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at >= ?
    AND expires_at <= CASE WHEN plan = 'trial' THEN ? ELSE ? END
    AND (renew_warned_for IS NULL OR renew_warned_for != expires_at)
`);
const markWarnedStmt = db.prepare('UPDATE licenses SET renew_warned_for = expires_at WHERE key = ?');

// Active subscriptions ending within `withinMs` (`trialWithinMs` for trials) that
// haven't been reminded for their current expiry yet. Marks them reminded.
// Returns [{ plan, redeemed_by, expires_at }].
export function renewDue(withinMs, trialWithinMs = withinMs) {
  const now = Date.now();
  const due = renewDueStmt.all(now, now + trialWithinMs, now + withinMs);
  for (const row of due) markWarnedStmt.run(row.key);
  return due;
}

// Paid time (Telegram Stars): extend the active subscription, or start a new one.
// Extending keeps the bound Rust account. Returns the resulting license, or null
// if the user already has a lifetime license (nothing to extend).
export function grantDays(telegramId, days, name, plan = 'stars') {
  const lic = activeLicenseByUser(telegramId);
  if (lic && lic.expires_at == null) return null;
  if (lic) {
    extendStmt.run(lic.expires_at + days * DAY_MS, lic.key);
    if (lic.plan === 'trial') setPlanStmt.run(plan, lic.key); // paid now: no longer a trial
    return getStmt.get(lic.key);
  }
  return redeem(genKey({ plan, durationDays: days }), telegramId, name).license;
}

// Refund: take the paid days back off the active subscription (never below now).
export function revokeDays(telegramId, days) {
  const lic = activeLicenseByUser(telegramId);
  if (!lic || lic.expires_at == null) return;
  extendStmt.run(Math.max(Date.now(), lic.expires_at - days * DAY_MS), lic.key);
}

// --- Free trial: once per Telegram account and once per Rust account ---
const trialUsedStmt = db.prepare('SELECT 1 FROM trials WHERE telegram_id = ?');
const anyLicenseStmt = db.prepare('SELECT 1 FROM licenses WHERE redeemed_by = ? LIMIT 1');
const trialInsertStmt = db.prepare('INSERT INTO trials (telegram_id, key, created_at) VALUES (?, ?, ?)');
const trialAccountStmt = db.prepare('INSERT OR IGNORE INTO trial_accounts (player_id, telegram_id, created_at) VALUES (?, ?, ?)');
const trialAccountUsedStmt = db.prepare('SELECT 1 FROM trial_accounts WHERE player_id = ? AND telegram_id != ?');

// A trial is offered to users who never had a trial or any subscription.
export function trialAvailable(telegramId, days) {
  return days > 0 && !trialUsedStmt.get(telegramId) && !anyLicenseStmt.get(telegramId);
}

// Starts a `days`-long trial. Returns the license, or null if not available.
export function startTrial(telegramId, days, name) {
  if (!trialAvailable(telegramId, days)) return null;
  const key = genKey({ plan: 'trial', durationDays: days });
  const res = redeem(key, telegramId, name);
  trialInsertStmt.run(telegramId, key, Date.now());
  return res.license;
}
