import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function parseIds(raw) {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

export const config = Object.freeze({
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    allowedIds: parseIds(optional('ALLOWED_TELEGRAM_IDS')),
    // First admin bootstrap; falls back to the first whitelisted id.
    adminId: Number(optional('ADMIN_TELEGRAM_ID')) || parseIds(optional('ALLOWED_TELEGRAM_IDS'))[0] || null,
  },
  rust: {
    // Optional: only the operator's own pairing seed. Customers pair via the
    // helper, so a product deploy can run without any RUST_* set.
    ip: optional('RUST_SERVER_IP'),
    port: Number(optional('RUST_SERVER_PORT')) || undefined,
    playerId: optional('RUST_PLAYER_ID'),
    playerToken: Number(optional('RUST_PLAYER_TOKEN')) || undefined,
    serverId: optional('RUST_SERVER_ID'),
  },
  steam: {
    apiKey: optional('STEAM_API_KEY'),
  },
  ingest: {
    port: Number(optional('INGEST_PORT')) || 8787,
    publicUrl: optional('PUBLIC_INGEST_URL'), // Cloudflare Tunnel HTTPS URL for the helper
  },
  helper: {
    url: optional('HELPER_DOWNLOAD_URL'), // where users download the pairing helper
  },
  battlemetrics: {
    token: optional('BATTLEMETRICS_TOKEN'),
    serverId: optional('BM_SERVER_ID'),
  },
  analytics: {
    // Local timezone offset for enemy activity heatmaps (default MSK +3).
    tzOffset: Number(optional('TZ_OFFSET_HOURS')) || 3,
  },
  map: {
    // Render the tactical map PNG (jimp). Memory-heavy — off by default so a 1 GB
    // box fits more concurrent sessions; /map then lists live markers as text +
    // a RustMaps link. Set MAP_RENDER=on once you have RAM headroom (≥2 GB).
    render: optional('MAP_RENDER', 'off').toLowerCase() === 'on',
  },
  dbPath: optional('DB_PATH', './data/bot.db'),
  poll: {
    markersMs: 5_000,
    teamMs: 10_000,
    infoMs: 60_000,
    timeMs: 60_000,
    steamMs: 60_000,
  },
});
