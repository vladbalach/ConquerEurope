// Hero: crown emblem. Made from any of your land units for honor (Honor window, Cult of Heroes). Each kind
// (what it was made from) sets its mark behind a smaller crown: crossed swords for an Infantry Hero, crossed
// arrows for an Archer Hero, a horseshoe for a Cavalry Hero. Without a kind (a group of Heroes of all kinds):
// the crown alone.
import { HERO } from '/shared/config.js';
import { UnitType, ICON_INK } from './UnitType.js';

// Draws `parts` (Path2D each) in the emblem's two passes: a dark halo, then the light fill.
function drawParts(ctx, parts, outline, pad) {
  for (const p of parts) {
    if (outline) { ctx.lineWidth = pad; ctx.stroke(p); }
    ctx.fill(p);
  }
}

// Two of `one` (a shape drawn upright on x = 50) crossed in an X, turned `deg` degrees each way.
function crossed(one, deg = 40) {
  const parts = [];
  for (const d of [-deg, deg]) {
    const m = new DOMMatrix().translate(50, 50).rotate(d).translate(-50, -50);
    for (const p of one()) { const q = new Path2D(); q.addPath(p, m); parts.push(q); }
  }
  return parts;
}

function sword() {
  const blade = new Path2D();
  blade.moveTo(50, 0); blade.lineTo(55, 9); blade.lineTo(55, 66); blade.lineTo(45, 66); blade.lineTo(45, 9); blade.closePath();
  const guard = new Path2D(); guard.rect(31, 65, 38, 8);
  const grip = new Path2D(); grip.rect(46.5, 73, 7, 12);
  const pommel = new Path2D(); pommel.arc(50, 90, 5.5, 0, Math.PI * 2);
  return [blade, grip, guard, pommel];
}

function arrow() {
  const shaft = new Path2D(); shaft.rect(47, 14, 6, 76);
  const head = new Path2D();
  head.moveTo(50, -3); head.lineTo(62, 19); head.lineTo(38, 19); head.closePath();
  const left = new Path2D();
  left.moveTo(47, 72); left.lineTo(37, 82); left.lineTo(37, 99); left.lineTo(47, 89); left.closePath();
  const right = new Path2D();
  right.moveTo(53, 72); right.lineTo(63, 82); right.lineTo(63, 99); right.lineTo(53, 89); right.closePath();
  return [shaft, head, left, right];
}

// A horseshoe open at the top, the crown set in it.
function horseshoe() {
  const p = new Path2D();
  const a0 = -0.5, a1 = Math.PI + 0.5;
  p.arc(50, 50, 46, a0, a1);
  p.arc(50, 50, 31, a1, a0, true);
  p.closePath();
  return [p];
}

const MARKS = {
  infantry: () => crossed(sword, 140),          // points down: the hilts, crossguards and all, show above the crown
  archer: () => crossed(arrow),
  cavalry: horseshoe,
};
// Where the smaller crown goes with each mark: [centre x, centre y, scale].
const CROWN_AT = { infantry: [50, 52, 0.72], archer: [50, 52, 0.72], cavalry: [50, 48, 0.66] };

function crownPath() {
  const p = new Path2D();
  p.moveTo(10, 82);
  p.lineTo(6, 30);              // left point
  p.lineTo(30, 52);
  p.lineTo(50, 14);             // middle point
  p.lineTo(70, 52);
  p.lineTo(94, 30);             // right point
  p.lineTo(90, 82);
  p.closePath();
  return p;
}

// A Hero by its kind (HERO_KINDS: what it was made from): "Infantry Hero", "Archer Hero", "Cavalry Hero";
// with `article`: "an Infantry Hero", "a Cavalry Hero".
export function heroName(kind = 'infantry', article = false) {
  const name = `${kind[0].toUpperCase()}${kind.slice(1)} Hero`;
  return article ? `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}` : name;
}

export class Hero extends UnitType {
  static type = 'hero';

  // A Hero has no speed or range of its own: those of the unit it was made from.
  static describe() {
    const s = this.stats;
    return `${s.name}: ${s.hp} HP · ${s.damage} damage/s · the range and speed of the unit it was made from ` +
      `(a knight makes a cavalry Hero) · regen ${s.hpRegen}/s out of combat. ${this.special()}`;
  }

  static special() {
    return `Your land units within ${HERO.auraRadius} km of it, itself too, deal +${Math.round(HERO.auraBonus * 100)}% ` +
      `damage, all the time. Made from any land unit for ${HERO.cost} honor.`;
  }

  // `kind`: the Hero's kind (HERO_KINDS), or none for the crown alone.
  static drawIcon(ctx, outline, kind = null) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    const mark = MARKS[kind];
    if (mark) drawParts(ctx, mark(), outline, pad);
    ctx.save();
    let s = 1;
    if (mark) {
      const [x, y, scale] = CROWN_AT[kind];
      s = scale;
      ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-50, -48);   // the crown's own centre
    }
    const crown = crownPath();
    if (outline) {
      ctx.lineWidth = (pad + 2) / s; ctx.stroke(crown);
    } else if (mark) {
      ctx.strokeStyle = ICON_INK; ctx.lineWidth = 7 / s; ctx.stroke(crown);   // sets it off from the mark behind
    }
    ctx.fill(crown);
    if (!outline) {
      ctx.fillStyle = ICON_INK;
      ctx.fillRect(14, 70, 72, 7);                     // band
      for (const [x, y] of [[6, 30], [50, 14], [94, 30]]) {
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();   // jewels on the points
      }
    }
    ctx.restore();
    if (!outline && kind === 'cavalry') {               // nail holes in the horseshoe
      ctx.fillStyle = ICON_INK;
      for (const a of [0.05, 0.6, Math.PI - 0.6, Math.PI - 0.05]) {
        ctx.beginPath(); ctx.arc(50 + Math.cos(a) * 38.5, 50 + Math.sin(a) * 38.5, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}
