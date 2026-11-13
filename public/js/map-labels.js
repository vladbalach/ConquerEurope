// Where the region names go on the map. A name is printed in the middle of its region's cities,
// unless there it would cover a city (castle and name) or another region's name: then it moves
// to the nearest free spot that still lies inside its region. Plain geometry in world units; the
// renderer measures the texts and the cities. Also the outline of each region (regionOutlines),
// which lights up when a player takes all of it.

// Font size of a region's name in world units: bigger regions get bigger letters.
const SIZE = { perSqrtArea: 0.07, min: 20, max: 60 };
// How far a name looks for a free spot, in label heights: sideways it may also move by half its
// own width. MAX_CHECKS caps how many free spots are tested against the region's borders.
const REACH_X = 3, REACH_Y = 5, STEP = 1 / 3, MAX_CHECKS = 400;
// A name that cannot lie wholly in its region takes a free spot with at least this share inside.
const MIN_INSIDE = 0.6;
// What regionIndex().at() returns off the regions: the sea, or land no city holds (North Africa).
export const SEA = -1, NO_REGION = -2;
const BUCKET = 100;     // world units: the index keeps the territories in a grid of this size

function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return Math.abs(a / 2);
}

// Is (x, y) inside the even-odd fill of these flat rings ([x0, y0, x1, y1, ...])?
function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < r[j] + (y - yj) * (r[i] - r[j]) / (yi - yj)) inside = !inside;
    }
  }
  return inside;
}

function boxOf(rings) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      b.x0 = Math.min(b.x0, r[i]); b.x1 = Math.max(b.x1, r[i]);
      b.y0 = Math.min(b.y0, r[i + 1]); b.y1 = Math.max(b.y1, r[i + 1]);
    }
  }
  return b;
}

// The regions of the map. at(x, y): the region whose land the point is on (or SEA, NO_REGION).
// area[region]: the area of its cities' territories. A landmass with one city belongs to that
// city's region; one with several is split between them by map.polys[].cells.
export function regionIndex(map) {
  const area = map.countries.map(() => 0);
  const parts = [];
  for (const p of map.polys) {
    const box = boxOf(p.r);
    if (p.c.length <= 1) {
      const region = p.c.length ? map.cities[p.c[0]].c : NO_REGION;
      if (region >= 0) area[region] += p.r.reduce((s, r) => s + ringArea(r), 0);
      parts.push({ region, rings: p.r, cell: null, box });
      continue;
    }
    p.c.forEach((ci, k) => {
      const region = map.cities[ci].c, cell = [p.cells[k]], cb = boxOf(cell);
      area[region] += ringArea(p.cells[k]);
      parts.push({
        region, rings: p.r, cell,
        box: { x0: Math.max(box.x0, cb.x0), y0: Math.max(box.y0, cb.y0), x1: Math.min(box.x1, cb.x1), y1: Math.min(box.y1, cb.y1) },
      });
    });
  }
  const b = map.bounds;
  const cols = Math.ceil((b.x1 - b.x0) / BUCKET) + 1, rows = Math.ceil((b.y1 - b.y0) / BUCKET) + 1;
  const col = (x) => Math.floor((x - b.x0) / BUCKET), row = (y) => Math.floor((y - b.y0) / BUCKET);
  const grid = Array.from({ length: cols * rows }, () => []);
  for (const q of parts) {
    for (let j = Math.max(0, row(q.box.y0)); j <= Math.min(rows - 1, row(q.box.y1)); j++) {
      for (let i = Math.max(0, col(q.box.x0)); i <= Math.min(cols - 1, col(q.box.x1)); i++) grid[j * cols + i].push(q);
    }
  }
  const at = (x, y) => {
    const i = col(x), j = row(y);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return SEA;
    for (const q of grid[j * cols + i]) {
      if (x >= q.box.x0 && x <= q.box.x1 && y >= q.box.y0 && y <= q.box.y1
        && (!q.cell || inRings(q.cell, x, y)) && inRings(q.rings, x, y)) return q.region;
    }
    return SEA;
  };
  return { at, area };
}

// Ring edges that two landmasses share are land borders (tools/build-map.js gives neighbours
// exactly the same border points); the others are coast. landEdges(map)(ring, e): is the edge
// from point e of the ring to the next one a land border?
export function landEdges(map) {
  const key = (r, i, j) => (r[i] < r[j] || (r[i] === r[j] && r[i + 1] < r[j + 1])
    ? `${r[i]},${r[i + 1]},${r[j]},${r[j + 1]}` : `${r[j]},${r[j + 1]},${r[i]},${r[i + 1]}`);
  const uses = new Map();
  for (const p of map.polys) {
    for (const r of p.r) {
      for (let i = 0; i < r.length; i += 2) {
        const k = key(r, i, (i + 2) % r.length);
        uses.set(k, (uses.get(k) || 0) + 1);
      }
    }
  }
  return (r, e) => uses.get(key(r, 2 * e, (2 * e + 2) % r.length)) > 1;
}

// The outline of every region, as the map draws it: its stretches of coast and its borders with
// other regions (map.segs of kind 1). outlines[region] = [x0, y0, x1, y1, ...], loose segments.
export function regionOutlines(map, index) {
  const out = map.countries.map(() => []);
  const add = (region, ax, ay, bx, by) => { if (region >= 0) out[region].push(ax, ay, bx, by); };
  // A land border belongs to the regions on either side of it. One segment of map.segs can divide
  // several pairs of regions (it runs on while the line kind stays the same), so it is cut where
  // the region on either side changes: found by halving, to a tenth of a world unit.
  const s = map.segs, SIDE = 0.3, INSET = 1, MIN = 0.1;
  for (let i = 0; i < s.length; i += 5) {
    if (!s[i + 4]) continue;
    const ax = s[i], ay = s[i + 1], dx = s[i + 2] - ax, dy = s[i + 3] - ay;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const nx = -dy / len * SIDE, ny = dx / len * SIDE;
    // The regions on the left and right of the point at t (0..1 along the segment). At its ends
    // the samples stay a little inside, off the other borders that meet there.
    const sides = (t) => {
      const u = Math.min(Math.max(t, Math.min(0.5, INSET / len)), 1 - Math.min(0.5, INSET / len));
      const x = ax + dx * u, y = ay + dy * u;
      return [index.at(x + nx, y + ny), index.at(x - nx, y - ny)];
    };
    const same = (p, q) => p[0] === q[0] && p[1] === q[1];
    const emit = (t0, t1, [left, right]) => {
      if (left === right) return;
      add(left, ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1);
      add(right, ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1);
    };
    const part = (t0, t1, p0, p1) => {
      const tm = (t0 + t1) / 2, pm = sides(tm);
      if (same(p0, pm) && same(pm, p1)) emit(t0, t1, pm);
      else if ((t1 - t0) * len < MIN) emit(t0, t1, pm);
      else { part(t0, tm, p0, pm); part(tm, t1, pm, p1); }
    };
    part(0, 1, sides(0), sides(1));
  }
  // The coast belongs to the region of the city whose territory it bounds. A landmass with several
  // cities is split between them by distance (map.polys[].cells are those Voronoi cells), so a
  // stretch of coast that crosses from one cell into the next is cut where they meet.
  // Where the map's edge cuts a landmass off, its ring runs along the edge; a ragged country cut there
  // (Kazakhstan by the north Caspian) gets stretches of it that run over the sea and back. So an edge on the
  // map's edge is cut where the ring meets that edge line, and only the pieces with the landmass's own land
  // beside them are outline.
  const land = landEdges(map);
  const b = map.bounds;
  const onEdge = (ax, ay, bx, by) => (ax === bx && (ax === b.x0 || ax === b.x1)) || (ay === by && (ay === b.y0 || ay === b.y1));
  for (const p of map.polys) {
    if (!p.c.length) continue;
    const owners = p.c.map((ci) => map.cities[ci]);
    const nearest = (x, y) => {
      let best = owners[0], bd = Infinity;
      for (const c of owners) {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    };
    const coast = (ax, ay, bx, by) => {
      const ca = nearest(ax, ay);
      if (owners.length === 1 || ca === nearest(bx, by)) { add(ca.c, ax, ay, bx, by); return; }
      // Where along the edge (0..1) a point is as far from two of the cities.
      const dx = bx - ax, dy = by - ay, ts = [0, 1];
      for (let k = 0; k < owners.length; k++) {
        for (let m = k + 1; m < owners.length; m++) {
          const u = owners[k], v = owners[m];
          const ex = v.x - u.x, ey = v.y - u.y, slope = 2 * (dx * ex + dy * ey);
          if (!slope) continue;
          const t = -(2 * (ax * ex + ay * ey) + u.x * u.x + u.y * u.y - v.x * v.x - v.y * v.y) / slope;
          if (t > 0 && t < 1) ts.push(t);
        }
      }
      ts.sort((a, c) => a - c);
      for (let k = 0; k + 1 < ts.length; k++) {
        const t0 = ts[k], t1 = ts[k + 1];
        if (t1 - t0 < 1e-9) continue;
        const tm = (t0 + t1) / 2;
        add(nearest(ax + dx * tm, ay + dy * tm).c, ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1);
      }
    };
    for (const r of p.r) {
      const n = r.length / 2;
      const ends = (e) => { const i = 2 * e, j = (2 * e + 2) % r.length; return [r[i], r[i + 1], r[j], r[j + 1]]; };
      // Where the ring meets each line of the map's edge ("x2924.9": the y of those points).
      const cuts = new Map();
      for (let e = 0; e < n; e++) {
        const [ax, ay, bx, by] = ends(e);
        if (!onEdge(ax, ay, bx, by)) continue;
        const key = ax === bx ? `x${ax}` : `y${ay}`;
        if (!cuts.has(key)) cuts.set(key, []);
        cuts.get(key).push(...(ax === bx ? [ay, by] : [ax, bx]));
      }
      for (let e = 0; e < n; e++) {
        if (land(r, e)) continue;
        const [ax, ay, bx, by] = ends(e);
        if (!onEdge(ax, ay, bx, by)) { coast(ax, ay, bx, by); continue; }
        const vertical = ax === bx, key = vertical ? `x${ax}` : `y${ay}`;
        const lo = vertical ? Math.min(ay, by) : Math.min(ax, bx), hi = vertical ? Math.max(ay, by) : Math.max(ax, bx);
        const at = [lo, hi, ...cuts.get(key).filter((v) => v > lo && v < hi)].sort((u, v) => u - v);
        for (let k = 0; k + 1 < at.length; k++) {
          if (at[k + 1] - at[k] < 1e-9) continue;
          const mid = (at[k] + at[k + 1]) / 2;
          // Half a unit inside the map from the middle of the piece: the landmass's own land there?
          const ix = vertical ? ax + (ax === b.x0 ? 0.5 : -0.5) : mid, iy = vertical ? mid : ay + (ay === b.y0 ? 0.5 : -0.5);
          if (index.at(ix, iy) !== nearest(ix, iy).c) continue;
          if (vertical) coast(ax, at[k], ax, at[k + 1]);
          else coast(at[k], ay, at[k + 1], ay);
        }
      }
    }
  }
  return out;
}

// The font size of every region's name, from the area of its cities' territories.
export function regionLabelSizes(index) {
  return index.area.map((a) => Math.max(SIZE.min, Math.min(SIZE.max, Math.sqrt(a) * SIZE.perSqrtArea)));
}

function overlap(boxes, x0, y0, x1, y1) {
  let a = 0;
  for (const b of boxes) {
    const w = Math.min(x1, b.x1) - Math.max(x0, b.x0);
    const h = Math.min(y1, b.y1) - Math.max(y0, b.y0);
    if (w > 0 && h > 0) a += w * h;
  }
  return a;
}

// Where the label box (centre x, y) lies, from a 5 × 3 grid of points: the share in its own
// region, and how many points fall on other land (another region, or land no city holds).
function sample(l, x, y, at) {
  let own = 0, foreign = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      const r = at(x + (i / 4 - 0.5) * l.w * 0.95, y + (j - 1) * l.h * 0.35);
      if (r === l.region) own++;
      else if (r !== SEA) foreign++;
    }
  }
  return { own: own / 15, foreign };
}

function findSpot(l, taken, index) {
  const hw = l.w / 2, hh = l.h / 2;
  const step = l.h * STEP;
  const kx = Math.floor((hw + REACH_X * l.h) / step), ky = Math.floor(REACH_Y * l.h / step);
  const near = taken.filter((b) => b.x1 > l.x - (kx + 1) * step - hw && b.x0 < l.x + (kx + 1) * step + hw
    && b.y1 > l.y - (ky + 1) * step - hh && b.y0 < l.y + (ky + 1) * step + hh);
  const spots = [];
  for (let j = -ky; j <= ky; j++) {
    for (let i = -kx; i <= kx; i++) {
      if ((i / kx) ** 2 + (j / ky) ** 2 <= 1) spots.push([i * step, j * step, Math.hypot(i, j)]);
    }
  }
  spots.sort((a, b) => a[2] - b[2]);
  // A region smaller than its own name (Malta, Shetland) can't hold it: the name goes beside it,
  // on the sea, rather than over its city.
  const small = index.area[l.region] < l.w * l.h;

  let free = null, beside = null, checks = 0;
  const blocked = [];
  for (const [dx, dy] of spots) {
    const x = l.x + dx, y = l.y + dy;
    const over = overlap(near, x - hw, y - hh, x + hw, y + hh);
    if (over > 0) { blocked.push({ x, y, over }); continue; }
    const { own, foreign } = sample(l, x, y, index.at);
    if (own === 1) return { x, y };
    if (!free || own > free.own) free = { x, y, own };
    if (small && !beside && foreign === 0) beside = { x, y };
    if (++checks >= MAX_CHECKS) break;
  }
  if (free && free.own >= MIN_INSIDE) return free;
  if (beside) return beside;
  // Nowhere free: the spot covering the least, among those in the region (the nearest on a tie).
  blocked.sort((a, b) => a.over - b.over);
  return blocked.find((s) => index.at(s.x, s.y) === l.region) || free || { x: l.x, y: l.y };
}

// labels: [{ region, x, y, w, h, fixed }]: (x, y) the preferred centre, w × h the label's box.
// cities: [{ x0, y0, x1, y1 }], the boxes the names must keep off. index: regionIndex(map).
// Moves each label's x and y; bigger names choose first, and every placed name is kept off by
// the ones after it. A `fixed` label (placed by an admin in Edit map) stays where it is, and goes
// first: the others keep off it.
export function placeLabels(labels, cities, index) {
  const taken = cities.slice();
  const order = labels.map((l, i) => i)
    .sort((a, b) => (labels[b].fixed ? 1 : 0) - (labels[a].fixed ? 1 : 0) || labels[b].h - labels[a].h || a - b);
  for (const i of order) {
    const l = labels[i];
    if (!l.fixed) {
      const spot = findSpot(l, taken, index);
      l.x = spot.x;
      l.y = spot.y;
    }
    taken.push({ x0: l.x - l.w / 2, y0: l.y - l.h / 2, x1: l.x + l.w / 2, y1: l.y + l.h / 2 });
  }
  return labels;
}
