// Healer: a plain, bold cross (no shield, so it never looks like the Knight's emblem). Made from any
// plain land unit of yours for honor (Honor window, Order of Mercy).
import { HEALER } from '/shared/config.js';
import { UnitType } from './UnitType.js';

function crossPath() {
  const p = new Path2D();
  const a = 31, b = 69, t = 8, e = 92;      // arm edges, tips
  p.moveTo(a, t); p.lineTo(b, t); p.lineTo(b, a); p.lineTo(e, a); p.lineTo(e, b); p.lineTo(b, b);
  p.lineTo(b, e); p.lineTo(a, e); p.lineTo(a, b); p.lineTo(t, b); p.lineTo(t, a); p.lineTo(a, a);
  p.closePath();
  return p;
}

export class Healer extends UnitType {
  static type = 'healer';

  static special() {
    return `Heals: your land units within ${HEALER.radius} km, itself too, regain ${HEALER.hpPerSecond} HP per second, ` +
      `even in combat (several Healers don't add up). Made from any land unit for ${HEALER.cost} honor.`;
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    const cross = crossPath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    if (outline) { ctx.lineWidth = pad + 2; ctx.stroke(cross); }
    ctx.fill(cross);
  }
}
