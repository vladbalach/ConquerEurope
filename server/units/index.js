// Registry of unit classes, keyed by the type names used in shared/config.js.
import { UNIT_TYPES } from '../../shared/config.js';
import { Infantry } from './Infantry.js';
import { Archer } from './Archer.js';
import { Cavalry } from './Cavalry.js';
import { Knight } from './Knight.js';
import { Transport } from './Transport.js';
import { Hero } from './Hero.js';
import { Healer } from './Healer.js';
import { Battleship } from './Battleship.js';

export const UNIT_CLASSES = {
  infantry: Infantry, archer: Archer, cavalry: Cavalry, knight: Knight, transport: Transport, hero: Hero, healer: Healer,
  battleship: Battleship,
};

for (const type of UNIT_TYPES) {
  if (!UNIT_CLASSES[type]) throw new Error(`No unit class for type "${type}"`);
}

export function createUnit(type, game, id, owner, x, y) {
  return new UNIT_CLASSES[type](game, id, owner, x, y);
}
