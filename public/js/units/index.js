// Unit type classes, indexed by the type id used on the network (UNIT_TYPES order).
import { UNIT_TYPES } from '/shared/config.js';
import { Infantry } from './Infantry.js';
import { Archer } from './Archer.js';
import { Cavalry } from './Cavalry.js';
import { Knight } from './Knight.js';
import { Transport } from './Transport.js';

const BY_NAME = { infantry: Infantry, archer: Archer, cavalry: Cavalry, knight: Knight, transport: Transport };

export const UNIT_CLASSES = UNIT_TYPES.map((type) => {
  if (!BY_NAME[type]) throw new Error(`No client unit class for type "${type}"`);
  return BY_NAME[type];
});
