import { db } from '../store/db.js';

// Per-owner Rust+ smart devices (paired via FCM "entity" pushes).
export const ENTITY_TYPE = { 1: 'Switch', 2: 'Alarm', 3: 'StorageMonitor' };

const upsertStmt = db.prepare(`
  INSERT INTO devices (owner_user_id, entity_id, type, name, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(owner_user_id, entity_id) DO UPDATE SET type = excluded.type, name = excluded.name
`);
const listStmt = db.prepare('SELECT entity_id, type, name FROM devices WHERE owner_user_id = ? ORDER BY type, name');
const getStmt = db.prepare('SELECT entity_id, type, name FROM devices WHERE owner_user_id = ? AND entity_id = ?');

export function upsertDevice(ownerId, { entityId, type = null, name = null }) {
  upsertStmt.run(ownerId, Number(entityId), type, name, Date.now());
}
export function listDevices(ownerId) {
  return listStmt.all(ownerId);
}
export function getDevice(ownerId, entityId) {
  return getStmt.get(ownerId, Number(entityId)) ?? null;
}
export function typeName(type) {
  return ENTITY_TYPE[type] ?? 'Entity';
}

const watchStmt = db.prepare('UPDATE devices SET watch = ? WHERE owner_user_id = ? AND entity_id = ? AND type = 3');
const watchedStmt = db.prepare('SELECT entity_id, name FROM devices WHERE owner_user_id = ? AND type = 3 AND watch = 1');
const monitorsStmt = db.prepare('SELECT entity_id, name, watch FROM devices WHERE owner_user_id = ? AND type = 3 ORDER BY name, entity_id');

// Storage Monitor contents-change alerts (see features/storageWatch.js).
export function setStorageWatch(ownerId, entityId, on) {
  return watchStmt.run(on ? 1 : 0, ownerId, Number(entityId)).changes > 0;
}
export function watchedStorage(ownerId) {
  return watchedStmt.all(ownerId);
}
export function storageMonitors(ownerId) {
  return monitorsStmt.all(ownerId);
}

const allStorageStmt = db.prepare("SELECT owner_user_id, entity_id, name FROM devices WHERE type = 3");
// All Storage Monitors across owners (for upkeep/decay polling).
export function allStorageMonitors() {
  return allStorageStmt.all();
}
