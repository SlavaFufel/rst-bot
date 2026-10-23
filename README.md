# Rust+ Companion Telegram Bot

A Node.js Telegram bot that extends the official Rust+ Companion app. It keeps a 24/7 Rust+ connection per subscriber, relays team, server and base events to Telegram, bridges team chat both ways, controls smart devices and cameras, and adds raid/craft calculators and player intel. Multi-user: each subscriber pairs their own Steam account, with up to 4 family viewers.

> **Rust+ change, 6 Aug 2026:** Facepunch stopped sending map markers over Rust+. Everything built on them was removed from the bot: cargo/heli/CH47/oil rig/Bradley/travelling vendor alerts, vending machine features (`/market`, `/price`, `/deals`, `/pricehistory`, `/watch`) and live markers on `/map`. The old commands still answer with an explanation. Team, time, server info, smart devices, cameras and push notifications are not affected.

---

## Tech Stack

* **Node.js** 22.5+ (ESM, built-in `node:sqlite`)
* **@liamcottle/rustplus.js**: WebSocket and Protobuf wrapper for the Rust+ Companion API
* **@liamcottle/push-receiver**: FCM listener for in-game "Pair with Server" and smart device pairing pushes
* **grammY**: Telegram bot framework
* **jimp**: tactical map rendering (optional, `MAP_RENDER=on`)

---

## Features

### Telegram commands
* **Server:** `/status`, `/time`, `/subscribe` (notification toggles), `/sub`, `/mirror on|off` (copy alerts to team chat), `/say`, `/promote`, `/teamstats`
* **Map and recon:** `/map` (team, oil rigs, recent deaths, in-game map notes, your pins), `/rustmap` (RustMaps link), `/pin`, `/deaths`, `/cam`, `/cams`
* **Raid and RustLabs:** `/raid`, `/durability`, `/craft`, `/recycle`, `/decay`
* **Players:** `/enemy add|stats|list|remove` (dossier via BattleMetrics and Steam), `/check` (VAC/smurf check), `/track`, `/online`
* **Base (smart home):** `/devices`, `/switch`, `/storage`, `/allon`, `/alloff`, `/scene`, `/scenes`, `/onraid` (scene applied when a Smart Alarm fires)
* **Journal:** `/note`, `/notes`, `/delnote`, `/pins`, `/unpin`, `/stats`
* **Subscription and pairing:** `/redeem`, `/pair`, `/rebind`, `/repair`, `/family`, `/join`, `/leave`
* **Admin:** `/genkey`, `/keys`, `/revoke`

### In-game team chat commands
`!pop` `!time` `!online` `!team` `!teamstats` `!playtime-all` `!afktime-all` `!deaths` `!promote` `!wipe` `!raid` `!durability` `!craft` `!recycle` `!decay` `!check` `!help`

### Notifications
Team join/leave/death/respawn/AFK, Smart Alarm (raid alarm), upkeep running out, friends and enemies online, wipe, server down/up, day/night and "night soon".

---

## Project Structure

* `src/`
  * `index.js`: entry point, wires sessions, bot, FCM listener, ingest server and scheduler
  * `config.js`: environment variables
  * `core/eventbus.js`: event names and subscribable notification types
  * `access/`: access gate and user settings (language, mirror)
  * `billing/`: license keys and subscription expiry
  * `pair/`: pairing codes, FCM listener, ingest endpoint for the `helper/` pairing app
  * `rust/`
    * `client.js`: Rust+ client wrapper (reconnects, promisified requests)
    * `session.js`, `sessionManager.js`: one live Rust+ connection per subscriber
    * `poller.js`: polls team, server info and time, emits events, tracks team stats
    * `chat.js`: two-way team chat bridge
    * `ingameCommands.js`: `!` commands in team chat
    * `maprender.js`: tactical map PNG
  * `devices/`: paired smart devices and scenes
  * `enemy/`: BattleMetrics, A2S and Steam lookups, enemy store and analytics
  * `features/`: cameras and journal (notes, pins)
  * `telegram/`: bot commands, notifier, formatters, `/help`, i18n (RU/EN)
  * `tracking/steam.js`: Steam friend online tracking
  * `scheduler.js`: upkeep (decay) monitor
  * `util/`: grid math, item names, RustLabs data, raid calculator
* `helper/`: Windows pairing helper (`rst-pair.exe`)
* `deploy/`: deployment guides (Oracle, GCP, JustHost, Windows PC)

---

## Important Notes

1. **Steam account:** the bot writes to team chat as the paired Steam account. Messages are prefixed so teammates know they are automated.
2. **24/7 session:** the token stays valid without the game running, as long as the account stays in the team on the server.
3. **App conflict:** running the official Rust+ mobile app on the same account can occasionally cause brief disconnects or missed pairing pushes.
4. **Wipes:** after a wipe or if the team disbands, re-join the team in-game and press "Pair with Server" again. The bot picks it up automatically.
