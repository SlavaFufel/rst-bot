import { db } from '../store/db.js';

// Smart-switch presets ("scenes") per owner: name -> { entityId: bool }.
// Plus the per-owner scene auto-applied on a Smart Alarm trigger (users.raid_scene).

// SQLite COLLATE NOCASE only case-folds ASCII, so normalise names in JS
// (Unicode-aware) for consistent Cyrillic lookups.
const norm = (s) => String(s).trim().toLowerCase();

const saveStmt = db.prepare(`
  INSERT INTO scenes (owner_user_id, name, data, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_user_id, name) DO UPDATE SET data = excluded.data
`);
const getStmt = db.prepare('SELECT data FROM scenes WHERE owner_user_id = ? AND name = ?');
const listStmt = db.prepare('SELECT name FROM scenes WHERE owner_user_id = ? ORDER BY name');
const delStmt = db.prepare('DELETE FROM scenes WHERE owner_user_id = ? AND name = ?');
const setRaidStmt = db.prepare('UPDATE users SET raid_scene = ? WHERE telegram_id = ?');
const getRaidStmt = db.prepare('SELECT raid_scene FROM users WHERE telegram_id = ?');

export function saveScene(ownerId, name, stateMap) {
  saveStmt.run(ownerId, norm(name), JSON.stringify(stateMap), Date.now());
}
export function getScene(ownerId, name) {
  const row = getStmt.get(ownerId, norm(name));
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}
export function listScenes(ownerId) {
  return listStmt.all(ownerId).map((r) => r.name);
}
export function deleteScene(ownerId, name) {
  return delStmt.run(ownerId, norm(name)).changes > 0;
}
export function setRaidScene(ownerId, name) {
  setRaidStmt.run(name == null ? null : norm(name), ownerId);
}
export function getRaidScene(ownerId) {
  return getRaidStmt.get(ownerId)?.raid_scene ?? null;
}
