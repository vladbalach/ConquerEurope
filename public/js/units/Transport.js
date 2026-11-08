// Transport: two-passengers emblem on the sail of a boat in the owner's colour (sprites.js shipSprite).
import { NAVAL } from '/shared/config.js';
import { UnitType } from './UnitType.js';

// A passenger: round head over rounded shoulders, in the 100x100 icon box.
function passenger(p, x, y, s) {
  p.moveTo(x + 12 * s, y);
  p.arc(x, y, 12 * s, 0, Math.PI * 2);
  p.moveTo(x - 20 * s, y + 46 * s);
  p.lineTo(x - 20 * s, y + 34 * s);
  p.quadraticCurveTo(x - 20 * s, y + 17 * s, x, y + 17 * s);
  p.quadraticCurveTo(x + 20 * s, y + 17 * s, x + 20 * s, y + 34 * s);
  p.lineTo(x + 20 * s, y + 46 * s);
  p.closePath();
}

export class Transport extends UnitType {
  static type = 'transport';

  static describe() {
    const s = this.stats;
    return `${s.name}: ${s.hp} HP · no weapons · speed ${s.moveSpeed} · regen ${s.hpRegen}/s out of combat, ` +
      `${NAVAL.harbourRegen}/s near your coastal cities. Carries up to ${s.capacity} units across the sea. ` +
      'Built only in coastal cities.';
  }

  static drawIcon(ctx, outline) {
    const { fill, pad } = this.colors(outline);
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    for (const [x, y, s] of [[66, 24, 0.95], [36, 32, 1.1]]) {     // the one behind first
      const p = new Path2D();
      passenger(p, x, y, s);
      if (outline) { ctx.lineWidth = pad; ctx.stroke(p); }
      ctx.fill(p);
      if (!outline && x === 36) {
        // A dark edge so the front passenger stands out from the one behind.
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(28,19,11,0.6)';
        ctx.stroke(p);
      }
    }
  }
}
