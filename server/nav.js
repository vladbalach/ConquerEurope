// Land grid built by tools/build-map.js, with line-of-sight checks and A*
// pathfinding so units walk around seas. Land units cannot cross water at all:
// places on another landmass (Britain, Sicily, Zealand, ...) are unreachable.
//
// Every cell stores the landmass polygon it lies in (0 = water). Neighbouring
// cells are linked only when they share a polygon or their polygons share a
// land border, so even straits narrower than a cell cannot be crossed.
//
// Ships use the same grid the other way round: they sail on water cells (the seas), and the
// coast is a land cell next to a sea cell. That is where transports take units on board and
// land them.
//
// Also runs in the host player's browser (browser-to-browser play), so no Node-only imports.

import { forEachCoastPiece, nearestCell } from '../shared/coastline.js';

const SQRT2 = Math.SQRT2;
const MIN_SEA_CELLS = 400;         // connected water smaller than this (10,000 km²: lakes) can't be sailed
// Straits too narrow for the 5 km grid, opened for ships only (land units still can't cross them).
// Points in map km (the projection of tools/build-map.js), from sea to sea.
const SEA_CHANNELS = [
  [[1207, 1213], [1222, 1196], [1239, 1169]],     // Dardanelles: Aegean -> Sea of Marmara
  [[1419, 1066], [1420, 1055], [1423, 1043]],     // Bosporus: Sea of Marmara -> Black Sea
];
const HEURISTIC_WEIGHT = 1.2;      // >1 trades a little path optimality for much faster searches
const MAX_EXPANSIONS = 400000;
const SEARCHES_PER_TICK = 8;       // background re-plans per tick; player commands are never throttled
const EXPANSIONS_PER_TICK = 40000; // ...and the A* work they may take together (every search counts, one may overrun it)
const SEARCH_COST = 1000;          // the least a search counts as: the work around the A* (line of sight, the string pulled tight)
// A* estimates the way left with landmarks (ALT): the walking distance from a few far-apart cells of every
// landmass and sea to every cell of it. Going round a sea, the straight line says far too little, and the
// search floods half the continent; the landmarks know about the detour. Built on the first search.
const LANDMARKS = 8;               // per landmass and sea
const LANDMARK_MIN_CELLS = 2000;   // smaller landmasses and seas have none (the straight line is good enough there)
const LM_STEP = 5, LM_DIAG = 7;    // table units of a straight and a diagonal step: 7 / 5 < √2, so never too long
const LM_NONE = 0xffff;            // no distance (a cell without landmarks, or both land and sea)
const CACHE_TTL = 8;               // seconds
const CACHE_CELL = 4;              // starts within the same 4x4 block of cells share cached paths
const OBSTACLE_COST = 6;           // path cost multiplier for cells next to a city's walls
const OBSTACLE_GRACE = 20;         // km around a destination where obstacles are ignored (attacking a city)
const DANGER_COST = 4;             // sea path cost multiplier for water within a city's range
// Beaches (markBeaches): about BEACH_SHARE of the coast; the rest is cliffs.
const BEACH_SHARE = 0.26;          // of the shore cells: about 22% of the drawn coastline
const SHELTER_CELLS = 3;           // how far around a coast cell the land is counted (cells): bays score high
const SHELTER_WEIGHT = 0.5;        // shelter against noise in a coast cell's score
const BEACH_NOISE_KM = 25;         // size of the noise's features: how long beach and cliff stretches run
const BEACH_SMOOTH_CELLS = 1;      // scores are averaged over the coast this many cells around
const HARBOUR_RANGE = 30;          // km: the coast this close to a city is always a beach
const MIN_BEACH_ISLAND = 40;       // cells (1,000 km²): smaller landmasses without a city get no beach

// A fixed pseudo-random number in [0, 1) for a lattice point, and smooth noise between them.
function hash2(i, j) {
  let x = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(u, v) {
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

export class NavGrid {
  // Node only (the server and tests). Browsers fetch /navgrid.json and use new NavGrid(data).
  static load(file) {
    const fs = process.getBuiltinModule('node:fs');
    return new NavGrid(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  constructor(data) {
    this.cell = data.cell;
    this.x0 = data.x0;
    this.y0 = data.y0;
    this.w = data.w;
    this.h = data.h;
    const n = this.w * this.h;
    this.poly = new Uint16Array(n);
    let pos = 0;
    for (const run of data.rle.split(',')) {
      const [v, l] = run.split(':');
      const len = parseInt(l, 36);
      this.poly.fill(parseInt(v, 36), pos, pos + len);
      pos += len;
    }
    this.touch = new Set(data.touches.map(([a, b]) => a * 65536 + b));

    // A* scratch space, reused between searches (stamps avoid clearing).
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.stamp = 0;
    this.heapIdx = new Int32Array(4096);
    this.heapF = new Float64Array(4096);
    this.heapSize = 0;
    this.cache = new Map();
    this.budget = SEARCHES_PER_TICK;
    this.expansionBudget = EXPANSIONS_PER_TICK;
    this.lastExpansions = 0;
    this.landmarks = null;               // the landmark tables (buildLandmarks), on the first search
    // Neighbours as index offsets (DIRS order), and back: dirAt[b - a + w + 1] is the direction from a to b.
    this.offsets = DIRS.map(([di, dj]) => dj * this.w + di);
    this.dirAt = new Int8Array(2 * this.w + 3).fill(-1);
    this.offsets.forEach((o, d) => { this.dirAt[o + this.w + 1] = d; });
    this.landSteps = this.stepMasks((a, b) => this.stepOk(a, b), (c) => this.poly[c] > 0);
    this.labelLandmasses();
    this.labelSeas();
    this.seaSteps = this.stepMasks((a, b) => this.seaStepOk(a, b), (c) => this.sea[c] > 0);
    this.findCoasts();
  }

  beginTick() {
    this.budget = SEARCHES_PER_TICK;
    this.expansionBudget = EXPANSIONS_PER_TICK;
  }

  // For every cell, a bit per direction (DIRS order) in which `ok` lets a unit step to the neighbour:
  // stepOk and seaStepOk worked out once, so searches and line-of-sight checks only test a bit.
  stepMasks(ok, from) {
    const { w, h } = this;
    const mask = new Uint8Array(w * h);
    for (let c = 0; c < mask.length; c++) {
      if (!from(c)) continue;
      const ci = c % w, cj = (c - ci) / w;
      let m = 0;
      for (let d = 0; d < 8; d++) {
        const ni = ci + DIRS[d][0], nj = cj + DIRS[d][1];
        if (ni >= 0 && nj >= 0 && ni < w && nj < h && ok(c, nj * w + ni)) m |= 1 << d;
      }
      mask[c] = m;
    }
    return mask;
  }

  // stepOk and seaStepOk from the masks, for a cell b next to a, or a itself (false for any other cell).
  landStep(a, b) {
    if (a === b) return this.poly[a] > 0;
    const d = this.dirAt[b - a + this.w + 1];
    return d >= 0 && ((this.landSteps[a] >> d) & 1) === 1;
  }

  seaStep(a, b) {
    if (a === b) return this.sea[a] > 0;
    const d = this.dirAt[b - a + this.w + 1];
    return d >= 0 && ((this.seaSteps[a] >> d) & 1) === 1;
  }

  // ---------------------------------------------------------------- cells
  cellOf(x, y) {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((y - this.y0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  center(idx) {
    const i = idx % this.w;
    return [this.x0 + (i + 0.5) * this.cell, this.y0 + ((idx - i) / this.w + 0.5) * this.cell];
  }

  walkable(x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 && this.poly[c] > 0;
  }

  // Two land cells (any distance apart) whose polygons are the same or share a border.
  linked(a, b) {
    const pa = this.poly[a], pb = this.poly[b];
    if (!pa || !pb) return false;
    return pa === pb || this.touch.has(pa < pb ? pa * 65536 + pb : pb * 65536 + pa);
  }

  // Can a unit step from cell a to the neighbouring cell b (8-way)?
  stepOk(a, b) {
    if (a === b) return this.poly[a] > 0;
    const w = this.w;
    const ai = a % w, aj = (a - ai) / w, bi = b % w, bj = (b - bi) / w;
    const di = bi - ai, dj = bj - aj;
    if (di < -1 || di > 1 || dj < -1 || dj > 1) return false;
    if (!this.linked(a, b)) return false;
    if (di && dj) {
      // No squeezing diagonally past a corner of water.
      const c1 = aj * w + bi, c2 = bj * w + ai;
      return this.linked(a, c1) && this.linked(c1, b) && this.linked(a, c2) && this.linked(c2, b);
    }
    return true;
  }

  // Is a short move from (ax, ay) to (bx, by) allowed? (moves are smaller than a cell)
  canStep(ax, ay, bx, by) {
    const a = this.cellOf(ax, ay), b = this.cellOf(bx, by);
    if (a < 0 || b < 0) return false;
    if (!this.poly[a]) return this.poly[b] > 0;      // already off the grid: let it climb back onto land
    return this.landStep(a, b);
  }

  // True when the straight segment stays on one connected stretch of land.
  los(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(d / (this.cell * 0.5));
    let prev = this.cellOf(ax, ay);
    if (prev < 0 || !this.poly[prev]) return false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const c = this.cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (c < 0) return false;
      if (c !== prev && !this.landStep(prev, c)) return false;
      prev = c;
    }
    return true;
  }

  // Mark circular obstacles (cities): paths go around them instead of through them.
  markObstacles(circles) {
    this.obstacle = new Uint8Array(this.w * this.h);
    for (const { x, y, r } of circles) {
      const i0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell));
      const i1 = Math.min(this.w - 1, Math.floor((x + r - this.x0) / this.cell));
      const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell));
      const j1 = Math.min(this.h - 1, Math.floor((y + r - this.y0) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const [cx, cy] = this.center(j * this.w + i);
          if (Math.hypot(cx - x, cy - y) <= r) this.obstacle[j * this.w + i] = 1;
        }
      }
    }
    this.cache.clear();
  }

  // Water within reach of a city's guns (circles: { x, y, r }). Ships' paths keep out of it where
  // the sea allows: each such cell remembers its nearest circle (index + 1).
  markDanger(circles) {
    const zone = (this.danger = new Uint16Array(this.w * this.h));
    this.dangerZones = circles;
    circles.forEach(({ x, y, r }, k) => {
      const i0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell));
      const i1 = Math.min(this.w - 1, Math.floor((x + r - this.x0) / this.cell));
      const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell));
      const j1 = Math.min(this.h - 1, Math.floor((y + r - this.y0) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * this.w + i;
          if (!this.sea[c]) continue;
          const [cx, cy] = this.center(c);
          const d = Math.hypot(cx - x, cy - y);
          if (d > r) continue;
          const other = zone[c] ? circles[zone[c] - 1] : null;
          if (!other || d < Math.hypot(cx - other.x, cy - other.y)) zone[c] = k + 1;
        }
      }
    });
    this.cache.clear();
  }

  // Like seaLos(), but a ship only crosses the range of a city it starts or ends in.
  seaClear(ax, ay, bx, by) {
    if (!this.seaLos(ax, ay, bx, by)) return false;
    const zone = this.danger;
    if (!zone) return true;
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (this.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const k = zone[this.cellOf(ax + (bx - ax) * t, ay + (by - ay) * t)];
      if (!k) continue;
      const z = this.dangerZones[k - 1];
      if (Math.hypot(ax - z.x, ay - z.y) > z.r && Math.hypot(bx - z.x, by - z.y) > z.r) return false;
    }
    return true;
  }

  // Like los(), but also refuses to pass through obstacles (except right at the destination).
  clear(ax, ay, bx, by) {
    if (!this.los(ax, ay, bx, by)) return false;
    const obst = this.obstacle;
    if (!obst) return true;
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(d / (this.cell * 0.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (obst[this.cellOf(x, y)] && Math.hypot(bx - x, by - y) > OBSTACLE_GRACE) return false;
    }
    return true;
  }

  // Give every connected landmass an id so unreachable targets are detected
  // instantly instead of by searching the whole continent.
  labelLandmasses() {
    const { w, h, poly, landSteps, offsets } = this;
    const comp = (this.comp = new Int32Array(w * h));
    const stack = [];
    let next = 0;
    for (let s = 0; s < poly.length; s++) {
      if (!poly[s] || comp[s]) continue;
      comp[s] = ++next;
      stack.push(s);
      while (stack.length) {
        const cur = stack.pop();
        const m = landSteps[cur];
        for (let d = 0; d < 8; d++) {
          if (!((m >> d) & 1)) continue;
          const n = cur + offsets[d];
          if (comp[n]) continue;
          comp[n] = next;
          stack.push(n);
        }
      }
    }
  }

  // The grid as pathfinding sees it, for the debug console's "show navigation" (debug builds only):
  // the connected-landmass id of every cell (0 = not walkable), run-length encoded like the
  // navgrid file, and the cells around cities that paths avoid.
  debugExport() {
    const runs = [];
    const comp = this.comp;
    let cur = comp[0], len = 0;
    for (let k = 0; k < comp.length; k++) {
      if (comp[k] === cur) { len++; continue; }
      runs.push(`${cur.toString(36)}:${len.toString(36)}`);
      cur = comp[k]; len = 1;
    }
    runs.push(`${cur.toString(36)}:${len.toString(36)}`);
    const obstacles = [];
    if (this.obstacle) this.obstacle.forEach((v, k) => { if (v) obstacles.push(k); });
    return { cell: this.cell, x0: this.x0, y0: this.y0, w: this.w, h: this.h, comp: runs.join(','), obstacles };
  }

  // Landmass id at (x, y); 0 for water or outside the map.
  landmass(x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 ? this.comp[c] : 0;
  }

  // Closest walkable point (cell centre) to (x, y), or null if none within maxDist.
  // With `landmass` set, only points on that landmass count.
  nearestWalkable(x, y, maxDist = 250, landmass = 0) {
    const here = this.landmass(x, y);
    if (here && (!landmass || here === landmass)) return [x, y];
    const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((y - this.y0) / this.cell);
    const maxR = Math.ceil(maxDist / this.cell);
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      const test = (i, j) => {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
        const c = this.comp[j * this.w + i];
        if (!c || (landmass && c !== landmass)) return;
        const p = this.center(j * this.w + i);
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) { bd = d; best = p; }
      };
      for (let d = -r; d <= r; d++) { test(ci + d, cj - r); test(ci + d, cj + r); }
      for (let d = -r + 1; d < r; d++) { test(ci - r, cj + d); test(ci + r, cj + d); }
      if (best && bd <= maxDist) return best;
    }
    return null;
  }

  // ---------------------------------------------------------------- seas
  // Give every connected stretch of water an id (this.sea, 0 = not sailable). Water is every cell
  // outside the land polygons, plus the strait channels. Lakes smaller than MIN_SEA_CELLS are not seas.
  labelSeas() {
    const { w, h, poly } = this;
    const n = w * h;
    const water = new Uint8Array(n);
    for (let k = 0; k < n; k++) water[k] = poly[k] ? 0 : 1;
    for (const line of SEA_CHANNELS) this.carve(water, line);
    // A diagonal step needs open water on at least one side, so a ship never slips between two
    // land cells that touch at a corner.
    const step = (a, b, ai, aj, bi, bj) => {
      if (!water[b]) return false;
      if (ai === bi || aj === bj) return true;
      return water[aj * w + bi] || water[bj * w + ai];
    };
    const comp = new Int32Array(n), size = [0], stack = [];
    let next = 0;
    for (let s = 0; s < n; s++) {
      if (!water[s] || comp[s]) continue;
      comp[s] = ++next;
      size[next] = 1;
      stack.push(s);
      while (stack.length) {
        const cur = stack.pop();
        const ci = cur % w, cj = (cur - ci) / w;
        for (const [di, dj] of DIRS) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const m = nj * w + ni;
          if (comp[m] || !step(cur, m, ci, cj, ni, nj)) continue;
          comp[m] = next;
          size[next]++;
          stack.push(m);
        }
      }
    }
    // Small ids for the seas big enough to sail; lakes get 0.
    const id = new Uint16Array(next + 1);
    let seas = 0;
    for (let k = 1; k <= next; k++) if (size[k] >= MIN_SEA_CELLS) id[k] = ++seas;
    this.sea = new Uint16Array(n);
    for (let k = 0; k < n; k++) if (comp[k]) this.sea[k] = id[comp[k]];
    this.seaCount = seas;
  }

  // Mark the cells along a polyline as water, without diagonal-only gaps, so the channel is sailable.
  carve(water, line) {
    const w = this.w;
    for (let k = 0; k + 1 < line.length; k++) {
      const [ax, ay] = line[k], [bx, by] = line[k + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (this.cell / 4));
      let prev = -1;
      for (let s = 0; s <= steps; s++) {
        const c = this.cellOf(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
        if (c < 0) continue;
        water[c] = 1;
        if (prev >= 0 && prev !== c) {
          const pi = prev % w, pj = (prev - pi) / w, ci = c % w;
          if (pi !== ci && pj !== (c - ci) / w) water[pj * w + ci] = 1;
        }
        prev = c;
      }
    }
  }

  // The coast: land cells next to a sea cell, listed per landmass and sea, each with the sea cell a
  // transport docks at (an orthogonal neighbour when there is one). Ships take units on board and land
  // them only on beaches (this.landing, see markBeaches): until those are marked, anywhere on the coast.
  findCoasts() {
    const { w, h, comp, sea } = this;
    const n = w * h;
    const lists = new Map();
    const added = [];
    for (let c = 0; c < n; c++) {
      if (!comp[c]) continue;
      const ci = c % w, cj = (c - ci) / w;
      added.length = 0;
      for (const [di, dj] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const m = nj * w + ni, s = sea[m];
        if (!s || added.includes(s)) continue;
        added.push(s);
        const key = comp[c] * 65536 + s;
        if (!lists.has(key)) lists.set(key, []);
        lists.get(key).push(c, m);
      }
    }
    this.coasts = new Map([...lists].map(([k, v]) => [k, Int32Array.from(v)]));
    this.isCoast = new Uint8Array(n);
    for (const list of this.coasts.values()) for (let k = 0; k < list.length; k += 2) this.isCoast[list[k]] = 1;
    this.shore = null;
    this.landing = this.coasts;
    this.beach = null;
    this.beachCode = '';
    this.shoreCode = '';
  }

  // The shore: the coast cells on the coastline the map draws (shared/coastline.js): for every piece of
  // it, the coast cell nearest to it. The grid's coast also has cells behind those (it is finer than the
  // drawing in places); they are never beaches, so every beach is drawn, and every drawn beach is one.
  // Every drawn piece is also remembered with its shore cell, by the grid cell it lies in, for the brush.
  markShore(map) {
    const shore = (this.shore = new Uint8Array(this.w * this.h));
    const pieces = (this.shorePieces = new Map());     // grid cell -> [x, y, shore cell, ...] of the pieces in it
    forEachCoastPiece(map, (ax, ay, bx, by) => {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const c = nearestCell(this, mx, my, (k) => this.isCoast[k] === 1);
      if (c < 0) return;
      shore[c] = 1;
      const at = this.cellOf(mx, my);
      if (!pieces.has(at)) pieces.set(at, []);
      pieces.get(at).push(mx, my, c);
    });
    let last = 0;
    const steps = [];
    for (let c = 0; c < shore.length; c++) if (shore[c]) { steps.push((c - last).toString(36)); last = c; }
    this.shoreCode = steps.join(',');
  }

  // Beaches: the stretches of coast where ships take units on board and land them, about BEACH_SHARE
  // of the coast; the rest is cliffs. Sheltered coast (bays, coves: land wrapped around the water) makes
  // a beach, open headlands make cliffs, mixed with a fixed smooth noise so long straight shores also
  // alternate. Scores are averaged along the shore, so beaches come in stretches. The coast near a city
  // (`towns`: [[x, y], ...], within HARBOUR_RANGE) is always a beach (its harbour), and every island gets
  // one, except tiny ones without a city (under MIN_BEACH_ISLAND cells): those get none at all. It
  // depends only on the grid and the cities: the same in every game and on every computer.
  // `edits` ({ beach: [cell, ...], cliff: [cell, ...] }): coast cells an admin painted in Edit map,
  // which win over all of that. `map`: the map as drawn; only its shore cells can be beaches (markShore).
  markBeaches(towns, edits = null, map = null) {
    if (map) this.markShore(map);
    const { w, h, comp } = this;
    const n = w * h, W = w + 1;
    // Landmasses that may have beaches: those with a city, and those big enough.
    const size = new Map();
    for (let c = 0; c < n; c++) if (comp[c]) size.set(comp[c], (size.get(comp[c]) || 0) + 1);
    const settled = new Set(towns.map(([x, y]) => this.landmass(x, y)));
    const mayHave = (c) => settled.has(comp[c]) || size.get(comp[c]) >= MIN_BEACH_ISLAND;
    const clampI = (i) => Math.max(0, Math.min(w - 1, i)), clampJ = (j) => Math.max(0, Math.min(h - 1, j));
    // Sums over any box of cells in O(1): prefix sums over (j + 1) * W + (i + 1).
    const prefix = (value) => {
      const S = new Float64Array(W * (h + 1));
      for (let j = 0; j < h; j++) {
        let row = 0;
        for (let i = 0; i < w; i++) {
          row += value(j * w + i);
          S[(j + 1) * W + i + 1] = S[j * W + i + 1] + row;
        }
      }
      return (i, j, r) => {
        const i0 = clampI(i - r), i1 = clampI(i + r), j0 = clampJ(j - r), j1 = clampJ(j + r);
        return [S[(j1 + 1) * W + i1 + 1] - S[j0 * W + i1 + 1] - S[(j1 + 1) * W + i0] + S[j0 * W + i0], (i1 - i0 + 1) * (j1 - j0 + 1)];
      };
    };
    // The coast cells that can be beaches (the shore, when known), once each.
    const isCoast = this.shore || this.isCoast, coastal = [];
    for (let c = 0; c < n; c++) if (isCoast[c]) coastal.push(c);
    // How sheltered each coast cell is (the share of land around it), mixed with the noise...
    const landAround = prefix((c) => (comp[c] ? 1 : 0));
    const raw = new Float64Array(n);
    for (const c of coastal) {
      const i = c % w, j = (c - i) / w;
      const [land, cells] = landAround(i, j, SHELTER_CELLS);
      const [x, y] = this.center(c);
      raw[c] = (land / cells) * SHELTER_WEIGHT + valueNoise(x / BEACH_NOISE_KM, y / BEACH_NOISE_KM) * (1 - SHELTER_WEIGHT);
    }
    // ...then averaged over the coast nearby.
    const rawAround = prefix((c) => raw[c]), coastAround = prefix((c) => isCoast[c]);
    const score = new Float64Array(n);
    for (const c of coastal) {
      const i = c % w, j = (c - i) / w;
      score[c] = rawAround(i, j, BEACH_SMOOTH_CELLS)[0] / coastAround(i, j, BEACH_SMOOTH_CELLS)[0];
    }
    const beach = new Uint8Array(n);
    // Harbours: the coast near every city.
    const reach = Math.ceil(HARBOUR_RANGE / this.cell);
    for (const [x, y] of towns) {
      const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((y - this.y0) / this.cell);
      for (let j = clampJ(cj - reach); j <= clampJ(cj + reach); j++) {
        for (let i = clampI(ci - reach); i <= clampI(ci + reach); i++) {
          const c = j * w + i;
          if (!isCoast[c] || beach[c] || !mayHave(c)) continue;
          const [cx, cy] = this.center(c);
          if (Math.hypot(cx - x, cy - y) <= HARBOUR_RANGE) beach[c] = 1;
        }
      }
    }
    // Every island that may have beaches (on each of its seas) and has none yet gets one at its most
    // sheltered spot: one cell, so a small island is not all beach.
    for (const list of this.coasts.values()) {
      if (!mayHave(list[0])) continue;
      let best = -1;
      for (let k = 0; k < list.length; k += 2) {
        const c = list[k];
        if (!isCoast[c]) continue;               // not on the drawn shore
        if (beach[c]) { best = -2; break; }
        if (best < 0 || score[c] > score[best]) best = c;
      }
      if (best >= 0) beach[best] = 1;
    }
    // The rest of the share: the best scores.
    let count = 0;
    for (const c of coastal) count += beach[c];
    const rest = coastal.filter((c) => !beach[c] && mayHave(c)).sort((a, b) => score[b] - score[a]);
    for (let k = 0; k < Math.round(coastal.length * BEACH_SHARE) - count && k < rest.length; k++) beach[rest[k]] = 1;
    // What admins painted.
    for (const c of edits?.beach || []) if (isCoast[c]) beach[c] = 1;
    for (const c of edits?.cliff || []) if (isCoast[c]) beach[c] = 0;

    this.beach = beach;
    this.beachesChanged();
  }

  // Edit map: make these shore cells beaches (on) or cliffs (off).
  editBeaches(cells, on) {
    if (!this.beach) return;
    const shore = this.shore || this.isCoast;
    for (const c of cells) if (shore[c]) this.beach[c] = on ? 1 : 0;
    this.beachesChanged();
  }

  // What an Edit map brush stroke at (x, y) with radius r km changes: the shore cells behind the pieces
  // of drawn coastline under the brush (so what you see under it changes, wherever those cells lie);
  // without a drawn coastline, the coast cells within r.
  coastCellsNear(x, y, r) {
    const out = new Set();
    const { w, h, cell } = this;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / cell)), i1 = Math.min(w - 1, Math.floor((x + r - this.x0) / cell));
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / cell)), j1 = Math.min(h - 1, Math.floor((y + r - this.y0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * w + i;
        if (this.shorePieces) {
          const p = this.shorePieces.get(c);
          if (p) for (let k = 0; k < p.length; k += 3) if (Math.hypot(p[k] - x, p[k + 1] - y) <= r) out.add(p[k + 2]);
        } else if (this.isCoast[c]) {
          const [cx, cy] = this.center(c);
          if (Math.hypot(cx - x, cy - y) <= r) out.add(c);
        }
      }
    }
    return [...out];
  }

  // The beaches changed: where ships may dock, and the code the browsers draw them from (the beach
  // cells, sorted, as base-36 steps from the last).
  beachesChanged() {
    const beach = this.beach;
    this.landing = new Map();
    for (const [key, list] of this.coasts) {
      const kept = [];
      for (let k = 0; k < list.length; k += 2) if (beach[list[k]]) kept.push(list[k], list[k + 1]);
      if (kept.length) this.landing.set(key, Int32Array.from(kept));
    }
    let last = 0;
    const steps = [];
    for (let c = 0; c < beach.length; c++) if (beach[c]) { steps.push((c - last).toString(36)); last = c; }
    this.beachCode = steps.join(',');
  }

  // The beaches as the browsers get them: the grid they lie on and the coded cells (see markBeaches).
  // With `shore`, also the shore cells (the same until the map is rebuilt): the browsers draw every
  // piece of coast as beach or cliff after the shore cell nearest to it, as markShore picked them.
  beachData(shore = false) {
    return {
      cell: this.cell, x0: this.x0, y0: this.y0, w: this.w, code: this.beachCode, ...(shore ? { shore: this.shoreCode } : {}),
    };
  }


  // Sea id at (x, y); 0 for land, lakes or outside the map.
  seaAt(x, y) {
    const c = this.cellOf(x, y);
    return c >= 0 ? this.sea[c] : 0;
  }

  // Can a ship sail from cell a to the neighbouring cell b (8-way)?
  seaStepOk(a, b) {
    const sea = this.sea;
    if (!sea[a] || !sea[b]) return false;
    if (a === b) return true;
    const w = this.w;
    const ai = a % w, aj = (a - ai) / w, bi = b % w, bj = (b - bi) / w;
    const di = bi - ai, dj = bj - aj;
    if (di < -1 || di > 1 || dj < -1 || dj > 1) return false;
    if (di && dj) return sea[aj * w + bi] > 0 || sea[bj * w + ai] > 0;
    return true;
  }

  // Is a short ship move from (ax, ay) to (bx, by) allowed? (moves are smaller than a cell)
  canSail(ax, ay, bx, by) {
    const a = this.cellOf(ax, ay), b = this.cellOf(bx, by);
    if (a < 0 || b < 0) return false;
    if (!this.sea[a]) return this.sea[b] > 0;        // off the sea: let it get back onto the water
    return this.seaStep(a, b);
  }

  // True when the straight segment stays on the water.
  seaLos(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(d / (this.cell * 0.5));
    let prev = this.cellOf(ax, ay);
    if (prev < 0 || !this.sea[prev]) return false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const c = this.cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (c < 0) return false;
      if (c !== prev && !this.seaStep(prev, c)) return false;
      prev = c;
    }
    return true;
  }

  // Closest sailable point (cell centre) to (x, y), or null if none within maxDist.
  // With `sea` set, only points of that sea count.
  nearestSea(x, y, maxDist = 250, sea = 0) {
    const here = this.seaAt(x, y);
    if (here && (!sea || here === sea)) return [x, y];
    const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((y - this.y0) / this.cell);
    const maxR = Math.ceil(maxDist / this.cell);
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      const test = (i, j) => {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
        const s = this.sea[j * this.w + i];
        if (!s || (sea && s !== sea)) return;
        const p = this.center(j * this.w + i);
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) { bd = d; best = p; }
      };
      for (let d = -r; d <= r; d++) { test(ci + d, cj - r); test(ci + d, cj + r); }
      for (let d = -r + 1; d < r; d++) { test(ci - r, cj + d); test(ci + r, cj + d); }
      if (best && bd <= maxDist) return best;
    }
    return null;
  }


  // The beach of `landmass` on `sea` nearest to (x, y), within maxDist (only beaches take ships):
  // { land: [x, y] (the shore cell), water: [x, y] (where a ship docks), d }, or null.
  // `ok(wx, wy)`: only docks it accepts count (e.g. not one that another ship uses).
  coastNear(x, y, landmass, sea, maxDist = Infinity, ok = null) {
    const list = this.landing.get(landmass * 65536 + sea);
    if (!list) return null;
    const { w, cell, x0, y0 } = this;
    let best = -1, bd = maxDist * maxDist;
    for (let k = 0; k < list.length; k += 2) {
      const c = list[k], i = c % w;
      const dx = x0 + (i + 0.5) * cell - x, dy = y0 + ((c - i) / w + 0.5) * cell - y;
      const d = dx * dx + dy * dy;
      if (d > bd) continue;
      if (ok) {
        const m = list[k + 1], mi = m % w;
        if (!ok(x0 + (mi + 0.5) * cell, y0 + ((m - mi) / w + 0.5) * cell)) continue;
      }
      bd = d; best = k;
    }
    if (best < 0) return null;
    return { land: this.center(list[best]), water: this.center(list[best + 1]), d: Math.sqrt(bd) };
  }

  // ---------------------------------------------------------------- A*
  heapPush(idx, f) {
    if (this.heapSize === this.heapIdx.length) {
      const ni = new Int32Array(this.heapIdx.length * 2); ni.set(this.heapIdx); this.heapIdx = ni;
      const nf = new Float64Array(this.heapF.length * 2); nf.set(this.heapF); this.heapF = nf;
    }
    let k = this.heapSize++;
    const hi = this.heapIdx, hf = this.heapF;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hf[p] <= f) break;
      hi[k] = hi[p]; hf[k] = hf[p];
      k = p;
    }
    hi[k] = idx; hf[k] = f;
  }

  heapPop() {
    const hi = this.heapIdx, hf = this.heapF;
    const top = hi[0];
    const n = --this.heapSize;
    if (n > 0) {
      const idx = hi[n], f = hf[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hi[k] = hi[c]; hf[k] = hf[c];
        k = c;
      }
      hi[k] = idx; hf[k] = f;
    }
    return top;
  }

  // ---------------------------------------------------------------- landmarks (A* estimates)
  // LANDMARKS tables of walking (or sailing) distances in table units (LM_STEP a cell): table k holds, for
  // every cell, its distance from the k-th landmark of its landmass or sea. Landmarks are picked far apart
  // (each the cell farthest from those before it). For two cells of the same landmass, the difference of
  // their distances from a landmark is never more than the way between them (the triangle inequality), and
  // round a sea it is far closer to it than the straight line. Stored by cell: lm[c * LANDMARKS + k].
  buildLandmarks() {
    if (this.landmarks) return;
    const { w, h, comp, sea } = this;
    const n = w * h;
    const table = new Uint16Array(n * LANDMARKS).fill(LM_NONE);
    const dist = new Int32Array(n);
    const nearest = new Int32Array(n);       // distance from the nearest landmark so far
    // Land and sea separately: a strait channel is both, and its cells keep no distance.
    for (const [ids, mask, other] of [[comp, this.landSteps, sea], [sea, this.seaSteps, comp]]) {
      let count = 0;
      for (let c = 0; c < n; c++) if (ids[c] > count) count = ids[c];
      const size = new Int32Array(count + 1), first = new Int32Array(count + 1).fill(-1);
      for (let c = 0; c < n; c++) {
        const id = ids[c];
        if (!id) continue;
        size[id]++;
        if (first[id] < 0) first[id] = c;
      }
      // Only landmasses (seas) big enough get landmarks: `cells` are theirs.
      const big = [];
      for (let id = 1; id <= count; id++) if (size[id] >= LANDMARK_MIN_CELLS) big.push(id);
      if (!big.length) continue;
      const isBig = new Uint8Array(count + 1);
      for (const id of big) isBig[id] = 1;
      const cells = [];
      for (let c = 0; c < n; c++) if (isBig[ids[c]]) cells.push(c);
      // The first landmark of each is the cell farthest from any cell of it (its first one); every
      // next one the cell farthest from the landmarks before it.
      this.distances(big.map((id) => first[id]), mask, nearest);
      const far = new Int32Array(count + 1);
      for (let k = 0; k < LANDMARKS; k++) {
        far.fill(-1);
        for (const c of cells) {
          const id = ids[c], f = far[id];
          if (nearest[c] < 0x7fffffff && (f < 0 || nearest[c] > nearest[f])) far[id] = c;
        }
        this.distances(big.map((id) => far[id]).filter((c) => c >= 0), mask, dist);
        for (const c of cells) {
          const d = dist[c];
          if (!other[c] && d < LM_NONE) table[c * LANDMARKS + k] = d;
          if (k === 0 || d < nearest[c]) nearest[c] = d;
        }
      }
    }
    this.landmarks = table;
  }

  // Distances (table units) from the nearest of `sources` over the steps of `mask`, into `dist`
  // (0x7fffffff where none reaches). Dijkstra with buckets: steps cost LM_STEP or LM_DIAG.
  distances(sources, mask, dist) {
    const INF = 0x7fffffff, offsets = this.offsets;
    dist.fill(INF);
    const cost = DIRS.map((d) => (d[2] === 1 ? LM_STEP : LM_DIAG));
    const buckets = Array.from({ length: 8 }, () => []);   // by distance % 8: a step adds at most 7
    let pending = 0;
    for (const s of sources) { dist[s] = 0; buckets[0].push(s); pending++; }
    for (let cur = 0; pending > 0; cur++) {
      const b = buckets[cur & 7];
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        pending--;
        if (dist[c] !== cur) continue;          // reached by a shorter way since
        const m = mask[c];
        for (let d = 0; d < 8; d++) {
          if (!((m >> d) & 1)) continue;
          const nb = c + offsets[d], nd = cur + cost[d];
          if (nd < dist[nb]) { dist[nb] = nd; buckets[nd & 7].push(nb); pending++; }
        }
      }
      b.length = 0;
    }
  }

  // Waypoints from (sx, sy) towards (tx, ty), excluding the destination itself.
  // Returns [] when the straight line is clear, null when unreachable.
  // `sea`: a ship's path over the water instead of a walk over land.
  findPath(sx, sy, tx, ty, sea = false) {
    this.lastExpansions = 0;
    const clear = sea ? (ax, ay, bx, by) => this.seaClear(ax, ay, bx, by) : (ax, ay, bx, by) => this.clear(ax, ay, bx, by);
    if (clear(sx, sy, tx, ty)) return [];
    const sp = sea ? this.nearestSea(sx, sy, 30) : this.nearestWalkable(sx, sy, 30);
    if (!sp) return null;
    const tp = sea ? this.nearestSea(tx, ty, 15, this.seaAt(sp[0], sp[1]))
      : this.nearestWalkable(tx, ty, 15, this.landmass(sp[0], sp[1]));
    if (!tp) return null;                                  // on another landmass (sea): unreachable
    const s = this.cellOf(sp[0], sp[1]), t = this.cellOf(tp[0], tp[1]);
    if (s === t) return [];

    this.buildLandmarks();
    const w = this.w, g = this.g, parent = this.parent;
    // Extra cost: next to city walls on land, within a city's range at sea.
    const seen = this.seen, closed = this.closed, obst = sea ? this.danger : this.obstacle;
    const penalty = sea ? DANGER_COST : OBSTACLE_COST;
    const mask = sea ? this.seaSteps : this.landSteps, offsets = this.offsets;
    if (++this.stamp === 0xffffffff) { seen.fill(0); closed.fill(0); this.stamp = 1; }
    const stamp = this.stamp;
    const ti = t % w, tj = (t - ti) / w;
    // The estimate: the straight (octile) distance, or what the landmarks of the destination's landmass
    // (sea) say when that is more.
    const lm = this.landmarks, K = LANDMARKS;
    const ak = [], at = [];
    for (let k = 0; k < K; k++) {
      if (lm[t * K + k] !== LM_NONE) { ak.push(k); at.push(lm[t * K + k]); }
    }
    const na = ak.length;
    const heur = (c) => {
      const ci = c % w, dx = Math.abs(ci - ti), dy = Math.abs((c - ci) / w - tj);
      let e = dx + dy + (SQRT2 - 2) * (dx < dy ? dx : dy);
      const base = c * K;
      for (let i = 0; i < na; i++) {
        const v = lm[base + ak[i]];
        if (v === LM_NONE) continue;
        const d = (v > at[i] ? v - at[i] : at[i] - v) / LM_STEP;
        if (d > e) e = d;
      }
      return HEURISTIC_WEIGHT * e;
    };
    this.heapSize = 0;
    g[s] = 0; parent[s] = -1; seen[s] = stamp;
    this.heapPush(s, heur(s));
    let found = false, expansions = 0;
    while (this.heapSize) {
      const cur = this.heapPop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === t) { found = true; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      const m = mask[cur], gc = g[cur];
      for (let d = 0; d < 8; d++) {
        if (!((m >> d) & 1)) continue;
        const n = cur + offsets[d];
        if (closed[n] === stamp) continue;
        const cost = d < 4 ? 1 : SQRT2;
        const ng = gc + (obst && obst[n] ? cost * penalty : cost);
        if (seen[n] !== stamp || ng < g[n]) {
          seen[n] = stamp; g[n] = ng; parent[n] = cur;
          this.heapPush(n, ng + heur(n));
        }
      }
    }
    this.lastExpansions = expansions;
    if (!found) return null;

    // Keep only the cells where the direction changes, then pull the string tight.
    const cells = [];
    for (let c = t; c !== -1; c = parent[c]) cells.push(c);
    cells.reverse();
    const turns = [];
    for (let k = 1; k < cells.length; k++) {
      if (k === cells.length - 1 || cells[k] - cells[k - 1] !== cells[k + 1] - cells[k]) turns.push(cells[k]);
    }
    const pts = turns.map((c) => this.center(c));
    const out = [];
    let ax = sx, ay = sy, i = 0;
    while (i < pts.length && !clear(ax, ay, tx, ty)) {
      let j = i;
      while (j + 1 < pts.length && clear(ax, ay, pts[j + 1][0], pts[j + 1][1])) j++;
      out.push(pts[j]);
      [ax, ay] = pts[j];
      i = j + 1;
    }
    return out;
  }

  // Cached search for unit AI. Returns undefined when this tick's search budget (a number of searches,
  // and of A* expansions, which player commands use up too) is spent: try again next tick. `force`
  // skips the budget (player commands). `fresh` ignores cached results (a unit that got stuck on a
  // cached route). `sea`: a ship's path (findPath).
  findPathCached(sx, sy, tx, ty, force = false, fresh = false, sea = false) {
    this.lastExpansions = 0;                 // stays 0 for a cached path
    const now = performance.now() / 1000;    // real time: the cache is shared by all games
    const si = Math.floor((sx - this.x0) / (this.cell * CACHE_CELL));
    const sj = Math.floor((sy - this.y0) / (this.cell * CACHE_CELL));
    const key = `${sea ? 's' : ''}${si},${sj}>${this.cellOf(tx, ty)}`;
    const hit = this.cache.get(key);
    const clear = (bx, by) => (sea ? this.seaClear(sx, sy, bx, by) : this.clear(sx, sy, bx, by));
    if (!fresh && hit && now - hit.time < CACHE_TTL &&
        (!hit.path || !hit.path.length || clear(hit.path[0][0], hit.path[0][1]))) {
      return hit.path;
    }
    if (!force) {
      if (this.budget <= 0 || this.expansionBudget <= 0) return undefined;
      this.budget--;
    }
    const path = this.findPath(sx, sy, tx, ty, sea);
    this.expansionBudget -= Math.max(this.lastExpansions, SEARCH_COST);
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(key, { path, time: now });
    return path;
  }
}
