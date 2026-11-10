// Battleship: crossed cannon barrels, muzzles up, over a pile of three cannonballs, on the main sail of
// a two-masted warship in the owner's colour (sprites.js shipSprite).
import { UnitType, ICON_INK } from './UnitType.js';

// A cannon barrel upright on x = 50, muzzle at the top: the tapering tube with its rounded breech, the
// muzzle ring, a reinforcing ring, and the knob (cascabel) behind the breech.
function barrel() {
  const tube = new Path2D();
  tube.moveTo(44.5, 12); tube.lineTo(55.5, 12); tube.lineTo(60, 68);
  tube.quadraticCurveTo(60, 80, 50, 80);
  tube.quadraticCurveTo(40, 80, 40, 68);
  tube.closePath();
  const muzzle = new Path2D(); muzzle.rect(41, 4, 18, 9);
  const ring = new Path2D(); ring.rect(38, 54, 24, 8);
  const knob = new Path2D();
  knob.rect(46.5, 78, 7, 7);
  knob.moveTo(56, 88); knob.arc(50, 88, 6, 0, Math.PI * 2);
  return [tube, muzzle, ring, knob];
}

// The same parts turned `deg` degrees about the centre of the box.
function turned(parts, deg) {
  const m = new DOMMatrix().translate(50, 50).rotate(deg).translate(-50, -50);
  return parts.map((p) => { const q = new Path2D(); q.addPath(p, m); return q; });
}

const BALLS = [[41, 91], [59, 91], [50, 77]];     // the bottom two first, the top one on them
const BALL_R = 7.5;

export class Battleship extends UnitType {
  static type = 'battleship';

  static describe() {
    const s = this.stats;
    return `${s.name}: ${s.hp} HP · ${s.damage} damage per shot, one every ${s.reload} s · range ${s.attackRange} · ` +
      `speed ${s.moveSpeed}, reached ${s.accelTime} s after a stop · regen ${s.hpRegen}/s out of combat, ` +
      `${s.hpRegen * s.harbourFactor}/s (${s.harbourFactor}×) near your coastal cities. ` +
      `${this.special()}`;
  }

  static special() {
    return 'Shells ships, troops ashore and cities from the sea. It reloads while it sails: shoot, move away, ' +
      'come back and shoot again. It takes coastal cities; an inland city in range it brings down to 1 HP, ' +
      'for troops to take. Between its shots a city doesn\'t regenerate. ' +
      'Built only in coastal cities.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    const left = turned(barrel(), -40), right = turned(barrel(), 40);
    const balls = BALLS.map(([x, y]) => { const p = new Path2D(); p.arc(x, y, BALL_R, 0, Math.PI * 2); return p; });
    if (outline) {
      ctx.lineWidth = pad;
      for (const p of [...left, ...right, ...balls]) { ctx.stroke(p); ctx.fill(p); }
      return;
    }
    // The fill: each shape set off from the one behind it by a dark edge, so the barrels cross and the
    // balls lie one on another instead of melting into one shape. Rings in ink across the barrels.
    const edge = (p) => { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(28,19,11,0.6)'; ctx.stroke(p); };
    for (const parts of [left, right]) {
      for (const p of parts) { ctx.fillStyle = fill; ctx.fill(p); edge(p); }
    }
    for (const p of balls) { ctx.fillStyle = fill; ctx.fill(p); edge(p); }
    ctx.fillStyle = ICON_INK;
    for (const [x, y] of BALLS) {          // shade on each ball's lower right: the light comes from the top left
      ctx.globalAlpha = 0.18;
      ctx.beginPath(); ctx.arc(x + 2.2, y + 2.2, BALL_R * 0.55, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
