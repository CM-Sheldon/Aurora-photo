/**
 * Public album shares — the ONLY unauthenticated media surface in Aurora.
 *
 * Mounted at /api/aurora/share BEFORE the requireAuth guard (see server.js).
 * Everything here is keyed by an unguessable 128-bit share token, and every
 * media request re-checks that the asset is (a) a member of the shared album
 * and (b) still visible (not hidden / not a duplicate / not a live-motion
 * clip) — so revoking a share or hiding a photo takes effect immediately.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../services/auroraDbService');
const { getThumbPath, ensureThumb, videoMimeType } = require('../services/auroraIndexerService');

const VISIBLE = 'a.is_live_motion=0 AND a.hidden=0 AND a.duplicate_of IS NULL';

async function albumForToken(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  return db.get('SELECT id, name FROM albums WHERE share_token = ?', [token]);
}

// The asset row, but only if it's a visible member of the shared album.
async function sharedAsset(token, assetId) {
  const album = await albumForToken(token);
  if (!album) return null;
  return db.get(
    `SELECT a.id, a.path, a.kind FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
      WHERE aa.album_id = ? AND a.id = ? AND ${VISIBLE}`,
    [album.id, parseInt(assetId, 10) || 0]
  );
}

// GET /api/aurora/share/:token — album name + visible assets (chronological)
router.get('/:token', async (req, res) => {
  try {
    const album = await albumForToken(req.params.token);
    if (!album) return res.status(404).json({ error: 'This share link is no longer available' });
    const assets = await db.all(
      `SELECT a.id, a.kind, a.taken_at, a.duration_s
         FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
        WHERE aa.album_id = ? AND ${VISIBLE}
        ORDER BY CASE WHEN a.taken_at IS NULL THEN 1 ELSE 0 END, a.taken_at ASC, a.id ASC`,
      [album.id]
    );
    res.json({ name: album.name, count: assets.length, assets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/aurora/share/:token/thumb/:id?size=grid|full
router.get('/:token/thumb/:id', async (req, res) => {
  try {
    const asset = await sharedAsset(req.params.token, req.params.id);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    const size = req.query.size === 'full' ? 'full' : 'grid';
    let file = getThumbPath(asset.id, size);
    if (!fs.existsSync(file)) file = await ensureThumb(asset.id, asset.path, asset.kind, size);
    if (file && fs.existsSync(file)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(file);
    }
    res.status(404).json({ error: 'Thumbnail not available' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/aurora/share/:token/video/:id — range-request streaming for shared videos
router.get('/:token/video/:id', async (req, res) => {
  try {
    const asset = await sharedAsset(req.params.token, req.params.id);
    if (!asset || asset.kind !== 'video') return res.status(404).json({ error: 'Not found' });
    if (!fs.existsSync(asset.path)) return res.status(404).json({ error: 'File not found' });

    const total = fs.statSync(asset.path).size;
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr);
      const end = endStr ? parseInt(endStr) : Math.min(start + 10 * 1024 * 1024, total - 1);
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': videoMimeType(asset.path),
      });
      fs.createReadStream(asset.path, { start, end }).pipe(res);
    } else {
      res.set({ 'Content-Length': total, 'Content-Type': videoMimeType(asset.path), 'Accept-Ranges': 'bytes' });
      fs.createReadStream(asset.path).pipe(res);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
