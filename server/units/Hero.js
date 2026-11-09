// Hero: never trained, made from one of your land units for honor (tradition Cult of Heroes, see HERO
// in shared/config.js). It has the HP and damage of a Hero (UNITS.hero) but the speed and attack range of
// its kind, what it was made from (`kind`: infantry, archer or cavalry; a knight makes a cavalry Hero), so
// an archer Hero shoots from afar and a cavalry Hero rides. Every land unit of its owner around it deals
// more damage (Game.inspire).
import { UNITS } from '../../shared/config.js';
import { Unit } from './Unit.js';

export class Hero extends Unit {
  static type = 'hero';

  constructor(game, id, owner, x, y) {
    super(game, id, owner, x, y);
    this.kind = 'infantry';     // set by Game.promote
  }

  // UNITS.hero with the moveSpeed and attackRange of its kind, read on every call so that a balance
  // change (applied to UNITS in place) reaches Heroes already on the map.
  get stats() {
    const s = (this.ownStats ||= {});
    Object.assign(s, UNITS.hero);
    const k = UNITS[this.kind] || UNITS.infantry;   // `kind` is not set yet while Unit's constructor runs
    s.moveSpeed = k.moveSpeed;
    s.attackRange = k.attackRange;
    return s;
  }
}
