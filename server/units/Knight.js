// Knight: expensive heavy cavalry. Strong, tough and fast; its stats are set in
// UNITS.knight (shared/config.js). It fights like the base melee unit.
import { Unit } from './Unit.js';

export class Knight extends Unit {
  static type = 'knight';
}
