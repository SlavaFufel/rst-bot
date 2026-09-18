import { db } from '../store/db.js';

// Per-owner registry of CCTV camera identifiers. Rust+ exposes no API to
// enumerate cameras (unlike smart devices, which pair via FCM), so the user
// saves identifiers once and then views them by a friendly label.

const addStmt = db.prepare(`
  INSERT INTO cameras (owner_user_id, identifier, label, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_user_id, identifier) DO UPDATE SET label = excluded.label
`);
const listStmt = db.prepare(
  'SELECT identifier, label FROM cameras WHERE owner_user_id = ? ORDER BY label IS NULL, label, identifier'
);
const delStmt = db.prepare('DELETE FROM cameras WHERE owner_user_id = ? AND identifier = ?');

export function addCamera(ownerId, identifier, label = null) {
  addStmt.run(ownerId, identifier, label, Date.now());
}

export function listCameras(ownerId) {
  return listStmt.all(ownerId);
}

export function removeCamera(ownerId, identifier) {
  return delStmt.run(ownerId, identifier).changes > 0;
}

// Resolve a user-typed token to a stored camera identifier, matching either the
// identifier or the friendly label (case-insensitive). Returns null if unknown.
export function resolveCamera(ownerId, token) {
  const t = String(token).trim().toLowerCase();
  const rows = listCameras(ownerId);
  const hit =
    rows.find((r) => r.identifier.toLowerCase() === t) ||
    rows.find((r) => (r.label || '').toLowerCase() === t);
  return hit ? hit.identifier : null;
}
