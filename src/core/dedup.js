import { db } from '../store/db.js';

const seenStmt = db.prepare('SELECT 1 FROM dedup WHERE key = ? AND expires_at > ?');
const markStmt = db.prepare('INSERT OR REPLACE INTO dedup (key, expires_at) VALUES (?, ?)');
const cleanStmt = db.prepare('DELETE FROM dedup WHERE expires_at <= ?');

const HOUR_MS = 3_600_000;

export function alreadyHandled(key) {
  return Boolean(seenStmt.get(key, Date.now()));
}

export function markHandled(key, ttlSeconds = 3600) {
  markStmt.run(key, Date.now() + ttlSeconds * 1000);
}

export function cleanupDedup() {
  cleanStmt.run(Date.now());
}

export { HOUR_MS };
