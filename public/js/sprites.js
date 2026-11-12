// Procedurally drawn, cached sprites: unit cones with type icons, ships, castles and the anchor
// badge of coastal cities. Sprites are 64x64 logical px, rendered at 2x for crisp scaling.
import { UNIT_CLASSES } from './units/index.js';
import { UPGRADE_TYPES, UNIT_TYPES, TRADITIONS } from '/shared/config.js';
import { drawTradition, drawTraditionSmall, drawTechEmblem } from './tradition-icons.js';

const RES = 2;
const SIZE = 64;
const INK = '#1c130b';

// Unit cone geometry (logical px). The unit's position maps to the base centre.
export const CONE = { cx: 32, by: 46, rx: 22, ry: 10, apex: 25 };
// Castle anchor: the city position maps to this point of the sprite.
export const CASTLE_ANCHOR = { x: 32, y: 47 };

const unitCache = new Map();
const castleCache = new Map();
const urlCache = new Map();

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(hex, target, t) {
  const c = rgb(hex);
  return `rgb(${c.map((v, i) => Math.round(v + (target[i] - v) * t)).join(',')})`;
}
const lighten = (hex, t) => mix(hex, [255, 255, 255], t);
const darken = (hex, t) => mix(hex, [0, 0, 0], t);

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * RES;
  const ctx = c.getContext('2d');
  ctx.scale(RES, RES);
  return [c, ctx];
}

// ------------------------------------------------------------------ icons
// Each unit class (js/units/*.js) draws its own emblem in a 100x100 box. `variant`: a Hero's kind
// (HERO_KINDS), which sets its mark behind the crown.
export function drawIcon(ctx, type, cx, cy, size, variant = null) {
  const UnitClass = UNIT_CLASSES[type];
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 100, size / 100);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  UnitClass.drawIcon(ctx, true, variant);
  UnitClass.drawIcon(ctx, false, variant);
  ctx.restore();
}

// ------------------------------------------------------------------ unit cone
// A unit's sprite: a cone, or a boat for ships. Both map the unit's position to CONE's base
// centre (the waterline of a boat) and are about as wide as CONE.rx * 2 at the same size.
// `variant`: a Hero's kind (its emblem, see drawIcon), or 'cannons' for a battleship of a player with Gunnery.
export function unitSprite(color, type, variant = null) {
  const key = `${color}${type}${variant || ''}`;
  let c = unitCache.get(key);
  if (c) return c;
  if (UNIT_CLASSES[type].naval) {
    c = UNIT_CLASSES[type].type === 'battleship' ? warshipSprite(color, type, variant) : shipSprite(color, type);
    unitCache.set(key, c);
    return c;
  }
  let ctx;
  [c, ctx] = makeCanvas();
  const { cx, by, rx, ry, apex } = CONE;

  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(cx + 3, by + 3, rx + 1, ry + 1, 0, 0, Math.PI * 2); ctx.fill();

  // Cone silhouette: apex + tangent lines to the base ellipse + lower half of the ellipse.
  const ay = by - apex;
  const k = apex / ry;
  const tu = Math.sqrt(1 - 1 / (k * k)), tv = -1 / k;
  const th = Math.atan2(tv, tu);
  const body = new Path2D();
  body.moveTo(cx, ay);
  body.lineTo(cx + rx * tu, by + ry * tv);
  body.ellipse(cx, by, rx, ry, 0, th, Math.PI - th, false);
  body.closePath();

  const grad = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  grad.addColorStop(0, lighten(color, 0.45));
  grad.addColorStop(0.45, color);
  grad.addColorStop(1, darken(color, 0.5));
  ctx.fillStyle = grad;
  ctx.fill(body);

  // Soft highlight near the apex.
  const hl = ctx.createRadialGradient(cx - 6, ay + 8, 1, cx - 6, ay + 8, 16);
  hl.addColorStop(0, 'rgba(255,255,255,0.45)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fill(body);

  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke(body);

  // Rim along the front of the base.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(cx, by, rx - 1.5, ry - 1.5, 0, 0.25, Math.PI - 0.25); ctx.stroke();

  drawIcon(ctx, type, cx, ay - 2, 30, variant);
  unitCache.set(key, c);
  return c;
}

// ------------------------------------------------------------------ ship
// A boat seen from the side, bow to the right: hull in the owner's colour, a cream sail carrying the
// ship type's emblem (like the icon over a unit's cone). The renderer mirrors it when it sails left.
function shipSprite(color, type) {
  const [c, ctx] = makeCanvas();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Shadow on the water and a short wake behind the stern.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(34, 48, 25, 5.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(225,242,255,0.6)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(1, 45); ctx.quadraticCurveTo(5, 47.5, 10, 46.5);
  ctx.moveTo(3, 50); ctx.quadraticCurveTo(8, 51.5, 14, 50);
  ctx.stroke();

  // Mast and sail.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(32, 36); ctx.lineTo(32, 5); ctx.stroke();
  const sail = new Path2D();
  sail.moveTo(18, 9); sail.lineTo(46, 9);
  sail.quadraticCurveTo(50, 20, 46, 32);
  sail.lineTo(18, 32);
  sail.quadraticCurveTo(22, 20, 18, 9);
  sail.closePath();
  const cloth = ctx.createLinearGradient(18, 0, 48, 0);
  cloth.addColorStop(0, '#fbf4e2'); cloth.addColorStop(1, '#d9cdb0');
  ctx.fillStyle = cloth;
  ctx.fill(sail);
  ctx.lineWidth = 1.4;
  ctx.stroke(sail);
  ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(16, 9); ctx.lineTo(48, 9); ctx.stroke();       // yard
  const pennant = new Path2D();
  pennant.moveTo(32.5, 4); pennant.lineTo(42, 6.5); pennant.lineTo(32.5, 9); pennant.closePath();
  ctx.fillStyle = color;
  ctx.fill(pennant);
  ctx.lineWidth = 1;
  ctx.stroke(pennant);

  // Hull.
  const hull = new Path2D();
  hull.moveTo(9, 35); hull.lineTo(50, 35); hull.lineTo(59, 30.5);
  hull.quadraticCurveTo(56, 44, 46, 48.5);
  hull.lineTo(17, 48.5);
  hull.quadraticCurveTo(10, 46, 9, 35);
  hull.closePath();
  const wood = ctx.createLinearGradient(0, 31, 0, 49);
  wood.addColorStop(0, lighten(color, 0.4)); wood.addColorStop(0.45, color); wood.addColorStop(1, darken(color, 0.5));
  ctx.fillStyle = wood;
  ctx.fill(hull);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(12, 42.5); ctx.lineTo(54, 41.5); ctx.stroke();  // a plank line
  ctx.strokeStyle = lighten(color, 0.6);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(11, 37.5); ctx.lineTo(50, 37.5); ctx.lineTo(56.5, 34); ctx.stroke();   // rail
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.stroke(hull);

  drawIcon(ctx, type, 32, 21, 24);
  return c;
}

// A warship (battleship), bow to the right, drawn like shipSprite: a longer hull in the owner's colour
// with a raised stern castle, a light band along its side, and two masts. The main sail carries the ship
// type's emblem (a ballista); the pennant on the main mast is in the owner's colour. With `variant`
// 'cannons' (its owner has Gunnery) the sail shows crossed cannons and the band a row of gun ports.
function warshipSprite(color, type, variant = null) {
  const [c, ctx] = makeCanvas();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Shadow on the water and the wake behind the stern.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(34, 48.5, 29, 5.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(225,242,255,0.6)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, 45); ctx.quadraticCurveTo(3, 47.5, 7, 46.5);
  ctx.moveTo(1, 50.5); ctx.quadraticCurveTo(5, 52, 10, 50.5);
  ctx.stroke();

  // A sail on its yard, from x0 to x1 and y0 to y1, bellied towards the bow.
  const cloth = (x0, x1) => {
    const g = ctx.createLinearGradient(x0, 0, x1 + 3, 0);
    g.addColorStop(0, '#fbf4e2'); g.addColorStop(1, '#d9cdb0');
    return g;
  };
  const sail = (x0, x1, y0, y1) => {
    const p = new Path2D();
    p.moveTo(x0, y0); p.lineTo(x1, y0);
    p.quadraticCurveTo(x1 + 3.5, (y0 + y1) / 2, x1, y1);
    p.lineTo(x0, y1);
    p.quadraticCurveTo(x0 + 3.5, (y0 + y1) / 2, x0, y0);
    p.closePath();
    ctx.fillStyle = cloth(x0, x1);
    ctx.fill(p);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.3;
    ctx.stroke(p);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0 - 2, y0); ctx.lineTo(x1 + 2, y0); ctx.stroke();      // yard
  };

  // Masts (main, then fore), with the bowsprit, then their sails.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(29, 34); ctx.lineTo(29, 3);
  ctx.moveTo(49, 33); ctx.lineTo(49, 10);
  ctx.moveTo(56, 30); ctx.lineTo(63, 24);
  ctx.stroke();
  sail(17, 41, 7.5, 30);
  sail(44, 54, 13, 29);
  const pennant = new Path2D();
  pennant.moveTo(29.5, 2); pennant.lineTo(40, 4.5); pennant.lineTo(29.5, 7); pennant.closePath();
  ctx.fillStyle = color;
  ctx.fill(pennant);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.stroke(pennant);

  // Hull: the stern castle at the left, the bow rising to the right.
  const hull = new Path2D();
  hull.moveTo(4, 29); hull.lineTo(17, 29); hull.lineTo(18, 33);
  hull.lineTo(52, 33); hull.lineTo(61, 28.5);
  hull.quadraticCurveTo(58, 45, 47, 49.5);
  hull.lineTo(15, 49.5);
  hull.quadraticCurveTo(6, 47, 4, 29);
  hull.closePath();
  const wood = ctx.createLinearGradient(0, 29, 0, 50);
  wood.addColorStop(0, lighten(color, 0.4)); wood.addColorStop(0.45, color); wood.addColorStop(1, darken(color, 0.5));
  ctx.fillStyle = wood;
  ctx.fill(hull);
  ctx.save();
  ctx.clip(hull);
  // The deck band: a light band, with cannons a row of square gun ports in it, dark inside.
  ctx.fillStyle = lighten(color, 0.62);
  ctx.beginPath(); ctx.moveTo(5, 37); ctx.lineTo(58, 36); ctx.lineTo(57.5, 40.5); ctx.lineTo(6, 41.5); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = INK;
  if (variant === 'cannons') for (let x = 12; x <= 50; x += 6.3) ctx.fillRect(x, 37.4, 3, 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(8, 45.5); ctx.lineTo(54, 44.5); ctx.stroke();    // a plank line
  ctx.restore();
  ctx.strokeStyle = lighten(color, 0.6);
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(5.5, 31); ctx.lineTo(16.5, 31); ctx.moveTo(19, 35); ctx.lineTo(52, 35); ctx.lineTo(58.5, 31.5); ctx.stroke();   // rails
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.stroke(hull);

  drawIcon(ctx, type, 29, 18.2, 20, variant);
  return c;
}

// ------------------------------------------------------------------ anchor badge
// The mark of a coastal city (it can build ships): a white anchor on a sea-blue disc.
let anchorCanvas = null;
export function anchorBadge() {
  if (anchorCanvas) return anchorCanvas;
  const [c, ctx] = makeCanvas();
  ctx.fillStyle = '#1d4a72';
  ctx.strokeStyle = '#e8f3fb';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(32, 32, 29, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(32, 32, 30.8, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(32, 15, 4.5, 0, Math.PI * 2);                         // ring
  ctx.moveTo(32, 19.5); ctx.lineTo(32, 51);                     // shank
  ctx.moveTo(22, 26); ctx.lineTo(42, 26);                       // stock
  ctx.moveTo(14, 37); ctx.quadraticCurveTo(17, 51, 32, 51);     // arms
  ctx.quadraticCurveTo(47, 51, 50, 37);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  for (const dir of [-1, 1]) {                                  // flukes
    ctx.beginPath();
    ctx.moveTo(32 + dir * 21, 33); ctx.lineTo(32 + dir * 14, 40); ctx.lineTo(32 + dir * 21, 42);
    ctx.closePath(); ctx.fill();
  }
  anchorCanvas = c;
  return c;
}

// ------------------------------------------------------------------ castle
const STONE = '#c4bba5';
const STONE_DARK = '#8f8774';
const GOLD = '#e2b93b';
const WALL_FLAG = 1 << UPGRADE_TYPES.indexOf('wall');
const WALL2_FLAG = 1 << UPGRADE_TYPES.indexOf('wall2');
const TOWER_FLAG = 1 << UPGRADE_TYPES.indexOf('tower');
const CASTLE_FLAG = 1 << UPGRADE_TYPES.indexOf('castle');
const FARM_FLAG = 1 << UPGRADE_TYPES.indexOf('farm');
const BARRACKS_FLAG = 1 << UPGRADE_TYPES.indexOf('barracks');
const WHEAT = '#e8c454';
const TIMBER = '#9b6a3a';
const STEEL = '#e6e2d6';

// Long timber hall with a roof in the owner's colour (Barracks upgrade). Drawn at the castle's
// front right, outside the walls, opposite the Farm's field.
function drawBarracks(ctx, color, x0 = 42, y0 = 50, scale = 1) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(scale, scale);
  const body = new Path2D();
  body.rect(1.5, 5.5, 18, 7.5);
  ctx.fillStyle = TIMBER;
  ctx.fill(body);
  const roof = new Path2D();
  roof.moveTo(0, 6); roof.lineTo(4, 0); roof.lineTo(17, 0); roof.lineTo(21, 6); roof.closePath();
  ctx.fillStyle = color;
  ctx.fill(roof);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.stroke(body);
  ctx.stroke(roof);
  ctx.fillStyle = INK;
  ctx.fillRect(9.2, 8.5, 2.6, 4.5);                   // door
  ctx.fillRect(4, 8, 2.4, 2); ctx.fillRect(14.6, 8, 2.4, 2);   // windows
  ctx.restore();
}

// Two crossed swords (Barracks button icon).
function drawSwords(ctx, cx, cy, s) {
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(dir * Math.PI / 4);
    ctx.scale(s, s);
    ctx.lineWidth = 1.5 / s;
    ctx.strokeStyle = INK;
    const blade = new Path2D();
    blade.moveTo(-1.3, 4); blade.lineTo(-1.3, -8); blade.lineTo(0, -10.5); blade.lineTo(1.3, -8); blade.lineTo(1.3, 4); blade.closePath();
    ctx.fillStyle = STEEL; ctx.fill(blade); ctx.stroke(blade);
    ctx.fillStyle = GOLD;
    ctx.fillRect(-4, 4, 8, 1.8); ctx.strokeRect(-4, 4, 8, 1.8);   // cross-guard
    ctx.fillStyle = TIMBER;
    ctx.fillRect(-1, 5.8, 2, 3.6); ctx.strokeRect(-1, 5.8, 2, 3.6); // grip
    ctx.restore();
  }
}

// Golden field with furrows (Farm upgrade). Drawn at the castle's front left, outside the walls.
function drawField(ctx, x0 = 0, y0 = 51, scale = 1) {
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(scale, scale);
  const field = new Path2D();
  field.moveTo(1, 4); field.lineTo(15, 0); field.lineTo(20, 10); field.lineTo(4, 12); field.closePath();
  ctx.fillStyle = WHEAT;
  ctx.fill(field);
  ctx.strokeStyle = 'rgba(120,80,20,0.75)';
  ctx.lineWidth = 0.9;
  for (let k = 1; k < 4; k++) {
    const t = k / 4;
    ctx.beginPath();
    ctx.moveTo(1 + 3 * t, 4 + 8 * t);
    ctx.lineTo(15 + 5 * t, 0 + 10 * t);
    ctx.stroke();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.stroke(field);
  ctx.restore();
}

// Banner on a pole over the left wall (Castle upgrade).
function drawBanner(ctx, color, x = 12, top = 6) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, top); ctx.stroke();
  const flag = new Path2D();
  flag.moveTo(x + 0.8, top); flag.lineTo(x + 13, top + 2.5); flag.lineTo(x + 8, top + 5); flag.lineTo(x + 13, top + 8);
  flag.lineTo(x + 0.8, top + 9); flag.closePath();
  ctx.fillStyle = color;
  ctx.fill(flag);
  ctx.lineWidth = 1.2;
  ctx.stroke(flag);
  ctx.fillStyle = GOLD;
  ctx.beginPath(); ctx.arc(x, top - 1, 1.6, 0, Math.PI * 2); ctx.fill();
}

// Stone curtain wall ringing the castle: the back half is drawn behind it, the front half in front.
// `strong` (Wall II): a thicker wall with round-topped turrets along its front.
function drawRingWall(ctx, front, strong = false) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(32, 50, 29, 9, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = INK; ctx.lineWidth = strong ? 9.5 : 7.5; ctx.stroke();
  ctx.strokeStyle = front ? STONE : STONE_DARK; ctx.lineWidth = strong ? 7 : 5; ctx.stroke();
  if (front) {
    ctx.fillStyle = STONE;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    const lift = strong ? 6 : 5;
    for (let a = 0.22; a < Math.PI - 0.15; a += 0.36) {
      const x = 32 + Math.cos(a) * 29, y = 50 + Math.sin(a) * 9 - lift;
      ctx.fillRect(x - 1.7, y - 2.4, 3.4, 2.8);
      ctx.strokeRect(x - 1.7, y - 2.4, 3.4, 2.8);
    }
    if (strong) {
      // Turrets at both ends of the front and two in between, clear of the gate.
      ctx.lineWidth = 1.2;
      for (const a of [0.12, 0.95, Math.PI - 0.95, Math.PI - 0.12]) {
        const x = 32 + Math.cos(a) * 29, y = 50 + Math.sin(a) * 9 + 3;
        const t = new Path2D();
        t.moveTo(x - 3.2, y); t.lineTo(x - 3.2, y - 11);
        t.lineTo(x - 3.2, y - 13); t.lineTo(x - 1.6, y - 13); t.lineTo(x - 1.6, y - 11.5);
        t.lineTo(x + 1.6, y - 11.5); t.lineTo(x + 1.6, y - 13); t.lineTo(x + 3.2, y - 13);
        t.lineTo(x + 3.2, y); t.closePath();
        ctx.fillStyle = STONE; ctx.fill(t); ctx.stroke(t);
        ctx.fillStyle = INK; ctx.fillRect(x - 0.6, y - 8.5, 1.2, 3);   // arrow slit
      }
    }
  }
  ctx.restore();
}

// Tall extra tower on the right of the castle.
function drawTower(ctx, color) {
  const p = new Path2D();
  p.moveTo(45, 50); p.lineTo(45, 8);
  for (const x of [45, 49.5, 54]) { p.lineTo(x, 8); p.lineTo(x, 2); p.lineTo(x + 3, 2); p.lineTo(x + 3, 8); }
  p.lineTo(57, 8); p.lineTo(57, 50); p.closePath();
  const grad = ctx.createLinearGradient(45, 0, 57, 0);
  grad.addColorStop(0, lighten(color, 0.5)); grad.addColorStop(1, darken(color, 0.3));
  ctx.fillStyle = grad;
  ctx.fill(p);
  ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
  ctx.stroke(p);
  ctx.fillStyle = INK;
  ctx.fillRect(50, 14, 2, 6);
  ctx.fillRect(50, 28, 2, 6);
}

// Castle in the owner's colour; `flags` adds the built upgrades (see UPGRADE_TYPES).
export function castleSprite(color, flags = 0) {
  const cacheKey = `${color}|${flags}`;
  let c = castleCache.get(cacheKey);
  if (c) return c;
  let ctx;
  [c, ctx] = makeCanvas();
  const light = lighten(color, 0.35), dark = darken(color, 0.4);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  const walled = flags & (WALL_FLAG | WALL2_FLAG), strong = !!(flags & WALL2_FLAG);
  ctx.beginPath(); ctx.ellipse(34, 52, walled ? 31 : 27, walled ? 10 : 7, 0, 0, Math.PI * 2); ctx.fill();
  if (walled) drawRingWall(ctx, false, strong);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;

  const wallGrad = ctx.createLinearGradient(8, 0, 56, 0);
  wallGrad.addColorStop(0, light); wallGrad.addColorStop(0.5, color); wallGrad.addColorStop(1, dark);

  // Outer wall with crenellations.
  const wall = new Path2D();
  wall.moveTo(8, 52); wall.lineTo(8, 26);
  const merlons = [8, 15, 22, 29, 36, 43, 50];
  for (let i = 0; i < merlons.length; i++) {
    const x = merlons[i];
    wall.lineTo(x, 26); wall.lineTo(x, 22); wall.lineTo(x + 4, 22); wall.lineTo(x + 4, 26);
  }
  wall.lineTo(56, 26); wall.lineTo(56, 52); wall.closePath();
  ctx.fillStyle = wallGrad; ctx.fill(wall); ctx.stroke(wall);

  // Keep (taller, with a gold band, when the Castle upgrade is built).
  const great = flags & CASTLE_FLAG;
  const kt = great ? 6 : 12;
  const keep = new Path2D();
  keep.moveTo(23, 52); keep.lineTo(23, kt);
  for (const x of [23, 30, 37]) { keep.lineTo(x, kt); keep.lineTo(x, kt - 5); keep.lineTo(x + 4, kt - 5); keep.lineTo(x + 4, kt); }
  keep.lineTo(41, kt); keep.lineTo(41, 52); keep.closePath();
  const keepGrad = ctx.createLinearGradient(23, 0, 41, 0);
  keepGrad.addColorStop(0, lighten(color, 0.55)); keepGrad.addColorStop(1, color);
  ctx.fillStyle = keepGrad; ctx.fill(keep); ctx.stroke(keep);
  if (great) {
    ctx.fillStyle = GOLD;
    ctx.fillRect(23.8, kt + 2, 16.4, 2.4);
  }

  // Gate and windows.
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.moveTo(27.5, 52); ctx.lineTo(27.5, 44); ctx.arc(32, 44, 4.5, Math.PI, 0); ctx.lineTo(36.5, 52); ctx.closePath(); ctx.fill();
  ctx.fillRect(30.5, 19, 3, 6);
  ctx.fillRect(13, 32, 3, 5); ctx.fillRect(48, 32, 3, 5);

  if (great) drawBanner(ctx, color);
  if (flags & TOWER_FLAG) drawTower(ctx, color);
  if (walled) drawRingWall(ctx, true, strong);
  if (flags & FARM_FLAG) drawField(ctx);
  if (flags & BARRACKS_FLAG) drawBarracks(ctx, color);

  castleCache.set(cacheKey, c);
  return c;
}

// Icon for an upgrade button or queue slot (data URL).
export function upgradeIconURL(key, color) {
  const cacheKey = `up|${key}|${color}`;
  let u = urlCache.get(cacheKey);
  if (u) return u;
  const [c, ctx] = makeCanvas();
  ctx.lineJoin = 'round';
  if (key === 'wall' || key === 'wall2') {
    const p = new Path2D();
    p.moveTo(6, 54); p.lineTo(6, 26);
    for (const x of [6, 17, 28, 39, 50]) { p.lineTo(x, 26); p.lineTo(x, 18); p.lineTo(x + 8, 18); p.lineTo(x + 8, 26); }
    p.lineTo(58, 26); p.lineTo(58, 54); p.closePath();
    ctx.fillStyle = STONE;
    ctx.fill(p);
    ctx.strokeStyle = 'rgba(28,19,11,0.45)';
    ctx.lineWidth = 1.2;
    for (const y of [34, 42, 50]) { ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(58, y); ctx.stroke(); }
    for (let row = 0; row < 3; row++) {
      for (let x = 12 + (row % 2) * 6; x < 58; x += 12) {
        ctx.beginPath(); ctx.moveTo(x, 26 + row * 8); ctx.lineTo(x, 34 + row * 8); ctx.stroke();
      }
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 2.2;
    ctx.stroke(p);
    if (key === 'wall2') {
      // Wall II: two taller towers flank the wall.
      for (const x0 of [2, 48]) {
        const t = new Path2D();
        t.moveTo(x0, 58); t.lineTo(x0, 14);
        for (const x of [x0, x0 + 5.5, x0 + 11]) { t.lineTo(x, 14); t.lineTo(x, 7); t.lineTo(x + 3, 7); t.lineTo(x + 3, 14); }
        t.lineTo(x0 + 14, 14); t.lineTo(x0 + 14, 58); t.closePath();
        ctx.fillStyle = STONE_DARK; ctx.fill(t);
        ctx.strokeStyle = INK; ctx.lineWidth = 2.2; ctx.stroke(t);
        ctx.fillStyle = INK;
        ctx.fillRect(x0 + 6, 22, 2.4, 8);
        ctx.fillRect(x0 + 6, 38, 2.4, 8);
      }
    }
  } else if (key === 'farm') {
    // A barn in the owner's colour behind a big wheat field.
    const barn = new Path2D();
    barn.moveTo(30, 34); barn.lineTo(30, 20); barn.lineTo(41, 10); barn.lineTo(52, 20); barn.lineTo(52, 34); barn.closePath();
    ctx.fillStyle = color;
    ctx.fill(barn);
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.stroke(barn);
    ctx.fillStyle = INK;
    ctx.fillRect(38, 24, 6, 10);
    drawField(ctx, 2, 26, 2.8);
  } else if (key === 'barracks') {
    // The barracks hall, big, under two crossed swords.
    drawSwords(ctx, 32, 15, 1.7);
    drawBarracks(ctx, color, 3, 28, 2.75);
  } else if (key === 'castle') {
    // Great keep with a gold band and a banner.
    const kt = 16;
    const keep = new Path2D();
    keep.moveTo(16, 58); keep.lineTo(16, kt);
    for (const x of [16, 26, 36]) { keep.lineTo(x, kt); keep.lineTo(x, kt - 7); keep.lineTo(x + 6, kt - 7); keep.lineTo(x + 6, kt); }
    keep.lineTo(42, kt); keep.lineTo(42, 58); keep.closePath();
    const grad = ctx.createLinearGradient(16, 0, 42, 0);
    grad.addColorStop(0, lighten(color, 0.55)); grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.fill(keep);
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.stroke(keep);
    ctx.fillStyle = GOLD;
    ctx.fillRect(17, kt + 3, 24, 3);
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.moveTo(24, 58); ctx.lineTo(24, 48); ctx.arc(29, 48, 5, Math.PI, 0); ctx.lineTo(34, 58); ctx.closePath(); ctx.fill();
    drawBanner(ctx, color, 48, 8);
  } else {
    // The castle's extra tower, widened and centred.
    ctx.save();
    ctx.translate(32, 4);
    ctx.scale(1.7, 1.08);
    ctx.translate(-51, 0);
    drawTower(ctx, color);
    ctx.restore();
  }
  u = c.toDataURL();
  urlCache.set(cacheKey, u);
  return u;
}

// Data URL of a unit sprite (used for HUD buttons). `variant`: a Hero's kind.
export function unitIconURL(color, type, variant = null) {
  const key = `${color}${type}${variant || ''}`;
  let u = urlCache.get(key);
  if (!u) {
    u = unitSprite(color, type, variant).toDataURL();
    urlCache.set(key, u);
  }
  return u;
}

// Data URL of a unit type's emblem alone: the marker drawn over its cone (or on a ship's sail),
// without the cone. The selection panel's unit icons, where many small cones are hard to tell apart.
// `variant`: a Hero's kind.
export function unitEmblemURL(type, variant = null) {
  const key = `emblem|${type}|${variant || ''}`;
  let u = urlCache.get(key);
  if (!u) {
    const [c, ctx] = makeCanvas();
    drawIcon(ctx, type, SIZE / 2, SIZE / 2, 56, variant);
    u = c.toDataURL();
    urlCache.set(key, u);
  }
  return u;
}

// ------------------------------------------------------------------ technology icons
const NEUTRAL_GREY = '#8c8c8c';      // the castles in technology icons

// A gold coin rimmed in `rim` (the smuggling mark on the map looks the same).
function drawCoin(ctx, x, y, r, rim) {
  ctx.fillStyle = '#e8c04a';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = rim;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(110,80,10,0.8)';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
}

// A person: round head over rounded shoulders, in `color` with a dark outline.
function drawPerson(ctx, x, y, s, color) {
  const p = new Path2D();
  p.arc(x, y, 6 * s, 0, Math.PI * 2);
  p.moveTo(x - 11 * s, y + 25 * s);
  p.lineTo(x - 11 * s, y + 17 * s);
  p.quadraticCurveTo(x - 11 * s, y + 8 * s, x, y + 8 * s);
  p.quadraticCurveTo(x + 11 * s, y + 8 * s, x + 11 * s, y + 17 * s);
  p.lineTo(x + 11 * s, y + 25 * s);
  p.closePath();
  const grad = ctx.createLinearGradient(x - 11 * s, 0, x + 11 * s, 0);
  grad.addColorStop(0, lighten(color, 0.4)); grad.addColorStop(1, darken(color, 0.25));
  ctx.fillStyle = grad;
  ctx.fill(p);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.stroke(p);
}

// A tradition's picture (data URL): a heraldic shield in the player's colour (tradition-icons.js).
export function traditionIconURL(key, color) {
  const cacheKey = `tradition|${key}|${color}`;
  let u = urlCache.get(cacheKey);
  if (u) return u;
  const [c, ctx] = makeCanvas();
  drawTradition(ctx, key, color, !!TRADITIONS[key]?.ultimate);
  u = c.toDataURL();
  urlCache.set(cacheKey, u);
  return u;
}

// A tradition's small picture (data URL) for 22-24 px: Players list and results (tradition-icons.js).
// Drawn on a 48 px canvas, close to the size it is shown at, so it stays crisp.
export function traditionSmallIconURL(key, color) {
  const cacheKey = `tradition-small|${key}|${color}`;
  let u = urlCache.get(cacheKey);
  if (u) return u;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d');
  ctx.scale(48 / SIZE, 48 / SIZE);
  drawTraditionSmall(ctx, key, color, !!TRADITIONS[key]?.ultimate);
  u = c.toDataURL();
  urlCache.set(cacheKey, u);
  return u;
}

// The picture of a technology in the Tech window (data URL), in the player's colour:
//   seafaring   the transport it unlocks
//   warships    the battleship it unlocks
//   navigation  a compass rose in silver and gold, north in the player's colour (tradition-icons.js)
//   gunnery     two bronze cannons crossed over a pile of iron cannonballs (tradition-icons.js)
//   supporters  a crowd behind a gold coin (liberator gold every turn)
//   influencer  a castle in the dashed ring that marks a city about to be liberated
//   smuggling   gold flowing from a castle to a coin rimmed in your colour (the smuggling mark)
export function techIconURL(key, color) {
  if (key === 'seafaring') return unitIconURL(color, UNIT_TYPES.indexOf('transport'));
  if (key === 'warships') return unitIconURL(color, UNIT_TYPES.indexOf('battleship'));
  const cacheKey = `tech|${key}|${color}`;
  let u = urlCache.get(cacheKey);
  if (u) return u;
  const [c, ctx] = makeCanvas();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (key === 'navigation' || key === 'gunnery') {
    drawTechEmblem(ctx, key, color);
  } else if (key === 'supporters') {
    drawPerson(ctx, 14, 20, 0.95, color);
    drawPerson(ctx, 50, 20, 0.95, color);
    drawPerson(ctx, 32, 14, 1.2, color);
    drawCoin(ctx, 46, 49, 10, color);
  } else if (key === 'influencer') {
    const ring = () => { ctx.beginPath(); ctx.ellipse(32, 47, 28, 11, 0, 0, Math.PI * 2); ctx.stroke(); };
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = INK; ctx.lineWidth = 5; ring();
    ctx.strokeStyle = color; ctx.lineWidth = 3; ring();
    ctx.setLineDash([]);
    ctx.drawImage(castleSprite(NEUTRAL_GREY), 9, 5, 46, 46);
  } else {
    ctx.drawImage(castleSprite(NEUTRAL_GREY), 0, 4, 34, 34);
    ctx.strokeStyle = INK; ctx.lineWidth = 5;
    const arrow = () => { ctx.beginPath(); ctx.moveTo(22, 40); ctx.quadraticCurveTo(26, 56, 38, 52); ctx.stroke(); };
    arrow();
    ctx.strokeStyle = '#e8c04a'; ctx.lineWidth = 3; arrow();
    ctx.fillStyle = '#e8c04a'; ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(42, 50); ctx.lineTo(35, 46); ctx.lineTo(36, 57); ctx.closePath(); ctx.fill(); ctx.stroke();
    drawCoin(ctx, 47, 30, 12, color);
  }
  u = c.toDataURL();
  urlCache.set(cacheKey, u);
  return u;
}
