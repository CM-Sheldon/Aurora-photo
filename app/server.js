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
const auroraDb = require('./src/services/auroraDbService');
const auroraIndexer = require('./src/services/auroraIndexerService');

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

app.use('/api/aurora', auroraRoutes);
app.get('/aurora', (req, res) => res.render('aurora', { user: null, appVersion: APP_VERSION }));
app.get('/', (req, res) => res.redirect('/aurora'));
app.get('/health', (req, res) => res.json({ status: 'OK', version: APP_VERSION.version, timestamp: new Date().toISOString() }));
app.get('/api/aurora/version', (req, res) => res.json(APP_VERSION));

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
