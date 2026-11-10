// Battleship: a warship with guns (UNITS.battleship in shared/config.js; built with the Gunnery
// technology). It shells ships, units ashore and cities within its range, like archers do on land:
// one shot of `damage` every `reload` seconds (Unit.hit). The guns reload whatever it does, so it can
// sail off between two shots and fire at once when it attacks again. Fighting is in Ship.js and Unit.js.
import { Ship } from './Ship.js';

export class Battleship extends Ship {
  static type = 'battleship';

  get armed() { return true; }
}
