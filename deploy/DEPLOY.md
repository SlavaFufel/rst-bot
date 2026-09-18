# Полный гайд: от привязки аккаунта до Oracle Cloud (24/7)

Бот — постоянный процесс (WebSocket к Rust + long-polling Telegram). Хостим его как
`systemd`-сервис на бесплатной Linux-VM Oracle. Боту нужны только **исходящие**
соединения — входящие порты открывать не надо.

Обозначения: 🪟 — выполняется локально на Windows, 🐧 — на сервере (Ubuntu).

---

## A. Подготовка (🪟 локально)

1. **Перевыпусти токен бота.** Telegram → @BotFather → `/mybots` → выбрать бота →
   *API Token* → **Revoke current token** → скопировать новый. (Старый засветился — больше не используем.)
2. **Узнай свой Telegram ID.** Напиши @userinfobot — он пришлёт числовой `id`.
   Это значение для `ALLOWED_TELEGRAM_IDS`.
3. Проверь, что код и зависимости на месте:
   ```powershell
   cd C:\Users\Слава\rst
   node -v        # должно быть v18+ (у тебя v24)
   npm install    # если ещё не ставил
   ```

---

## B. Привязка аккаунта к Rust+ (🪟 локально — нужен браузер)

Бот пишет в тимчат от лица **твоего** аккаунта. Пейринг — разовый.

1. Зарегистрируйся в FCM (откроется браузер для входа Steam):
   ```powershell
   npm run pair
   ```
   Войди своим Steam-аккаунтом. В корне проекта появится `rustplus.config.json`.
2. Запусти слушатель уведомлений о сопряжении:
   ```powershell
   npm run pair:listen
   ```
3. **Не закрывая** терминал, зайди в Rust → подключись к своему серверу → открой
   меню (Esc) → раздел **Rust+** → **Pair with Server** (Сопряжение с сервером).
4. В терминале `pair:listen` появится JSON уведомления `type: "server"` с полями:
   `ip`, `port`, `playerId`, `playerToken`, `name`. Выпиши эти значения.
5. Останови слушатель (Ctrl+C).

> `rustplus.config.json` нужен только для FCM-листенера рейд-сигналок (M5). Для текущего
> функционала достаточно четырёх значений выше. Файл — в `.gitignore`, не коммить его.

---

## C. Локальный тест (🪟 — рекомендуется перед деплоем)

Убедимся, что пейринг верный и бот вообще поднимается.

1. Создай `.env`:
   ```powershell
   copy .env.example .env
   notepad .env
   ```
   Заполни:
   ```
   TELEGRAM_BOT_TOKEN=<новый токен>
   ALLOWED_TELEGRAM_IDS=<твой id из @userinfobot>
   RUST_SERVER_IP=<ip из пейринга>
   RUST_SERVER_PORT=<port>
   RUST_PLAYER_ID=<playerId>
   RUST_PLAYER_TOKEN=<playerToken>
   ```
2. Запусти:
   ```powershell
   npm start
   ```
   В логах ждём `Telegram bot started` и `Rust+ connected`.
3. В Telegram напиши боту `/start`, затем `/status` — должна прийти инфа о сервере.
4. Останови (Ctrl+C). Если работает локально — заработает и на сервере.

---

## D. Заливаем код на GitHub (🪟 — приватный репозиторий)

1. На github.com → **New repository** → имя → **Private** → Create (без README).
2. Привяжи и запушь:
   ```powershell
   git remote add origin https://github.com/<логин>/<repo>.git
   git push -u origin main
   ```
3. Для клона приватного репо на сервере понадобится **Personal Access Token**:
   GitHub → Settings → Developer settings → *Fine-grained tokens* → создать токен с
   доступом **read** к этому репо. Сохрани его — пригодится в шаге F.

> Секреты (`.env`, `data/`, `rustplus.config.json`) уже в `.gitignore` и в репозиторий не попадают.
> Альтернатива без GitHub — скопировать папку на сервер через `scp` (без `node_modules`).

---

## E. Создаём VM на Oracle Cloud (Always Free)

1. Зарегистрируйся на <https://cloud.oracle.com> → *Start for free*. Нужна карта для
   верификации (Always Free-ресурсы **не списываются**). Регион выбери поближе к своему
   Rust-серверу.
2. Меню → **Compute → Instances → Create instance**.
3. Настрой:
   - **Image:** Canonical **Ubuntu** 22.04/24.04.
   - **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → 1 OCPU / 6 GB
     (Always Free покрывает до 4 OCPU / 24 GB суммарно).
     Если пишет *Out of host capacity* — попробуй позже/другой AD, либо возьми
     `VM.Standard.E2.1.Micro` (AMD, тоже Always Free — для бота хватит).
   - **SSH keys:** *Generate a key pair for me* → скачай приватный и публичный ключ
     (или загрузи свой публичный). **Сохрани приватный ключ.**
   - **Networking:** оставь дефолт (новый VCN, публичный IPv4). Входящие правила менять
     не нужно — порт 22 (SSH) открыт по умолчанию, больше ничего боту не требуется.
4. **Create.** Когда статус *Running* — скопируй **Public IP address**.

---

## F. Подключение и установка (🐧 на сервере)

1. SSH с Windows (PowerShell):
   ```powershell
   ssh -i C:\path\to\ssh-key.key ubuntu@<PUBLIC_IP>
   ```
   Если ругается *UNPROTECTED PRIVATE KEY* — ужми права ключа:
   ```powershell
   icacls C:\path\to\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):R"
   ```
2. Доставь код (приватный репо + PAT из шага D):
   ```bash
   git clone https://github.com/<логин>/<repo>.git ~/rst
   # username = твой GitHub-логин, password = Personal Access Token
   ```
3. Запусти установочный скрипт (ставит Node 24, зависимости, systemd-сервис):
   ```bash
   cd ~/rst
   bash deploy/setup-oracle.sh
   ```

---

## G. Секреты и запуск (🐧 на сервере)

1. Заполни `.env` теми же значениями, что тестировал локально:
   ```bash
   nano ~/rst/.env
   ```
2. Запусти и проверь:
   ```bash
   sudo systemctl start rst-bot
   journalctl -u rst-bot -f
   ```
   Ждём `Telegram bot started` + `Rust+ connected`. В Telegram: `/start`, `/status`.

Сервис уже включён в автозапуск (`enable`), поднимется после краша (`Restart=always`)
и после ребута VM.

---

## Эксплуатация

- Статус / рестарт:
  ```bash
  systemctl status rst-bot
  sudo systemctl restart rst-bot
  ```
- Логи за сегодня: `journalctl -u rst-bot --since today`
- Обновление после правок кода:
  ```bash
  cd ~/rst && git pull && npm install --omit=dev && sudo systemctl restart rst-bot
  ```
- **После вайпа** (тима распускается): зайти в игру, снова вступить в тиму, при
  необходимости перепривязаться (`npm run pair` локально → обновить `RUST_*` в `.env` на сервере
  → `sudo systemctl restart rst-bot`). В боте есть подсказка `/repair`.

> ⚠️ Если параллельно сидишь в официальном приложении Rust+ на том же аккаунте — это
> два соединения на один токен; обычно ок, но изредка может флапать.

---

## H. Продуктовый режим: подписки и самопривязка

Бот многопользовательский: доступ по ключам-подпискам, клиенты сами привязывают
свой Rust+ через скачиваемый помощник. Серверу при этом `RUST_*` не нужны
(они только если ты сам играешь и хочешь свою сессию).

### Доп. переменные `.env`

```
ADMIN_TELEGRAM_ID=<твой id>        # кто может /genkey /keys /revoke (иначе первый ALLOWED id)
INGEST_PORT=8787                    # локальный порт приёма привязок (только localhost)
PUBLIC_INGEST_URL=                  # HTTPS-адрес ingest (туннель) — зашивается в помощник
HELPER_DOWNLOAD_URL=                # где клиент скачивает rst-pair.exe
```

### Туннель для ingest (Cloudflare Tunnel — без открытых портов)

Помощник клиента шлёт привязку на `PUBLIC_INGEST_URL`. Порт на VM открывать не нужно —
пробрасываем через `cloudflared` на `localhost:8787`:

```bash
# на сервере (🐧)
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel --url http://localhost:8787    # быстрый туннель -> https://<...>.trycloudflare.com
```

Адрес из вывода → `.env`: `PUBLIC_INGEST_URL=https://<...>.trycloudflare.com/pair/ingest`,
перезапусти бота. Для постоянного адреса — именованный туннель + свой systemd-юнит.

### Сборка помощника (🪟 локально, разово)

```powershell
cd helper
build.cmd https://<твой-туннель>/pair/ingest
```

`helper\build\rst-pair.exe` выложи (GitHub Release / Я.Диск / сайт), адрес → `HELPER_DOWNLOAD_URL`.

### Поток клиента

1. `/redeem <ключ>` — активирует подписку.
2. `/pair` — бот даёт одноразовый код (10 мин) + ссылку на помощник.
3. Запускает `rst-pair.exe`, вводит код, логинится в Steam.
4. Заходит на сервер → Esc → Rust+ → **Pair with Server**.
5. Бот ловит привязку и работает 24/7. Смена аккаунта/вайп — авто-восстановление.

### Команды админа

- `/genkey [дней] [план]` — создать ключ (без дней = бессрочно), напр. `/genkey 30`
- `/keys` — список ключей и статусов
- `/revoke <ключ>` — отозвать (замораживает сессию клиента)

### Подписка и заморозка

- Истекла → сессия и уведомления стоп (данные/привязка хранятся).
- `/redeem` нового ключа → авто-возобновление без повторной привязки Steam.
- 1 подписка = 1 Rust-аккаунт; сменить — `/rebind`.
