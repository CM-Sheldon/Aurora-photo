# Aurora Photos — self-hosted photo & video viewer

A local-first photo library: fast virtualized grid, world map of where your photos
were taken, albums, powerful fuzzy search, Live Photo support, and import from local
folders or SMB/NFS network shares. Your originals are never modified — Aurora only
builds an index and thumbnail cache.

Highlights:

- **Tags & smart tagging** — tag any photo from its info panel. Tag one photo of a
  trip (e.g. *Cyprus Holiday 2024*) and Aurora finds the rest of that trip (same
  place, same stretch of dates) and offers to tag them all in one click. Manage,
  rename and merge tags from Settings. Tags are fully searchable.
- **Select, tag & share** (v1.3) — tap **Select** (Library or Search), then tap or
  **drag** across photos to multi-select. Add/remove tags in bulk, or **Share** the
  selection (native share sheet where available, otherwise a single-file or zip
  download).
- **Timeline by month** (v1.3) — the time-range slider is month-precision, and the
  Library shows month/year section headers as you scroll, with thumbnails prefetched
  ahead so they're ready before you reach them.
- **Map** — country-name labels appear as you zoom, and your places are labelled
  once you zoom in close (declutters automatically; outlines stay smooth).
- **Search that just works** — type anything (`cyprus 2019`, `iphone videos`,
  `favourites`, a tag name). Matches places, countries, cameras, years, months, file
  names and tags, auto-wildcards partial words, and corrects typos (`bournmouth` →
  Bournemouth).
- **Places** — pins are named from a bundled offline city dataset; click a pin for a
  preview, then **View all** to open the full set in the search results page.
- **Live Photos** play their motion clip directly over the still.
- **Settings & Import** live on one screen, with clear actions and instant feedback.

## Directory layout

After installation two directories are created:

| Path | Purpose |
|------|---------|
| `/opt/aurora-photos/` | **Software** — app code, Node dependencies. Replaced entirely by updates. |
| `/var/lib/aurora-photos/` | **Data** — photo index, thumbnails, geocoder dataset. **Never touched by updates.** |

### What lives in the data directory

```
/var/lib/aurora-photos/
  database/aurora.db      — SQLite photo index (favourites, places, import history)
  cache/thumbs/           — generated thumbnail cache
  data/cities.tsv         — offline place-name dataset (bundled, ~2.4 MB; see below)
  update-status.json      — written by the update mechanism
  update.log              — log of past in-app update runs
```

## Install (fresh Linux server)

1. Extract this zip and `cd` into the extracted folder:

   ```bash
   unzip aurora-photos-installer.zip
   cd aurora-photos
   ```

2. Run the installer as root:

   ```bash
   sudo ./install.sh
   ```

3. When it finishes it prints the URL, e.g. `http://<server-ip>:8080/aurora`.

The installer is **idempotent** — if anything goes wrong, fix it and run
`sudo ./install.sh` again. It preserves all user data across re-runs.

### Options

```bash
sudo PORT=9000 ./install.sh                 # serve on a different port
sudo INSTALL_DIR=/srv/aurora ./install.sh   # install app somewhere else
sudo DATA_DIR=/mnt/data/aurora ./install.sh # store data somewhere else
```

## What it installs

- **Node.js 20** (only if a suitable Node isn't already present)
- **perl** (powers the bundled exiftool for reading photo/video metadata)
- **ffmpeg** (generates video poster thumbnails) — *recommended*
- **cifs-utils / nfs-common** (to import from SMB / NFS shares) — *recommended*
- **unzip** (required for the in-app software update mechanism)
- The Aurora app under `/opt/aurora-photos`, run by a **systemd** service
  (`aurora-photos`) that auto-restarts and starts on boot.

The installer runs `npm install` on the target to fetch the app's Node dependencies
(the server needs internet access to `registry.npmjs.org` during install — it retries
on failure and never hangs).

## Updating

In-app software updates are available from **Settings → Software Update**.

1. Place an update zip on the server (e.g. via `scp`).
2. Open Aurora → Settings → Software Update.
3. Enter the full path to the zip file and click **Apply Update**.
4. Aurora stops, applies the new code, runs `npm install`, and restarts.
5. **All user data (photos index, thumbnails, favourites) is preserved.**

The update status is polled while the service is down and the page reloads
automatically once the new version is running.

### Place names on the map

The map resolves GPS coordinates to city names using a bundled offline dataset
(~69k cities) installed to `/var/lib/aurora-photos/data/cities.tsv`. Names are
applied automatically as photos are imported — no network, no API keys.

- **Already-imported library:** open **Settings → Maintenance → Name places on map**
  to fill in names for places imported before the dataset was present.
- **Custom dataset:** replace `cities.tsv` (`name⇥lat⇥lon⇥country` per line) and click
  *Name places on map* (or restart the service).

> Note: the dataset is **data**, not code, so software updates never overwrite it —
> a fresh install seeds it; updates leave whatever you have in place.

### Tagging & smart tagging

Open any photo, then use the **Info** panel (ⓘ in the lightbox, or long-press / right-click
a grid tile) to add tags. Tags appear as a facet on the **Search** screen and match
free-text search, so `cyprus holiday` finds everything tagged that way.

When you add a tag, Aurora looks at the photo's date and location and offers to apply
the same tag to the rest of that **trip** — the contiguous run of photos in the same
country around that date. One click tags the whole holiday. The suggestion is
conservative (same country, one continuous stretch) so it won't sweep in everyday
photos from home.

## Manage it

```bash
systemctl status aurora-photos
systemctl restart aurora-photos
journalctl -u aurora-photos -f      # live logs
```

## Notes

- Importing from network shares mounts them read-only and needs root (which is why
  the service runs as root by default). To run as a non-root user instead:
  `sudo SERVICE_USER=aurora ./install.sh` (you'll then need a sudoers rule allowing
  that user to `mount`/`umount`).
- On RHEL/CentOS, `ffmpeg` may require the EPEL/RPM Fusion repos; without it photos
  still work, only video thumbnails are skipped.
