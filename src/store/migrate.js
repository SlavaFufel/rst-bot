// Forward-only, additive migrations. Run once at boot after the
// `CREATE TABLE IF NOT EXISTS` schema. node:sqlite (DatabaseSync) supports
// PRAGMA table_info and ALTER TABLE ADD COLUMN. We never drop/rewrite columns.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

function addColumn(db, table, column, decl) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function migrate(db) {
  db.exec('BEGIN');
  try {
    // Scope previously-global rows by owner/session.
    addColumn(db, 'event_log', 'session_id', 'INTEGER');
    addColumn(db, 'enemies', 'owner_user_id', 'INTEGER');
    addColumn(db, 'pins', 'owner_user_id', 'INTEGER');
    addColumn(db, 'enemy_sessions', 'owner_user_id', 'INTEGER');
    // Subscription duration (days); null = lifetime. expires_at computed at redeem.
    addColumn(db, 'licenses', 'duration_days', 'INTEGER');
    // Auto-resolved BattleMetrics server id (from the session's IP) — cached so
    // customers never enter it manually.
    addColumn(db, 'rust_sessions', 'bm_server_id', 'TEXT');
    // Mirror this owner's alerts into the in-game team chat (1=on by default).
    addColumn(db, 'users', 'chat_mirror', 'INTEGER NOT NULL DEFAULT 1');
    // Scene to auto-apply when this owner's Smart Alarm triggers (raid reaction).
    addColumn(db, 'users', 'raid_scene', 'TEXT');
    // UI language: 'ru' | 'en' | null (null = not chosen yet → show picker).
    addColumn(db, 'users', 'lang', 'TEXT');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
