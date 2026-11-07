// Archers: fragile ranged unit. They hit anything within UNITS.archer.attackRange
// (shared/config.js); since arrows fly, they can shoot across a strait even though
// they cannot walk over water. Ranged behaviour comes from attackRange > 0 in Unit.
import { Unit } from './Unit.js';

export class Archer extends Unit {
  static type = 'archer';
}
