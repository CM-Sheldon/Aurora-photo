# Aurora Photos — Development & Release Guide

## Layout

```
aurora-photos/            ← repo root (this)
├─ install.sh             fresh-install script (sets up systemd, data dir, deps)
├─ app/                   the application (this is what gets deployed)
│  ├─ server.js
│  ├─ version.json        ← single source of truth for the version
│  ├─ src/ views/ public/ scripts/ data/cities.tsv   (UI: views/partials + public/ui)
│  └─ package.json
├─ scripts/build-release.sh   builds the installer + update zips
├─ tools/ui-check/        headless browser checks for the UI (never deployed)
└─ .github/workflows/release.yml   CI that publishes a Release on a version tag
```

## Front-end map (Aurora 2)

The web UI is plain HTML/CSS/JS — no build step. One page, `/aurora`:

| Where | What |
|-------|------|
| `app/views/aurora.ejs` | Shell: `<head>`, the partial includes, and the ordered CSS/JS lists |
| `app/views/partials/*.ejs` | Markup per area: `library`, `places`, `collections` (+ detail view), `search`, `settings`, `viewer`, `overlays`, `sidebar`, `tabbar`, `icons` (SVG sprite) |
| `app/public/ui/css/` | `tokens` (all colours/themes) · `base` (shell, nav, glass, lists, sheets, dialogs, menus) · `grid` · `viewer` · `screens` · `settings` |
| `app/public/ui/js/` | Classic scripts sharing one global scope, loaded in the order listed in `aurora.ejs` |

JS modules: `core` (state, helpers, permissions, theme, `switchScreen`, `ScrollChrome`) ·
`sheets` (bottom sheets, `uiConfirm`/`uiPrompt`, `openMenu`, date-range sheet) ·
`grid` (`VirtualGrid` — every photo grid, zoom levels, swipe-select, long-press) ·
`library` · `viewer` (gestures, filmstrip, info sheet) · `select` (bulk actions, share and album pickers) ·
`search` · `places` · `collections` (detail view, albums, Hidden, Recently removed) ·
`settings` (settings stack, import, captions, duplicates, maintenance, **the updater**) ·
`admin` (`/me`, account sheet, users, roles, activity log) · `boot`.

Rules the tests in `app/tests/ui-regressions.test.js` enforce:

- Every `/ui` URL carries `?v=<build>` — **bump `version.json` `build` on every deploy**.
- Inline `onclick=` handlers must name functions that exist in `/ui/js`.
- `backdrop-filter` only on allow-listed small floating pieces, never `saturate()`
  (a blurred full-width bar over a scrolling grid janked iPhone scrolling in v1.5).
- Live Photo hover previews only for a real mouse (`pointerType === 'mouse'`).
- No third-party fonts or scripts — the app must work with no internet.

Also: element ids in the partials are read by the JS (grep before renaming), and
controls are permission-gated with `data-perm` / `data-perm-any` (the server
enforces every permission regardless).

To check the UI in a real browser engine, use `tools/ui-check/` (headless
iPhone + desktop screenshots, touch-gesture tests, scroll perf) against a
throwaway copy started by `tools/ui-check/dev-server.sh`.

The repo holds **code only**. Real data (the SQLite DB, thumbnail cache) lives on
the server under `/var/lib/aurora-photos/` and is never committed and never
touched by updates.

## Environments on the server

| Path | Role |
|------|------|
| `~/aurora-photos/` (your checkout) | this git repo — **edit here** |
| `/opt/aurora-photos/` | the running install (replaced by updates) |
| `/var/lib/aurora-photos/` | data (DB, thumbs) — never touched |

`aurora-photos.service` (systemd) runs the app on port 8080 at `/aurora`.

## Day-to-day loop

1. Edit under `app/` in this checkout.
2. **Bump `app/version.json`** (`version` for releases, `build` for every deploy —
   the in-app stale-build detector compares `build` against `/api/aurora/version`).
3. Deploy to the running instance for testing:
   ```bash
   sudo cp -a app/<changed files> /opt/aurora-photos/<same path>
   sudo systemctl restart aurora-photos
   ```
4. Commit and push:
   ```bash
   git add -A && git commit -m "…" && git push
   ```

## Cutting a release

The version tag drives everything; CI builds the zips and publishes the Release.

```bash
# 1. Make sure app/version.json "version" is the release version (e.g. 1.5.1).
# 2. Commit, then tag and push the tag:
git tag v1.5.1
git push origin v1.5.1
```

CI (`.github/workflows/release.yml`) then:
- verifies the tag matches `app/version.json`,
- runs `scripts/build-release.sh`,
- creates a GitHub Release `v1.5.1` with two artifacts attached:
  - `aurora-photos-installer-1.5.1.zip` — fresh install
  - `aurora-photos-update-1.5.1.zip` — in-place update (Settings → Software Update)

### Build the zips locally (optional)

```bash
bash scripts/build-release.sh      # → dist/*.zip
```

## Artifact shapes (for reference)

- **Installer**: top dir `aurora-photos/` with `install.sh` + `app/` (incl.
  `data/cities.tsv`). Extract, then `./aurora-photos/install.sh`.
- **Update**: single dir `aurora-photos-<version>/` with only the code items the
  updater swaps (`server.js package.json package-lock.json version.json src views
  public scripts`) — no data, no `node_modules`. Consumed by
  `app/scripts/apply-update.sh` via the in-app updater.
