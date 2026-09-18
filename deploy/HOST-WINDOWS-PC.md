# Хостинг бота 24/7 на своём ПК (Windows)

Полный пошаговый гайд: как поднять бота на втором/домашнем Windows-ПК так, чтобы он
работал круглосуточно, сам перезапускался при сбое и сам поднимался после
перезагрузки компа.

> Требования к железу: ~1 ГБ свободной RAM на бота (с включённым рендером карты —
> ближе к 2 ГБ). 16 ГБ — с огромным запасом. Нужен **стабильный интернет** (бот
> держит постоянные соединения с Telegram и Rust+; при обрыве переподключается сам).

---

## Что понадобится (один раз собрать)

| Что | Где взять |
|-----|-----------|
| **Node.js 24 LTS** | https://nodejs.org → кнопка LTS (24.x). Нужен ≥ 22.5, но на 24 `node:sqlite` работает без флагов — бери 24. |
| **Git** (опц., для обновлений) | https://git-scm.com/download/win |
| **Токен Telegram-бота** | @BotFather → `/newbot` → скопировать токен |
| **Свой Telegram ID** | @userinfobot → пишет твой numeric id |
| **Steam Web API key** | https://steamcommunity.com/dev/apikey (нужен для `/online`, `/enemy`, `/check`) |
| **Привязка Rust+** | данные сервера (ip/port/playerId/playerToken) — см. шаг 5 |
| **BattleMetrics token** | опц., для heatmap врагов |

---

## Шаг 1. Установить Node.js 24 LTS

1. Скачай LTS-инсталлятор с https://nodejs.org и установи (галочки по умолчанию).
2. Проверь в **PowerShell**:
   ```powershell
   node -v   # должно быть v24.x.x (или ≥ v22.5)
   npm -v
   ```
   Если `node` не распознан — перезапусти PowerShell (или перелогинься), PATH
   обновляется после установки.

---

## Шаг 2. Получить код бота на этот ПК

**Вариант А — через Git (рекомендую, удобно обновлять):**
```powershell
cd $HOME
git clone <URL-твоего-репозитория> rst
cd rst
```
Если репозиторий приватный — Git попросит логин/Personal Access Token (GitHub →
Settings → Developer settings → PAT).

**Вариант Б — просто скопировать папку** (флешка / сетевая шара / архив):
скопируй всю папку `rst` с рабочего ПК, **но без** `node_modules` (её пересоздаст
`npm install`). Файл `.env` скопировать **можно и нужно** — в нём вся конфигурация.

---

## Шаг 3. Установить зависимости

В папке бота:
```powershell
npm install
```
Это поставит зависимости и автоматически прогонит `postinstall` (патч proto для
Rust+). Дождись завершения без красных ошибок (warnings — норм).

---

## Шаг 4. Настроить `.env`

Если скопировал рабочий `.env` с другого ПК — он уже готов, переходи к шагу 6
(пропусти привязку). Если делаешь с нуля — создай файл `.env` в корне папки:

```env
# --- Telegram ---
TELEGRAM_BOT_TOKEN=сюда_токен_от_BotFather
# Через запятую — кому можно пользоваться ботом. Первый id = админ.
ALLOWED_TELEGRAM_IDS=твой_telegram_id
ADMIN_TELEGRAM_ID=твой_telegram_id

# --- Привязка Rust-сервера (см. шаг 5) ---
RUST_SERVER_IP=
RUST_SERVER_PORT=
RUST_PLAYER_ID=
RUST_PLAYER_TOKEN=
RUST_SERVER_ID=

# --- Опционально ---
STEAM_API_KEY=сюда_steam_api_key
BATTLEMETRICS_TOKEN=
BM_SERVER_ID=

# --- Хранилище ---
DB_PATH=./data/bot.db

# --- Карта ---
# Рендер картинки /map (jimp, ест RAM). На домашнем ПК с 16 ГБ — включай.
MAP_RENDER=on
```

> Файл `.env` — это секреты. Он уже в `.gitignore`, не коммить его и не выкладывай.

---

## Шаг 5. Привязать Rust+ (если ещё не привязан)

Привязка нужна один раз на аккаунт. Самый простой путь на этом же ПК:

1. Зарегистрировать FCM + войти в Steam (откроется браузер):
   ```powershell
   npm run pair
   ```
   Войди в Steam в открывшемся окне. Создастся `rustplus.config.json`.
2. Поймать данные сервера:
   ```powershell
   npm run pair:listen
   ```
   Теперь зайди в Rust на нужный сервер → **Esc → Rust+ → Pair with Server**.
   В консоли появятся `playerId`, `playerToken`, `ip`, `port`.
3. Впиши их в `.env` (`RUST_PLAYER_ID`, `RUST_PLAYER_TOKEN`, `RUST_SERVER_IP`,
   `RUST_SERVER_PORT`) и закрой `pair:listen` (Ctrl+C).

> Токен живёт на игровом сервере, а не в запущенном Steam — после привязки бот
> работает 24/7, даже когда ты не в игре. Сменишь сервер — снова нажми Pair (бот
> переедет сам). После вайпа токен сбивается → просто нажми Pair снова.

---

## Шаг 6. Тестовый запуск (проверка перед 24/7)

```powershell
npm start
```
Ожидаемо в консоли: `Rust+ connected`, `Server info loaded`, `SessionManager … started`.
В Telegram напиши боту `/start`, затем `/status` — должен ответить онлайном сервера.

Останови тест: **Ctrl+C**. Дальше делаем автозапуск.

---

## Шаг 7. Запуск 24/7 (автостарт + автоперезапуск)

Выбери **один** из вариантов. Рекомендую **A (NSSM)** — это настоящая служба
Windows: переживает перезагрузку, стартует ещё до входа в систему, сама поднимает
бот после краша. Вариант **B (PM2)** — удобнее логи/мониторинг, но автозапуск при
ребуте надо настроить отдельно.

### Вариант A — NSSM (служба Windows, надёжнее всего) ✅

1. Скачай NSSM с https://nssm.cc/download (бери `nssm-2.24`), распакуй,
   возьми `win64\nssm.exe` (положи, например, в `C:\nssm\nssm.exe`).
2. Открой PowerShell **от администратора** и создай службу. Подставь свои пути
   (`<ПУТЬ_К_NODE>` обычно `C:\Program Files\nodejs\node.exe`, `<ПАПКА_БОТА>` —
   твоя папка `rst`):
   ```powershell
   C:\nssm\nssm.exe install RustBot "C:\Program Files\nodejs\node.exe" "src\index.js"
   C:\nssm\nssm.exe set RustBot AppDirectory "C:\Users\Слава\rst"
   C:\nssm\nssm.exe set RustBot AppStdout   "C:\Users\Слава\rst\logs\out.log"
   C:\nssm\nssm.exe set RustBot AppStderr   "C:\Users\Слава\rst\logs\err.log"
   C:\nssm\nssm.exe set RustBot Start SERVICE_AUTO_START
   C:\nssm\nssm.exe set RustBot AppExit Default Restart
   C:\nssm\nssm.exe set RustBot AppRestartDelay 5000
   ```
   (Папку `logs` создай заранее: `mkdir "C:\Users\Слава\rst\logs"`.)
3. Запусти:
   ```powershell
   C:\nssm\nssm.exe start RustBot
   ```
4. Проверь: `Get-Service RustBot` → Status `Running`. Логи — в `logs\out.log` /
   `logs\err.log`.

Управление потом:
```powershell
C:\nssm\nssm.exe restart RustBot   # после обновления/правки .env
C:\nssm\nssm.exe stop RustBot
C:\nssm\nssm.exe remove RustBot confirm   # удалить службу
```

### Вариант B — PM2 (live-мониторинг и логи)

```powershell
npm install -g pm2
pm2 start src/index.js --name rst-bot
pm2 logs rst-bot          # живые логи (Ctrl+C — выйти, бот продолжит)
pm2 save                  # запомнить список процессов

# автозапуск при загрузке Windows:
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```
Полезное: `pm2 status`, `pm2 restart rst-bot`, `pm2 monit`.
> На Windows автостарт PM2 при ребуте иногда капризничает. Если важна
> железобетонная живучесть после перезагрузок — бери NSSM.

---

## Шаг 8. Чтобы ПК НЕ засыпал (критично для 24/7)

Спящий ПК = мёртвый бот. Отключи сон:

- **Через настройки:** Параметры → Система → Питание → «Экран и спящий режим» →
  «Перевод в спящий режим при питании от сети» = **Никогда**.
- **Или одной командой** (PowerShell от админа):
  ```powershell
  powercfg /change standby-timeout-ac 0   # не засыпать (от сети)
  powercfg /change monitor-timeout-ac 0   # (опц.) не гасить монитор
  powercfg /hibernate off                 # выключить гибернацию
  ```
- Если это **ноутбук** — в питании от батареи тоже поставь «Никогда», и держи на
  зарядке. При закрытии крышки: Питание → «Действие при закрытии крышки» = «Ничего
  не делать» (от сети).

**Windows Update** иногда перезагружает ПК. Это ок: служба (вариант A) сама
поднимет бот после ребута. Чтобы перезагрузки были предсказуемы — задай
«Период активности» (Параметры → Центр обновления → Дополнительно).

---

## Шаг 9. Обновление бота

```powershell
cd C:\Users\Слава\rst
git pull                  # или скопируй новые файлы
npm install               # если менялись зависимости
# затем перезапусти службу/процесс:
C:\nssm\nssm.exe restart RustBot     # (вариант A)
# или
pm2 restart rst-bot                   # (вариант B)
```
После правки `.env` тоже нужен restart — переменные читаются только при старте.

---

## Диагностика

| Симптом | Что смотреть |
|---------|--------------|
| Бот не отвечает в TG | логи (`logs\err.log` или `pm2 logs`); жив ли процесс/служба; верный ли `TELEGRAM_BOT_TOKEN` |
| `/status` → «нет сессии» | привязка Rust+ (шаг 5); в логе должно быть `Rust+ connected` |
| `/map` шлёт ссылку вместо картинки | `MAP_RENDER=on` в `.env` + restart |
| Бот замолчал ночью | ПК уснул — см. шаг 8 |
| После ребута не поднялся | служба не на `SERVICE_AUTO_START` (вариант A) или PM2-startup не настроен (вариант B) |
| `node:sqlite` ошибка при старте | версия Node < 22.5 — поставь Node 24 LTS |

Проверка «живой ли бот» прямо из Telegram: `/status`, `/markers` (живые маркеры карты).

---

## (Опционально) Для продукта по подписке — приём привязки от клиентов

Если продаёшь подписки и клиенты привязываются через помощник (`.exe`), боту нужен
HTTPS-вход для приёма их данных (`/pair/ingest`). Не открывай порт наружу — подними
**Cloudflare Tunnel** (бесплатно, без белого IP и проброса портов):

1. Установи `cloudflared` (https://github.com/cloudflare/cloudflared/releases, win64).
2. Запусти туннель на локальный порт ingest (по умолчанию 8787):
   ```powershell
   cloudflared tunnel --url http://localhost:8787
   ```
   Он выдаст публичный `https://…trycloudflare.com` адрес.
3. Впиши его в `.env` как `PUBLIC_INGEST_URL=…` и вшей в помощник
   (`helper/src/ingest-url.txt`), пересобери помощник.
4. Для постоянного адреса — заведи именованный туннель Cloudflare и оформи его тоже
   службой (NSSM), как бота.

Для **личного** использования (только ты и твоя тима через `/join`) это **не нужно** —
ingest требуется лишь для онбординга сторонних платящих юзеров.

---

## Памятка одной строкой

Node 24 → `npm install` → заполнить `.env` (+ `MAP_RENDER=on`) → привязать Rust+ →
`npm start` (проверить) → завернуть в **NSSM-службу** с автозапуском → **отключить
сон ПК**. Готово — бот живёт 24/7 и сам встаёт после ребута.
