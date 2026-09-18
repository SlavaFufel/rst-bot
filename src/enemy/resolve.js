import { config } from '../config.js';
import { log } from '../logger.js';
import * as sessions from '../store/sessions.js';
import { searchServer } from './battlemetrics.js';

// Resolve a user's BattleMetrics server id automatically from their paired
// server IP (cached in rust_sessions.bm_server_id), so customers never enter it.
// Falls back to the operator's BM_SERVER_ID override, else null.
export async function resolveBmServerId(ownerId) {
  const cached = sessions.getBmServerId(ownerId);
  if (cached) return cached;

  const row = sessions.getByOwner(ownerId);
  if (row?.ip) {
    try {
      const found = await searchServer(row.ip, { token: config.battlemetrics.token });
      // Prefer the highest-population Rust server at that IP.
      const best = found.sort((a, b) => (b.players ?? 0) - (a.players ?? 0))[0];
      if (best) {
        sessions.setBmServerId(ownerId, best.id);
        log.info(`Resolved BattleMetrics server for ${ownerId}: ${best.name} (${best.id})`);
        return best.id;
      }
    } catch (err) {
      log.warn('resolveBmServerId failed:', err.message);
    }
  }
  return config.battlemetrics.serverId || null;
}
