# Rust+ Companion Telegram Bot

A Node.js bot for a small group of players (~10 people on a single server). It expands the functionality of the official Rust+ Companion app by relaying server events to Telegram, bridging team chat with TG, and helping monitor the map.

> **Note:** The project is currently a working prototype (skeleton). Connection, server polling, two-way chat, and basic Telegram admin features are fully functional. Advanced features (enemy tracking, smart devices, cameras, markets) are currently placeholders with TODOs in the code.

---

## Tech Stack

* **Node.js** (v18+, ESM)
* **@liamcottle/rustplus.js** — WebSocket & Protobuf wrapper for Rust+ Companion API
* **grammY** — Telegram bot framework
* **better-sqlite3** — Local SQLite database for settings and subscriptions

---

## Bot Commands

### From Telegram
* `/start`, `/help`, `/status` — Health check and help info *(Working)*
* `/subscribe` — Event notification settings *(Working)*
* `/say [text]` — Send a message to the in-game team chat *(Working)*
* `/team`, `/online`, `/track` — Team and online status info *(In progress)*
* `/enemy`, `/raidwindow` — Enemy player and raid tracking *(Placeholder)*
* `/shop`, `/watch`, `/market` — Vending machine monitoring *(Placeholder)*
* `/devices`, `/switch`, `/scene`, `/cam` — Smart switches, electronics, and cameras *(Placeholder)*

### From In-Game Team Chat
*(Parser is ready, command handlers are in progress)*
* `!cargo`, `!heli`, `!time`, `!pop`, `!help`

---

## Project Structure

* `src/`
  * `index.js` — Entry point, module initialization, and setup
  * `config.js` — Environment variables loading and validation
  * `logger.js` — Logging utility
  * `core/`
    * `eventbus.js` — Internal application event bus
    * `dedup.js` — Deduplication logic to prevent notification spam
  * `store/`
    * `db.js` — SQLite database initialization and schema
  * `util/`
    * `grid.js` — Coordinate conversion to map grid (e.g., D7)
  * `rust/`
    * `client.js` — Rust+ client wrapper (reconnects, promisified methods)
    * `poller.js` — Polling loop for map markers, team status, and time
    * `markers.js` — Map marker parser & diffing (cargo, heli, vending machines)
    * `chat.js` — Two-way chat bridge between game and Telegram
  * `telegram/`
    * `bot.js` — grammY bot setup, whitelist authorization, command handlers
    * `notifier.js` — Event router to Telegram subscribers
    * `format.js` — Message formatting templates for Telegram
  * `tracking/`
    * `steam.js` — Steam Web API integration for friend tracking
  * `enemy/` — Enemy tracking logic *(Placeholder)*
  * `scheduler.js` — Scheduled time events *(Placeholder)*

---

## Important Notes

1. **Steam Authentication:** The bot sends messages to team chat on behalf of your main Steam account. Messages are prefixed with so teammates know they are automated.
2. **24/7 Session:** The token stays active continuously without requiring your main client to be online, as long as you remain in the team on the server.
3. **App Conflict:** Running the official Rust+ mobile app simultaneously using the same account creates a secondary connection. It usually works fine, but may occasionally cause brief disconnects.
4. **Wipes:** When a server wipes or the team disbands, you must re-join the team in-game and re-pair if necessary (`npm run pair`).