// The coastline as the map draws it: the edges of the land rings (map.polys) that no other ring
// shares; a shared edge is a land border between two landmasses. The browsers draw it from this, and
// the game (server/nav.js, markShore) uses it to know which cells of its land grid lie on it: only
// those can be beaches, so what the map shows as beach is exactly where ships can dock.

export const COAST_PIECE_KM = 2;      // the coast is walked in pieces at most this long

// Calls piece(ax, ay, bx, by, first) for every piece of coastline, in order along each stretch of
// coast; `first` is true for the first piece of a stretch.
export function forEachCoastPiece(map, piece) {
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
  for (const p of map.polys) {
    for (const r of p.r) {
      const n = r.length / 2;
      const land = (e) => uses.get(key(r, 2 * e, 2 * ((e + 1) % n))) > 1;
      // Walk the ring from just after a land border, so no stretch of coast is cut in two.
      let start = 0;
      for (let e = 0; e < n; e++) if (land(e)) { start = (e + 1) % n; break; }
      let open = false;
      for (let m = 0; m < n; m++) {
        const e = (start + m) % n, i = 2 * e, j = 2 * ((e + 1) % n);
        if (land(e)) { open = false; continue; }
        const ax = r[i], ay = r[i + 1], bx = r[j], by = r[j + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / COAST_PIECE_KM));
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          piece(ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, !open);
          open = true;
        }
      }
    }
  }
}

// The cell nearest to (x, y), by cell centre, among the cells within 2 of the one it lies in for
// which has(cell) is true; -1 if none. Ties go to the first in row order, so the game and every
// browser pick the same cell. grid: { cell, x0, y0, w }.
export function nearestCell(grid, x, y, has) {
  const { cell, x0, y0, w } = grid;
  const ci = Math.floor((x - x0) / cell), cj = Math.floor((y - y0) / cell);
  let best = -1, bd = Infinity;
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= w) continue;
      const c = j * w + i;
      if (!has(c)) continue;
      const d = Math.hypot(x0 + (i + 0.5) * cell - x, y0 + (j + 0.5) * cell - y);
      if (d < bd) { bd = d; best = c; }
    }
  }
  return best;
}
