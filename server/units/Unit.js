// Base class for every unit. Holds the behaviour all units share: following
// orders, picking targets, walking around water and fighting. Unit types
// (Infantry.js, Archer.js, Cavalry.js, Knight.js) extend it, and all numbers come
// from UNITS in shared/config.js.
import { UNITS, UNIT_TYPES, CITY, COMBAT, DISBAND } from '../../shared/config.js';

const SCAN_INTERVAL = 0.3;          // seconds between searches for a new target
const REPLAN_INTERVAL = 0.5;        // minimum seconds between two path searches
const SLIDE_ANGLES = [0.6, -0.6, 1.2, -1.2, 1.6, -1.6];   // radians tried when the coast blocks the way

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
    this.stuck = 0;
    this.wantMove = 0;
    this.attacking = false;
    this.engaged = 0;
    this.slide = 1;
  }

  // ---------------------------------------------------------------- attributes
  get stats() { return UNITS[this.type]; }
  get maxHp() { return this.stats.hp; }
  get r() { return this.stats.size; }
  get isCity() { return false; }
  get isRanged() { return this.stats.attackRange > 0; }

  // Centre-to-centre distance at which this unit can hit `target`.
  reach(target) {
    return this.isRanged ? this.stats.attackRange + target.r : this.r + target.r + COMBAT.meleeReach;
  }

  dist(o) {
    return Math.hypot(o.x - this.x, o.y - this.y);
  }

  // ---------------------------------------------------------------- orders
  makeIdle() {
    this.order = { kind: 'idle' };
    this.guardX = this.x;
    this.guardY = this.y;
    this.target = null;
    this.route = null;
    this.unreachable = false;
  }

  orderMove(x, y, amove, route = null) {
    this.order = { kind: amove ? 'amove' : 'move', x, y };
    this.target = null;
    this.stuck = 0;
    this.route = route;
    this.unreachable = false;
  }

  orderAttack(k, id) {
    this.order = { kind: 'attack', tk: k, tid: id };
    this.target = null;
    this.stuck = 0;
    this.route = null;
    this.unreachable = false;
  }

  // H key: stand still. The unit hits whatever comes within reach but never walks, not even
  // to chase or to return after a push. Only a new order (move, attack, stop) ends it.
  orderHold() {
    this.makeIdle();
    this.order = { kind: 'hold' };
  }

  get holding() { return this.order.kind === 'hold'; }

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

    let target = null;
    if (this.order.kind === 'attack') {
      target = g.resolve(this.order.tk, this.order.tid, this.owner);
      if (target) this.target = { k: this.order.tk, id: this.order.tid };
      else this.makeIdle();
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
    if (this.travel(this.order.x, this.order.y, dt, 0, true) || this.unreachable) this.makeIdle();
  }

  // Hold: keep hitting the current target while it stays within reach, otherwise the nearest
  // enemy within reach. Nothing out of reach is chased.
  holdGround(dt) {
    let t = this.target ? this.game.resolve(this.target.k, this.target.id, this.owner) : null;
    if (!t || this.dist(t) > this.reach(t)) {
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

  // Can this unit fight `o` from here: already in reach, or walkable straight line?
  canEngage(o) {
    if (this.dist(o) <= this.reach(o)) return true;
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
      if (d <= extra && d < bd) { bd = d; best = o; }
    });
    if (best) return best;
    g.cityGrid.forEachNear(this.x, this.y, extra + CITY.size, (c) => {
      if (c.owner === this.owner) return;
      const d = this.dist(c) - c.r;
      if (d <= extra && d < bd) { bd = d; best = c; }
    });
    return best;
  }

  // ---------------------------------------------------------------- combat
  engage(target, dt) {
    const reach = this.reach(target);
    if (this.dist(target) <= reach) {
      this.route = null;
      this.hit(target, dt);
      return;
    }
    if (this.stuck > 0.4) {
      const alt = this.findInReach();
      if (alt) { this.hit(alt, dt); return; }
    }
    this.travel(target.x, target.y, dt, reach * 0.9, false);
    if (this.unreachable && this.order.kind === 'attack') this.makeIdle();
  }

  hit(target, dt) {
    this.attacking = true;
    this.lastCombat = this.game.time;
    this.engaged = target.isCity ? -(target.id + 1) : target.id;
    target.receiveDamage(this.stats.damage * dt, this);
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
    if (isDestination && this.stuck > 1.2 && d < 45) { this.route = null; return true; }   // crowd at the spot

    let r = this.route;
    const shift = r ? Math.hypot(r.gx - x, r.gy - y) : Infinity;
    const stuckOnRoute = r && this.stuck > 1.5 && g.time - r.time > 2;
    const needPlan = !r || shift > (r.pts ? 25 : 10) || stuckOnRoute;
    if (needPlan && g.time >= this.nextPlanAt) {
      this.nextPlanAt = g.time + REPLAN_INTERVAL;
      if (nav.clear(this.x, this.y, x, y)) {
        r = this.route = { pts: null, idx: 0, gx: x, gy: y, time: g.time };
      } else {
        const pts = nav.findPathCached(this.x, this.y, x, y, false, stuckOnRoute);
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
      if (Math.hypot(p[0] - this.x, p[1] - this.y) < nav.cell) {
        r.idx++;
      } else if (g.time >= this.losCheckAt) {
        // Skip ahead when the next waypoint is already in sight.
        this.losCheckAt = g.time + 0.4;
        const next = r.idx + 1 < pts.length ? pts[r.idx + 1] : [x, y];
        if (nav.clear(this.x, this.y, next[0], next[1])) r.idx++;
      }
      if (r.idx < pts.length) { wx = pts[r.idx][0]; wy = pts[r.idx][1]; sd = 0; }
    }
    this.stepToward(wx, wy, dt, sd);
    return false;
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
    const step = Math.min(this.stats.moveSpeed * dt, d - stopDist);
    this.wantMove = step;
    let nx = this.x + (dx / d) * step, ny = this.y + (dy / d) * step;
    if (this.blocked(nx, ny)) {
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
    }
    this.x = nx;
    this.y = ny;
  }
}
