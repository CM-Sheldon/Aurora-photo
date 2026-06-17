/**
 * Builds a lightweight equirectangular world map (country outlines) as SVG path
 * strings, projected into a 1000×500 canvas. Local-first: no tile server, no
 * network — just the bundled world-atlas dataset converted once and cached.
 *
 * The Places screen projects its pins with the SAME formula, so pins and
 * coastlines line up. Zooming is done by setting the SVG viewBox to the data's
 * bounding box.
 */
const W = 1000, H = 500;

let cache = null;

// Equirectangular projection → 1000×500 canvas
function project(lon, lat) {
  const x = (lon + 180) / 360 * W;
  const y = (90 - lat) / 180 * H;
  return [x, y];
}

function ringToPath(ring) {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = project(ring[i][0], ring[i][1]);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  return d + 'Z';
}

function geometryToPath(geom) {
  let d = '';
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) d += ringToPath(ring);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) for (const ring of poly) d += ringToPath(ring);
  }
  return d;
}

// Signed-area centroid of one ring, in projected (1000×500) space.
function ringAreaCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = project(ring[i][0], ring[i][1]);
    const [x1, y1] = project(ring[(i + 1) % n][0], ring[(i + 1) % n][1]);
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) { const [x, y] = project(ring[0][0], ring[0][1]); return { area: 0, cx: x, cy: y }; }
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

// A label anchor = centroid of the country's LARGEST polygon (so e.g. the US is
// labelled on the mainland, not mid-ocean). `r` ≈ linear size in projected units,
// which the client uses to decide which labels are big enough to show at a zoom.
function labelFor(geom, name) {
  if (!name) return null;
  let best = null;
  const consider = (ring) => { const c = ringAreaCentroid(ring); if (!best || c.area > best.area) best = c; };
  if (geom.type === 'Polygon') consider(geom.coordinates[0]);
  else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) consider(poly[0]);
  if (!best || !best.area) return null;
  const tidy = name === 'United States of America' ? 'United States'
    : name === 'Dem. Rep. Congo' ? 'DR Congo' : name;
  return { name: tidy, x: +best.cx.toFixed(1), y: +best.cy.toFixed(1), r: +Math.sqrt(best.area).toFixed(1) };
}

function build() {
  if (cache) return cache;
  try {
    const topology = require('world-atlas/countries-110m.json');
    const { feature } = require('topojson-client');
    const fc = feature(topology, topology.objects.countries);
    const paths = fc.features.map(f => geometryToPath(f.geometry)).filter(Boolean);
    const labels = fc.features
      .map(f => labelFor(f.geometry, f.properties && f.properties.name))
      .filter(Boolean)
      .sort((a, b) => b.r - a.r);   // largest first, so the client can cap easily
    cache = { width: W, height: H, paths, labels, project: true };
  } catch (_) {
    cache = { width: W, height: H, paths: [], labels: [] };
  }
  return cache;
}

module.exports = { build, project, W, H };
