// Knight: heater-shield-with-cross emblem.
import { UnitType, ICON_INK } from './UnitType.js';

function shieldPath() {
  const p = new Path2D();
  p.moveTo(16, 8);
  p.lineTo(84, 8);
  p.lineTo(84, 44);
  p.quadraticCurveTo(82, 80, 50, 97);
  p.quadraticCurveTo(18, 80, 16, 44);
  p.closePath();
  return p;
}

export class Knight extends UnitType {
  static type = 'knight';

  static special() {
    return 'Heavy armoured cavalry: tough, hard-hitting and fast, but expensive.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    const shield = shieldPath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    if (outline) { ctx.lineWidth = pad + 2; ctx.stroke(shield); }
    ctx.fill(shield);
    if (!outline) {
      ctx.fillStyle = ICON_INK;
      ctx.fillRect(44, 16, 12, 66);     // cross: upright
      ctx.fillRect(26, 32, 48, 11);     // cross: arms
    }
  }
}
