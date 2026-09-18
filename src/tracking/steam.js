import { config } from '../config.js';
import { db } from '../store/db.js';
import { bus, EVENTS } from '../core/eventbus.js';
import { logEvent } from '../store/db.js';
import { log } from '../logger.js';

const RUST_APPID = '252490';

// Polls the Steam Web API for tracked friends and emits online/offline transitions.
export class SteamTracker {
  constructor() {
    this.state = new Map(); // steamId -> { online, inRust }
    this.timer = null;
    this.friendsStmt = db.prepare('SELECT steam_id, label FROM tracked_friends WHERE notify = 1');
  }

  start() {
    if (!config.steam.apiKey) {
      log.warn('STEAM_API_KEY not set — friend online tracking disabled.');
      return;
    }
    this.timer = setInterval(() => {
      this.poll().catch((err) => log.warn('steam poll:', err.message));
    }, config.poll.steamMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    const friends = this.friendsStmt.all();
    if (!friends.length) return;

    const ids = friends.map((f) => f.steam_id).join(',');
    const url =
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/' +
      `?key=${config.steam.apiKey}&steamids=${ids}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Steam API ${response.status}`);
    const data = await response.json();
    const players = data?.response?.players ?? [];

    for (const player of players) {
      const inRust = player.gameid === RUST_APPID;
      const online = player.personastate > 0 || inRust;
      const label = friends.find((f) => f.steam_id === player.steamid)?.label ?? player.personaname;
      const prev = this.state.get(player.steamid);

      if (prev !== undefined) {
        if (!prev.online && online) {
          logEvent(EVENTS.FRIEND_ONLINE, { label, inRust });
          bus.emit(EVENTS.FRIEND_ONLINE, { label, inRust, server: player.gameserverip });
        } else if (prev.online && !online) {
          logEvent(EVENTS.FRIEND_OFFLINE, { label });
          bus.emit(EVENTS.FRIEND_OFFLINE, { label });
        }
      }
      this.state.set(player.steamid, { online, inRust });
    }
  }
}
