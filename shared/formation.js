// Group moves in formation. The game (server/game.js) lays its formations out with this, and so does the
// preview of a move while the right mouse button is held (public/js/input.js), so the grey ghosts show
// exactly the places the units get.
import { GAME } from './config.js';

export const SHIP_SPACING = 26;      // distance between ships in a group move
const WING_GAP = 0.4;                // extra room (in spacings) between the middle of a formation and its wings
const WING_COLUMNS = 3;              // a wing deeper than the middle grows deeper rather than wider than this

// Where each kind of unit stands: infantry in front, archers behind it, Healers at the very back, cavalry
// and knights on the two wings. At sea, battleships in front of the transports.
const ROLES = {
  infantry: 'front', archer: 'back', healer: 'rear', cavalry: 'wing', knight: 'wing',
  battleship: 'front', transport: 'back',
};

// A unit's place in a formation by its type; a Hero's by its kind (HERO_KINDS: infantry, archer, cavalry).
export function formationRole(type, heroKind = null) {
  return ROLES[type === 'hero' ? heroKind : type] || 'front';
}

// A place for each of `units` in a formation round (tx, ty). Map unit -> [x, y].
//   spacing  distance between two units
//   facing   the way its front looks, in radians (0: east, PI / 2: south); null: the way the group goes,
//            from the middle of where its units set off to (tx, ty)
//   width    how wide the whole formation is, wings and all, in km (the right button dragged: twice as wide as
//            the drag is long), so a wide one has few rows, a narrow one many; null: about twice as wide as deep
//   pos(u)   where a unit sets off from, [x, y]
//   role(u)  'front', 'back', 'rear' or 'wing' (formationRole)
// The middle is rows across the facing: the front units first, then the back ones, then the rear ones, each
// kind in rows of its own. The wing units split into two wings, left and right of the middle, as deep as
// it (with a width, the middle and the wings share it by their numbers of units, so they come out about
// as deep). Units keep their order: those ahead now get the places ahead, those on the left the places on
// the left.
export function formationSlots(units, tx, ty, { spacing = GAME.formationSpacing, facing = null, width = null, pos, role }) {
  const slots = new Map();
  if (!units.length) return slots;
  if (units.length === 1) { slots.set(units[0], [tx, ty]); return slots; }
  const at = new Map(units.map((u) => [u, pos(u)]));
  let cx = 0, cy = 0;
  for (const [x, y] of at.values()) { cx += x; cy += y; }
  cx /= units.length; cy /= units.length;
  let dx, dy;
  if (Number.isFinite(facing)) {
    dx = Math.cos(facing); dy = Math.sin(facing);
  } else {
    dx = tx - cx; dy = ty - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
  }
  const px = -dy, py = dx;            // to the right of the facing
  const fwd = (u) => (at.get(u)[0] - cx) * dx + (at.get(u)[1] - cy) * dy;
  const side = (u) => (at.get(u)[0] - cx) * px + (at.get(u)[1] - cy) * py;
  const place = (u, f, s) => slots.set(u, [tx + px * s + dx * f, ty + py * s + dy * f]);
  // `list` in rows of `width`, the units ahead now in the rows ahead; each row from left to right.
  const rowsOf = (list, width) => {
    const sorted = [...list].sort((a, b) => fwd(b) - fwd(a));
    const out = [];
    for (let i = 0; i < sorted.length; i += width) out.push(sorted.slice(i, i + width).sort((a, b) => side(a) - side(b)));
    return out;
  };

  const groups = { front: [], back: [], rear: [], wing: [] };
  for (const u of units) (groups[role(u)] || groups.front).push(u);
  let wings = groups.wing;
  const middle = [groups.front, groups.back, groups.rear];
  if (!middle.some((g) => g.length)) { middle[0] = wings; wings = []; }   // only riders: one block

  const n = middle.reduce((s, g) => s + g.length, 0);
  let cols, wingCols = 0;
  if (Number.isFinite(width) && width > 0) {
    const across = Math.max(1, Math.round(width / spacing) + 1);      // units side by side, wings and all
    cols = Math.min(n, Math.max(1, Math.round((across * n) / units.length)));
    if (wings.length) wingCols = Math.max(1, Math.round((across - cols) / 2));
  } else {
    cols = Math.max(1, Math.round(Math.sqrt(n * 2)));
  }
  const rows = middle.flatMap((g) => rowsOf(g, cols));
  const depth = rows.length;
  let half = 0;                       // half the width of the middle
  rows.forEach((row, r) => {
    const f = ((depth - 1) / 2 - r) * spacing;
    row.forEach((u, i) => place(u, f, (i - (row.length - 1) / 2) * spacing));
    half = Math.max(half, ((row.length - 1) / 2) * spacing);
  });
  if (!wings.length) return slots;

  // The wings: the riders on the left of the group now take the left one. An odd one out goes to the
  // side it is on.
  const bySide = [...wings].sort((a, b) => side(a) - side(b));
  let k = Math.floor(bySide.length / 2);
  if (bySide.length % 2 && side(bySide[k]) < 0) k++;
  for (const [wing, dir] of [[bySide.slice(0, k), -1], [bySide.slice(k), 1]]) {
    if (!wing.length) continue;
    let wdepth, wcols;
    if (wingCols) {
      wcols = Math.min(wing.length, wingCols);
      wdepth = Math.ceil(wing.length / wcols);
    } else {
      wdepth = Math.max(depth, Math.ceil(wing.length / WING_COLUMNS));
      wcols = Math.ceil(wing.length / wdepth);
    }
    rowsOf(wing, wcols).forEach((row, r) => {
      const f = ((wdepth - 1) / 2 - r) * spacing;
      row.forEach((u, i) => {
        const col = dir < 0 ? row.length - 1 - i : i;      // counted outwards from the middle
        place(u, f, dir * (half + (1 + WING_GAP + col) * spacing));
      });
    });
  }
  return slots;
}
