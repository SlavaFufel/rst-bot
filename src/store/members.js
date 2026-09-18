import { randomBytes } from 'node:crypto';
import { db } from './db.js';

// Family / seat-sharing: one paying owner + up to MAX_FAMILY_VIEWERS teammates
// who use the bot through Telegram only. Viewers attach to the owner's single
// RustSession via session_members — they get the same read access + smart-home
// control through the ONE shared bot, but cannot pair/unpair the server (that
// stays owner-only). Invite codes (family_invites) let an owner add teammates.

export const MAX_FAMILY_VIEWERS = 4;
const INVITE_TTL_MS = 14 * 24 * 60 * 60_000; // 14 days
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// ---- membership -----------------------------------------------------------
const addStmt = db.prepare(
  'INSERT OR IGNORE INTO session_members (session_owner_id, user_id, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)',
);
const removeStmt = db.prepare('DELETE FROM session_members WHERE session_owner_id = ? AND user_id = ?');
const listStmt = db.prepare('SELECT user_id, role FROM session_members WHERE session_owner_id = ? AND is_active = 1');
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM session_members WHERE session_owner_id = ? AND is_active = 1');
const ownerStmt = db.prepare('SELECT session_owner_id FROM session_members WHERE user_id = ? AND is_active = 1 LIMIT 1');
const isMemberStmt = db.prepare('SELECT 1 FROM session_members WHERE session_owner_id = ? AND user_id = ?');

export function addMember(ownerId, userId, role = 'viewer') {
  addStmt.run(ownerId, userId, role, Date.now());
}
export function removeMember(ownerId, userId) {
  removeStmt.run(ownerId, userId);
}
export function listMembers(ownerId) {
  return listStmt.all(ownerId);
}
export function countMembers(ownerId) {
  return countStmt.get(ownerId).c;
}
// The owner whose family this user views, or null if they're not a viewer.
export function ownerForViewer(userId) {
  return ownerStmt.get(userId)?.session_owner_id ?? null;
}
export function isMember(ownerId, userId) {
  return !!isMemberStmt.get(ownerId, userId);
}

// ---- invite codes ---------------------------------------------------------
const invInsertStmt = db.prepare(
  'INSERT INTO family_invites (code, owner_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
);
const invGetStmt = db.prepare('SELECT * FROM family_invites WHERE code = ?');
const invByOwnerStmt = db.prepare(
  'SELECT code FROM family_invites WHERE owner_user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
);
const invDelOwnerStmt = db.prepare('DELETE FROM family_invites WHERE owner_user_id = ?');
const invCleanupStmt = db.prepare('DELETE FROM family_invites WHERE expires_at < ?');

function makeCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

// Generate (replacing any prior) this owner's single active invite code.
export function createInvite(ownerId, ttlMs = INVITE_TTL_MS) {
  invCleanupStmt.run(Date.now());
  invDelOwnerStmt.run(ownerId);
  const code = makeCode();
  const now = Date.now();
  invInsertStmt.run(code, ownerId, now + ttlMs, now);
  return code;
}
// Current non-expired invite code for an owner, or null.
export function getActiveInvite(ownerId) {
  return invByOwnerStmt.get(ownerId, Date.now())?.code ?? null;
}
// Resolve a typed code to its owner id (null if unknown/expired).
export function resolveInvite(code) {
  const row = invGetStmt.get(String(code ?? '').trim().toUpperCase());
  if (!row || row.expires_at < Date.now()) return null;
  return row.owner_user_id;
}
