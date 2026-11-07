// Cavalry: fast melee unit. Its speed, HP and damage are set in UNITS.cavalry
// (shared/config.js); it fights like the base melee unit.
import { Unit } from './Unit.js';

export class Cavalry extends Unit {
  static type = 'cavalry';
}
