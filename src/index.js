import { log } from './logger.js';
import { config } from './config.js';
import { SessionManager } from './rust/sessionManager.js';
import { SteamTracker } from './tracking/steam.js';
import { EnemyTracker } from './enemy/index.js';
import { Scheduler } from './scheduler.js';
import { createBot } from './telegram/bot.js';
import { createNotifier } from './telegram/notifier.js';
import { FcmListenerManager } from './pair/fcm-listener.js';
import { startIngest } from './pair/ingest.js';
import { seedOperator } from './pair/seed.js';
import { seedAdmin } from './access/gate.js';
import { upsertDevice } from './devices/store.js';
import { isAdmin, langOf } from './access/users.js';
import { L } from './telegram/i18n.js';
import { checkAndBind } from './billing/licenses.js';
import { SubscriptionService } from './billing/subscriptions.js';

process.on('uncaughtException', (err) => {
  log.warn('Uncaught exception (non-fatal):', err.message);
});

process.on('unhandledRejection', (reason) => {
  log.warn('Unhandled rejection (non-fatal):', reason?.message ?? reason);
});

async function main() {
  // Seed the first admin, then the operator's FCM pairing + live server
  // connection from existing rustplus.config.json / .env.
  seedAdmin();
  seedOperator();

  // bot is referenced by the manager's notify() closure; declared first.
  let bot;
  const sessionManager = new SessionManager({
    notify: (telegramId, text) => bot?.api.sendMessage(telegramId, text).catch(() => {}),
    // Enforce 1 subscription = 1 account (admins bypass).
    canPair: (telegramId, playerId) => checkAndBind(telegramId, playerId, { isAdmin: isAdmin(telegramId) }),
  });

  bot = createBot({ sessions: sessionManager });
  createNotifier(bot, sessionManager);

  const steam = new SteamTracker();
  const enemy = new EnemyTracker();
  const scheduler = new Scheduler(sessionManager);
  const subscriptions = new SubscriptionService({
    sessionManager,
    notify: (telegramId, text) => bot?.api.sendMessage(telegramId, text).catch(() => {}),
  });

  // FCM listener: in-game "Pair with Server" pushes drive session creation /
  // hot-swap / account-switch detection through the manager.
  const fcm = new FcmListenerManager({
    onServerPairing: (telegramId, pairing) => sessionManager.upsertPairing(telegramId, pairing),
    onEntityPairing: (telegramId, entity) => {
      upsertDevice(telegramId, { entityId: entity.entityId, type: entity.entityType, name: entity.name });
      bot?.api
        .sendMessage(
          telegramId,
          L(
            langOf(telegramId),
            `🔌 Устройство привязано: ${entity.name || 'без имени'} (id ${entity.entityId}). Список: /devices`,
            `🔌 Device paired: ${entity.name || 'unnamed'} (id ${entity.entityId}). List: /devices`,
          ),
        )
        .catch(() => {});
    },
  });

  // Ingest endpoint: desktop helper uploads FCM creds, keyed by a /pair code.
  const ingestServer = startIngest({
    fcmListener: fcm,
    notify: (telegramId, text) => bot?.api.sendMessage(telegramId, text).catch(() => {}),
    port: config.ingest.port,
  });

  sessionManager.init(); // create + start a session per stored pairing
  scheduler.start();
  subscriptions.start();
  steam.start();
  enemy.start();
  await fcm.startAll();

  const shutdown = () => {
    log.info('Shutting down...');
    sessionManager.stopAll();
    steam.stop();
    enemy.stop();
    scheduler.stop();
    subscriptions.stop();
    fcm.stopAll();
    ingestServer.close();
    bot.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await bot.start({ onStart: () => log.info('Telegram bot started') });
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
