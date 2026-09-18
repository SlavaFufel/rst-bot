import { db } from '../store/db.js';

// CRUD for the pairings table — the user's FCM identity (set once at onboarding),
// plus the rolling persistent_ids list used to avoid reprocessing old pushes.

const MAX_PERSISTENT_IDS = 50;

const getStmt = db.prepare('SELECT * FROM pairings WHERE telegram_id = ?');
const listStmt = db.prepare('SELECT * FROM pairings');
const insertStmt = db.prepare(`
  INSERT INTO pairings
    (telegram_id, fcm_credentials, expo_push_token, rustplus_auth_token, persistent_ids, status, updated_at)
  VALUES (?, ?, ?, ?, '[]', 'ok', ?)
`);
const updateStmt = db.prepare(`
  UPDATE pairings
  SET fcm_credentials = ?, expo_push_token = ?, rustplus_auth_token = ?, status = 'ok', updated_at = ?
  WHERE telegram_id = ?
`);
const setStatusStmt = db.prepare('UPDATE pairings SET status = ?, updated_at = ? WHERE telegram_id = ?');
const setPidsStmt = db.prepare('UPDATE pairings SET persistent_ids = ? WHERE telegram_id = ?');
const deleteStmt = db.prepare('DELETE FROM pairings WHERE telegram_id = ?');

export function getPairing(telegramId) {
  return getStmt.get(telegramId) ?? null;
}

export function listPairings() {
  return listStmt.all();
}

export function upsertPairing(telegramId, { fcm_credentials, expo_push_token, rustplus_auth_token }) {
  const now = Date.now();
  const fcmJson = JSON.stringify(fcm_credentials);
  if (getStmt.get(telegramId)) {
    updateStmt.run(fcmJson, expo_push_token, rustplus_auth_token, now, telegramId);
  } else {
    insertStmt.run(telegramId, fcmJson, expo_push_token, rustplus_auth_token, now);
  }
}

export function setStatus(telegramId, status) {
  setStatusStmt.run(status, Date.now(), telegramId);
}

export function remove(telegramId) {
  deleteStmt.run(telegramId);
}

export function getPersistentIds(telegramId) {
  const row = getStmt.get(telegramId);
  if (!row) return [];
  try {
    const ids = JSON.parse(row.persistent_ids);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

export function appendPersistentId(telegramId, persistentId) {
  if (!persistentId) return;
  const ids = getPersistentIds(telegramId);
  if (ids.includes(persistentId)) return;
  ids.push(persistentId);
  setPidsStmt.run(JSON.stringify(ids.slice(-MAX_PERSISTENT_IDS)), telegramId);
}

// Parse the stored fcm_credentials JSON ({ gcm:{androidId,securityToken}, fcm:{token} }).
export function credentials(row) {
  return JSON.parse(row.fcm_credentials);
}
