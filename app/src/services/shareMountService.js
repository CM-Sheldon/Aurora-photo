const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const MOUNT_BASE = '/media/photo-dedup-mounts';

function slugify(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 40);
}

function getMountPoint(shareId, host, shareName) {
  return path.join(MOUNT_BASE, `${shareId}_${slugify(host)}_${slugify(shareName)}`);
}

function ensureMountBase() {
  if (!fs.existsSync(MOUNT_BASE)) {
    fs.mkdirSync(MOUNT_BASE, { recursive: true });
  }
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
    const { stdout } = await execAsync(`findmnt --noheadings --output TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null | grep "${MOUNT_BASE}"`);
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [target, source, fstype, options] = line.trim().split(/\s+/);
      return { target, source, fstype, options };
    });
  } catch { return []; }
}

// Mount SMB/CIFS share
async function mountSMB(shareId, host, shareName, options = {}) {
  const { username = '', password = '', domain = '', readOnly = false } = options;
  ensureMountBase();

  const mountPoint = getMountPoint(shareId, host, shareName);
  fs.mkdirSync(mountPoint, { recursive: true });

  if (await isMounted(mountPoint)) return { success: true, mountPoint, alreadyMounted: true };

  const uid = process.getuid ? process.getuid() : 1000;
  const gid = process.getgid ? process.getgid() : 1000;

  let mountOpts = [`uid=${uid}`, `gid=${gid}`, 'iocharset=utf8', 'file_mode=0644', 'dir_mode=0755'];
  if (readOnly) mountOpts.push('ro');

  if (username) {
    mountOpts.push(`username=${username}`);
    if (password) mountOpts.push(`password=${password}`);
    if (domain) mountOpts.push(`domain=${domain}`);
  } else {
    mountOpts.push('guest', 'username=guest');
  }

  const cmd = `sudo mount -t cifs "//${host}/${shareName}" "${mountPoint}" -o ${mountOpts.join(',')}`;

  try {
    await execAsync(cmd, { timeout: 20000 });
    return { success: true, mountPoint };
  } catch (err) {
    try { fs.rmdirSync(mountPoint); } catch {}
    const msg = sanitizeMountError(err.message || '');
    const friendly = msg.includes('Connection refused') ? `Connection refused — is SMB running on ${host}?`
      : msg.includes('No route to host') || msg.includes('Network unreachable') ? `Cannot reach ${host} — check the IP and network`
      : msg.includes('LOGON_FAILURE') || msg.includes('NT_STATUS_LOGON_FAILURE') ? 'Wrong username or password'
      : msg.includes('NT_STATUS_ACCESS_DENIED') ? 'Access denied — check share permissions'
      : msg.includes('NT_STATUS_BAD_NETWORK_NAME') || msg.includes('does not exist') ? `Share "${shareName}" not found on ${host}`
      : msg.trim() || 'Mount failed — check host, share name, and credentials';
    return { success: false, error: friendly };
  }
}

// Mount NFS share
async function mountNFS(shareId, host, exportPath, options = {}) {
  const { version = '4', readOnly = false } = options;
  ensureMountBase();

  const mountPoint = getMountPoint(shareId, host, exportPath);
  fs.mkdirSync(mountPoint, { recursive: true });

  if (await isMounted(mountPoint)) return { success: true, mountPoint, alreadyMounted: true };

  // timeo=30 = 3s, retrans=2 → gives up after ~6s if host unreachable
  let mountOpts = [`nfsvers=${version}`, 'soft', 'timeo=30', 'retrans=2', 'retry=0'];
  if (readOnly) mountOpts.push('ro');

  const cmd = `sudo mount -t nfs "${host}:${exportPath}" "${mountPoint}" -o ${mountOpts.join(',')}`;

  try {
    await execAsync(cmd, { timeout: 20000 });
    return { success: true, mountPoint };
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

  const mountPoint = getMountPoint(shareId, host, remotePath);
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

// Unmount a share
async function unmountShare(mountPoint) {
  if (!mountPoint.startsWith(MOUNT_BASE)) {
    return { success: false, error: 'Safety check: can only unmount paths under ' + MOUNT_BASE };
  }
  try {
    await execAsync(`sudo umount "${mountPoint}" 2>/dev/null || sudo umount -l "${mountPoint}" 2>/dev/null`, { timeout: 10000 });
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
function sanitizeMountError(msg) {
  return msg.replace(/password=[^,\s]*/gi, 'password=***')
    .replace(/user=[^,\s]*/gi, 'user=***')
    .replace(/username=[^,\s]*/gi, 'username=***');
}

module.exports = {
  getMountPoint,
  isMounted,
  listActiveMounts,
  mountSMB,
  mountNFS,
  mountSSHFS,
  mountShare,
  unmountShare,
  MOUNT_BASE
};
