import { createServer } from 'node:http';
import { log } from '../logger.js';
import { consumeCode } from './codes.js';
import * as pairStore from './store.js';
import { langOf } from '../access/users.js';
import { L } from '../telegram/i18n.js';

const MAX_BODY = 16 * 1024;

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function hasShape(d) {
  return (
    d?.fcm_credentials?.gcm?.androidId &&
    d?.fcm_credentials?.gcm?.securityToken &&
    d?.fcm_credentials?.fcm?.token &&
    d?.expo_push_token &&
    d?.rustplus_auth_token
  );
}

// Receives FCM credentials from the desktop helper, authenticated by a single-use
// pair code (Bearer). Binds to a Telegram account and starts that user's listener.
// Binds to localhost only — exposure is via a Cloudflare Tunnel, not an open port.
export function startIngest({ fcmListener, notify, port = 8787 }) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/pair/ingest')) {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }

    const auth = req.headers['authorization'] || '';
    const code = auth.startsWith('Bearer ') ? auth.slice(7).trim().toUpperCase() : '';

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooBig) return send(res, 413, { ok: false, error: 'body too large' });

      const telegramId = consumeCode(code);
      if (!telegramId) return send(res, 401, { ok: false, error: 'invalid or expired code' });

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      if (!hasShape(data)) return send(res, 400, { ok: false, error: 'missing fields' });

      try {
        pairStore.upsertPairing(telegramId, {
          fcm_credentials: data.fcm_credentials,
          expo_push_token: data.expo_push_token,
          rustplus_auth_token: data.rustplus_auth_token,
        });
        fcmListener.startForUser(telegramId);
        notify?.(
          telegramId,
          L(
            langOf(telegramId),
            '✅ Привязка готова. Теперь зайди на сервер в игре и нажми «Pair with Server».',
            '✅ Pairing ready. Now join the server in game and press "Pair with Server".',
          ),
        );
        log.info(`Ingest: stored pairing for user ${telegramId}`);
        return send(res, 200, { ok: true });
      } catch (err) {
        log.warn('Ingest store failed:', err.message);
        return send(res, 500, { ok: false, error: 'server error' });
      }
    });
  });

  server.on('error', (err) => log.warn('Ingest server error:', err.message));
  server.listen(port, '127.0.0.1', () => log.info(`Pair ingest listening on 127.0.0.1:${port}`));
  return server;
}
