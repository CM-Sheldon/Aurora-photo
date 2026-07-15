/**
 * Aurora — standalone local photo viewer.
 *
 * Single-purpose Express server (HTTP). No auth, no external database — just the
 * Aurora photo app and its on-disk SQLite index. Extracted from the intranet-server
 * project so it runs by itself on a fresh machine.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');

const auroraRoutes = require('./src/routes/aurora');
const authRoutes = require('./src/routes/authRoutes');
const auroraDb = require('./src/services/auroraDbService');
const auroraIndexer = require('./src/services/auroraIndexerService');
const auroraAuth = require('./src/services/auroraAuthService');
const { attachSession, requireAuth } = require('./src/middleware/auth');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Version is read from version.json at startup and exposed to the API.
let APP_VERSION = { name: 'Aurora Photos', version: '1.0.0', build: 'unknown' };
try { APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); } catch (_) {}

// A stray rejection on a low-RAM box shouldn't kill the server.
process.on('unhandledRejection', (r) => console.error('Unhandled rejection:', r && r.message ? r.message : r));

const app = express();

// Aurora's asset index is large but mostly numbers — gzip turns ~12MB into ~1MB.
app.use(compression());
app.set('trust proxy', 1);

// Local app served over HTTP. CSP permits the inline app script/styles, the PWA
// manifest + service worker, webp thumbnails, and blob: video playback.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:"],
      frameSrc: ["'none'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      upgradeInsecureRequests: null, // served over HTTP — don't upgrade fetches
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Everything below can read req.user (null if not signed in).
app.use(attachSession);

// /health and /api/aurora/version are the only two API endpoints that are
// public — they're cheap probes that shouldn't require a session.
app.get('/health', (req, res) => res.json({ status: 'OK', version: APP_VERSION.version, timestamp: new Date().toISOString() }));
app.get('/api/aurora/version', (req, res) => res.json(APP_VERSION));

// Auth API is mounted BEFORE the guarded router so /login and /setup can hit it
// without a session.
app.use('/api/aurora/auth', authRoutes);

// Everything else under /api/aurora/* needs an authenticated session; individual
// endpoints add requirePerm() for finer-grained checks.
app.use('/api/aurora', requireAuth, auroraRoutes);

app.get('/setup', async (req, res) => {
  if (!(await auroraAuth.needsSetup())) return res.redirect('/aurora');
  res.render('auth', { mode: 'setup', nextUrl: '/aurora' });
});
app.get('/login', async (req, res) => {
  if (await auroraAuth.needsSetup()) return res.redirect('/setup');
  if (req.user) return res.redirect('/aurora');
  res.render('auth', { mode: 'login', nextUrl: (req.query.next && String(req.query.next).startsWith('/')) ? req.query.next : '/aurora' });
});

app.get('/aurora', async (req, res) => {
  if (await auroraAuth.needsSetup()) return res.redirect('/setup');
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent('/aurora'));
  // Thumbnails are cached hard in the browser (max-age 24h) and keyed by asset id.
  // A re-import reassigns ids to different files, so a stale browser cache would
  // show the wrong thumbnail. Stamp every thumb URL with a cache epoch tied to the
  // latest import — it changes on each import, so reused ids never collide with a
  // previously-cached thumbnail.
  let cacheEpoch = String(APP_VERSION.build || '0');
  try {
    const row = await auroraDb.get('SELECT MAX(started_at) AS e FROM import_sessions');
    if (row && row.e) cacheEpoch = String(row.e);
  } catch (_) {}
  res.render('aurora', { user: req.user, appVersion: APP_VERSION, cacheEpoch });
});
app.get('/', (req, res) => res.redirect('/aurora'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

(async () => {
  try {
    // sqlite won't create the parent directory — make sure it exists.
    try { fs.mkdirSync(path.dirname(auroraDb.DB_PATH), { recursive: true }); } catch (_) {}

    await auroraDb.initSchema();
    await auroraAuth.ensureBuiltinRoles();
    await auroraAuth.pruneExpiredSessions();
    // Cheap periodic sweep so the sessions table doesn't grow forever.
    setInterval(() => auroraAuth.pruneExpiredSessions().catch(() => {}), 60 * 60 * 1000).unref();
    await auroraIndexer.recoverInterruptedSessions();

    // Live Photo pairing (still + short clip → one item). Idempotent, non-blocking.
    auroraIndexer.linkLivePhotos()
      .then(({ linked }) => console.log(`Aurora: linked ${linked} Live Photos`))
      .catch((e) => console.error('Live Photo linking failed:', e.message));

    console.log('Aurora database initialized');

    // Warm thumbnails in the background once there's a library (resumable).
    setTimeout(async () => {
      try {
        const n = await auroraDb.get('SELECT COUNT(*) c FROM assets');
        if (n && n.c > 0) {
          console.log(`Aurora: warming thumbnails for ${n.c} assets in background`);
          auroraIndexer.startThumbnailWarming();
        }
      } catch (_) {}
    }, 8000);

    const server = http.createServer(app);
    server.listen(PORT, HOST, () => {
      console.log(`Aurora running on http://${HOST}:${PORT}/aurora`);
    });

    const shutdown = async () => { try { await auroraIndexer.shutdown(); } catch (_) {} process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('Failed to start Aurora:', err);
    process.exit(1);
  }
})();
