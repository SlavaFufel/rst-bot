import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrate.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'member',
  quiet_from  INTEGER,
  quiet_to    INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id    INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, event_type)
);

CREATE TABLE IF NOT EXISTS tracked_friends (
  steam_id TEXT PRIMARY KEY,
  label    TEXT,
  notify   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS enemies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  steam_id      TEXT,
  bm_player_id  TEXT,
  notify        INTEGER NOT NULL DEFAULT 1,
  added_by      INTEGER
);

CREATE TABLE IF NOT EXISTS enemy_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enemy_id     INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_sec INTEGER,
  source       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL,
  item_id   INTEGER NOT NULL,
  max_price INTEGER,
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS entities (
  entity_id INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL,
  name      TEXT,
  grp       TEXT
);

CREATE TABLE IF NOT EXISTS pins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  grid       TEXT,
  note       TEXT,
  added_by   INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER,
  text      TEXT NOT NULL,
  remind_at INTEGER
);

CREATE TABLE IF NOT EXISTS event_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT NOT NULL,
  payload TEXT,
  ts      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dedup (
  key        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- FCM identity per user (set once at onboarding; drives the push listener).
CREATE TABLE IF NOT EXISTS pairings (
  telegram_id         INTEGER PRIMARY KEY,
  fcm_credentials     TEXT NOT NULL,            -- JSON {gcm:{androidId,securityToken},fcm:{token}}
  expo_push_token     TEXT NOT NULL,
  rustplus_auth_token TEXT NOT NULL,
  persistent_ids      TEXT NOT NULL DEFAULT '[]', -- JSON array of last-seen FCM ids
  status              TEXT NOT NULL DEFAULT 'ok',
  updated_at          INTEGER NOT NULL
);

-- Live game-server connection per owner + session state machine.
CREATE TABLE IF NOT EXISTS rust_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL UNIQUE,        -- telegram_id; one pairing per owner
  label         TEXT,
  ip            TEXT,
  port          INTEGER,
  player_id     TEXT,                           -- last paired playerId (account-switch detect)
  player_token  INTEGER,
  server_id     TEXT,
  state         TEXT NOT NULL DEFAULT 'active',  -- active | frozen:expired | frozen:disconnected | needs_repair
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Viewers attached to another owner's session (shared-team mode).
CREATE TABLE IF NOT EXISTS session_members (
  session_owner_id INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,
  role             TEXT NOT NULL DEFAULT 'viewer',
  is_active        INTEGER NOT NULL DEFAULT 1,   -- viewer's currently-selected session
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (session_owner_id, user_id)
);

-- License/subscription: key + term + 1-account binding. Unifies access key and subscription.
CREATE TABLE IF NOT EXISTS licenses (
  key               TEXT PRIMARY KEY,
  plan              TEXT NOT NULL DEFAULT 'standard',
  account_player_id TEXT,                         -- bound on first server pairing (1 sub = 1 account)
  redeemed_by       INTEGER,                      -- telegram_id
  redeemed_at       INTEGER,
  expires_at        INTEGER,                       -- null = lifetime
  status            TEXT NOT NULL DEFAULT 'unused',-- unused | active | expired | revoked
  created_by        INTEGER,
  created_at        INTEGER NOT NULL
);

-- Single-use codes binding the desktop helper upload to a Telegram account.
CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Family invite codes: an owner shares a code, teammates /join to become viewers.
CREATE TABLE IF NOT EXISTS family_invites (
  code          TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Per-owner tracked friends (replaces global tracked_friends; PK could not be ALTERed).
CREATE TABLE IF NOT EXISTS tracked_friends2 (
  owner_user_id INTEGER NOT NULL,
  steam_id      TEXT NOT NULL,
  label         TEXT,
  notify        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_user_id, steam_id)
);

-- Paired Rust+ smart devices (alarms, switches, storage monitors) per owner.
CREATE TABLE IF NOT EXISTS devices (
  owner_user_id INTEGER NOT NULL,
  entity_id     INTEGER NOT NULL,
  type          INTEGER,            -- 1=Switch, 2=Alarm, 3=StorageMonitor
  name          TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, entity_id)
);

-- Smart-switch presets: data = JSON { entityId: bool }.
CREATE TABLE IF NOT EXISTS scenes (
  owner_user_id INTEGER NOT NULL,
  name          TEXT NOT NULL,
  data          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, name)
);

-- Vending price snapshots (cheapest scrap price per item) for /pricehistory.
CREATE TABLE IF NOT EXISTS price_history (
  owner_user_id INTEGER NOT NULL,
  item_id       INTEGER NOT NULL,
  price         INTEGER NOT NULL,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history ON price_history (owner_user_id, item_id, ts);

-- Saved CCTV camera identifiers per owner (Rust+ has no API to list cameras,
-- so the user registers identifiers once and views them by friendly label).
CREATE TABLE IF NOT EXISTS cameras (
  owner_user_id INTEGER NOT NULL,
  identifier    TEXT NOT NULL,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, identifier)
);

-- Per-teammate playtime/AFK/deaths/distance, accumulated by the poller and reset
-- each wipe. Keyed by (session, steamId, wipe) so a bot restart mid-wipe resumes
-- from the last flush instead of starting from zero.
CREATE TABLE IF NOT EXISTS team_stats (
  session_id  INTEGER NOT NULL,
  steam_id    TEXT NOT NULL,
  wipe        INTEGER NOT NULL,          -- server wipeTime; identifies the wipe
  name        TEXT,
  playtime_ms INTEGER NOT NULL DEFAULT 0,
  afk_ms      INTEGER NOT NULL DEFAULT 0,
  deaths      INTEGER NOT NULL DEFAULT 0,
  distance_m  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, steam_id, wipe)
);
`;

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(SCHEMA);
migrate(db);

const logEventStmt = db.prepare(
  'INSERT INTO event_log (type, payload, ts, session_id) VALUES (?, ?, ?, ?)'
);

export function logEvent(type, payload, sessionId = null) {
  logEventStmt.run(type, payload ? JSON.stringify(payload) : null, Date.now(), sessionId);
}
