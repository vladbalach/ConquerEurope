// Healer: never trained, made from any plain land unit of yours for honor (tradition Order of Mercy, see
// HEALER in shared/config.js). A weak fighter; the land units of its owner around it heal (Game.heal).
import { Unit } from './Unit.js';

export class Healer extends Unit {
  static type = 'healer';
}
