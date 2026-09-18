import RustPlus from '@liamcottle/rustplus.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { bus, EVENTS } from '../core/eventbus.js';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// Thin wrapper around rustplus.js: auto-reconnect with backoff + promisified requests.
export class RustClient {
  // creds: { ip, port, playerId, playerToken }. Defaults to config.rust so the
  // single-tenant boot path keeps working; multi-tenant callers pass per-user creds.
  // busArg: per-session EventEmitter; defaults to the global bus.
  constructor(creds = null, busArg = null) {
    this.rp = null;
    this.connected = false;
    this.reconnectMs = RECONNECT_BASE_MS;
    this.stopping = false;
    this.bus = busArg ?? bus;
    this.creds = creds ?? {
      ip: config.rust.ip,
      port: config.rust.port,
      playerId: config.rust.playerId,
      playerToken: config.rust.playerToken,
    };
  }

  connect() {
    this.stopping = false;
    const { ip, port, playerId, playerToken } = this.creds;
    this.rp = new RustPlus(ip, port, playerId, playerToken);

    this.rp.on('connected', () => {
      this.connected = true;
      this.reconnectMs = RECONNECT_BASE_MS;
      log.info('Rust+ connected');
      this.bus.emit('rust:connected');
    });

    this.rp.on('disconnected', () => {
      this.connected = false;
      log.warn('Rust+ disconnected');
      this.bus.emit('rust:disconnected');
      if (!this.stopping) this.scheduleReconnect();
    });

    this.rp.on('error', (err) => {
      log.error('Rust+ socket error:', err?.message || err);
    });

    this.rp.on('message', (message) => {
      const teamMessage = message?.broadcast?.teamMessage?.message;
      if (teamMessage) this.bus.emit(EVENTS.TEAM_CHAT_IN, teamMessage);
      const entityChanged = message?.broadcast?.entityChanged;
      if (entityChanged) {
        this.bus.emit('entity:changed', {
          entityId: entityChanged.entityId,
          value: entityChanged.payload?.value,
        });
      }
    });

    this.rp.connect();
  }

  scheduleReconnect() {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    log.info(`Rust+ reconnect in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (!this.stopping) this.connect();
    }, delay);
  }

  stop() {
    this.stopping = true;
    try {
      this.rp?.disconnect();
    } catch {
      // ignore
    }
  }

  // Hot-swap credentials (account switch / re-pair after wipe) and reconnect.
  // Detaches the old socket's listeners first so its async 'disconnected' does
  // not trigger a stray reconnect against the stale creds.
  reconfigure(creds) {
    this.creds = creds;
    const old = this.rp;
    this.rp = null;
    this.connected = false;
    if (old) {
      try {
        old.removeAllListeners();
        old.disconnect();
      } catch {
        // ignore
      }
    }
    this.connect();
  }

  request(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.rp || !this.connected) {
        reject(new Error('Rust+ not connected'));
        return;
      }
      try {
        this.rp[method](...args, (message) => {
          if (message?.response?.error) {
            reject(new Error(message.response.error.error));
          } else {
            resolve(message.response);
          }
          return true; // mark handled so rustplus.js drops the callback
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getInfo() {
    return this.request('getInfo').then((r) => r.info);
  }

  getMapMarkers() {
    return this.request('getMapMarkers').then((r) => r.mapMarkers.markers ?? []);
  }

  getTeamInfo() {
    return this.request('getTeamInfo').then((r) => r.teamInfo);
  }

  getTime() {
    return this.request('getTime').then((r) => r.time);
  }

  getMap() {
    return this.request('getMap').then((r) => r.map);
  }

  sendTeamMessage(message) {
    return this.request('sendTeamMessage', message);
  }

  // Transfer team leadership to a Steam id. The Rust server only honors this when
  // OUR paired account is the CURRENT team leader (leader-only action). There's no
  // typed wrapper in rustplus.js, so we hand-build the AppRequest via sendRequest.
  promoteToLeader(steamId) {
    return this.request('sendRequest', { promoteToLeader: { steamId } });
  }

  getEntityInfo(entityId) {
    return this.request('getEntityInfo', entityId).then((r) => r.entityInfo);
  }

  setEntityValue(entityId, value) {
    return this.request('setEntityValue', entityId, value);
  }

  // Subscribe to a camera, wait for the first rendered PNG frame, unsubscribe.
  // Returns a PNG Buffer. Uses rustplus.js's Camera class (pure-JS jimp render).
  cameraSnapshot(identifier, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      if (!this.rp || !this.connected) {
        reject(new Error('Rust+ не подключён'));
        return;
      }
      // rustplus.js rejects with the raw AppError ({ error: 'not_found' }), not
      // an Error — normalise so callers get a readable message.
      const toError = (err) =>
        err instanceof Error ? err : new Error(err?.error || err?.message || JSON.stringify(err));
      let camera;
      try {
        camera = this.rp.getCamera(identifier);
      } catch (err) {
        reject(toError(err));
        return;
      }
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          camera.removeAllListeners('render');
          camera.unsubscribe().catch(() => {});
        } catch {
          // ignore
        }
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error('камера не ответила (таймаут — нет кадров)')), timeoutMs);
      camera.on('render', (png) => finish(resolve, png));
      camera.subscribe().catch((err) => finish(reject, toError(err)));
    });
  }
}
