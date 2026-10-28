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
* **Map and recon:** `/map` (team, oil rigs, recent deaths, in-game map notes, your pins), `/rustmap` (RustMaps link), `/whereis` (monument grid), `/pin`, `/deaths`, `/cam`, `/cams`
* **Raid and RustLabs:** `/raid`, `/durability`, `/craft`, `/recycle`, `/decay`
* **Players:** `/enemy add|stats|list|remove` (dossier via BattleMetrics and Steam), `/check` (VAC/smurf check), `/track`, `/online`
* **Base (smart home):** `/devices`, `/switch`, `/storage`, `/find` (item search across all Storage Monitors), `/allon`, `/alloff`, `/scene`, `/scenes`, `/onraid` (scene applied when a Smart Alarm fires), `/auto` (automations, see below)
* **Journal:** `/note`, `/notes`, `/delnote`, `/pins`, `/unpin`, `/stats`
* **Subscription and pairing:** `/buy`, `/redeem`, `/pair`, `/rebind`, `/repair`, `/family`, `/join`, `/leave`, `/paysupport`
* **Admin:** `/genkey`, `/keys`, `/revoke`, `/payments`, `/refund`

### Selling subscriptions (Telegram Stars)
`/buy` shows the plans from `STARS_PLANS` (default `30:300,90:800`, i.e. days:Stars) and sends a Stars invoice. No payment provider or merchant account is needed. A payment extends the active subscription, keeping the bound Rust account, or starts a new one, and un-freezes a lapsed session. The plan and price are re-checked at checkout, so an old invoice can't be paid after a price change. Payments are stored in the `payments` table. The admin gets a message per sale and can refund with `/refund «charge_id»`, which returns the Stars and removes the paid days. Subscribers get a renewal reminder 3 days before expiry. `/paysupport` answers payment questions, as Telegram requires for bots that sell for Stars. Set `STARS_PLANS=off` to hide `/buy` and sell keys only.

### In-game team chat commands
`!pop` `!time` `!online` `!team` `!locate` `!nearby` `!whereis` `!find` `!teamstats` `!playtime-all` `!afktime-all` `!deaths` `!promote` `!wipe` `!raid` `!durability` `!craft` `!recycle` `!decay` `!check` `!help`

### Automations (`/auto`)
Rules that drive smart switches on their own. A target is a switch id from `/devices` or a device name; a name addresses every switch paired under it, so it works as a group.
* `/auto night «switch» [off]`: ON at night, OFF by day (lights)
* `/auto offline «switch» [min] [off]`: ON once the whole team has been offline for N minutes (default 1), OFF when anyone is back (SAM sites, turrets)
* `/auto online «switch» [off]`: ON while anyone in the team is online
* `/auto timer «switch» «on_min» «off_min»`: repeating ON/OFF cycle (farm watering)
* `/auto del|pause|resume «id»`; `/auto` alone lists the rules

`off` inverts a rule (OFF instead of ON). New rules are applied to the current state right away, and every rule is re-synced after a reconnect. Night/offline/online actions send an "Automations" notification (toggle in `/subscribe`); timer cycles stay silent. Up to 20 rules per owner.

### Notifications
Team join/leave/death/respawn/AFK, Smart Alarm (raid alarm), automations, upkeep running out, friends and enemies online, wipe, server down/up, day/night and "night soon".

---

## Project Structure

* `src/`
  * `index.js`: entry point, wires sessions, bot, FCM listener, ingest server and scheduler
  * `config.js`: environment variables
  * `core/eventbus.js`: event names and subscribable notification types
  * `access/`: access gate and user settings (language, mirror)
  * `billing/`: license keys, Telegram Stars payments, subscription expiry and renewal reminders
  * `pair/`: pairing codes, FCM listener, ingest endpoint for the `helper/` pairing app
  * `rust/`
    * `client.js`: Rust+ client wrapper (reconnects, promisified requests)
    * `session.js`, `sessionManager.js`: one live Rust+ connection per subscriber
    * `poller.js`: polls team, server info and time, emits events, tracks team stats
    * `chat.js`: two-way team chat bridge
    * `ingameCommands.js`: `!` commands in team chat
    * `maprender.js`: tactical map PNG
  * `devices/`: paired smart devices, scenes, automation rules and the engine that applies them
  * `enemy/`: BattleMetrics, A2S and Steam lookups, enemy store and analytics
  * `features/`: cameras, journal (notes, pins), storage search
  * `telegram/`: bot commands, notifier, formatters, `/help`, i18n (RU/EN)
  * `tracking/steam.js`: Steam friend online tracking
  * `scheduler.js`: upkeep (decay) monitor
  * `util/`: grid math, item and monument names, RustLabs data, raid calculator
* `helper/`: Windows pairing helper (`rst-pair.exe`)
* `deploy/`: deployment guides (Oracle, GCP, JustHost, Windows PC)

---

## Important Notes

1. **Steam account:** the bot writes to team chat as the paired Steam account. Messages are prefixed so teammates know they are automated.
2. **24/7 session:** the token stays valid without the game running, as long as the account stays in the team on the server.
3. **App conflict:** running the official Rust+ mobile app on the same account can occasionally cause brief disconnects or missed pairing pushes.
4. **Wipes:** after a wipe or if the team disbands, re-join the team in-game and press "Pair with Server" again. The bot picks it up automatically.
