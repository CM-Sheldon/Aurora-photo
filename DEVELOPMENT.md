# Aurora Photos — Development & Release Guide

## Layout

```
aurora-photos/            ← repo root (this)
├─ install.sh             fresh-install script (sets up systemd, data dir, deps)
├─ app/                   the application (this is what gets deployed)
│  ├─ server.js
│  ├─ version.json        ← single source of truth for the version
│  ├─ src/ views/ public/ scripts/ data/cities.tsv
│  └─ package.json
├─ scripts/build-release.sh   builds the installer + update zips
└─ .github/workflows/release.yml   CI that publishes a Release on a version tag
```

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
