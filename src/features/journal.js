import { db } from '../store/db.js';

// Per-user notes, map pins (also serve as the legal "stash journal"), and
// per-session event stats — all keyed so users only see their own data.

const addNoteStmt = db.prepare('INSERT INTO notes (user_id, text, remind_at) VALUES (?, ?, ?)');
const listNotesStmt = db.prepare('SELECT id, text, remind_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 30');
const delNoteStmt = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?');

const addPinStmt = db.prepare(
  'INSERT INTO pins (grid, note, added_by, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)'
);
const listPinsStmt = db.prepare('SELECT id, grid, note FROM pins WHERE owner_user_id = ? ORDER BY id DESC LIMIT 50');
const listPinsByGridStmt = db.prepare(
  'SELECT id, grid, note FROM pins WHERE owner_user_id = ? AND grid = ? COLLATE NOCASE ORDER BY id DESC'
);
const delPinStmt = db.prepare('DELETE FROM pins WHERE id = ? AND owner_user_id = ?');

const statsStmt = db.prepare(
  'SELECT type, COUNT(*) AS n FROM event_log WHERE session_id = ? GROUP BY type ORDER BY n DESC'
);

export function addNote(userId, text, remindAt = null) {
  return Number(addNoteStmt.run(userId, text, remindAt).lastInsertRowid);
}
export function listNotes(userId) {
  return listNotesStmt.all(userId);
}
export function deleteNote(id, userId) {
  return delNoteStmt.run(id, userId).changes > 0;
}

export function addPin(ownerId, grid, note) {
  return Number(addPinStmt.run(grid, note, ownerId, ownerId, Date.now()).lastInsertRowid);
}
export function listPins(ownerId, grid = null) {
  return grid ? listPinsByGridStmt.all(ownerId, grid) : listPinsStmt.all(ownerId);
}
export function deletePin(id, ownerId) {
  return delPinStmt.run(id, ownerId).changes > 0;
}

export function sessionStats(sessionId) {
  return sessionId == null ? [] : statsStmt.all(sessionId);
}
