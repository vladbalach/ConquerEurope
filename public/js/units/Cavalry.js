// Cavalry: horse-head emblem.
import { UnitType, ICON_INK } from './UnitType.js';

const HEAD = [[78, 97], [82, 62], [77, 40], [70, 25], [73, 4], [62, 15], [55, 17], [43, 22], [31, 32],
  [15, 52], [11, 63], [20, 71], [34, 67], [44, 61], [41, 73], [36, 97]];

export class Cavalry extends UnitType {
  static type = 'cavalry';

  static special() {
    return 'Fast melee raider.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    const p = new Path2D();
    p.moveTo(HEAD[0][0], HEAD[0][1]);
    for (const [x, y] of HEAD.slice(1)) p.lineTo(x, y);
    p.closePath();
    if (outline) { ctx.lineWidth = pad + 2; ctx.stroke(p); }
    ctx.fill(p);
    if (!outline) {
      ctx.fillStyle = ICON_INK;
      ctx.beginPath(); ctx.arc(49, 33, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(28,19,11,0.55)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(73, 30); ctx.lineTo(80, 60); ctx.stroke();
    }
  }
}
