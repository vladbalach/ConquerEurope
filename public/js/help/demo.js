// Animated demos for the help (F1): little scenes played on the real map with the game's own renderer, as if
// recorded from a game. A scene (scenes.js) sets up cities and units round a real city and plays a script: a
// mouse pointer moves, clicks and drags, keys light up as they are pressed, and the units obey the way they do
// in the game (selection rings, formations from shared/formation.js, click markers, HP bars, captures...).
//
// What draws it: DemoRenderer, the game's Renderer bound to a stand-in for the game (DemoWorld) and to the
// demo's canvas. It borrows the map geometry the game's renderer has already built, so a demo costs little.
// The stand-in is made from the game client's own prototype, so the renderer's calls into it (colours, city
// ranges and HP, sprite variants...) run the game's own code on the demo's state.
//
// What moves it: a small simulation (Sim below): walking, formations, fighting units and cities, training,
// captures. It is not the host's game: just enough to show each control doing what it does.
import {
  UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, DISBAND, COMBAT, HERO, HEALER, HERO_KINDS,
  NAVAL, NEUTRAL_COLOR,
} from '/shared/config.js';
import { formationSlots, formationRole, SHIP_SPACING } from '/shared/formation.js';
import { HERO_KIND_SHIFT, CARGO_SHIFT } from '/shared/protocol.js';
import { Renderer } from '../render.js';

export const DEMO_W = 440;
export const DEMO_H = 250;

const YOU = 0, ENEMY = 1, NEUTRAL = -1;
const WHO = { you: YOU, enemy: ENEMY, neutral: NEUTRAL };
const MARKER = { move: '#9dff6a', amove: '#ff9a3c', attack: '#ff4a3a' };   // as the game's click markers
const FLAG = { disband: 4, hold: 8, repair: 16 };
const ABORT = Symbol('demo restarted');

// The map geometry a DemoRenderer takes from the game's renderer instead of building it again.
const SHARED_GEOMETRY = [
  'landActive', 'landDim', 'outlines', 'cityPaths', 'multi', 'lines', 'mountains', 'regions', 'labelSizes',
  'countryLabels', 'regionLand', 'regionEdges', 'regionOutline',
];

// ------------------------------------------------------------------ renderer
class DemoRenderer extends Renderer {
  constructor(world, canvas) {
    const wrap = document.createElement('div');       // the base class wants a minimap in a frame: never shown
    const mini = document.createElement('canvas');
    wrap.append(mini);
    super(world, canvas, mini);
  }

  buildPaths() {
    const src = this.g.sourceRenderer;
    for (const k of SHARED_GEOMETRY) this[k] = src[k];
  }

  // A fixed size, and no minimap (the game's resize() also sizes the page's minimap).
  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = DEMO_W;
    this.H = DEMO_H;
    this.canvas.width = Math.round(DEMO_W * this.dpr);
    this.canvas.height = Math.round(DEMO_H * this.dpr);
    this.mapLayer.width = this.canvas.width;
    this.mapLayer.height = this.canvas.height;
    this.mapKey = '';
  }

  // The game's frame (Renderer.draw) without the minimap and the guide, then the demo's pointer and keys.
  frame(now, overlay) {
    const ctx = this.ctx, g = this.g;
    this.ensureMapLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mapLayer, 0, 0);
    this.drawRegionGlow(now);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawRally();
    if (g.input.showRanges) this.drawCityRanges();
    this.drawPorts();
    this.drawCities(now);
    this.drawPlans();
    this.drawDocks();
    this.drawUnits(now);
    this.drawFormation();
    this.drawEffects(now);
    this.drawSelectionBox();
    overlay(ctx);
  }
}

// ------------------------------------------------------------------ the stand-in for the game
// `g`: the game client (its map, ports, beaches and prototype). `colors`: [yours, the enemy's].
function makeWorld(g, colors, cam) {
  const n = g.map.cities.length;
  const w = Object.create(Object.getPrototypeOf(g));
  Object.assign(w, {
    map: g.map, ports: g.ports, beaches: g.beaches, regionCities: g.regionCities, sourceRenderer: g.renderer,
    you: YOU, spectator: false,
    players: new Map([
      [YOU, { id: YOU, color: colors[0], tech: { seafaring: 1, warships: 1 } }],
      [ENEMY, { id: ENEMY, color: colors[1], tech: { seafaring: 1, warships: 1 } }],
    ]),
    cityOwner: new Int16Array(n).fill(NEUTRAL),
    cityHp: new Float32Array(n).fill(CITY.hp),
    cityUpgrades: new Uint8Array(n),
    territoryVersion: 0, upgradesVersion: 0,
    renderUnits: [], unitById: new Map(), myQueues: new Map(), cargo: new Map(),
    selection: new Set(), selectedCities: new Set(), inspect: null,
    plans: new Map(), landPlans: new Map(), docks: new Map(), marks: null,
    hoverRegion: -1, hoverCity: -1, brush: null, mapEdit: false, debug: null,
    guideStep: 0, guideHighlight: false, traditions: new Set(),
    effects: { shots: [], sparks: [], deaths: [], markers: [], flashes: [], regions: [], pings: [], blasts: [], projectiles: [] },
    viewTime: 0,
    cam: { ...cam },
    formView: null,
  });
  w.input = {
    hoverCity: -1, hoverShip: -1, cityDrag: null, drag: null, showRanges: false, targetMode: null,
    mouse: { x: 0, y: 0, inside: false }, formationView: () => w.formView,
  };
  return w;
}

// ------------------------------------------------------------------ simulation
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

class Sim {
  constructor(world) {
    this.w = world;
    this.units = [];
    this.nextId = 1;
    this.time = 0;            // seconds
    this.cityShotAt = new Map();
  }

  get nowMs() { return this.time * 1000; }

  add(type, owner, x, y, opts = {}) {
    const def = UNITS[type];
    const t = UNIT_TYPES.indexOf(type);
    const u = {
      id: this.nextId++, t, type, def, owner, x, y, dx: x, dy: y, vx: 0, hp: def.hp * (opts.hp ?? 1), flags: 0, tgt: 0,
      order: null, queue: [], lastFight: -99, cool: Math.random() * 0.5, heroKind: null,
    };
    if (opts.heroKind) this.makeHero(u, opts.heroKind);
    if (opts.cargo) this.setCargo(u, opts.cargo);
    this.units.push(u);
    this.w.unitById.set(u.id, u);
    return u;
  }

  makeHero(u, kind) {
    const share = u.hp / u.def.hp;
    u.heroKind = kind;
    u.type = 'hero';
    u.def = UNITS.hero;
    u.t = UNIT_TYPES.indexOf('hero');
    u.hp = u.def.hp * share;
    u.flags = (u.flags & ~(3 << HERO_KIND_SHIFT)) | (HERO_KINDS.indexOf(kind) << HERO_KIND_SHIFT);
  }

  makeHealer(u) {
    const share = u.hp / u.def.hp;
    u.type = 'healer';
    u.def = UNITS.healer;
    u.t = UNIT_TYPES.indexOf('healer');
    u.hp = u.def.hp * share;
  }

  setCargo(u, n) {
    u.cargoCount = n;
    u.flags = (u.flags & ((1 << CARGO_SHIFT) - 1)) | (n << CARGO_SHIFT);
  }

  remove(u, died = true) {
    const i = this.units.indexOf(u);
    if (i < 0) return;
    this.units.splice(i, 1);
    this.w.unitById.delete(u.id);
    this.w.selection.delete(u.id);
    this.w.plans.delete(u.id);
    if (died) this.w.effects.deaths.push({ x: u.x, y: u.y, color: this.w.colorOf(u.owner), t0: this.nowMs });
    for (const v of this.units) if (v.order?.unit === u) this.nextOrder(v);
  }

  // Orders. `units` share one formation round (x, y), as a group move in the game.
  orderGroup(units, kind, x, y, { facing = null, width = null, queue = false } = {}) {
    const land = units.filter((u) => !u.def.naval), ships = units.filter((u) => u.def.naval);
    for (const [list, spacing] of [[land, undefined], [ships, SHIP_SPACING]]) {
      if (!list.length) continue;
      const slots = formationSlots(list, x, y, {
        facing, width, pos: (u) => [u.x, u.y], role: (u) => formationRole(u.type, u.heroKind), ...(spacing ? { spacing } : {}),
      });
      for (const u of list) {
        const [sx, sy] = slots.get(u);
        this.give(u, { k: kind, x: sx, y: sy }, queue);
      }
    }
  }

  orderAttack(units, target, queue = false) {
    for (const u of units) this.give(u, { k: 'attack', ...target }, queue);
  }

  give(u, order, queue) {
    if (!queue) {
      u.queue = [];
      u.order = order;
      u.flags &= ~FLAG.hold;
    } else if (u.order) u.queue.push(order);
    else u.order = order;
    this.updatePlan(u);
  }

  stop(units) {
    for (const u of units) { u.order = null; u.queue = []; u.flags &= ~FLAG.hold; this.updatePlan(u); }
  }

  hold(units) {
    for (const u of units) { u.order = null; u.queue = []; u.flags |= FLAG.hold; this.updatePlan(u); }
  }

  disband(units) {
    for (const u of units) u.flags |= FLAG.disband;
  }

  nextOrder(u) {
    u.order = u.queue.shift() || null;
    this.updatePlan(u);
  }

  // The dashed route of a unit's queued orders (render.js drawPlans), as the game shows it while selected.
  updatePlan(u) {
    const all = [u.order, ...u.queue].filter(Boolean);
    if (all.length < 2) { this.w.plans.delete(u.id); return; }
    const pts = [];
    for (const o of all) {
      const [x, y] = this.orderPos(o) || [u.x, u.y];
      pts.push(o.k === 'amove' ? 1 : o.k === 'attack' ? 2 : 0, x, y);
    }
    this.w.plans.set(u.id, pts);
  }

  orderPos(o) {
    if (o.unit) return [o.unit.x, o.unit.y];
    if (o.city !== undefined) { const c = this.w.map.cities[o.city]; return [c.x, c.y]; }
    return [o.x, o.y];
  }

  hostile(a, b) { return a !== b; }

  // ---------------------------------------------------------------- one step
  step(dt) {
    this.time += dt;
    this.w.viewTime = this.time;
    const w = this.w;

    for (const u of this.units) this.think(u, dt);
    this.separate();
    this.cities(dt);
    this.train(dt);
    this.heal(dt);
    this.projectiles();

    for (const u of [...this.units]) {
      if (u.flags & FLAG.disband) u.hp -= DISBAND.hpPerSecond * dt;
      else this.regen(u, dt);
      if (u.hp <= 0) this.remove(u);
      u.dx = u.x; u.dy = u.y;
    }
    w.renderUnits = this.units;

    // Old effects go.
    const now = this.nowMs, fx = w.effects;
    for (const k of ['shots', 'sparks', 'deaths', 'markers', 'flashes', 'regions', 'blasts']) {
      fx[k] = fx[k].filter((e) => now - e.t0 < (k === 'regions' ? 4500 : 2000));
    }
  }

  // HP back once out of a fight for a while. A ship in harbour (near the pier of one of its owner's coastal
  // cities) mends much faster, and shows its crew at work (FLAG.repair: render.js drawRepair).
  regen(u, dt) {
    u.flags &= ~FLAG.repair;
    if (this.time - u.lastFight <= COMBAT.regenDelay || u.hp >= u.def.hp) return;
    let rate = u.def.hpRegen || 0;
    if (u.def.naval) {
      for (const [ci, p] of this.w.ports) {
        if (this.w.cityOwner[ci] !== u.owner || dist(u.x, u.y, p.x, p.y) > NAVAL.harbourRange) continue;
        rate = u.def.harbourFactor ? u.def.hpRegen * u.def.harbourFactor : NAVAL.harbourRegen;
        u.flags |= FLAG.repair;
        break;
      }
    }
    u.hp = Math.min(u.def.hp, u.hp + rate * dt);
  }

  // What a unit does this step: its order, or what it finds to fight.
  think(u, dt) {
    const o = u.order;
    const hold = u.flags & FLAG.hold;
    let target = null;
    if (o?.k === 'attack') target = o.unit ? (this.units.includes(o.unit) ? { unit: o.unit } : null) : { city: o.city };
    else if (!o || o.k === 'amove' || hold) target = this.acquire(u, hold ? 'reach' : 'sight');
    if (o?.k === 'attack' && !target) { this.nextOrder(u); return; }
    if (o?.k === 'attack' && o.city !== undefined && !this.hostile(u.owner, this.w.cityOwner[o.city])) { this.nextOrder(u); return; }

    if (target) {
      const [tx, ty, tr] = this.targetGeom(target);
      const reach = (u.def.attackRange || u.def.size + COMBAT.meleeReach) + tr;
      const d = dist(u.x, u.y, tx, ty);
      if (d > reach) {
        if (!hold) this.walk(u, tx, ty, dt, d - reach + 1);
        return;
      }
      u.vx = 0;
      this.hit(u, target, dt, tx, ty);
      return;
    }
    if (!o) { u.vx = 0; return; }
    const d = dist(u.x, u.y, o.x, o.y);
    if (d < 1.5) { u.vx = 0; this.nextOrder(u); return; }
    this.walk(u, o.x, o.y, dt, d);
  }

  walk(u, tx, ty, dt, maxStep) {
    const d = dist(u.x, u.y, tx, ty) || 1;
    const step = Math.min(maxStep, u.def.moveSpeed * dt);
    const vx = ((tx - u.x) / d) * step, vy = ((ty - u.y) / d) * step;
    u.x += vx; u.y += vy;
    u.vx = vx / dt;
  }

  targetGeom(t) {
    if (t.unit) return [t.unit.x, t.unit.y, t.unit.def.size];
    const c = this.w.map.cities[t.city];
    return [c.x, c.y, CITY.size];
  }

  // The nearest enemy unit in sight (or within reach, on hold); with none, an enemy city in sight.
  acquire(u, how) {
    if (u.def.damage <= 0) return null;
    const range = how === 'reach' ? (u.def.attackRange || u.def.size + COMBAT.meleeReach) : COMBAT.visionRange;
    let best = null, bd = Infinity;
    for (const v of this.units) {
      if (!this.hostile(u.owner, v.owner)) continue;
      if (v.def.naval && !u.def.attackRange) continue;                // melee can't reach ships
      if (u.def.naval && !v.def.naval && u.type === 'transport') continue;
      const d = dist(u.x, u.y, v.x, v.y) - (how === 'reach' ? v.def.size : 0);
      if (d <= range && d < bd) { bd = d; best = v; }
    }
    if (best) return { unit: best };
    if (how === 'reach' || u.def.naval) return null;
    // Only the cities the scene is about: the others are scenery (they neither shoot nor get attacked).
    const cities = this.w.map.cities;
    for (const i of this.activeCities) {
      if (!this.hostile(u.owner, this.w.cityOwner[i])) continue;
      const d = dist(u.x, u.y, cities[i].x, cities[i].y);
      if (d <= COMBAT.visionRange && d < bd) { bd = d; best = { city: i }; }
    }
    return best;
  }

  aura(u) {
    for (const v of this.units) {
      if (v.owner === u.owner && v.type === 'hero' && dist(u.x, u.y, v.x, v.y) <= HERO.auraRadius) return 1 + HERO.auraBonus;
    }
    return 1;
  }

  hit(u, target, dt, tx, ty) {
    u.lastFight = this.time;
    const dmg = u.def.damage * this.aura(u);
    const fx = this.w.effects, now = this.nowMs;
    if (u.type === 'battleship') {              // a bolt every `reload` seconds, landing later (projectiles())
      u.cool -= dt;
      if (u.cool > 0) return;
      u.cool = u.def.reload || 1.5;
      if (!target.unit) return;
      const d = dist(u.x, u.y, tx, ty);
      fx.projectiles.push({
        fired: true, homing: true, tgt: target.unit.id, x0: u.x, y0: u.y, x1: tx, y1: ty,
        t0: this.time, t1: this.time + d / (u.def.boltSpeed || 110), dmg, owner: u.owner,
      });
      return;
    }
    if (target.unit) {
      target.unit.hp -= dmg * dt;
      target.unit.lastFight = this.time;
    } else {
      const ci = target.city;
      this.w.cityHp[ci] -= dmg * dt;
      if (this.w.cityHp[ci] <= 0) this.capture(ci, u.owner);
    }
    u.cool -= dt;
    if (u.cool > 0) return;
    if (u.def.attackRange) {
      u.cool = 0.8 + Math.random() * 0.3;
      const d = dist(u.x, u.y, tx, ty);
      fx.shots.push({ x0: u.x, y0: u.y, x1: tx + (Math.random() - 0.5) * 6, y1: ty, t0: now, dur: Math.max(120, d * 6), arc: d * 0.18, city: false });
    } else {
      u.cool = 0.3 + Math.random() * 0.25;
      fx.sparks.push({ x: (u.x + tx) / 2 + (Math.random() - 0.5) * 4, y: (u.y + ty) / 2 + (Math.random() - 0.5) * 4, t0: now, rot: Math.random() * 3 });
    }
  }

  projectiles() {
    const fx = this.w.effects;
    fx.projectiles = fx.projectiles.filter((p) => {
      if (this.time < p.t1) return true;
      const t = this.w.unitById.get(p.tgt);
      if (t) {
        t.hp -= p.dmg;
        t.lastFight = this.time;
        fx.sparks.push({ x: t.x, y: t.y, t0: this.nowMs, rot: Math.random() * 3 });
      }
      return false;
    });
  }

  capture(ci, owner) {
    const w = this.w;
    w.cityOwner[ci] = owner;
    w.cityHp[ci] = CITY.captureHp;
    w.cityUpgrades[ci] = 0;
    w.upgradesVersion++;
    w.territoryVersion++;
    w.myQueues.delete(ci);
    w.effects.flashes.push({ city: ci, color: w.colorOf(owner), t0: this.nowMs });
    // The region's last city: the region lights up (render.js REGION_GLOW), its cities now pay more.
    const region = w.map.cities[ci].c, ids = w.regionCities[region] || [];
    if (ids.length && ids.every((i) => w.cityOwner[i] === owner)) w.effects.regions.push({ region, city: ci, t0: this.nowMs });
    for (const u of this.units) if (u.order?.k === 'attack' && u.order.city === ci) this.nextOrder(u);
  }

  // Cities shoot the nearest enemy in range (neutral ones everybody) and win back HP.
  cities(dt) {
    const w = this.w, cities = w.map.cities;
    for (const ci of this.activeCities) {
      const c = cities[ci], owner = w.cityOwner[ci];
      w.cityHp[ci] = Math.min(w.cityMaxHp(ci), w.cityHp[ci] + CITY.hpRegen * dt);
      let best = null, bd = Infinity;
      const range = w.cityRange(ci);
      for (const u of this.units) {
        if (!this.hostile(owner, u.owner)) continue;
        const d = dist(c.x, c.y, u.x, u.y) - u.def.size;
        if (d <= range && d < bd) { bd = d; best = u; }
      }
      if (!best) continue;
      best.hp -= w.cityDamage(ci) * dt;
      best.lastFight = this.time;
      const last = this.cityShotAt.get(ci) ?? -1;
      if (this.time - last > 0.7) {
        this.cityShotAt.set(ci, this.time);
        const d = dist(c.x, c.y, best.x, best.y);
        w.effects.shots.push({ x0: c.x, y0: c.y - 6, x1: best.x, y1: best.y, t0: this.nowMs, dur: Math.max(140, d * 5), arc: d * 0.25, city: true });
      }
    }
  }

  // Your cities' queues: an entry is done after its build time (units faster with Barracks), then the
  // unit steps out (to its rally point, if any) or the upgrade shows on the castle.
  train(dt) {
    const w = this.w;
    for (const [ci, q] of w.myQueues) {
      if (!q.queue.length) continue;
      const item = PRODUCTION_ITEMS[q.queue[0]];
      const unit = UNITS[item];
      const def = unit || CITY_UPGRADES[item];
      q.progress += dt * (unit ? w.cityTrainRate(ci) : 1);
      if (q.progress < def.buildTime) continue;
      q.progress = 0;
      q.queue.shift();
      const c = w.map.cities[ci];
      if (unit) {
        const out = q.rally ? Math.atan2(q.rally[1] - c.y, q.rally[0] - c.x) : Math.PI / 2 + (Math.random() - 0.5) * 1.6;
        const u = this.add(item, w.cityOwner[ci], c.x + Math.cos(out) * 16, c.y + Math.sin(out) * 16);
        if (q.rally) this.give(u, { k: 'amove', x: q.rally[0] + (Math.random() - 0.5) * 24, y: q.rally[1] + (Math.random() - 0.5) * 24 }, false);
        this.onSpawn?.(u, ci);
      } else {
        w.cityUpgrades[ci] |= 1 << UPGRADE_TYPES.indexOf(item);     // one bit per upgrade, as the host sends them
        w.upgradesVersion++;
      }
    }
  }

  heal(dt) {
    const healers = this.units.filter((u) => u.type === 'healer');
    if (!healers.length) return;
    for (const u of this.units) {
      if (u.def.naval || u.flags & FLAG.disband || u.hp >= u.def.hp) continue;
      if (healers.some((h) => h.owner === u.owner && dist(h.x, h.y, u.x, u.y) <= HEALER.radius)) {
        u.hp = Math.min(u.def.hp, u.hp + HEALER.hpPerSecond * dt);
      }
    }
  }

  // Units never overlap; units on hold are not pushed aside.
  separate() {
    const list = this.units;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.def.naval !== b.def.naval) continue;
        const min = a.def.size + b.def.size;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d >= min) continue;
        const ux = d > 0.01 ? dx / d : 1, uy = d > 0.01 ? dy / d : 0;
        const push = min - d;
        const ha = a.flags & FLAG.hold, hb = b.flags & FLAG.hold;
        const ka = ha ? 0 : hb ? 1 : 0.5, kb = hb ? 0 : ha ? 1 : 0.5;
        a.x -= ux * push * ka; a.y -= uy * push * ka;
        b.x += ux * push * kb; b.y += uy * push * kb;
      }
    }
  }
}

// ------------------------------------------------------------------ the player
// One demo on one canvas. `env`: { g: the game client, colors: [yours, the enemy's] }.
export class Demo {
  constructor(scene, canvas, env) {
    this.scene = scene;
    this.canvas = canvas;
    this.env = env;
    this.gen = 0;
    this.waiters = [];
    this.anchor = env.g.map.cities.find((c) => c.n === scene.at);
    this.playing = false;
    this.reset();
    if (this.anchor) this.run();
  }

  reset() {
    const s = this.scene, a = this.anchor || { x: 0, y: 0 };
    const cam = { x: a.x + (s.cam?.[0] || 0), y: a.y + (s.cam?.[1] || 0), zoom: s.zoom || 1.7 };
    this.world = makeWorld(this.env.g, this.env.colors, cam);
    this.sim = new Sim(this.world);
    this.sim.activeCities = [];
    if (this.renderer) {
      this.renderer.g = this.world;
      this.renderer.mapKey = '';
      this.renderer.facing.clear();
    } else {
      this.renderer = new DemoRenderer(this.world, this.canvas);
    }
    this.cursor = { x: DEMO_W * 0.62, y: DEMO_H * 0.7, shown: false, down: null, tween: null, ripple: null };
    this.keys = { held: new Set(), taps: [] };
    this.say('');
    this.wheel = 0;
    this.speed = s.speed || 1;
  }

  // The script, over and over: a short pause at the end of each round, then everything starts afresh.
  async run() {
    const gen = this.gen;
    for (;;) {
      try {
        await this.scene.play(this.api());
        await this.wait(2.2);
      } catch (e) {
        if (e !== ABORT) console.error(`help demo ${this.scene.id}:`, e);
        if (e !== ABORT) return;
      }
      if (gen !== this.gen) return;
      this.reset();
    }
  }

  restart() {
    this.gen++;
    for (const w of this.waiters) w.reject(ABORT);
    this.waiters = [];
    this.reset();
    if (this.anchor) this.run();
    this.draw();
  }

  destroy() {
    this.gen++;
    for (const w of this.waiters) w.reject(ABORT);
    this.waiters = [];
  }

  // A frame: the scene's time goes on (at the scene's speed), the script's waits that are over resume.
  tick(dtMs) {
    if (!this.anchor) { this.draw(); return; }
    const dt = Math.min(0.05, dtMs / 1000);
    let left = dt * this.speed;
    while (left > 1e-6) {                      // in small steps, so fast scenes stay exact
      const step = Math.min(left, 1 / 30);
      this.sim.step(step);
      left -= step;
    }
    this.updateCursor();
    const t = this.sim.time;
    const ready = this.waiters.filter((w) => w.done(t));
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
    this.draw();
  }

  draw() {
    if (!this.anchor) {
      const ctx = this.canvas.getContext('2d');
      ctx.fillStyle = '#1f3d58';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    this.renderer.frame(this.sim.nowMs, (ctx) => this.overlay(ctx));
  }

  // ---------------------------------------------------------------- waiting
  until(done) {
    const gen = this.gen;
    return new Promise((resolve, reject) => {
      if (gen !== this.gen) { reject(ABORT); return; }
      this.waiters.push({ done, resolve, reject });
    });
  }

  wait(s) {
    const end = this.sim.time + s * this.speed;
    return this.until((t) => t >= end);
  }

  // ---------------------------------------------------------------- pointer
  screenOf(target) {
    const p = this.worldOf(target);
    return this.renderer.w2s(p[0], p[1]);
  }

  worldOf(target) {
    if (Array.isArray(target)) return target;
    if (typeof target === 'number') {
      const c = this.world.map.cities[target];
      return [c.x, c.y - 4];
    }
    return [target.x, target.y];
  }

  // Glide the pointer to `target` (a place, a unit or a city) in `s` seconds of real time.
  moveTo(target, s = 0.7) {
    const c = this.cursor;
    c.shown = true;
    const to = typeof target === 'function' ? target : () => this.screenOf(target);
    c.tween = { from: [c.x, c.y], to, t0: this.sim.time, dur: s * this.speed };
    return this.until((t) => t >= c.tween.t0 + c.tween.dur);
  }

  updateCursor() {
    const c = this.cursor, tw = c.tween;
    if (!tw) return;
    const k = Math.min(1, (this.sim.time - tw.t0) / Math.max(1e-3, tw.dur));
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const [tx, ty] = tw.to();
    c.x = tw.from[0] + (tx - tw.from[0]) * e;
    c.y = tw.from[1] + (ty - tw.from[1]) * e;
    if (c.drag) {
      c.drag.x1 = c.x; c.drag.y1 = c.y;
    }
  }

  press(button) {
    this.cursor.down = button;
    this.cursor.ripple = { x: this.cursor.x, y: this.cursor.y, t0: this.sim.nowMs, button };
  }

  // ---------------------------------------------------------------- what the scripts use
  api() {
    const d = this, sim = this.sim, w = this.world, a = this.anchor;
    const at = (dx, dy) => [a.x + dx, a.y + dy];
    const own = (u) => u.owner === YOU;
    const selectUnits = (list, add = false) => {
      if (!add) { w.selection.clear(); w.selectedCities.clear(); }
      for (const u of list) w.selection.add(u.id);
      for (const u of sim.units) sim.updatePlan(u);
    };
    const selectedUnits = () => sim.units.filter((u) => w.selection.has(u.id));
    const api = {
      at, sim, world: w,
      YOU, ENEMY, NEUTRAL,
      say: (text) => d.say(text),
      wait: (s) => d.wait(s),
      until: (fn) => d.until(() => fn()),
      speed: (k) => { d.speed = k; },

      // Set-up.
      city(name) { return w.map.cities.findIndex((c) => c.n === name); },
      own(ci, who) {
        if (ci < 0) return ci;
        w.cityOwner[ci] = WHO[who] ?? who;
        w.territoryVersion++;
        if (!sim.activeCities.includes(ci)) sim.activeCities.push(ci);
        return ci;
      },
      // Cities that take part (they shoot, regenerate): the ones `own` was called for, and these.
      active(...cis) { for (const ci of cis) if (ci >= 0 && !sim.activeCities.includes(ci)) sim.activeCities.push(ci); },
      upgrades(ci, ...keys) {
        for (const k of keys) w.cityUpgrades[ci] |= 1 << UPGRADE_TYPES.indexOf(k);
        w.upgradesVersion++;
      },
      unit(type, who, dx, dy, opts) { return sim.add(type, WHO[who] ?? who, a.x + dx, a.y + dy, opts); },
      units(type, who, offsets, opts) { return offsets.map(([dx, dy]) => sim.add(type, WHO[who] ?? who, a.x + dx, a.y + dy, opts)); },
      // A block of `n` units `cols` wide round (dx, dy), `gap` km apart.
      block(type, who, n, dx, dy, cols = 3, gap = 15, opts) {
        const out = [];
        for (let i = 0; i < n; i++) {
          const r = Math.floor(i / cols), c = i % cols;
          const rowLen = Math.min(cols, n - r * cols);
          out.push(sim.add(type, WHO[who] ?? who, a.x + dx + (c - (rowLen - 1) / 2) * gap, a.y + dy + r * gap, opts));
        }
        return out;
      },
      select: selectUnits,
      selectCities(cis) { w.selection.clear(); w.selectedCities = new Set(cis); },
      order: (units, kind, p, opts) => sim.orderGroup(units, kind, p[0], p[1], opts),
      attack: (units, target) => sim.orderAttack(units, typeof target === 'number' ? { city: target } : { unit: target }),
      alive: (u) => sim.units.includes(u),
      // Where land meets sea on the way from `land` to `sea` (both world points): the shore point.
      shore(land, sea) {
        let lo = land, hi = sea;
        for (let i = 0; i < 24; i++) {
          const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
          if (d.renderer.isLand(mid[0], mid[1])) lo = mid; else hi = mid;
        }
        return lo;
      },
      isLand: (p) => d.renderer.isLand(p[0], p[1]),
      camTo(dx, dy, zoom, s) {
        const c = w.cam, from = { ...c }, to = { x: a.x + dx, y: a.y + dy, zoom: zoom ?? c.zoom };
        const t0 = sim.time, dur = s * d.speed;
        const step = () => {
          const k = Math.min(1, (sim.time - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          c.x = from.x + (to.x - from.x) * e;
          c.y = from.y + (to.y - from.y) * e;
          c.zoom = from.zoom * (to.zoom / from.zoom) ** e;
          return k >= 1;
        };
        return d.until(step);
      },

      // The pointer and the keyboard, doing what they do in the game.
      hover: (target, s) => d.moveTo(target, s),
      hide() { d.cursor.shown = false; },
      async key(name) {
        d.keys.taps.push({ name, t0: sim.nowMs });
        await d.wait(0.35);
      },
      keyDown(name) {
        d.keys.held.add(name);
        if (name === 'Alt') w.input.showRanges = true;
      },
      keyUp(name) {
        d.keys.held.delete(name);
        if (name === 'Alt') w.input.showRanges = false;
      },
      wheel(dir) { d.wheel = dir; d.wheelAt = sim.nowMs; },

      // Left click: a unit of yours selects it (Shift adds or removes it), one of your cities selects the
      // city, anything else shows it (red ring) or, on empty ground, clears the selection.
      async click(target, { s = 0.6 } = {}) {
        await d.moveTo(target, s);
        d.press('left');
        await d.wait(0.12);
        d.cursor.down = null;
        const shift = d.keys.held.has('Shift');
        if (typeof target === 'number') {
          if (w.cityOwner[target] === YOU) {
            w.selection.clear();
            if (!shift) w.selectedCities.clear();
            w.selectedCities.add(target);
            w.inspect = null;
          } else { w.selection.clear(); w.selectedCities.clear(); w.inspect = { k: 'c', id: target }; }
        } else if (Array.isArray(target)) {
          if (!shift) { w.selection.clear(); w.selectedCities.clear(); }
          w.inspect = null;
        } else if (own(target)) {
          w.selectedCities.clear();
          if (shift && w.selection.has(target.id)) w.selection.delete(target.id);
          else selectUnits([target], shift);
          w.inspect = null;
        } else { w.inspect = { k: 'u', id: target.id }; }
        await d.wait(0.25);
      },

      // Double click on a unit of yours: every unit of its type on screen.
      async dblclick(target) {
        await d.moveTo(target, 0.6);
        for (let k = 0; k < 2; k++) {
          d.press('left');
          await d.wait(0.08);
          d.cursor.down = null;
          await d.wait(0.08);
        }
        const r = d.renderer;
        selectUnits(sim.units.filter((u) => own(u) && u.type === target.type && r.onScreen(...r.w2s(u.x, u.y), 0)));
        await d.wait(0.3);
      },

      // Drag a frame: your units inside it are selected; with none, your cities inside it (Alt: cities only).
      async box(p0, p1, { s = 0.9 } = {}) {
        await d.moveTo(p0, 0.6);
        d.press('left');
        const [x0, y0] = d.screenOf(p0);
        d.cursor.drag = { active: true, x0, y0, x1: x0, y1: y0 };
        w.input.drag = d.cursor.drag;
        await d.moveTo(p1, s);
        const r = d.cursor.drag;
        const inside = (wx, wy) => {
          const [sx, sy] = d.renderer.w2s(wx, wy);
          return sx >= Math.min(r.x0, r.x1) && sx <= Math.max(r.x0, r.x1) && sy >= Math.min(r.y0, r.y1) && sy <= Math.max(r.y0, r.y1);
        };
        d.cursor.drag = null;
        w.input.drag = null;
        d.cursor.down = null;
        const shift = d.keys.held.has('Shift'), alt = d.keys.held.has('Alt');
        const units = alt ? [] : sim.units.filter((u) => own(u) && inside(u.x, u.y));
        if (units.length) selectUnits(units, shift);
        else {
          const cities = w.map.cities.map((c, i) => i).filter((i) => w.cityOwner[i] === YOU && inside(w.map.cities[i].x, w.map.cities[i].y));
          if (!shift) w.selectedCities.clear();
          if (cities.length) { w.selection.clear(); for (const ci of cities) w.selectedCities.add(ci); }
        }
        await d.wait(0.25);
      },

      // Right click: with units selected, a move (A held: attack-move) to a place, or an attack on an enemy
      // unit or city; Shift queues it. With only cities selected: their rally point.
      async right(target, { s = 0.6 } = {}) {
        await d.moveTo(target, s);
        d.press('right');
        await d.wait(0.12);
        d.cursor.down = null;
        const shift = d.keys.held.has('Shift'), amove = d.keys.held.has('A');
        const units = selectedUnits();
        const [x, y] = d.worldOf(target);
        const fx = w.effects;
        const enemyCity = typeof target === 'number' && w.cityOwner[target] !== YOU;
        const enemyUnit = !Array.isArray(target) && typeof target === 'object' && target.owner !== YOU;
        if (units.length) {
          if (enemyUnit || (enemyCity && !amove)) {
            fx.markers.push({ x, y, color: MARKER.attack, t0: sim.nowMs });
            sim.orderAttack(units, enemyUnit ? { unit: target } : { city: target }, shift);
          } else if (enemyCity) {
            fx.markers.push({ x, y, color: MARKER.amove, t0: sim.nowMs });
            sim.orderAttack(units, { city: target }, shift);
          } else {
            fx.markers.push({ x, y, color: amove ? MARKER.amove : MARKER.move, t0: sim.nowMs });
            sim.orderGroup(units, amove ? 'amove' : 'move', x, y, { queue: shift });
          }
        } else if (w.selectedCities.size && d.keys.held.has('Alt')) {     // Alt + right click: no rally point
          for (const ci of w.selectedCities) { const q = w.myQueues.get(ci); if (q) q.rally = null; }
        } else if (w.selectedCities.size) {
          fx.markers.push({ x, y, color: MARKER.move, t0: sim.nowMs });
          for (const ci of w.selectedCities) {
            const q = w.myQueues.get(ci) || { progress: 0, queue: [], rally: null, seaRally: null, honorPaid: [] };
            q.rally = [x, y];
            w.myQueues.set(ci, q);
          }
        }
        await d.wait(0.2);
      },

      // Hold the right button and drag: grey ghosts where each unit will stand, the formation facing the way
      // of the drag and twice as wide as the drag is long; letting go gives the move.
      async rightDrag(p0, p1, { s = 1.1 } = {}) {
        const units = selectedUnits();
        await d.moveTo(p0, 0.6);
        d.press('right');
        const [x0, y0] = d.worldOf(p0);
        const view = () => {
          const [sx, sy] = [d.cursor.x, d.cursor.y];
          const [wx, wy] = d.renderer.s2w(sx, sy);
          // As input.js: dragged far enough, the formation faces the way of the drag, twice as wide as it is long.
          const far = Math.hypot(sx - d.renderer.w2s(x0, y0)[0], sy - d.renderer.w2s(x0, y0)[1]) > 8;
          const facing = far ? Math.atan2(wy - y0, wx - x0) : null;
          const width = far ? 2 * Math.hypot(wx - x0, wy - y0) : null;
          const slots = formationSlots(units, x0, y0, {
            facing, width, pos: (u) => [u.x, u.y], role: (u) => formationRole(u.type, u.heroKind),
          });
          return { places: units.map((u) => ({ u, x: slots.get(u)[0], y: slots.get(u)[1] })), x: x0, y: y0, facing, amove: d.keys.held.has('A'), cursor: { x: sx, y: sy }, slots };
        };
        w.formView = view();
        const tracker = () => { w.formView = view(); return false; };
        d.waiters.push({ done: tracker, resolve() {}, reject() {} });
        await d.wait(0.35);
        await d.moveTo(p1, s);
        await d.wait(0.4);
        const v = view();
        d.waiters = d.waiters.filter((x) => x.done !== tracker);
        w.formView = null;
        d.cursor.down = null;
        w.effects.markers.push({ x: x0, y: y0, color: v.amove ? MARKER.amove : MARKER.move, t0: sim.nowMs });
        for (const u of units) {
          const [sx, sy] = v.slots.get(u);
          sim.give(u, { k: v.amove ? 'amove' : 'move', x: sx, y: sy }, false);
        }
        await d.wait(0.2);
      },

      // Orders from the keyboard for the selected units.
      async stop() { await api.key('S'); sim.stop(selectedUnits()); },
      async hold() { await api.key('H'); sim.hold(selectedUnits()); },
      async disband() { await api.key('Delete'); sim.disband(selectedUnits()); },
      selected: selectedUnits,

      // Train in the selected cities (the unit's key, or an upgrade's): one in each, as in the game.
      // C with cities selected: the last entry of each queue goes (its gold back).
      async cancel() {
        await api.key('C');
        for (const ci of w.selectedCities) w.myQueues.get(ci)?.queue.pop();
      },
      async build(item) {
        const def = UNITS[item] || CITY_UPGRADES[item];
        await api.key(def.hotkey || item);
        for (const ci of w.selectedCities) {
          const q = w.myQueues.get(ci) || { progress: 0, queue: [], rally: null, seaRally: null, honorPaid: [] };
          q.queue.push(PRODUCTION_ITEMS.indexOf(item));
          w.myQueues.set(ci, q);
        }
      },
      onSpawn(fn) { sim.onSpawn = fn; },
    };
    return api;
  }

  // What is being shown, in words: the line under the demo (env.caption, a <figcaption>).
  say(text) {
    this.caption = text;
    if (this.env.caption && this.env.caption.textContent !== text) this.env.caption.textContent = text;
  }

  // ---------------------------------------------------------------- what is drawn over the map
  overlay(ctx) {
    const now = this.sim.nowMs;
    ctx.textAlign = 'left';            // the game's renderer leaves it centred (city names)
    // Keys: the ones held, then the ones just pressed, fading.
    const badges = [...this.keys.held].map((name) => ({ name, alpha: 1, held: true }));
    this.keys.taps = this.keys.taps.filter((k) => now - k.t0 < 900);
    for (const k of this.keys.taps) {
      if (this.keys.held.has(k.name)) continue;
      badges.push({ name: k.name, alpha: 1 - Math.max(0, (now - k.t0 - 400) / 500), held: false, pop: now - k.t0 < 160 });
    }
    let x = 10;
    ctx.save();
    ctx.font = '700 12px system-ui, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const b of badges) {
      const w = Math.max(24, ctx.measureText(b.name).width + 14), y = DEMO_H - 32, h = 22;
      ctx.globalAlpha = b.alpha;
      ctx.fillStyle = b.held || b.pop ? '#c9a24a' : 'rgba(40,30,20,0.92)';
      roundRect(ctx, x, y + (b.pop ? 2 : 0), w, h, 4);
      ctx.fill();
      ctx.strokeStyle = '#e3c06e';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = b.held || b.pop ? '#1d140a' : '#f4ead2';
      ctx.fillText(b.name, x + (w - ctx.measureText(b.name).width) / 2, y + h / 2 + (b.pop ? 2 : 0));
      x += w + 6;
    }
    ctx.restore();
    // The mouse, bottom right: which button is down; the wheel turning.
    this.drawMouse(ctx, DEMO_W - 28, DEMO_H - 40, now);
    // Faster than the game: say so.
    if (this.speed > 1) {
      ctx.save();
      ctx.font = '700 11px system-ui, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(20,15,10,0.75)';
      roundRect(ctx, DEMO_W - 40, DEMO_H - 62, 30, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#e3c06e';
      ctx.textBaseline = 'middle';
      ctx.fillText(`×${this.speed}`, DEMO_W - 35, DEMO_H - 54);
      ctx.restore();
    }
    // A click: a small ring where it landed.
    const r = this.cursor.ripple;
    if (r && now - r.t0 < 400) {
      const k = (now - r.t0) / 400;
      ctx.save();
      ctx.strokeStyle = r.button === 'right' ? `rgba(255,154,60,${1 - k})` : `rgba(255,255,255,${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, 4 + k * 12, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (this.cursor.shown) drawPointer(ctx, this.cursor.x, this.cursor.y);
  }

  drawMouse(ctx, x, y, now) {
    const down = this.cursor.down, w = 18, h = 26;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(20,15,10,0.75)';
    roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 6);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#e8dcc0';
    roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();
    if (down) {
      ctx.fillStyle = '#c9a24a';
      ctx.beginPath();
      if (down === 'left') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + 11); ctx.lineTo(x, y + 11); ctx.arcTo(x, y, x + w / 2, y, 8); }
      else { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + 11); ctx.lineTo(x + w, y + 11); ctx.arcTo(x + w, y, x + w / 2, y, 8); }
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(x, y + 11); ctx.lineTo(x + w, y + 11); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + 11); ctx.stroke();
    const turning = this.wheel && now - (this.wheelAt || 0) < 500;
    ctx.fillStyle = turning ? '#c9a24a' : '#e8dcc0';
    roundRect(ctx, x + w / 2 - 1.5, y + 3, 3, 6, 1.5);
    ctx.fill();
    ctx.restore();
  }
}

// ------------------------------------------------------------------ drawing helpers
function drawPointer(ctx, x, y) {
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.2, 13); ctx.lineTo(7.2, 19.5); ctx.lineTo(10, 18.3);
  ctx.lineTo(7.1, 12); ctx.lineTo(12.5, 12); ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Your colour in the demos, and a different, easily told apart one for the enemy.
export function demoColors(g) {
  const mine = g.players?.get(g.you)?.color || '#4363d8';
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const far = (a, b) => { const p = rgb(a), q = rgb(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 160; };
  const enemy = ['#e6194b', '#4363d8', '#f58231', '#911eb4', '#3cb44b'].find((c) => far(c, mine) && far(c, NEUTRAL_COLOR)) || '#e6194b';
  return [mine, enemy];
}
