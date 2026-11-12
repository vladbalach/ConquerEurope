// Shots in flight: a battleship's ballista bolts and cannon shells (UNITS.battleship, TECHS.gunnery). A shot
// leaves the ship when it fires (Unit.hit, Battleship.fire) and does its damage when it lands, distance /
// speed seconds later:
//  - at a unit, a ship or troops on land: a ballista bolt, or at troops a shell once its owner has Gunnery.
//    It follows its target and can't be dodged: it hits unless the target died meanwhile. A shell also
//    bursts there: every other enemy unit within splashRadius km takes splashShare of its damage. One whose
//    target died first bursts where the target last stood;
//  - at a city: a bolt, or with Gunnery a shell, that always hits. A shell bursts on the walls: no splash.
// A shot counts as its ship's (kills, honor, a city it takes) even when the ship sank before it landed, as
// long as its owner is still in the game.
//
// Shots are plain data, so they are saved with the game (server/save.js) and land after a host handover.
// The browsers draw them from the snapshots (Game.sendSnapshots: `fired`).
import { UNITS, TECHS } from '../shared/config.js';
import { hasGunnery } from '../shared/tech.js';

const MIN_FLIGHT = 0.15;    // seconds: even a shot at point-blank range is still in the air at the next snapshot
// km added to the search round where a shell bursts: the unit grid holds where the units stood at the start of
// the tick, and they have moved (and been pushed) since.
const GRID_SLACK = 30;
const MAX_FIRED = 512;      // shots kept for the snapshots: plenty, unless nobody sends them (tests)

export class Projectiles {
  constructor(game) {
    this.game = game;
    this.list = [];         // in flight
    this.fired = [];        // fired since the last snapshot, for the browsers to draw
  }

  // `ship` fires at `target` (a unit or a city): the shot sets off from where the ship is now.
  launch(ship, target) {
    const g = this.game;
    const shell = !(!target.isCity && target.naval) && hasGunnery(g.players.get(ship.owner)?.tech);
    const speed = shell ? TECHS.gunnery.shellSpeed : ship.stats.boltSpeed;
    const d = Math.hypot(target.x - ship.x, target.y - ship.y);
    const s = {
      shell, homing: !target.isCity, owner: ship.owner, shooter: ship.id, type: ship.type,
      fx: ship.x, fy: ship.y, x: target.x, y: target.y,          // from, and its target's place (kept up to date)
      tk: target.isCity ? 'c' : 'u', tid: target.id,
      damage: ship.damage, firedAt: g.time, landsAt: g.time + Math.max(MIN_FLIGHT, d / speed),
    };
    this.list.push(s);
    this.fired.push(s);
    if (this.fired.length > MAX_FIRED) this.fired = this.fired.slice(-MAX_FIRED / 2);
  }

  // Every tick (Game.tick, once the units and cities have moved and fought): shots that follow a unit keep
  // up with it, and every shot whose time has come lands.
  update() {
    if (!this.list.length) return;
    const g = this.game, now = g.time, flying = [];
    for (const s of this.list) {
      const t = s.homing ? this.target(s) : null;
      if (t) { s.x = t.x; s.y = t.y; }
      if (now < s.landsAt - 1e-6) flying.push(s);
      else this.land(s, t);
    }
    this.list = flying;
  }

  // The unit shot `s` follows, while it is alive on the map.
  target(s) {
    const t = this.game.units.get(s.tid);
    return t && t.hp > 0 ? t : null;
  }

  // Shot `s` lands on `t`, the unit it follows (null: it died first), or on its city.
  land(s, t) {
    const g = this.game, p = g.players.get(s.owner);
    if (!p || p.surrendered) return;            // its owner left the game: harmless
    // Who it counts as: the ship, as it stood when it fired.
    const from = { id: s.shooter, owner: s.owner, x: s.fx, y: s.fy, naval: true, isCity: false, stats: UNITS[s.type] };
    if (s.tk === 'c') {
      const c = g.cities[s.tid];
      if (c && c.owner !== s.owner) c.receiveDamage(s.damage, from);
      return;
    }
    if (t) t.receiveDamage(s.damage, from);
    if (!s.shell) return;
    const { splashRadius, splashShare } = TECHS.gunnery;
    g.unitGrid.forEachNear(s.x, s.y, splashRadius + GRID_SLACK, (o) => {
      if (o === t || o.owner === s.owner || o.hp <= 0 || g.units.get(o.id) !== o) return;
      if (Math.hypot(o.x - s.x, o.y - s.y) - o.r <= splashRadius) o.receiveDamage(s.damage * splashShare, from);
    });
  }
}
