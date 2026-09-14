#!/usr/bin/env bash
# Deploy the locally built pi-web dist/ over the global npm install and restart
# the user services. tsc emits entry points without the exec bit, and a plain
# rsync preserves that — which previously left pi-web-sessiond in a
# permission-denied restart loop. This script exists so that never happens
# again: build, backup, sync, fix permissions, restart, verify.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${PI_WEB_INSTALL_DIR:-$HOME/.nvm/versions/node/v22.22.0/lib/node_modules/@jmfederico/pi-web}"
BACKUP_ROOT="${PI_WEB_BACKUP_DIR:-$HOME/pi-web-deploy-backups}"

ENTRY_POINTS=(cli.js server/index.js server/sessiond.js)

echo "==> build"
(cd "$REPO_ROOT" && npm run build)

echo "==> backup current dist"
BACKUP_DIR="$BACKUP_ROOT/dist-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -a "$INSTALL_DIR/dist/." "$BACKUP_DIR/"
echo "    backup: $BACKUP_DIR"

echo "==> sync dist (node_modules and top-level plugin dirs untouched)"
rsync -a --delete "$REPO_ROOT/dist/" "$INSTALL_DIR/dist/"

echo "==> restore exec bit on entry points"
for entry in "${ENTRY_POINTS[@]}"; do
  chmod +x "$INSTALL_DIR/dist/$entry"
done

echo "==> restart services (sessiond first: it owns the session runtime)"
systemctl --user restart pi-web-sessiond.service
systemctl --user restart pi-web.service

echo "==> verify"
sleep 2
systemctl --user is-active --quiet pi-web-sessiond.service \
  || { echo "ERROR: pi-web-sessiond not active"; systemctl --user status pi-web-sessiond.service --no-pager | head -15; exit 1; }
systemctl --user is-active --quiet pi-web.service \
  || { echo "ERROR: pi-web not active"; systemctl --user status pi-web.service --no-pager | head -15; exit 1; }
for entry in "${ENTRY_POINTS[@]}"; do
  [[ -x "$INSTALL_DIR/dist/$entry" ]] || { echo "ERROR: $entry lost exec bit"; exit 1; }
done
echo "    all services active, entry points executable"
