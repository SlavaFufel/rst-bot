import { RustSession } from './session.js';
import { EVENTS } from '../core/eventbus.js';
import { log } from '../logger.js';
import * as sessions from '../store/sessions.js';
import { handleInGameCommand } from './ingameCommands.js';
import { langOf } from '../access/users.js';
import { ownerForViewer, listMembers } from '../store/members.js';
import { L } from '../telegram/i18n.js';

// Every world/team event except the internal TEAM_CHAT_IN (consumed by ChatBridge),
// plus the chat-mirror signal, gets forwarded from a session's private bus to the
// single notifier sink, tagged with the originating session.
const FORWARD_EVENTS = [
  ...Object.values(EVENTS).filter((e) => e !== EVENTS.TEAM_CHAT_IN),
  'chat:fromGame',
];

// Registry of per-owner RustSessions. The single point the bot/notifier talk to.
export class SessionManager {
  constructor({ notify, canPair } = {}) {
    this.byOwner = new Map(); // ownerUserId -> RustSession
    this.onEvent = null; // (session, event, payload) => void — set by notifier
    this.notify = notify ?? (() => {}); // (telegramId, text) => void
    // (telegramId, playerId) => { allowed: boolean, reason?: string }
    this.canPair = canPair ?? (() => ({ allowed: true }));
  }

  init() {
    for (const row of sessions.listSessions()) {
      if (!row.ip) continue; // no server paired yet
      this._create(row);
    }
    for (const s of this.byOwner.values()) s.start();
    log.info(`SessionManager: ${this.byOwner.size} session(s) started`);
  }

  _create(row) {
    const creds = {
      ip: row.ip,
      port: row.port,
      playerId: row.player_id,
      playerToken: row.player_token,
      serverId: row.server_id ?? undefined,
    };
    const s = new RustSession({
      sessionId: row.id,
      ownerUserId: row.owner_user_id,
      creds,
      state: row.state || 'active',
    });
    s.onNotify = (text) => this.notify(s.ownerUserId, text);
    for (const ev of FORWARD_EVENTS) {
      s.bus.on(ev, (payload) => this.onEvent?.(s, ev, payload));
    }
    // In-game "!commands" typed in team chat → handled per session.
    s.bus.on('chat:command', (teamMessage) => handleInGameCommand(s, teamMessage).catch(() => {}));
    this.byOwner.set(row.owner_user_id, s);
    return s;
  }

  // Called when an FCM "Pair with Server" push arrives for a user.
  upsertPairing(ownerUserId, pairing) {
    const guard = this.canPair(ownerUserId, pairing.playerId);
    if (!guard.allowed) {
      log.warn(`Pairing rejected for ${ownerUserId}: ${guard.reason}`);
      this.notify(ownerUserId, '⚠️ ' + L(langOf(ownerUserId), guard.reason, guard.reasonEn || guard.reason));
      return null;
    }

    const prev = sessions.getByOwner(ownerUserId);
    const oldPlayerId = prev?.player_id;
    const changed = !prev
      || prev.ip !== pairing.ip
      || prev.port !== pairing.port
      || String(prev.player_id) !== String(pairing.playerId)
      || Number(prev.player_token) !== Number(pairing.playerToken);

    sessions.upsertServer(ownerUserId, pairing);
    const creds = {
      ip: pairing.ip,
      port: pairing.port,
      playerId: pairing.playerId,
      playerToken: pairing.playerToken,
    };

    let s = this.byOwner.get(ownerUserId);
    if (!s) {
      s = this._create(sessions.getByOwner(ownerUserId));
      s.start();
    } else if (changed) {
      s.swapCreds(creds);
    }

    if (oldPlayerId && String(oldPlayerId) !== String(pairing.playerId)) {
      this.notify(
        ownerUserId,
        L(
          langOf(ownerUserId),
          '⚠️ Аккаунт был сменён — перенастроил Rust+ на новый аккаунт.',
          '⚠️ Account switched — reconfigured Rust+ to the new account.',
        ),
      );
    }
    return s;
  }

  // Resolve a Telegram user to their active session: their own if they pair one,
  // otherwise the session of the family they're a viewer of (session_members).
  sessionForUser(telegramId) {
    const own = this.byOwner.get(telegramId);
    if (own) return own;
    const ownerId = ownerForViewer(telegramId);
    return ownerId != null ? this.byOwner.get(ownerId) ?? null : null;
  }

  // Recipients of a session's notifications: the owner + their family viewers.
  // deliver() filters each one by per-user subscriptions / quiet hours.
  recipientsOf(session) {
    return [session.ownerUserId, ...listMembers(session.ownerUserId).map((m) => m.user_id)];
  }

  freeze(ownerUserId, kind) {
    this.byOwner.get(ownerUserId)?.freeze(kind);
  }

  resume(ownerUserId) {
    this.byOwner.get(ownerUserId)?.resumeFromExpiry();
  }

  removePairing(ownerUserId) {
    this.byOwner.get(ownerUserId)?.stop();
    this.byOwner.delete(ownerUserId);
    sessions.remove(ownerUserId);
  }

  stopAll() {
    for (const s of this.byOwner.values()) s.stop();
  }
}
