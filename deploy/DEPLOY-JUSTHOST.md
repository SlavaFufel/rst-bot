# Хостинг на российском VPS (JustHost / Aeza / Timeweb и пр.)

Дешёвый KVM-VPS с оплатой рублями. Подходит план **1 ядро / 1 ГБ / 10 ГБ / Ubuntu**.
Боту нужны только **исходящие** соединения — порты открывать не надо.

Обозначения: 🪟 — на твоём Windows, 🐧 — на сервере по SSH.

---

## Шаг 1. Заказ сервера (в панели хостинга)

| Пункт | Что выбрать |
|---|---|
| **Тип сервера** | Стандартные серверы |
| **Образ диска** | Чистая ОС → **Ubuntu** (24.04 или 26.04 LTS) |
| **Тариф** | **1 core / 1 ГБ / 10 ГБ / 1 ТБ** (самый дешёвый, ~5 ₽/день) |
| **Локация** | Москва |
| **Авто-бэкап** | по желанию (+4 ₽/день; база крошечная, можно и без) |
| **SSH-ключи** | можно пропустить — дадут root-пароль |

Жми **Создать**. Через минуту в панели появятся **IP-адрес** и **root-пароль**
(иногда пароль приходит на почту).

> 1 ГБ ОЗУ хватает, потому что отрисовка карты картинкой выключена (`MAP_RENDER=off`).
> Бот держит ~30–50 активных сессий. Перерастёшь — апнешь тариф на 2 ГБ в пару кликов.

---

## Шаг 2. Подключение по SSH (🪟 PowerShell)

```powershell
ssh root@<IP_СЕРВЕРА>
```
На вопрос про fingerprint — `yes`, затем введи root-пароль (при вводе он не виден — это норма).

---

## Шаг 3. Подготовка сервера (🐧 от root)

Скопируй и вставь целиком:
```bash
# обновиться + поставить git
apt-get update && apt-get install -y git

# swap 2 ГБ — страховка от нехватки памяти на 1 ГБ
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# отдельный пользователь для бота (безопаснее, чем root)
adduser --gecos "" rst        # задай пароль для пользователя rst
usermod -aG sudo rst
su - rst                       # дальше работаем под rst
```

---

## Шаг 4. Установка бота (🐧 под пользователем rst)

```bash
git clone https://github.com/<твой-логин>/<репо>.git ~/rst
# логин = твой GitHub, пароль = Personal Access Token (репо приватный)

cd ~/rst
bash deploy/setup-oracle.sh    # ставит Node 24 + зависимости + systemd-сервис
```
Скрипт сам подставит пользователя `rst` в сервис (не хардкодит ничего лишнего).

---

## Шаг 5. Секреты (🐧)

```bash
nano ~/rst/.env
```
Заполни (Ctrl+O сохранить, Ctrl+X выйти):
```
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
ALLOWED_TELEGRAM_IDS=<твой Telegram id от @userinfobot>
ADMIN_TELEGRAM_ID=<твой же id>     # кто может /genkey /keys /revoke
STEAM_API_KEY=<ключ Steam>          # для /check и /enemy stats
MAP_RENDER=off                      # карта картинкой выкл (память); метки идут текстом
# Если играешь сам и хочешь свою сессию — добавь RUST_* из локальной привязки (npm run pair).
# Клиенты-подписчики привязываются сами через помощник — им RUST_* не нужны.
```

---

## Шаг 6. Запуск и проверка (🐧)

```bash
sudo systemctl start rst-bot
journalctl -u rst-bot -f          # смотрим логи; ждём "Telegram bot started"
```
Выйти из логов — Ctrl+C (бот продолжит работать в фоне).

В Telegram: напиши боту `/start` → выбери язык → `/status`. Если ответил — всё работает.

Сервис уже в автозапуске: переживёт перезагрузку VPS и сам поднимется после краша.

---

## Эксплуатация

```bash
systemctl status rst-bot              # состояние
sudo systemctl restart rst-bot        # перезапуск
journalctl -u rst-bot --since today   # логи за сегодня

# обновление после правок кода:
cd ~/rst && git pull && npm install --omit=dev && sudo systemctl restart rst-bot
```

---

## Если продаёшь подписки (самопривязка клиентов)

Клиентам нужен публичный HTTPS-адрес для ingest. На VPS есть белый IP, но проще и
безопаснее — Cloudflare Tunnel (раздел **H** в [DEPLOY.md](DEPLOY.md)):
```bash
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel --url http://localhost:8787   # выдаст https://<...>.trycloudflare.com
```
Адрес → в `.env` как `PUBLIC_INGEST_URL=https://<...>.trycloudflare.com/pair/ingest`,
затем `sudo systemctl restart rst-bot`. Команды клиента/админа — см. [DEPLOY.md](DEPLOY.md) раздел H.

---

## Включить карту картинкой позже

Возьмёшь тариф 2 ГБ — в `~/rst/.env` поставь `MAP_RENDER=on`, `sudo systemctl restart rst-bot`.
Код рендера на месте, ничего доустанавливать не надо.
