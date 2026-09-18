import { db } from '../store/db.js';
import { config } from '../config.js';

// Thin helpers over the users table (telegram_id PK, role, quiet hours).

const getStmt = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO users (telegram_id, name, role, created_at) VALUES (?, ?, ?, ?)'
);
const updateNameStmt = db.prepare('UPDATE users SET name = ? WHERE telegram_id = ?');
const setRoleStmt = db.prepare('UPDATE users SET role = ? WHERE telegram_id = ?');

export function getUser(telegramId) {
  return getStmt.get(telegramId) ?? null;
}

export function ensureUser(telegramId, name, role = 'member') {
  insertStmt.run(telegramId, name ?? String(telegramId), role, Date.now());
  if (name) updateNameStmt.run(name, telegramId);
}

export function setRole(telegramId, role) {
  setRoleStmt.run(role, telegramId);
}

export function isAdmin(telegramId) {
  if (telegramId === config.telegram.adminId) return true;
  return getStmt.get(telegramId)?.role === 'admin';
}

export function displayName(ctx) {
  return ctx.from?.username ?? ctx.from?.first_name ?? String(ctx.from?.id);
}

const mirrorGetStmt = db.prepare('SELECT chat_mirror FROM users WHERE telegram_id = ?');
const mirrorSetStmt = db.prepare('UPDATE users SET chat_mirror = ? WHERE telegram_id = ?');

// Whether to mirror this owner's alerts into the in-game team chat (default on).
export function mirrorEnabled(telegramId) {
  const row = mirrorGetStmt.get(telegramId);
  return row ? row.chat_mirror === 1 : true;
}
export function setMirror(telegramId, on) {
  mirrorSetStmt.run(on ? 1 : 0, telegramId);
}

const langGetStmt = db.prepare('SELECT lang FROM users WHERE telegram_id = ?');
const langSetStmt = db.prepare('UPDATE users SET lang = ? WHERE telegram_id = ?');

// Chosen UI language ('ru'|'en'), or null if the user hasn't picked yet.
export function getLang(telegramId) {
  return langGetStmt.get(telegramId)?.lang ?? null;
}
// Normalised UI language for a user ('ru'|'en'), defaulting to ru. Use this in
// notification/DM code paths that only have a telegram id (no ctx).
export function langOf(telegramId) {
  return langGetStmt.get(telegramId)?.lang === 'en' ? 'en' : 'ru';
}
export function setLang(telegramId, lang) {
  ensureUser(telegramId);
  langSetStmt.run(lang, telegramId);
}
