import PushReceiverClient from '@liamcottle/push-receiver/src/client.js';
import { log } from '../logger.js';
import * as pairStore from './store.js';
import { parseNotification } from './notification.js';

// Runs one FCM PushReceiverClient per paired user, concurrently in this process.
// When a user presses "Pair with Server" in-game, Facepunch pushes the server
// details here; we forward them via injected callbacks (so this module stays
// decoupled from the RustClient / SessionManager that consume them).
export class FcmListenerManager {
  constructor({ onServerPairing, onEntityPairing } = {}) {
    this.clients = new Map(); // telegramId -> PushReceiverClient
    this.onServerPairing = onServerPairing; // (telegramId, { ip, port, playerId, playerToken, name }) => void
    this.onEntityPairing = onEntityPairing; // optional (telegramId, entity) => void
  }

  async startAll() {
    for (const row of pairStore.listPairings()) {
      await this.startForUser(row.telegram_id);
    }
  }

  async startForUser(telegramId) {
    if (this.clients.has(telegramId)) return;

    const row = pairStore.getPairing(telegramId);
    if (!row) {
      log.warn(`FCM: no pairing stored for user ${telegramId}`);
      return;
    }

    let creds;
    try {
      creds = pairStore.credentials(row);
    } catch {
      log.warn(`FCM: corrupt fcm_credentials for user ${telegramId}`);
      return;
    }

    const androidId = creds?.gcm?.androidId;
    const securityToken = creds?.gcm?.securityToken;
    if (!androidId || !securityToken) {
      log.warn(`FCM: missing gcm credentials for user ${telegramId}`);
      return;
    }

    const persistentIds = pairStore.getPersistentIds(telegramId);
    const client = new PushReceiverClient(androidId, securityToken, persistentIds);
    client.on('connect', () => log.info(`FCM connected (user ${telegramId})`));
    client.on('disconnect', () => log.warn(`FCM disconnected (user ${telegramId})`));
    client.on('ON_DATA_RECEIVED', (data) => this._onData(telegramId, data));
    this.clients.set(telegramId, client);

    try {
      await client.connect();
    } catch (err) {
      log.warn(`FCM connect failed (user ${telegramId}): ${err.message}`);
    }
  }

  stopForUser(telegramId) {
    const client = this.clients.get(telegramId);
    if (!client) return;
    try {
      client.destroy();
    } catch {
      // ignore
    }
    this.clients.delete(telegramId);
  }

  async restartForUser(telegramId) {
    this.stopForUser(telegramId);
    await this.startForUser(telegramId);
  }

  stopAll() {
    for (const id of [...this.clients.keys()]) this.stopForUser(id);
  }

  _onData(telegramId, data) {
    if (data?.persistentId) pairStore.appendPersistentId(telegramId, data.persistentId);
    const n = parseNotification(data);
    if (!n) return;
    if (n.type === 'server') {
      log.info(`FCM server pairing (user ${telegramId}): ${n.name} ${n.ip}:${n.port} pid=${n.playerId}`);
      this.onServerPairing?.(telegramId, n);
    } else if (n.type === 'entity') {
      this.onEntityPairing?.(telegramId, n);
    }
  }
}
