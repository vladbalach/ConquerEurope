// Infantry: sturdy melee unit. Its shields block part of the damage from archers
// (UNITS.infantry.archerDamageReduction in shared/config.js).
import { Unit } from './Unit.js';

export class Infantry extends Unit {
  static type = 'infantry';

  receiveDamage(amount, attacker) {
    if (attacker && attacker.type === 'archer') amount *= 1 - this.stats.archerDamageReduction;
    super.receiveDamage(amount, attacker);
  }
}
