// Base class for ships. They sail on the sea (the seas of NavGrid) instead of walking, and are
// built only in coastal cities. Transport.js carries units: they come on board at a gather point on
// the coast and are landed on the coast nearest to where the player sends them. It has no weapons:
// attack and hold orders are ignored, and it never picks fights.
// Ships with guns (`armed`: Battleship.js) fight like land units (Unit.update): attack orders,
// attack-move, hold, and targets of their own. They hit what is within reach of the water: other
// ships, and units and cities on land, which they shell from the water nearest to them.
import { Unit } from './Unit.js';
import { DISBAND, NAVAL, COMBAT } from '../../shared/config.js';

const DOCK_REACH = 8;        // km from its dock at which a transport lands its units
const SPOT_MARGIN = 4;       // km inside its reach that an armed ship stops to shell a target on land
const SPOT_REFRESH = 10;     // km a target on land moves before its firing spot is looked for again

export class Ship extends Unit {
  constructor(game, id, owner, x, y) {
    super(game, id, owner, x, y);
    this.cargo = [];          // units on board, out of the map until they are landed
    this.gather = null;       // { x, y, land }: where units walk to come on board
  }

  get naval() { return true; }
  get capacity() { return this.stats.capacity || 0; }
  get armed() { return false; }

  // Sailing instead of walking: the sea grid for straight lines, paths and every step. Routes keep
  // out of the range of cities' guns where the sea allows (NavGrid.markDanger).
  clearPath(ax, ay, bx, by) {
    return this.game.nav.seaClear(ax, ay, bx, by);
  }

  planPath(x, y, fresh) {
    return this.game.nav.findPathCached(this.x, this.y, x, y, false, fresh, true);
  }

  blocked(x, y) {
    return !this.game.nav.canSail(this.x, this.y, x, y);
  }

  // Held up near its destination: by other ships there (arrived), or by the coast (find a way).
  crowded() {
    let found = false;
    this.game.unitGrid.forEachNear(this.x, this.y, this.r * 3, (o) => {
      if (!found && o !== this && o.naval && Math.hypot(o.x - this.x, o.y - this.y) <= this.r + o.r + 6) found = true;
    });
    return found;
  }

  // Repairs: out of combat (COMBAT.regenDelay seconds without hitting or being hit), a ship regains its own
  // hpRegen per second, and in harbour more: harbourFactor times its hpRegen when it has one (battleships),
  // otherwise NAVAL.harbourRegen.
  regenerate(dt) {
    if (this.disbanding || this.hp >= this.maxHp || this.game.time - this.lastCombat <= COMBAT.regenDelay) return;
    const s = this.stats;
    const rate = !this.inHarbour() ? s.hpRegen : s.harbourFactor ? s.hpRegen * s.harbourFactor : NAVAL.harbourRegen;
    this.hp = Math.min(this.maxHp, this.hp + rate * dt);
  }

  // Within NAVAL.harbourRange of the pier of one of its owner's coastal cities?
  inHarbour() {
    const r = NAVAL.harbourRange;
    let found = false;
    // A port is at most NAVAL.editPortRange from its city.
    this.game.cityGrid.forEachNear(this.x, this.y, r + NAVAL.editPortRange, (c) => {
      if (!found && c.owner === this.owner && c.port && Math.hypot(c.port.x - this.x, c.port.y - this.y) <= r) found = true;
    });
    return found;
  }

  // ---------------------------------------------------------------- targets (armed ships)
  // Something out of reach is worth sailing for only along a clear straight line to where it can be hit
  // from (as land units need one to walk to their target).
  canEngage(o) {
    if (this.canHit(o)) return true;
    const spot = this.approach(o);
    return !!spot && this.clearPath(this.x, this.y, spot[0], spot[1]);
  }

  // Another ship is chased (on round mountains in the way, Unit.approach); a unit or city on land is
  // shelled from the water of this ship's sea nearest to it that lies within reach of it with a clear line
  // of fire (no mountains in between): from anywhere in that cell of water, so from where the ship stops
  // too. None: nowhere to shell it from. That spot is kept until the target moves SPOT_REFRESH km.
  approach(o) {
    if (o.naval) return super.approach(o);
    const s = this.spot;
    if (s && s.city === o.isCity && s.id === o.id && Math.hypot(s.x - o.x, s.y - o.y) < SPOT_REFRESH) return s.at;
    // Its sea: where it is, or the water next to it when a push has left it on a coast cell.
    const nav = this.game.nav, here = nav.nearestSea(this.x, this.y, 2 * nav.cell);
    const sea = here ? nav.seaAt(here[0], here[1]) : 0;
    const h = nav.cell / 2;
    const clear = (x, y) => [[0, 0], [h, 0], [-h, 0], [0, h], [0, -h]].every(([dx, dy]) => nav.lineOfFire(x + dx, y + dy, o.x, o.y));
    const p = sea ? nav.nearestSea(o.x, o.y, this.reach(o) - SPOT_MARGIN, sea, clear) : null;
    const at = p ? [p[0], p[1], 0] : null;
    this.spot = { city: o.isCity, id: o.id, x: o.x, y: o.y, at };
    return at;
  }

  // ---------------------------------------------------------------- orders
  // Any new order ends the boarding: units still on their way stop (see Unit.boardOrder). It also
  // forgets the anchorage the ship would have gone back to.
  makeIdle() {
    super.makeIdle();
    this.gather = null;
    this.returnTo = null;
  }

  // Attack-move only for armed ships: the others just sail.
  orderMove(x, y, amove, route = null) {
    super.orderMove(x, y, amove && this.armed, route);
    this.gather = null;
    this.returnTo = null;
  }

  orderAttack(k, id) {
    if (this.armed) super.orderAttack(k, id);
  }

  orderHold() {
    if (this.armed) super.orderHold();
    else this.makeIdle();
  }

  orderBoard() {}

  // Sailing, attacking and landing units end by themselves, so Shift can queue sails behind them;
  // waiting at a dock for units to come on board does not.
  get busy() {
    const k = this.order.kind;
    return k === 'move' || k === 'unload' || (this.armed && (k === 'amove' || k === 'attack'));
  }

  // Sail to the dock (a sea cell next to the coast) and wait there while units come on board
  // at `gather`, the coast cell next to it: { x, y, land }. Once boarding is done (boardingDone) the
  // ship sails back to where it lay at anchor; one still sailing goes on to where it was going, one
  // docked already back to the anchorage it came from. Only when that is within NAVAL.returnRange of
  // the dock: from farther away it stays at the beach.
  orderDock(x, y, gather) {
    const o = this.order;
    let back = o.kind === 'idle' ? [this.x, this.y]
      : o.kind === 'dock' ? this.returnTo
        : o.kind === 'move' ? [o.x, o.y] : null;
    if (back && Math.hypot(back[0] - x, back[1] - y) > NAVAL.returnRange) back = null;
    super.orderMove(x, y, false);
    this.order = { kind: 'dock', x, y };
    this.gather = gather;
    this.returnTo = back;
  }

  // Boarding is over (everyone sent is on board, the ship is full, or the rest got other orders):
  // what Shift queued for it comes first, otherwise it sails back to its anchorage, if it had one.
  boardingDone() {
    const back = this.returnTo;
    if (back && !this.queue.length) {
      this.orderMove(back[0], back[1], false);
      this.order.back = true;
    } else {
      this.done();
    }
  }

  // Sail to the dock (x, y), land everyone on board at the coast cell (lx, ly), and send them on:
  // to attack `city` (>= 0), or to (tx, ty): walking, or attack-moving with `amove`.
  orderUnload({ x, y, lx, ly, land, tx, ty, city, amove }) {
    super.orderMove(x, y, false);
    this.order = { kind: 'unload', x, y, lx, ly, land, tx, ty, city, amove };
    this.gather = null;
    this.returnTo = null;
  }

  // ---------------------------------------------------------------- per tick
  update(dt) {
    if (this.armed) {             // fights like a land unit; it never takes units on board
      super.update(dt);
      return;
    }
    this.attacking = false;
    this.wantMove = 0;
    this.engaged = 0;
    if (this.disbanding) this.hp -= DISBAND.hpPerSecond * dt;
    const o = this.order;
    if (o.kind === 'move') {
      if (this.travel(o.x, o.y, dt, 0, true) || this.unreachable) this.done();
    } else if (o.kind === 'dock') {
      this.travel(o.x, o.y, dt, 0, false);
      // Twice a second: is anybody still on the way to come on board?
      const g = this.game;
      if (g.time >= (this.boardCheckAt || 0)) {
        this.boardCheckAt = g.time + 0.5;
        if (this.cargo.length >= this.capacity || !g.boardersOf(this).length) this.boardingDone();
      }
    } else if (o.kind === 'unload') {
      // At the dock, or held up by other ships close to the landing place: land them (after this
      // tick's moves, see Game.landUnits).
      const there = Math.hypot(o.x - this.x, o.y - this.y) <= DOCK_REACH ||
        (this.stuck > 1 && Math.hypot(o.lx - this.x, o.ly - this.y) <= NAVAL.boardRadius);
      if (there) {
        this.game.unloading.push(this);
        return;
      }
      this.travel(o.x, o.y, dt, 0, false);
      if (this.unreachable) this.makeIdle();
    }
  }
}
