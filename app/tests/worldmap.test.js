/**
 * Guard against the antimeridian regression: countries whose polygons cross
 * ±180° longitude (e.g. Russia's Chukotka, Fiji) used to draw a straight line
 * clean across the whole map because `ringToPath` naively joined every
 * adjacent point with an `L` command. The fix in auroraWorldMapService.js
 * lifts the pen (starts a new `M` subpath) when consecutive points are more
 * than 180° of longitude apart.
 *
 * We can't easily assert the visual output, so we parse the emitted SVG path
 * data and check no `L` segment jumps more than half the canvas width.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const wm = require('../src/services/auroraWorldMapService');

test('build() returns a cached shape', () => {
  const a = wm.build();
  const b = wm.build();
  assert.equal(typeof a, 'object');
  assert.equal(a, b, 'build() should memoise');
  assert.equal(a.width, 1000);
  assert.equal(a.height, 500);
  assert.ok(Array.isArray(a.paths));
});

// Parse an SVG path string into a flat list of {cmd, x, y} points.
// Only handles the M/L/Z commands emitted by ringToPath — no arcs, no curves.
function parsePath(d) {
  const pts = [];
  const re = /([MLZ])\s*(-?\d+(?:\.\d+)?)?\s*(-?\d+(?:\.\d+)?)?/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    if (cmd === 'Z') { pts.push({ cmd }); continue; }
    pts.push({ cmd, x: +m[2], y: +m[3] });
  }
  return pts;
}

test('no line segment crosses more than half the map width (antimeridian guard)', () => {
  const { paths, width } = wm.build();
  assert.ok(paths.length > 50, `expected many country paths, got ${paths.length}`);

  const HALF = width / 2;
  const offenders = [];
  for (let i = 0; i < paths.length; i++) {
    const pts = parsePath(paths[i]);
    let prev = null;
    for (const p of pts) {
      if (p.cmd === 'Z') { prev = null; continue; }
      if (p.cmd === 'M') { prev = p; continue; }
      // L: check the jump from prev
      if (prev && Math.abs(p.x - prev.x) > HALF) {
        offenders.push({ pathIndex: i, from: prev, to: p });
      }
      prev = p;
    }
    if (offenders.length > 5) break; // enough evidence
  }

  assert.equal(offenders.length, 0,
    `expected no straight-line antimeridian crossings, found ${offenders.length}:\n` +
    offenders.slice(0, 3).map(o =>
      `  path ${o.pathIndex}: (${o.from.x},${o.from.y}) → (${o.to.x},${o.to.y})`
    ).join('\n'));
});

test('no Z-close draws a diagonal across the map (subpaths must close along the antimeridian edge)', () => {
  // Regression guard for the actual sprint bug: the first "M-lift" antimeridian
  // fix left subpaths whose Z closed from far-right (x≈1000) back to a
  // ring-start deep in the interior (e.g. Russia's Kamchatka closed diagonally
  // to mid-Asia). The correct behaviour is that every closed subpath's start
  // and end are either the same point OR both sit on the antimeridian edge
  // (x=0 or x=width), so Z draws a vertical line at the canvas boundary and
  // is visually invisible.
  const { paths, width } = wm.build();
  const EDGE = 1;   // tolerance around 0 / width
  const MAX = width / 4;   // any diagonal close longer than 25% of map is a bug

  const bad = [];
  for (let i = 0; i < paths.length; i++) {
    const parts = paths[i].split(/(?=[MZ])/);
    let start = null, last = null;
    for (const c of parts) {
      if (c[0] === 'M') {
        const m = c.slice(1).trim().split(/\s+/);
        start = { x: +m[0], y: +m[1] };
        last = { ...start };
        for (const lm of c.matchAll(/L(-?[\d.]+)\s+(-?[\d.]+)/g)) {
          last = { x: +lm[1], y: +lm[2] };
        }
      } else if (c[0] === 'L') {
        for (const lm of c.matchAll(/L(-?[\d.]+)\s+(-?[\d.]+)/g)) {
          last = { x: +lm[1], y: +lm[2] };
        }
      } else if (c[0] === 'Z' && start && last) {
        const dx = Math.abs(last.x - start.x);
        const dy = Math.abs(last.y - start.y);
        const onEdge =
          (start.x < EDGE || start.x > width - EDGE) &&
          (last.x  < EDGE || last.x  > width  - EDGE);
        if ((dx > MAX || dy > MAX) && !onEdge) {
          bad.push({ pathIndex: i, start, last, dx, dy });
        }
      }
    }
  }
  assert.equal(bad.length, 0,
    `expected every Z-close to be either short or along the antimeridian edge,\n` +
    `found ${bad.length} diagonals:\n` +
    bad.slice(0, 3).map(b =>
      `  path ${b.pathIndex}: Z closes (${b.last.x},${b.last.y}) → (${b.start.x},${b.start.y})`
    ).join('\n'));
});

test('project() maps (0,0) to the centre of the canvas', () => {
  const [x, y] = wm.project(0, 0);
  assert.equal(x, 500);
  assert.equal(y, 250);
});

test('labels are sorted largest-first for client-side capping', () => {
  const { labels } = wm.build();
  for (let i = 1; i < labels.length; i++) {
    assert.ok(labels[i].r <= labels[i - 1].r,
      `labels not sorted at index ${i}: ${labels[i - 1].r} < ${labels[i].r}`);
  }
});
