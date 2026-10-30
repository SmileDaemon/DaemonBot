#!/usr/bin/env bash
# Sets up the bot on a fresh Ubuntu VM (Oracle Cloud Always Free). Run it from
# the cloned repository: `bash DaemonBot/deploy/setup-oracle.sh`. Safe to re-run.
# Steps are in MAINTAINING.md → "Keeping it online".
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"

# Node 22 from NodeSource: Ubuntu's own package is too old for the bot (needs 20.11+).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

cd "$DIR"
npm ci --omit=dev
mkdir -p data

sed -e "s|USER|$USER_NAME|g" -e "s|DIR|$DIR|g" deploy/daemonbot.service | sudo tee /etc/systemd/system/daemonbot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable daemonbot

# The GitHub Action restarts the bot after each deploy; let this user do that without a password.
echo "$USER_NAME ALL=(root) NOPASSWD: /usr/bin/systemctl restart daemonbot" | sudo tee /etc/sudoers.d/daemonbot >/dev/null
sudo chmod 440 /etc/sudoers.d/daemonbot

echo
if [ -f .env ]; then
  sudo systemctl restart daemonbot
  echo "Bot started. Follow its log with: journalctl -u daemonbot -f"
else
  echo "Installed. Copy your .env to $DIR/.env, then run: sudo systemctl start daemonbot"
fi
echo "This VM's SSH host key, for the ORACLE_HOST_KEY GitHub secret:"
cat /etc/ssh/ssh_host_ed25519_key.pub
