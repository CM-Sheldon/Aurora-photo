# Aurora Photos — self-hosted photo & video viewer

A local-first photo library: fast virtualized grid, world map of where your photos
were taken, albums and share links, powerful fuzzy search, Live Photo support, and
import from local folders or SMB/NFS network shares. Your originals are never
modified — Aurora only builds an index and thumbnail cache.

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

## Run it on a clean box

Give Aurora its **own dedicated container or VM** (a fresh Debian/Ubuntu LXC or
small VM is ideal). The installer adds system packages, installs Node.js if
needed, and sets up a systemd service that runs as root — it has **not been
tested on servers shared with other software**, and running it alongside other
services is at your own risk.

## Install

On the fresh server:

```bash
curl -fsSL https://raw.githubusercontent.com/CM-Sheldon/Aurora-photo/main/get-aurora.sh | sudo bash
```

That downloads the latest release and runs the installer. When it finishes it
prints a URL like `http://<server-ip>:8080/aurora` — open it in a browser.
**The first visitor sets up the admin account** (username + 4-digit PIN); from
then on the app requires login, and the admin can add users and roles from
**Settings → Users & roles**.

Prefer not to pipe a script into `sudo bash`? Download the installer zip from the
[latest release](https://github.com/CM-Sheldon/Aurora-photo/releases/latest),
extract it, and run `sudo ./aurora-photos/install.sh`. The installer is
idempotent — if anything fails, fix it and run it again; user data is preserved.

## Updating

Everything is built in — no command line needed.

Open **Settings → System**. Aurora checks GitHub for the newest release and shows
the changelog; one click on **Update now** downloads it, applies it, and restarts.
A rollback snapshot and a database backup are taken automatically before every
install, and a failed update reverts to the previous version on its own.

**Your data (photo index, thumbnails, tags, favourites, users, albums) is never
touched by updates.**

## Highlights

- **Library** — virtualized grid that stays fluid at 100k+ items, month headers,
  a dual-thumb time-range slider, and a toolbar that gets out of the way as you
  scroll.
- **Search that just works** — type anything (`cyprus 2019`, `iphone videos`, a
  tag name). Matches places, cameras, dates, file names and tags, auto-completes
  partial words, and corrects typos.
- **Tags & smart tagging** — tag one photo of a trip and Aurora offers to tag the
  rest of that trip (same country, same stretch of dates) in one click.
- **Places** — your photos on a world map with offline place names (bundled
  dataset, no API keys), clustering, and a timeline filter that narrows the map
  to any date range.
- **Albums & sharing** — manual albums, auto month events, On This Day memories,
  and public share links for individual albums.
- **Live Photos** — stills pair with their motion clips and play in place.
- **Privacy** — passcode-protected hidden album, duplicate detection, and
  soft-remove (photos leave the library but originals stay on disk, undoable
  from Settings).
- **Users, roles & audit** — per-user accounts with fine-grained permissions,
  per-account themes and avatars, and an audit log of sign-ins and actions.

## Where things live

| Path | Purpose |
|------|---------|
| `/opt/aurora-photos/` | **Software** — replaced entirely by updates. |
| `/var/lib/aurora-photos/` | **Data** — photo index, thumbnails, place-name dataset. **Never touched by updates.** |

## Importing from a NAS inside a container

Mounting SMB/NFS shares **from inside a container** needs the kernel capability
to mount filesystems, which unprivileged containers don't have. Pick one:

- **Privileged LXC** — on Proxmox set `unprivileged: 0` and
  `features: nesting=1,mount=nfs;cifs` in the container config; Aurora can then
  mount shares from its own UI.
- **Bind mount from the host** — mount the share on the host and pass it into the
  container (`mp0: /mnt/nas-photos,mp=/import/photos,ro=1`), then import from
  **Local folder** → `/import/photos`. Same idea for Docker
  (`-v /mnt/nas-photos:/import/photos:ro`).
- **Full VM** — the guest kernel handles its own mounts; no restrictions.
