// Battleships and the Warships technology: warships whose ballistas shoot ships, troops ashore and cities, one
// shot every `reload` seconds, reloading while they sail (shoot, move, shoot). Their shots fly and do their
// damage when they land; with Gunnery, cannon shells that burst. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as setupGame, nav, map, DT } from './helpers.js';
import { UNITS, TECHS, CITY, NAVAL } from '../shared/config.js';
import { canTrain } from '../shared/tech.js';
import { saveGame, restoreGame } from '../server/save.js';
import { NavGrid } from '../server/nav.js';
import fs from 'node:fs';

const navData = JSON.parse(fs.readFileSync(new URL('../server/data/navgrid.json', import.meta.url), 'utf8'));

const B = UNITS.battleship;

// The two-player game of helpers.js. `techs`: what both players have researched. `grid`: a land grid of
// the test's own.
function setup(techs = { seafaring: 1, warships: 1 }, grid = nav) {
  const ctx = setupGame(grid);
  for (const p of [ctx.a, ctx.b]) p.tech = { ...p.tech, ...techs };
  ctx.order = (p, msg) => { p.commandTokens = 20; ctx.game.handleCommand(p, msg); };
  return ctx;
}

// Open sea west of Lisbon, ~200 km from the nearest city: nothing shoots there.
function openSea(ctx) {
  const lis = ctx.city('Lisbon').port;
  const x = lis.x - 200, y = lis.y;
  assert.ok(nav.seaAt(x, y) > 0 && nav.seaAt(x - 60, y) === nav.seaAt(x, y), 'open sea');
  return [x, y];
}

// A beach on that sea far from every city: [land x, land y, a sea point `off` km straight out from it].
function quietShore(ctx, off) {
  const [sx, sy] = openSea(ctx);
  const sea = nav.seaAt(sx, sy);
  for (let y = sy - 600; y <= sy + 600; y += 10) {
    for (let x = sx; x < sx + 700; x += 2) {
      if (!nav.walkable(x, y)) continue;
      const lx = x + 4;
      const far = ctx.game.cities.every((c) => Math.hypot(c.x - lx, c.y - y) > 150);
      if (far && nav.walkable(lx, y) && nav.seaAt(lx - off, y) === sea && nav.seaClear(lx - off, y, lx - off - 20, y)) {
        return [lx, y, lx - off, y];
      }
      break;                      // the first land on this row is the shore: try the next row
    }
  }
  assert.fail('no quiet shore found');
}

// Times (game seconds, rounded) at which `u` lost HP while `seconds` run.
function hitTimes(ctx, u, seconds) {
  const out = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    const hp = u.hp;
    ctx.game.tick(DT);
    if (u.hp < hp - 1e-9) out.push(Math.round(ctx.game.time * 100) / 100);
  }
  return out;
}

// Times (game seconds, rounded) at which `ship` fired while `seconds` run: each shot reloads it.
function fireTimes(ctx, ship, seconds) {
  const out = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    const ready = ship.readyAt;
    ctx.game.tick(DT);
    if (ship.readyAt !== ready) out.push(Math.round(ctx.game.time * 100) / 100);
  }
  return out;
}

// Seconds a shot from `from` to `to` (anything with x, y) flies at `speed` km/s.
const flight = (from, to, speed) => Math.hypot(to.x - from.x, to.y - from.y) / speed;

test('Warships needs Seafaring first: refused before, queued after it, cancelled with it', () => {
  const { a, order } = setup({});
  a.gold = 1000;
  order(a, { t: 'research', tech: 'warships' });
  assert.equal(a.research, null, 'refused without Seafaring');
  assert.equal(a.gold, 1000);

  order(a, { t: 'research', tech: 'seafaring' });
  order(a, { t: 'research', tech: 'warships' });
  assert.equal(a.research.tech, 'seafaring');
  assert.deepEqual(a.researchQueue.map((e) => e.tech), ['warships'], 'Seafaring on its way is enough to queue it');
  assert.equal(a.gold, 1000 - TECHS.seafaring.levels[0].cost - TECHS.warships.levels[0].cost);

  order(a, { t: 'cancelResearch', tech: 'seafaring', level: 1 });
  assert.equal(a.research, null, 'Warships does not start: it needed Seafaring');
  assert.deepEqual(a.researchQueue, []);
  assert.equal(a.gold, 1000, 'both refunded');
});

test('cancelling a researched Seafaring does nothing to Warships', () => {
  const { a, order } = setup({ seafaring: 1 });
  a.gold = 1000;
  order(a, { t: 'research', tech: 'warships' });
  assert.equal(a.research?.tech, 'warships');
  order(a, { t: 'cancelResearch', tech: 'seafaring', level: 1 });
  assert.equal(a.research?.tech, 'warships', 'still running');
  assert.equal(a.gold, 1000 - TECHS.warships.levels[0].cost);
});

test('battleships need Warships and a coastal city; Seafaring alone builds only transports', () => {
  assert.ok(canTrain('transport', { seafaring: 1 }) && !canTrain('battleship', { seafaring: 1 }));
  assert.ok(canTrain('battleship', { seafaring: 1, warships: 1 }) && canTrain('infantry', {}));

  const s1 = setup({ seafaring: 1 });
  s1.a.gold = 1000;
  s1.order(s1.a, { t: 'build', cities: [s1.city('Lisbon').id], item: 'battleship' });
  assert.deepEqual(s1.city('Lisbon').queue, [], 'no Warships: refused');
  assert.equal(s1.a.gold, 1000);

  const { game, a, city, order, run } = setup();
  const madrid = city('Madrid'), lisbon = city('Lisbon');
  lisbon.addUpgrade('barracks');
  a.gold = 1000;
  order(a, { t: 'build', cities: [madrid.id, lisbon.id], item: 'battleship' });
  assert.deepEqual(madrid.queue, [], 'inland: no ships');
  assert.deepEqual(lisbon.queue, ['battleship']);
  assert.equal(a.gold, 1000 - B.cost);
  run(B.buildTime - 0.5);
  assert.equal(lisbon.queue.length, 1, 'Barracks do not speed ships up');
  run(1);
  const ships = [...game.units.values()].filter((u) => u.type === 'battleship');
  assert.equal(ships.length, 1);
  assert.ok(ships[0].naval && ships[0].armed);
  assert.ok(nav.seaAt(ships[0].x, ships[0].y) > 0, 'launched on the water');
});

test(`a battleship hits ${B.damage} per shot, one shot every ${B.reload} s`, () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  target.hp = 1000;
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  const times = hitTimes(ctx, target, 4);
  assert.equal(times.length, 3);
  assert.ok(Math.abs(times[1] - times[0] - B.reload) < 1e-6 && Math.abs(times[2] - times[1] - B.reload) < 1e-6, `every ${B.reload} s: ${times}`);
  assert.equal(target.hp, 1000 - 3 * B.damage, 'the whole damage in one shot');
});

test('shoot, move, shoot: the guns reload while it sails, and it fires at once when it attacks again', () => {
  const ctx = setup();
  const { a, order } = ctx;
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  target.hp = 1000;
  const attack = () => order(a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });

  attack();
  assert.equal(fireTimes(ctx, ship, DT).length, 1, 'the first shot at once');
  // Sail away and back, the target in reach all the time: a move order doesn't shoot.
  order(a, { t: 'move', ids: [ship.id], x, y: y - 120 });
  assert.equal(fireTimes(ctx, ship, 1).length, 0);
  assert.ok(target.hp < 1000, 'the shot fired before it sailed off still landed');
  order(a, { t: 'move', ids: [ship.id], x, y: y + 120 });
  assert.equal(fireTimes(ctx, ship, 1).length, 0, 'no shots while sailing');
  assert.ok(ship.dist(target) <= ship.reach(target), 'still in reach');
  // Reloaded on the way: the next attack fires on its first tick.
  attack();
  assert.equal(fireTimes(ctx, ship, DT).length, 1, 'fires at once');

  // An attack ordered again halfway through the reload does not start it over.
  const shot = ctx.game.time;
  order(a, { t: 'move', ids: [ship.id], x, y: y - 120 });
  ctx.run(0.5);
  attack();
  const next = fireTimes(ctx, ship, 1.5);
  assert.equal(next.length, 1);
  assert.ok(Math.abs(next[0] - (shot + B.reload)) < DT / 2, `reloaded ${B.reload} s after the last shot: ${next[0]} vs ${shot}`);
});

// Distance a unit starting from rest covers in `t` seconds with the speed rising by moveSpeed / accelTime
// every second, tick by tick as Unit.currentSpeed does (the speed is raised before each step).
function rampDistance(def, t) {
  const a = def.moveSpeed / def.accelTime;
  let v = 0, d = 0;
  for (let k = 0; k < Math.round(t / DT); k++) { v = Math.min(def.moveSpeed, v + a * DT); d += v * DT; }
  return d;
}

test(`a battleship gathers speed from rest: full speed after ${B.accelTime} s`, () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  ctx.order(ctx.a, { t: 'move', ids: [ship.id], x, y: y - 300 });
  ctx.run(B.accelTime);
  const ramp = y - ship.y;
  assert.ok(Math.abs(ramp - rampDistance(B, B.accelTime)) < 0.5, `${ramp} km while gathering speed`);
  assert.ok(ramp < B.moveSpeed * B.accelTime * 0.6, 'well behind a ship at full speed all along');
  assert.ok(Math.abs(ship.speed - B.moveSpeed) < 1e-6, 'at full speed');
  ctx.run(1);
  assert.ok(Math.abs(y - ship.y - ramp - B.moveSpeed) < 0.5, 'then full speed');
});

test('a battleship that stops to shoot starts again from rest; a ship that kept going gets away', () => {
  const ctx = setup();
  const { a, order } = ctx;
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(a.id, 'battleship', x, y);
  const enemy = ctx.spawn(ctx.b.id, 'battleship', x - 40, y);
  const chaser = ctx.spawn(a.id, 'battleship', x + 60, y + 60);     // sailing all along, out of the fight
  order(a, { t: 'move', ids: [chaser.id], x: x + 60, y: y - 300 });
  order(a, { t: 'attack', ids: [ship.id], k: 'u', id: enemy.id });
  ctx.run(2);
  assert.ok(enemy.hp < B.hp, 'it fired');
  assert.equal(ship.speed, 0, 'standing to shoot');
  const [y0, c0] = [ship.y, chaser.y];
  order(a, { t: 'move', ids: [ship.id], x, y: y - 300 });
  ctx.run(1);
  const went = y0 - ship.y, kept = c0 - chaser.y;
  assert.ok(Math.abs(went - rampDistance(B, 1)) < 0.5, `${went} km in its first second`);
  assert.ok(Math.abs(kept - B.moveSpeed) < 0.5, 'the one already sailing: full speed');
  assert.ok(kept - went > B.moveSpeed * 0.3, 'falls behind it');
});

test('other units, transports too, go at full speed at once', () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const t = ctx.spawn(ctx.a.id, 'transport', x, y);
  ctx.order(ctx.a, { t: 'move', ids: [t.id], x, y: y - 300 });
  ctx.game.tick(DT);
  assert.ok(Math.abs(y - t.y - UNITS.transport.moveSpeed * DT) < 1e-6);
});

const NAV = TECHS.navigation;

test('Navigation needs Seafaring first: refused before, queued after it', () => {
  const { a, order } = setup({});
  a.gold = 1000;
  order(a, { t: 'research', tech: 'navigation' });
  assert.equal(a.research, null, 'refused without Seafaring');
  assert.equal(a.gold, 1000);
  order(a, { t: 'research', tech: 'seafaring' });
  order(a, { t: 'research', tech: 'navigation' });
  assert.deepEqual(a.researchQueue.map((e) => e.tech), ['navigation']);
  assert.equal(a.gold, 1000 - TECHS.seafaring.levels[0].cost - NAV.levels[0].cost);
});

test(`Navigation: its owner's ships sail ${NAV.speedPercent}% faster, those at sea too; nobody else's`, () => {
  const ctx = setup();
  const { a, b, order } = ctx;
  const [x, y] = openSea(ctx);
  const f = 1 + NAV.speedPercent / 100, T = UNITS.transport;
  const mine = ctx.spawn(a.id, 'transport', x, y);
  const theirs = ctx.spawn(b.id, 'transport', x + 40, y);
  order(a, { t: 'move', ids: [mine.id], x, y: y - 300 });
  order(b, { t: 'move', ids: [theirs.id], x: x + 40, y: y - 300 });
  // How far each sails in one tick.
  const tick = () => {
    const [m, t] = [mine.y, theirs.y];
    ctx.game.tick(DT);
    return [m - mine.y, t - theirs.y];
  };
  let [m, t] = tick();
  assert.ok(Math.abs(m - T.moveSpeed * DT) < 1e-6 && Math.abs(t - T.moveSpeed * DT) < 1e-6, 'without it: moveSpeed');

  a.tech = { ...a.tech, navigation: 1 };       // researched while it sails
  [m, t] = tick();
  assert.ok(Math.abs(m - T.moveSpeed * f * DT) < 1e-6, `${m} km per tick: ${NAV.speedPercent}% faster at once`);
  assert.ok(Math.abs(t - T.moveSpeed * DT) < 1e-6, "the other player's: as fast as before");

  const knight = ctx.spawn(a.id, 'knight', ctx.city('Madrid').x, ctx.city('Madrid').y);
  assert.equal(knight.moveSpeed, UNITS.knight.moveSpeed, 'land units: as fast as before');
});

test(`Navigation: a battleship still gathers speed for ${B.accelTime} s, up to a higher full speed`, () => {
  const ctx = setup({ seafaring: 1, warships: 1, navigation: 1 });
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const fast = { ...B, moveSpeed: B.moveSpeed * (1 + NAV.speedPercent / 100) };
  ctx.order(ctx.a, { t: 'move', ids: [ship.id], x, y: y - 300 });
  ctx.run(B.accelTime);
  assert.ok(Math.abs(y - ship.y - rampDistance(fast, B.accelTime)) < 0.5, `${y - ship.y} km while gathering speed`);
  assert.ok(Math.abs(ship.speed - fast.moveSpeed) < 1e-6, `full speed ${ship.speed}`);
});

test('a save from before Navigation existed: not researched, and it can be', () => {
  const ctx = setup();
  const save = JSON.parse(JSON.stringify(saveGame(ctx.game)));
  for (const p of save.players) delete p.tech.navigation;
  const copy = restoreGame(save, { map, nav, hostId: 0 });
  const p = copy.players.get(ctx.a.id);
  assert.equal(p.tech.navigation, 0);
  p.gold = 1000;
  copy.startResearch(p, 'navigation');
  assert.equal(p.research?.tech, 'navigation');
});

test(`in harbour a battleship repairs ${B.harbourFactor} times its regeneration; a transport at NAVAL.harbourRegen`, () => {
  const ctx = setup();
  const port = ctx.city('Lisbon').port;                  // A's city
  const ship = ctx.spawn(ctx.a.id, 'battleship', port.x, port.y);
  const boat = ctx.spawn(ctx.a.id, 'transport', port.x + 6, port.y);
  ship.hp = 100;
  boat.hp = 50;
  ctx.run(2);
  assert.ok(Math.abs(ship.hp - (100 + 2 * B.hpRegen * B.harbourFactor)) < 1e-6, `battleship: ${ship.hp}`);
  assert.ok(Math.abs(boat.hp - (50 + 2 * NAVAL.harbourRegen)) < 1e-6, `transport: ${boat.hp}`);

  const saved = B.hpRegen;
  B.hpRegen = 3;                                         // a balance change: the harbour rate follows it
  try {
    ctx.run(1);
    assert.ok(Math.abs(ship.hp - (100 + 2 * saved * B.harbourFactor + 3 * B.harbourFactor)) < 1e-6);
  } finally {
    B.hpRegen = saved;
  }

  const [x, y] = openSea(ctx);
  const far = ctx.spawn(ctx.a.id, 'battleship', x, y);
  far.hp = 100;
  ctx.run(2);
  assert.ok(Math.abs(far.hp - (100 + 2 * B.hpRegen)) < 1e-6, 'at sea: its own regeneration');
});

test(`harbour: within ${NAVAL.harbourRange} km of the pier; snapshots flag a ship under repair there (16), not at sea`, () => {
  const ctx = setup();
  const { game, a } = ctx;
  const port = ctx.city('Lisbon').port;                  // A's city
  const sea = (x, y) => nav.seaAt(x, y) === port.sea;
  // Water a little inside the harbour's edge and a little outside it, on the same line out from the pier.
  let inside = null, outside = null;
  for (let k = 0; k < 16 && !(inside && outside); k++) {
    const ang = (k / 16) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
    const i = [port.x + c * (NAVAL.harbourRange - 5), port.y + s * (NAVAL.harbourRange - 5)];
    const o = [port.x + c * (NAVAL.harbourRange + 5), port.y + s * (NAVAL.harbourRange + 5)];
    if (sea(...i) && sea(...o)) { inside = i; outside = o; }
  }
  assert.ok(inside, 'open water round the pier');
  const near = ctx.spawn(a.id, 'transport', ...inside);
  const away = ctx.spawn(a.id, 'transport', ...outside);
  const full = ctx.spawn(a.id, 'transport', inside[0], inside[1] + 0.1);
  near.hp = away.hp = 50;
  ctx.run(1);
  assert.ok(Math.abs(near.hp - (50 + NAVAL.harbourRegen)) < 1e-6, `in harbour: ${near.hp}`);
  assert.ok(Math.abs(away.hp - (50 + UNITS.transport.hpRegen)) < 1e-6, `outside: ${away.hp}`);

  const snaps = [];
  a.client = { send: (m) => { if (m.t === 'snap') snaps.push(m); } };
  a.view = { x0: port.x - 200, y0: port.y - 200, x1: port.x + 200, y1: port.y + 200 };
  const flagsOf = (u) => { const s = snaps.at(-1), i = s.u.indexOf(u.id); return s.u[i + 6]; };
  game.sendSnapshots();
  assert.equal(flagsOf(near) & 16, 16, 'repairing in harbour');
  assert.equal(flagsOf(away) & 16, 0, 'mending at sea, slowly: not shown');
  assert.equal(flagsOf(full) & 16, 0, 'nothing to repair');
  near.receiveDamage(1, { id: 0, owner: ctx.b.id, isCity: false });
  game.tick(DT);
  game.sendSnapshots();
  assert.equal(flagsOf(near) & 16, 0, 'just hit: no repairs');
});

test('attack-move: battleships fight what they meet on the way; transports just sail', () => {
  const ctx = setup();
  const { a, order } = ctx;
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(a.id, 'battleship', x, y);
  const transport = ctx.spawn(a.id, 'transport', x + 30, y);
  const enemy = ctx.spawn(ctx.b.id, 'transport', x - 40, y - 30);
  order(a, { t: 'move', ids: [ship.id, transport.id], x, y: y - 150, amove: true });
  assert.equal(ship.order.kind, 'amove');
  assert.equal(transport.order.kind, 'move');
  ctx.run(0.2);
  assert.ok(ship.attacking, 'firing on the way');
  ctx.run(0.6);
  assert.ok(enemy.hp < UNITS.transport.hp, 'hit once its bolt landed');

  order(a, { t: 'attack', ids: [transport.id], k: 'u', id: enemy.id });
  assert.notEqual(transport.order.kind, 'attack', 'a transport has no guns');
});

test('a battleship shells troops ashore within range; melee troops cannot hit back', () => {
  const ctx = setup();
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(ctx.a.id, 'battleship', sx, sy);
  const foot = ctx.spawn(ctx.b.id, 'infantry', lx, ly);
  const killsBefore = ctx.a.kills;
  ctx.run(Math.ceil(UNITS.infantry.hp / B.damage) * B.reload);     // idle: it picks the target itself
  assert.ok(!ctx.game.units.has(foot.id), 'the infantry fell');
  assert.equal(ctx.a.kills, killsBefore + UNITS.infantry.cost);
  assert.equal(ship.hp, B.hp, 'untouched');
});

test('an attack on a unit inland sails to the nearest water within range of it', () => {
  const ctx = setup();
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(ctx.a.id, 'battleship', sx - 150, sy);
  const foot = ctx.spawn(ctx.b.id, 'infantry', lx + 20, ly);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: foot.id });
  ctx.run(10);
  assert.ok(foot.hp < UNITS.infantry.hp, 'shelled');
  assert.ok(nav.seaAt(ship.x, ship.y) > 0, 'from the water');
  assert.ok(ship.dist(foot) <= ship.reach(foot));
});

// Mountains on a grid of its own: the land cells within `r` km of the points.
function withMountains(points, r) {
  const g = new NavGrid(navData);
  g.editMountains(points.flatMap(([x, y]) => g.cellsNear(x, y, r)), true);
  return g;
}

test('a battleship does not shoot over mountains: it shells from water with a clear line, or not at all', () => {
  const probe = setup();
  const [lx, ly, sx, sy] = quietShore(probe, 45);
  const tx = lx + 14, ty = ly;
  assert.ok(nav.walkable(tx, ty), 'the target stands on land');
  // A short wall on the shore, between the ship out at sea and the target inland.
  const g = withMountains([[lx + 3, ly - 12], [lx + 3, ly - 6], [lx + 3, ly], [lx + 3, ly + 6], [lx + 3, ly + 12]], 5);
  assert.equal(g.lineOfFire(sx, sy, tx, ty), false);
  const ctx = setup(undefined, g);
  const ship = ctx.spawn(ctx.a.id, 'battleship', sx, sy);
  const foot = ctx.spawn(ctx.b.id, 'infantry', tx, ty);
  assert.ok(ship.dist(foot) <= ship.reach(foot), 'in range');
  ctx.order(ctx.a, { t: 'hold', ids: [ship.id] });
  ctx.run(6);
  assert.equal(foot.hp, foot.maxHp, 'on hold behind the mountains: no shot');
  // Ordered to attack, it sails along the coast to water with a clear line, and every shot flies clear.
  const shots = [];
  const take = foot.receiveDamage.bind(foot);
  foot.receiveDamage = (amount, from) => { shots.push(g.lineOfFire(from.x, from.y, foot.x, foot.y)); take(amount, from); };
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: foot.id });
  ctx.run(25);
  assert.ok(shots.length > 0, 'it found a clear shot');
  assert.ok(shots.every(Boolean), 'never over the mountains');
  assert.ok(nav.seaAt(ship.x, ship.y) > 0, 'from the water');

  // A target farther inland (in range of the sea, but no water within 22 km of it) in a clearing in the
  // mountains: no water anywhere has a clear line, so the order is dropped.
  let ix = 0, iy = 0;
  for (let dx = 20; dx <= 60 && !ix; dx += 5) {
    for (let dy = -60; dy <= 60 && !ix; dy += 10) {
      const x = lx + dx, y = ly + dy;
      if (nav.walkable(x, y) && !nav.nearestSea(x, y, 22) && nav.nearestSea(x, y, 50)) [ix, iy] = [x, y];
    }
  }
  assert.ok(ix, 'inland, the sea farther than the mountains but within range');
  const ringed = withMountains([[ix, iy]], 22);
  ringed.editMountains(ringed.cellsNear(ix, iy, 3), false);
  assert.ok(ringed.walkable(ix, iy) && ringed.mountainAt(ix - 10, iy), 'a clearing in the mountains');
  const shut = setup(undefined, ringed);
  const ship2 = shut.spawn(shut.a.id, 'battleship', sx, sy);
  const foot2 = shut.spawn(shut.b.id, 'infantry', ix, iy);
  assert.ok(ship2.dist(foot2) <= ship2.reach(foot2) + 20, 'not far out of range');
  shut.order(shut.a, { t: 'attack', ids: [ship2.id], k: 'u', id: foot2.id });
  shut.run(4);
  assert.equal(foot2.hp, foot2.maxHp, 'not shelled');
  assert.equal(ship2.order.kind, 'idle', 'nowhere to shell it from: the order is dropped');
});

// Lisbon given to B at full HP, and a battleship of A out at sea 90 km west of its port.
function siege(ctx) {
  const { game, a, b, city } = ctx;
  const lisbon = city('Lisbon');
  lisbon.owner = b.id;
  lisbon.hp = CITY.hp;
  game.recount();
  const ship = ctx.spawn(a.id, 'battleship', lisbon.port.x - 90, lisbon.port.y);
  return { lisbon, ship };
}

test('an inland city in reach of its guns goes down to 1 HP and no further: only troops take it', () => {
  const ctx = setup();
  const { game, a, b, order } = ctx;
  const sea = ctx.city('Lisbon').port.sea;
  // The inland city nearest to the open sea (Arkhangelsk, as the map is now).
  const [inland, spot] = game.cities.filter((c) => !c.port)
    .map((c) => [c, nav.nearestSea(c.x, c.y, B.attackRange + CITY.size - 4, sea)])
    .filter(([, p]) => p)
    .sort(([c, p], [d, q]) => Math.hypot(p[0] - c.x, p[1] - c.y) - Math.hypot(q[0] - d.x, q[1] - d.y))[0];
  inland.owner = b.id;
  inland.hp = CITY.hp;
  game.recount();
  const ship = ctx.spawn(a.id, 'battleship', spot[0], spot[1]);
  order(a, { t: 'attack', ids: [ship.id], k: 'c', id: inland.id });
  ctx.run(Math.ceil(CITY.hp / B.damage) * B.reload + 3);
  assert.equal(inland.owner, b.id, `${inland.name} not taken by a ship`);
  assert.equal(inland.hp, 1, 'held at 1 HP: no regeneration while shelled');

  const [fx, fy] = inland.spawnPoint(UNITS.infantry.size);
  const foot = ctx.spawn(a.id, 'infantry', fx, fy);
  order(a, { t: 'attack', ids: [foot.id], k: 'c', id: inland.id });
  ctx.run(1);
  assert.equal(inland.owner, a.id, 'taken by the infantry');
});

test('a battleship takes a coastal city with its shots, from the water within range of it', () => {
  const ctx = setup();
  const { lisbon, ship } = siege(ctx);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'c', id: lisbon.id });
  let shots = 0;
  for (let t = 0; t < 30 && lisbon.owner !== ctx.a.id; t += DT) {
    const ready = ship.readyAt;
    ctx.game.tick(DT);
    if (ship.readyAt !== ready) shots++;
  }
  assert.equal(lisbon.owner, ctx.a.id, 'captured by the ship');
  assert.ok(lisbon.hp >= CITY.captureHp && lisbon.hp < CITY.captureHp + 1, 'with the HP of a city just taken');
  assert.ok(nav.seaAt(ship.x, ship.y) > 0 && ship.dist(lisbon) <= ship.reach(lisbon), 'fired from the water');
  assert.ok(ctx.game.units.has(ship.id), 'and lived');
  ctx.game.tick(DT);
  assert.equal(ship.order.kind, 'idle', 'the city is its own now: the attack is over');
  // No regeneration between the shots: just enough of them for the city's HP (with it, one more).
  assert.equal(shots, Math.ceil(CITY.hp / B.damage));
});

test('a city does not regenerate between a battleship\'s shots, and does again once it stops', () => {
  const ctx = setup();
  const { lisbon, ship } = siege(ctx);
  ship.x = lisbon.port.x - 50;               // in reach of the city from the start
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'c', id: lisbon.id });
  ctx.game.tick(DT);
  assert.equal(ctx.game.projectiles.list.length, 1, 'fired');
  while (ctx.game.projectiles.list.length) ctx.game.tick(DT);
  const hit = lisbon.hp;
  assert.equal(hit, CITY.hp - B.damage, 'one shot, landed');
  ctx.order(ctx.a, { t: 'move', ids: [ship.id], x: ship.x - 200, y: ship.y });   // off it goes, not shooting
  ctx.run(B.reload - 0.1);
  assert.equal(lisbon.hp, hit, 'no regeneration while the guns could still be reloading');
  ctx.run(0.5);
  assert.ok(lisbon.hp > hit, 'regenerates again once the next shot is overdue');
});

test('a city still regenerates under attack by units that hit every second', () => {
  const ctx = setup();
  const { game, a, b, city } = ctx;
  const lisbon = city('Lisbon');
  lisbon.owner = b.id;
  lisbon.hp = CITY.hp / 2;
  game.recount();
  const archer = ctx.spawn(a.id, 'archer', lisbon.x + CITY.size + 30, lisbon.y);
  archer.hp = 1e6;
  ctx.order(a, { t: 'attack', ids: [archer.id], k: 'c', id: lisbon.id });
  ctx.run(1);
  const expected = CITY.hp / 2 + (CITY.hpRegen - UNITS.archer.damage);
  assert.ok(Math.abs(lisbon.hp - expected) < 1, `regeneration offsets the damage: ${lisbon.hp} vs ${expected}`);
});

test('snapshots carry each shot once, in the snapshot after it was fired: kind, owner, from, to, target, times', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  const snaps = [];
  a.client = { send: (m) => { if (m.t === 'snap') snaps.push(m); } };
  a.view = { x0: x - 200, y0: y - 200, x1: x + 200, y1: y + 200 };
  const flagsOf = (snap) => { const i = snap.u.indexOf(ship.id); return snap.u[i + 6]; };
  game.sendSnapshots();
  ctx.order(a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  game.tick(DT);
  game.sendSnapshots();
  game.tick(DT);
  game.sendSnapshots();
  assert.equal(snaps[0].f, undefined, 'nothing fired yet');
  const f = snaps[1].f;
  assert.equal(f.length, 9, 'one shot');
  const [kind, owner, x0, y0, x1, y1, tgt, firedAt, landsAt] = f;
  assert.equal(kind, 2, 'a ballista bolt (not 1, a shell) that follows its target (2): a ship');
  assert.equal(owner, a.id);
  assert.ok(Math.abs(x0 - x) < 0.1 && Math.abs(y0 - y) < 0.1, 'from the ship');
  assert.ok(Math.abs(x1 - target.x) < 0.1 && Math.abs(y1 - target.y) < 0.1, 'at the target');
  assert.equal(tgt, target.id);
  assert.ok(Math.abs(firedAt - DT) < 1e-6);
  assert.ok(Math.abs(landsAt - firedAt - 40 / B.boltSpeed) < 0.002, `lands ${landsAt - firedAt} s later`);
  assert.equal(snaps[2].f, undefined, 'not again');
  assert.equal(flagsOf(snaps[1]) & 1, 1, 'attacking');
});

test(`a bolt does its damage when it lands, ${B.boltSpeed} km a second after it was fired`, () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  target.hp = 1000;
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  const [fired] = fireTimes(ctx, ship, DT);
  assert.equal(target.hp, 1000, 'not when it is fired');
  const [hit] = hitTimes(ctx, target, 1);
  const takes = flight(ship, target, B.boltSpeed);
  assert.ok(hit - fired >= takes - 1e-6 && hit - fired < takes + DT, `landed ${hit - fired} s later, flies ${takes} s`);
  assert.equal(target.hp, 1000 - B.damage);
});

test('a bolt at a ship follows it: sailing off does not dodge it', () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 60, y);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  assert.ok(nav.seaAt(x - 60, y - 200) === nav.seaAt(x, y), 'open sea to the north');
  ctx.order(ctx.b, { t: 'move', ids: [target.id], x: x - 60, y: y - 200 });
  ctx.run(1);
  assert.ok(target.dist({ x: x - 60, y }) > 20, 'it sailed off');
  assert.equal(target.hp, UNITS.transport.hp - B.damage, 'hit all the same');
});

test('a bolt at troops on land follows them too: running off does not dodge it, and nobody else is hit', () => {
  const ctx = setup();
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(ctx.a.id, 'battleship', sx, sy);
  const runner = ctx.spawn(ctx.b.id, 'cavalry', lx + 10, ly);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: runner.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  const [shot] = ctx.game.projectiles.list;
  assert.ok(shot.homing && !shot.shell, 'a bolt that follows it');
  const [ax, ay] = [shot.x, shot.y];
  runner.orderMove(lx + 120, ly, false);
  ctx.run(DT);
  // Another unit of B steps onto the spot the bolt was fired at.
  const other = ctx.spawn(ctx.b.id, 'infantry', ax, ay);
  other.orderHold();
  while (ctx.game.projectiles.list.includes(shot)) ctx.game.tick(DT);
  assert.ok(runner.dist({ x: ax, y: ay }) > 2 * runner.r, 'it ran off');
  assert.equal(runner.hp, UNITS.cavalry.hp - B.damage, 'hit all the same');
  assert.equal(other.hp, UNITS.infantry.hp, 'not the one standing where it was');
});

test('a bolt whose target died before it landed hits nobody', () => {
  const ctx = setup();
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(ctx.a.id, 'battleship', sx, sy);
  const foot = ctx.spawn(ctx.b.id, 'infantry', lx + 10, ly);
  const next = ctx.spawn(ctx.b.id, 'infantry', lx + 10, ly + 13);
  for (const u of [foot, next]) u.orderHold();
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: foot.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  const [shot] = ctx.game.projectiles.list;
  foot.hp = 0;
  while (ctx.game.projectiles.list.includes(shot)) ctx.game.tick(DT);
  assert.ok(!ctx.game.units.has(foot.id));
  assert.equal(next.hp, UNITS.infantry.hp, 'lost');
});

test('a shot still lands after its ship sank, and the kill is its owner\'s', () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 50, y);
  target.hp = 1;
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  ship.hp = 0;
  ctx.game.tick(DT);
  assert.ok(!ctx.game.units.has(ship.id), 'sunk');
  const kills = ctx.a.kills;
  ctx.run(1);
  assert.ok(!ctx.game.units.has(target.id), 'its bolt sank the transport');
  assert.equal(ctx.a.kills, kills + UNITS.transport.cost);
});

const G = TECHS.gunnery;

test('Gunnery needs Warships first; cancelling Seafaring cancels both', () => {
  const { a, order } = setup({});
  a.gold = 1000;
  order(a, { t: 'research', tech: 'seafaring' });
  order(a, { t: 'research', tech: 'gunnery' });
  assert.deepEqual(a.researchQueue, [], 'Seafaring is not enough');
  order(a, { t: 'research', tech: 'warships' });
  order(a, { t: 'research', tech: 'gunnery' });
  assert.deepEqual(a.researchQueue.map((e) => e.tech), ['warships', 'gunnery'], 'queued after Warships');
  order(a, { t: 'cancelResearch', tech: 'seafaring', level: 1 });
  assert.equal(a.research, null);
  assert.deepEqual(a.researchQueue, []);
  assert.equal(a.gold, 1000, 'all refunded');
});

// Damage `u` takes from ships from now on (other units and cities fighting it don't count).
function shipDamage(u) {
  const took = { hp: 0 };
  const take = u.receiveDamage.bind(u);
  u.receiveDamage = (amount, from) => { if (from.naval) took.hp += amount; take(amount, from); };
  return took;
}

test(`Gunnery: a shell does ${B.damage} to the unit it hits and ${Math.round(G.splashShare * 100)}% to the enemies within ` +
  `${G.splashRadius} km, never to your own`, () => {
  const ctx = setup({ seafaring: 1, warships: 1, gunnery: 1 });
  const { a, b } = ctx;
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(a.id, 'battleship', sx, sy);
  const at = (dx, dy) => { assert.ok(nav.walkable(lx + dx, ly + dy), `land at ${dx}, ${dy}`); return [lx + dx, ly + dy]; };
  const ownY = nav.walkable(lx + 19, ly - 12) ? -12 : 12;
  const aimed = ctx.spawn(b.id, 'infantry', ...at(12, 0));
  const near = ctx.spawn(b.id, 'infantry', ...at(26, 0));      // 14 km off: its edge within the burst
  const far = ctx.spawn(b.id, 'infantry', ...at(46, 0));       // 34 km off: out of it
  const own = ctx.spawn(a.id, 'infantry', ...at(19, ownY));    // A's own, in the burst
  const took = new Map();
  for (const u of [aimed, near, far, own]) { u.orderHold(); u.hp = 1000; took.set(u, shipDamage(u)); }
  ctx.order(a, { t: 'attack', ids: [ship.id], k: 'u', id: aimed.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  const [shot] = ctx.game.projectiles.list;
  assert.ok(shot.shell && shot.homing, 'a shell that follows its target');
  assert.ok(Math.abs(shot.landsAt - shot.firedAt - flight(ship, aimed, G.shellSpeed)) < 1e-6, `${G.shellSpeed} km a second`);
  while (ctx.game.projectiles.list.length) ctx.game.tick(DT);
  assert.equal(took.get(aimed).hp, B.damage, 'the whole damage');
  assert.ok(Math.abs(took.get(near).hp - B.damage * G.splashShare) < 1e-9, `splash: ${took.get(near).hp}`);
  assert.equal(took.get(far).hp, 0, 'out of the burst');
  assert.equal(took.get(own).hp, 0, 'never your own');
});

test('Gunnery: a shell follows troops on the move and bursts on them, not where they stood', () => {
  const ctx = setup({ seafaring: 1, warships: 1, gunnery: 1 });
  const { a, b } = ctx;
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(a.id, 'battleship', sx, sy);
  const runner = ctx.spawn(b.id, 'cavalry', lx + 10, ly);
  ctx.order(a, { t: 'attack', ids: [ship.id], k: 'u', id: runner.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  const [shot] = ctx.game.projectiles.list;
  const [ax, ay] = [shot.x, shot.y];
  runner.orderMove(lx + 120, ly, false);
  ctx.run(DT);
  const left = ctx.spawn(b.id, 'infantry', ax, ay);      // on the spot it was fired at
  left.orderHold();
  const took = shipDamage(runner), tookLeft = shipDamage(left);
  while (ctx.game.projectiles.list.includes(shot)) ctx.game.tick(DT);
  assert.ok(left.dist(runner) - left.r > G.splashRadius, 'it ran farther than the burst reaches');
  assert.equal(took.hp, B.damage, 'the whole damage');
  assert.equal(tookLeft.hp, 0, 'nothing where it stood');
});

test('Gunnery: a shell whose target died before it landed bursts where it last stood', () => {
  const ctx = setup({ seafaring: 1, warships: 1, gunnery: 1 });
  const { a, b } = ctx;
  const [lx, ly, sx, sy] = quietShore(ctx, 45);
  const ship = ctx.spawn(a.id, 'battleship', sx, sy);
  const foot = ctx.spawn(b.id, 'infantry', lx + 10, ly);
  const next = ctx.spawn(b.id, 'infantry', lx + 24, ly);     // 14 km off: its edge within the burst
  for (const u of [foot, next]) u.orderHold();
  const took = shipDamage(next);
  ctx.order(a, { t: 'attack', ids: [ship.id], k: 'u', id: foot.id });
  assert.equal(fireTimes(ctx, ship, DT).length, 1);
  const [shot] = ctx.game.projectiles.list;
  ctx.game.tick(DT);
  foot.hp = 0;
  while (ctx.game.projectiles.list.includes(shot)) ctx.game.tick(DT);
  assert.ok(!ctx.game.units.has(foot.id));
  assert.ok(Math.abs(took.hp - B.damage * G.splashShare) < 1e-9, `the splash all the same: ${took.hp}`);
});

test('Gunnery: battleships still fire bolts at ships; a shell at a city does no harm to the units around it', () => {
  const ctx = setup({ seafaring: 1, warships: 1, gunnery: 1 });
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const boat = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: boat.id });
  ctx.game.tick(DT);
  const [bolt] = ctx.game.projectiles.list;
  assert.ok(!bolt.shell && bolt.homing, 'a bolt that follows the ship');

  const siege2 = setup({ seafaring: 1, warships: 1, gunnery: 1 });
  const { lisbon, ship: gunship } = siege(siege2);
  const guard = siege2.spawn(siege2.b.id, 'infantry', ...lisbon.spawnPoint(UNITS.infantry.size));
  guard.orderHold();
  const took = shipDamage(guard);
  assert.ok(Math.hypot(guard.x - lisbon.x, guard.y - lisbon.y) - guard.r <= G.splashRadius, 'within a burst at the city');
  siege2.order(siege2.a, { t: 'attack', ids: [gunship.id], k: 'c', id: lisbon.id });
  for (let t = 0; t < 20 && lisbon.hp >= CITY.hp; t += DT) siege2.game.tick(DT);
  assert.ok(lisbon.hp < CITY.hp, 'the city is hit');
  assert.equal(took.hp, 0, 'no splash at a city');
});

test('a battleship and its reload survive a host handover (save)', () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 40, y);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  ctx.run(0.5);
  const copy = restoreGame(JSON.parse(JSON.stringify(saveGame(ctx.game))), { map, nav, hostId: 0 });
  const s = copy.units.get(ship.id);
  assert.equal(s.type, 'battleship');
  assert.ok(s.armed);
  assert.equal(s.readyAt, ship.readyAt, 'still reloading');
  assert.deepEqual(s.order, ship.order);
});

test('a shot in flight survives a host handover and lands', () => {
  const ctx = setup();
  const [x, y] = openSea(ctx);
  const ship = ctx.spawn(ctx.a.id, 'battleship', x, y);
  const target = ctx.spawn(ctx.b.id, 'transport', x - 50, y);
  ctx.order(ctx.a, { t: 'attack', ids: [ship.id], k: 'u', id: target.id });
  ctx.game.tick(DT);
  assert.equal(ctx.game.projectiles.list.length, 1, 'in flight');
  const copy = restoreGame(JSON.parse(JSON.stringify(saveGame(ctx.game))), { map, nav, hostId: 0 });
  assert.deepEqual(copy.projectiles.list, ctx.game.projectiles.list);
  for (let t = 0; t < 1; t += DT) copy.tick(DT);
  assert.equal(copy.units.get(target.id).hp, UNITS.transport.hp - B.damage, 'landed in the new host\'s game');
});
