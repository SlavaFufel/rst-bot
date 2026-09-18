import { readFileSync, existsSync } from 'node:fs';
import { log } from '../logger.js';
import { config } from '../config.js';
import * as pairStore from './store.js';
import * as sessions from '../store/sessions.js';

const CONFIG_FILE = 'rustplus.config.json';

// One-time seed for the operator (the existing single user) so the FCM listener
// and account-switch detection work before the full onboarding flow exists.
// Idempotent: only seeds rows that are missing.
export function seedOperator() {
  const adminId = config.telegram.allowedIds[0];
  if (!adminId) {
    log.warn('seedOperator: no admin id in ALLOWED_TELEGRAM_IDS');
    return;
  }

  // FCM identity from rustplus.config.json (produced by `npm run pair`).
  if (!pairStore.getPairing(adminId) && existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.fcm_credentials && cfg.expo_push_token && cfg.rustplus_auth_token) {
        pairStore.upsertPairing(adminId, {
          fcm_credentials: cfg.fcm_credentials,
          expo_push_token: cfg.expo_push_token,
          rustplus_auth_token: cfg.rustplus_auth_token,
        });
        log.info('Seeded FCM pairing for operator from rustplus.config.json');
      }
    } catch (err) {
      log.warn('seedOperator: failed to read rustplus.config.json:', err.message);
    }
  }

  // Live server connection from .env (the working credentials).
  if (!sessions.getByOwner(adminId) && config.rust.ip) {
    sessions.upsertServer(adminId, {
      ip: config.rust.ip,
      port: config.rust.port,
      playerId: config.rust.playerId,
      playerToken: config.rust.playerToken,
      serverId: config.rust.serverId ?? null,
    });
    log.info('Seeded server pairing for operator from .env');
  }
}
