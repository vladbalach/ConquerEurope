// Infantry: crossed-swords emblem.
import { UnitType } from './UnitType.js';

function swordPath(p) {
  p.moveTo(50, 2); p.lineTo(57, 13); p.lineTo(57, 62); p.lineTo(43, 62); p.lineTo(43, 13); p.closePath();
  p.rect(28, 62, 44, 9);
  p.rect(45.5, 71, 9, 14);
  p.moveTo(56.5, 90); p.arc(50, 90, 6.5, 0, Math.PI * 2);
}

export class Infantry extends UnitType {
  static type = 'infantry';

  static special() {
    return 'Sturdy melee line.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    for (const ang of [-0.62, 0.62]) {
      ctx.save();
      ctx.translate(50, 50); ctx.rotate(ang); ctx.translate(-50, -50);
      const p = new Path2D();
      swordPath(p);
      if (outline) { ctx.lineWidth = pad; ctx.stroke(p); }
      ctx.fill(p);
      ctx.restore();
    }
  }
}
