import { config } from '../config.js';
import { getUser, ensureUser, isAdmin, displayName } from './users.js';
import { activeLicenseByUser } from '../billing/licenses.js';
import { ownerForViewer } from '../store/members.js';

// Commands a user without an active subscription may still use. /join is here so
// a fresh teammate (no license yet) can redeem a family invite code.
const PUBLIC_COMMAND = /^\/(start|redeem|sub|help|lang|join)\b/;

// Seed the first admin from ADMIN_TELEGRAM_ID (or the first whitelisted id).
export function seedAdmin() {
  const adminId = config.telegram.adminId;
  if (adminId) ensureUser(adminId, 'admin', 'admin');
}

// Access gate replacing the static whitelist. Admins and whitelisted ids always
// pass (bootstrap); subscribers with an active license pass; everyone else may
// only use the public commands (so they can /redeem a key).
export function createGate() {
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;

    // Always let the first-run language choice through (no message text on a
    // callback query, so it would otherwise fail the public-command check).
    if (ctx.callbackQuery?.data?.startsWith('lang:')) return next();

    const whitelisted = config.telegram.allowedIds.includes(id);
    if (whitelisted || isAdmin(id)) {
      const role = whitelisted && id === config.telegram.allowedIds[0] ? 'admin' : undefined;
      ensureUser(id, displayName(ctx), role ?? getUser(id)?.role ?? 'member');
      return next();
    }

    if (activeLicenseByUser(id)) {
      ensureUser(id, displayName(ctx));
      return next();
    }

    // Family viewers ride on the owner's active subscription.
    const ownerId = ownerForViewer(id);
    if (ownerId != null && activeLicenseByUser(ownerId)) {
      ensureUser(id, displayName(ctx));
      return next();
    }

    if (PUBLIC_COMMAND.test(ctx.message?.text ?? '')) return next();
    return; // no access — drop silently
  };
}
