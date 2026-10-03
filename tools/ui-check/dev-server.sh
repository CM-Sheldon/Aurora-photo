#!/usr/bin/env bash
# Throwaway Aurora for UI work: runs THIS checkout's app/ on a spare port against
# a private snapshot of the live database, with a fresh admin session minted in
# the snapshot. Never writes to the live DB or /opt.
#
#   tools/ui-check/dev-server.sh            # snapshot (first run) + start on :8091
#   tools/ui-check/dev-server.sh restart    # restart after server-side edits
#   tools/ui-check/dev-server.sh stop
#   tools/ui-check/dev-server.sh snapshot   # take a fresh DB snapshot first
#
# Prints AURORA_TOKEN for smoke.mjs / gestures.mjs / perf.mjs. EJS views and /ui
# files are re-read on every request (NODE_ENV is not production), so front-end
# edits only need a browser reload.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../../app" && pwd)"
PORT="${AURORA_DEV_PORT:-8091}"
WORK="${AURORA_DEV_DIR:-$HOME/.aurora-ui-dev}"
LIVE_DB="${AURORA_LIVE_DB:-/var/lib/aurora-photos/database/aurora.db}"
NODE_MODULES="${AURORA_NODE_MODULES:-/opt/aurora-photos/node_modules}"
THUMBS="${AURORA_THUMB_DIR:-/var/lib/aurora-photos/cache/thumbs}"
DATA_DIR="${AURORA_DATA_DIR:-/var/lib/aurora-photos/data}"
mkdir -p "$WORK/root" "$WORK/sidecar"

stop() {
  if [ -f "$WORK/pid" ]; then kill "$(cat "$WORK/pid")" 2>/dev/null || true; rm -f "$WORK/pid"; fi
}
snapshot() {
  rm -f "$WORK/aurora.db"
  ( cd "$NODE_MODULES/.." && node -e "
    const sqlite3 = require('sqlite3');
    const src = new sqlite3.Database(process.argv[1], sqlite3.OPEN_READONLY);
    src.run('VACUUM INTO ?', [process.argv[2]], (e) => { if (e) { console.error(e.message); process.exit(1); } src.close(); });
  " "$LIVE_DB" "$WORK/aurora.db" )
  # Fresh admin session + no boot-time thumbnail warming in the copy.
  ( cd "$NODE_MODULES/.." && node -e "
    const sqlite3 = require('sqlite3'), crypto = require('crypto'), fs = require('fs');
    const db = new sqlite3.Database(process.argv[1]);
    const tok = crypto.randomBytes(24).toString('hex');
    db.serialize(() => {
      db.run(\"INSERT OR REPLACE INTO app_settings(key, value) VALUES('warm_on_boot', '0')\");
      db.run(\`INSERT INTO sessions(token, user_id, created_at, expires_at, user_agent)
              SELECT ?, u.id, ?, ?, 'ui-check' FROM users u JOIN roles r ON r.id = u.role_id
              WHERE r.name = 'admin' ORDER BY u.id LIMIT 1\`, [tok, Date.now(), Date.now() + 30 * 864e5],
        (e) => { if (e) { console.error(e.message); process.exit(1); } fs.writeFileSync(process.argv[2], tok); });
    });
  " "$WORK/aurora.db" "$WORK/token" )
  echo "snapshot taken → $WORK/aurora.db"
}
start() {
  [ -f "$WORK/aurora.db" ] || snapshot
  cd "$APP"
  NODE_PATH="$NODE_MODULES" PORT="$PORT" HOST=127.0.0.1 \
  AURORA_DB_PATH="$WORK/aurora.db" AURORA_THUMB_DIR="$THUMBS" AURORA_DATA_DIR="$DATA_DIR" \
  AURORA_DATA_ROOT="$WORK/root" AURORA_INSTALL_DIR="$APP" AURORA_NO_AUTOWARM=1 \
  AURORA_CAPTION_SIDECAR_DIR="$WORK/sidecar" AURORA_CAPTION_OLLAMA=http://127.0.0.1:1 \
    nohup node server.js > "$WORK/server.log" 2>&1 &
  echo $! > "$WORK/pid"
  for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.25; done
  echo "Aurora dev server → http://127.0.0.1:$PORT/aurora   (log: $WORK/server.log)"
  echo "export AURORA_TOKEN=$(cat "$WORK/token")"
}
case "${1:-start}" in
  stop) stop ;;
  restart) stop; start ;;
  snapshot) stop; snapshot; start ;;
  *) stop; start ;;
esac
