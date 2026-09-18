import { EventEmitter } from 'node:events';
import { RustClient } from './client.js';
import { Poller } from './poller.js';
import { ChatBridge } from './chat.js';
import { log } from '../logger.js';
import { EVENTS } from '../core/eventbus.js';
import * as sessions from '../store/sessions.js';
import { getDevice } from '../devices/store.js';
import { renderMapImage } from './maprender.js';

// Consecutive failed polls (invalid-token symptom) before we freeze the session.
const AUTH_ERROR_THRESHOLD = 3;

// Owns one user's live Rust+ connection: RustClient + Poller + ChatBridge, all
// wired to a private EventEmitter so events are inherently scoped to this owner.
// Encapsulates the freeze / auto-restore state machine.
export class RustSession {
  constructor({ sessionId, ownerUserId, creds, state = 'active' }) {
    this.id = sessionId;
    this.ownerUserId = ownerUserId;
    this.creds = creds;
    this.state = state;
    this.pollingActive = false;
    this.authErrors = 0;
    this.onNotify = null; // (text) => void — injected by SessionManager

    this.bus = new EventEmitter();
    this.bus.setMaxListeners(50);
    this.client = new RustClient(creds, this.bus);
    this.chat = new ChatBridge(this.client, this.bus);
    this.poller = new Poller(this.client, this.bus, this.id);

    this.bus.on('rust:connected', () => {
      this._startPolling().catch((e) => log.warn(`session ${this.id} startPolling:`, e.message));
    });
    this.bus.on('rust:poll_ok', () => { this.authErrors = 0; });
    this.bus.on('rust:auth_error', () => {
      this.authErrors += 1;
      if (this.authErrors >= AUTH_ERROR_THRESHOLD) this.freeze('disconnected');
    });
    // Smart Alarm triggered → raid alert (entityChanged broadcast, value=true).
    this.bus.on('entity:changed', ({ entityId, value }) => {
      const device = getDevice(this.ownerUserId, entityId);
      if (device?.type === 2 && value) {
        this.bus.emit(EVENTS.ALARM, { title: device.name || 'Smart Alarm', message: 'сработала сигналка в базе!' });
      }
    });
  }

  start() {
    if (this.state === 'frozen:expired') return; // subscription lapsed — stay down
    // A disconnected-frozen session gets a fresh attempt on boot; polling
    // re-freezes it if the token is still bad.
    if (this.state === 'frozen:disconnected') this._setState('active');
    this.client.connect();
  }

  async _startPolling() {
    // Run init() on EVERY (re)connect: it re-arms firstMarkerPoll so the first
    // marker poll after a reconnect re-seeds silently. Without this, a server
    // restart (which reissues marker ids) made every standing shop look "new"
    // and spammed SHOP_NEW. Re-running it also refreshes seed/map/monuments.
    await this.poller.init();
    if (this.pollingActive) return; // reconnect — intervals already running, don't double-start
    this.pollingActive = true;
    this.poller.start();
  }

  _setState(state) {
    this.state = state;
    sessions.setState(this.ownerUserId, state);
  }

  // Stop polling + socket and mark frozen. kind: 'disconnected' | 'expired'.
  freeze(kind) {
    const state = `frozen:${kind}`;
    if (this.state === state) return;
    this._setState(state);
    this.pollingActive = false;
    this.poller.stop();
    this.client.stop();
    log.warn(`Session ${this.id} frozen: ${kind}`);
    if (kind === 'disconnected') {
      this.onNotify?.(
        '⚠️ Соединение с Rust+ потеряно (возможно, токен сбит после вайпа). ' +
          'Зайди в игру и нажми «Pair with Server» — бот восстановится сам.'
      );
    }
  }

  // Re-pair / account switch: swap creds + reconnect; clears any freeze.
  swapCreds(creds) {
    const wasFrozen = this.state.startsWith('frozen');
    this.creds = creds;
    this.authErrors = 0;
    this._setState('active');
    this.client.reconfigure(creds); // reconnect → bus 'rust:connected' → re-arm polling
    if (wasFrozen) this.onNotify?.('✅ Связь с Rust+ восстановлена.');
  }

  // Subscription renewed: come back online with the stored creds (no re-pair).
  resumeFromExpiry() {
    if (this.state !== 'frozen:expired') return;
    this._setState('active');
    this.client.connect();
  }

  stop() {
    this.poller.stop();
    this.client.stop();
    this.bus.removeAllListeners();
    this.pollingActive = false;
  }

  isConnected() { return this.client.connected; }
  mapSize() { return this.poller.mapSize; }
  seed() { return this.poller.lastSeed; }

  // Current map markers with grid labels (for in-game !cargo/!heli etc.).
  liveMarkers() {
    const out = [];
    for (const m of this.poller.markers.values()) out.push({ type: m.type, grid: this.poller.gridNear(m) });
    return out;
  }
  getInfo() { return this.client.getInfo(); }
  getTime() { return this.client.getTime(); }
  getTeamInfo() { return this.client.getTeamInfo(); }
  sendToGame(text) { this.chat.sendToGame(text); }
  promoteToLeader(steamId) { return this.client.promoteToLeader(steamId); }
  teamStats() { return this.poller.teamStatsList(); }
  recentDeaths() { return this.poller.recentDeaths(); }
  markerDump() { return this.poller.markerDump(); }
  getEntityInfo(entityId) { return this.client.getEntityInfo(entityId); }
  setEntityValue(entityId, value) { return this.client.setEntityValue(entityId, value); }

  // Read current on/off state of the given switch entity ids → { id: bool }.
  async switchStates(entityIds) {
    const out = {};
    for (const id of entityIds) {
      try {
        const info = await this.getEntityInfo(id);
        out[id] = !!info?.payload?.value;
      } catch {
        // skip unreachable device
      }
    }
    return out;
  }

  // Apply a { entityId: bool } map to the switches.
  async applySwitches(stateMap) {
    for (const [id, val] of Object.entries(stateMap)) {
      try {
        await this.setEntityValue(Number(id), !!val);
      } catch {
        // skip unreachable device
      }
    }
  }
  shops() { return this.poller.shops(); }
  getMap() { return this.client.getMap(); }
  cameraSnapshot(identifier) { return this.client.cameraSnapshot(identifier); }

  // Tactical map: server map image with live markers + teammates + oil rigs +
  // recent deaths + the owner's pins drawn on top. pins: [{ x, y, label }].
  async tacticalMap({ pins = [] } = {}) {
    const [map, markers, team] = await Promise.all([
      this.client.getMap(),
      this.client.getMapMarkers(),
      this.client.getTeamInfo().catch(() => ({ members: [] })),
    ]);
    // In-game map notes the team placed in Rust (personal + leader), deduped by cell.
    const seen = new Set();
    const mapNotes = [...(team.mapNotes ?? []), ...(team.leaderMapNotes ?? [])].filter((n) => {
      if (n?.x == null) return false;
      const key = `${Math.round(n.x)},${Math.round(n.y)}`;
      return seen.has(key) ? false : seen.add(key);
    });
    return renderMapImage(map, markers, team.members ?? [], this.poller.mapSize || 4500, {
      monuments: this.poller.monuments,
      deaths: this.poller.recentDeaths(),
      pins,
      mapNotes,
    });
  }

  // Raw live markers + team for a text listing (used when image render is off).
  async mapMarkersData() {
    const [markers, team] = await Promise.all([
      this.client.getMapMarkers(),
      this.client.getTeamInfo().catch(() => ({ members: [] })),
    ]);
    return { markers: markers ?? [], team: team.members ?? [], mapSize: this.poller.mapSize || 4500 };
  }
}
