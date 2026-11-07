// Client-side base class for a unit type: how it looks (icon) and how it is
// described in the UI. Numbers always come from UNITS in shared/config.js.
import { UNITS } from '/shared/config.js';

export const ICON_INK = '#1c130b';
export const ICON_FILL = '#fffaf0';

export class UnitType {
  static type = '';

  static get stats() { return UNITS[this.type]; }
  static get isRanged() { return this.stats.attackRange > 0; }

  // Tooltip text, built from the config so it never goes stale.
  static describe() {
    const s = this.stats;
    const range = s.attackRange ? `range ${s.attackRange}` : 'melee';
    const extra = this.special();
    return `${s.name}: ${s.hp} HP · ${s.damage} damage/s · ${range} · speed ${s.moveSpeed} · ` +
      `regen ${s.hpRegen}/s out of combat.${extra ? ` ${extra}` : ''}`;
  }

  // Extra line about what makes this unit special.
  static special() { return ''; }

  // Draw the emblem inside a 100x100 box. Called twice: first with outline=true
  // (thick dark halo), then with outline=false (light fill on top).
  static drawIcon(ctx, outline) {} // eslint-disable-line no-unused-vars

  static colors(outline) {
    return { fill: outline ? ICON_INK : ICON_FILL, pad: outline ? 9 : 0 };
  }
}
