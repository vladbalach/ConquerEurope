// Builds public/map.json from Natural Earth (world-atlas 50m) geometry + tools/cities.js.
//
//  1. Project every country polygon with a Lambert azimuthal equal-area projection
//     centred on Europe (units ~ km, y axis pointing down/south).
//  2. Clip to the playable rectangle, simplify, drop tiny islets.
//  3. Assign each city to the landmass (polygon) it stands on.
//  4. Split every landmass between its cities with a Voronoi diagram, so each
//     city owns a territory. Landmasses without a city (small islands, micro
//     states) go to the nearest city.
//  5. Emit the Voronoi edges inside landmasses as province lines / country borders.
//  6. Rasterise land into server/data/navgrid.json (units can only walk on land).
//
// Run: npm run build-map

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { COUNTRIES } from './cities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Output and input paths can be changed with environment variables (used by tests).
const OUT = process.env.MAP_OUT || path.join(ROOT, 'public', 'map.json');
const NAV_OUT = process.env.NAV_OUT || path.join(ROOT, 'server', 'data', 'navgrid.json');
// Cities moved by admins in the game (Edit map), as { "City name": [x, y] } in map units.
// They replace the positions from tools/cities.js.
const CITY_POSITIONS = process.env.CITY_POSITIONS || path.join(ROOT, 'server', 'data', 'city-positions.json');

// Land grid used by the server for movement and pathfinding: units walk on land only.
const NAV_CELL = 5;            // km per grid cell

const SIMPLIFY_TOL = 1.8;      // km
const MIN_RING_AREA = 30;      // km^2, smaller islets / holes are dropped
const MARGIN = 280;            // km of map around the outermost cities
const ORPHAN_SAME_FEATURE_DIST = 700;   // island of a country without a city -> nearest city of that country
const ORPHAN_FOREIGN_DIST = 150;        // tiny state without a city -> nearest city of any country
const ORPHAN_FOREIGN_MAX_AREA = 15000;

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

function simplifyRing(pts, tol) {
  if (pts.length < 4) return pts;
  let far = 0, fd = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = dpOpen(pts.slice(0, far + 1), tol);
  const b = dpOpen(pts.slice(far).concat([pts[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
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

function distToRing(ring, p) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, segDist2(p, ring[j], ring[i]));
  return Math.sqrt(best);
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
  for (const [n, lat, lon] of co.cities) {
    const [x, y] = project(lon, lat);
    cities.push({ n, c: ci, x, y });
  }
});

// The map rectangle comes from the positions in tools/cities.js, before any admin move,
// so moving a city never changes the map size or the land grid.
const rect = {
  x0: Math.min(...cities.map((c) => c.x)) - MARGIN,
  x1: Math.max(...cities.map((c) => c.x)) + MARGIN,
  y0: Math.min(...cities.map((c) => c.y)) - MARGIN,
  y1: Math.max(...cities.map((c) => c.y)) + MARGIN,
};

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
const topo = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/world-atlas/countries-50m.json'), 'utf8'));
const fc = feature(topo, topo.objects.countries);

const polys = [];   // { f: featureIndex, rings: [[ [x,y], ...], ...], bbox, area }
const featureNames = [];
for (const f of fc.features) {
  if (!f.geometry) continue;
  const g = f.geometry;
  const gp = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const fi = featureNames.length;
  let used = false;
  for (const poly of gp) {
    if (!poly[0].some(([lon, lat]) => lon > -45 && lon < 80 && lat > 20 && lat < 85)) continue;
    const rings = [];
    const rawRings = [];   // unsimplified: neighbouring countries share exact borders, so no slivers when rasterised
    for (let k = 0; k < poly.length; k++) {
      let pts = poly[k].map(([lon, lat]) => project(lon, lat));
      const last = pts[pts.length - 1];
      if (pts.length > 1 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
      const raw = clipRingRect(pts, rect);
      if (raw.length >= 3) pts = simplifyRing(raw, SIMPLIFY_TOL);
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
const grid = new Uint16Array(nav.w * nav.h);
const cellX = (i) => nav.x0 + (i + 0.5) * NAV_CELL;
const cellY = (j) => nav.y0 + (j + 0.5) * NAV_CELL;

function rasterPolygon(rings, value) {
  const edges = [];
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] !== r[j][1]) edges.push([r[j][0], r[j][1], r[i][0], r[i][1]]);
    }
  }
  const bb = bboxOf(rings[0]);
  const j0 = Math.max(0, Math.floor((bb.y0 - nav.y0) / NAV_CELL - 0.5));
  const j1 = Math.min(nav.h - 1, Math.ceil((bb.y1 - nav.y0) / NAV_CELL));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const yc = cellY(j);
    xs.length = 0;
    for (const [ax, ay, bx, by] of edges) {
      if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - nav.x0) / NAV_CELL - 0.5));
      const i1 = Math.min(nav.w - 1, Math.floor((xs[k + 1] - nav.x0) / NAV_CELL - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * nav.w + i] = value;
    }
  }
}
polys.forEach((p, pi) => rasterPolygon(p.rawRings, pi + 1));

// Polygons that share border vertices touch by land (TopoJSON shares border arcs exactly).
const touches = [];
{
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
}

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

for (const p of polys) {
  let owners = p.cities;
  if (!owners.length) {
    // Orphan landmass: same-country island -> nearest city of that country,
    // tiny foreign state -> nearest city nearby, otherwise neutral scenery.
    let best = -1, bd = ORPHAN_SAME_FEATURE_DIST;
    cities.forEach((c, ci) => {
      if (c.f !== p.f) return;
      const d = distToRing(p.rings[0], [c.x, c.y]);
      if (d < bd) { bd = d; best = ci; }
    });
    if (best < 0 && p.area < ORPHAN_FOREIGN_MAX_AREA) {
      bd = ORPHAN_FOREIGN_DIST;
      cities.forEach((c, ci) => {
        const d = distToRing(p.rings[0], [c.x, c.y]);
        if (d < bd) { bd = d; best = ci; }
      });
    }
    owners = best >= 0 ? [best] : [];
    if (best >= 0) orphanCount++;
  }

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
        const kind = cities[cj].c === ca.c ? 0 : 1;   // 0 = province line, 1 = country border
        for (const s of clipSegToPoly(cell[k], cell[(k + 1) % cell.length], p.rings)) {
          segs.push(r1(s[0]), r1(s[1]), r1(s[2]), r1(s[3]), kind);
        }
      }
    });
  }
  outPolys.push(entry);
}

// ---------------------------------------------------------------- land grid output
// Run-length encode as "polygon:length" pairs in base 36.
const runs = [];
let cur = grid[0], len = 0;
for (const v of grid) {
  if (v === cur) len++;
  else { runs.push(`${cur.toString(36)}:${len.toString(36)}`); cur = v; len = 1; }
}
runs.push(`${cur.toString(36)}:${len.toString(36)}`);
fs.mkdirSync(path.dirname(NAV_OUT), { recursive: true });
fs.writeFileSync(NAV_OUT, JSON.stringify({ ...nav, rle: runs.join(','), touches }));

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
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const vertexCount = outPolys.reduce((s, p) => s + p.r.reduce((t, r) => t + r.length / 2, 0), 0);
console.log(`map.json: ${countries.length} countries, ${cities.length} cities, ${outPolys.length} landmasses ` +
  `(${orphanCount} orphan islands assigned), ${vertexCount} vertices, ${segs.length / 5} border segments, ` +
  `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`bounds: ${JSON.stringify(out.bounds)}`);
console.log(`navgrid.json: ${nav.w}x${nav.h} cells of ${NAV_CELL} km, ${grid.filter((v) => v).length} on land, ` +
  `${touches.length} land borders, ${(fs.statSync(NAV_OUT).size / 1024).toFixed(0)} KB`);
