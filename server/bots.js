// Bots: computer players (game option "With bots", BOTS in shared/config.js), for someone who would otherwise play
// alone. They are played where the game runs, in the host's browser (Game.tick), and by the rules of any player:
// they give the orders a player's page sends (Game.handleCommand), paid with their own gold, within the same
// command limit.
//
// A bot is simple. Every BOTS.thinkSeconds of game time it:
//  - sends its idle units near one of its cities that enemy units have come close to, to fight them there;
//  - sends each gathering of its idle units (an army) against a city: an army close to the city it marched on
//    attacks the city itself; one big enough for a city it can walk to marches there (an attack-move: it fights
//    whatever it meets on the way). Big enough: 4 infantry for a neutral city, 10 units for a player's (more for
//    walls and defenders), and never without infantry. It picks the nearest such city, neutral ones first
//    (BOTS.playerCityPenalty), and neutral ones only in the first turns (BOTS.graceTurns);
//  - trains units in its cities as far as its gold goes, filling one city's queue before the next, where an army
//    is already gathering, so its units come together instead of standing one by one at every city. Infantry
//    only in the first turn (its start gold: 4 infantry in one city, the first army), then infantry, archers
//    and, once it is rich, knights; never cavalry (BOTS.mix);
//  - as a liberator (Death: Liberator), takes a neutral city whenever it may.
// It doesn't research, learn traditions, build upgrades or ships, and never leaves the land its units stand on.
//
// What a bot remembers (where each army was sent) is not saved: after a host change it simply looks again.
//
// Runs in the host's browser too (served as /sim/): no Node-only modules here.
import { BOTS, UNITS, CITY, COMBAT } from '../shared/config.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const infantryIn = (army) => army.reduce((n, u) => n + (u.type === 'infantry' ? 1 : 0), 0);
const LAND_REFRESH = 60;      // seconds of game time between two looks at which land each city stands on
const CANDIDATES = 5;         // cities an army weighs, nearest first, before it waits to grow bigger
const LIBERATE_SAMPLE = 12;   // neutral cities a liberator weighs
const LIBERATE_AREA = 300;    // km: ...by how many neutral cities lie this close to each

export class Bots {
  constructor(game) {
    this.game = game;
    // Bot id -> { nextAt: the game time it thinks next, sent: unit id -> the city id its army marched on }.
    this.minds = new Map();
    this.land = null;           // city id -> the landmass it stands on (cityLand)
    this.landAt = -Infinity;
  }

  // One tick: each bot thinks when its time comes, each at a moment of its own (they don't all think at once).
  update() {
    const g = this.game;
    for (const p of g.players.values()) {
      if (!p.bot || p.eliminated) continue;
      let mind = this.minds.get(p.id);
      if (!mind) this.minds.set(p.id, (mind = { nextAt: g.time + Math.random() * BOTS.thinkSeconds, sent: new Map() }));
      if (g.time < mind.nextAt) continue;
      mind.nextAt = g.time + BOTS.thinkSeconds;
      this.think(p, mind);
    }
  }

  // The landmass each city stands on (that of the land round it: the city itself is walled), looked at again
  // now and then, as admins may move cities or rebuild the map.
  cityLand() {
    const g = this.game;
    if (this.land && g.time - this.landAt < LAND_REFRESH) return this.land;
    this.landAt = g.time;
    this.land = g.cities.map((c) => {
      const p = g.nav.nearestWalkable(c.x, c.y, 60);
      return p ? g.nav.landmass(p[0], p[1]) : 0;
    });
    return this.land;
  }

  order(p, msg) {
    this.game.handleCommand(p, msg);
  }

  think(p, mind) {
    if (p.liberator) {
      this.liberate(p);
      return;
    }
    const g = this.game, land = this.cityLand();
    const own = g.cities.filter((c) => c.owner === p.id);
    const units = [];
    for (const u of g.units.values()) if (u.owner === p.id && !u.naval) units.push(u);
    for (const id of mind.sent.keys()) if (!g.units.has(id)) mind.sent.delete(id);
    // Idle: no order, and not fighting what came at it on its own.
    const idle = units.filter((u) => u.order.kind === 'idle' && !u.attacking && !u.disbanding);
    const free = new Set(idle);
    const landOf = new Map(idle.map((u) => [u, g.nav.landOf(u.x, u.y)]));
    this.defend(p, own, free, land, landOf);
    this.attack(p, mind, free, land, landOf);
    this.train(p, own, units.length, idle, land);
  }

  // Enemy units close to one of its cities: its idle units around come to fight them there (an attack-move to
  // the city). Those already at the city stay: they fight whatever comes within sight.
  defend(p, own, free, land, landOf) {
    const g = this.game;
    for (const c of own) {
      if (!free.size) return;
      let threat = false;
      g.unitGrid.forEachNear(c.x, c.y, BOTS.defendRadius, (o) => {
        if (!threat && o.owner !== p.id && !o.naval && o.hp > 0 && dist(o, c) <= BOTS.defendRadius) threat = true;
      });
      if (!threat) continue;
      const helpers = [];
      for (const u of free) {
        const d = dist(u, c);
        if (d > BOTS.helpRadius || landOf.get(u) !== land[c.id]) continue;
        free.delete(u);                    // the garrison, too, is busy with this
        if (d > COMBAT.visionRange / 2) helpers.push(u);
      }
      if (helpers.length) this.order(p, { t: 'move', ids: helpers.map((u) => u.id), x: c.x, y: c.y, amove: true });
    }
  }

  // Each army of idle units: close to the city it marched on, it attacks that city (an attack-move takes most
  // cities on the way in; this is for those it stopped short of), unless too few of it are left: those wait
  // for more. Otherwise it marches on the best city it is big enough for, or waits to grow.
  attack(p, mind, free, land, landOf) {
    for (const army of this.armies([...free], landOf)) {
      const at = { x: army.reduce((s, u) => s + u.x, 0) / army.length, y: army.reduce((s, u) => s + u.y, 0) / army.length };
      const ids = army.map((u) => u.id);
      const goal = this.armyGoal(p, army, mind);
      if (goal && dist(at, goal) <= BOTS.nearTarget) {
        if (this.canTake(p, army, goal, 0.5)) {
          this.order(p, { t: 'attack', k: 'c', id: goal.id, ids });
          continue;
        }
        for (const id of ids) mind.sent.delete(id);
      }
      const target = this.pickTarget(p, army, at, landOf.get(army[0]), land);
      if (!target) continue;
      // In the grace turns a plain move: on an attack-move it would take players' cities it passes by.
      this.order(p, { t: 'move', ids, x: target.x, y: target.y, amove: this.game.turn >= BOTS.graceTurns });
      for (const id of ids) mind.sent.set(id, target.id);
    }
  }

  // Idle units of one landmass standing within BOTS.groupRadius of one of them.
  armies(units, landOf) {
    const left = new Set(units), out = [];
    for (const u of units) {
      if (!left.has(u)) continue;
      const army = [];
      for (const v of left) if (landOf.get(v) === landOf.get(u) && dist(u, v) <= BOTS.groupRadius) army.push(v);
      for (const v of army) left.delete(v);
      out.push(army);
    }
    return out;
  }

  // The city most of the army was sent against, while it can still be attacked (and is still neutral, in the
  // first BOTS.graceTurns turns); or null.
  armyGoal(p, army, mind) {
    const votes = new Map();
    let best = -1, most = 0;
    for (const u of army) {
      const id = mind.sent.get(u.id);
      if (id === undefined) continue;
      const n = (votes.get(id) || 0) + 1;
      votes.set(id, n);
      if (n > most) { most = n; best = id; }
    }
    const goal = best >= 0 ? this.game.resolve('c', best, p.id) : null;
    return goal && (goal.owner < 0 || this.game.turn >= BOTS.graceTurns) ? goal : null;
  }

  // The city `army` (its units, standing round `at` on landmass `home`) marches on: of the cities it can walk to,
  // the nearest (a player's counts BOTS.playerCityPenalty km farther) that it is big enough to take (canTake).
  // Neutral ones only in the first BOTS.graceTurns turns. Null: none.
  pickTarget(p, army, at, home, land) {
    const g = this.game;
    if (!infantryIn(army)) return null;      // never without infantry: no need to look
    const options = [], peace = g.turn < BOTS.graceTurns;
    for (const c of g.cities) {
      if (c.owner === p.id || c.isSafe || land[c.id] !== home || !home || (peace && c.owner >= 0)) continue;
      options.push({ c, score: dist(at, c) + (c.owner >= 0 ? BOTS.playerCityPenalty : 0) });
    }
    options.sort((a, b) => a.score - b.score);
    for (const { c } of options.slice(0, CANDIDATES)) if (this.canTake(p, army, c)) return c;
    return null;
  }

  // Is `army` big enough to attack city `c`? Never without infantry. A neutral city takes armyNeeded infantry
  // (the rest of the army comes along), a player's city armyNeeded units of any kind. `share`: of that many (an
  // army at its target already goes on with half).
  canTake(p, army, c, share = 1) {
    const infantry = infantryIn(army);
    return infantry > 0 && (c.owner < 0 ? infantry : army.length) >= this.armyNeeded(p, c) * share;
  }

  // How many a bot sends against city `c` (infantry for a neutral city, units for a player's: canTake): more for
  // a player's city than a neutral one, more for a city with walls (its HP), more for the enemy units round it.
  armyNeeded(p, c) {
    const g = this.game;
    let defenders = 0;
    g.unitGrid.forEachNear(c.x, c.y, BOTS.defendRadius, (o) => {
      if (o.owner !== p.id && o.owner === c.owner && !o.naval && dist(o, c) <= BOTS.defendRadius) defenders++;
    });
    const base = c.owner < 0 ? BOTS.attackNeutral : BOTS.attackPlayer;
    return Math.min(BOTS.maxArmy, Math.ceil(base * c.maxHp / CITY.hp) + defenders);
  }

  // Units in its cities, as far as its gold goes. One city's queue is filled (BOTS.queue) before the next one's,
  // so that an army gathers there: the start gold makes 4 infantry in one city. Only in a third of its cities
  // (BOTS.trainShare), those where the most units are queued or already stand. Not in cities on land with
  // nothing left to take: their units could reach nobody.
  train(p, own, count, idle, land) {
    const g = this.game;
    let room = BOTS.maxUnits - count, gold = p.gold;
    if (room <= 0) return;
    const open = new Set();
    for (const c of g.cities) if (c.owner !== p.id) open.add(land[c.id]);
    const ranked = own.filter((c) => land[c.id] && open.has(land[c.id]))
      .map((c) => ({ c, n: c.queue.length + idle.reduce((n, u) => n + (dist(u, c) <= BOTS.groupRadius ? 1 : 0), 0), r: Math.random() }))
      .sort((a, b) => b.n - a.n || a.r - b.r);
    const cities = ranked.slice(0, Math.ceil(ranked.length * BOTS.trainShare)).map(({ c }) => c);
    // An order trains one unit in each city it lists, so a city's second unit goes in a second order:
    // `${type} ${k}` -> the cities getting their k-th unit of this type now.
    const orders = new Map();
    fill: for (const c of cities) {
      const made = new Map();               // unit type -> how many this city gets now
      for (let k = c.queue.length; k < BOTS.queue; k++) {
        if (room <= 0) break fill;
        let type = this.pickUnit(gold);
        if (gold < UNITS[type].cost) type = 'infantry';
        if (gold < UNITS[type].cost) break fill;
        gold -= UNITS[type].cost;
        room--;
        const n = made.get(type) || 0;
        made.set(type, n + 1);
        const key = `${type} ${n}`;
        if (!orders.has(key)) orders.set(key, { item: type, cities: [] });
        orders.get(key).cities.push(c.id);
      }
    }
    for (const { item, cities: ids } of orders.values()) this.order(p, { t: 'build', item, cities: ids });
  }

  // A unit type to train: infantry in the first BOTS.infantryTurns turns, then at random by BOTS.mix; knights only
  // with BOTS.richGold gold or more.
  pickUnit(gold) {
    if (this.game.turn < BOTS.infantryTurns) return 'infantry';
    const mix = Object.entries(BOTS.mix).filter(([type, w]) => w > 0 && UNITS[type] && (type !== 'knight' || gold >= BOTS.richGold));
    let roll = Math.random() * mix.reduce((s, [, w]) => s + w, 0);
    for (const [type, w] of mix) if ((roll -= w) < 0) return type;
    return 'infantry';
  }

  // A liberator (Death: Liberator) takes a neutral city whenever it may: of a few picked at random, the one
  // with the most neutral cities round it, to grow from. With no neutral city left, any it may take.
  liberate(p) {
    const g = this.game;
    if (!g.canInfluence(p)) return;
    const free = (c) => c.owner !== p.id && g.liberable(c) && !g.markedBy('influence', c.id, p);
    let pool = g.cities.filter((c) => c.owner < 0 && free(c));
    if (!pool.length) pool = g.cities.filter(free);
    if (!pool.length) return;
    let best = null, bestN = -1;
    for (let k = 0; k < LIBERATE_SAMPLE; k++) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      const n = g.cities.reduce((s, o) => s + (o.owner < 0 && dist(o, c) <= LIBERATE_AREA ? 1 : 0), 0);
      if (n > bestN) { bestN = n; best = c; }
    }
    this.order(p, { t: 'influence', city: best.id });
  }
}
