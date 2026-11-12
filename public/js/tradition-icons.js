// The pictures of the traditions, drawn on a canvas in a 64x64 logical-px box (sprites.js turns them
// into data URLs). Big (drawTradition, the Honor window): a heraldic shield, the field in the player's
// colour inside a gold border, the tradition's subject on it in silver and gold. Small
// (drawTraditionSmall, 22-24 px): the subject alone as a bold glyph (see there). New icons in this
// style: ICON_STYLE.md. The subjects:
//   heroes        a Greek helmet with a crest
//   mercy         the eight-pointed cross of the Hospitallers
//   brotherhood   two gauntlets clasped over two crossed swords
//   honoredDead   a remembrance flame in a brazier
//   eternalGlory  the honor star in a laurel wreath tied with a red ribbon
// The tier II traditions are set apart by a double gold border with a crimson line between, and a faint red halo.
// Technologies in the same style, the subject alone without the shield (drawTechEmblem):
//   navigation    a compass rose, its north point in the player's colour
//   gunnery       two bronze cannons crossed over three cannonballs, a ring on each in the player's colour
//   roads         a paved Roman road coming out of a triumphal arch, its inscription panel in the player's colour

const INK = '#1a120a';
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (hex, to, t) => `rgb(${rgbOf(hex).map((v, i) => Math.round(v + (to[i] - v) * t)).join(',')})`;
const lighten = (hex, t) => mix(hex, [255, 255, 255], t);
const darken = (hex, t) => mix(hex, [0, 0, 0], t);

const GOLD = [[0, '#fff4c8'], [0.22, '#f2cf6e'], [0.5, '#c9952f'], [0.78, '#87601c'], [1, '#b8903e']];
const SILVER = [[0, '#ffffff'], [0.22, '#e4e8ee'], [0.5, '#a9b1bc'], [0.78, '#646c77'], [1, '#98a0aa']];
const LEAF_GOLD = [[0, '#fff0b0'], [0.5, '#e2b54e'], [1, '#a5761f']];
const LEATHER = [[0, '#7a4a2a'], [1, '#3a2010']];
const FLAME = [[0, '#fff3a0'], [0.45, '#f6a23a'], [1, '#c3302a']];
const RED = [[0, '#ff7a6c'], [0.5, '#c8262c'], [1, '#6e0f12']];

let R = 2;            // device px per logical px: shadows ignore the canvas transform

function grad(ctx, stops, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
function shadow(ctx, blur, ox, oy, color) {
  ctx.shadowColor = color; ctx.shadowBlur = blur * R; ctx.shadowOffsetX = ox * R; ctx.shadowOffsetY = oy * R;
}
// Light along the top-left inner edge of `path`, shade along the bottom-right one.
function bevel(ctx, path, d, lw, light, dark) {
  ctx.save(); ctx.clip(path); ctx.lineWidth = lw;
  ctx.translate(d, d); ctx.strokeStyle = light; ctx.stroke(path);
  ctx.translate(-2 * d, -2 * d); ctx.strokeStyle = dark; ctx.stroke(path);
  ctx.restore();
}
function capsule(p, x1, y1, x2, y2, r) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  p.moveTo(x1 + Math.cos(a + Math.PI / 2) * r, y1 + Math.sin(a + Math.PI / 2) * r);
  p.arc(x1, y1, r, a + Math.PI / 2, a - Math.PI / 2);
  p.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  p.closePath();
}
const xf = (p, m) => { const q = new Path2D(); q.addPath(p, m); return q; };

// ------------------------------------------------------------------ subjects
// Each returns { box, layers } in a -50..50 box, back to front. Layer roles:
//   main (silver), accent (gold), blade, grip, flame, inner (the flame's heart), ribbon, star: filled shapes
//   leaf: the laurel, outlined as a whole;  hole: an opening;  line: detail strokes, clipped to `clip`;
//   shine: a highlight

function helmet() {
  const crest = new Path2D();
  crest.moveTo(-5, -30);
  crest.bezierCurveTo(-21, -28, -30, -33, -28, -40);
  crest.bezierCurveTo(-23, -51, 23, -51, 28, -40);
  crest.bezierCurveTo(30, -33, 21, -28, 5, -30);
  crest.closePath();
  const strands = new Path2D();
  for (let k = 1; k < 12; k++) {
    const a = Math.PI + 0.2 + (k / 12) * (Math.PI - 0.4);
    strands.moveTo(Math.cos(a) * 6, -31 + Math.sin(a) * 3);
    strands.lineTo(Math.cos(a) * 40, -31 + Math.sin(a) * 30);
  }
  const holder = new Path2D();
  holder.rect(-4.5, -34, 9, 5);
  const body = new Path2D();
  body.moveTo(0, -30);
  body.bezierCurveTo(15, -30, 24, -20, 24, -4);
  body.bezierCurveTo(24, 8, 21, 17, 22, 25);
  body.bezierCurveTo(23, 32, 22, 38, 17, 41);
  body.lineTo(7.5, 41); body.lineTo(4, 15); body.lineTo(-4, 15); body.lineTo(-7.5, 41); body.lineTo(-17, 41);
  body.bezierCurveTo(-22, 38, -23, 32, -22, 25);
  body.bezierCurveTo(-21, 17, -24, 8, -24, -4);
  body.bezierCurveTo(-24, -20, -15, -30, 0, -30);
  body.closePath();
  const eyes = new Path2D();
  eyes.moveTo(-19, 0);
  eyes.bezierCurveTo(-15, -6, -7, -6, -2, -3);
  eyes.lineTo(2, -3);
  eyes.bezierCurveTo(7, -6, 15, -6, 19, 0);
  eyes.bezierCurveTo(16, 5, 10, 7, 5, 7);
  eyes.lineTo(4, 16); eyes.lineTo(-4, 16); eyes.lineTo(-5, 7);
  eyes.bezierCurveTo(-10, 7, -16, 5, -19, 0);
  eyes.closePath();
  const nose = new Path2D();
  nose.moveTo(-3.2, -6); nose.lineTo(3.2, -6); nose.lineTo(2.2, 11); nose.quadraticCurveTo(0, 14, -2.2, 11); nose.closePath();
  const lines = new Path2D();
  lines.moveTo(-23, -8); lines.quadraticCurveTo(0, -17, 23, -8);            // brow band
  lines.moveTo(-22, -4); lines.quadraticCurveTo(0, -13, 22, -4);
  lines.moveTo(-20, 6); lines.bezierCurveTo(-18, 18, -18, 30, -13, 39);       // cheek guard ridges
  lines.moveTo(20, 6); lines.bezierCurveTo(18, 18, 18, 30, 13, 39);
  const shine = new Path2D();
  shine.ellipse(-12, -17, 3.2, 8, 0.55, 0, Math.PI * 2);
  return {
    box: [-30, -48, 30, 42],
    layers: [
      { role: 'accent', path: crest },
      { role: 'line', path: strands, clip: crest, w: 0.7 },
      { role: 'main', path: holder },
      { role: 'main', path: body },
      { role: 'line', path: lines, clip: body, w: 0.8 },
      { role: 'hole', path: eyes },
      { role: 'main', path: nose },
      { role: 'shine', path: shine },
    ],
  };
}

function hospitallerCross() {
  const cross = new Path2D(), inner = new Path2D();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, c = Math.cos(a), si = Math.sin(a);
    const r = (x, y) => [x * c - y * si, x * si + y * c];
    cross.moveTo(...r(0, -2));
    cross.quadraticCurveTo(...r(-4.5, -18), ...r(-17, -40));
    cross.lineTo(...r(0, -30));
    cross.lineTo(...r(17, -40));
    cross.quadraticCurveTo(...r(4.5, -18), ...r(0, -2));
    cross.closePath();
    inner.moveTo(...r(-3, -12)); inner.quadraticCurveTo(...r(-5.5, -24), ...r(-12.5, -34.5));   // an engraved line in each arm
    inner.lineTo(...r(0, -27)); inner.lineTo(...r(12.5, -34.5));
    inner.quadraticCurveTo(...r(5.5, -24), ...r(3, -12));
  }
  const boss = new Path2D();
  boss.arc(0, 0, 6.5, 0, Math.PI * 2);
  const shine = new Path2D();
  shine.ellipse(-8, -22, 2.2, 6, 0.4, 0, Math.PI * 2);
  return {
    box: [-42, -42, 42, 42],
    layers: [
      { role: 'main', path: cross },
      { role: 'line', path: inner, clip: cross, w: 0.8 },
      { role: 'shine', path: shine },
      { role: 'accent', path: boss },
    ],
  };
}

// Two swords crossed, points up; over the crossing two gauntlets clasped: the right one behind, the
// left one in front, the right one's fingers curling over the left one's back, the left one's thumb on top.
function brotherhood() {
  const blade = new Path2D();
  blade.moveTo(-3.6, 0); blade.lineTo(-3.6, -49); blade.lineTo(0, -57); blade.lineTo(3.6, -49); blade.lineTo(3.6, 0); blade.closePath();
  const fuller = new Path2D();
  fuller.moveTo(0, -4); fuller.lineTo(0, -46);
  const guard = new Path2D();
  guard.moveTo(-12.5, -1); guard.lineTo(12.5, -1); guard.quadraticCurveTo(15, 1.4, 12.5, 4.6);
  guard.lineTo(-12.5, 4.6); guard.quadraticCurveTo(-15, 1.4, -12.5, -1); guard.closePath();
  const grip = new Path2D();
  grip.rect(-2.7, 5, 5.4, 13);
  const wrap = new Path2D();
  for (let y = 8; y < 18; y += 3) { wrap.moveTo(-2.7, y); wrap.lineTo(2.7, y - 1.5); }
  const pommel = new Path2D();
  pommel.arc(0, 22.5, 4.6, 0, Math.PI * 2);

  const layers = [];
  const TILT = 40, TO_CROSSING = 26;          // degrees from upright; guard to the crossing
  for (const side of [-1, 1]) {
    const rad = (TILT * Math.PI) / 180;
    const m = new DOMMatrix().translate(side * TO_CROSSING * Math.sin(rad), TO_CROSSING * Math.cos(rad)).rotate(-side * TILT);
    const b = xf(blade, m), g = xf(grip, m);
    layers.push({ role: 'blade', path: b }, { role: 'line', path: xf(fuller, m), clip: b, w: 0.9 },
      { role: 'grip', path: g }, { role: 'line', path: xf(wrap, m), clip: g, w: 0.7 },
      { role: 'accent', path: xf(guard, m) }, { role: 'accent', path: xf(pommel, m) });
  }
  const H = new DOMMatrix().translate(0, -1).scale(0.86);
  const cuffL = new Path2D();
  cuffL.moveTo(-27, -12); cuffL.quadraticCurveTo(-25.5, 0, -27, 12); cuffL.lineTo(-17, 8.5); cuffL.lineTo(-17, -8.5); cuffL.closePath();
  const cuffR = new Path2D();
  cuffR.moveTo(27, -12); cuffR.quadraticCurveTo(25.5, 0, 27, 12); cuffR.lineTo(17, 8.5); cuffR.lineTo(17, -8.5); cuffR.closePath();
  const cuffLines = new Path2D();
  cuffLines.moveTo(-22.5, -10); cuffLines.quadraticCurveTo(-21.5, 0, -22.5, 10);
  cuffLines.moveTo(22.5, -10); cuffLines.quadraticCurveTo(21.5, 0, 22.5, 10);
  const handR = new Path2D();
  handR.moveTo(17.5, -8); handR.bezierCurveTo(12, -9.5, 6, -9.5, 2, -8); handR.lineTo(2, 8.5);
  handR.bezierCurveTo(7, 9.5, 12, 9.5, 17.5, 8); handR.closePath();
  const handL = new Path2D();
  handL.moveTo(-17.5, -8); handL.bezierCurveTo(-10, -10.5, -1, -10.5, 5, -8.5);
  handL.bezierCurveTo(9.5, -7, 11, -3, 10.5, 1); handL.bezierCurveTo(10, 5.5, 6, 9, 0, 9);
  handL.lineTo(-17.5, 8); handL.closePath();
  const fingers = new Path2D();
  for (const x of [-9.5, -3.2, 3.1]) capsule(fingers, x + 2.4, -2.5, x - 0.6, 7.8, 2.9);
  const thumb = new Path2D();
  capsule(thumb, -1, -10, 11.5, -10.8, 2.9);
  layers.push(
    { role: 'main', path: xf(cuffL, H) }, { role: 'main', path: xf(cuffR, H) },
    { role: 'line', path: xf(cuffLines, H), w: 0.8 },
    { role: 'main', path: xf(handR, H) }, { role: 'main', path: xf(handL, H) },
    { role: 'main', path: xf(fingers, H) }, { role: 'main', path: xf(thumb, H) });
  return { box: [-36, -26, 36, 43], layers };
}

function brazier(small = false) {
  const flame = new Path2D();
  flame.moveTo(-17, -3);
  flame.bezierCurveTo(-23, -15, -13, -23, -11, -33);
  flame.bezierCurveTo(-7, -26, -5, -25, -4, -29);
  flame.bezierCurveTo(-3, -37, 1, -42, 0, -49);
  flame.bezierCurveTo(10, -40, 9, -31, 9, -25);
  flame.bezierCurveTo(11, -28, 13, -31, 14, -35);
  flame.bezierCurveTo(21, -24, 23, -13, 17, -3);
  flame.closePath();
  const heart = new Path2D();
  heart.moveTo(-9, -3);
  heart.bezierCurveTo(-12, -12, -3, -19, -1, -31);
  heart.bezierCurveTo(4, -20, 12, -13, 9, -3);
  heart.closePath();
  const rim = new Path2D(); rim.roundRect(-28, -7, 56, 6, 3);
  const bowl = new Path2D();
  bowl.moveTo(-25, -1); bowl.lineTo(25, -1);
  bowl.bezierCurveTo(24, 10, 14, 15, 0, 15); bowl.bezierCurveTo(-14, 15, -24, 10, -25, -1);
  bowl.closePath();
  const stem = new Path2D();
  stem.moveTo(-4.5, 14); stem.lineTo(4.5, 14); stem.lineTo(3.5, 31); stem.lineTo(-3.5, 31); stem.closePath();
  const knot = new Path2D(); knot.ellipse(0, 22, 8, 3.4, 0, 0, Math.PI * 2);
  const foot = new Path2D();
  foot.moveTo(-12, 31); foot.lineTo(12, 31); foot.lineTo(18, 39); foot.lineTo(-18, 39); foot.closePath();
  const plinth = new Path2D(); plinth.roundRect(-21, 39, 42, 5.5, 1.5);
  const band = new Path2D();
  band.moveTo(-23, 5); band.quadraticCurveTo(0, 11, 23, 5);
  band.moveTo(-19, 9.5); band.quadraticCurveTo(0, 15, 19, 9.5);
  const shine = new Path2D(); shine.ellipse(-15, 4, 2, 4.5, -0.9, 0, Math.PI * 2);
  const layers = [
    { role: 'flame', path: flame }, { role: 'inner', path: heart },
    { role: 'main', path: plinth }, { role: 'main', path: foot }, { role: 'main', path: stem },
  ];
  if (!small) layers.push({ role: 'main', path: knot });
  layers.push({ role: 'main', path: bowl, tint: true });
  if (!small) layers.push({ role: 'line', path: band, clip: bowl, w: 0.8 }, { role: 'shine', path: shine });
  layers.push({ role: 'main', path: rim, tint: true });
  return { box: [-29, -50, 29, 45], layers };
}

// `small`: fewer, bigger leaves and a bigger star, to read at 22 px.
function laurel(small = false) {
  const RAD = small ? 31 : 33, LEAVES = small ? 4 : 7, L = small ? 18 : 13, W = small ? 7.5 : 5.2, STAR = small ? 25 : 20;
  const stems = new Path2D(), leaves = new Path2D();
  const leaf = (x, y, ang) => {
    const p = new Path2D();
    p.moveTo(0, 0); p.quadraticCurveTo(W, -L / 2, 0, -L); p.quadraticCurveTo(-W, -L / 2, 0, 0); p.closePath();
    leaves.addPath(p, new DOMMatrix().translate(x, y).rotate((ang * 180) / Math.PI));
  };
  for (const side of [1, -1]) {               // 1: the left branch, -1: the right one
    const a0 = Math.PI / 2 + side * 0.32, a1 = Math.PI / 2 + side * 2.6;
    stems.moveTo(Math.cos(a0) * (RAD + 1.3), Math.sin(a0) * (RAD + 1.3));
    stems.arc(0, 0, RAD + 1.3, a0, a1, side < 0);
    stems.arc(0, 0, RAD - 1.3, a1, a0, side > 0);
    stems.closePath();
    for (let k = 0; k < LEAVES; k++) {        // pairs of leaves along the branch, pointing up it
      const a = Math.PI / 2 + side * (0.5 + (k / (LEAVES - 1)) * 1.95);
      const up = Math.atan2(-Math.sin(a) * side, -Math.cos(a) * side);
      leaf(Math.cos(a) * RAD, Math.sin(a) * RAD, up + 0.62);
      leaf(Math.cos(a) * RAD, Math.sin(a) * RAD, up - 0.62);
    }
    leaf(Math.cos(a1) * RAD, Math.sin(a1) * RAD, Math.atan2(-Math.sin(a1) * side, -Math.cos(a1) * side));
  }
  const ribbon = new Path2D();
  for (const s of [-1, 1]) {
    ribbon.moveTo(s * 3, RAD - 1); ribbon.lineTo(s * 14, RAD + 11); ribbon.lineTo(s * 9.5, RAD + 9.5);
    ribbon.lineTo(s * 8, RAD + 14); ribbon.lineTo(s * -1, RAD + 2); ribbon.closePath();
  }
  const knot = new Path2D(); knot.ellipse(0, RAD, 5, 4, 0, 0, Math.PI * 2);
  const star = new Path2D();
  for (let k = 0; k < 10; k++) {
    const d = k % 2 ? STAR * 0.42 : STAR, a = -Math.PI / 2 + (k * Math.PI) / 5;
    if (k) star.lineTo(Math.cos(a) * d, -1 + Math.sin(a) * d); else star.moveTo(Math.cos(a) * d, -1 + Math.sin(a) * d);
  }
  star.closePath();
  const shine = new Path2D(); shine.ellipse(-4, -10, 1.6, 4, 0.5, 0, Math.PI * 2);
  const layers = [
    { role: 'leaf', path: stems }, { role: 'leaf', path: leaves },
    { role: 'ribbon', path: ribbon }, { role: 'ribbon', path: knot },
    { role: 'star', path: star, tint: true },
  ];
  if (!small) layers.push({ role: 'shine', path: shine });
  return { box: [-45, -45, 45, 48], layers };
}

// A compass rose (technology Navigation): four long silver points at the cardinal directions, north
// enamelled in the player's colour, four short gold ones between them, a gold ring and a gold boss. Each
// point is cut along its ridge into a lit half and a shaded one.
function compassRose() {
  const points = (len, side, from) => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const a = from + (k * Math.PI) / 2, at = (r, da) => [Math.cos(a + da) * r, Math.sin(a + da) * r];
      const whole = new Path2D(), shade = new Path2D();
      whole.moveTo(...at(len, 0)); whole.lineTo(...at(side, Math.PI / 4)); whole.lineTo(0, 0);
      whole.lineTo(...at(side, -Math.PI / 4)); whole.closePath();
      shade.moveTo(...at(len, 0)); shade.lineTo(...at(side, Math.PI / 4)); shade.lineTo(0, 0); shade.closePath();
      out.push({ whole, shade });
    }
    return out;
  };
  const ring = new Path2D();
  ring.arc(0, 0, 26, 0, Math.PI * 2);
  ring.moveTo(21, 0); ring.arc(0, 0, 21, 0, Math.PI * 2, true);
  const boss = new Path2D(); boss.arc(0, 0, 4.5, 0, Math.PI * 2);
  const layers = [];
  for (const p of points(39, 10, -Math.PI / 4)) layers.push({ role: 'accent', path: p.whole }, { role: 'shade', path: p.shade });
  layers.push({ role: 'accent', path: ring });
  // North first in the list (k = 0: straight up), drawn in the player's colour.
  points(49, 15, -Math.PI / 2).forEach((p, k) => layers.push({ role: k ? 'main' : 'enamel', path: p.whole }, { role: 'shade', path: p.shade }));
  layers.push({ role: 'accent', path: boss });
  return { box: [-50, -50, 50, 50], layers };
}

// Two cannons crossed in saltire, muzzles up, over a pile of three iron cannonballs (technology Gunnery). The
// barrels are bronze (gold), each tapering to its muzzle, with a knob behind the breech and a reinforcing ring
// enamelled in the player's colour.
function crossedCannons() {
  const barrel = () => {
    const tube = new Path2D();
    tube.moveTo(-5.5, -38); tube.lineTo(5.5, -38); tube.lineTo(10, 18);
    tube.quadraticCurveTo(10, 30, 0, 30); tube.quadraticCurveTo(-10, 30, -10, 18);
    tube.closePath();
    const muzzle = new Path2D(); muzzle.rect(-9, -46, 18, 9);
    const ring = new Path2D(); ring.rect(-12, 4, 24, 8);
    const knob = new Path2D(); knob.rect(-3.5, 28, 7, 7); knob.moveTo(6, 38); knob.arc(0, 38, 6, 0, Math.PI * 2);
    return [tube, muzzle, ring, knob];
  };
  const layers = [];
  for (const deg of [-40, 40]) {               // the one pointing up-left behind the other
    const [tube, muzzle, ring, knob] = barrel().map((p) => xf(p, new DOMMatrix().rotate(deg)));
    layers.push({ role: 'accent', path: knob }, { role: 'accent', path: tube }, { role: 'enamel', path: ring },
      { role: 'accent', path: muzzle });
  }
  for (const [x, y] of [[-9, 41], [9, 41], [0, 27]]) {   // the bottom two first, the top one on them
    const ball = new Path2D(); ball.arc(x, y, 7.5, 0, Math.PI * 2);
    layers.push({ role: 'main', path: ball });
  }
  return { box: [-46, -48, 46, 50], layers };
}

// A paved Roman road (technology Roads) coming toward you out of a triumphal arch on the horizon. The road
// is silver flagstones in rows that close up with the distance, its right half shaded (a cambered road lit
// from the left), between two gold kerbs. The arch is gold, with pilasters, a keystone over its opening, a
// cornice, and an inscription panel enamelled in the player's colour.
function romanRoad() {
  // The road from the arch's foot (y TOP, half-width FAR) to the bottom (BOT, NEAR); the kerbs widen from KF to KN.
  const TOP = -12, BOT = 48, FAR = 9, NEAR = 36, KF = 2.5, KN = 10, ROWS = 5;
  const along = (y) => (y - TOP) / (BOT - TOP);
  const half = (y) => FAR + (NEAR - FAR) * along(y);
  const kerbW = (y) => KF + (KN - KF) * along(y);
  const quad = (x0, x1, x2, x3) => {           // top-left, top-right, bottom-right, bottom-left x
    const p = new Path2D();
    p.moveTo(x0, TOP); p.lineTo(x1, TOP); p.lineTo(x2, BOT); p.lineTo(x3, BOT); p.closePath();
    return p;
  };
  const road = quad(-FAR, FAR, NEAR, -NEAR);
  const crown = quad(0, FAR, NEAR, 0);
  const kerbs = [-1, 1].map((s) => quad(s * FAR, s * (FAR + KF), s * (NEAR + KN), s * NEAR));
  // Flagstones: rows closing up toward the arch, joints staggered from row to row and running to the
  // vanishing point; each kerb stone as long as its row.
  const ys = Array.from({ length: ROWS + 1 }, (_, k) => TOP + (BOT - TOP) * (k / ROWS) ** 1.55);
  const joints = new Path2D(), kerbJoints = new Path2D();
  for (let k = 0; k < ROWS; k++) {
    const y0 = ys[k], y1 = ys[k + 1], mid = (y0 + y1) / 2;
    if (k) { joints.moveTo(-half(y0), y0); joints.lineTo(half(y0), y0); }
    for (const u of k % 2 ? [-0.5, 0, 0.5] : [-0.75, -0.25, 0.25, 0.75]) {
      joints.moveTo(u * half(y0), y0); joints.lineTo(u * half(y1), y1);
    }
    for (const s of [-1, 1]) { kerbJoints.moveTo(s * half(mid), mid); kerbJoints.lineTo(s * (half(mid) + kerbW(mid)), mid); }
  }
  // The arch: its body with a round-headed opening as wide as the road, standing on the road's end.
  const arch = new Path2D();
  arch.moveTo(-24, TOP); arch.lineTo(-24, -44); arch.lineTo(24, -44); arch.lineTo(24, TOP); arch.lineTo(FAR, TOP);
  arch.lineTo(FAR, -24); arch.arc(0, -24, FAR, 0, Math.PI, true); arch.lineTo(-FAR, TOP); arch.closePath();
  const opening = new Path2D();
  opening.moveTo(-FAR, TOP); opening.lineTo(-FAR, -24); opening.arc(0, -24, FAR, Math.PI, 0); opening.lineTo(FAR, TOP); opening.closePath();
  const cornice = new Path2D(); cornice.rect(-28, -50, 56, 7);
  const panel = new Path2D(); panel.rect(-14, -41.5, 28, 6);
  const keystone = new Path2D();
  keystone.moveTo(-3, -34.5); keystone.lineTo(3, -34.5); keystone.lineTo(2, -29.5); keystone.lineTo(-2, -29.5); keystone.closePath();
  const archLines = new Path2D();
  for (const s of [-1, 1]) {
    archLines.moveTo(s * 17, -43); archLines.lineTo(s * 17, TOP);            // pilasters
    archLines.moveTo(s * 24, -24); archLines.lineTo(s * 17, -24);            // imposts
  }
  return {
    box: [-50, -50, 50, 50],
    layers: [
      { role: 'hole', path: opening },
      { role: 'main', path: road }, { role: 'shade', path: crown },
      { role: 'line', path: joints, clip: road, w: 0.9 },
      { role: 'accent', path: kerbs[0] }, { role: 'accent', path: kerbs[1] },
      { role: 'line', path: kerbJoints, w: 0.8 },
      { role: 'accent', path: arch }, { role: 'line', path: archLines, clip: arch, w: 0.9 },
      { role: 'accent', path: cornice }, { role: 'enamel', path: panel }, { role: 'accent', path: keystone },
    ],
  };
}

const SUBJECTS = {
  heroes: helmet, mercy: hospitallerCross, brotherhood, honoredDead: () => brazier(), eternalGlory: () => laurel(),
};
// Technologies drawn in this style, without the shield (drawTechEmblem).
const TECH_SUBJECTS = { navigation: compassRose, gunnery: crossedCannons, roads: romanRoad };

// The subject in silver and gold, `size` px across, centred on (cx, cy). Roles of its own here: `enamel`, a
// part in the player's colour; `shade`, the shaded half of a faceted part (laid flat over it).
function drawSubject(ctx, key, color, cx, cy, size, subjects = SUBJECTS) {
  const { box: [x0, y0, x1, y1], layers } = subjects[key]();
  const MAT = {
    main: SILVER, blade: SILVER, accent: GOLD, grip: LEATHER, hole: darken(color, 0.82),
    flame: FLAME, inner: '#fff3b8', ribbon: RED, star: SILVER, leaf: LEAF_GOLD,
    enamel: [[0, lighten(color, 0.38)], [0.5, color], [1, darken(color, 0.45)]],
  };
  const s = size / Math.max(x1 - x0, y1 - y0);
  const px = (v) => v / s;
  const fill = (l, stops) => { ctx.fillStyle = typeof stops === 'string' ? stops : grad(ctx, stops, x0, y0, x1, y1); ctx.fill(l.path); };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // Its shadow on the field.
  ctx.save();
  shadow(ctx, 1.5, 0.6, 1.2, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = '#000';
  for (const l of layers) if (!['line', 'shine', 'shade', 'hole', 'inner'].includes(l.role)) ctx.fill(l.path);
  ctx.restore();
  const leaves = layers.filter((l) => l.role === 'leaf');
  for (const l of layers) {
    if (l.role === 'shade') {
      ctx.fillStyle = 'rgba(20,12,4,0.32)'; ctx.fill(l.path);
    } else if (l.role === 'line') {
      ctx.save();
      if (l.clip) ctx.clip(l.clip);
      ctx.strokeStyle = 'rgba(30,20,10,0.55)'; ctx.lineWidth = px(l.w); ctx.stroke(l.path);
      ctx.restore();
    } else if (l.role === 'shine') {
      ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fill(l.path);
    } else if (l.role === 'leaf') {
      // The wreath: one outline around it all (drawn behind the gold), not one per leaf.
      if (l !== leaves[0]) continue;
      ctx.strokeStyle = INK; ctx.lineWidth = px(2);
      for (const q of leaves) ctx.stroke(q.path);
      for (const q of leaves) fill(q, MAT.leaf);
    } else {
      fill(l, MAT[l.role]);
      const flat = l.role === 'hole' || l.role === 'inner';
      if (!flat) bevel(ctx, l.path, px(0.7), px(1.1), 'rgba(255,255,255,0.55)', 'rgba(0,0,0,0.35)');
      ctx.strokeStyle = INK; ctx.lineWidth = px(1); ctx.stroke(l.path);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ the shield
function shieldPath(inset) {
  const i = inset, p = new Path2D();
  p.moveTo(8 + i, 4 + i);
  p.quadraticCurveTo(32, 7 + i, 56 - i, 4 + i);
  p.lineTo(56 - i, 29);
  p.bezierCurveTo(56 - i, 46, 45, 54 - i * 0.6, 32, 61 - i * 1.4);
  p.bezierCurveTo(19, 54 - i * 0.6, 8 + i, 46, 8 + i, 29);
  p.closePath();
  return p;
}

// The field: the player's colour lit from the top left, with a faint diaper pattern, sunk below the border.
function drawField(ctx, field, color) {
  ctx.fillStyle = grad(ctx, [[0, lighten(color, 0.22)], [0.55, color], [1, darken(color, 0.45)]], 14, 6, 50, 60);
  ctx.fill(field);
  ctx.save(); ctx.clip(field);
  ctx.strokeStyle = 'rgba(0,0,0,0.13)'; ctx.lineWidth = 0.5;
  for (let d = -60; d < 70; d += 6) {
    ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + 64, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(d + 64, 0); ctx.lineTo(d, 64); ctx.stroke();
  }
  const glow = ctx.createRadialGradient(22, 14, 1, 22, 14, 34);
  glow.addColorStop(0, 'rgba(255,255,255,0.28)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 64, 64);
  ctx.restore();
  bevel(ctx, field, 0.9, 1.6, 'rgba(0,0,0,0.45)', 'rgba(255,255,255,0.18)');
}

// A tradition's big picture (Honor window) on `ctx`, scaled to 64x64 logical px.
export function drawTradition(ctx, key, color, ultimate = false) {
  R = ctx.getTransform().a;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const outer = shieldPath(0);
  if (ultimate) {
    const halo = ctx.createRadialGradient(32, 32, 14, 32, 32, 32);
    halo.addColorStop(0, 'rgba(190,24,30,0.55)'); halo.addColorStop(1, 'rgba(190,24,30,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, 64, 64);
  }
  ctx.save(); shadow(ctx, 3, 0, 1.5, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = grad(ctx, GOLD, 8, 4, 56, 61); ctx.fill(outer);
  ctx.restore();
  bevel(ctx, outer, 0.8, 1.4, 'rgba(255,255,255,0.6)', 'rgba(60,30,0,0.5)');
  let field;
  if (ultimate) {
    // A double gold border with a crimson line between.
    const band = shieldPath(3.1);
    ctx.fillStyle = '#7a1016'; ctx.fill(shieldPath(2.2));
    ctx.fillStyle = grad(ctx, GOLD, 8, 4, 56, 61); ctx.fill(band);
    field = shieldPath(4.8);
    drawField(ctx, field, color);
    ctx.strokeStyle = INK; ctx.lineWidth = 0.9; ctx.stroke(band);
  } else {
    field = shieldPath(3.4);
    drawField(ctx, field, color);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = ultimate ? 0.9 : 1; ctx.stroke(field);
  ctx.lineWidth = 1.3; ctx.stroke(outer);
  const at = {
    heroes: [31, 37], mercy: [30, 34], brotherhood: [31, 39], honoredDead: [31, 37], eternalGlory: [30, ultimate ? 33 : 36],
  }[key];
  drawSubject(ctx, key, color, 32, at[0], at[1]);
  ctx.restore();
}

// A technology's picture in this style (TECH_SUBJECTS) on `ctx`, scaled to 64x64 logical px: the subject
// alone, no shield, filling the box (the Tech window shows it at 54 px, the results at 24 px).
export function drawTechEmblem(ctx, key, color) {
  R = ctx.getTransform().a;
  drawSubject(ctx, key, color, 32, 32, 58, TECH_SUBJECTS);
}

// ------------------------------------------------------------------ small pictures (22-24 px)
// The same subjects as bold glyphs without the shield, for the Players list and the results: silver,
// with one part in the player's colour (the `tint` layers): the crest, the cross, the sleeves, the
// brazier, the star. The helmet and the clasp are redrawn simpler and bolder; the laurel and the brazier
// are the big ones with fewer details.

function smallHelmet() {
  const crest = new Path2D();
  crest.moveTo(-6, -28);
  crest.bezierCurveTo(-23, -26, -32, -31, -30, -39);
  crest.bezierCurveTo(-25, -52, 25, -52, 30, -39);
  crest.bezierCurveTo(32, -31, 23, -26, 6, -28);
  crest.closePath();
  const body = new Path2D();
  body.moveTo(0, -31);
  body.bezierCurveTo(16, -31, 26, -20, 26, -4);
  body.bezierCurveTo(26, 9, 23, 18, 24, 26);
  body.bezierCurveTo(25, 33, 23, 39, 18, 42);
  body.lineTo(8, 42); body.lineTo(5, 16); body.lineTo(-5, 16); body.lineTo(-8, 42); body.lineTo(-18, 42);
  body.bezierCurveTo(-23, 39, -25, 33, -24, 26);
  body.bezierCurveTo(-23, 18, -26, 9, -26, -4);
  body.bezierCurveTo(-26, -20, -16, -31, 0, -31);
  body.closePath();
  const eyes = new Path2D();
  eyes.moveTo(-21, 1);
  eyes.bezierCurveTo(-17, -8, -8, -8, -3, -4.5);
  eyes.lineTo(3, -4.5);
  eyes.bezierCurveTo(8, -8, 17, -8, 21, 1);
  eyes.bezierCurveTo(18, 8, 11, 10, 6.5, 10);
  eyes.lineTo(5.5, 18); eyes.lineTo(-5.5, 18); eyes.lineTo(-6.5, 10);
  eyes.bezierCurveTo(-11, 10, -18, 8, -21, 1);
  eyes.closePath();
  const nose = new Path2D();
  nose.moveTo(-4.2, -8); nose.lineTo(4.2, -8); nose.lineTo(3.2, 12); nose.quadraticCurveTo(0, 16, -3.2, 12); nose.closePath();
  return {
    box: [-32, -50, 32, 43],
    layers: [
      { role: 'accent', path: crest, tint: true }, { role: 'main', path: body },
      { role: 'hole', path: eyes }, { role: 'main', path: nose },
    ],
  };
}

function smallCross() {
  const cross = new Path2D();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, c = Math.cos(a), si = Math.sin(a);
    const r = (x, y) => [x * c - y * si, x * si + y * c];
    cross.moveTo(...r(0, -1));
    cross.quadraticCurveTo(...r(-6, -18), ...r(-19, -41));
    cross.lineTo(...r(0, -31.5));
    cross.lineTo(...r(19, -41));
    cross.quadraticCurveTo(...r(6, -18), ...r(0, -1));
    cross.closePath();
  }
  const boss = new Path2D(); boss.arc(0, 0, 8, 0, Math.PI * 2);
  return { box: [-43, -43, 43, 43], layers: [{ role: 'main', path: cross, tint: true }, { role: 'accent', path: boss }] };
}

// Two forearms rising from the bottom corners to a big clasp: taller than the big picture's level one.
function smallHands() {
  const arm = (side) => {
    const p = new Path2D(), x = (v) => side * v;
    p.moveTo(x(-29), 2.5); p.lineTo(x(-46), 23); p.lineTo(x(-31), 40); p.lineTo(x(-10), 20.5); p.closePath();
    return p;
  };
  const cuffs = new Path2D();
  cuffs.moveTo(-38, 14); cuffs.lineTo(-23, 31);
  cuffs.moveTo(38, 14); cuffs.lineTo(23, 31);
  const H = new DOMMatrix().scale(1.36);
  const handB = new Path2D();       // the right one's hand, behind
  handB.moveTo(21, 2); handB.bezierCurveTo(16, -9, 10, -13, 4, -13); handB.lineTo(4, 14); handB.lineTo(8, 15); handB.closePath();
  const handA = new Path2D();       // the left one's hand, in front
  handA.moveTo(-21, 2); handA.bezierCurveTo(-15, -10, -4, -13, 6, -12);
  handA.bezierCurveTo(13, -11, 17, -5, 16, 2); handA.bezierCurveTo(15, 9, 9, 14, 2, 15);
  handA.lineTo(-8, 15); handA.closePath();
  const fingers = new Path2D();
  for (const x of [-9, -1.5, 6]) capsule(fingers, x + 3, -4, x - 1, 9, 3.4);
  const thumb = new Path2D();
  capsule(thumb, -4, -14, 13, -15, 3.4);
  return {
    box: [-47, -26, 47, 41],
    layers: [
      { role: 'main', path: arm(-1), tint: true }, { role: 'main', path: arm(1), tint: true }, { role: 'line', path: cuffs },
      { role: 'main', path: xf(handB, H) }, { role: 'main', path: xf(handA, H) },
      { role: 'main', path: xf(fingers, H) }, { role: 'main', path: xf(thumb, H) },
    ],
  };
}

const SMALL_SUBJECTS = {
  heroes: smallHelmet, mercy: smallCross, brotherhood: smallHands,
  honoredDead: () => brazier(true), eternalGlory: () => laurel(true),
};
const STEEL = [[0, '#ffffff'], [0.45, '#cfd5dc'], [1, '#7f8792']];
const SMALL_MAT = {
  main: STEEL, accent: LEAF_GOLD, flame: FLAME, inner: '#fff6c8', ribbon: RED, star: STEEL, leaf: LEAF_GOLD, hole: INK,
  blade: STEEL,
};

// A tradition's small picture on `ctx`, scaled to 64x64 logical px. `ultimate`: a soft red glow behind.
export function drawTraditionSmall(ctx, key, color, ultimate = false) {
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (ultimate) {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(200,40,40,0.5)'); g.addColorStop(0.6, 'rgba(190,25,30,0.28)'); g.addColorStop(1, 'rgba(190,25,30,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  }
  const { box: [x0, y0, x1, y1], layers } = SMALL_SUBJECTS[key]();
  const s = 60 / Math.max(x1 - x0, y1 - y0);
  const px = (v) => v / s;
  const tint = [[0, lighten(color, 0.38)], [0.5, color], [1, darken(color, 0.45)]];
  const style = (stops) => (typeof stops === 'string' ? stops : grad(ctx, stops, x0, y0, x0 + (x1 - x0) * 0.6, y1));
  ctx.translate(32, 32); ctx.scale(s, s); ctx.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  const leaves = layers.filter((l) => l.role === 'leaf');
  for (const l of layers) {
    if (l.role === 'line') {
      ctx.save();
      if (l.clip) ctx.clip(l.clip);
      ctx.strokeStyle = INK; ctx.lineWidth = px(2.4); ctx.stroke(l.path);
      ctx.restore();
    } else if (l.role === 'leaf') {
      // The wreath: one outline around it all (drawn behind the gold), not one per leaf.
      if (l !== leaves[0]) continue;
      ctx.strokeStyle = INK; ctx.lineWidth = px(5);
      for (const q of leaves) ctx.stroke(q.path);
      ctx.fillStyle = style(SMALL_MAT.leaf);
      for (const q of leaves) ctx.fill(q.path);
    } else {
      ctx.fillStyle = style(l.tint ? tint : SMALL_MAT[l.role]);
      ctx.fill(l.path);
      if (l.role !== 'hole' && l.role !== 'inner') { ctx.strokeStyle = INK; ctx.lineWidth = px(2.6); ctx.stroke(l.path); }
    }
  }
  ctx.restore();
}
