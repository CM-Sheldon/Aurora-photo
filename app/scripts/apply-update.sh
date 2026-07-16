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
#
# Safety model:
#   1. Snapshot the *current* INSTALL_DIR code items into a rollback dir
#      BEFORE we touch anything. If anything after that fails (npm install,
#      native-module check, service start), we restore from the snapshot and
#      start the service on the old code so the user is never left with a
#      broken install.
#   2. Snapshot the SQLite DB (aurora.db + WAL + SHM) into a timestamped
#      backup file. Updates don't touch the DB, but the belt-and-braces copy
#      means captions/tags/favourites/imports can be restored from a known
#      point even if a future update ever did migrate destructively.

set -Eeuo pipefail

STAGING="${1:?staging dir required}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aurora-photos}"
DATA_DIR="${DATA_DIR:-/var/lib/aurora-photos}"
SERVICE_NAME="${SERVICE_NAME:-aurora-photos}"
STATUS_FILE="$DATA_DIR/update-status.json"
LOG_FILE="$DATA_DIR/update.log"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROLLBACK_DIR="$DATA_DIR/update-rollback/$STAMP"
DB_BACKUP_DIR="$DATA_DIR/backups"
CODE_ITEMS=(server.js package.json package-lock.json version.json src views public scripts)

mkdir -p "$DATA_DIR" "$DB_BACKUP_DIR"

write_status() {
  local status="$1" msg="${2:-}"
  # Escape message via python for correct JSON quoting (message may contain
  # quotes, backslashes, newlines from npm output).
  printf '{"status":"%s","message":%s,"ts":%d,"rollback":"%s"}\n' \
    "$status" \
    "$(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(date +%s)" \
    "$ROLLBACK_DIR" > "$STATUS_FILE"
}

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

exec >> "$LOG_FILE" 2>&1

log "───── Update started ─────"
log "Staging: $STAGING"
log "Rollback snapshot: $ROLLBACK_DIR"

# ── Snapshot current install BEFORE we touch anything ───────────────────────
# rsync isn't guaranteed to be present; `cp -a` is enough for a small tree.
mkdir -p "$ROLLBACK_DIR"
for item in "${CODE_ITEMS[@]}"; do
  if [ -e "$INSTALL_DIR/$item" ]; then
    cp -a "$INSTALL_DIR/$item" "$ROLLBACK_DIR/$item"
  fi
done
log "Rollback snapshot created"

# ── Snapshot the DB (belt-and-braces — updates never touch the DB) ──────────
DB_SRC="$DATA_DIR/database/aurora.db"
if [ -f "$DB_SRC" ]; then
  DB_DEST="$DB_BACKUP_DIR/aurora_pre_update_${STAMP}.db"
  # Use `.backup` via sqlite3 if available (safer under WAL); else plain cp.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_SRC" ".backup '$DB_DEST'" && log "DB backup: $DB_DEST" || {
      log "WARN: sqlite3 .backup failed, falling back to file copy";
      cp -a "$DB_SRC" "$DB_DEST"
    }
  else
    cp -a "$DB_SRC" "$DB_DEST"
    log "DB backup (file copy): $DB_DEST"
  fi
fi

# ── Rollback helper — restores code and starts old service ──────────────────
rollback() {
  local reason="$1"
  log "ROLLBACK: $reason"
  write_status "rolling_back" "Rolling back: $reason"
  # Stop whatever's running (may already be stopped)
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  # Restore each item from the snapshot
  for item in "${CODE_ITEMS[@]}"; do
    if [ -e "$ROLLBACK_DIR/$item" ]; then
      rm -rf "$INSTALL_DIR/$item"
      cp -a "$ROLLBACK_DIR/$item" "$INSTALL_DIR/$item"
    fi
  done
  log "Files restored from snapshot"
  # Restart on the previous version so the user isn't left offline
  if systemctl start "$SERVICE_NAME"; then
    log "Service restarted on previous version"
    write_status "rolled_back" "Update failed and was rolled back: $reason. Aurora is running on the previous version."
  else
    log "ERROR: rollback restart failed — manual intervention required"
    write_status "error" "Rollback restart failed — check $LOG_FILE"
  fi
  exit 1
}
trap 'rollback "Unexpected error at line $LINENO"' ERR

write_status "stopping" "Stopping service…"
sleep 2   # allow the HTTP response to be delivered before we restart

systemctl stop "$SERVICE_NAME" || rollback "Failed to stop service"
log "Service stopped"
write_status "applying" "Applying new files…"

# Replace only the code artefacts — data directories are never touched.
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
  || rollback "npm install failed — check $LOG_FILE"

# Verify critical native modules still load
node -e "require('sharp');require('sqlite3');require('exiftool-vendored')" >> "$LOG_FILE" 2>&1 \
  || rollback "Native module check failed — check $LOG_FILE"

write_status "starting" "Starting service…"
systemctl start "$SERVICE_NAME" || rollback "Failed to start service"

# Health-check: give the service a few seconds to bind, then confirm it's
# actually responding on the HTTP port. This catches "process starts, then
# crashes 200ms later" which systemctl start returns success for.
sleep 4
HEALTH_URL="http://127.0.0.1:${AURORA_HEALTH_PORT:-8080}/health"
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "Health check failed on $HEALTH_URL after start"
    rollback "Service started but is not responding on $HEALTH_URL"
  fi
  log "Health check OK"
fi

# Success — drop the trap so a later benign command's exit doesn't rollback.
trap - ERR

NEW_VER="unknown"
if [ -f "$INSTALL_DIR/version.json" ]; then
  NEW_VER=$(python3 -c "import json; print(json.load(open('$INSTALL_DIR/version.json')).get('version','unknown'))" 2>/dev/null || echo "unknown")
fi

log "Update complete — version $NEW_VER"
write_status "complete" "Update complete — Aurora Photos $NEW_VER is running"

# Keep the last 5 rollback snapshots; delete older ones to bound disk use.
ls -1dt "$DATA_DIR/update-rollback"/* 2>/dev/null | tail -n +6 | xargs -r rm -rf
# Keep the last 10 DB backups the updater created.
ls -1t "$DB_BACKUP_DIR"/aurora_pre_update_*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
