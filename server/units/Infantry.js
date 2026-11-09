// Infantry: sturdy melee unit. Its HP, damage and speed are set in UNITS.infantry
// (shared/config.js); it fights like the base melee unit.
import { Unit } from './Unit.js';

export class Infantry extends Unit {
  static type = 'infantry';
}
