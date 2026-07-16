# Aurora Photos — self-hosted photo & video viewer

A local-first photo library: fast virtualized grid, world map of where your photos
were taken, albums, powerful fuzzy search, Live Photo support, and import from local
folders or SMB/NFS network shares. Your originals are never modified — Aurora only
builds an index and thumbnail cache.

## Disclaimer

**This software was written with the help of AI (Claude).** It is provided
**as-is**, without warranty of any kind — express or implied — including but not
limited to warranties of merchantability, fitness for a particular purpose, or
non-infringement.

The authors and contributors accept **no responsibility and no liability** for
any loss of data, file corruption, hardware or system damage, downtime, security
incidents, or any other direct, indirect, incidental, consequential or special
damages arising from installing, running, updating or otherwise using this
software. Aurora reads your photo originals to build its index and never modifies
them, and updates take a code snapshot + database backup before applying, but
those safeguards are best-effort — **the only backup you can rely on is the one
you keep yourself.** Please maintain independent backups of any photos or data
you can't afford to lose.

Use of this software is entirely at your own risk.

## Install (one line)

On a fresh Linux server:

```bash
curl -fsSL https://raw.githubusercontent.com/CM-Sheldon/Aurora-photo/main/get-aurora.sh | sudo bash
```

That downloads the latest release, extracts it and runs the installer. When it
finishes it prints a URL like `http://<server-ip>:8080/aurora`. Open that in your
browser — **the first visitor sets up the admin account**.

Prefer to download the zip yourself? See [Install (manual)](#install-manual) below.

## Highlights

- **Users, roles & audit log** — first visitor to a fresh install claims the admin
  account (username + 4-digit PIN). Admin can add more users, hand out custom roles
  from an ACL checkbox tree (settings access, hidden-album access, tagging rights,
  download originals, delete, etc.), reset PINs, and see who did what in an audit
  log. Two roles ship built-in: `admin` (everything) and `user` (view + favorite).
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

## Install (manual)

If you'd rather not pipe a script into `sudo bash`, download the installer zip
manually from the [latest release](https://github.com/CM-Sheldon/Aurora-photo/releases/latest)
and run it yourself:

1. Extract this zip and `cd` into the extracted folder:

   ```bash
   unzip aurora-photos-installer-*.zip
   cd aurora-photos
   ```

2. Run the installer as root:

   ```bash
   sudo ./install.sh
   ```

3. When it finishes it prints the URL, e.g. `http://<server-ip>:8080/aurora`.

The installer is **idempotent** — if anything goes wrong, fix it and run
`sudo ./install.sh` again. It preserves all user data across re-runs.

### First-run: claim admin

The first person to open `/aurora` on a fresh install lands on a **Set up admin**
screen — pick a username and a 4-digit PIN and that account becomes the admin.
From then on the app requires login, and only the admin can add more users. You
can add users any time from **Settings → Users & roles**.

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

### Users & roles

Aurora ships with two built-in roles:

| Role  | What they can do |
|-------|------------------|
| `admin` | Everything: browse, tag, hide, download originals, delete, manage users, edit roles, apply updates, view the audit log. |
| `user`  | View the library and mark favorites — nothing else by default. Intended for family members who should browse but not curate. |

You can also create **custom roles** from **Settings → Users & roles → New role**
and grant any combination of these permissions:

- `photos.view`, `photos.favorite`, `photos.tag`, `photos.download`
- `photos.hidden` — see and manage the hidden album
- `photos.delete` — resolve duplicates and remove assets
- `settings.view`, `settings.manage`
- `users.manage`, `roles.manage`, `audit.view`

Sessions live in a `httpOnly` cookie and roll for 30 days on activity. PINs are
hashed with scrypt; five wrong attempts locks the account for 15 min. Resetting
a user's PIN signs them out of every device.

Every login, permission change, PIN reset and destructive action is recorded in
**Settings → Audit log** (admin only).

### Tagging & smart tagging

Open any photo, then use the **Info** panel (ⓘ in the lightbox, or long-press / right-click
a grid tile) to add tags. Tags appear as a facet on the **Search** screen and match
free-text search, so `cyprus holiday` finds everything tagged that way.

When you add a tag, Aurora looks at the photo's date and location and offers to apply
the same tag to the rest of that **trip** — the contiguous run of photos in the same
country around that date. One click tags the whole holiday. The suggestion is
conservative (same country, one continuous stretch) so it won't sweep in everyday
photos from home.

## Installing in a container (Proxmox LXC, Docker, etc.)

Aurora runs fine in a container, but mounting **SMB/NFS shares from inside the
container** needs the container to have the kernel capability to mount
filesystems. An **unprivileged** container doesn't have that, so any attempt
from the UI fails with `Operation not permitted` before it ever contacts your
NAS.

Three ways to make this work — pick the one that fits your setup:

**A. Make the container privileged.** On Proxmox, edit
`/etc/pve/lxc/<CTID>.conf` on the host and set:
```
unprivileged: 0
features: nesting=1,mount=nfs;cifs
```
Restart the container. Aurora can now mount shares from its own UI.

**B. Keep it unprivileged, bind-mount from the host.** Mount the share on the
Proxmox host itself (via `/etc/fstab`) and expose it into the container:
```
# host /etc/fstab
//nas.local/Photos  /mnt/nas-photos  cifs  credentials=/root/.smbcred,ro,_netdev,nofail  0 0

# host /etc/pve/lxc/<CTID>.conf
mp0: /mnt/nas-photos,mp=/import/photos,ro=1
```
Restart the container, then in Aurora import from **Local folder** → `/import/photos`.

**C. Run Aurora in a full VM** (KVM/QEMU) instead of a container. The guest
kernel handles its own mounts and there's no capability restriction.

Docker is the same story — mount the share on the host and pass it in with
`-v /mnt/nas-photos:/import/photos:ro`.

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
