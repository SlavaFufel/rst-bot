import dgram from 'node:dgram';

// Valve A2S server queries (A2S_INFO, A2S_PLAYER) over UDP. Rust servers answer
// on their query port with the current player list: names and time connected,
// no SteamIDs. This is the public data BattleMetrics is built on, and it needs
// no API key. https://developer.valvesoftware.com/wiki/Server_queries

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQ = Buffer.concat([HEADER, Buffer.from([0x54]), Buffer.from('Source Engine Query\0')]);
const PLAYER_REQ = Buffer.concat([HEADER, Buffer.from([0x55, 0xff, 0xff, 0xff, 0xff])]);
const S2C_CHALLENGE = 0x41;
const S2A_INFO = 0x49;
const S2A_PLAYER = 0x44;
const DEFAULT_TIMEOUT_MS = 3000;

// The server answers queries but keeps its player list to itself.
export class HiddenError extends Error {
  constructor() {
    super('A2S: server hides its player list');
    this.hidden = true;
  }
}

// Sends one request and resolves with the reassembled response payload (starting
// at the 0xFFFFFFFF header), or rejects on timeout.
function exchange(ip, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const parts = new Map();
    let total = 0;
    const done = (err, buf) => {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(buf);
    };
    const timer = setTimeout(() => done(new Error(`A2S timeout ${ip}:${port}`)), timeoutMs);

    socket.on('error', (err) => done(err));
    socket.on('message', (msg) => {
      if (msg.length < 5) return;
      const kind = msg.readInt32LE(0);
      if (kind === -1) return done(null, msg); // single packet
      if (kind !== -2) return;
      // Split response (Source format): header, id, total, number, size, payload.
      if (msg.length < 12) return;
      total = msg[8];
      parts.set(msg[9], msg.subarray(12));
      if (parts.size === total) {
        const ordered = [];
        for (let i = 0; i < total; i += 1) ordered.push(parts.get(i));
        if (ordered.some((p) => !p)) return done(new Error('A2S split packet missing'));
        done(null, Buffer.concat(ordered));
      }
    });
    socket.send(payload, port, ip);
  });
}

// Runs a request, answering a challenge if the server sends one first.
async function request(ip, port, payload, { timeoutMs = DEFAULT_TIMEOUT_MS, challengeAt } = {}) {
  let res = await exchange(ip, port, payload, timeoutMs);
  if (res[4] === S2C_CHALLENGE && res.length >= 9) {
    const challenge = res.subarray(5, 9);
    let withChallenge;
    if (challengeAt != null) {
      withChallenge = Buffer.from(payload);
      challenge.copy(withChallenge, challengeAt);
    } else {
      withChallenge = Buffer.concat([payload, challenge]);
    }
    res = await exchange(ip, port, withChallenge, timeoutMs);
    // Some servers answer every request with a fresh challenge to hide the data.
    if (res[4] === S2C_CHALLENGE) throw new HiddenError();
  }
  return res;
}

class Reader {
  constructor(buf, offset) {
    this.buf = buf;
    this.o = offset;
  }
  byte() {
    return this.buf[this.o++];
  }
  short() {
    const v = this.buf.readInt16LE(this.o);
    this.o += 2;
    return v;
  }
  long() {
    const v = this.buf.readInt32LE(this.o);
    this.o += 4;
    return v;
  }
  float() {
    const v = this.buf.readFloatLE(this.o);
    this.o += 4;
    return v;
  }
  string() {
    let end = this.buf.indexOf(0, this.o);
    if (end < 0) end = this.buf.length;
    const s = this.buf.toString('utf8', this.o, end);
    this.o = end + 1;
    return s;
  }
  get left() {
    return this.buf.length - this.o;
  }
}

// { name, map, players, maxPlayers }
export async function queryInfo(ip, port, opts = {}) {
  const res = await request(ip, port, INFO_REQ, opts);
  if (res[4] !== S2A_INFO) throw new Error('A2S_INFO: unexpected reply');
  const r = new Reader(res, 6); // header(4) + type(1) + protocol(1)
  const name = r.string();
  const map = r.string();
  r.string(); // folder
  r.string(); // game
  r.short(); // app id
  const players = r.byte();
  const maxPlayers = r.byte();
  return { name, map, players, maxPlayers };
}

// [{ name, durationSec }] — players currently connected. Nameless entries
// (still loading in) are dropped.
export async function queryPlayers(ip, port, opts = {}) {
  const res = await request(ip, port, PLAYER_REQ, { ...opts, challengeAt: 5 });
  if (res[4] !== S2A_PLAYER) throw new Error('A2S_PLAYER: unexpected reply');
  const r = new Reader(res, 5);
  const count = r.byte();
  const out = [];
  for (let i = 0; i < count && r.left > 0; i += 1) {
    r.byte(); // index
    const name = r.string().trim();
    r.long(); // score
    const durationSec = Math.max(0, Math.round(r.float()));
    if (name) out.push({ name, durationSec });
  }
  return out;
}

// The Rust+ app port is usually game port + 67 and the query port game port + 1,
// but hosts vary; try the likely candidates and return the first that answers.
export function queryPortCandidates(appPort) {
  const game = appPort - 67;
  const list = [game + 1, game, game + 2, appPort + 1, appPort - 1, 28016, 28015, 28017];
  return [...new Set(list.filter((p) => p > 0 && p < 65536))];
}

export async function findQueryPort(ip, appPort, opts = {}) {
  for (const port of queryPortCandidates(appPort)) {
    try {
      const info = await queryInfo(ip, port, { timeoutMs: 1500, ...opts });
      return { port, info };
    } catch {
      // try the next candidate
    }
  }
  return null;
}
