// Transport: an unarmed ship that carries up to UNITS.transport.capacity units across the sea
// (shared/config.js). Boarding and landing are in Ship.js and Game (orderBoard, orderUnload).
import { Ship } from './Ship.js';

export class Transport extends Ship {
  static type = 'transport';
}
