#!/usr/bin/env bash
#
# Aurora Photos — one-line installer bootstrap.
#
# This script is meant to be piped into bash:
#
#   curl -fsSL https://raw.githubusercontent.com/CM-Sheldon/Aurora-photo/main/get-aurora.sh | sudo bash
#
# It looks up the latest release on GitHub, downloads the installer zip,
# extracts it to a temp directory, and hands off to the real ./install.sh
# inside that zip. All installer options (PORT, INSTALL_DIR, DATA_DIR,
# SERVICE_USER) are forwarded from the calling environment, so:
#
#   curl -fsSL <this-url> | sudo PORT=9000 bash
#
# also works. Safe to re-run — install.sh itself is idempotent and preserves
# all user data across re-runs.

set -Eeuo pipefail

REPO="${AURORA_REPO:-CM-Sheldon/Aurora-photo}"
API="https://api.github.com/repos/${REPO}/releases/latest"

C_R='\033[0;31m'; C_G='\033[0;32m'; C_Y='\033[0;33m'; C_B='\033[0;36m'; C_0='\033[0m'
[ -t 1 ] || { C_R=; C_G=; C_Y=; C_B=; C_0=; }
info() { echo -e "${C_B}[*]${C_0} $*"; }
ok()   { echo -e "${C_G}[✓]${C_0} $*"; }
err()  { echo -e "${C_R}[✗]${C_0} $*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "Please run as root:  curl -fsSL <url> | sudo bash"
  exit 1
fi

command -v curl  >/dev/null || { err "curl is required.";  exit 1; }
command -v unzip >/dev/null || {
  info "Installing unzip…"
  if   command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq unzip
  elif command -v dnf     >/dev/null; then dnf install -y -q unzip
  elif command -v yum     >/dev/null; then yum install -y -q unzip
  else err "unzip missing and no known package manager (apt-get/dnf/yum)."; exit 1
  fi
}

info "Looking up the latest Aurora Photos release from ${REPO}…"
# Pull the installer zip's download URL from the GitHub Releases API. We match
# on the artifact name so the release can add other files without breaking us.
DOWNLOAD_URL="$(
  curl -fsSL "$API" | \
    grep -oE '"browser_download_url": *"[^"]*aurora-photos-installer[^"]*\.zip"' | \
    head -n1 | \
    sed -E 's/.*"([^"]+)"$/\1/'
)"
[ -n "$DOWNLOAD_URL" ] || { err "Could not find an installer zip on the latest release."; exit 1; }
ok "Found: $DOWNLOAD_URL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/aurora-installer.zip"

info "Downloading installer…"
curl -fSL --retry 3 -o "$ZIP" "$DOWNLOAD_URL"
ok "Downloaded $(du -h "$ZIP" | cut -f1)"

info "Extracting…"
unzip -q "$ZIP" -d "$TMP"

# The installer zip contains a top-level `aurora-photos/` dir with install.sh.
INSTALLER="$(find "$TMP" -maxdepth 2 -name install.sh -type f | head -n1)"
[ -x "$INSTALLER" ] || chmod +x "$INSTALLER" 2>/dev/null || true
[ -f "$INSTALLER" ] || { err "install.sh not found in the release zip."; exit 1; }

info "Running installer…"
# Exec so signals reach install.sh directly and its final exit code is ours.
exec bash "$INSTALLER"
