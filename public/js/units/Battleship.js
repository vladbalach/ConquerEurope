// Battleship: a ballista seen from above, shooting up, on the main sail of a two-masted warship in the owner's
// colour (sprites.js warshipSprite). Once its owner has Gunnery (variant 'cannons'): crossed cannon barrels,
// muzzles up, over a pile of three cannonballs.
import { TECHS } from '/shared/config.js';
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

// The ballista: its stock (along the middle, the bolt's channel), the frame across it holding the two arms,
// which sweep back to the tips the string runs from, drawn back to the bolt's tail.
const STOCK = [43, 30, 14, 66];
const FRAME = [27, 23, 46, 17];
const SPRINGS = [[35, 31.5], [65, 31.5]];         // the twisted rope bundles in the frame that drive the arms
const bolt = () => {
  const p = new Path2D(); p.moveTo(50, 2); p.lineTo(40.5, 18); p.lineTo(59.5, 18); p.closePath();
  return p;
};

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
    const G = TECHS.gunnery;
    return 'Shoots ballista bolts at ships, troops ashore and cities. A bolt does its damage when it lands; it ' +
      `follows its target and can't be dodged. With ${G.name} it fires cannon shells at troops and cities instead: ` +
      `every other enemy within ${G.splashRadius} km of the one hit takes ${Math.round(G.splashShare * 100)}% of its ` +
      'damage (not at a city). It reloads while it sails: shoot, move away, come back and shoot again. It takes coastal ' +
      'cities; an inland city in range it brings down to 1 HP, for troops to take. Between its shots a city ' +
      'doesn\'t regenerate. Built only in coastal cities.';
  }

  static drawIcon(ctx, outline, variant = null) {
    if (variant === 'cannons') this.drawCannons(ctx, outline);
    else this.drawBallista(ctx, outline);
  }

  static drawBallista(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    const line = (w, f) => { ctx.lineWidth = w + pad; ctx.beginPath(); f(); ctx.stroke(); };
    line(2.5, () => { ctx.moveTo(7, 57); ctx.lineTo(50, 80); ctx.lineTo(93, 57); });          // the string
    line(8, () => {                                                                           // the arms
      ctx.moveTo(32, 32); ctx.quadraticCurveTo(12, 29, 7, 57);
      ctx.moveTo(68, 32); ctx.quadraticCurveTo(88, 29, 93, 57);
    });
    if (outline) {
      ctx.lineWidth = pad;
      for (const r of [STOCK, FRAME]) { ctx.strokeRect(...r); ctx.fillRect(...r); }
      line(4, () => { ctx.moveTo(50, 16); ctx.lineTo(50, 82); });
      line(3, () => { ctx.moveTo(43, 91); ctx.lineTo(50, 83); ctx.lineTo(57, 91); });
      const head = bolt();
      ctx.lineWidth = pad; ctx.stroke(head); ctx.fill(head);
      return;
    }
    // The fill: each part set off from the one under it by a dark edge, so the stock, the frame and the bolt
    // laid on them don't melt into one shape.
    const edge = 'rgba(28,19,11,0.6)';
    for (const r of [STOCK, FRAME]) {
      ctx.fillStyle = fill; ctx.fillRect(...r);
      ctx.lineWidth = 3; ctx.strokeStyle = edge; ctx.strokeRect(...r);
    }
    ctx.fillStyle = ICON_INK;
    for (const [x, y] of SPRINGS) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = ICON_INK;
    line(7, () => { ctx.moveTo(50, 17); ctx.lineTo(50, 82); });
    ctx.strokeStyle = fill;
    line(3.5, () => { ctx.moveTo(50, 17); ctx.lineTo(50, 82); });
    ctx.strokeStyle = ICON_INK;
    line(3, () => { ctx.moveTo(43, 91); ctx.lineTo(50, 83); ctx.lineTo(57, 91); });
    const head = bolt();
    ctx.fillStyle = fill; ctx.fill(head);
    ctx.lineWidth = 3; ctx.strokeStyle = edge; ctx.stroke(head);
  }

  static drawCannons(ctx, outline) {
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
