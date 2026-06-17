#!/usr/bin/env bash
#
# Aurora Photos — update applier.
#
# Spawned as a detached child by the Node update endpoint so the HTTP response
# can be sent before the service is restarted. Never run this by hand during
# normal operation; use the Settings → Software Update panel instead.
#
# Usage (internal):
#   apply-update.sh <staging-dir>
#
# Environment:
#   INSTALL_DIR   (default /opt/aurora-photos)
#   DATA_DIR      (default /var/lib/aurora-photos)
#   SERVICE_NAME  (default aurora-photos)

set -Eeuo pipefail

STAGING="${1:?staging dir required}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aurora-photos}"
DATA_DIR="${DATA_DIR:-/var/lib/aurora-photos}"
SERVICE_NAME="${SERVICE_NAME:-aurora-photos}"
STATUS_FILE="$DATA_DIR/update-status.json"
LOG_FILE="$DATA_DIR/update.log"

write_status() {
  local status="$1" msg="${2:-}"
  printf '{"status":"%s","message":%s,"ts":%d}\n' \
    "$status" "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(date +%s)" > "$STATUS_FILE"
}

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

exec >> "$LOG_FILE" 2>&1

log "Update started from staging: $STAGING"
write_status "stopping" "Stopping service…"

sleep 2   # allow the HTTP response to be delivered before we restart

systemctl stop "$SERVICE_NAME" || { log "ERROR: failed to stop service"; write_status "error" "Failed to stop service"; exit 1; }
log "Service stopped"
write_status "applying" "Applying new files…"

# Replace only the code artefacts — data directories are never touched.
CODE_ITEMS=(server.js package.json package-lock.json version.json src views public scripts)
for item in "${CODE_ITEMS[@]}"; do
  src="$STAGING/$item"
  dst="$INSTALL_DIR/$item"
  if [ -e "$src" ]; then
    rm -rf "$dst"
    cp -a "$src" "$dst"
    log "Replaced: $item"
  fi
done

write_status "deps" "Installing dependencies…"
log "Running npm install"
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund >> "$LOG_FILE" 2>&1 \
  || { log "ERROR: npm install failed"; write_status "error" "npm install failed — check $LOG_FILE"; exit 1; }

# Verify critical native modules still load
node -e "require('sharp');require('sqlite3');require('exiftool-vendored')" >> "$LOG_FILE" 2>&1 \
  || { log "ERROR: native module check failed"; write_status "error" "Native module check failed — check $LOG_FILE"; exit 1; }

write_status "starting" "Starting service…"
systemctl start "$SERVICE_NAME" || { log "ERROR: failed to start service"; write_status "error" "Failed to start service — check $LOG_FILE"; exit 1; }

NEW_VER="unknown"
if [ -f "$INSTALL_DIR/version.json" ]; then
  NEW_VER=$(python3 -c "import json; print(json.load(open('$INSTALL_DIR/version.json')).get('version','unknown'))" 2>/dev/null || echo "unknown")
fi

log "Update complete — version $NEW_VER"
write_status "complete" "Update complete — Aurora Photos $NEW_VER is running"
