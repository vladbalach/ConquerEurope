// Builds public/map.json from Natural Earth (world-atlas 50m) geometry + tools/cities.js.
//
//  1. Project every country polygon with a Lambert azimuthal equal-area projection
//     centred on Europe (units ~ km, y axis pointing down/south). A few islands are then
//     moved closer to the rest of the map (MOVED).
//  2. Simplify every border arc once (so neighbouring countries keep sharing exactly the
//     same border points), clip to the playable rectangle (RECT), drop tiny islets. Some coasts
//     get less detail still (SMOOTH_COASTS: Norway's fjords and skerries).
//  3. Assign each city to the landmass (polygon) it stands on.
//  4. Split every landmass between its cities with a Voronoi diagram, so each
//     city owns a territory. Landmasses without a city (small islands, micro
//     states) go to the nearest city.
//  5. Emit the lines between city territories as `segs`: the Voronoi edges inside landmasses
//     and the parts of today's national borders that divide two cities. Each one is a
//     province line (two cities of one region) or a region border (two regions, or a region
//     and neutral land). Today's borders inside one city's territory are not drawn.
//  6. Rasterise land into server/data/navgrid.json (units can only walk on land), and mark the
//     mountains of tools/mountains.js on it (land nobody walks on), checking that they wall nobody in.
//     The map gets the same mountain cells to draw them.
//
// Run: npm run build-map

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature, transform } from 'topojson-client';
import { COUNTRIES } from './cities.js';
import { MOUNTAINS } from './mountains.js';
import { NavGrid } from '../server/nav.js';
import { encodeMask, MOUNTAIN_RULES } from '../shared/mountains.js';
import { NAVAL } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Output and input paths can be changed with environment variables (used by tests).
const OUT = process.env.MAP_OUT || path.join(ROOT, 'public', 'map.json');
const NAV_OUT = process.env.NAV_OUT || path.join(ROOT, 'server', 'data', 'navgrid.json');
// Cities moved by admins in the game (Edit map), as { "City name": [x, y] } in map units.
// They replace the positions from tools/cities.js.
const CITY_POSITIONS = process.env.CITY_POSITIONS || path.join(ROOT, 'server', 'data', 'city-positions.json');

// Land grid used by the server for movement and pathfinding: units walk on land only.
const NAV_CELL = 5;            // km per grid cell

// The playable rectangle, in map units. Fixed, so adding, removing or moving cities never changes
// the map size or the land grid: the beaches admins paint are saved as grid cells
// (server/data/beach-edits.json) and stay where they are. (It is the rectangle the city list once
// gave: 280 km around its outermost cities.)
const RECT = { x0: -2099.757959543213, y0: -2289.4736066327387, x1: 2924.9435929370316, y1: 2060.631029097228 };

// Islands moved closer to the rest of the map, as [dx, dy] in km (x east, y south): the land of the
// Natural Earth country of that name, and the cities of the region of that name in tools/cities.js
// (their latitude and longitude are where they stand on the real island). Greenland comes down into
// the map's north-west corner; Iceland moves down out of its way. Multiples of NAV_CELL, so the land
// grid under an island moves by whole cells and the beaches painted on it can move with it.
const MOVED = { Greenland: [150, 400], Iceland: [0, 300] };

// Islands made bigger for the game, each picked by a point on it (`at`: longitude, latitude): grown `scale`
// times about its middle, then moved by `move` [dx, dy] km. Only that island grows, not its country's other
// land. Cities standing on it grow and move with it.
const GROWN = [
  { name: 'Crete', at: [24.9, 35.2], scale: 1.3 },
  { name: 'Jan Mayen', at: [-8.2, 71.07], scale: 4, move: [150, 60] },   // east, out of Greenland's way
];

// Natural Earth countries whose islands become one island: a smooth outline round them all.
const MERGED = ['Faeroe Is.'];

// Coasts with less detail than Natural Earth gives (smoothCoast), within `area` (longitude, latitude): every
// inlet of the mainland that a disc of `radius` km rolling along its coast on the sea can't get into becomes
// land (a morphological closing, on a raster of SMOOTH_RES km), so the fjords fill up and the coast runs
// across their mouths. The islands off it are closed the same way among themselves: skerries merge into
// bigger islands, which stay islands. Land borders keep every point, so the neighbours still meet them.
const SMOOTH_COASTS = [
  // Norway's west coast from Stavanger to Troms (not the Skagerrak with the Oslofjord).
  { name: 'Norway', radius: 8, area: (lon, lat) => lat > 58.85 && lon < 21.5 && !(lon > 8.5 && lat < 60.3) },
  // Finnmark, whose fjords are wider: not the Varangerfjord's south shore by Russia.
  { name: 'Norway', radius: 12, area: (lon, lat) => lon >= 21.5 && lat > 68.5 && !(lon > 29.3 && lat < 70) },
];
const SMOOTH_RES = 1;          // km
const SMOOTH_STRAIT = 2;       // km: islands that stay islands keep at least this much sea from the mainland
const SMOOTH_ISLAND = 60;      // km²: smaller islands there are dropped (unless a city stands on one)
const SMOOTH_HARBOUR = 3;      // km: a port's way to the open sea stays sea this far to either side

// Mountains (tools/mountains.js): land cells nobody walks on. Where they may stand (coastGap, cityGap) and how
// walled-in land is opened (pocket, passWidth) are MOUNTAIN_RULES (shared/mountains.js), which the mountains
// admins paint keep too.
const MOUNTAIN = {
  ...MOUNTAIN_RULES,
  endWidth: 0.55,    // a chain narrows to this share of its width at either end, over one width
  wobble: 0.25,      // the edges wander in and out by up to this share of the width (smooth noise)
  pass: 20,          // km: the way through a range where one of its chains ends and the next begins
};

const SIMPLIFY_TOL = 1.8;      // km
const MIN_RING_AREA = 30;      // km^2, smaller islets / holes are dropped
const ORPHAN_SAME_FEATURE_DIST = 700;   // island of a country without a city -> nearest city of that country
const ORPHAN_FOREIGN_DIST = 150;        // small state without a city -> the cities of any country this near
const ORPHAN_FOREIGN_MAX_AREA = 28000;  // km^2: as big as North Macedonia; bigger land without a city is neutral scenery

// ---------------------------------------------------------------- projection
const LON0 = 12, LAT0 = 52, R = 6371, DEG = Math.PI / 180;
const sinP0 = Math.sin(LAT0 * DEG), cosP0 = Math.cos(LAT0 * DEG);

function project(lon, lat) {
  const l = (lon - LON0) * DEG, p = lat * DEG;
  const cosC = sinP0 * Math.sin(p) + cosP0 * Math.cos(p) * Math.cos(l);
  const k = Math.sqrt(2 / (1 + cosC));
  const x = R * k * Math.cos(p) * Math.sin(l);
  const y = R * k * (cosP0 * Math.sin(p) - sinP0 * Math.cos(p) * Math.cos(l));
  return [x, -y];
}

// Longitude and latitude of a map point: the inverse of project.
function unproject(x, y) {
  const north = -y, rho = Math.hypot(x, north);
  if (rho < 1e-9) return [LON0, LAT0];
  const c = 2 * Math.asin(Math.min(1, rho / (2 * R))), sinC = Math.sin(c), cosC = Math.cos(c);
  const lat = Math.asin(cosC * sinP0 + (north * sinC * cosP0) / rho);
  const lon = LON0 * DEG + Math.atan2(x * sinC, rho * cosP0 * cosC - north * sinP0 * sinC);
  return [lon / DEG, lat / DEG];
}

// ---------------------------------------------------------------- geometry helpers
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

function clipRingRect(pts, rc) {
  const edges = [
    [(p) => p[0] >= rc.x0, (a, b) => { const t = (rc.x0 - a[0]) / (b[0] - a[0]); return [rc.x0, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= rc.x1, (a, b) => { const t = (rc.x1 - a[0]) / (b[0] - a[0]); return [rc.x1, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= rc.y0, (a, b) => { const t = (rc.y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rc.y0]; }],
    [(p) => p[1] <= rc.y1, (a, b) => { const t = (rc.y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rc.y1]; }],
  ];
  let out = pts;
  for (const [inside, inter] of edges) {
    if (!out.length) break;
    const inp = out;
    out = [];
    let prev = inp[inp.length - 1];
    for (const cur of inp) {
      if (inside(cur)) {
        if (!inside(prev)) out.push(inter(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(inter(prev, cur));
      }
      prev = cur;
    }
  }
  return out;
}

function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

function dpOpen(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bd = tol2;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i], pts[s], pts[e]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// A closed ring without its closing point and without repeated points.
function openRing(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPoly(rings, x, y) {
  if (!inRing(rings[0], x, y)) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(rings[k], x, y)) return false;
  return true;
}

function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

// The centre of mass of a ring.
function centroid(r) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f;
  }
  return [x / (3 * a), y / (3 * a)];
}

// The smallest convex ring round the points (monotone chain).
function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half(p.reverse())];
}

// A ring with its corners rounded off (Chaikin's corner cutting, `times` over).
function smoothRing(r, times) {
  for (let t = 0; t < times; t++) {
    const out = [];
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    });
    r = out;
  }
  return r;
}

// A closed ring simplified like dpOpen: cut in two at its first point and the point farthest from it.
function dpClosed(r, tol) {
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = dpOpen(r.slice(0, far + 1), tol), b = dpOpen([...r.slice(far), r[0]], tol);
  return [...a, ...b.slice(1, -1)];
}

// ---------------------------------------------------------------- rasters
// Rasters are w x h cells of `res` km, row by row, cell (i, j) with its corner at (x0 + i res, y0 + j res).

// Calls fn(k) for every cell whose centre lies in the polygon (outer ring, then holes).
function scanRings(rings, x0, y0, res, w, h, fn) {
  const edges = [];
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] !== r[j][1]) edges.push(r[j][0], r[j][1], r[i][0], r[i][1]);
    }
  }
  const bb = bboxOf(rings[0]);
  const j0 = Math.max(0, Math.floor((bb.y0 - y0) / res - 0.5));
  const j1 = Math.min(h - 1, Math.ceil((bb.y1 - y0) / res));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const yc = y0 + (j + 0.5) * res;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e], ay = edges[e + 1], bx = edges[e + 2], by = edges[e + 3];
      if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) fn(j * w + i);
    }
  }
}

// Squared distance, in cells, from every cell to the nearest cell where `on` is set (Felzenszwalb and
// Huttenlocher's exact transform); about 1e20 where there is none.
function edt(on, w, h) {
  const n = Math.max(w, h), INF = 1e20;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float64Array(w * h);
  for (let k = 0; k < out.length; k++) out[k] = on[k] ? 0 : INF;
  const line = (len) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k]));
      while (s <= z[k]) { k--; s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k])); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = out[j * w + i];
    line(h);
    for (let j = 0; j < h; j++) out[j * w + i] = d[j];
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = out[j * w + i];
    line(w);
    for (let i = 0; i < w; i++) out[j * w + i] = d[i];
  }
  return out;
}

// The outline of the cells where `mask` is set (one 4-connected piece, say): the outermost loop of cell
// edges round them, as a ring of corner points. Holes in it are left out.
function traceOutline(mask, x0, y0, res, w, h) {
  const at = (i, j) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
  // Edges go clockwise round every cell (y down), the cells on their right: corner id -> [end corner, ...].
  const W1 = w + 1, out = new Map();
  const add = (a, b) => { if (!out.has(a)) out.set(a, []); out.get(a).push(b); };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) add(j * W1 + i, j * W1 + i + 1);
      if (!at(i + 1, j)) add(j * W1 + i + 1, (j + 1) * W1 + i + 1);
      if (!at(i, j + 1)) add((j + 1) * W1 + i + 1, (j + 1) * W1 + i);
      if (!at(i - 1, j)) add((j + 1) * W1 + i, j * W1 + i);
    }
  }
  let best = null, bestArea = 0;
  for (const start of [...out.keys()]) {
    while (out.get(start)?.length) {
      const loop = [start];
      let prev = start, cur = out.get(start).pop();
      while (cur !== start) {
        loop.push(cur);
        const next = out.get(cur);
        // Where two cells touch only at a corner, turn right: round the same cell, so they stay apart.
        let k = next.length - 1;
        if (next.length > 1) {
          const dx = (cur % W1) - (prev % W1), dy = Math.floor(cur / W1) - Math.floor(prev / W1);
          k = next.findIndex((c) => (c % W1) - (cur % W1) === -dy && Math.floor(c / W1) - Math.floor(cur / W1) === dx);
          if (k < 0) k = next.length - 1;
        }
        prev = cur;
        cur = next.splice(k, 1)[0];
      }
      const ring = loop.map((c) => [x0 + (c % W1) * res, y0 + Math.floor(c / W1) * res]);
      const a = ringArea(ring);
      if (a > bestArea) { bestArea = a; best = ring; }
    }
  }
  return best;
}

// The ring with the stretch from point a to point b (the way round that passes point m) replaced by
// `between`: the points from a to b, without a and b. a, b and m are points of the ring, or the
// ring's points nearest to them.
function spliceRing(ring, a, b, m, between) {
  const near = (p) => {
    let best = 0, bd = Infinity;
    ring.forEach((q, i) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const n = ring.length, ia = near(a), ib = near(b), im = near(m);
  const walk = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % n) { out.push(ring[i]); if (i === to) return out; }
  };
  // Going on from a, does the ring reach m before b? Then it keeps b ... a, and the new stretch closes it.
  if ((im - ia + n) % n <= (ib - ia + n) % n) return [...walk(ib, ia), ...between];
  return [...walk(ia, ib), ...[...between].reverse()];
}

function distToRing(ring, p) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, segDist2(p, ring[j], ring[i]));
  return Math.sqrt(best);
}

// Width of the sea between two rings (0 if they touch or overlap).
function ringGap(a, b) {
  let best = Infinity;
  for (const p of a) best = Math.min(best, distToRing(b, p));
  for (const p of b) best = Math.min(best, distToRing(a, p));
  return best;
}

// Clip a convex polygon by the half plane nx*x + ny*y <= c, tracking which
// neighbour produced each edge (labels[k] = label of edge poly[k] -> poly[k+1]).
function clipHalfPlane(poly, labels, nx, ny, c, newLabel) {
  const out = [], outL = [];
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const a = poly[k], b = poly[(k + 1) % n], L = labels[k];
    const fa = nx * a[0] + ny * a[1] - c, fb = nx * b[0] + ny * b[1] - c;
    if (fa <= 0) {
      out.push(a); outL.push(L);
      if (fb > 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); outL.push(newLabel);
      }
    } else if (fb <= 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); outL.push(L);
    }
  }
  return [out, outL];
}

// Parts of segment AB that lie inside the polygon (outer ring minus holes).
function clipSegToPoly(a, b, rings) {
  const ts = [0, 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const p = r[j], q = r[i];
      const ex = q[0] - p[0], ey = q[1] - p[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = p[0] - a[0], wy = p[1] - a[1];
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * dy - wy * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const res = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    if (!inPoly(rings, a[0] + dx * tm, a[1] + dy * tm)) continue;
    if (res.length && Math.abs(res[res.length - 1][1] - t0) < 1e-9) res[res.length - 1][1] = t1;
    else res.push([t0, t1]);
  }
  return res
    .filter(([t0, t1]) => (t1 - t0) * Math.hypot(dx, dy) > 0.5)
    .map(([t0, t1]) => [a[0] + dx * t0, a[1] + dy * t0, a[0] + dx * t1, a[1] + dy * t1]);
}

const r1 = (v) => Math.round(v * 10) / 10;
const flat = (ring) => ring.flatMap(([x, y]) => [r1(x), r1(y)]);

// ---------------------------------------------------------------- cities
const countries = [];
const cities = [];
COUNTRIES.forEach((co, ci) => {
  countries.push({ n: co.name });
  const [mx, my] = MOVED[co.name] || [0, 0];
  for (const [n, lat, lon] of co.cities) {
    const [x, y] = project(lon, lat);
    cities.push({ n, c: ci, x: x + mx, y: y + my });
  }
});

const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/world-atlas/countries-50m.json'), 'utf8'));
const fc = feature(topo, topo.objects.countries);
const polyList = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

// Grown islands (GROWN): how the points of each one move, by "feature:polygon". The islets of the same
// country near it (within the distance its coast grows by) grow with it, so its coast never covers them;
// so do the cities on it.
const grown = new Map();
for (const g of GROWN) {
  const placed = (ring, name) => {
    const [ox, oy] = MOVED[name] || [0, 0];
    return openRing(ring.map(([lon, lat]) => { const [x, y] = project(lon, lat); return [x + ox, y + oy]; }));
  };
  // The smallest polygon round the point (not one across the date line, which seems to hold every point).
  let hit = null;
  fc.features.forEach((f, fIndex) => {
    if (!f.geometry) return;
    polyList(f.geometry).forEach((poly, pIndex) => {
      const bb = bboxOf(poly[0]), size = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
      if (bb.x1 - bb.x0 > 180 || !inRing(poly[0], g.at[0], g.at[1]) || (hit && hit.size <= size)) return;
      hit = { f, fIndex, pIndex, size };
    });
  });
  if (!hit) throw new Error(`No island at ${g.at} (${g.name})`);
  const polysOf = polyList(hit.f.geometry);
  const ring = placed(polysOf[hit.pIndex][0], hit.f.properties.name);
  const [cx, cy] = centroid(ring), [dx, dy] = g.move || [0, 0];
  const grow = ([x, y]) => [cx + dx + (x - cx) * g.scale, cy + dy + (y - cy) * g.scale];
  const bb = bboxOf(ring);
  const reach = (g.scale - 1) * Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 + 10;
  polysOf.forEach((poly, pIndex) => {
    const ob = bboxOf(placed(poly[0], hit.f.properties.name));
    if (ob.x0 < bb.x1 + reach && ob.x1 > bb.x0 - reach && ob.y0 < bb.y1 + reach && ob.y1 > bb.y0 - reach) {
      grown.set(`${hit.fIndex}:${pIndex}`, grow);
    }
  });
  for (const c of cities) {
    if (inRing(ring, c.x, c.y) || distToRing(ring, [c.x, c.y]) < 10) [c.x, c.y] = grow([c.x, c.y]);
  }
}

const rect = RECT;
for (const c of cities) {
  if (c.x < rect.x0 || c.x > rect.x1 || c.y < rect.y0 || c.y > rect.y1) {
    throw new Error(`City ${c.n} lies outside the map (${r1(c.x)}, ${r1(c.y)})`);
  }
}

let moved = 0;
try {
  const positions = JSON.parse(fs.readFileSync(CITY_POSITIONS, 'utf8'));
  for (const c of cities) {
    const p = positions[c.n];
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    c.x = Math.max(rect.x0, Math.min(rect.x1, p[0]));
    c.y = Math.max(rect.y0, Math.min(rect.y1, p[1]));
    moved++;
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (moved) console.log(`${moved} cities placed where admins moved them (${path.relative(ROOT, CITY_POSITIONS)})`);

// ---------------------------------------------------------------- land polygons
// The same countries drawn from arcs that were projected and simplified one by one. A border
// arc is shared by the two countries on either side of it, so both keep exactly the same border
// points: their fills meet without gaps, and the border is found later by matching edges.
const decodeArc = transform(topo.transform);
const simpleTopo = {
  ...topo,
  transform: null,
  arcs: topo.arcs.map((arc) => dpOpen(arc.map((p, k) => project(...decodeArc(p, k))), SIMPLIFY_TOL)),
};
const simpleFeatures = feature(simpleTopo, simpleTopo.objects.countries).features;

const polys = [];   // { f: featureIndex, rings: [[ [x,y], ...], ...], bbox, area }
const featureNames = [];
for (const [fIndex, f] of fc.features.entries()) {
  if (!f.geometry) continue;
  const gp = polyList(f.geometry);
  const simple = polyList(simpleFeatures[fIndex].geometry);
  const fi = featureNames.length;
  // A moved or grown island shares no border arc with another country, so moving its points alone
  // leaves no gap.
  const [mx, my] = MOVED[f.properties.name] || [0, 0];
  const move = ([x, y]) => [x + mx, y + my];
  if (MERGED.includes(f.properties.name)) {
    // One island round them all: the outline (convex hull) of every island of the country, rounded off.
    const all = gp.flatMap((poly) => poly[0].map(([lon, lat]) => move(project(lon, lat))));
    const ring = clipRingRect(smoothRing(convexHull(all), 3), rect);
    if (ring.length >= 3) {
      polys.push({ f: fi, rings: [ring], rawRings: [ring], bbox: bboxOf(ring), area: ringArea(ring), cities: [] });
      featureNames.push(f.properties.name);
    }
    continue;
  }
  let used = false;
  for (const [pIndex, poly] of gp.entries()) {
    if (!poly[0].some(([lon, lat]) => lon > -45 && lon < 80 && lat > 20 && lat < 85)) continue;
    const grow = grown.get(`${fIndex}:${pIndex}`);
    const place = grow ? (p) => grow(move(p)) : move;
    const rings = [];
    const rawRings = [];   // unsimplified: neighbouring countries share exact borders, so no slivers when rasterised
    for (let k = 0; k < poly.length; k++) {
      const full = poly[k].map(([lon, lat]) => place(project(lon, lat)));
      const last = full[full.length - 1];
      if (full.length > 1 && last[0] === full[0][0] && last[1] === full[0][1]) full.pop();
      const raw = clipRingRect(full, rect);
      const pts = clipRingRect(openRing(simple[pIndex][k]).map(place), rect);
      if (raw.length < 3 || pts.length < 3 || ringArea(pts) < MIN_RING_AREA) {
        if (k === 0) break;      // outer ring gone -> drop whole polygon
        continue;
      }
      rings.push(pts);
      rawRings.push(raw);
    }
    if (!rings.length) continue;
    polys.push({ f: fi, rings, rawRings, bbox: bboxOf(rings[0]), area: ringArea(rings[0]), cities: [] });
    used = true;
  }
  if (used) featureNames.push(f.properties.name);
}

// ---------------------------------------------------------------- simpler coasts
// SMOOTH_COASTS: see there. Only the longest stretch of the main landmass's outline in `area` that no other
// landmass shares is replaced; the rest keeps every point. The country's islands in `area` that end up in
// the new mainland are dropped (its outline goes round them); the others get the outlines of the islands
// they merge into, a strait of SMOOTH_STRAIT clear of the mainland. `ports`: cities whose way to the sea
// stays open.
function smoothCoast({ name, radius, area }, ports) {
  const fi = featureNames.indexOf(name);
  if (fi < 0) throw new Error(`SMOOTH_COASTS: no country ${name}`);
  const own = polys.filter((p) => p.f === fi);
  const main = own.reduce((a, b) => (b.area > a.area ? b : a));
  const shared = new Set();
  for (const p of polys) if (p.f !== fi) for (const r of p.rings) for (const [x, y] of r) shared.add(`${x},${y}`);
  const inArea = ([x, y]) => area(...unproject(x, y));
  const ring = main.rings[0], n = ring.length;
  const ok = ring.map((p) => !shared.has(`${p[0]},${p[1]}`) && inArea(p));
  const gap = ok.indexOf(false);
  if (gap < 0) throw new Error(`SMOOTH_COASTS: all of ${name}'s outline is in its area`);
  let s = -1, len = 0;
  for (let t = 1, run = 0, from = 0; t <= n; t++) {
    const i = (gap + t) % n;
    if (!ok[i]) { run = 0; continue; }
    if (!run) from = i;
    if (++run > len) { len = run; s = from; }
  }
  if (len < 3) throw new Error(`SMOOTH_COASTS: no coast of ${name} in its area`);
  const stretch = Array.from({ length: len }, (_, t) => ring[(s + t) % n]);
  const A = stretch[0], B = stretch[len - 1], M = stretch[len >> 1];

  // A raster round that stretch of coast. `solid`: the land the mainland's closing works on (the main
  // landmass, other countries', and this country's islands that are not all in `area`); `isle`: the islands
  // that are (index in `isles` + 1).
  const bb = bboxOf(stretch), margin = 3 * radius + 10, res = SMOOTH_RES;
  const x0 = bb.x0 - margin, y0 = bb.y0 - margin;
  const w = Math.ceil((bb.x1 + margin - x0) / res), h = Math.ceil((bb.y1 + margin - y0) / res), size = w * h;
  const within = (q) => q.bbox.x0 >= x0 && q.bbox.y0 >= y0 && q.bbox.x1 <= x0 + w * res && q.bbox.y1 <= y0 + h * res;
  const isles = own.filter((p) => p !== main && within(p) && p.rings[0].every(inArea));
  const land = new Uint8Array(size), solid = new Uint8Array(size), mainland = new Uint8Array(size);
  const isle = new Int32Array(size);
  for (const p of polys) {
    if (p.bbox.x1 < x0 || p.bbox.x0 > x0 + w * res || p.bbox.y1 < y0 || p.bbox.y0 > y0 + h * res) continue;
    const id = isles.indexOf(p) + 1;
    scanRings(p.rings, x0, y0, res, w, h, (k) => {
      land[k] = 1;
      if (id) isle[k] = id; else solid[k] = 1;
      if (p === main) mainland[k] = 1;
    });
  }
  const cellInArea = (k) => { const i = k % w; return inArea([x0 + (i + 0.5) * res, y0 + ((k - i) / w + 0.5) * res]); };
  // The closing of `mask`: 1 where it is set, or where no disc of `radius` clear of it reaches.
  const r2 = (radius / res) ** 2;
  const closing = (mask) => {
    const fromMask = edt(mask, w, h), open = new Uint8Array(size);
    for (let k = 0; k < size; k++) open[k] = fromMask[k] > r2 ? 1 : 0;
    const fromOpen = edt(open, w, h), out = new Uint8Array(size);
    for (let k = 0; k < size; k++) out[k] = mask[k] || fromOpen[k] > r2 ? 1 : 0;
    return out;
  };
  const closedMain = closing(solid);
  const isleMask = new Uint8Array(size);
  for (let k = 0; k < size; k++) isleMask[k] = isle[k] ? 1 : 0;
  const closedIsles = closing(isleMask);
  // The water that becomes land: the mainland's inlets, and the sounds between the islands.
  const fill = new Uint8Array(size);
  for (let k = 0; k < size; k++) fill[k] = !land[k] && (closedMain[k] || closedIsles[k]) && cellInArea(k) ? 1 : 0;
  // But a port keeps its way to the open sea: from the water nearest to it, the shortest way through water
  // that would fill to water that stays, and SMOOTH_HARBOUR to either side, stays water.
  let harbours = 0;
  const reach = Math.ceil(NAVAL.portRange / res), hr = Math.ceil(SMOOTH_HARBOUR / res);
  for (const c of ports) {
    const ci = Math.floor((c.x - x0) / res), cj = Math.floor((c.y - y0) / res);
    let start = -1, bd = Infinity;
    for (let j = Math.max(0, cj - reach); j <= Math.min(h - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(w - 1, ci + reach); i++) {
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (!land[j * w + i] && d < bd) { bd = d; start = j * w + i; }
      }
    }
    if (start < 0 || !fill[start]) continue;
    const from = new Map([[start, -1]]), queue = [start];
    let end = -1;
    for (let q = 0; q < queue.length && end < 0; q++) {
      const k = queue[q], i = k % w;
      for (const m of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (m < 0 || m >= size || land[m] || from.has(m)) continue;
        from.set(m, k);
        if (!fill[m]) { end = m; break; }
        queue.push(m);
      }
    }
    for (let k = end; k >= 0; k = from.get(k)) {
      const i = k % w, j = (k - i) / w;
      for (let dj = -hr; dj <= hr; dj++) {
        for (let di = -hr; di <= hr; di++) {
          if (di * di + dj * dj <= hr * hr && i + di >= 0 && j + dj >= 0 && i + di < w && j + dj < h) fill[(j + dj) * w + i + di] = 0;
        }
      }
    }
    if (end >= 0) harbours++;
  }
  // What the country has there now: the mainland with its inlets filled (and the islands in them), and
  // the islands with the sounds between them filled.
  const keep = new Uint8Array(size);
  for (let k = 0; k < size; k++) keep[k] = mainland[k] || isle[k] || fill[k] ? 1 : 0;
  // Its 4-connected pieces; the main one is the mainland's.
  const label = () => {
    const out = new Int32Array(size), stack = [];
    let count = 0;
    for (let k0 = 0; k0 < size; k0++) {
      if (!keep[k0] || out[k0]) continue;
      out[k0] = ++count;
      stack.push(k0);
      while (stack.length) {
        const k = stack.pop(), i = k % w;
        for (const m of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w]) {
          if (m < 0 || m >= size || !keep[m] || out[m]) continue;
          out[m] = count;
          stack.push(m);
        }
      }
    }
    return out;
  };
  const mostOf = (pieces, test) => {
    const count = new Map();
    for (let k = 0; k < size; k++) if (pieces[k] && test(k)) count.set(pieces[k], (count.get(pieces[k]) || 0) + 1);
    let best = 0, most = 0;
    for (const [c, m] of count) if (m > most) { most = m; best = c; }
    return best;
  };
  let piece = label();
  let mainPiece = mostOf(piece, (k) => mainland[k] === 1);
  // Islands nearer the mainland than SMOOTH_STRAIT lose the land that near, so they never touch it.
  const onMain = new Uint8Array(size);
  for (let k = 0; k < size; k++) onMain[k] = piece[k] === mainPiece ? 1 : 0;
  const fromMain = edt(onMain, w, h), strait2 = (SMOOTH_STRAIT / res) ** 2;
  for (let k = 0; k < size; k++) if (keep[k] && !onMain[k] && fromMain[k] <= strait2) keep[k] = 0;
  piece = label();
  mainPiece = mostOf(piece, (k) => mainland[k] === 1);

  const outline = (c) => {
    const mask = new Uint8Array(size);
    for (let k = 0; k < size; k++) mask[k] = piece[k] === c ? 1 : 0;
    // The cell edges' staircase, straightened, rounded off, and thinned out again.
    return dpClosed(smoothRing(dpClosed(traceOutline(mask, x0, y0, res, w, h), res * 0.75), 2), res * 0.8);
  };
  const coast = outline(mainPiece);
  const near = (p) => coast.reduce((b, q, i) => ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
    < (coast[b][0] - p[0]) ** 2 + (coast[b][1] - p[1]) ** 2 ? i : b), 0);
  const ia = near(A), ib = near(B), im = near(M), cn = coast.length;
  // The new coast from A to B: the way round the outline that passes M.
  const between = [];
  const dir = (im - ia + cn) % cn <= (ib - ia + cn) % cn ? 1 : -1;
  for (let i = (ia + dir + cn) % cn; i !== ib; i = (i + dir + cn) % cn) between.push(coast[i]);
  main.rings[0] = spliceRing(main.rings[0], A, B, M, between);
  main.rawRings[0] = spliceRing(main.rawRings[0], A, B, M, between);
  main.bbox = bboxOf(main.rings[0]);
  main.area = ringArea(main.rings[0]);

  // The islands: each takes the outline of the piece most of it lies in, once (several merge into one).
  const cityPieces = new Set();
  for (const c of cities) {
    const i = Math.floor((c.x - x0) / res), j = Math.floor((c.y - y0) / res);
    if (i >= 0 && j >= 0 && i < w && j < h && piece[j * w + i]) cityPieces.add(piece[j * w + i]);
  }
  let joined = 0, merged = 0, dropped = 0;
  const done = new Set();
  isles.forEach((p, idx) => {
    const c = mostOf(piece, (k) => isle[k] === idx + 1);
    const r = c && c !== mainPiece && !done.has(c) ? outline(c) : null;
    if (!r || (ringArea(r) < SMOOTH_ISLAND && !cityPieces.has(c))) {
      polys.splice(polys.indexOf(p), 1);
      if (c === mainPiece) joined++; else if (done.has(c)) merged++; else dropped++;
      return;
    }
    done.add(c);
    p.rings = [r];
    p.rawRings = [r];
    p.bbox = bboxOf(r);
    p.area = ringArea(r);
  });
  console.log(`${name}: ${len} points of coast smoothed into ${between.length}, ${harbours} ports' ways to the sea ` +
    `kept; islands: ${joined} joined to the mainland, ${merged} merged into others, ${dropped} too small dropped, ` +
    `${done.size} left`);
}

// ---------------------------------------------------------------- land grid
// Each cell stores the landmass polygon its centre lies in (0 = water), rasterised
// from the unsimplified rings (neighbouring countries share exact borders, so no
// slivers). Two neighbouring cells are connected only when they lie in the same
// polygon or in two polygons sharing a land border, so units cannot hop across a
// strait narrower than a cell: islands stay islands.
const nav = {
  cell: NAV_CELL, x0: rect.x0, y0: rect.y0,
  w: Math.ceil((rect.x1 - rect.x0) / NAV_CELL), h: Math.ceil((rect.y1 - rect.y0) / NAV_CELL),
};
const cellX = (i) => nav.x0 + (i + 0.5) * NAV_CELL;
const cellY = (j) => nav.y0 + (j + 0.5) * NAV_CELL;

// The land grid of the landmasses as they are now, and the landmasses that touch by land.
function landGrid() {
  const grid = new Uint16Array(nav.w * nav.h);
  polys.forEach((p, pi) => scanRings(p.rawRings, nav.x0, nav.y0, NAV_CELL, nav.w, nav.h, (k) => { grid[k] = pi + 1; }));
  // The grid is whole cells, so its last row (and column) can reach past the map's edge, where no land was
  // drawn. Those cells take the cell inside next to them, or they would make a strip of sea along the edge
  // for ships to sail behind the land (North Africa).
  for (let j = 1; j < nav.h; j++) {
    if (cellY(j) > rect.y1) grid.copyWithin(j * nav.w, (j - 1) * nav.w, j * nav.w);
  }
  for (let i = 1; i < nav.w; i++) {
    if (cellX(i) <= rect.x1) continue;
    for (let j = 0; j < nav.h; j++) grid[j * nav.w + i] = grid[j * nav.w + i - 1];
  }

  // Polygons that share border vertices touch by land (TopoJSON shares border arcs exactly).
  const touches = [];
  const vertexOwner = new Map();
  const shared = new Map();
  polys.forEach((p, pi) => {
    for (const ring of p.rawRings) {
      for (const [x, y] of ring) {
        const key = `${x.toFixed(3)},${y.toFixed(3)}`;
        const other = vertexOwner.get(key);
        if (other === undefined) { vertexOwner.set(key, pi + 1); continue; }
        if (other === pi + 1) continue;
        const k = Math.min(other, pi + 1) * 65536 + Math.max(other, pi + 1);
        shared.set(k, (shared.get(k) || 0) + 1);
      }
    }
  });
  for (const [k, n] of shared) if (n >= 2) touches.push([Math.floor(k / 65536), k % 65536]);
  return { grid, touches };
}

// The cities with a port before the coasts are smoothed (the game's rule: the sea within NAVAL.portRange):
// smoothCoast keeps their way to the sea open, so it takes no port away.
const ports = (() => {
  const before = landGrid();
  const g = new NavGrid({ ...nav, rle: rle(before.grid), touches: before.touches });
  return cities.filter((c) => g.nearestSea(c.x, c.y, NAVAL.portRange));
})();
for (const c of SMOOTH_COASTS) smoothCoast(c, ports);
const { grid, touches } = landGrid();

// Coastal cities whose point falls in the water are nudged onto the nearest land cell.
for (const c of cities) {
  const ci = Math.floor((c.x - nav.x0) / NAV_CELL), cj = Math.floor((c.y - nav.y0) / NAV_CELL);
  if (grid[cj * nav.w + ci]) continue;
  let best = null, bd = Infinity;
  for (let j = cj - 4; j <= cj + 4; j++) {
    for (let i = ci - 4; i <= ci + 4; i++) {
      if (i < 0 || j < 0 || i >= nav.w || j >= nav.h || !grid[j * nav.w + i]) continue;
      const d = Math.hypot(cellX(i) - c.x, cellY(j) - c.y);
      if (d < bd) { bd = d; best = [cellX(i), cellY(j)]; }
    }
  }
  if (!best) throw new Error(`City ${c.n} is more than 20 km from land`);
  [c.x, c.y] = best;
}

// ---------------------------------------------------------------- mountains
// Land cells nobody walks on, along the chains of tools/mountains.js: within half a chain's width of its
// crest (narrowing towards its ends, the edges wandering in and out), but never within MOUNTAIN.coastGap
// of water nor MOUNTAIN.cityGap of a city.
const mountain = new Uint8Array(nav.w * nav.h);
let passesCut = 0, pocketsFilled = 0;

// Smooth noise in -1..1 (value noise, two octaves), the same in every build.
function wobble(x, y) {
  const hash = (i, j) => {
    let v = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  const octave = (px, py, size) => {
    const fx = px / size, fy = py / size, i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const top = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * su;
    const bottom = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * su;
    return top + (bottom - top) * sv;
  };
  return (octave(x, y, 45) * 0.65 + octave(x + 1000, y - 700, 17) * 0.35) * 2 - 1;
}

{
  const water = new Uint8Array(nav.w * nav.h);
  for (let k = 0; k < water.length; k++) water[k] = grid[k] ? 0 : 1;
  const toWater = edt(water, nav.w, nav.h);
  const coastGap2 = (MOUNTAIN.coastGap / NAV_CELL) ** 2;
  for (const range of MOUNTAINS) {
    for (const chain of range.chains) {
      const pts = chain.map(([lat, lon, wd]) => [...project(lon, lat), wd ?? range.width]);
      // Distance along the chain to every point, for its narrowing ends (over a width, at most half of it).
      const at = [0];
      for (let k = 1; k < pts.length; k++) at.push(at[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const total = at[at.length - 1], widest = Math.max(...pts.map((p) => p[2]));
      const taper = Math.max(1, Math.min(total / 2, widest));
      const halfWidth = (along, wd) => {
        const t = Math.min(1, Math.min(along, total - along) / taper);
        return (wd / 2) * (MOUNTAIN.endWidth + (1 - MOUNTAIN.endWidth) * t * t * (3 - 2 * t));
      };
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, ay, aw] = pts[k], [bx, by, bw] = pts[k + 1];
        const reach = (Math.max(aw, bw) / 2) * (1 + MOUNTAIN.wobble);
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - nav.x0) / NAV_CELL));
        const i1 = Math.min(nav.w - 1, Math.floor((Math.max(ax, bx) + reach - nav.x0) / NAV_CELL));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - nav.y0) / NAV_CELL));
        const j1 = Math.min(nav.h - 1, Math.floor((Math.max(ay, by) + reach - nav.y0) / NAV_CELL));
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const c = j * nav.w + i;
            if (mountain[c] || !grid[c] || toWater[c] <= coastGap2) continue;
            const x = cellX(i), y = cellY(j);
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
            const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
            const hw = halfWidth(at[k] + t * (at[k + 1] - at[k]), aw + t * (bw - aw));
            if (d <= hw * (1 + MOUNTAIN.wobble * wobble(x, y))) mountain[c] = 1;
          }
        }
      }
    }
  }
  // The passes: where a chain ends and the next begins, a straight way MOUNTAIN.pass wide across the line
  // between the two ends, as far to either side as the range is wide.
  for (const range of MOUNTAINS) {
    for (let k = 0; k + 1 < range.chains.length; k++) {
      const a = range.chains[k][range.chains[k].length - 1], b = range.chains[k + 1][0];
      const [ex, ey] = project(a[1], a[0]), [sx, sy] = project(b[1], b[0]);
      const mx = (ex + sx) / 2, my = (ey + sy) / 2, len = Math.hypot(sx - ex, sy - ey) || 1;
      const ux = (sx - ex) / len, uy = (sy - ey) / len;
      const across = Math.max(a[2] ?? range.width, b[2] ?? range.width), half = MOUNTAIN.pass / 2;
      const i0 = Math.max(0, Math.floor((mx - across - half - nav.x0) / NAV_CELL));
      const i1 = Math.min(nav.w - 1, Math.floor((mx + across + half - nav.x0) / NAV_CELL));
      const j0 = Math.max(0, Math.floor((my - across - half - nav.y0) / NAV_CELL));
      const j1 = Math.min(nav.h - 1, Math.floor((my + across + half - nav.y0) / NAV_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = cellX(i) - mx, dy = cellY(j) - my;
          if (Math.abs(dx * ux + dy * uy) <= half && Math.abs(dy * ux - dx * uy) <= across) mountain[j * nav.w + i] = 0;
        }
      }
    }
  }
  const gap = Math.ceil(MOUNTAIN.cityGap / NAV_CELL);
  for (const c of cities) {
    const ci = Math.floor((c.x - nav.x0) / NAV_CELL), cj = Math.floor((c.y - nav.y0) / NAV_CELL);
    for (let j = Math.max(0, cj - gap); j <= Math.min(nav.h - 1, cj + gap); j++) {
      for (let i = Math.max(0, ci - gap); i <= Math.min(nav.w - 1, ci + gap); i++) {
        if (Math.hypot(cellX(i) - c.x, cellY(j) - c.y) <= MOUNTAIN.cityGap) mountain[j * nav.w + i] = 0;
      }
    }
  }
}

// No land may be walled in by mountains. Units find their way with the game's own grid (server/nav.js), so
// it judges, as it does for the mountains admins paint (NavGrid.openWalls): every landmass must stay one
// piece. A smaller piece cut off without a city becomes mountain too (a valley nobody could reach); any
// other gets a pass, the shortest way through to the rest.
{
  const g = new NavGrid({ ...nav, rle: rle(grid), touches, mountains: encodeMask(mountain) });
  const walls = g.openWalls(cities, MOUNTAIN);
  mountain.set(g.mountain);
  passesCut = walls.passes;
  pocketsFilled = walls.pockets;
}

// ---------------------------------------------------------------- cities -> landmasses
cities.forEach((c, ci) => {
  let home = polys.find((p) => c.x >= p.bbox.x0 && c.x <= p.bbox.x1 && c.y >= p.bbox.y0 && c.y <= p.bbox.y1 && inPoly(p.rings, c.x, c.y));
  if (!home) {
    let bd = 40;
    for (const p of polys) {
      if (c.x < p.bbox.x0 - 60 || c.x > p.bbox.x1 + 60 || c.y < p.bbox.y0 - 60 || c.y > p.bbox.y1 + 60) continue;
      const d = distToRing(p.rings[0], [c.x, c.y]);
      if (d < bd) { bd = d; home = p; }
    }
    if (home) console.log(`  note: ${c.n} lies ${bd.toFixed(1)} km off the coast of ${featureNames[home.f]}`);
  }
  if (!home) throw new Error(`City ${c.n} is not on any landmass`);
  home.cities.push(ci);
  c.f = home.f;
});

// ---------------------------------------------------------------- territories
const outPolys = [];
const segs = [];
let orphanCount = 0;
const bordered = new Set(touches.flat().map((k) => polys[k - 1]));   // landmasses with a land border

for (const p of polys) {
  let owners = p.cities;
  if (!owners.length) {
    // Orphan landmass: same-country island -> the nearest landmass of that country with a city
    // (within ORPHAN_SAME_FEATURE_DIST), and its nearest city: an island goes with the coast it
    // lies off, not with a farther island whose city happens to be a little closer (Orkney
    // stays with Scotland, not Shetland). Small foreign state -> the cities nearby (below), otherwise
    // neutral scenery.
    let best = -1, bestGap = Infinity, bd = Infinity;
    for (const q of polys) {
      if (q.f !== p.f || !q.cities.length) continue;
      const far = ORPHAN_SAME_FEATURE_DIST;
      if (q.bbox.x0 - p.bbox.x1 > far || p.bbox.x0 - q.bbox.x1 > far || q.bbox.y0 - p.bbox.y1 > far || p.bbox.y0 - q.bbox.y1 > far) continue;
      let gap = null;
      for (const ci of q.cities) {
        const c = cities[ci];
        const d = distToRing(p.rings[0], [c.x, c.y]);
        if (d >= far) continue;
        if (gap === null) gap = ringGap(p.rings[0], q.rings[0]);
        if (gap < bestGap || (gap === bestGap && d < bd)) { bestGap = gap; bd = d; best = ci; }
      }
    }
    owners = best >= 0 ? [best] : [];
    if (best < 0 && p.area < ORPHAN_FOREIGN_MAX_AREA) {
      // The cities within ORPHAN_FOREIGN_DIST of it. An island goes to the nearest of them. Land with
      // neighbours (Slovenia, Luxembourg...) is split between them by distance, like a landmass with
      // several cities: between those that are the nearest of them to some point of its outline.
      const near = [];
      cities.forEach((c, ci) => { if (distToRing(p.rings[0], [c.x, c.y]) < ORPHAN_FOREIGN_DIST) near.push(ci); });
      const nearestTo = ([x, y]) => near.reduce((b, ci) => (b < 0 || (cities[ci].x - x) ** 2 + (cities[ci].y - y) ** 2
        < (cities[b].x - x) ** 2 + (cities[b].y - y) ** 2 ? ci : b), -1);
      if (near.length && bordered.has(p)) owners = [...new Set(p.rings[0].map(nearestTo))].sort((a, b) => a - b);
      else if (near.length) owners = [near.reduce((b, ci) => (distToRing(p.rings[0], [cities[ci].x, cities[ci].y])
        < distToRing(p.rings[0], [cities[b].x, cities[b].y]) ? ci : b))];
    }
    if (owners.length) orphanCount++;
  }
  p.owners = owners;

  const entry = { r: p.rings.map(flat), c: owners };
  if (owners.length >= 2) {
    const bb = { x0: p.bbox.x0 - 20, y0: p.bbox.y0 - 20, x1: p.bbox.x1 + 20, y1: p.bbox.y1 + 20 };
    entry.cells = [];
    owners.forEach((ci, idx) => {
      const ca = cities[ci];
      let cell = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]];
      let labels = [-1, -1, -1, -1];
      for (const cj of owners) {
        if (cj === ci) continue;
        const cb = cities[cj];
        const nx = cb.x - ca.x, ny = cb.y - ca.y;
        const c = (cb.x * cb.x + cb.y * cb.y - ca.x * ca.x - ca.y * ca.y) / 2;
        [cell, labels] = clipHalfPlane(cell, labels, nx, ny, c, cj);
        if (cell.length < 3) break;
      }
      entry.cells.push(flat(cell));
      // Voronoi edges shared with other cities of this landmass (emit each once).
      for (let k = 0; k < cell.length; k++) {
        const cj = labels[k];
        if (cj < 0 || cj < ci) continue;
        const kind = borderKind(ci, cj);
        for (const s of clipSegToPoly(cell[k], cell[(k + 1) % cell.length], p.rings)) {
          segs.push(r1(s[0]), r1(s[1]), r1(s[2]), r1(s[3]), kind);
        }
      }
    });
  }
  outPolys.push(entry);
}

// Line between the territories of cities a and b (-1 = neutral land): 0 = province line
// (two cities of one region), 1 = region border, -1 = none (one city, or neutral on both sides).
function borderKind(a, b) {
  if (a === b) return -1;
  if (a < 0 || b < 0) return 1;
  return cities[a].c === cities[b].c ? 0 : 1;
}

// ---------------------------------------------------------------- borders between landmasses
// Today's national borders are drawn only where they divide two cities' territories. They are
// the ring edges two landmasses share (same points, see simpleTopo), compared after rounding,
// exactly as written to map.json. Each shared edge is cut where a Voronoi edge of either side
// crosses it, and every piece gets the line kind of the two cities it divides.
const ownerAt = (p, x, y) => {
  if (p.owners.length < 2) return p.owners.length ? p.owners[0] : -1;
  let best = -1, bd = Infinity;
  for (const ci of p.owners) {
    const d = (cities[ci].x - x) ** 2 + (cities[ci].y - y) ** 2;
    if (d < bd) { bd = d; best = ci; }
  }
  return best;
};

// Where along a->b (0..1) the point is equally far from two cities of the landmass.
function voronoiCuts(a, b, owners, ts) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (let i = 0; i < owners.length; i++) {
    for (let j = i + 1; j < owners.length; j++) {
      const ci = cities[owners[i]], cj = cities[owners[j]];
      const ex = cj.x - ci.x, ey = cj.y - ci.y;
      const slope = 2 * (dx * ex + dy * ey);
      if (!slope) continue;
      const t = -(2 * (a[0] * ex + a[1] * ey) + ci.x * ci.x + ci.y * ci.y - cj.x * cj.x - cj.y * cj.y) / slope;
      if (t > 0 && t < 1) ts.push(t);
    }
  }
}

let landBorderEdges = 0;
{
  const edges = new Map();   // "x,y,x,y" (smaller point first) -> landmass of the first ring that has it
  polys.forEach((p, pi) => {
    for (const ring of outPolys[pi].r) {
      const n = ring.length / 2;
      for (let e = 0; e < n; e++) {
        const i = 2 * e, j = 2 * ((e + 1) % n);
        const a = [ring[i], ring[i + 1]], b = [ring[j], ring[j + 1]];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const swap = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
        const key = swap ? `${b},${a}` : `${a},${b}`;
        const other = edges.get(key);
        if (other === undefined) { edges.set(key, pi); continue; }
        if (other === pi) continue;
        landBorderEdges++;
        const pa = polys[other];
        const ts = [0, 1];
        voronoiCuts(a, b, p.owners, ts);
        voronoiCuts(a, b, pa.owners, ts);
        ts.sort((x, y) => x - y);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        let from = 0, kind = null;
        const emit = (to) => {
          if (kind >= 0) segs.push(r1(a[0] + dx * from), r1(a[1] + dy * from), r1(a[0] + dx * to), r1(a[1] + dy * to), kind);
        };
        for (let k = 0; k + 1 < ts.length; k++) {
          if (ts[k + 1] - ts[k] < 1e-9) continue;
          const tm = (ts[k] + ts[k + 1]) / 2;
          const x = a[0] + dx * tm, y = a[1] + dy * tm;
          const kk = borderKind(ownerAt(p, x, y), ownerAt(pa, x, y));
          if (kind !== null && kk !== kind) { emit(ts[k]); from = ts[k]; }
          kind = kk;
        }
        emit(1);
      }
    }
  });
}

// ---------------------------------------------------------------- land grid output
// Run-length encode as "polygon:length" pairs in base 36.
function rle(cells) {
  const runs = [];
  let cur = cells[0], len = 0;
  for (const v of cells) {
    if (v === cur) len++;
    else { runs.push(`${cur.toString(36)}:${len.toString(36)}`); cur = v; len = 1; }
  }
  runs.push(`${cur.toString(36)}:${len.toString(36)}`);
  return runs.join(',');
}
// The mountains as shared/mountains.js codes them: navgrid.json blocks them, map.json draws them.
const mountainCode = encodeMask(mountain);
fs.mkdirSync(path.dirname(NAV_OUT), { recursive: true });
fs.writeFileSync(NAV_OUT, JSON.stringify({ ...nav, rle: rle(grid), touches, mountains: mountainCode }));

// ---------------------------------------------------------------- output
const countryOut = countries.map((co, i) => {
  const cs = cities.filter((c) => c.c === i);
  return {
    n: co.n,
    x: r1(cs.reduce((s, c) => s + c.x, 0) / cs.length),
    y: r1(cs.reduce((s, c) => s + c.y, 0) / cs.length),
  };
});

const out = {
  version: 1,
  bounds: { x0: r1(rect.x0), y0: r1(rect.y0), x1: r1(rect.x1), y1: r1(rect.y1) },
  countries: countryOut,
  cities: cities.map((c) => ({ n: c.n, c: c.c, x: r1(c.x), y: r1(c.y) })),
  polys: outPolys,
  segs,
  // On the land grid of navgrid.json (exactly: its cells are what units can't cross).
  mountains: { cell: NAV_CELL, x0: nav.x0, y0: nav.y0, w: nav.w, h: nav.h, code: mountainCode },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const vertexCount = outPolys.reduce((s, p) => s + p.r.reduce((t, r) => t + r.length / 2, 0), 0);
console.log(`map.json: ${countries.length} countries, ${cities.length} cities, ${outPolys.length} landmasses ` +
  `(${orphanCount} orphan islands assigned), ${vertexCount} vertices, ${landBorderEdges} land border edges, ` +
  `${segs.length / 5} border segments, ` +
  `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`bounds: ${JSON.stringify(out.bounds)}`);
console.log(`navgrid.json: ${nav.w}x${nav.h} cells of ${NAV_CELL} km, ${grid.filter((v) => v).length} on land, ` +
  `${touches.length} land borders, ${(fs.statSync(NAV_OUT).size / 1024).toFixed(0)} KB`);
const mountainCells = mountain.reduce((s, v) => s + v, 0);
console.log(`mountains: ${mountainCells} cells (${(mountainCells * NAV_CELL * NAV_CELL / 1000).toFixed(0)}k km²) in ` +
  `${MOUNTAINS.length} ranges; ${passesCut} passes cut, ${pocketsFilled} walled-in valleys filled`);
