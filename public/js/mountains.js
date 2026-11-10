// Mountains on the map: the land units can't cross (shared/mountains.js). Drawn from the very cells the
// game blocks, so the drawing is exactly where units can't go: opaque rocky ground over their outline (the
// colour of the region they lie in doesn't show through; its borders do) and, close up, hill signs as on
// an old map, lit from the top left (ICON_STYLE.md) with a thin ink line.
//
// The map layer is repainted whenever the camera moves, so the signs are built once into a few paths per
// tile, and only the tiles in view are drawn. Signs overlap in rows as on old maps, the nearer (lower) in
// front: each goes into the layer above every sign behind it that it overlaps, so the signs of one layer
// never overlap and a layer is two fills and a stroke; the layers are painted back to front.
import { decodeMask } from '/shared/mountains.js';

const LIGHT = '#efe6cd';                 // the lit (left) face of a sign
const SHADE = '#a48b67';                 // its shaded (right) face
const INK = 'rgba(42, 28, 14, 0.85)';
const HATCH = 'rgba(42, 28, 14, 0.42)';  // engraved lines down the shaded face
const EDGE = 'rgba(78, 56, 32, 0.45)';   // the outline of the mountains' land
// The mountains' ground, opaque: under the signs close up, and darker without them (strategic view,
// minimap, timeline) so the ranges stand out from the land round them.
const AREA = { near: [196, 182, 150], far: [160, 140, 108] };
export const PEAKS_ZOOM = 0.45;          // signs fade in from this zoom over the next 0.1
const TILE = 250;                        // km: signs are drawn by tiles this big
const SPACING = { x: 0.62, y: 0.42 };    // how close signs stand (placePeaks)

// A number in [0, 1) for a cell and a salt: the same on every computer, so the signs never move.
function hash(i, j, salt) {
  let v = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 1442695041);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

// The outline of the mountain cells, as rings round them (marching squares between the cell centres, so
// it runs along the cells' edges with the corners cut), rounded off. Cells touching at a corner are one
// range, as they are for units (no squeezing between them).
function outlineRings(mask, w, h, cell, x0, y0) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h ? mask[j * w + i] : 0);
  const W2 = w + 2;
  const hEdge = (i, j) => ((j + 1) * W2 + i + 1) * 2;       // between the centres of cells (i, j) and (i + 1, j)
  const vEdge = (i, j) => ((j + 1) * W2 + i + 1) * 2 + 1;   // between (i, j) and (i, j + 1)
  const point = (id) => {
    const k = id >> 1, i = (k % W2) - 1, j = Math.floor(k / W2) - 1;
    return id & 1 ? [x0 + (i + 0.5) * cell, y0 + (j + 1) * cell] : [x0 + (i + 1) * cell, y0 + (j + 0.5) * cell];
  };
  // Every block of four cell centres with mountains at some corners but not all: a piece of outline from the
  // edge where going clockwise leaves the mountains to the next edge where it comes back in.
  const next = new Map();
  const seen = new Uint8Array((w + 1) * (h + 1));
  const corner = [0, 0, 0, 0];
  const block = (i, j) => {
    const b = (j + 1) * (w + 1) + i + 1;
    if (seen[b]) return;
    seen[b] = 1;
    corner[0] = at(i, j); corner[1] = at(i + 1, j); corner[2] = at(i + 1, j + 1); corner[3] = at(i, j + 1);
    const sum = corner[0] + corner[1] + corner[2] + corner[3];
    if (sum === 0 || sum === 4) return;
    const edges = [hEdge(i, j), vEdge(i + 1, j), hEdge(i, j + 1), vEdge(i, j)];   // top, right, bottom, left
    for (let e = 0; e < 4; e++) {
      if (!corner[e] || corner[(e + 1) % 4]) continue;
      for (let f = 1; f < 4; f++) {
        const g = (e + f) % 4;
        if (!corner[g] && corner[(g + 1) % 4]) { next.set(edges[e], edges[g]); break; }
      }
    }
  };
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const i = k % w, j = (k - i) / w;
    block(i - 1, j - 1); block(i, j - 1); block(i - 1, j); block(i, j);
  }
  const rings = [];
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const ring = [];
    let e = start;
    while (e !== undefined && next.has(e)) {
      ring.push(point(e));
      const n = next.get(e);
      next.delete(e);
      e = n;
    }
    // Keep the corners only, then round them off twice (Chaikin).
    let r = ring.filter((p, k) => {
      const a = ring[(k + ring.length - 1) % ring.length], b = ring[(k + 1) % ring.length];
      return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
    });
    for (let t = 0; t < 2; t++) {
      const out = [];
      r.forEach((a, k) => {
        const b = r[(k + 1) % r.length];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      });
      r = out;
    }
    if (r.length >= 3) rings.push(r);
  }
  return rings;
}

// How deep in the mountains every cell is: cells to the nearest cell without (chamfer distance).
function depthOf(mask, w, h) {
  const d = new Float32Array(mask.length);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 1e9 : 0;
  const step = (k, i, j, di, dj, cost) => {
    const ni = i + di, nj = j + dj;
    const v = ni >= 0 && nj >= 0 && ni < w && nj < h ? d[nj * w + ni] : 0;
    if (v + cost < d[k]) d[k] = v + cost;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!mask[k]) continue;
      step(k, i, j, -1, 0, 1); step(k, i, j, 0, -1, 1); step(k, i, j, -1, -1, 1.4); step(k, i, j, 1, -1, 1.4);
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      if (!mask[k]) continue;
      step(k, i, j, 1, 0, 1); step(k, i, j, 0, 1, 1); step(k, i, j, 1, 1, 1.4); step(k, i, j, -1, 1, 1.4);
    }
  }
  return d;
}

// The hill signs: one tried on every mountain cell, the deepest first (the biggest signs stand in the
// middle of a range), kept when it stands wholly on mountain cells and far enough from the signs kept
// before that it hides at most the lower part of one behind it.
function placePeaks(mask, w, h, cell, x0, y0) {
  const depth = depthOf(mask, w, h);
  const onMountain = (x, y) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
    return i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
  };
  const tries = [];
  for (let k = 0; k < mask.length; k++) if (mask[k]) tries.push(k);
  tries.sort((a, b) => depth[b] - depth[a] || hash(a, 0, 1) - hash(b, 0, 1));
  const peaks = [];
  const BUCKET = 25;                     // km: kept signs by buckets, to test for overlaps
  const buckets = new Map();
  const key = (bx, by) => bx * 65536 + by;
  for (const k of tries) {
    const i = k % w, j = (k - i) / w;
    const hw = cell * (0.8 + 0.2 * Math.min(depth[k], 4)) * (0.9 + 0.2 * hash(i, j, 2));   // half the width
    const ht = hw * (1.05 + 0.35 * hash(i, j, 3));
    const x = x0 + (i + 0.5 + (hash(i, j, 4) - 0.5) * 0.9) * cell;
    const y = y0 + (j + 0.5 + (hash(i, j, 5) - 0.5) * 0.9) * cell + ht / 2;                 // the foot
    if (!onMountain(x - hw, y) || !onMountain(x + hw, y) || !onMountain(x, y - ht) || !onMountain(x, y - ht / 2)) continue;
    // Side by side the feet may come as close as SPACING.x of the widths, one behind the other the summit of
    // the back one must stand clear above the front one by SPACING.y of the heights.
    const bx = Math.floor(x / BUCKET), by = Math.floor(y / BUCKET);
    let clear = true;
    for (let gx = bx - 1; gx <= bx + 1 && clear; gx++) {
      for (let gy = by - 1; gy <= by + 1 && clear; gy++) {
        for (const o of buckets.get(key(gx, gy)) || []) {
          const dx = Math.abs(x - o.x) / ((hw + o.hw) * SPACING.x), dy = Math.abs(y - o.y) / ((ht + o.ht) * SPACING.y);
          if (dx * dx + dy * dy < 1) { clear = false; break; }
        }
      }
    }
    if (!clear) continue;
    const p = { x, y, hw, ht, lean: (hash(i, j, 6) - 0.5) * 0.3 };
    if (!buckets.has(key(bx, by))) buckets.set(key(bx, by), []);
    buckets.get(key(bx, by)).push(p);
    peaks.push(p);
  }
  // Back to front, each in the layer above the signs behind it that it overlaps.
  peaks.sort((a, b) => a.y - b.y);
  const placed = new Map();
  for (const p of peaks) {
    const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET);
    p.layer = 0;
    for (let gx = bx - 1; gx <= bx + 1; gx++) {
      for (let gy = by - 1; gy <= by + 1; gy++) {
        for (const o of placed.get(key(gx, gy)) || []) {
          if (o.layer >= p.layer && Math.abs(p.x - o.x) < p.hw + o.hw && p.y - p.ht < o.y) p.layer = o.layer + 1;
        }
      }
    }
    if (!placed.has(key(bx, by))) placed.set(key(bx, by), []);
    placed.get(key(bx, by)).push(p);
  }
  return peaks;
}

// One sign into the tile's paths: the slopes curve in a little (steeper near the summit); the left face
// is lit, the right one in shade up to a ridge from the summit, engraved with lines fanning down from
// below the summit; ink along the slopes, none on the foot.
function addPeak(t, { x, y, hw, ht, lean, layer }) {
  while (t.layers.length <= layer) t.layers.push({ light: new Path2D(), shade: new Path2D(), hatch: new Path2D(), ink: new Path2D() });
  const { light, shade, hatch, ink } = t.layers[layer];
  const sx = x + lean * hw, sy = y - ht;
  const lcx = x - hw * 0.42 + lean * hw * 0.3, rcx = x + hw * 0.42 + lean * hw * 0.3, cy = y - ht * 0.32;
  light.moveTo(x - hw, y);
  light.quadraticCurveTo(lcx, cy, sx, sy);
  light.quadraticCurveTo(rcx, cy, x + hw, y);
  light.closePath();
  shade.moveTo(sx, sy);
  shade.quadraticCurveTo(rcx, cy, x + hw, y);
  shade.lineTo(x + hw * 0.12, y);
  shade.quadraticCurveTo(x + lean * hw * 0.5 + hw * 0.12, y - ht * 0.5, sx, sy);
  shade.closePath();
  for (const u of [0.38, 0.7]) {
    const fx = x + hw * (0.12 + 0.88 * u);
    hatch.moveTo(sx + (fx - sx) * 0.22, sy + ht * 0.22);
    hatch.lineTo(fx - hw * 0.04, y - ht * 0.04);
  }
  ink.moveTo(x - hw, y);
  ink.quadraticCurveTo(lcx, cy, sx, sy);
  ink.quadraticCurveTo(rcx, cy, x + hw, y);
  t.x0 = Math.min(t.x0, x - hw); t.x1 = Math.max(t.x1, x + hw);
  t.y0 = Math.min(t.y0, sy); t.y1 = Math.max(t.y1, y);
}

// The mountains of `map` (map.mountains, built by tools/build-map.js) ready to paint, or null if it has none.
export function buildMountains(map) {
  const m = map.mountains;
  if (!m || !m.code) return null;
  const { cell, x0, y0, w, h } = m;
  const mask = decodeMask(m.code, w * h);
  const area = new Path2D();
  for (const r of outlineRings(mask, w, h, cell, x0, y0)) {
    area.moveTo(r[0][0], r[0][1]);
    for (let k = 1; k < r.length; k++) area.lineTo(r[k][0], r[k][1]);
    area.closePath();
  }
  const tiles = new Map();
  const peaks = placePeaks(mask, w, h, cell, x0, y0);
  for (const p of peaks) {
    const k = `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
    if (!tiles.has(k)) tiles.set(k, { layers: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    addPeak(tiles.get(k), p);
  }
  return { area, tiles: [...tiles.values()], peaks: peaks.length };
}

// Paints the mountains in world coordinates at zoom z. `view` ({ x0, y0, x1, y1 }, world units): the part of
// the map on screen, to draw the signs there; without it (minimap, timeline) only the tinted land.
export function paintMountains(ctx, art, z, view = null) {
  const fade = view ? Math.max(0, Math.min(1, (z - PEAKS_ZOOM) / 0.1)) : 0;
  ctx.fillStyle = `rgb(${AREA.far.map((v, k) => Math.round(v + (AREA.near[k] - v) * fade)).join(',')})`;
  ctx.fill(art.area, 'evenodd');
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1 / z;
  ctx.lineJoin = 'round';
  ctx.stroke(art.area);
  if (fade <= 0) return;
  ctx.globalAlpha = fade;
  ctx.lineWidth = 0.9 / z;
  ctx.lineCap = 'round';
  // Layer by layer (the layers hold for all the tiles together), then tile by tile.
  const shown = art.tiles.filter((t) => t.x1 >= view.x0 && t.x0 <= view.x1 && t.y1 >= view.y0 && t.y0 <= view.y1);
  const layers = shown.reduce((n, t) => Math.max(n, t.layers.length), 0);
  const hatchWidth = 0.7 / z;
  for (let l = 0; l < layers; l++) {
    for (const t of shown) {
      const layer = t.layers[l];
      if (!layer) continue;
      ctx.fillStyle = LIGHT;
      ctx.fill(layer.light);
      ctx.fillStyle = SHADE;
      ctx.fill(layer.shade);
      ctx.strokeStyle = HATCH;
      ctx.lineWidth = hatchWidth;
      ctx.stroke(layer.hatch);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.9 / z;
      ctx.stroke(layer.ink);
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}
