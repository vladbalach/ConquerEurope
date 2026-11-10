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
