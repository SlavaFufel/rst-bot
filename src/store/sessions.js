import { db } from './db.js';

// CRUD for rust_sessions — one live game-server connection per owner.
// Phase 2 (SessionManager) extends this with session_members / viewers.

const getByOwnerStmt = db.prepare('SELECT * FROM rust_sessions WHERE owner_user_id = ?');
const listStmt = db.prepare('SELECT * FROM rust_sessions');
const insertStmt = db.prepare(`
  INSERT INTO rust_sessions
    (owner_user_id, label, ip, port, player_id, player_token, server_id, state, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateServerStmt = db.prepare(`
  UPDATE rust_sessions
  SET ip = ?, port = ?, player_id = ?, player_token = ?, server_id = ?, label = ?, updated_at = ?
  WHERE owner_user_id = ?
`);
const setStateStmt = db.prepare('UPDATE rust_sessions SET state = ?, updated_at = ? WHERE owner_user_id = ?');
const deleteStmt = db.prepare('DELETE FROM rust_sessions WHERE owner_user_id = ?');

export function getByOwner(ownerId) {
  return getByOwnerStmt.get(ownerId) ?? null;
}

export function listSessions() {
  return listStmt.all();
}

// Live connection credentials for RustClient, or null if no server paired yet.
export function credsForOwner(ownerId) {
  const row = getByOwnerStmt.get(ownerId);
  if (!row || !row.ip) return null;
  return {
    ip: row.ip,
    port: row.port,
    playerId: row.player_id,
    playerToken: row.player_token,
    serverId: row.server_id ?? undefined,
  };
}

export function upsertServer(ownerId, { ip, port, playerId, playerToken, serverId = null, label = null }) {
  const now = Date.now();
  const existing = getByOwnerStmt.get(ownerId);
  if (existing) {
    updateServerStmt.run(
      ip, port, String(playerId), Number(playerToken), serverId, label ?? existing.label, now, ownerId
    );
    return existing.id;
  }
  const info = insertStmt.run(
    ownerId, label, ip, port, String(playerId), Number(playerToken), serverId, 'active', now, now
  );
  return Number(info.lastInsertRowid);
}

export function setState(ownerId, state) {
  setStateStmt.run(state, Date.now(), ownerId);
}

const getBmStmt = db.prepare('SELECT bm_server_id FROM rust_sessions WHERE owner_user_id = ?');
const setBmStmt = db.prepare('UPDATE rust_sessions SET bm_server_id = ? WHERE owner_user_id = ?');

export function getBmServerId(ownerId) {
  return getBmStmt.get(ownerId)?.bm_server_id ?? null;
}
export function setBmServerId(ownerId, bmServerId) {
  setBmStmt.run(bmServerId, ownerId);
}

export function remove(ownerId) {
  deleteStmt.run(ownerId);
}
