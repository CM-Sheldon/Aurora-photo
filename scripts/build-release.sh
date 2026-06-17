#!/usr/bin/env bash
#
# Aurora Photos — release builder.
#
# Produces two artifacts in dist/ from the repo, matching the conventions that
# install.sh and app/scripts/apply-update.sh expect:
#
#   aurora-photos-installer-<version>.zip
#       Full fresh install. Top-level dir `aurora-photos/` containing
#       README.md, install.sh and app/ (incl. data/cities.tsv). The user
#       extracts it and runs ./aurora-photos/install.sh.
#
#   aurora-photos-update-<version>.zip
#       In-place update. Single top-level dir `aurora-photos-<version>/` holding
#       ONLY the code items the updater swaps (no data, no node_modules). Fed to
#       Settings → Software Update (apply-update.sh).
#
# Usage:  bash scripts/build-release.sh
# Run from anywhere — it locates the repo root from its own path.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v zip >/dev/null || { echo "ERROR: 'zip' is required (apt-get install zip)"; exit 1; }
git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "ERROR: not a git repo — release builds package committed content"; exit 1; }

# Code items the updater replaces (must mirror apply-update.sh CODE_ITEMS).
CODE_ITEMS=(server.js package.json package-lock.json version.json src views public scripts)

DIST="$REPO_ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Export the committed tree (HEAD). Reproducible, and excludes untracked runtime
# cruft (app/cache, node_modules, the DB, etc.) by construction. NB: this packages
# the last commit — commit your changes before building/tagging a release.
EXPORT="$STAGE/export"
mkdir -p "$EXPORT"
git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$EXPORT"

[ -f "$EXPORT/app/version.json" ] || { echo "ERROR: app/version.json not in HEAD"; exit 1; }
VERSION="$(node -p "require('$EXPORT/app/version.json').version" 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "ERROR: could not read version from app/version.json"; exit 1; }

echo "Building Aurora Photos $VERSION (from $(git -C "$REPO_ROOT" rev-parse --short HEAD)) …"

# ── Installer zip ──────────────────────────────────────────────────────────
INST="$STAGE/installer/aurora-photos"
mkdir -p "$INST"
cp -a "$EXPORT/README.md" "$EXPORT/install.sh" "$INST/"
cp -a "$EXPORT/app" "$INST/app"
( cd "$STAGE/installer" && zip -rq "$DIST/aurora-photos-installer-$VERSION.zip" aurora-photos )

# ── Update zip ─────────────────────────────────────────────────────────────
UPD="$STAGE/update/aurora-photos-$VERSION"
mkdir -p "$UPD"
for item in "${CODE_ITEMS[@]}"; do
  [ -e "$EXPORT/app/$item" ] && cp -a "$EXPORT/app/$item" "$UPD/$item"
done
[ -f "$UPD/server.js" ] || { echo "ERROR: update staging missing server.js"; exit 1; }
( cd "$STAGE/update" && zip -rq "$DIST/aurora-photos-update-$VERSION.zip" "aurora-photos-$VERSION" )

echo ""
echo "Artifacts in dist/:"
( cd "$DIST" && ls -lh *.zip | awk '{print "  " $9 "  (" $5 ")"}' )
echo "Done."
