/**
 * Lightweight offline reverse geocoder.
 *
 * Replaces `local-reverse-geocoder`, which loads the full geonames
 * `alternateNames` (700MB+) and `allCountries` datasets into memory and OOMs a
 * small box. This loads a compact cities list (~34k towns, <1MB on disk, a few
 * MB in memory) ONCE and does a simple nearest-neighbour lookup. No network.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CITIES_FILE = process.env.AURORA_CITIES_FILE
  || (process.env.AURORA_DATA_DIR ? path.join(process.env.AURORA_DATA_DIR, 'cities.tsv') : null)
  || path.join(__dirname, '../../data/cities.tsv');

let cities = null;       // { name, country, lat, lon }
let loadPromise = null;

function load() {
  if (cities) return Promise.resolve(cities);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    const result = [];
    if (!fs.existsSync(CITIES_FILE)) {
      // No dataset — geocoding degrades to coordinates only
      cities = result;
      return resolve(result);
    }
    const rl = readline.createInterface({
      input: fs.createReadStream(CITIES_FILE),
      crlfDelay: Infinity
    });
    rl.on('line', (line) => {
      const parts = line.split('\t');
      if (parts.length < 4) return;
      const lat = parseFloat(parts[1]);
      const lon = parseFloat(parts[2]);
      if (isNaN(lat) || isNaN(lon)) return;
      result.push({ name: parts[0], lat, lon, country: parts[3] });
    });
    rl.on('close', () => {
      cities = result;
      resolve(result);
    });
    rl.on('error', () => {
      cities = result;
      resolve(result);
    });
  });
  return loadPromise;
}

// Forget the cached dataset so the next lookup re-reads cities.tsv. Used by the
// "name places" maintenance action after a cities.tsv is dropped onto a running
// server (otherwise the empty/old list stays cached for the process lifetime).
function reload() {
  cities = null;
  loadPromise = null;
  return load();
}

// Number of cities currently loaded (0 if no dataset present).
function size() {
  return cities ? cities.length : 0;
}

// Equirectangular approximation — fast and plenty accurate for "nearest city"
function distanceSq(lat1, lon1, lat2, lon2) {
  const dLat = lat1 - lat2;
  const dLon = (lon1 - lon2) * Math.cos((lat1 + lat2) * 0.5 * Math.PI / 180);
  return dLat * dLat + dLon * dLon;
}

/**
 * Returns { name, country } for the nearest known city, or null.
 */
async function lookup(lat, lon) {
  if (lat == null || lon == null) return null;
  const list = await load();
  if (!list.length) return null;

  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const d = distanceSq(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  // ~1.5 degrees ≈ 150km cap; beyond that, don't guess a name
  if (best && bestD < 2.25) {
    return { name: best.name, country: best.country };
  }
  return null;
}

module.exports = { lookup, load, reload, size };
