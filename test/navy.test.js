// Navy: coastal cities, ships sailing the seas, units going on board a transport and landing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as setupGame, nav, map } from './helpers.js';
import { forEachCoastPiece, nearestCell } from '../shared/coastline.js';
import { UNITS, NAVAL, COMBAT, TECHS, ECONOMY, HONOR } from '../shared/config.js';
import { CARGO_SHIFT } from '../shared/protocol.js';

// The two-player game of helpers.js; both players have researched Seafaring (ships, boarding, landing).
function setup() {
  const ctx = setupGame();
  for (const p of [ctx.a, ctx.b]) p.tech = { ...p.tech, seafaring: 1 };
  return ctx;
}

// A transport of `owner` in the port of `city`, and a way to read the events its player gets.
function harbour(ctx, owner, cityName) {
  const c = ctx.city(cityName);
  const ship = ctx.spawn(owner.id, 'transport', c.port.x, c.port.y);
  const events = [];
  owner.client = { send: (m) => { if (m.t === 'event') events.push(m); } };
  return { c, ship, events };
}

// `n` infantry of `owner` standing on land around (x, y), on the same landmass, 14 km apart.
function troops(ctx, owner, n, x, y) {
  const out = [], land = nav.landmass(x, y);
  for (let ring = 0; out.length < n && ring < 12; ring++) {
    for (let i = -ring; i <= ring && out.length < n; i++) {
      for (let j = -ring; j <= ring && out.length < n; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const px = x + i * 14, py = y + j * 14;
        if (nav.landmass(px, py) === land) out.push(ctx.spawn(owner.id, 'infantry', px, py));
      }
    }
  }
  assert.equal(out.length, n, 'room for the troops');
  return out;
}

test('cities by the sea are coastal and have a port on the water; inland cities do not', () => {
  const { game, city } = setup();
  for (const name of ['Lisbon', 'Brest', 'Athens', 'Varna', 'Istanbul', 'Plymouth']) {
    const c = city(name);
    assert.ok(c.port, `${name} is coastal`);
    assert.ok(nav.seaAt(c.port.x, c.port.y) > 0, `${name}'s port is on the sea`);
    assert.ok(Math.hypot(c.port.x - c.x, c.port.y - c.y) <= NAVAL.portRange);
  }
  for (const name of ['Madrid', 'Paris', 'London']) assert.equal(city(name).port, null, `${name} is inland`);
  const listed = new Set(game.portList().map(([id]) => id));
  assert.ok(listed.has(city('Lisbon').id) && !listed.has(city('Madrid').id), 'browsers get the coastal cities');
});

test('the seas are joined through the straits, the Caspian is a sea of its own', () => {
  const { city } = setup();
  const athens = city('Athens').port, varna = city('Varna').port, lisbon = city('Lisbon').port;
  assert.equal(nav.seaAt(athens.x, athens.y), nav.seaAt(varna.x, varna.y), 'Aegean and Black Sea: one sea');
  assert.ok(nav.findPath(athens.x, athens.y, varna.x, varna.y, true), 'ships sail through the Dardanelles and the Bosporus');
  assert.ok(nav.findPath(lisbon.x, lisbon.y, varna.x, varna.y, true), 'and from the Atlantic through Gibraltar');
  const caspian = nav.seaAt(2815, 71);
  assert.ok(caspian > 0 && caspian !== nav.seaAt(athens.x, athens.y));
});

test('transports are built only in coastal cities, and Barracks do not speed them up', () => {
  const { game, a, city, run } = setup();
  const madrid = city('Madrid'), lisbon = city('Lisbon');
  lisbon.addUpgrade('barracks');
  a.gold = 1000;
  game.handleCommand(a, { t: 'build', cities: [madrid.id, lisbon.id], item: 'transport' });
  assert.deepEqual(madrid.queue, [], 'an inland city cannot build ships');
  assert.deepEqual(lisbon.queue, ['transport']);
  assert.equal(a.gold, 1000 - UNITS.transport.cost, 'paid once');
  run(UNITS.transport.buildTime - 0.5);
  assert.equal(lisbon.queue.length, 1, 'not ready early: Barracks train soldiers, not ships');
  run(1);
  const ships = [...game.units.values()].filter((u) => u.type === 'transport');
  assert.equal(ships.length, 1);
  assert.ok(nav.seaAt(ships[0].x, ships[0].y) > 0, 'launched on the water');
});

test('ships sail around the land and never leave the water', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { ship } = harbour(ctx, a, 'Brest');
  const plymouth = ctx.city('Plymouth').port;
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: plymouth.x, y: plymouth.y });
  for (let t = 0; t < 15; t += 0.5) {
    run(0.5);
    assert.ok(nav.seaAt(ship.x, ship.y) > 0, `on the sea at ${t + 0.5} s`);
  }
  assert.ok(Math.hypot(ship.x - plymouth.x, ship.y - plymouth.y) < 15, 'crossed the Channel');
  const london = ctx.city('London');
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: london.x, y: london.y });
  run(20);
  assert.ok(nav.seaAt(ship.x, ship.y) > 0, 'an order on land takes it to the nearest water');
  game.handleCommand(a, { t: 'attack', ids: [ship.id], k: 'c', id: ctx.city('Varna').id });
  assert.notEqual(ship.order.kind, 'attack', 'a transport has no weapons');
});

test('units sent to a transport go on board, as many as fit, the closest first', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { c, ship, events } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 10, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  const sent = army.filter((u) => u.order.kind === 'board');
  assert.equal(sent.length, UNITS.transport.capacity, 'orders only for the units that fit');
  assert.deepEqual(events.at(-1), { t: 'event', kind: 'board', ship: ship.id, count: 8, skipped: 2 });
  assert.ok(ship.gather, 'the transport tells them where to gather');
  const toGather = (u) => Math.hypot(u.x - ship.gather.x, u.y - ship.gather.y);
  const nearestLeft = Math.min(...army.filter((u) => !sent.includes(u)).map(toGather));
  assert.ok(sent.every((u) => toGather(u) <= nearestLeft), 'the ones closest to the shore go');
  run(20);
  assert.equal(ship.cargo.length, 8, 'all on board');
  for (const u of sent) assert.ok(!game.units.has(u.id), 'off the map while on board');
  for (const u of army.filter((x) => !sent.includes(x))) assert.ok(game.units.has(u.id), 'the others stay ashore');
  assert.equal(a.unitCount, 11, 'units on board still count as yours');

  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.filter((u) => game.units.has(u.id)).map((u) => u.id) });
  assert.equal(events.at(-1).reason, 'full', 'a full transport takes nobody');
  const snap = [];
  a.client = { send: (m) => { if (m.t === 'snap') snap.push(m); } };
  game.sendSnapshots();
  const i = snap[0].u.indexOf(ship.id);
  assert.equal(snap[0].u[i + 6] >> CARGO_SHIFT, 8, 'the snapshot says how many are on board');
  assert.deepEqual(snap[0].b[0][0], ship.id, 'you get the list of who is on board');
});

test('transports clicked one after another with the same selection share the units out', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const { c, events } = harbour(ctx, a, 'Brest');
  const sea = nav.seaAt(c.port.x, c.port.y);
  const fleet = [0, 1, 2, 3, 4].map((k) => {
    const [x, y] = nav.nearestSea(c.port.x - 10 - k * 8, c.port.y + k * 6, 40, sea);
    return ctx.spawn(a.id, 'transport', x, y);
  });
  const army = troops(ctx, a, 30, c.x + 40, c.y);
  const ids = army.map((u) => u.id);
  const goingTo = (ship) => army.filter((u) => u.order.kind === 'board' && u.order.ship === ship.id);
  const free = () => army.filter((u) => u.order.kind !== 'board');

  // A new selection, then the same selection on two more transports: 8 + 8 + 8, nobody twice.
  game.handleCommand(a, { t: 'board', ship: fleet[0].id, ids });
  game.handleCommand(a, { t: 'board', ship: fleet[1].id, ids, keep: true });
  game.handleCommand(a, { t: 'board', ship: fleet[2].id, ids, keep: true });
  for (const ship of fleet.slice(0, 3)) assert.equal(goingTo(ship).length, 8, 'each transport gets a full load');
  assert.equal(free().length, 6, 'the 6 that did not fit stay');
  // Still the same selection: only those 6 are left to send.
  game.handleCommand(a, { t: 'board', ship: fleet[3].id, ids, keep: true });
  assert.equal(goingTo(fleet[3]).length, 6);
  assert.equal(free().length, 0);
  game.handleCommand(a, { t: 'board', ship: fleet[4].id, ids, keep: true });
  assert.equal(goingTo(fleet[4]).length, 0, 'every unit already has a transport: nothing changes');
  assert.equal(events.at(-1).reason, 'assigned');
  for (const ship of fleet.slice(0, 3)) assert.equal(goingTo(ship).length, 8);

  // The same units selected again: a new selection, so 8 of them leave their transports for this one.
  game.handleCommand(a, { t: 'board', ship: fleet[4].id, ids });
  assert.equal(goingTo(fleet[4]).length, 8, 'the new transport gets a full load');
  assert.equal(fleet.reduce((n, s) => n + goingTo(s).length, 0), 30, 'nobody is sent to two transports');

  // Any other order ends it: after a move, the same selection may board anew.
  game.handleCommand(a, { t: 'move', ids, x: c.x + 60, y: c.y });
  assert.equal(free().length, 30, 'the move ends their boarding');
  game.handleCommand(a, { t: 'board', ship: fleet[0].id, ids, keep: true });
  assert.equal(goingTo(fleet[0]).length, 8, 'units that were moved are free to board again');
});

test('a transport anywhere on the sea takes units on board; only one on another sea cannot', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const { c, events } = harbour(ctx, a, 'Brest');
  // 300 km out at sea: it sails to the nearest beach of their land.
  const far = ctx.spawn(a.id, 'transport', c.port.x - 300, c.port.y);
  assert.ok(nav.seaAt(far.x, far.y) > 0);
  const army = troops(ctx, a, 2, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: far.id, ids: army.map((u) => u.id) });
  assert.equal(far.order.kind, 'dock', 'it sails to a beach, however far');
  assert.ok(army.every((u) => u.order.kind === 'board'), 'and they go to meet it');
  // On the Caspian, a sea of its own: Britain has no beach there.
  const [cx, cy] = nav.nearestSea(2815, 71, 50);
  const caspian = ctx.spawn(a.id, 'transport', cx, cy);
  const london = ctx.city('London');
  const more = troops(ctx, a, 1, london.x, london.y + 20);
  game.handleCommand(a, { t: 'board', ship: caspian.id, ids: more.map((u) => u.id) });
  assert.equal(events.at(-1).reason, 'far');
  assert.equal(more[0].order.kind, 'idle', 'nobody walks off');
});

test('a transport lands its units on the coast nearest to the target, and they march on', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { c, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 4, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(15);
  assert.equal(ship.cargo.length, 4);

  // To London, across the Channel on another landmass than Brest.
  const london = ctx.city('London');
  const britain = nav.landmass(london.x, london.y);
  assert.notEqual(britain, nav.landmass(c.x, c.y));
  game.handleCommand(a, { t: 'unload', ids: [ship.id], x: london.x + 5, y: london.y + 5 });
  assert.equal(ship.order.kind, 'unload');
  for (let t = 0; t < 60 && ship.cargo.length; t += 1) run(1);
  assert.equal(ship.cargo.length, 0, 'everyone is ashore');
  for (const u of army) {
    assert.ok(game.units.has(u.id), 'back on the map');
    assert.equal(nav.landmass(u.x, u.y), britain, 'in Britain');
  }
  // Each walks to its place in the formation around the target.
  const walking = army.filter((u) => u.order.kind === 'move');
  assert.ok(walking.length, 'they march on');
  for (const u of walking) assert.ok(Math.hypot(u.order.x - london.x, u.order.y - london.y) < 60, 'to London');
  const left = (u) => Math.hypot(u.order.x - u.x, u.order.y - u.y);
  const before = walking.map(left);
  run(3);
  walking.forEach((u, i) => assert.ok(u.order.kind !== 'move' || left(u) < before[i], 'getting there'));
});

test('transports steer clear of the guns of coastal cities where the sea allows', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  for (const c of game.cities) c.owner = -1;              // every city shoots at A's ship...
  const rome = ctx.city('Rome');
  rome.owner = a.id;                                      // ...except its home port
  rome.portOverride = true;                               // Rome stands inland now: made coastal, as an admin can
  rome.updatePort();
  game.recount();
  const ship = game.spawnUnit(rome, 'transport');
  for (const u of troops(ctx, a, 4, rome.x + 30, rome.y)) { game.units.delete(u.id); ship.cargo.push(u); }
  // Rome -> Albania: the short way runs through the Strait of Messina, under Reggio's walls.
  const tirana = ctx.city('Tirana');
  game.handleCommand(a, { t: 'unload', ids: [ship.id], x: tirana.x, y: tirana.y });
  let underReggio = 0;
  for (let t = 0; t < 90 && ship.cargo.length && game.units.has(ship.id); t += 0.5) {
    run(0.5);
    if (ctx.city('Reggio').target === ship.id) underReggio += 0.5;
  }
  assert.ok(game.units.has(ship.id), 'the transport made it');
  assert.equal(ship.cargo.length, 0, 'and landed its units');
  assert.equal(underReggio, 0, 'it went round Sicily instead of through the strait');
});

test('ships are repaired fast near their own coastal cities, once nobody has hit them for a while', () => {
  const ctx = setup();
  const { game, a, b } = ctx;
  const { c: brest, ship } = harbour(ctx, a, 'Brest');
  const enemy = ctx.spawn(b.id, 'archer', brest.x + 300, brest.y);
  const far = ctx.spawn(a.id, 'transport', brest.port.x - 200, brest.port.y);
  assert.ok(nav.seaAt(far.x, far.y) > 0);
  for (const s of [ship, far]) s.hp = 50;
  game.time = 100;

  ship.receiveDamage(0.01, enemy);
  ship.regenerate(1);
  assert.equal(ship.hp, 49.99, 'no repairs while under attack');

  game.time += COMBAT.regenDelay + 0.1;
  ship.regenerate(2);
  far.regenerate(2);
  assert.ok(Math.abs(ship.hp - (49.99 + 2 * NAVAL.harbourRegen)) < 1e-9, `${NAVAL.harbourRegen} HP/s in harbour`);
  assert.ok(Math.abs(far.hp - (50 + 2 * UNITS.transport.hpRegen)) < 1e-9, 'its own slow regen at sea');

  brest.owner = b.id;                                  // someone else's port: no repairs there
  const hp = ship.hp;
  ship.regenerate(2);
  assert.ok(Math.abs(ship.hp - (hp + 2 * UNITS.transport.hpRegen)) < 1e-9, 'only your own cities repair your ships');
});

test('a sunk transport takes everyone on board down with it', () => {
  const ctx = setup();
  const { game, a, b, run } = ctx;
  const { c, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 3, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(15);
  assert.equal(ship.cargo.length, 3);
  const enemy = ctx.spawn(b.id, 'archer', c.x + 200, c.y);
  const goldB = b.gold;
  ship.receiveDamage(ship.hp + 1, enemy);
  run(0.1);
  assert.ok(!game.units.has(ship.id));
  const lost = UNITS.transport.cost + 3 * UNITS.infantry.cost;
  assert.equal(a.losses, lost, 'the ship and its passengers are lost');
  assert.equal(b.kills, lost, 'and count as kills for whoever sank it');
  assert.equal(b.gold - goldB, lost * ECONOMY.killGoldShare, 'each of them pays the kill gold');
  assert.equal(b.honor, lost * HONOR.killShare, 'and honor: the ship and its three passengers');
  assert.equal(a.unitCount, 0);
});

test('units that were sent on board stop when the transport sails off', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { c, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 2, c.x + 120, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(1);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: c.port.x - 100, y: c.port.y });
  run(1);
  assert.ok(army.every((u) => u.order.kind === 'idle' && game.units.has(u.id)), 'they stop where they are');
});

test('a city has two rally points: on land for its units, on the water for its ships', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const { c: brest, events } = harbour(ctx, a, 'Brest');
  const madrid = city('Madrid');
  const seaSpot = nav.nearestSea(brest.port.x - 60, brest.port.y, 40, brest.port.sea);
  const landSpot = [brest.x + 40, brest.y];
  assert.ok(nav.walkable(...landSpot));

  // On the water: only the ships' rally point of the coastal city; the inland one is left alone.
  game.handleCommand(a, { t: 'rally', cities: [brest.id, madrid.id], x: seaSpot[0], y: seaSpot[1] });
  assert.deepEqual(brest.seaRally, { x: seaSpot[0], y: seaSpot[1] });
  assert.equal(brest.rally, null, 'the land rally point is not touched');
  assert.equal(madrid.seaRally, null, 'an inland city has no rally point at sea');
  // On land: the units' rally point; the ships' one stays.
  game.handleCommand(a, { t: 'rally', cities: [brest.id], x: landSpot[0], y: landSpot[1] });
  assert.ok(brest.rally && brest.seaRally, 'both are set');

  const ship = game.spawnUnit(brest, 'transport');
  const foot = game.spawnUnit(brest, 'infantry');
  assert.equal(ship.order.kind, 'move', 'a new ship sails to the rally point at sea');
  assert.equal(foot.order.kind, 'amove', 'a new unit attack-moves to the one on land');
  run(10);
  assert.ok(Math.hypot(ship.x - seaSpot[0], ship.y - seaSpot[1]) < 30, 'the ship got there');

  // Only inland cities selected: told why nothing happened.
  game.handleCommand(a, { t: 'rally', cities: [madrid.id], x: seaSpot[0], y: seaSpot[1] });
  assert.equal(events.at(-1).reason, 'inland');

  // Clearing clears both; so do a capture and the city becoming inland.
  game.handleCommand(a, { t: 'rally', cities: [brest.id], x: null, y: null });
  assert.equal(brest.rally, null);
  assert.equal(brest.seaRally, null);
  game.handleCommand(a, { t: 'rally', cities: [brest.id], x: seaSpot[0], y: seaSpot[1] });
  game.setPortOverride(brest.id, false);
  assert.equal(brest.seaRally, null, 'an inland city keeps no rally point at sea');
  const snap = [];
  a.client = { send: (m) => { if (m.t === 'snap') snap.push(m); } };
  game.setPortOverride(brest.id, null);
  game.handleCommand(a, { t: 'rally', cities: [brest.id], x: seaSpot[0], y: seaSpot[1] });
  game.sendSnapshots();
  const q = snap[0].q.find(([id]) => id === brest.id);
  assert.deepEqual(q.slice(5, 7), [Math.round(seaSpot[0] * 10) / 10, Math.round(seaSpot[1] * 10) / 10], 'your browser gets it');
  brest.capture(-1);
  assert.equal(brest.seaRally, null, 'a captured city loses it');
});

test('new units step out of the city onto its own landmass, never onto an island across the water', () => {
  const { game } = setup();
  const sizes = [...new Set(Object.values(UNITS).filter((u) => !u.naval).map((u) => u.size))];
  // Split, Athens, Copenhagen, Turku and Reggio have islands just outside their walls.
  for (const c of game.cities) {
    const land = nav.landmass(c.x, c.y);
    for (let k = 0; k < 32; k++) {
      const ang = (k / 32) * Math.PI * 2;
      c.rally = { x: c.x + Math.cos(ang) * 100, y: c.y + Math.sin(ang) * 100 };
      for (const size of sizes) {
        const [x, y] = c.spawnPoint(size);
        if (nav.landmass(x, y) !== land) assert.fail(`${c.name}: a unit facing ${Math.round(ang * 180 / Math.PI)}° spawned off its landmass`);
      }
    }
    c.rally = null;
  }
});

test('ships, boarding and landing need the Seafaring technology (Tech, Sea tab)', () => {
  const ctx = setupGame();                               // nobody has researched Seafaring
  const { game, a, run, city } = ctx;
  const brest = city('Brest');
  const { seafaring } = TECHS;
  assert.deepEqual(seafaring.levels, [{ cost: 100, time: 30 }], 'one level: 100 gold, 30 seconds');
  a.gold = 1000;
  a.commandTokens = 20;
  game.handleCommand(a, { t: 'build', cities: [brest.id], item: 'transport' });
  assert.deepEqual(brest.queue, [], 'no ships without it');
  assert.equal(a.gold, 1000);

  // Boarding and landing are refused too (a transport placed here by the test).
  const ship = ctx.spawn(a.id, 'transport', brest.port.x, brest.port.y);
  const [foot] = [ctx.spawn(a.id, 'infantry', brest.x + 30, brest.y)];
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: [foot.id] });
  assert.equal(foot.order.kind, 'idle', 'no boarding without it');
  ship.cargo.push(ctx.spawn(a.id, 'infantry', brest.x + 40, brest.y));
  game.handleCommand(a, { t: 'unload', ids: [ship.id], x: city('London').x, y: city('London').y });
  assert.notEqual(ship.order.kind, 'unload', 'no landing without it');

  game.handleCommand(a, { t: 'research', tech: 'seafaring' });
  assert.equal(a.gold, 1000 - 100);
  run(29.5);
  assert.equal(a.tech.seafaring, 0, 'not before 30 seconds');
  run(1);
  assert.equal(a.tech.seafaring, 1);
  game.handleCommand(a, { t: 'research', tech: 'seafaring' });
  assert.equal(a.research, null, 'one level only');
  game.handleCommand(a, { t: 'build', cities: [brest.id], item: 'transport' });
  assert.deepEqual(brest.queue, ['transport'], 'now coastal cities build ships');
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: [foot.id] });
  assert.equal(foot.order.kind, 'board', 'and units go on board');
});

test('a right-click on land with a loaded transport lands its units there; on water it just sails', () => {
  const ctx = setup();
  const { game, a, b, run, city } = ctx;
  const { c: brest, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 3, brest.x + 30, brest.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(15);
  assert.equal(ship.cargo.length, 3);

  // Water: a plain sail.
  const water = nav.nearestSea(brest.port.x - 60, brest.port.y, 40, brest.port.sea);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: water[0], y: water[1] });
  assert.equal(ship.order.kind, 'move');

  // An enemy city: land them to attack it.
  const london = city('London');
  london.owner = b.id;
  game.handleCommand(a, { t: 'attack', ids: [ship.id], k: 'c', id: london.id });
  assert.equal(ship.order.kind, 'unload');
  assert.equal(ship.order.city, london.id);

  // Land (inside Britain, not the city): the same as Unload, then a click there.
  london.owner = a.id;
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: london.x + 20, y: london.y + 20 });
  assert.equal(ship.order.kind, 'unload', 'treated as Unload');
  for (let t = 0; t < 60 && ship.cargo.length; t += 0.05) run(0.05);
  assert.equal(ship.cargo.length, 0, 'everyone is ashore');
  assert.ok(army.every((u) => u.order.kind === 'amove'), 'and they attack-move to the target');
  for (const u of army) assert.equal(nav.landmass(u.x, u.y), nav.landmass(london.x, london.y), 'in Britain');

  // An empty transport clicked onto land only sails to the nearest water.
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: london.x, y: london.y });
  assert.equal(ship.order.kind, 'move');
});

// The place clicked for a landing only says where the transports land (park there); what Shift adds on land
// is where the units go (go there), straight from the beach.
test('Shift while landing units: an order on land is for the units on board once ashore, one on the water for the ship', () => {
  const ctx = setup();
  const { game, a, b, run, city } = ctx;
  const { c: brest, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 3, brest.x + 30, brest.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(15);
  assert.equal(ship.cargo.length, 3);
  // Britain is yours, but for York.
  const london = city('London'), britain = nav.landmass(london.x, london.y);
  for (const c of game.cities) if (nav.landmass(c.x, c.y) === britain) c.owner = a.id;
  const york = city('York');
  york.owner = b.id;

  game.handleCommand(a, { t: 'unload', ids: [ship.id], x: london.x + 20, y: london.y + 20 });
  const field = nav.nearestWalkable(london.x - 40, london.y - 60, 40);
  assert.equal(nav.landmass(field[0], field[1]), britain, 'the field is in Britain');
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: field[0], y: field[1], queue: true });
  game.handleCommand(a, { t: 'attack', ids: [ship.id], k: 'c', id: york.id, queue: true });
  const [wx, wy] = seaSpot(nav.seaAt(ship.x, ship.y), [london.x, london.y], 60, 200);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: wx, y: wy, queue: true });
  assert.equal(ship.order.kind, 'unload', 'the transport still lands them');
  assert.deepEqual(ship.order.then.map((q) => q.kind), ['move', 'attack'], 'the orders on land are for the units on board');
  assert.equal(ship.queue.length, 1, 'the one on the water is the ship\'s');

  // Your browser draws their way from the shore: the field, then York (not the place clicked for the landing).
  const snap = [];
  a.client = { send: (m) => { if (m.t === 'snap') snap.push(m); } };
  game.sendSnapshots();
  const plan = snap[0].wl.find(([id]) => id === ship.id);
  assert.deepEqual(plan.slice(1, 3), [Math.round(ship.order.lx), Math.round(ship.order.ly)], 'from the beach where they land');
  assert.deepEqual(plan.slice(3, 6), [0, Math.round(field[0]), Math.round(field[1])]);
  assert.deepEqual(plan.slice(6), [2, Math.round(york.x), Math.round(york.y)]);

  for (let t = 0; t < 60 && ship.cargo.length; t += 0.05) run(0.05);
  assert.equal(ship.cargo.length, 0, 'everyone is ashore');
  for (const u of army) {
    assert.equal(u.order.kind, 'move', 'they set off for the field straight from the beach');
    assert.ok(Math.hypot(u.order.x - field[0], u.order.y - field[1]) < 40, 'to their places by the field');
    assert.deepEqual(u.queue.map((q) => q.kind), ['attack'], 'then York');
    assert.equal(u.queue[0].tid, york.id);
  }
  assert.equal(ship.order.kind, 'move', 'the transport sails on to the water it was sent to');
  assert.ok(Math.hypot(ship.order.x - wx, ship.order.y - wy) < 40);
});

test('units step ashore only where there is room; the others wait on board until there is', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const { c: brest, ship, events } = harbour(ctx, a, 'Brest');
  for (const u of troops(ctx, a, 4, brest.x + 30, brest.y)) { game.units.delete(u.id); ship.cargo.push(u); }

  // Land them in Britain, on a shore packed with your own units holding their ground.
  const london = city('London');
  game.handleCommand(a, { t: 'unload', ids: [ship.id], x: london.x, y: london.y });
  const o = ship.order;
  const wall = [];
  for (let dx = -NAVAL.boardRadius - 10; dx <= NAVAL.boardRadius + 10; dx += 9) {
    for (let dy = -NAVAL.boardRadius - 10; dy <= NAVAL.boardRadius + 10; dy += 9) {
      if (nav.landmass(o.lx + dx, o.ly + dy) !== o.land) continue;
      const u = ctx.spawn(a.id, 'infantry', o.lx + dx, o.ly + dy);
      u.orderHold();
      wall.push(u);
    }
  }
  for (let t = 0; t < 60 && ship.order.kind === 'unload' && ship.order.crowded === undefined; t += 0.5) run(0.5);
  assert.equal(ship.cargo.length, 4, 'nobody lands on top of other units');
  assert.equal(ship.order.kind, 'unload', 'the transport waits to land them');
  assert.deepEqual(events.filter((e) => e.kind === 'unload').map((e) => [e.reason, e.left]), [['crowded', 4]], 'told once');

  // A small hole on the shore: room for some of them; they land, the rest still wait.
  for (const u of wall) if (Math.hypot(u.x - o.lx, u.y - o.ly) < 14) game.units.delete(u.id);
  run(1);
  assert.ok(ship.cargo.length > 0 && ship.cargo.length < 4, `some landed (${4 - ship.cargo.length}), the rest wait`);
  for (const u of wall) game.units.delete(u.id);
  run(1);
  assert.equal(ship.cargo.length, 0, 'everyone is ashore once the shore is clear');
  assert.notEqual(ship.order.kind, 'unload', 'and the transport is done');
  assert.equal(events.filter((e) => e.kind === 'unload').length, 1, 'still told only once');
});

test('transports sent together each get their own dock, nearest first, and all land without jamming', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const brest = city('Brest');
  const sea = brest.port.sea;
  const fleet = [];
  for (let k = 0; k < 10; k++) {
    const [x, y] = nav.nearestSea(brest.port.x - 20 - (k % 5) * 22, brest.port.y + Math.floor(k / 5) * 22, 60, sea);
    const ship = ctx.spawn(a.id, 'transport', x, y);
    const [u] = troops(ctx, a, 1, brest.x + 30, brest.y + k * 14);
    game.units.delete(u.id);
    ship.cargo.push(u);
    fleet.push(ship);
  }
  const london = city('London');
  game.handleCommand(a, { t: 'unload', ids: fleet.map((s) => s.id), x: london.x, y: london.y });
  const docks = fleet.map((s) => [s.order.x, s.order.y]);
  for (let i = 0; i < docks.length; i++) {
    for (let j = i + 1; j < docks.length; j++) {
      const d = Math.hypot(docks[i][0] - docks[j][0], docks[i][1] - docks[j][1]);
      assert.ok(d >= 2 * fleet[0].r, `docks ${i} and ${j} leave room for both ships (${d.toFixed(1)} km apart)`);
    }
  }
  // Your browser is told where each one will be.
  const snap = [];
  a.client = { send: (m) => { if (m.t === 'snap') snap.push(m); } };
  game.sendSnapshots();
  assert.equal(snap[0].k.length, 10 * 6, 'every transport\'s dock and shore point');

  for (let t = 0; t < 120 && fleet.some((s) => s.cargo.length); t += 1) run(1);
  assert.ok(fleet.every((s) => !s.cargo.length), `all landed (${fleet.filter((s) => s.cargo.length).length} still loaded)`);

  // Two transports taking units on board from the same shore get different gather points.
  const [s1, s2] = fleet;
  const army = troops(ctx, a, 4, london.x, london.y);
  game.handleCommand(a, { t: 'board', ship: s1.id, ids: army.slice(0, 2).map((u) => u.id) });
  game.handleCommand(a, { t: 'board', ship: s2.id, ids: army.slice(2).map((u) => u.id) });
  assert.ok(Math.hypot(s1.order.x - s2.order.x, s1.order.y - s2.order.y) >= s1.r + s2.r, 'separate docks for loading too');
});

// A spot in open water of `sea` (no land within 12 km) between `min` and `max` km from `p`, that `ok`.
function seaSpot(sea, p, min, max, ok = () => true) {
  const open = (x, y) => [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]].every(([dx, dy]) => nav.seaAt(x + dx, y + dy) === sea);
  for (let d = min; d <= max; d += 5) {
    for (let k = 0; k < 16; k++) {
      const x = p[0] + Math.cos(k * Math.PI / 8) * d, y = p[1] + Math.sin(k * Math.PI / 8) * d;
      if (open(x, y) && ok(x, y)) return [x, y];
    }
  }
  return null;
}

test('a transport at anchor near the beach takes units on board, then sails back to its anchorage', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const brest = city('Brest');
  const sea = brest.port.sea;
  // The beach the units pick (asked with a transport that is then taken away).
  const army = troops(ctx, a, 3, brest.x + 30, brest.y);
  const probe = ctx.spawn(a.id, 'transport', brest.port.x, brest.port.y);
  game.handleCommand(a, { t: 'board', ship: probe.id, ids: army.map((u) => u.id) });
  const dock = [probe.order.x, probe.order.y];
  game.handleCommand(a, { t: 'stop', ids: army.map((u) => u.id) });
  game.units.delete(probe.id);
  const near = (x, y) => Math.hypot(x - dock[0], y - dock[1]) <= NAVAL.returnRange - 20;

  // At anchor 60+ km out, within NAVAL.returnRange of that beach.
  const anchor = seaSpot(sea, dock, 60, NAVAL.returnRange - 20);
  assert.ok(anchor, 'a spot at sea near the beach');
  const ship = ctx.spawn(a.id, 'transport', anchor[0], anchor[1]);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  assert.equal(ship.order.kind, 'dock', 'it sails to the beach to take them');
  const away = () => Math.hypot(ship.x - anchor[0], ship.y - anchor[1]);
  let farthest = 0;
  for (let t = 0; t < 120 && !(ship.cargo.length === 3 && ship.order.kind === 'idle'); t += 0.5) {
    run(0.5);
    farthest = Math.max(farthest, away());
  }
  assert.ok(farthest > 40, 'it went to the coast');
  assert.equal(ship.cargo.length, 3, 'everyone came on board');
  assert.ok(away() < 15, `and it is back at its anchorage (${away().toFixed(1)} km)`);

  // Boarding called off (the units got other orders): it sails back too.
  const more = troops(ctx, a, 2, brest.x + 60, brest.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: more.map((u) => u.id) });
  run(2);
  game.handleCommand(a, { t: 'stop', ids: more.map((u) => u.id) });
  for (let t = 0; t < 60 && ship.order.kind !== 'idle'; t += 0.5) run(0.5);
  assert.ok(away() < 15, 'back again with nobody left to wait for');

  // Called while still sailing to a new anchorage: afterwards it sails on there.
  const next = seaSpot(sea, anchor, 60, 120, near);
  assert.ok(next, 'another spot near the beach');
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: next[0], y: next[1] });
  run(0.5);
  assert.equal(ship.order.kind, 'move');
  const target = [ship.order.x, ship.order.y];
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: more.map((u) => u.id) });
  assert.deepEqual(ship.returnTo, target, 'it will sail on to where it was going');
  for (let t = 0; t < 120 && !(ship.cargo.length === 5 && ship.order.kind === 'idle'); t += 0.5) run(0.5);
  assert.equal(ship.cargo.length, 5);
  assert.ok(Math.hypot(ship.x - target[0], ship.y - target[1]) < 15, 'and it is there');
});

test('a transport at anchor far from the beach stays there after taking units on board', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const brest = city('Brest');
  const land = nav.landmass(brest.x, brest.y), sea = brest.port.sea;
  // At anchor well beyond NAVAL.returnRange of the nearest beach of Brest's land.
  let anchor = null;
  for (let dx = 150; dx < 600 && !anchor; dx += 10) {
    const p = nav.nearestSea(brest.port.x - dx, brest.port.y, 10, sea);
    const c = p && nav.coastNear(p[0], p[1], land, sea);
    if (c && c.d > NAVAL.returnRange + 50) anchor = p;
  }
  assert.ok(anchor, 'a spot at sea far from the beaches');
  const ship = ctx.spawn(a.id, 'transport', anchor[0], anchor[1]);
  const army = troops(ctx, a, 3, brest.x + 30, brest.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  assert.equal(ship.order.kind, 'dock');
  assert.equal(ship.returnTo, null, 'too far to come back to');
  const dock = [ship.order.x, ship.order.y];
  for (let t = 0; t < 120 && !(ship.cargo.length === 3 && ship.order.kind === 'idle'); t += 0.5) run(0.5);
  assert.equal(ship.cargo.length, 3, 'everyone came on board');
  assert.equal(ship.order.kind, 'idle');
  assert.ok(Math.hypot(ship.x - dock[0], ship.y - dock[1]) < 20, 'it waits at the beach');
});
test('transports find their way through narrow waters, round capes and peninsulas', () => {
  // Beaches where a transport at anchor 50 km out used to slide along the coast for ever, or give up
  // there, on its way to take one unit on board or back: the strait between Tromsø and its islands, the
  // Baltic islands, a channel one cell wide off Africa.
  for (const [bx, by] of [[250, -1925], [368, -627], [403, -632], [1848, 2038], [1858, 2038]]) {
    const ctx = setup();
    const { game, a, b, run, city } = ctx;
    for (const c of game.cities) c.owner = a.id;                 // no guns on the way...
    city('Lisbon').owner = b.id;                                   // ...and the game goes on
    let best = null;
    for (const list of nav.landing.values()) {
      for (let j = 0; j < list.length; j += 2) {
        const [lx, ly] = nav.center(list[j]), d = Math.hypot(lx - bx, ly - by);
        if (!best || d < best.d) best = { d, land: list[j], water: list[j + 1] };
      }
    }
    const [lx, ly] = nav.center(best.land), [wx, wy] = nav.center(best.water);
    const spot = nav.nearestWalkable(lx + (lx - wx) * 8, ly + (ly - wy) * 8, 30);
    const anchor = nav.nearestSea(wx + (wx - lx) * 10, wy + (wy - ly) * 10, 20, nav.seaAt(wx, wy));
    const ship = ctx.spawn(a.id, 'transport', anchor[0], anchor[1]);
    const unit = ctx.spawn(a.id, 'infantry', spot[0], spot[1]);
    game.handleCommand(a, { t: 'board', ship: ship.id, ids: [unit.id] });
    assert.ok(ship.returnTo, `${bx},${by}: comes back afterwards`);
    for (let t = 0; t < 90 && !(ship.cargo.length && ship.order.kind === 'idle'); t += 0.5) run(0.5);
    assert.equal(ship.cargo.length, 1, `${bx},${by}: the unit came on board`);
    const away = Math.hypot(ship.x - anchor[0], ship.y - anchor[1]);
    assert.ok(away < 10, `${bx},${by}: back at anchor (${away.toFixed(1)} km away)`);
  }
});

test('all of the coast is beach: ships take units on board and land them anywhere on it', () => {
  const { game, a, city } = setup();
  // The coastline as the map draws it: every piece shows the shore cell nearest to it. All of them are
  // beaches; only the pieces around islets too small for the land grid have no shore cell (no land to
  // land on), and are drawn as plain coast. Every beach is drawn, and every beach drawn takes ships.
  const dockable = new Set();
  for (const list of nav.landing.values()) for (let k = 0; k < list.length; k += 2) dockable.add(list[k]);
  const drawn = new Set();
  let pieces = 0, onShore = 0, onBeach = 0;
  forEachCoastPiece(map, (ax, ay, bx, by) => {
    pieces++;
    const c = nearestCell(nav, (ax + bx) / 2, (ay + by) / 2, (k) => nav.shore[k] === 1);
    if (c >= 0) onShore++;
    if (c >= 0 && nav.beach[c]) { onBeach++; drawn.add(c); }
  });
  assert.equal(onBeach, onShore, 'every piece of drawn coast with land behind it is beach');
  assert.ok(onBeach / pieces > 0.97, `${(onBeach / pieces * 100).toFixed(1)}% of the drawn coast is beach`);
  let beaches = 0;
  for (let c = 0; c < nav.beach.length; c++) {
    if (!nav.beach[c]) continue;
    beaches++;
    assert.ok(drawn.has(c), 'every beach is drawn on the map');
  }
  for (const c of drawn) assert.ok(dockable.has(c), 'and every beach drawn takes ships');
  // Every island has beaches on each of its seas, the tiny ones without a city too.
  const size = new Map();
  for (let c = 0; c < nav.comp.length; c++) if (nav.comp[c]) size.set(nav.comp[c], (size.get(nav.comp[c]) || 0) + 1);
  const settled = new Set(game.cities.map((c) => nav.landmass(c.x, c.y)));
  let tiny = 0;
  for (const [key, list] of nav.coasts) {
    let shore = false;
    for (let k = 0; k < list.length; k += 2) if (nav.shore[list[k]]) shore = true;
    if (!shore) continue;                                    // not on the drawn coastline
    assert.ok(nav.landing.has(key), 'a beach on every island, on each of its seas');
    const land = Math.floor(key / 65536);
    if (!settled.has(land) && size.get(land) < 40) tiny++;
  }
  assert.ok(tiny > 100, `islets without a city have beaches too (${tiny})`);
  // A harbour by every coastal city.
  for (const name of ['Lisbon', 'Brest', 'Nice', 'Athens', 'Plymouth']) {
    const c = city(name);
    const near = nav.coastNear(c.x, c.y, nav.landmass(c.x, c.y), c.port.sea, 35);
    assert.ok(near, `${name} has a beach next to it`);
  }
  // Docks for landing and boarding are on beaches.
  const london = city('London');
  const dock = nav.coastNear(london.x, london.y, nav.landmass(london.x, london.y), 1);
  assert.equal(nav.beach[nav.cellOf(dock.land[0], dock.land[1])], 1);
  // Every player's browser gets them, to draw them.
  const got = [];
  a.client = { send: (m) => got.push(m) };
  game.sendStart(a);
  const b = got.find((m) => m.t === 'start').beaches;
  let c = 0, decoded = 0;
  for (const step of b.code.split(',')) { c += parseInt(step, 36); decoded += nav.beach[c]; }
  assert.equal(decoded, beaches, 'the coded cells are exactly the beaches');
});

test('the units pick the beach nearest to them, and the transport sails there', () => {
  const ctx = setup();
  const { game, a, city } = ctx;
  // A transport out in the Atlantic, units by Montpellier on the Mediterranean (one sea, one landmass).
  const brest = city('Brest'), montpellier = city('Montpellier');
  const ship = ctx.spawn(a.id, 'transport', brest.port.x - 150, brest.port.y);
  const army = troops(ctx, a, 3, montpellier.x, montpellier.y - 40);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  assert.equal(ship.order.kind, 'dock');
  const cx = army.reduce((s, u) => s + u.x, 0) / 3, cy = army.reduce((s, u) => s + u.y, 0) / 3;
  const land = nav.landmass(cx, cy), sea = nav.seaAt(ship.x, ship.y);
  const nearest = nav.coastNear(cx, cy, land, sea);
  const toUnits = Math.hypot(ship.gather.x - cx, ship.gather.y - cy);
  assert.ok(toUnits <= nearest.d + 1, `they gather at the beach nearest to them (${toUnits.toFixed(0)} km away)`);
  assert.ok(Math.hypot(ship.order.x - ship.x, ship.order.y - ship.y) > 800, 'and the transport comes round from the Atlantic');

  // More units clicked onto the same transport while it is on its way: they join the same place.
  const dock = [ship.order.x, ship.order.y];
  const more = troops(ctx, a, 2, montpellier.x - 100, montpellier.y - 60);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: more.map((u) => u.id) });
  assert.deepEqual([ship.order.x, ship.order.y], dock, 'the meeting place stays where it was');
  assert.ok(more.every((u) => u.order.kind === 'board'));
});

test('Autoload: the selected transports take the idle units around them on board, each unit the nearest one with room', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { c, events } = harbour(ctx, a, 'Brest');
  const sea = c.port.sea;
  const fleet = [0, 1, 2].map((k) => {
    const [x, y] = nav.nearestSea(c.port.x - 10 - k * 25, c.port.y + k * 10, 40, sea);
    return ctx.spawn(a.id, 'transport', x, y);
  });
  const [bx, by] = nav.nearestSea(c.port.x - 20, c.port.y - 30, 40, sea);
  const battleship = ctx.spawn(a.id, 'battleship', bx, by);
  const army = troops(ctx, a, 30, c.x + 40, c.y);
  // Units with orders stay, and so do idle units out of reach.
  const [walker, holder] = troops(ctx, a, 2, c.x + 20, c.y - 50);
  game.handleCommand(a, { t: 'move', ids: [walker.id], x: c.x + 60, y: c.y - 50 });
  game.handleCommand(a, { t: 'hold', ids: [holder.id] });
  const land = nav.landmass(c.x, c.y);
  const farSpot = nav.nearestWalkable(c.x + NAVAL.autoloadRange + 150, c.y, 60);
  assert.equal(nav.landmass(farSpot[0], farSpot[1]), land, 'the far spot is on the same land');
  const [far] = troops(ctx, a, 1, farSpot[0], farSpot[1]);

  game.handleCommand(a, { t: 'autoload', ids: [...fleet, battleship].map((s) => s.id) });
  const goingTo = (ship) => army.filter((u) => u.order.kind === 'board' && u.order.ship === ship.id);
  for (const ship of fleet) {
    assert.equal(ship.order.kind, 'dock', 'each transport sails to a beach');
    assert.equal(goingTo(ship).length, UNITS.transport.capacity, 'and gets a full load');
  }
  assert.equal(army.filter((u) => u.order.kind === 'idle').length, 30 - 3 * UNITS.transport.capacity, 'the rest stay');
  assert.deepEqual(events.at(-1), { t: 'event', kind: 'autoload', count: 24, ships: 3 });
  assert.equal(walker.order.kind, 'move', 'a unit walking somewhere keeps going');
  assert.equal(holder.order.kind, 'hold', 'a unit holding its ground stays');
  assert.equal(far.order.kind, 'idle', `units more than ${NAVAL.autoloadRange} km away stay`);
  assert.notEqual(battleship.order.kind, 'dock', 'a battleship carries nobody');
  for (let i = 0; i < fleet.length; i++) {
    for (let j = i + 1; j < fleet.length; j++) {
      const d = Math.hypot(fleet[i].order.x - fleet[j].order.x, fleet[i].order.y - fleet[j].order.y);
      assert.ok(d >= 2 * fleet[0].r, `transports ${i} and ${j} get their own docks (${d.toFixed(1)} km apart)`);
    }
  }
  // Each unit went to the nearest transport that had room: the first transport's load is no farther
  // from it than the units left ashore.
  const nearest = fleet.reduce((p, s) => {
    const d = Math.min(...army.map((u) => Math.hypot(u.x - s.x, u.y - s.y)));
    return !p || d < p.d ? { s, d } : p;
  }, null).s;
  const dist = (u) => Math.hypot(u.x - nearest.x, u.y - nearest.y);
  const left = army.filter((u) => u.order.kind === 'idle');
  assert.ok(Math.max(...goingTo(nearest).map(dist)) <= Math.min(...left.map(dist)), 'the closest units go');

  for (let t = 0; t < 60 && fleet.some((s) => s.cargo.length < s.capacity); t += 1) run(1);
  for (const ship of fleet) assert.equal(ship.cargo.length, UNITS.transport.capacity, 'all on board');

  game.handleCommand(a, { t: 'autoload', ids: fleet.map((s) => s.id) });
  assert.equal(events.at(-1).reason, 'full', 'full transports take nobody');
  assert.ok(left.every((u) => u.order.kind === 'idle'));
});

test('Autoload: a transport already waiting at a beach fills up its places there', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const { c, ship, events } = harbour(ctx, a, 'Brest');
  const first = troops(ctx, a, 3, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: first.map((u) => u.id) });
  const dock = [ship.order.x, ship.order.y];
  const more = troops(ctx, a, 10, c.x + 30, c.y + 60);
  game.handleCommand(a, { t: 'autoload', ids: [ship.id] });
  assert.deepEqual([ship.order.x, ship.order.y], dock, 'the meeting place stays where it was');
  assert.equal(more.filter((u) => u.order.kind === 'board').length, 5, 'only the places still free are filled');
  assert.ok(first.every((u) => u.order.kind === 'board' && u.order.ship === ship.id), 'the ones on their way keep going');
  assert.deepEqual(events.at(-1), { t: 'event', kind: 'autoload', count: 5, ships: 1 });
});

test('Autoload: nobody to take, or no Seafaring', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const { c, ship, events } = harbour(ctx, a, 'Brest');
  game.handleCommand(a, { t: 'autoload', ids: [ship.id] });
  assert.equal(events.at(-1).reason, 'none', 'no idle units nearby');
  const army = troops(ctx, a, 4, c.x + 30, c.y);
  a.tech = { ...a.tech, seafaring: 0 };
  const before = events.length;
  game.handleCommand(a, { t: 'autoload', ids: [ship.id] });
  assert.equal(events.length, before, 'without Seafaring the order is ignored');
  assert.ok(army.every((u) => u.order.kind === 'idle'));
  assert.equal(ship.order.kind, 'idle');
});

test('Autoload with land units selected: they find your transports around them and go on board', () => {
  const ctx = setup();
  const { game, a, run } = ctx;
  const { c, ship, events } = harbour(ctx, a, 'Brest');
  const sea = c.port.sea;
  const [x2, y2] = nav.nearestSea(c.port.x - 40, c.port.y + 20, 40, sea);
  const second = ctx.spawn(a.id, 'transport', x2, y2);
  // A transport busy elsewhere (sailing off) is left alone; one out of reach too.
  const [x3, y3] = nav.nearestSea(c.port.x - 30, c.port.y - 30, 40, sea);
  const busy = ctx.spawn(a.id, 'transport', x3, y3);
  game.handleCommand(a, { t: 'move', ids: [busy.id], x: x3 - 200, y: y3 });
  const far = ctx.spawn(a.id, 'transport', c.port.x - NAVAL.autoboardRange - 300, c.port.y);
  assert.ok(nav.seaAt(far.x, far.y) > 0);
  const army = troops(ctx, a, 20, c.x + 60, c.y);
  game.handleCommand(a, { t: 'move', ids: army.slice(0, 5).map((u) => u.id), x: c.x + 100, y: c.y });

  game.handleCommand(a, { t: 'autoload', ids: army.map((u) => u.id) });
  const goingTo = (s) => army.filter((u) => u.order.kind === 'board' && u.order.ship === s.id);
  assert.equal(goingTo(ship).length + goingTo(second).length, 16, 'two transports, 8 places each: walking units come too');
  assert.equal(goingTo(busy).length + goingTo(far).length, 0, 'a transport sailing off, or far away, is not called');
  assert.equal(busy.order.kind, 'move');
  assert.deepEqual(events.at(-1), { t: 'event', kind: 'autoload', count: 16, ships: 2, left: 4 });
  for (let t = 0; t < 60 && ship.cargo.length + second.cargo.length < 16; t++) run(1);
  assert.equal(ship.cargo.length + second.cargo.length, 16, 'all on board');

  // Nobody left with room: the rest are told so.
  const rest = army.filter((u) => game.units.has(u.id));
  game.handleCommand(a, { t: 'autoload', ids: rest.map((u) => u.id) });
  assert.equal(events.at(-1).reason, 'noship');
  assert.ok(rest.every((u) => u.order.kind !== 'board'));
});

test('Autoload with transports and land units selected: the units look for transports, the full selected one is no matter', () => {
  const ctx = setup();
  const { game, a } = ctx;
  const { c, ship, events } = harbour(ctx, a, 'Brest');
  // The selected transport is full; a free one lies nearby, not selected.
  for (const u of troops(ctx, a, UNITS.transport.capacity, c.x + 30, c.y - 80)) { game.units.delete(u.id); ship.cargo.push(u); }
  const [x2, y2] = nav.nearestSea(c.port.x - 40, c.port.y + 20, 40, c.port.sea);
  const free = ctx.spawn(a.id, 'transport', x2, y2);
  const picked = troops(ctx, a, 6, c.x + 30, c.y);
  const idle = troops(ctx, a, 4, c.x + 30, c.y + 60);     // idle and near, but not selected
  game.handleCommand(a, { t: 'autoload', ids: [ship.id, ...picked.map((u) => u.id)] });
  assert.ok(picked.every((u) => u.order.kind === 'board' && u.order.ship === free.id), 'the selected units go to the free transport');
  assert.equal(ship.order.kind, 'idle', 'the full one stays where it is');
  assert.ok(idle.every((u) => u.order.kind === 'idle'), 'units not selected stay: the units asked, not the transport');
  assert.deepEqual(events.at(-1), { t: 'event', kind: 'autoload', count: 6, ships: 1 });
  // Selected again: they already have a transport.
  game.handleCommand(a, { t: 'autoload', ids: [ship.id, ...picked.map((u) => u.id)] });
  assert.equal(events.at(-1).reason, 'assigned');
});

test('only its owner sees how many units a transport carries', () => {
  const ctx = setup();
  const { game, a, b, run } = ctx;
  const { c, ship } = harbour(ctx, a, 'Brest');
  const army = troops(ctx, a, 3, c.x + 30, c.y);
  game.handleCommand(a, { t: 'board', ship: ship.id, ids: army.map((u) => u.id) });
  run(15);
  assert.equal(ship.cargo.length, 3);
  const snaps = new Map();
  for (const p of [a, b]) {
    p.view = { x0: c.x - 500, y0: c.y - 500, x1: c.x + 500, y1: c.y + 500 };
    p.client = { send: (m) => { if (m.t === 'snap') snaps.set(p, m); } };
  }
  game.sendSnapshots();
  const flagsFor = (p) => { const u = snaps.get(p).u, i = u.indexOf(ship.id); return u[i + 6]; };
  assert.equal(flagsFor(a) >> CARGO_SHIFT, 3, 'the owner sees 3 on board');
  assert.ok(snaps.get(b).u.includes(ship.id), 'the enemy sees the transport');
  assert.equal(flagsFor(b) >> CARGO_SHIFT, 0, 'but not how many it carries');
  assert.equal(snaps.get(b).b.length, 0, 'nor who');
});

// A fleet sent to land at one place uses docks all along the coast. Each transport used to give its own units
// the same few places round the target, so hundreds of units headed for the same spots and jammed there.
test('a fleet landing along a long coast gives every unit a place of its own, and they all get there', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const ships = [];
  for (const name of ['Lisbon', 'Porto', 'Valencia', 'Bilbao']) {
    const port = city(name).port;
    for (let k = 0; k < 3; k++) {
      const [x, y] = nav.nearestSea(port.x - 15 * k, port.y + 12 * k, 60, port.sea);
      const ship = ctx.spawn(a.id, 'transport', x, y);
      for (const u of troops(ctx, a, UNITS.transport.capacity, city(name).x + 30, city(name).y)) { game.units.delete(u.id); ship.cargo.push(u); }
      ships.push(ship);
    }
  }
  const ids = ships.map((s) => s.id);
  const lisbon = city('Lisbon'), land = nav.landmass(lisbon.x, lisbon.y);
  game.handleCommand(a, { t: 'move', ids, x: lisbon.x + 60, y: lisbon.y });
  assert.ok(ships.every((s) => s.order.kind === 'unload'));
  const distinct = (places) => {
    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        if (Math.hypot(places[i][0] - places[j][0], places[i][1] - places[j][1]) < 5) return false;
      }
    }
    return true;
  };
  const places = ships.flatMap((s) => s.cargo.map((u) => s.order.slots[u.id]));
  assert.equal(places.length, 96);
  assert.ok(places.every((p) => p && nav.walkable(p[0], p[1]) && nav.landmass(p[0], p[1]) === land), 'every place is on open land');
  assert.ok(distinct(places), 'no two units of the fleet get the same place');

  // Shift + right-click on land while they sail: one formation there for all of them too.
  const madrid = city('Madrid');
  game.handleCommand(a, { t: 'move', ids, x: madrid.x - 40, y: madrid.y + 40, queue: true });
  const next = ships.flatMap((s) => s.cargo.map((u) => s.order.then[0].slots[u.id]));
  assert.ok(next.every(Boolean) && distinct(next), 'nor the same place after it');

  const cargo = ships.flatMap((s) => s.cargo);
  const there = () => cargo.every((u) => game.units.has(u.id) && u.order.kind === 'idle');
  for (let t = 0; t < 200 && !there(); t += 2) run(2);
  assert.ok(there(), `every unit got there (${cargo.filter((u) => !game.units.has(u.id) || u.order.kind !== 'idle').length} not yet)`);
  const far = cargo.filter((u) => Math.hypot(u.x - (madrid.x - 40), u.y - (madrid.y + 40)) > 150);
  assert.equal(far.length, 0, 'all by Madrid, where Shift sent them after landing');
});

// By a port such as Plymouth the beach is next to the walls: a full transport storming it used to land 4 and keep
// 4 on board, to go down with it under the city's guns.
test('a transport storming a city lands everyone at once, even with little room by the beach', () => {
  const ctx = setup();
  const { game, a, b, run, city } = ctx;
  const plymouth = city('Plymouth');
  plymouth.owner = b.id;
  const [x, y] = nav.nearestSea(plymouth.port.x - 100, plymouth.port.y - 30, 100, plymouth.port.sea);
  const ship = ctx.spawn(a.id, 'transport', x, y);
  for (const u of troops(ctx, a, UNITS.transport.capacity, ...brestSpot(city))) { game.units.delete(u.id); ship.cargo.push(u); }
  const cargo = [...ship.cargo];
  game.handleCommand(a, { t: 'attack', ids: [ship.id], k: 'c', id: plymouth.id });
  assert.equal(ship.order.kind, 'unload');
  // Shift + right-click on land after it: storming, they take the city first (it is not just where to land).
  const field = nav.nearestWalkable(plymouth.x + 80, plymouth.y - 30, 40);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: field[0], y: field[1], queue: true });
  for (let t = 0; t < 30 && !cargo.some((u) => game.units.has(u.id)); t += 0.05) run(0.05);
  assert.equal(cargo.filter((u) => game.units.has(u.id)).length, 8, 'all 8 step ashore at once');
  assert.equal(ship.cargo.length, 0, 'nobody stays on board');
  assert.ok(cargo.every((u) => u.order.kind === 'attack' && u.order.tid === plymouth.id), 'and they storm the city');
  assert.ok(cargo.every((u) => u.queue.length === 1 && u.queue[0].kind === 'move'), 'then on to the field');
  run(1);
  assert.ok(cargo.every((u) => !game.units.has(u.id) || nav.walkable(u.x, u.y)), 'the crowd spreads out on land, not into the sea');
});

// Where a test's troops are made before they are put on board: by Brest.
function brestSpot(city) {
  const c = city('Brest');
  return [c.x + 30, c.y];
}

// The whole Shift chain with a loaded transport: clicks on the water are its path, the first click on land is
// where it parks and lands them, the next ones on land are where they go from the beach, one after another,
// and a click on the water after that is the transport's again.
test('Shift chain: sail there, park here, then the units go there and there, then the transport sails on', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const { c: brest, ship } = harbour(ctx, a, 'Brest');
  for (const u of troops(ctx, a, 4, brest.x + 30, brest.y)) { game.units.delete(u.id); ship.cargo.push(u); }
  const cargo = [...ship.cargo];
  const london = city('London'), britain = nav.landmass(london.x, london.y);
  for (const c of game.cities) if (nav.landmass(c.x, c.y) === britain) c.owner = a.id;
  const sea = nav.seaAt(ship.x, ship.y);
  const w1 = seaSpot(sea, [brest.port.x, brest.port.y], 60, 120);
  const w2 = seaSpot(sea, [london.x, london.y + 60], 40, 140);
  const shift = (x, y) => game.handleCommand(a, { t: 'move', ids: [ship.id], x, y, queue: true });
  shift(...w1);
  shift(...w2);
  assert.equal(ship.order.kind, 'move', 'it sails along its path');
  const park = nav.nearestWalkable(london.x + 20, london.y + 20, 30);
  shift(...park);
  assert.deepEqual(ship.queue.map((q) => q.kind), ['move', 'unload'], 'the first click on land: where it lands them, after its path');
  const f1 = nav.nearestWalkable(london.x - 60, london.y - 60, 40), f2 = nav.nearestWalkable(london.x - 20, london.y - 160, 40);
  shift(...f1);
  shift(...f2);
  const w3 = seaSpot(sea, [london.x, london.y + 60], 60, 200, (x, y) => Math.hypot(x - w2[0], y - w2[1]) > 30);
  shift(...w3);
  const landing = ship.queue.find((q) => q.kind === 'unload');
  assert.deepEqual(landing.then.map((q) => q.kind), ['move', 'move'], 'the next clicks on land are for the units');
  assert.deepEqual(ship.queue.map((q) => q.kind), ['move', 'unload', 'move'], 'the one on the water after them is the transport\'s');

  // Your map shows where it parks (its path) and the units' way on from the beach.
  const snap = [];
  a.client = { send: (m) => { if (m.t === 'snap') snap.push(m); } };
  game.sendSnapshots();
  const path = snap[0].w.find(([id]) => id === ship.id);
  assert.ok(path.length >= 1 + 4 * 3, 'the transport\'s path: its sails, its dock, its sail after');
  const way = snap[0].wl.find(([id]) => id === ship.id);
  assert.deepEqual(way.slice(1, 3), [Math.round(landing.lx), Math.round(landing.ly)], 'the units\' way starts at the beach');
  assert.equal(way.length, 3 + 2 * 3, 'then the two places, not the place it parks at');

  for (let t = 0; t < 120 && ship.cargo.length; t += 0.5) run(0.5);
  assert.equal(ship.cargo.length, 0, 'everyone landed');
  for (const u of cargo) {
    assert.ok(Math.hypot(u.order.x - f1[0], u.order.y - f1[1]) < 40, 'straight from the beach to the first place');
    assert.equal(u.queue.length, 1, 'then the second');
  }
  assert.equal(ship.order.kind, 'move', 'the transport sails on');
  assert.ok(Math.hypot(ship.order.x - w3[0], ship.order.y - w3[1]) < 40);
});

test('a click on land after its path, with nothing after it: the units march there, as without Shift', () => {
  const ctx = setup();
  const { game, a, run, city } = ctx;
  const { c: brest, ship } = harbour(ctx, a, 'Brest');
  for (const u of troops(ctx, a, 3, brest.x + 30, brest.y)) { game.units.delete(u.id); ship.cargo.push(u); }
  const cargo = [...ship.cargo];
  const london = city('London'), britain = nav.landmass(london.x, london.y);
  for (const c of game.cities) if (nav.landmass(c.x, c.y) === britain) c.owner = a.id;
  const w1 = seaSpot(nav.seaAt(ship.x, ship.y), [brest.port.x, brest.port.y], 60, 120);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: w1[0], y: w1[1], queue: true });
  const park = nav.nearestWalkable(london.x - 30, london.y - 30, 30);
  game.handleCommand(a, { t: 'move', ids: [ship.id], x: park[0], y: park[1], queue: true });
  assert.deepEqual(ship.queue.map((q) => q.kind), ['unload']);
  for (let t = 0; t < 120 && ship.cargo.length; t += 0.5) run(0.5);
  assert.equal(ship.cargo.length, 0);
  for (const u of cargo) assert.ok(Math.hypot(u.order.x - park[0], u.order.y - park[1]) < 40, 'they march to the place clicked');
});
