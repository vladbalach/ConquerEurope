// Archers: drawn-bow emblem.
import { UnitType } from './UnitType.js';

export class Archer extends UnitType {
  static type = 'archer';

  static special() {
    return 'Shoots from a distance, even across water.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    const line = (w, f) => { ctx.lineWidth = w + pad; ctx.beginPath(); f(); ctx.stroke(); };
    line(9, () => { ctx.moveTo(40, 6); ctx.quadraticCurveTo(98, 50, 40, 94); });
    line(2.5, () => { ctx.moveTo(40, 6); ctx.lineTo(18, 50); ctx.lineTo(40, 94); });
    line(5, () => { ctx.moveTo(12, 50); ctx.lineTo(84, 50); });
    ctx.beginPath(); ctx.moveTo(98, 50); ctx.lineTo(80, 39); ctx.lineTo(80, 61); ctx.closePath();
    if (outline) { ctx.lineWidth = pad; ctx.stroke(); }
    ctx.fill();
    line(3, () => { ctx.moveTo(14, 50); ctx.lineTo(5, 41); ctx.moveTo(14, 50); ctx.lineTo(5, 59); });
  }
}
