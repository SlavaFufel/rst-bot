import { db } from '../store/db.js';

// Per-owner tracked enemies (enemies table; owner_user_id added by migrate).

const addStmt = db.prepare(
  'INSERT INTO enemies (label, steam_id, bm_player_id, notify, added_by, owner_user_id) VALUES (?, ?, ?, 1, ?, ?)'
);
const listStmt = db.prepare('SELECT id, label, steam_id, bm_player_id, notify FROM enemies WHERE owner_user_id = ? ORDER BY id');
const getStmt = db.prepare('SELECT * FROM enemies WHERE id = ? AND owner_user_id = ?');
const findByLabelStmt = db.prepare('SELECT * FROM enemies WHERE owner_user_id = ? AND label = ? COLLATE NOCASE LIMIT 1');
const delStmt = db.prepare('DELETE FROM enemies WHERE id = ? AND owner_user_id = ?');
const allNotifyStmt = db.prepare('SELECT id, label, bm_player_id, owner_user_id FROM enemies WHERE notify = 1 AND bm_player_id IS NOT NULL');

export function addEnemy(ownerId, { label, steamId = null, bmPlayerId = null }) {
  return Number(addStmt.run(label, steamId, bmPlayerId, ownerId, ownerId).lastInsertRowid);
}
export function listEnemies(ownerId) {
  return listStmt.all(ownerId);
}
export function getEnemy(id, ownerId) {
  return getStmt.get(id, ownerId) ?? null;
}
export function findEnemy(ownerId, label) {
  return findByLabelStmt.get(ownerId, label) ?? null;
}
export function removeEnemy(id, ownerId) {
  return delStmt.run(id, ownerId).changes > 0;
}
// All notify-enabled enemies with a BM id (for the online-tracking poll).
export function trackedWithBm() {
  return allNotifyStmt.all();
}

const allSteamStmt = db.prepare(
  'SELECT id, label, steam_id, owner_user_id FROM enemies WHERE notify = 1 AND steam_id IS NOT NULL'
);
// All notify-enabled enemies with a SteamID (for the Steam presence poll).
export function trackedWithSteam() {
  return allSteamStmt.all();
}

// --- Observed presence sessions (bot's own tracking → activity heatmap) ---
const openSessStmt = db.prepare('SELECT id FROM enemy_sessions WHERE enemy_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1');
const insertSessStmt = db.prepare("INSERT INTO enemy_sessions (enemy_id, owner_user_id, started_at, source) VALUES (?, ?, ?, 'steam')");
const closeSessStmt = db.prepare('UPDATE enemy_sessions SET ended_at = ?, duration_sec = (? - started_at) / 1000 WHERE id = ?');
const getSessStmt = db.prepare('SELECT started_at, ended_at FROM enemy_sessions WHERE enemy_id = ? ORDER BY started_at');

export function openSession(enemyId, ownerId) {
  if (openSessStmt.get(enemyId)) return; // already open
  insertSessStmt.run(enemyId, ownerId, Date.now());
}
export function closeSession(enemyId) {
  const open = openSessStmt.get(enemyId);
  if (!open) return;
  const now = Date.now();
  closeSessStmt.run(now, now, open.id);
}
export function getEnemySessions(enemyId) {
  return getSessStmt.all(enemyId);
}
