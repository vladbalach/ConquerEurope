// A city: shoots the nearest enemy unit in range, regenerates, produces units and
// upgrades, and changes hands when its HP drops to zero (an inland city only to land units). Stats come
// from CITY and CITY_UPGRADES in shared/config.js. A coastal city (the sea within NAVAL.portRange) has a
// port, where the ships it builds are launched.
import { CITY, CITY_UPGRADES, UPGRADE_TYPES, ECONOMY, NAVAL, UNITS } from '../shared/config.js';
import { nextGrade } from '../shared/upgrades.js';

const SHELLED_HP = 1;        // the least HP ships' fire leaves an inland city with (receiveDamage)

export class City {
  constructor(game, id, data) {
    this.game = game;
    this.id = id;
    this.name = data.n;
    this.country = data.c;
    this.x = data.x;
    this.y = data.y;
    this.owner = -1;
    this.hp = CITY.hp;
    this.queue = [];        // production: unit types and upgrade names
    // Honor paid for each queue entry, by index (Barracks with Brotherhood of Arms, units with Eternal
    // Glory): what a cancel or a capture gives back instead of gold. 0 or missing: paid in gold.
    this.queueHonor = [];
    this.progress = 0;
    this.rally = null;           // { x, y } on land: where new units go
    this.seaRally = null;        // { x, y } on the sea: where new ships go (coastal cities)
    this.target = 0;
    this.regenAt = 0;            // game time it regenerates again after a shot (receiveDamage)
    this.upgrades = new Set();   // built upgrades, e.g. 'wall', 'tower'
    this.port = null;            // { x, y, sea }: the nearest sea point, for coastal cities
    // Set by an admin in Edit map (map.json `coastal`): true or false, null = from the distance to the sea.
    this.portOverride = typeof data.coastal === 'boolean' ? data.coastal : null;
  }

  get isCity() { return true; }
  get r() { return CITY.size; }

  // Coastal or not, from where the city stands now (after an admin moved it, too): the sea within
  // NAVAL.portRange, unless an admin made it inland, or coastal with the sea a little farther.
  updatePort() {
    const nav = this.game.nav;
    const range = this.portOverride === false ? 0 : this.portOverride ? NAVAL.editPortRange : NAVAL.portRange;
    const p = range ? nav.nearestSea(this.x, this.y, range) : null;
    this.port = p ? { x: p[0], y: p[1], sea: nav.seaAt(p[0], p[1]) } : null;
  }

  // Can this unit type be built here? Ships only in coastal cities.
  canBuild(type) {
    return !UNITS[type]?.naval || !!this.port;
  }

  bonus(stat) {
    let sum = 0;
    for (const key of this.upgrades) sum += CITY_UPGRADES[key][stat] || 0;
    return sum;
  }

  get maxHp() { return CITY.hp + this.bonus('hp'); }
  get damage() { return CITY.damage + this.bonus('damage'); }
  get range() { return CITY.attackRange * (1 + this.bonus('rangePercent') / 100); }
  // Gold this city pays its owner at the end of every turn. A Farm adds to it, and so does
  // holding every city of its region (see hasRegionBonus).
  get goldPerTurn() {
    return ECONOMY.goldPerCityPerTurn + this.bonus('goldPerTurn') + (this.hasRegionBonus ? ECONOMY.regionBonusPerCity : 0);
  }
  // Does its owner hold every city of its region?
  get hasRegionBonus() { return this.owner >= 0 && this.game.regionHolder(this.country) === this.owner; }
  // How fast units are trained here: 1 normally, 1.4 with Barracks. Upgrades always build at 1.
  get trainRate() { return 1 + this.bonus('trainSpeedPercent') / 100; }

  // Bit mask of built upgrades, in UPGRADE_TYPES order (sent to the browser).
  get upgradeFlags() {
    let flags = 0;
    UPGRADE_TYPES.forEach((key, i) => { if (this.upgrades.has(key)) flags |= 1 << i; });
    return flags;
  }

  // The grade of this upgrade an order queues here: the lowest one not built and not already
  // queued ('wall2' once a Wall I is built or on its way), or null when every grade is.
  nextUpgrade(key) {
    return nextGrade(key, (k) => this.upgrades.has(k) || this.queue.includes(k));
  }

  // An upgrade finished building: the city gets its bonus straight away.
  addUpgrade(key) {
    if (this.upgrades.has(key)) return;
    this.upgrades.add(key);
    this.hp += CITY_UPGRADES[key].hp || 0;
  }

  // Fire at the nearest enemy unit in range (neutral cities fire at everyone) that no mountains hide: its
  // guns don't fire over them (NavGrid.lineOfFire).
  update(dt) {
    const g = this.game, nav = g.nav;
    const range = this.range;
    let t = this.target ? g.units.get(this.target) : null;
    if (t && (t.hp <= 0 || t.owner === this.owner || Math.hypot(t.x - this.x, t.y - this.y) > range + t.r ||
        !nav.lineOfFire(this.x, this.y, t.x, t.y))) t = null;
    if (!t) {
      let bd = Infinity;
      g.unitGrid.forEachNear(this.x, this.y, range + 8, (o) => {
        if (o.owner === this.owner || o.hp <= 0) return;
        const d = Math.hypot(o.x - this.x, o.y - this.y) - o.r;
        if (d <= range && d < bd && nav.lineOfFire(this.x, this.y, o.x, o.y)) { bd = d; t = o; }
      });
    }
    this.target = t ? t.id : 0;
    if (t) t.receiveDamage(this.damage * dt, this);
  }

  // At zero HP the city falls to whoever dealt the last blow. A ship takes only a coastal city (one with a
  // port): an inland one in reach of its guns goes down to SHELLED_HP and no further, for troops to take.
  // A shot (from a unit with `reload`: a battleship) also stops its regeneration until that unit could fire
  // again: otherwise it would win back between shots what an attack every second keeps down.
  receiveDamage(amount, attacker) {
    this.hp -= amount;
    const reload = attacker.stats?.reload;
    if (reload) this.regenAt = Math.max(this.regenAt, this.game.time + reload);
    if (this.hp > 0) return;
    if (attacker.naval && !this.port) this.hp = SHELLED_HP;
    else this.game.captureCity(this, attacker.owner);
  }

  // Always, even under attack; only not between the shots of a battleship firing at it.
  regenerate(dt) {
    const max = this.maxHp;
    if (this.hp < max && this.game.time >= this.regenAt) this.hp = Math.min(max, this.hp + CITY.hpRegen * dt);
  }

  // Changes hands: its upgrades are destroyed and production stops.
  capture(newOwner) {
    this.upgrades.clear();
    this.owner = newOwner;
    this.hp = CITY.captureHp;
    this.queue = [];
    this.queueHonor = [];
    this.progress = 0;
    this.rally = null;
    this.seaRally = null;
    this.target = 0;
    this.regenAt = 0;
  }

  // A spot on the city's own landmass just outside the walls, preferably facing the rally point.
  // Not just any land: across a narrow strait that spot can be on an island the city doesn't stand on.
  spawnPoint(unitSize) {
    const nav = this.game.nav;
    const home = nav.nearestWalkable(this.x, this.y, 60);
    const land = home ? nav.landmass(home[0], home[1]) : 0;
    const d = CITY.size + unitSize + 2;
    const base = this.rally ? Math.atan2(this.rally.y - this.y, this.rally.x - this.x) : Math.random() * Math.PI * 2;
    for (let k = 0; k < 16; k++) {
      const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8) + (Math.random() - 0.5) * 0.3;
      const x = this.x + Math.cos(ang) * d, y = this.y + Math.sin(ang) * d;
      if (land ? nav.landmass(x, y) === land : nav.walkable(x, y)) return [x, y];
    }
    return home || [this.x, this.y];
  }

  // A spot on the water of the port for a new ship, a little apart from the ships already there.
  launchPoint() {
    const nav = this.game.nav, p = this.port;
    for (let k = 0; k < 8; k++) {
      const ang = Math.random() * Math.PI * 2, d = 4 + Math.random() * 10;
      const x = p.x + Math.cos(ang) * d, y = p.y + Math.sin(ang) * d;
      if (nav.seaAt(x, y) === p.sea) return [x, y];
    }
    return [p.x, p.y];
  }
}

// Areas around cities that paths go around (the same for every game): their walls on land, and
// the water within their range at sea, which ships avoid where they can.
// `map`: the map as drawn (only its shore can be beach) with the beaches painted in Edit map (beachEdits).
export function markCityObstacles(nav, cities, map = null) {
  nav.markObstacles(cities.map((c) => ({ x: c.x, y: c.y, r: CITY.size + 2 })));
  nav.markDanger(cities.map((c) => ({ x: c.x, y: c.y, r: CITY.attackRange + 10 })));
  nav.markBeaches(map?.beachEdits, map);   // where ships use the coast: beaches (all of it but painted cliffs)
}
