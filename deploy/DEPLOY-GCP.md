# Хостинг на Google Cloud — `e2-micro` Always Free (замена Oracle)

Тот же бот, тот же `systemd`-сервис, что и в [DEPLOY.md](DEPLOY.md) — меняется только
способ создания VM. Боту нужны **только исходящие** соединения, входящие порты
открывать не надо.

Обозначения: 🪟 — локально на Windows, 🐧 — на сервере (Ubuntu), 🌐 — в браузере (консоль GCP).

---

## 💸 Сколько это стоит (честно)

| Ресурс | Цена |
|--------|------|
| 1× `e2-micro` VM (1 vCPU / 1 GB), регион us-west1 / us-central1 / us-east1 | **бесплатно навсегда** (Always Free) |
| 30 GB standard persistent disk | **бесплатно** (в пределах Always Free) |
| Внешний IPv4 (привязанный к работающей VM) | **0 – ~$3/мес** — Google с 2024 берёт за in-use IPv4, но для Always Free `e2-micro` практика плавающая. |
| Сетевой egress | 1 GB/мес из Сев. Америки **бесплатно**, дальше ~$0.12/GB (для бота мало; `/map`-картинки в TG тоже считаются) |

➡️ Чтобы **никогда** не словить счёт: на шаге B.4 ставим **Budget alert на $1**. Если IPv4
начнут тарифицировать — увидишь сразу и решишь (отключить VM / перейти на Pi / Oracle).
Реально для маленькой команды выходит **$0–3/мес**.

> Нужен строго $0 без карты — тогда лучше домашний Raspberry Pi / ПК (см. конец файла).

---

## A. Подготовка (🪟 — общая с Oracle)

Сделай шаги из [DEPLOY.md](DEPLOY.md): **A** (новый токен бота + свой Telegram ID),
**B** (привязка Rust+ → `rustplus.config.json` + 4 значения `RUST_*`), **C** (локальный
тест `npm start`), **D** (залить код в приватный GitHub-репо + Personal Access Token).
Всё это от хостинга не зависит.

---

## B. Аккаунт, проект и защита от счёта (🌐 console.cloud.google.com)

1. Зайди на <https://console.cloud.google.com>, войди Google-аккаунтом, прими условия.
2. **Billing → привяжи карту** (нужна для верификации; Always Free не списывает).
   GCP к картам лояльнее Oracle — обычно проходит с первого раза.
3. Вверху создай **проект** (New Project → имя `rst-bot` → Create), выбери его.
4. **Защита от счёта (обязательно):** Billing → **Budgets & alerts** → **Create budget** →
   сумма **$1**, алерты на 50/90/100 % → Finish. Теперь любой случайный платёж = письмо тебе.

---

## C. Создаём `e2-micro` VM (🌐) — строго по Always Free

Меню (☰) → **Compute Engine → VM instances** → (включить Compute Engine API, ~1 мин) → **Create instance**.

- **Name:** `rst-bot`
- **Region:** ⚠️ только **`us-west1` (Oregon)**, `us-central1` (Iowa) или `us-east1` (S. Carolina) —
  иначе Always Free не действует. Zone — любая.
- **Machine configuration:** серия **E2** → тип **`e2-micro`** (2 vCPU shared / 1 GB). Не бери e2-small+.
- **Boot disk:** Change → **Ubuntu** → **Ubuntu 24.04 LTS** → Boot disk type **Standard persistent disk**,
  Size **30 GB** (бесплатный потолок). Select.
- **Firewall:** галки *Allow HTTP/HTTPS* — **НЕ ставь** (боту входящие не нужны).
- (Опц.) Раскрой **Advanced → Networking** и оставь дефолт. **Create.**

Когда статус *Running* — VM готова. Внешний IP можно не записывать (подключимся через браузер).

---

## D. Подключение и установка (🌐 + 🐧)

1. В списке VM напротив `rst-bot` нажми **SSH** (откроется терминал в браузере — ключи не нужны).
2. Доставь код (приватный репо + PAT из шага A/D):
   ```bash
   git clone https://github.com/<логин>/<repo>.git ~/rst
   # username = GitHub-логин, password = Personal Access Token
   ```
3. Запусти установщик (ставит Node 24, зависимости, `systemd`-сервис под твоего пользователя):
   ```bash
   cd ~/rst
   bash deploy/setup-oracle.sh
   ```
   > Скрипт host-agnostic: он сам подставит твоего GCP-пользователя и путь в сервис
   > (не хардкодит `ubuntu`).

---

## E. Секреты и запуск (🐧 — общая с Oracle)

Как в [DEPLOY.md](DEPLOY.md) раздел **G**:
```bash
nano ~/rst/.env       # TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_IDS, ADMIN_TELEGRAM_ID,
                      # RUST_* (если играешь сам), STEAM_API_KEY (для /check, /enemy stats)
sudo systemctl start rst-bot
journalctl -u rst-bot -f
```
Ждём `Telegram bot started`. В Telegram: `/start` → выбор языка → `/status`.
Сервис уже в автозапуске (`enable`) и переживёт краш/ребут (`Restart=always`).

---

## F. Самопривязка клиентов (ingest) — если продаёшь подписки

Раздел **H** из [DEPLOY.md](DEPLOY.md) работает без изменений: Cloudflare Tunnel
(`cloudflared tunnel --url http://localhost:8787`) → `PUBLIC_INGEST_URL` в `.env`.
Никаких портов в GCP открывать не надо.

---

## Эксплуатация

```bash
systemctl status rst-bot              # состояние
sudo systemctl restart rst-bot        # рестарт
journalctl -u rst-bot --since today   # логи
cd ~/rst && git pull && npm install --omit=dev && sudo systemctl restart rst-bot   # обновление
```
Раз в пару дней первую неделю заглядывай в **Billing → Reports** — убедиться, что счёт $0.

---

## Если хочется строго $0 без карты — домашний хост

Raspberry Pi 4/5 или старый ПК/ноут: бот **только исходящий**, порты пробрасывать не надо,
креды клиентов остаются на твоём железе. Ставится тем же `bash deploy/setup-oracle.sh`
(Ubuntu/Raspberry Pi OS), ingest — через тот же Cloudflare Tunnel. Скажи — распишу отдельно.
