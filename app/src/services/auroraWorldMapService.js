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

// A "crossing" is any pair of adjacent points whose longitudes differ by more
// than 180°. In Natural Earth data (world-atlas 110m) this happens when a
// polygon straddles the antimeridian: e.g. Russia's mainland ring includes
// the segment (178.6, 69.4) → (-180.0, 69.0), which if drawn naively becomes
// a line running clean across the whole map from far right to far left.
const ANTIMERIDIAN_DEG = 180;

// Latitude of the antimeridian crossing between two points. Uses linear
// interpolation on the shortest-path lon distance. For points that lie
// exactly on ±180 (Natural Earth encodes many antimeridian polygons with
// boundary vertices at the pole), this reduces to lat2 or lat1.
function crossingLat(lon1, lat1, lon2, lat2) {
  let adj = lon2;
  if (lon2 - lon1 > ANTIMERIDIAN_DEG) adj = lon2 - 360;
  else if (lon2 - lon1 < -ANTIMERIDIAN_DEG) adj = lon2 + 360;
  const span = adj - lon1;
  if (span === 0) return (lat1 + lat2) / 2;
  const bound = span > 0 ? 180 : -180;
  const t = (bound - lon1) / span;
  return lat1 + t * (lat2 - lat1);
}

// Split a ring at every antimeridian crossing and emit one closed SVG
// subpath per resulting side. Segments that end up on the same side of the
// antimeridian (the ring's start and end always are, since a closed ring
// starts and ends on one side) are stitched together so we don't leak a
// diagonal Z-close line back to the ring's first point.
//
// The vertical closing edge introduced by the split sits on x=0 (for -180)
// or x=1000 (for +180) — the exact edge of the projected canvas — so it is
// visually invisible in a full-world view and clipped by the SVG viewBox in
// any zoomed-in view.
function ringToPath(ring) {
  // First pass: find every crossing.
  const crossings = [];
  for (let i = 1; i < ring.length; i++) {
    const dLon = ring[i][0] - ring[i - 1][0];
    if (Math.abs(dLon) > ANTIMERIDIAN_DEG) crossings.push(i);
  }

  // Fast path: no crossings, emit a single M…L…Z as before.
  if (crossings.length === 0) {
    let d = '';
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = project(ring[i][0], ring[i][1]);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d + 'Z';
  }

  // Build one segment (array of [lon, lat]) per side of the antimeridian.
  // At each crossing, close the current segment with a boundary point at
  // ±180 and open the next segment with the mirror boundary point at ∓180.
  const segments = [];
  let seg = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [lon1, lat1] = ring[i - 1];
    const [lon2, lat2] = ring[i];
    if (Math.abs(lon2 - lon1) > ANTIMERIDIAN_DEG) {
      const midLat = crossingLat(lon1, lat1, lon2, lat2);
      const exitLon = lon1 >= 0 ? 180 : -180;
      seg.push([exitLon, midLat]);
      segments.push(seg);
      seg = [[-exitLon, midLat]];
    }
    seg.push(ring[i]);
  }
  segments.push(seg);

  // The ring is closed, so segments[0] and segments[N-1] are on the same
  // side of the antimeridian. Merge them into one loop (drop the duplicated
  // ring[0] where they meet) so each emitted subpath is a self-contained
  // closed polygon that closes via the antimeridian edge, not via a
  // diagonal back to the ring's first point.
  if (segments.length > 1) {
    const first = segments.shift();
    segments[segments.length - 1] = segments[segments.length - 1].concat(first.slice(1));
  }

  let d = '';
  for (const s of segments) {
    if (s.length < 2) continue;
    for (let i = 0; i < s.length; i++) {
      const [x, y] = project(s[i][0], s[i][1]);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    d += 'Z';
  }
  return d;
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
