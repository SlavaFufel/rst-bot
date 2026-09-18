import { bus, EVENTS } from '../core/eventbus.js';
import { log } from '../logger.js';

const BOT_PREFIX = '[BOT]'; // ASCII — emoji don't render in Rust chat font
const SEND_INTERVAL_MS = 2_500;
const MAX_MESSAGE_LEN = 128;

// Rust's in-game chat font renders most emoji/pictographs as "?", and only some
// (e.g. ♻) by luck — inconsistent and ugly. Strip emoji, variation selectors,
// ZWJ and keycaps from anything we send to game chat (Telegram keeps its emoji;
// only the mirrored in-game copy is cleaned). Keeps ≈, →, ·, № and plain text.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;
function stripEmoji(text) {
  return String(text).replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Two-way bridge between the in-game team chat and the rest of the app.
// Outgoing messages are throttled and prefixed so they can be filtered back out.
export class ChatBridge {
  constructor(client, busArg = null) {
    this.client = client;
    this.bus = busArg ?? bus;
    this.queue = [];
    this.timer = null;
    this.bus.on(EVENTS.TEAM_CHAT_IN, (teamMessage) => this.onIncoming(teamMessage));
  }

  onIncoming(teamMessage) {
    if (typeof teamMessage.message === 'string' && teamMessage.message.startsWith(BOT_PREFIX)) {
      return; // our own message — avoid loops
    }
    this.bus.emit('chat:fromGame', teamMessage);
    if (teamMessage.message?.startsWith('!')) this.bus.emit('chat:command', teamMessage);
  }

  sendToGame(text) {
    const clean = stripEmoji(text);
    if (!clean) return; // nothing left after stripping (e.g. an emoji-only string)
    const message = `${BOT_PREFIX} ${clean}`.slice(0, MAX_MESSAGE_LEN);
    this.queue.push(message);
    this.drain();
  }

  drain() {
    if (this.timer) return;
    const tick = () => {
      const next = this.queue.shift();
      if (next === undefined) {
        this.timer = null;
        return;
      }
      this.client
        .sendTeamMessage(next)
        .catch((err) => log.warn('sendTeamMessage failed:', err.message));
      this.timer = setTimeout(tick, SEND_INTERVAL_MS);
    };
    tick();
  }
}
