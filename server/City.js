// A city: shoots the nearest enemy unit in range, regenerates, produces units and
// upgrades, and changes hands when its HP drops to zero. Stats come from CITY and
// CITY_UPGRADES in shared/config.js.
import { CITY, CITY_UPGRADES, UPGRADE_TYPES, ECONOMY } from '../shared/config.js';

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
    this.progress = 0;
    this.rally = null;
    this.target = 0;
    this.upgrades = new Set();   // built upgrades, e.g. 'wall', 'tower'
  }

  get isCity() { return true; }
  get r() { return CITY.size; }

  bonus(stat) {
    let sum = 0;
    for (const key of this.upgrades) sum += CITY_UPGRADES[key][stat] || 0;
    return sum;
  }

  get maxHp() { return CITY.hp + this.bonus('hp'); }
  get damage() { return CITY.damage + this.bonus('damage'); }
  get range() { return CITY.attackRange * (1 + this.bonus('rangePercent') / 100); }
  // Gold this city pays its owner at the end of every turn (a Farm adds to it).
  get goldPerTurn() { return ECONOMY.goldPerCityPerTurn + this.bonus('goldPerTurn'); }
  // How fast units are trained here: 1 normally, 1.4 with Barracks. Upgrades always build at 1.
  get trainRate() { return 1 + this.bonus('trainSpeedPercent') / 100; }

  // Bit mask of built upgrades, in UPGRADE_TYPES order (sent to the browser).
  get upgradeFlags() {
    let flags = 0;
    UPGRADE_TYPES.forEach((key, i) => { if (this.upgrades.has(key)) flags |= 1 << i; });
    return flags;
  }

  // Can this upgrade still be ordered here (not built and not already queued)?
  canQueueUpgrade(key) {
    return !!CITY_UPGRADES[key] && !this.upgrades.has(key) && !this.queue.includes(key);
  }

  // An upgrade finished building: the city gets its bonus straight away.
  addUpgrade(key) {
    if (this.upgrades.has(key)) return;
    this.upgrades.add(key);
    this.hp += CITY_UPGRADES[key].hp || 0;
  }

  // Fire at the nearest enemy unit in range (neutral cities fire at everyone).
  update(dt) {
    const g = this.game;
    const range = this.range;
    let t = this.target ? g.units.get(this.target) : null;
    if (t && (t.hp <= 0 || t.owner === this.owner || Math.hypot(t.x - this.x, t.y - this.y) > range + t.r)) t = null;
    if (!t) {
      let bd = Infinity;
      g.unitGrid.forEachNear(this.x, this.y, range + 8, (o) => {
        if (o.owner === this.owner || o.hp <= 0) return;
        const d = Math.hypot(o.x - this.x, o.y - this.y) - o.r;
        if (d <= range && d < bd) { bd = d; t = o; }
      });
    }
    this.target = t ? t.id : 0;
    if (t) t.receiveDamage(this.damage * dt, this);
  }

  receiveDamage(amount, attacker) {
    this.hp -= amount;
    if (this.hp <= 0) this.game.captureCity(this, attacker.owner);
  }

  regenerate(dt) {
    const max = this.maxHp;
    if (this.hp < max) this.hp = Math.min(max, this.hp + CITY.hpRegen * dt);
  }

  // Changes hands: its upgrades are destroyed and production stops.
  capture(newOwner) {
    this.upgrades.clear();
    this.owner = newOwner;
    this.hp = CITY.captureHp;
    this.queue = [];
    this.progress = 0;
    this.rally = null;
    this.target = 0;
  }

  // A spot on land just outside the walls, preferably facing the rally point.
  spawnPoint(unitSize) {
    const nav = this.game.nav;
    const d = CITY.size + unitSize + 2;
    const base = this.rally ? Math.atan2(this.rally.y - this.y, this.rally.x - this.x) : Math.random() * Math.PI * 2;
    for (let k = 0; k < 16; k++) {
      const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8) + (Math.random() - 0.5) * 0.3;
      const x = this.x + Math.cos(ang) * d, y = this.y + Math.sin(ang) * d;
      if (nav.walkable(x, y)) return [x, y];
    }
    return nav.nearestWalkable(this.x, this.y, 60) || [this.x, this.y];
  }
}

// Areas around cities that paths go around (the same for every game).
export function markCityObstacles(nav, cities) {
  nav.markObstacles(cities.map((c) => ({ x: c.x, y: c.y, r: CITY.size + 2 })));
}
