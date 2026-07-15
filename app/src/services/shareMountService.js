const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const MOUNT_BASE = '/media/photo-dedup-mounts';
const CRED_DIR = '/etc/aurora-shares';          // root-only credential files
const FSTAB_PATH = process.env.AURORA_FSTAB || '/etc/fstab';

function slugify(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 40);
}

function getMountPoint(shareId, host, shareName) {
  return path.join(MOUNT_BASE, `${shareId}_${slugify(host)}_${slugify(shareName)}`);
}

// Re-use an existing mountpoint for the same host+share so a reconnect re-links
// to the EXISTING photo index (asset paths already point at this dir) instead of
// creating a fresh, orphaned mountpoint. The leading id (timestamp) may differ;
// we match on the stable `_<host>_<share>` suffix.
// When multiple directories match (e.g. a duplicate was created), prefer the one
// already in fstab (persisted), then fall back to the alphabetically first entry
// (lowest timestamp = oldest = most likely the indexed one).
function findReusableMountPoint(host, shareName) {
  const suffix = `_${slugify(host)}_${slugify(shareName)}`;
  try {
    if (!fs.existsSync(MOUNT_BASE)) return null;
    const matches = fs.readdirSync(MOUNT_BASE)
      .filter(e => e.endsWith(suffix))
      .sort(); // alphabetical = lowest timestamp first
    if (!matches.length) return null;
    if (matches.length === 1) return path.join(MOUNT_BASE, matches[0]);
    // Multiple matches — prefer the one already in fstab.
    try {
      const fstab = fs.readFileSync(FSTAB_PATH, 'utf8');
      for (const m of matches) {
        const mp = path.join(MOUNT_BASE, m);
        if (fstab.split('\n').some(line => line.split(/\s+/)[1] === mp)) return mp;
      }
    } catch { /* fall through */ }
    return path.join(MOUNT_BASE, matches[0]);
  } catch { /* fall through */ }
  return null;
}

function ensureMountBase() {
  if (!fs.existsSync(MOUNT_BASE)) fs.mkdirSync(MOUNT_BASE, { recursive: true });
}

// ── Reboot persistence: /etc/fstab + root-only credentials file ──────────────
function credPathFor(mountPoint) {
  return path.join(CRED_DIR, path.basename(mountPoint) + '.cred');
}

// Read fstab and drop any line whose mountpoint (2nd field) == target. Reads the
// real file first (throws → caller aborts rather than risk clobbering). Comments
// and blank lines are preserved (their 2nd field never equals a mountpoint).
function fstabWithout(targetMount) {
  const raw = fs.readFileSync(FSTAB_PATH, 'utf8');
  return raw.split('\n').filter(line => line.split(/\s+/)[1] !== targetMount);
}

// Atomic write (tmp + rename) so fstab is never left half-written.
function writeFstab(lines) {
  const body = lines.join('\n').replace(/\n+$/, '') + '\n';
  const tmp = FSTAB_PATH + '.aurora.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, FSTAB_PATH);
}

// Persist a successful mount so it returns automatically after a reboot.
// Safety: only ever manages lines under MOUNT_BASE; every entry gets nofail so a
// down/missing NAS can never block boot.
async function persistMount({ source, mountPoint, fstype, credentials = null, readOnly = true, nfsVersion = '4', smbVersion = '3.1.1' }) {
  if (!mountPoint.startsWith(MOUNT_BASE)) return { persisted: false, error: 'refusing: outside mount base' };
  try {
    const opts = [readOnly ? 'ro' : 'rw', '_netdev', 'nofail'];
    if (fstype === 'cifs') {
      // Pin the SMB dialect that succeeded interactively so the reboot mount
      // doesn't fall back to failing auto-negotiation.
      opts.push(`vers=${smbVersion}`, 'uid=0', 'gid=0', 'iocharset=utf8', 'file_mode=0644', 'dir_mode=0755');
      if (credentials && credentials.username) {
        fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
        const cp = credPathFor(mountPoint);
        let body = `username=${credentials.username}\npassword=${credentials.password || ''}\n`;
        if (credentials.domain) body += `domain=${credentials.domain}\n`;
        fs.writeFileSync(cp, body, { mode: 0o600 });
        fs.chmodSync(cp, 0o600);
        opts.push(`credentials=${cp}`);
      } else {
        opts.push('guest');
      }
    } else if (fstype === 'nfs') {
      opts.push(`nfsvers=${nfsVersion}`, 'soft', 'timeo=30', 'retrans=2');
    } else {
      return { persisted: false, error: `persistence unsupported for ${fstype}` };
    }

    const line = `${source} ${mountPoint} ${fstype} ${opts.join(',')} 0 0`;
    const lines = fstabWithout(mountPoint);
    lines.push(line);
    writeFstab(lines);
    await execAsync('systemctl daemon-reload', { timeout: 10000 }).catch(() => {});
    return { persisted: true };
  } catch (err) {
    return { persisted: false, error: err.message };
  }
}

// Forget a persisted mount (called on explicit unmount) so it does NOT come back
// on the next reboot. Removes the fstab line and its credentials file.
async function unpersistMount(mountPoint) {
  if (!mountPoint.startsWith(MOUNT_BASE)) return;
  try {
    writeFstab(fstabWithout(mountPoint));
    try { fs.unlinkSync(credPathFor(mountPoint)); } catch { /* none */ }
    await execAsync('systemctl daemon-reload', { timeout: 10000 }).catch(() => {});
  } catch { /* best effort */ }
}

// Check if a path is currently mounted
async function isMounted(mountPoint) {
  try {
    const { stdout } = await execAsync(`findmnt --noheadings --output TARGET "${mountPoint}" 2>/dev/null`);
    return stdout.trim() === mountPoint;
  } catch { return false; }
}

// List all active photo-dedup mounts
async function listActiveMounts() {
  try {
    const { stdout } = await execAsync(`findmnt --noheadings --raw --output TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | grep "${MOUNT_BASE}"`);
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [target, source, fstype, options] = line.trim().split(/\s+/);
      return { target, source, fstype, options };
    });
  } catch { return []; }
}

// Mount SMB/CIFS share
async function mountSMB(shareId, host, shareName, options = {}) {
  const { username = '', password = '', domain = '', readOnly = true, persist = true } = options;
  ensureMountBase();

  // Re-use the existing mountpoint for this host+share if one exists (re-link).
  const mountPoint = findReusableMountPoint(host, shareName) || getMountPoint(shareId, host, shareName);
  fs.mkdirSync(mountPoint, { recursive: true });

  const creds = username ? { username, password, domain } : null;

  if (await isMounted(mountPoint)) {
    // Already mounted — still (re)write persistence so a reboot keeps it.
    if (persist) await persistMount({ source: `//${host}/${shareName}`, mountPoint, fstype: 'cifs', readOnly, credentials: creds });
    return { success: true, mountPoint, alreadyMounted: true };
  }

  const uid = process.getuid ? process.getuid() : 1000;
  const gid = process.getgid ? process.getgid() : 1000;

  const baseOpts = [`uid=${uid}`, `gid=${gid}`, 'iocharset=utf8', 'file_mode=0644', 'dir_mode=0755'];
  if (readOnly) baseOpts.push('ro');

  if (username) {
    baseOpts.push(`username=${username}`);
    if (password) baseOpts.push(`password=${password}`);
    if (domain) baseOpts.push(`domain=${domain}`);
  } else {
    baseOpts.push('guest', 'username=guest');
  }

  // SMB protocol version ladder. Modern kernels dropped SMB1 auto-negotiation, so
  // omitting vers= mounts against most real NAS boxes fail with EPERM ("Operation
  // not permitted"). We try 3.1.1 first (what current Synology / QNAP / Windows
  // Server 2016+ prefer and many enforce as the minimum), then 3.0, then 2.1 for
  // older Samba/Windows, and finally 1.0 as a last resort — that dialect is
  // deprecated for security so we surface a warning if it's what finally worked.
  const versionsToTry = ['3.1.1', '3.0', '2.1', '1.0'];
  let lastErr = null;
  let usedVers = null;
  for (const vers of versionsToTry) {
    const mountOpts = [...baseOpts, `vers=${vers}`];
    const cmd = `sudo mount -t cifs "//${host}/${shareName}" "${mountPoint}" -o ${mountOpts.join(',')}`;
    try {
      await execAsync(cmd, { timeout: 20000 });
      usedVers = vers;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Only continue the ladder for errors that look like a protocol mismatch.
      // Bad credentials, missing share, unreachable host etc. won't be fixed by
      // switching versions — stop early so the user sees the real error.
      const msg = String(err.message || '');
      const looksLikeProtocol =
        msg.includes('Operation not permitted') ||
        msg.includes('mount error(1)') ||
        msg.includes('mount error(112)') ||    // Host is down (dialect refused)
        msg.includes('protocol') ||
        msg.includes('Protocol not supported');
      if (!looksLikeProtocol) break;
    }
  }

  if (lastErr) {
    try { fs.rmdirSync(mountPoint); } catch {}
    const msg = sanitizeMountError(lastErr.message || '');
    const friendly = msg.includes('Connection refused') ? `Connection refused — is SMB running on ${host}?`
      : msg.includes('No route to host') || msg.includes('Network unreachable') ? `Cannot reach ${host} — check the IP and network`
      : msg.includes('LOGON_FAILURE') || msg.includes('NT_STATUS_LOGON_FAILURE') ? 'Wrong username or password'
      : msg.includes('NT_STATUS_ACCESS_DENIED') ? 'Access denied — check share permissions'
      : msg.includes('NT_STATUS_BAD_NETWORK_NAME') || msg.includes('does not exist') ? `Share "${shareName}" not found on ${host}`
      : msg.includes('Operation not permitted') || msg.includes('mount error(1)') ?
          (isUnprivilegedContainer()
            ? `Aurora is running in an unprivileged container, which can't mount SMB shares (the kernel rejects the mount syscall before it ever talks to ${host}). Either run Aurora in a privileged LXC (Proxmox: set unprivileged=0 and features=mount=nfs;cifs), or mount the share on the host and pass it in as a bind mount, or run Aurora in a full VM. See README → Installing in a container.`
            : `SMB negotiation failed (tried v3.1.1, v3.0, v2.1, v1.0). Check that SMB is enabled on ${host}, the account has access to "${shareName}", and run \`dmesg | tail\` for the kernel's reason.`)
      : msg.trim() || 'Mount failed — check host, share name, and credentials';
    return { success: false, error: friendly };
  }

  let persisted = false;
  if (persist) {
    // Persist with the version that actually worked so a reboot uses the same one.
    const p = await persistMount({
      source: `//${host}/${shareName}`, mountPoint, fstype: 'cifs',
      readOnly, credentials: creds, smbVersion: usedVers,
    });
    persisted = !!(p && p.persisted);
  }
  return {
    success: true,
    mountPoint,
    persisted,
    smbVersion: usedVers,
    warning: usedVers === '1.0' ? 'Mounted using SMB 1.0 (deprecated — consider enabling SMB 2/3 on your NAS)' : undefined,
  };
}

// Mount NFS share
async function mountNFS(shareId, host, exportPath, options = {}) {
  const { version = '4', readOnly = true, persist = true } = options;
  ensureMountBase();

  const mountPoint = findReusableMountPoint(host, exportPath) || getMountPoint(shareId, host, exportPath);
  fs.mkdirSync(mountPoint, { recursive: true });

  if (await isMounted(mountPoint)) {
    if (persist) await persistMount({ source: `${host}:${exportPath}`, mountPoint, fstype: 'nfs', readOnly, nfsVersion: version });
    return { success: true, mountPoint, alreadyMounted: true };
  }

  // timeo=30 = 3s, retrans=2 → gives up after ~6s if host unreachable
  let mountOpts = [`nfsvers=${version}`, 'soft', 'timeo=30', 'retrans=2', 'retry=0'];
  if (readOnly) mountOpts.push('ro');

  const cmd = `sudo mount -t nfs "${host}:${exportPath}" "${mountPoint}" -o ${mountOpts.join(',')}`;

  try {
    await execAsync(cmd, { timeout: 20000 });
    let persisted = false;
    if (persist) {
      const p = await persistMount({ source: `${host}:${exportPath}`, mountPoint, fstype: 'nfs', readOnly, nfsVersion: version });
      persisted = !!(p && p.persisted);
    }
    return { success: true, mountPoint, persisted };
  } catch (err) {
    try { fs.rmdirSync(mountPoint); } catch {}
    const msg = sanitizeMountError(err.message || '');
    // Distill kernel noise into something readable
    const friendly = msg.includes('Connection refused') ? `Connection refused — is NFS running on ${host}?`
      : msg.includes('No route to host') || msg.includes('Network unreachable') ? `Cannot reach ${host} — check the IP and network`
      : msg.includes('Permission denied') || msg.includes('access denied') ? `Access denied — check exports on ${host}`
      : msg.includes('No such file') ? `Export path not found on ${host}`
      : msg.trim() || 'Mount failed — check host, export path, and network';
    return { success: false, error: friendly };
  }
}

// Mount SSHFS share (fallback, uses FUSE - no root needed if fuse group is configured)
async function mountSSHFS(shareId, host, remotePath, options = {}) {
  const { username, port = 22, identityFile, password } = options;
  ensureMountBase();

  const mountPoint = findReusableMountPoint(host, remotePath) || getMountPoint(shareId, host, remotePath);
  fs.mkdirSync(mountPoint, { recursive: true });

  if (await isMounted(mountPoint)) return { success: true, mountPoint, alreadyMounted: true };

  const userHost = username ? `${username}@${host}` : host;
  let sshOpts = [`port=${port}`, 'StrictHostKeyChecking=no', 'reconnect', 'ServerAliveInterval=15'];
  if (identityFile) sshOpts.push(`IdentityFile=${identityFile}`);

  const cmd = `sshfs ${userHost}:${remotePath} "${mountPoint}" -o ${sshOpts.map(o => `${o}`).join(',')}`;

  try {
    await execAsync(cmd, { timeout: 15000 });
    return { success: true, mountPoint };
  } catch (err) {
    try { fs.rmdirSync(mountPoint); } catch {}
    return { success: false, error: sanitizeMountError(err.message) };
  }
}

// Unmount a share (and forget its reboot persistence)
async function unmountShare(mountPoint) {
  if (!mountPoint.startsWith(MOUNT_BASE)) {
    return { success: false, error: 'Safety check: can only unmount paths under ' + MOUNT_BASE };
  }
  try {
    await execAsync(`sudo umount "${mountPoint}" 2>/dev/null || sudo umount -l "${mountPoint}" 2>/dev/null`, { timeout: 10000 });
    await unpersistMount(mountPoint);
    try { fs.rmdirSync(mountPoint); } catch {}
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Mount a share by protocol
async function mountShare(shareRecord) {
  const { id, protocol, host, shareName, username, password, domain, options: extraOpts } = shareRecord;

  switch (protocol) {
    case 'smb':
      return mountSMB(id, host, shareName, { username, password, domain, ...extraOpts });
    case 'nfs':
      return mountNFS(id, host, shareName, extraOpts);
    case 'sshfs':
      return mountSSHFS(id, host, shareName, { username, ...extraOpts });
    case 'local':
      // Local path - no mount needed, just validate
      if (!fs.existsSync(shareRecord.path)) return { success: false, error: 'Path does not exist' };
      return { success: true, mountPoint: shareRecord.path };
    default:
      return { success: false, error: `Unknown protocol: ${protocol}` };
  }
}

// Strip credentials from error messages
// True when we're running inside an unprivileged LXC container — the case
// where `mount -t cifs` returns EPERM before the kernel ever contacts the NAS,
// because CAP_SYS_ADMIN in the container's user namespace isn't enough for
// mount syscalls that the host's user namespace doesn't allow. Cached because
// this is called from the error-path only.
let _uCtCache = null;
function isUnprivilegedContainer() {
  if (_uCtCache !== null) return _uCtCache;
  try {
    // /proc/self/status → CapEff bitmask. Container root that can't dmesg
    // (missing CAP_SYSLOG = bit 34 = 0x400000000) is the tell.
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const m = status.match(/^CapEff:\s*([0-9a-f]+)/mi);
    if (!m) return (_uCtCache = false);
    // BigInt because the mask is a 64-bit value.
    const cap = BigInt('0x' + m[1]);
    // CAP_SYSLOG = 34; CAP_SYS_ADMIN = 21. If BOTH are missing while we're
    // otherwise "root", we're in an unprivileged container.
    const missingSyslog = (cap & (1n << 34n)) === 0n;
    const missingSysAdmin = (cap & (1n << 21n)) === 0n;
    return (_uCtCache = missingSyslog || missingSysAdmin);
  } catch { return (_uCtCache = false); }
}

function sanitizeMountError(msg) {
  return msg.replace(/password=[^,\s]*/gi, 'password=***')
    .replace(/user=[^,\s]*/gi, 'user=***')
    .replace(/username=[^,\s]*/gi, 'username=***');
}

module.exports = {
  getMountPoint,
  findReusableMountPoint,
  isMounted,
  listActiveMounts,
  mountSMB,
  mountNFS,
  mountSSHFS,
  mountShare,
  unmountShare,
  persistMount,
  unpersistMount,
  MOUNT_BASE
};
