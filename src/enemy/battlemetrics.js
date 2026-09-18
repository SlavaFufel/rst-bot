// BattleMetrics client. Docs: https://www.battlemetrics.com/developers/documentation
// JSON:API. Player search works unauthenticated (rate-limited); session history
// needs a bearer token (config.battlemetrics.token). Limit: ~5 req/s.

const BASE = 'https://api.battlemetrics.com';

function headers(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function get(url, token) {
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 401 || res.status === 403) {
    throw new Error('BattleMetrics: нужен валидный API-токен (BATTLEMETRICS_TOKEN).');
  }
  if (res.status === 429) throw new Error('BattleMetrics: слишком много запросов, попробуй позже.');
  if (!res.ok) throw new Error(`BattleMetrics: HTTP ${res.status}`);
  return res.json();
}

// Resolve a SteamID64 to BattleMetrics players via the quick-match endpoint
// (filter[search] does NOT match Steam IDs — only names). Returns [{ id, name }].
export async function quickMatchSteamId(steamId, { token } = {}) {
  const res = await fetch(`${BASE}/players/quick-match?include=player`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: String(steamId) } }] }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('BattleMetrics: нужен валидный API-токен.');
  if (!res.ok) throw new Error(`BattleMetrics: HTTP ${res.status}`);
  const json = await res.json();
  const included = (json.included ?? []).filter((x) => x.type === 'player');
  const src = included.length ? included : (json.data ?? []).filter((x) => x.type === 'player');
  return src.map((p) => ({ id: p.id, name: p.attributes?.name ?? '?' }));
}

// Search players by name, or resolve a SteamID64 via quick-match.
// Returns [{ id, name }] (id = BattleMetrics player id).
export async function searchPlayer(query, { token } = {}) {
  const q = String(query).trim();
  if (/^7656119\d{10}$/.test(q)) {
    const byId = await quickMatchSteamId(q, { token });
    if (byId.length) return byId;
    return []; // a Steam ID won't match the name search below
  }
  const url = new URL(`${BASE}/players`);
  url.searchParams.set('filter[search]', q);
  url.searchParams.set('page[size]', '10');
  const json = await get(url, token);
  return (json.data ?? []).map((p) => ({ id: p.id, name: p.attributes?.name ?? '?' }));
}

// Session history for a player, optionally scoped to one server.
// Returns [{ start, stop }] (ISO strings; stop=null => currently online).
export async function fetchSessions(bmPlayerId, { token, serverId, pageSize = 100 } = {}) {
  const url = new URL(`${BASE}/players/${bmPlayerId}/relationships/sessions`);
  if (serverId) url.searchParams.set('filter[servers]', String(serverId));
  url.searchParams.set('page[size]', String(pageSize));
  const json = await get(url, token);
  return (json.data ?? []).map((s) => ({ start: s.attributes?.start ?? null, stop: s.attributes?.stop ?? null }));
}

// Find a Rust server on BattleMetrics by IP (the Rust+ port differs from the
// game/query port, so we match on IP and take the best Rust result).
// Returns [{ id, name, players }].
export async function searchServer(ip, { token } = {}) {
  const url = new URL(`${BASE}/servers`);
  url.searchParams.set('filter[search]', String(ip));
  url.searchParams.set('filter[game]', 'rust');
  url.searchParams.set('page[size]', '10');
  const json = await get(url, token);
  return (json.data ?? []).map((s) => ({
    id: s.id,
    name: s.attributes?.name ?? '?',
    players: s.attributes?.players ?? 0,
  }));
}

// Distinct servers a player has been seen on (from recent sessions), with
// session counts and last-seen — "where else does this enemy play".
export async function playerServers(bmPlayerId, { token, pageSize = 50 } = {}) {
  const url = new URL(`${BASE}/players/${bmPlayerId}/relationships/sessions`);
  url.searchParams.set('include', 'server');
  url.searchParams.set('page[size]', String(pageSize));
  const json = await get(url, token);
  const names = {};
  for (const inc of json.included ?? []) {
    if (inc.type === 'server') names[inc.id] = inc.attributes?.name ?? inc.id;
  }
  const byServer = {};
  for (const s of json.data ?? []) {
    const sid = s.relationships?.server?.data?.id;
    if (!sid) continue;
    if (!byServer[sid]) byServer[sid] = { name: names[sid] || sid, sessions: 0, lastSeen: null };
    byServer[sid].sessions += 1;
    const t = s.attributes?.stop || s.attributes?.start;
    if (t && (!byServer[sid].lastSeen || t > byServer[sid].lastSeen)) byServer[sid].lastSeen = t;
  }
  return Object.values(byServer).sort((a, b) => b.sessions - a.sessions);
}

// True if the player currently has an open session on the server.
export async function isOnline(bmPlayerId, opts = {}) {
  const sessions = await fetchSessions(bmPlayerId, { ...opts, pageSize: 1 });
  return sessions.length > 0 && !sessions[0].stop;
}
