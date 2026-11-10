// Base class for every unit. Holds the behaviour all units share: following
// orders, picking targets, walking around water and fighting. Unit types
// (Infantry.js, Archer.js, Cavalry.js, Knight.js) extend it, and all numbers come
// from UNITS in shared/config.js. Ships (Ship.js) extend it too and sail instead of walking;
// battleships fight with the same targeting and orders as land units.
import { UNITS, UNIT_TYPES, CITY, COMBAT, DISBAND, NAVAL, HERO } from '../../shared/config.js';

const SCAN_INTERVAL = 0.3;          // seconds between searches for a new target
const REPLAN_INTERVAL = 0.5;        // minimum seconds between two path searches
const SLIDE_ANGLES = [0.6, -0.6, 1.2, -1.2, 1.6, -1.6];   // radians tried when the coast blocks the way
const SLIDE_REPLAN = 1;             // seconds of sliding along the coast before looking for a new route
const WAYPOINT_REACH = 1.5;         // km from a waypoint at which it counts as reached
const MAX_QUEUED = 20;              // orders a unit keeps waiting behind the current one (Shift)

export class Unit {
  static type = '';

  constructor(game, id, owner, x, y) {
    this.game = game;
    this.id = id;
    this.owner = owner;
    this.type = this.constructor.type;
    this.t = UNIT_TYPES.indexOf(this.type);
    this.hp = this.stats.hp;
    this.x = x; this.y = y;
    this.px = x; this.py = y;

    this.order = { kind: 'idle' };
    this.queue = [];                    // orders given with Shift: each starts when the one before is done
    this.guardX = x; this.guardY = y;   // where an idle unit stands guard
    this.target = null;                 // { k: 'u' | 'c', id }
    this.route = null;                  // { pts, idx, gx, gy, time }
    this.unreachable = false;

    this.nextPlanAt = 0;
    this.losCheckAt = 0;
    this.nextScanAt = 0;
    this.lastCombat = -99;
    this.lastAttacker = null;
    this.lastPlayerHit = null;          // { owner, time } of the last hit by another player's unit or city
    this.disbanding = false;            // Delete key: losing HP until dead
    this.inspired = false;              // near one of its owner's Heroes this tick (Game.inspire)
    this.stuck = 0;
    this.wantMove = 0;
    this.attacking = false;
    this.engaged = 0;
    this.slide = 1;
    // Units that fire single shots (`reload` in UNITS: battleships): the game time their guns are loaded
    // again, and the time of their last shot (sendSnapshots tells the browsers, which draw it).
    this.readyAt = 0;
    this.shotAt = -1;
    // Units with `accelTime` (battleships): how fast they go now, and the last tick they moved (currentSpeed).
    this.speed = 0;
    this.movedTick = -1;
  }

  // ---------------------------------------------------------------- attributes
  get stats() { return UNITS[this.type]; }
  get maxHp() { return this.stats.hp; }
  get r() { return this.stats.size; }
  get isCity() { return false; }
  get isRanged() { return this.stats.attackRange > 0; }
  get naval() { return false; }
  // Can it fight at all? Every land unit can; ships only with guns (Ship.armed).
  get armed() { return true; }
  // Near one of its owner's Heroes: HERO.auraBonus more damage.
  get damage() {
    return this.inspired ? this.stats.damage * (1 + HERO.auraBonus) : this.stats.damage;
  }

  // Centre-to-centre distance at which this unit can hit `target`.
  reach(target) {
    return this.isRanged ? this.stats.attackRange + target.r : this.r + target.r + COMBAT.meleeReach;
  }

  dist(o) {
    return Math.hypot(o.x - this.x, o.y - this.y);
  }

  // Can it hit `o` from where it stands? Within reach and, for ranged units (archers, battleships), with no
  // mountains between them: arrows and shells don't fly over them (NavGrid.lineOfFire).
  canHit(o) {
    return this.dist(o) <= this.reach(o) && (!this.isRanged || this.game.nav.lineOfFire(this.x, this.y, o.x, o.y));
  }

  // ---------------------------------------------------------------- orders
  // Every order* method (and makeIdle) is a new order: it replaces the current one and drops the
  // queued ones. Shift + order goes through queueOrder instead.
  makeIdle() {
    this.queue.length = 0;
    this.order = { kind: 'idle' };
    this.guardX = this.x;
    this.guardY = this.y;
    this.target = null;
    this.route = null;
    this.unreachable = false;
  }

  orderMove(x, y, amove, route = null) {
    this.queue.length = 0;
    this.order = { kind: amove ? 'amove' : 'move', x, y };
    this.setOff(route);
  }

  orderAttack(k, id) {
    this.queue.length = 0;
    this.order = { kind: 'attack', tk: k, tid: id };
    this.setOff(null);
  }

  // A new order starts from scratch. Without a route the unit plans one on the next tick:
  // REPLAN_INTERVAL throttles re-planning along the way, not new orders (otherwise a player
  // clicking again within that time would leave the units standing still until it runs out).
  setOff(route) {
    this.target = null;
    this.stuck = 0;
    this.sliding = 0;
    this.route = route;
    this.unreachable = false;
    this.nextPlanAt = 0;
  }

  // H key: stand still. The unit hits whatever comes within reach but never walks, not even
  // to chase or to return after a push. Only a new order (move, attack, stop) ends it.
  orderHold() {
    this.makeIdle();              // drops the queue too
    this.order = { kind: 'hold' };
  }

  get holding() { return this.order.kind === 'hold'; }

  // Right-click on your transport: walk to its gather point on the shore of `land` and go on board
  // once close to it. The transport says where to gather (ship.gather); when it sails off for
  // something else, or gathers on another landmass, the order is over.
  orderBoard(shipId, land) {
    this.queue.length = 0;
    this.order = { kind: 'board', ship: shipId, land };
    this.setOff(null);
  }

  // Shift + order: `o` ({ kind: 'move' | 'amove', x, y } or { kind: 'attack', tk, tid }) waits until the
  // orders before it are done. A unit whose order never ends by itself (idle, on hold, on its way to
  // a transport) starts it at once, as if Shift was not held.
  queueOrder(o) {
    if (!this.busy) {
      this.startQueued(o);
    } else if (this.queue.length < MAX_QUEUED) {
      this.queue.push(o);
    }
  }

  // Busy with an order that ends by itself, so there is something to queue behind.
  get busy() {
    const k = this.order.kind;
    return k === 'move' || k === 'amove' || k === 'attack';
  }

  // The current order is over: the next queued one starts, or the unit goes idle. A queued attack
  // whose target is gone (dead, or a city that is ours by now) is skipped.
  done() {
    const rest = this.queue;
    this.queue = [];              // the order* methods empty the queue: let them empty this one, not `rest`
    while (rest.length) {
      const o = rest.shift();
      if (o.kind === 'attack' && !this.game.resolve(o.tk, o.tid, this.owner)) continue;
      this.startQueued(o);
      this.queue = rest;          // what is still to come
      return;
    }
    this.makeIdle();
  }

  startQueued(o) {
    if (o.kind === 'attack') this.orderAttack(o.tk, o.tid);
    else this.orderMove(o.x, o.y, o.kind === 'amove');
  }

  // Where an order takes the unit (an attack: where its target is now), or null for orders that
  // stay put (idle, hold) or follow something else (boarding).
  orderPoint(o) {
    if (o.kind === 'attack') {
      const t = this.game.resolve(o.tk, o.tid, this.owner);
      return t ? [t.x, t.y] : null;
    }
    return o.x === undefined ? null : [o.x, o.y];
  }

  // Where the unit will stand once its orders are done, as far as we can tell now: the place
  // a new queued order starts from.
  planEnd() {
    for (let i = this.queue.length - 1; i >= -1; i--) {
      const p = this.orderPoint(i < 0 ? this.order : this.queue[i]);
      if (p) return p;
    }
    return [this.x, this.y];
  }

  // The current order and the queued ones, for the player's map: [kind, x, y, ...] with kind
  // 0 move, 1 attack-move, 2 attack.
  planPoints() {
    const out = [];
    for (const o of [this.order, ...this.queue]) {
      const p = this.orderPoint(o);
      if (p) out.push(o.kind === 'attack' ? 2 : o.kind === 'amove' ? 1 : 0, Math.round(p[0]), Math.round(p[1]));
    }
    return out;
  }

  // Delete key: from now on the unit loses HP until it dies. It can't be undone.
  disband() {
    this.disbanding = true;
  }

  // ---------------------------------------------------------------- per tick
  update(dt) {
    this.attacking = false;
    this.wantMove = 0;
    this.engaged = 0;
    const g = this.game;
    if (this.disbanding) this.hp -= DISBAND.hpPerSecond * dt;

    if (this.order.kind === 'move') {
      this.walkOrder(dt);
      return;
    }
    if (this.order.kind === 'hold') {
      this.holdGround(dt);
      return;
    }
    if (this.order.kind === 'board') {
      this.boardOrder(dt);
      return;
    }

    let target = null;
    if (this.order.kind === 'attack') {
      target = g.resolve(this.order.tk, this.order.tid, this.owner);
      if (target) this.target = { k: this.order.tk, id: this.order.tid };
      else {
        this.done();                  // killed or captured: on to the next queued order (from the next tick)
        return;
      }
    }

    if (this.order.kind !== 'attack') {
      target = this.autoTarget();
      if (!target) {
        if (this.order.kind === 'amove') {
          this.walkOrder(dt);
        } else if (Math.hypot(this.x - this.guardX, this.y - this.guardY) > 30) {
          // Drift back to the guard post after a chase or after being pushed.
          if (this.travel(this.guardX, this.guardY, dt, 0, true) || this.unreachable) {
            this.guardX = this.x; this.guardY = this.y; this.unreachable = false;
          }
        }
        return;
      }
    }

    this.engage(target, dt);
  }

  walkOrder(dt) {
    if (this.travel(this.order.x, this.order.y, dt, 0, true) || this.unreachable) this.done();
  }

  // Walk to the transport's gather point; close enough to the transport, go on board (the game
  // loads it after this tick's moves). Waits at the gather point until the transport is there.
  boardOrder(dt) {
    const g = this.game;
    const ship = g.units.get(this.order.ship);
    const gather = ship && ship.owner === this.owner && ship.gather;
    if (!gather || gather.land !== this.order.land) { this.makeIdle(); return; }
    if (this.dist(ship) <= NAVAL.boardRadius) {
      g.boarding.push([this, ship]);
      return;
    }
    this.travel(gather.x, gather.y, dt, 0, true);
    if (this.unreachable) this.makeIdle();
  }

  // Hold: keep hitting the current target while it stays within reach, otherwise the nearest
  // enemy within reach. Nothing out of reach is chased.
  holdGround(dt) {
    let t = this.target ? this.game.resolve(this.target.k, this.target.id, this.owner) : null;
    if (!t || !this.canHit(t)) {
      t = this.findInReach();
      this.target = t ? { k: t.isCity ? 'c' : 'u', id: t.id } : null;
    }
    if (t) this.hit(t, dt);
  }

  regenerate(dt) {
    if (this.disbanding) return;
    if (this.game.time - this.lastCombat > COMBAT.regenDelay && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + this.stats.hpRegen * dt);
    }
  }

  // ---------------------------------------------------------------- targeting
  // Pick what to fight on our own initiative. Enemy units always come first: a city is
  // only attacked when no enemy unit we can reach is in sight. (Explicit attack orders
  // are handled in update() and are always obeyed.)
  autoTarget() {
    const g = this.game;
    let target = null;
    if (this.target) {
      target = g.resolve(this.target.k, this.target.id, this.owner);
      if (target) {
        const tooFar = this.dist(target) > COMBAT.visionRange * 1.6 + target.r;
        const leashed = this.order.kind === 'idle' &&
          Math.hypot(this.x - this.guardX, this.y - this.guardY) > COMBAT.leashRange;
        if (tooFar || leashed || this.unreachable) target = null;
      }
      if (!target) { this.target = null; this.route = null; this.unreachable = false; }
    }
    // Attack-move: a unit it went for that has moved out of reach is not chased like the target of an
    // attack order. At every scan the nearest enemy unit in sight is taken instead (the same one while it
    // is still the nearest); with none in sight the unit lets it go and walks on.
    if (target && !target.isCity && this.order.kind === 'amove' && g.time >= this.nextScanAt &&
        !this.canHit(target)) {
      this.nextScanAt = g.time + SCAN_INTERVAL;
      const nearest = this.findEnemyUnit();
      if (nearest !== target) {
        target = nearest;
        this.target = nearest ? { k: 'u', id: nearest.id } : null;
        this.route = null;
        this.unreachable = false;
      }
    }
    // Busy with a city: drop it as soon as an enemy unit shows up.
    if (target && target.isCity && g.time >= this.nextScanAt) {
      this.nextScanAt = g.time + SCAN_INTERVAL;
      const unit = this.findEnemyUnit();
      if (unit) { target = unit; this.target = { k: 'u', id: unit.id }; }
    }
    // Hit back at a unit that is hurting us.
    if (!target && this.lastAttacker && this.lastAttacker.k === 'u' && g.time - this.lastAttacker.time < 1) {
      const t = g.resolve('u', this.lastAttacker.id, this.owner);
      if (t && Math.hypot(this.x - this.guardX, this.y - this.guardY) < COMBAT.leashRange && this.canEngage(t)) {
        target = t;
        this.target = { k: 'u', id: t.id };
      }
    }
    if (!target && g.time >= this.nextScanAt) {
      this.nextScanAt = g.time + SCAN_INTERVAL;
      target = this.findEnemyUnit() || this.findEnemyCity(this.order.kind === 'amove');
      if (target) this.target = { k: target.isCity ? 'c' : 'u', id: target.id };
    }
    return target;
  }

  // Can this unit fight `o` from here: can hit it already, or walkable straight line?
  canEngage(o) {
    if (this.canHit(o)) return true;
    return this.game.nav.los(this.x, this.y, o.x, o.y);
  }

  sightRange() {
    return Math.max(COMBAT.visionRange, this.reach({ r: 0 }) + 20);
  }

  // Nearest enemy unit in sight that we can actually fight.
  findEnemyUnit() {
    const range = this.sightRange();
    const near = [];
    this.game.unitGrid.forEachNear(this.x, this.y, range + 8, (o) => {
      if (o.owner === this.owner || o.hp <= 0) return;
      const d = this.dist(o) - o.r;
      if (d <= range) near.push([d, o]);
    });
    near.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(near.length, 6); i++) {
      if (this.canEngage(near[i][1])) return near[i][1];
    }
    return null;
  }

  // An enemy city to attack when no enemy unit is around. Units standing idle only hit a
  // city that is shooting them or already within reach; attack-move seeks cities in sight.
  findEnemyCity(includeCities) {
    const g = this.game;
    if (this.lastAttacker && this.lastAttacker.k === 'c' && g.time - this.lastAttacker.time < 1) {
      const c = g.resolve('c', this.lastAttacker.id, this.owner);
      if (c && Math.hypot(this.x - this.guardX, this.y - this.guardY) < COMBAT.leashRange && this.canEngage(c)) return c;
    }
    const cityRange = includeCities ? this.sightRange() : this.reach({ r: 0 });
    let best = null, bd = Infinity;
    g.cityGrid.forEachNear(this.x, this.y, cityRange + CITY.size, (c) => {
      if (c.owner === this.owner) return;
      const d = this.dist(c) - c.r;
      if (d <= cityRange && d < bd && this.canEngage(c)) { bd = d; best = c; }
    });
    return best;
  }

  // Any enemy close enough to hit right now (used when the crowd blocks the real target).
  findInReach() {
    const g = this.game;
    const extra = this.reach({ r: 0 });
    let best = null, bd = Infinity;
    g.unitGrid.forEachNear(this.x, this.y, extra + 8, (o) => {
      if (o.owner === this.owner || o.hp <= 0) return;
      const d = this.dist(o) - o.r;
      if (d <= extra && d < bd && this.canHit(o)) { bd = d; best = o; }
    });
    if (best) return best;
    g.cityGrid.forEachNear(this.x, this.y, extra + CITY.size, (c) => {
      if (c.owner === this.owner) return;
      const d = this.dist(c) - c.r;
      if (d <= extra && d < bd && this.canHit(c)) { bd = d; best = c; }
    });
    return best;
  }

  // ---------------------------------------------------------------- combat
  engage(target, dt) {
    if (this.canHit(target)) {
      this.route = null;
      this.hit(target, dt);
      return;
    }
    if (this.stuck > 0.4) {
      const alt = this.findInReach();
      if (alt) { this.hit(alt, dt); return; }
    }
    const spot = this.approach(target);
    if (spot) this.travel(spot[0], spot[1], dt, spot[2], false);
    else this.unreachable = true;
    if (this.unreachable && this.order.kind === 'attack') this.done();
  }

  // Where to go to hit `target`, [x, y, how close]: towards the target itself, until within reach of it.
  // A ranged unit with mountains in its line of fire goes on towards it (round them, as paths do) until
  // it has a clear shot (engage fires as soon as canHit). Ships override it (a target on land is shelled
  // from the water nearest to it with a clear line of fire). Null: nowhere.
  approach(target) {
    const blocked = this.isRanged && !this.game.nav.lineOfFire(this.x, this.y, target.x, target.y);
    return [target.x, target.y, blocked ? this.r + target.r : this.reach(target) * 0.9];
  }

  // Damage every second; units with `reload` (battleships) instead fire one shot of `damage` whenever
  // their guns are loaded. Reloading goes on whatever the unit does, moving included, so it can sail
  // off between two shots and fire at once on coming back.
  hit(target, dt) {
    this.attacking = true;
    this.lastCombat = this.game.time;
    this.engaged = target.isCity ? -(target.id + 1) : target.id;
    const reload = this.stats.reload;
    if (!reload) {
      target.receiveDamage(this.damage * dt, this);
      return;
    }
    const now = this.game.time;
    if (now < this.readyAt - 1e-6) return;          // still loading (1e-6: ticks add up to a little less)
    this.readyAt = now + reload;
    this.shotAt = now;
    target.receiveDamage(this.damage, this);
  }

  // This unit replaces `u` where it stands (a unit made a Hero): the same orders, guard post, target
  // and fight, and the same share of its HP. In the Kills and Losses stats it is worth what `u` was.
  takeOver(u) {
    this.px = u.px; this.py = u.py;
    this.hp = (u.hp / u.maxHp) * this.maxHp;
    this.order = u.order;
    this.queue = u.queue;
    this.guardX = u.guardX; this.guardY = u.guardY;
    this.target = u.target;
    this.route = u.route;
    this.unreachable = u.unreachable;
    this.lastCombat = u.lastCombat;
    this.lastAttacker = u.lastAttacker;
    this.lastHitOwner = u.lastHitOwner;
    this.lastPlayerHit = u.lastPlayerHit;
    this.inspired = u.inspired;
    this.value = u.value ?? UNITS[u.type].cost;
  }

  receiveDamage(amount, attacker) {
    this.hp -= amount;
    this.lastHitOwner = attacker.owner;   // who gets the kill if this was the last hit
    if (this.game.players.has(attacker.owner)) this.lastPlayerHit = { owner: attacker.owner, time: this.game.time };
    this.lastCombat = this.game.time;
    this.lastAttacker = { k: attacker.isCity ? 'c' : 'u', id: attacker.id, time: this.game.time };
  }

  // ---------------------------------------------------------------- movement
  // Head for (x, y), path-finding around water. Returns true on arrival.
  travel(x, y, dt, stopDist, isDestination) {
    const g = this.game, nav = g.nav;
    const d = Math.hypot(x - this.x, y - this.y);
    if (d <= Math.max(stopDist, 0.5)) { this.route = null; return true; }
    if (isDestination && this.stuck > 1.2 && d < 45 && this.crowded()) { this.route = null; return true; }   // crowd at the spot

    let r = this.route;
    const shift = r ? Math.hypot(r.gx - x, r.gy - y) : Infinity;
    // Held up (by others or by the coast), or sliding along a coast for a while: the route does not
    // work from here, look for a new one.
    const stuckOnRoute = r && (this.stuck > 1.5 || this.sliding > SLIDE_REPLAN) && g.time - r.time > 2;
    const needPlan = !r || shift > (r.pts ? 25 : 10) || stuckOnRoute;
    if (needPlan && g.time >= this.nextPlanAt) {
      this.nextPlanAt = g.time + REPLAN_INTERVAL;
      this.sliding = 0;
      if (this.clearPath(this.x, this.y, x, y)) {
        r = this.route = { pts: null, idx: 0, gx: x, gy: y, time: g.time };
      } else {
        const pts = this.planPath(x, y, stuckOnRoute);
        if (pts === undefined) {
          this.nextPlanAt = g.time;                  // search budget used up: retry next tick
        } else if (pts === null) {
          this.unreachable = true;
          this.route = null;
          return false;
        } else {
          r = this.route = { pts: pts.length ? pts : null, idx: 0, gx: x, gy: y, time: g.time };
        }
      }
    }
    if (!r) return false;

    let wx = x, wy = y, sd = stopDist;
    const pts = r.pts;
    if (pts && r.idx < pts.length) {
      const p = pts[r.idx];
      const dp = Math.hypot(p[0] - this.x, p[1] - this.y);
      if (dp < WAYPOINT_REACH || (dp < nav.cell && this.stuck > 0.5)) {
        r.idx++;
      } else if (g.time >= this.losCheckAt) {
        // Skip ahead when the next waypoint is already in sight: from here, not from this one. Cutting
        // the corner from somewhere near a waypoint can run into the coast (a narrow strait, a cape).
        this.losCheckAt = g.time + (dp < nav.cell ? 0.1 : 0.4);
        const next = r.idx + 1 < pts.length ? pts[r.idx + 1] : [x, y];
        if (this.clearPath(this.x, this.y, next[0], next[1])) r.idx++;
      }
      if (r.idx < pts.length) { wx = pts[r.idx][0]; wy = pts[r.idx][1]; sd = 0; }
    }
    this.stepToward(wx, wy, dt, sd);
    return false;
  }

  // Held up at its destination by others standing there? (then it counts as arrived). Ships check
  // that other ships are around: one held up by the coast looks for a way instead.
  crowded() {
    return true;
  }

  // Can the unit go straight from (ax, ay) to (bx, by)? Ships override this and planPath to sail.
  clearPath(ax, ay, bx, by) {
    return this.game.nav.clear(ax, ay, bx, by);
  }

  // Waypoints to (x, y): see NavGrid.findPathCached.
  planPath(x, y, fresh) {
    return this.game.nav.findPathCached(this.x, this.y, x, y, false, fresh);
  }

  // Would stepping to (x, y) walk into water or into a city's walls?
  blocked(x, y) {
    if (!this.game.nav.canStep(this.x, this.y, x, y)) return true;
    let hit = false;
    this.game.cityGrid.forEachNear(x, y, CITY.size + this.r, (c) => {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < c.r + this.r - 0.5 && d < Math.hypot(this.x - c.x, this.y - c.y)) hit = true;
    });
    return hit;
  }

  // One step towards (x, y); slides along coasts and around cities instead of running into them.
  stepToward(x, y, dt, stopDist) {
    const dx = x - this.x, dy = y - this.y;
    const d = Math.hypot(dx, dy);
    if (d <= stopDist + 0.01) return;
    const step = Math.min(this.currentSpeed(dt) * dt, d - stopDist);
    this.wantMove = step;
    let nx = this.x + (dx / d) * step, ny = this.y + (dy / d) * step;
    if (this.blocked(nx, ny)) {
      this.sliding = (this.sliding || 0) + dt;      // see travel(): sliding for long means a new route
      const base = Math.atan2(dy, dx);
      let moved = false;
      for (const a of SLIDE_ANGLES) {
        const ang = base + a * this.slide;
        const sx = this.x + Math.cos(ang) * step, sy = this.y + Math.sin(ang) * step;
        if (!this.blocked(sx, sy)) {
          nx = sx; ny = sy; moved = true;
          if (a < 0) this.slide = -this.slide;     // remember which way along the coast works
          break;
        }
      }
      if (!moved) return;
    } else if (this.sliding) {
      this.sliding = Math.max(0, this.sliding - dt);
    }
    this.x = nx;
    this.y = ny;
    this.movedTick = this.game.tickCount;
  }

  // How fast it goes this tick. A unit with `accelTime` (battleships) that stood still the tick before
  // (stopped to shoot, idle, on hold, held up) starts again from rest and reaches moveSpeed after
  // accelTime seconds, so a ship that stops to fire falls behind one that keeps going. Every other unit
  // goes at full speed at once.
  currentSpeed(dt) {
    const s = this.stats, max = s.moveSpeed;
    if (!s.accelTime) return max;
    if (this.movedTick !== this.game.tickCount - 1) this.speed = 0;
    this.speed = Math.min(max, this.speed + (max / s.accelTime) * dt);
    return this.speed;
  }
}
