#!/usr/bin/env bash
#
# Provision a fresh Oracle Cloud "Always Free" VM (Ubuntu) to run rst-bot 24/7.
# Run as the default 'ubuntu' user:
#
#   bash deploy/setup-oracle.sh [git-repo-url]
#
# If a repo URL is given and ~/rst doesn't exist yet, it will be cloned.
# Otherwise run this from inside an already-present ~/rst checkout.

set -euo pipefail

REPO_URL="${1:-}"
APP_DIR="$HOME/rst"

echo "==> Installing Node.js 24 + git"
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
echo "==> node $(node -v), npm $(npm -v)"

if [ -n "$REPO_URL" ] && [ ! -d "$APP_DIR/.git" ]; then
  echo "==> Cloning $REPO_URL -> $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "==> Installing dependencies (production only)"
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from template — you MUST edit it with real secrets."
fi

echo "==> Installing systemd service (for user $(whoami), dir $APP_DIR)"
# Template User=/WorkingDirectory= to the actual account so this works on any
# host (Oracle's default user is 'ubuntu'; GCP uses your Google username).
RUN_USER="$(whoami)"
sudo sed \
  -e "s|^User=.*|User=${RUN_USER}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
  deploy/rst-bot.service | sudo tee /etc/systemd/system/rst-bot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable rst-bot

cat <<'NEXT'

==> Setup complete. Next steps:
    1) Fill secrets:        nano ~/rst/.env
         - TELEGRAM_BOT_TOKEN   (NEW token from @BotFather)
         - ALLOWED_TELEGRAM_IDS (your Telegram id from @userinfobot)
         - RUST_SERVER_IP / PORT / PLAYER_ID / PLAYER_TOKEN  (from local `npm run pair`)
    2) Start the bot:       sudo systemctl start rst-bot
    3) Watch logs:          journalctl -u rst-bot -f
    4) After code updates:  cd ~/rst && git pull && npm install --omit=dev && sudo systemctl restart rst-bot

NEXT
