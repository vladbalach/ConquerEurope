// Mountains: land no unit can cross. tools/build-map.js marks them on the land grid from the ranges in
// tools/mountains.js; the game keeps units out of them (server/nav.js) and the map draws them
// (public/js/mountains.js) from the same cells, so what you see is exactly where units can't go.
//
// Admins can paint mountains on and off in Edit map (server/map-editor.js): saved in
// server/data/mountain-edits.json, they apply on top of the built ones, under the same rules.
//
// A mask of the grid's cells (row by row, 1 = mountain) is stored as run lengths in base 36, alternating:
// cells without mountains, cells with, cells without, ... starting with cells without (maybe 0).

// Where mountains may stand, and what keeps them from walling land in (NavGrid.openWalls).
export const MOUNTAIN_RULES = {
  coastGap: 12,      // km: no built one this close to water, so a road runs along the coast past the ranges (painted ones may reach it)
  cityGap: 35,       // km: none this close to a city: room to gather and fight round every city
  pocket: 150,       // cells: land walled in by them that is smaller than this, without a city, becomes mountain too...
  passWidth: 2,      // ...any other gets a pass: the shortest way out, cleared this many cells to either side
};

export function encodeMask(mask) {
  const runs = [];
  let want = 0, len = 0;
  for (let k = 0; k < mask.length; k++) {
    if ((mask[k] ? 1 : 0) === want) { len++; continue; }
    runs.push(len.toString(36));
    want = 1 - want;
    len = 1;
  }
  runs.push(len.toString(36));
  return runs.join(',');
}

// The mask of `n` cells from its code (all 0 without one).
export function decodeMask(code, n) {
  const mask = new Uint8Array(n);
  if (!code) return mask;
  let pos = 0, on = 0;
  for (const run of code.split(',')) {
    const len = parseInt(run, 36);
    if (on) mask.fill(1, pos, Math.min(n, pos + len));
    pos += len;
    on = 1 - on;
  }
  return mask;
}
