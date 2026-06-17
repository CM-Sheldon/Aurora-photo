#!/usr/bin/env bash
#
# Aurora Photos — one-shot installer.
#
#   sudo ./install.sh
#
# Layout after install:
#
#   /opt/aurora-photos/        ← SOFTWARE   (replaced by updates)
#       server.js, src/, views/, public/, scripts/, node_modules/, version.json
#
#   /var/lib/aurora-photos/    ← DATA       (NEVER touched by updates)
#       database/aurora.db     — photo index (favourites, places, import history)
#       cache/thumbs/          — generated thumbnail cache
#       data/                  — optional cities.tsv for offline place names
#       update-status.json     — written by apply-update.sh during in-app updates
#       update.log             — log of past in-app update runs
#
# Safe to re-run (idempotent). Re-running preserves all user data.
#
# Optional environment overrides:
#   PORT=8080
#   INSTALL_DIR=/opt/aurora-photos      (software root — replaced on update)
#   DATA_DIR=/var/lib/aurora-photos     (data root — preserved on update)
#   SERVICE_USER=root

set -Eeuo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
PORT="${PORT:-8080}"
INSTALL_DIR="${INSTALL_DIR:-/opt/aurora-photos}"
DATA_DIR="${DATA_DIR:-/var/lib/aurora-photos}"
SERVICE_USER="${SERVICE_USER:-root}"
SERVICE_NAME="aurora-photos"
LOG_FILE="/var/log/aurora-photos.log"
NODE_MAJOR_MIN=18
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/app"

# ── Pretty logging ───────────────────────────────────────────────────────────
if [ -t 1 ]; then C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[0;33m'; C_B='\033[0;36m'; C_0='\033[0m'; else C_R=; C_G=; C_Y=; C_B=; C_0=; fi
info()  { echo -e "${C_B}[*]${C_0} $*"; }
ok()    { echo -e "${C_G}[✓]${C_0} $*"; }
warn()  { echo -e "${C_Y}[!]${C_0} $*"; }
err()   { echo -e "${C_R}[✗]${C_0} $*" >&2; }

# ── Fail loudly, never leave a stuck/half install ────────────────────────────
on_error() {
  local exit_code=$?
  local line=${1:-?}
  err "Installation failed (line $line, exit $exit_code)."
  err "Nothing was left running half-configured. Review the output above."
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
    err "Service logs:   journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    err "App log file:   ${LOG_FILE}"
  fi
  err "Fix the issue and simply re-run this script — it is safe to run again."
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "Please run as root:  sudo ./install.sh"
    exit 1
  fi
}

# ── Package manager abstraction ──────────────────────────────────────────────
PKG=""
detect_pkg_mgr() {
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then PKG="yum"
  elif command -v zypper >/dev/null 2>&1; then PKG="zypper"
  elif command -v pacman >/dev/null 2>&1; then PKG="pacman"
  else
    err "No supported package manager found (need apt, dnf, yum, zypper or pacman)."
    exit 1
  fi
  info "Package manager: $PKG"
}

PKG_REFRESHED=0
pkg_refresh() {
  [ "$PKG_REFRESHED" -eq 1 ] && return 0
  info "Refreshing package lists…"
  case "$PKG" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get update -y -q || warn "apt-get update reported problems; continuing." ;;
    dnf|yum) "$PKG" makecache -y >/dev/null 2>&1 || true ;;
    zypper) zypper --non-interactive refresh >/dev/null 2>&1 || true ;;
    pacman) pacman -Sy --noconfirm >/dev/null 2>&1 || true ;;
  esac
  PKG_REFRESHED=1
}

# install_pkg <generic-name> <critical:yes|no>
install_pkg() {
  local generic="$1" critical="${2:-no}" names=""
  case "$PKG:$generic" in
    apt:ffmpeg)      names="ffmpeg" ;;
    apt:cifs)        names="cifs-utils" ;;
    apt:nfs)         names="nfs-common" ;;
    apt:perl)        names="perl" ;;
    apt:sudo)        names="sudo" ;;
    apt:curl)        names="curl ca-certificates" ;;
    apt:unzip)       names="unzip" ;;
    apt:build)       names="python3 make g++" ;;
    dnf:ffmpeg|yum:ffmpeg)   names="ffmpeg" ;;
    dnf:cifs|yum:cifs)       names="cifs-utils" ;;
    dnf:nfs|yum:nfs)         names="nfs-utils" ;;
    dnf:perl|yum:perl)       names="perl" ;;
    dnf:sudo|yum:sudo)       names="sudo" ;;
    dnf:curl|yum:curl)       names="curl ca-certificates" ;;
    dnf:unzip|yum:unzip)     names="unzip" ;;
    dnf:build|yum:build)     names="python3 make gcc-c++" ;;
    zypper:ffmpeg)   names="ffmpeg" ;;
    zypper:cifs)     names="cifs-utils" ;;
    zypper:nfs)      names="nfs-client" ;;
    zypper:perl)     names="perl" ;;
    zypper:sudo)     names="sudo" ;;
    zypper:curl)     names="curl ca-certificates" ;;
    zypper:unzip)    names="unzip" ;;
    zypper:build)    names="python3 make gcc-c++" ;;
    pacman:ffmpeg)   names="ffmpeg" ;;
    pacman:cifs)     names="cifs-utils" ;;
    pacman:nfs)      names="nfs-utils" ;;
    pacman:perl)     names="perl" ;;
    pacman:sudo)     names="sudo" ;;
    pacman:curl)     names="curl ca-certificates" ;;
    pacman:unzip)    names="unzip" ;;
    pacman:build)    names="python make gcc" ;;
    *) names="$generic" ;;
  esac

  pkg_refresh
  info "Installing: $names"
  local rc=0
  case "$PKG" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get install -y -q $names || rc=$? ;;
    dnf)    dnf install -y $names || rc=$? ;;
    yum)    yum install -y $names || rc=$? ;;
    zypper) zypper --non-interactive install -y $names || rc=$? ;;
    pacman) pacman -S --noconfirm --needed $names || rc=$? ;;
  esac

  if [ "$rc" -ne 0 ]; then
    if [ "$critical" = "yes" ]; then
      err "Failed to install required package(s): $names"
      return 1
    fi
    warn "Could not install '$names' (non-critical) — continuing. Some features may be limited."
    return 0
  fi
  ok "Installed $names"
}

# ── Node.js ──────────────────────────────────────────────────────────────────
node_major() { command -v node >/dev/null 2>&1 && node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0; }

ensure_node() {
  local maj; maj="$(node_major)"
  if [ "${maj:-0}" -ge "$NODE_MAJOR_MIN" ]; then
    ok "Node.js $(node --version) already present."
    return 0
  fi
  info "Installing Node.js 20…"
  case "$PKG" in
    apt)
      install_pkg curl yes
      curl -fsSL --max-time 60 https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh \
        && bash /tmp/nodesource_setup.sh \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs \
        || { warn "NodeSource failed; trying the distro's nodejs package."; install_pkg nodejs yes; }
      rm -f /tmp/nodesource_setup.sh
      ;;
    dnf|yum)
      curl -fsSL --max-time 60 https://rpm.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh \
        && bash /tmp/nodesource_setup.sh \
        && "$PKG" install -y nodejs \
        || { warn "NodeSource failed; trying the distro's nodejs package."; "$PKG" install -y nodejs || true; }
      rm -f /tmp/nodesource_setup.sh
      ;;
    zypper) zypper --non-interactive install -y nodejs20 || zypper --non-interactive install -y nodejs || true ;;
    pacman) pacman -S --noconfirm --needed nodejs npm || true ;;
  esac

  maj="$(node_major)"
  if [ "${maj:-0}" -lt "$NODE_MAJOR_MIN" ]; then
    err "Node.js >= ${NODE_MAJOR_MIN} is required but could not be installed automatically."
    err "Install Node.js 18+ manually, then re-run this script."
    exit 1
  fi
  ok "Node.js $(node --version) installed."
}

# ── Create data directory (persistent — never wiped by updates) ───────────────
setup_data_dir() {
  info "Setting up data directory at $DATA_DIR …"
  mkdir -p "$DATA_DIR/database" "$DATA_DIR/cache/thumbs" "$DATA_DIR/data"

  # Migrate data from old layout (≤1.0.0) if present and target is empty.
  # Old layout stored everything under INSTALL_DIR.
  local old_db="$INSTALL_DIR/database/aurora.db"
  local new_db="$DATA_DIR/database/aurora.db"
  if [ -f "$old_db" ] && [ ! -f "$new_db" ]; then
    warn "Migrating existing database from $old_db → $new_db"
    cp -a "$INSTALL_DIR/database/." "$DATA_DIR/database/"
  fi

  local old_thumbs="$INSTALL_DIR/cache/aurora/thumbs"
  local new_thumbs="$DATA_DIR/cache/thumbs"
  if [ -d "$old_thumbs" ] && [ -z "$(ls -A "$new_thumbs" 2>/dev/null)" ]; then
    warn "Migrating thumbnail cache from $old_thumbs → $new_thumbs"
    cp -a "$old_thumbs/." "$new_thumbs/"
  fi

  # Offline place-name dataset. Prefer an existing one (migrate from old layout),
  # otherwise seed it from the copy bundled in this installer so place names work
  # out of the box. Never overwrite a dataset the user already has.
  local new_cities="$DATA_DIR/data/cities.tsv"
  local old_cities="$INSTALL_DIR/data/cities.tsv"
  local bundled_cities="$SRC_DIR/data/cities.tsv"
  if [ ! -f "$new_cities" ]; then
    if [ -f "$old_cities" ]; then
      warn "Migrating cities.tsv from $old_cities → $new_cities"
      cp "$old_cities" "$new_cities"
    elif [ -f "$bundled_cities" ]; then
      info "Installing bundled place-name dataset → $new_cities"
      cp "$bundled_cities" "$new_cities"
    fi
  fi

  if [ "$SERVICE_USER" != "root" ]; then
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"
  fi
  ok "Data directory ready."
}

# ── Deploy app (code only — never touches DATA_DIR) ──────────────────────────
deploy_app() {
  if [ ! -d "$SRC_DIR" ] || [ ! -f "$SRC_DIR/server.js" ]; then
    err "Bundled app not found at $SRC_DIR — is the archive extracted intact?"
    exit 1
  fi
  # Guard in case deploy_app is called independently (service should already be stopped)
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Stopping $SERVICE_NAME before deploy…"
    systemctl stop "$SERVICE_NAME" || true
  fi

  info "Deploying app (software) to $INSTALL_DIR …"
  mkdir -p "$INSTALL_DIR"

  # Sync only code artefacts — excludes data directories even if they happen to
  # exist in the source tree (they are placeholders in the dev checkout only).
  for item in server.js package.json package-lock.json version.json src views public scripts; do
    src="$SRC_DIR/$item"
    [ -e "$src" ] && cp -a "$src" "$INSTALL_DIR/$item"
  done

  # Ensure the update script is executable
  chmod +x "$INSTALL_DIR/scripts/apply-update.sh" 2>/dev/null || true

  if [ "$SERVICE_USER" != "root" ]; then
    id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  fi
  ok "App deployed."
}

# ── Ensure Node dependencies ──────────────────────────────────────────────────
ensure_deps() {
  if [ -d "$INSTALL_DIR/node_modules" ] && ( cd "$INSTALL_DIR" && node -e "require('express')" ) 2>/dev/null; then
    ok "Node dependencies already present."
    return 0
  fi
  info "Installing Node dependencies via npm (needs internet access to registry.npmjs.org)…"
  command -v npm >/dev/null 2>&1 || install_pkg npm yes
  install_pkg build no
  local tries=0
  while true; do
    if ( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund ); then
      ok "Dependencies installed."
      return 0
    fi
    tries=$((tries + 1))
    [ "$tries" -ge 3 ] && { err "npm install failed after 3 attempts."; exit 1; }
    warn "npm install failed — retrying ($tries/3) in 5s…"
    sleep 5
  done
}

# ── Verify native modules ─────────────────────────────────────────────────────
verify_native() {
  info "Verifying native modules (sharp, sqlite3, exiftool-vendored)…"
  if ( cd "$INSTALL_DIR" && node -e "require('sharp');require('sqlite3');require('exiftool-vendored')" ) 2>/dev/null; then
    ok "Native modules load correctly."
    return 0
  fi
  warn "Bundled binaries don't match this system's Node.js — rebuilding from source."
  install_pkg build yes
  command -v npm >/dev/null 2>&1 || install_pkg npm yes || true
  ( cd "$INSTALL_DIR" && npm rebuild --omit=dev ) || {
    err "Native module rebuild failed."
    exit 1
  }
  ( cd "$INSTALL_DIR" && node -e "require('sharp');require('sqlite3');require('exiftool-vendored')" ) || {
    err "Native modules still fail to load after rebuild."
    exit 1
  }
  ok "Native modules rebuilt successfully."
}

# ── systemd service ──────────────────────────────────────────────────────────
NODE_BIN=""
install_service() {
  NODE_BIN="$(command -v node)"
  info "Writing systemd unit /etc/systemd/system/${SERVICE_NAME}.service …"
  touch "$LOG_FILE" || true
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=Aurora Photos — local photo & video viewer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}

# Paths — app code lives in INSTALL_DIR, all user data lives in DATA_DIR.
# Updates replace INSTALL_DIR; DATA_DIR is never touched.
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=AURORA_INSTALL_DIR=${INSTALL_DIR}
Environment=AURORA_DATA_ROOT=${DATA_DIR}
Environment=AURORA_DB_PATH=${DATA_DIR}/database/aurora.db
Environment=AURORA_THUMB_DIR=${DATA_DIR}/cache/thumbs
Environment=AURORA_DATA_DIR=${DATA_DIR}/data

ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  info "Starting $SERVICE_NAME …"
  systemctl restart "$SERVICE_NAME"
  ok "Service installed and started."
}

# ── Health check ─────────────────────────────────────────────────────────────
health_check() {
  info "Waiting for Aurora to respond on port ${PORT} …"
  if node -e '
    const http=require("http"); let n=0;
    (function w(){
      const req=http.get({host:"127.0.0.1",port:'"$PORT"',path:"/health",timeout:2000},r=>{
        if(r.statusCode===200){console.log("up");process.exit(0);} else retry();
      });
      req.on("error",retry); req.on("timeout",()=>{req.destroy();retry();});
      function retry(){ if(++n>30){process.exit(1);} setTimeout(w,1000); }
    })();
  '; then
    ok "Aurora is up and healthy."
    return 0
  fi
  err "Aurora did not become healthy within 30s."
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager 2>/dev/null || tail -n 30 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo "──────────────────────────────────────────────"
  echo "  Aurora Photos installer"
  echo "──────────────────────────────────────────────"
  require_root
  detect_pkg_mgr

  ensure_node

  # perl  — powers bundled exiftool (photo/video metadata)
  # sudo  — used by the app to mount SMB/NFS shares
  # ffmpeg — generates video poster thumbnails
  # cifs-utils / nfs-common — mount network shares for import
  # unzip — required by the in-app software update mechanism
  install_pkg perl yes
  install_pkg sudo no
  install_pkg ffmpeg no
  install_pkg cifs no
  install_pkg nfs no
  install_pkg unzip yes

  # Stop service FIRST so the DB is not being written during migration.
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Stopping $SERVICE_NAME before data migration…"
    systemctl stop "$SERVICE_NAME" || true
  fi
  setup_data_dir
  deploy_app
  ensure_deps
  verify_native
  install_service
  health_check

  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -z "$ip" ] && ip="<this-server-ip>"
  local ver; ver="$(node -e "try{const v=require('${INSTALL_DIR}/version.json');process.stdout.write(v.version);}catch(e){process.stdout.write('?');}" 2>/dev/null || echo '?')"
  echo
  ok "Aurora Photos ${ver} is installed and running."
  echo "──────────────────────────────────────────────"
  echo -e "  Open:       ${C_G}http://${ip}:${PORT}/aurora${C_0}"
  echo    "              http://localhost:${PORT}/aurora"
  echo
  echo    "  Software:   ${INSTALL_DIR}     (replaced by updates)"
  echo    "  Data:       ${DATA_DIR}  (NEVER touched by updates)"
  echo
  echo    "  Manage:     systemctl {status|restart|stop} ${SERVICE_NAME}"
  echo    "  Logs:       journalctl -u ${SERVICE_NAME} -f"
  echo "──────────────────────────────────────────────"
  echo "  Next: open Aurora → Settings → Import photos → add a local path or SMB/NFS share."
}

main "$@"
