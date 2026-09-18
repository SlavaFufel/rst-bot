import { randomBytes } from 'node:crypto';
import { db } from '../store/db.js';

// Single-use codes that bind a desktop-helper upload to a Telegram account.
const CODE_TTL_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function makeCode() {
  const bytes = randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

const insertStmt = db.prepare('INSERT INTO pair_codes (code, telegram_id, expires_at) VALUES (?, ?, ?)');
const getStmt = db.prepare('SELECT * FROM pair_codes WHERE code = ?');
const useStmt = db.prepare('UPDATE pair_codes SET used_at = ? WHERE code = ?');
const delUserStmt = db.prepare('DELETE FROM pair_codes WHERE telegram_id = ?');
const cleanupStmt = db.prepare('DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL');

export function issueCode(telegramId, ttlMs = CODE_TTL_MS) {
  cleanupCodes(); // opportunistic sweep of expired/used codes
  delUserStmt.run(telegramId); // one active code per user
  const code = makeCode();
  insertStmt.run(code, telegramId, Date.now() + ttlMs);
  return code;
}

// Validate + consume atomically. Returns the bound telegram_id or null.
export function consumeCode(code) {
  const row = getStmt.get(code);
  if (!row || row.used_at != null || row.expires_at < Date.now()) return null;
  useStmt.run(Date.now(), code);
  return row.telegram_id;
}

export function cleanupCodes() {
  cleanupStmt.run(Date.now());
}
