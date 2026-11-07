// Land grid built by tools/build-map.js, with line-of-sight checks and A*
// pathfinding so units walk around seas. Land units cannot cross water at all:
// places on another landmass (Britain, Sicily, Zealand, ...) are unreachable.
//
// Every cell stores the landmass polygon it lies in (0 = water). Neighbouring
// cells are linked only when they share a polygon or their polygons share a
// land border, so even straits narrower than a cell cannot be crossed.
//
// Also runs in the host player's browser (browser-to-browser play), so no Node-only imports.

const SQRT2 = Math.SQRT2;
const HEURISTIC_WEIGHT = 1.2;      // >1 trades a little path optimality for much faster searches
const MAX_EXPANSIONS = 400000;
const SEARCHES_PER_TICK = 8;       // background re-plans per tick; player commands are never throttled
const CACHE_TTL = 8;               // seconds
const CACHE_CELL = 4;              // starts within the same 4x4 block of cells share cached paths
const OBSTACLE_COST = 6;           // path cost multiplier for cells next to a city's walls
const OBSTACLE_GRACE = 20;         // km around a destination where obstacles are ignored (attacking a city)

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
    this.labelLandmasses();
  }

  beginTick() {
    this.budget = SEARCHES_PER_TICK;
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
    return this.stepOk(a, b);
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
      if (c !== prev && !this.stepOk(prev, c)) return false;
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
    const { w, h, poly } = this;
    const comp = (this.comp = new Int32Array(w * h));
    const stack = [];
    let next = 0;
    for (let s = 0; s < poly.length; s++) {
      if (!poly[s] || comp[s]) continue;
      comp[s] = ++next;
      stack.push(s);
      while (stack.length) {
        const cur = stack.pop();
        const ci = cur % w, cj = (cur - ci) / w;
        for (const [di, dj] of DIRS) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const n = nj * w + ni;
          if (comp[n] || !this.stepOk(cur, n)) continue;
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

  // Waypoints from (sx, sy) towards (tx, ty), excluding the destination itself.
  // Returns [] when the straight line is clear, null when unreachable.
  findPath(sx, sy, tx, ty) {
    if (this.clear(sx, sy, tx, ty)) return [];
    const sp = this.nearestWalkable(sx, sy, 30);
    if (!sp) return null;
    const tp = this.nearestWalkable(tx, ty, 15, this.landmass(sp[0], sp[1]));
    if (!tp) return null;                                  // on another landmass: unreachable
    const s = this.cellOf(sp[0], sp[1]), t = this.cellOf(tp[0], tp[1]);
    if (s === t) return [];

    const w = this.w, h = this.h, g = this.g, parent = this.parent;
    const seen = this.seen, closed = this.closed, obst = this.obstacle;
    if (++this.stamp === 0xffffffff) { seen.fill(0); closed.fill(0); this.stamp = 1; }
    const stamp = this.stamp;
    const ti = t % w, tj = (t - ti) / w;
    const heur = (i, j) => {
      const dx = Math.abs(i - ti), dy = Math.abs(j - tj);
      return HEURISTIC_WEIGHT * (dx + dy + (SQRT2 - 2) * Math.min(dx, dy));
    };
    this.heapSize = 0;
    g[s] = 0; parent[s] = -1; seen[s] = stamp;
    this.heapPush(s, heur(s % w, (s - (s % w)) / w));
    let found = false, expansions = 0;
    while (this.heapSize) {
      const cur = this.heapPop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === t) { found = true; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      const ci = cur % w, cj = (cur - ci) / w;
      for (const [di, dj, cost] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni;
        if (closed[n] === stamp || !this.stepOk(cur, n)) continue;
        const ng = g[cur] + (obst && obst[n] ? cost * OBSTACLE_COST : cost);
        if (seen[n] !== stamp || ng < g[n]) {
          seen[n] = stamp; g[n] = ng; parent[n] = cur;
          this.heapPush(n, ng + heur(ni, nj));
        }
      }
    }
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
    while (i < pts.length && !this.clear(ax, ay, tx, ty)) {
      let j = i;
      while (j + 1 < pts.length && this.clear(ax, ay, pts[j + 1][0], pts[j + 1][1])) j++;
      out.push(pts[j]);
      [ax, ay] = pts[j];
      i = j + 1;
    }
    return out;
  }

  // Cached search for unit AI. Returns undefined when this tick's search budget
  // is used up (try again next tick). `force` skips the budget (player commands).
  // `fresh` ignores cached results (a unit that got stuck on a cached route).
  findPathCached(sx, sy, tx, ty, force = false, fresh = false) {
    const now = performance.now() / 1000;    // real time: the cache is shared by all games
    const si = Math.floor((sx - this.x0) / (this.cell * CACHE_CELL));
    const sj = Math.floor((sy - this.y0) / (this.cell * CACHE_CELL));
    const key = `${si},${sj}>${this.cellOf(tx, ty)}`;
    const hit = this.cache.get(key);
    if (!fresh && hit && now - hit.time < CACHE_TTL &&
        (!hit.path || !hit.path.length || this.clear(sx, sy, hit.path[0][0], hit.path[0][1]))) {
      return hit.path;
    }
    if (!force) {
      if (this.budget <= 0) return undefined;
      this.budget--;
    }
    const path = this.findPath(sx, sy, tx, ty);
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(key, { path, time: now });
    return path;
  }
}
