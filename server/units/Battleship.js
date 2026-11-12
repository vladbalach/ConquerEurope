// Battleship: a warship with ballistas (UNITS.battleship in shared/config.js; built with the Warships
// technology). It shoots ships, units ashore and cities within its range, one shot of `damage` every
// `reload` seconds (Unit.hit). The shot flies, following a unit it is fired at, and does its damage when it
// lands (server/projectiles.js): a ballista bolt, or with Gunnery a cannon shell at targets on land. It reloads whatever it does, so it
// can sail off between two shots and fire at once when it attacks again. Fighting is in Ship.js and Unit.js.
import { Ship } from './Ship.js';

export class Battleship extends Ship {
  static type = 'battleship';

  get armed() { return true; }

  fire(target) {
    this.game.projectiles.launch(this, target);
  }
}
