// Target priority: enemy units first, cities only on order or when no enemy unit is in sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, nav } from './helpers.js';

test('units fight enemy units first and attack a city only when no enemy unit is in sight', () => {
  const { game, a, b, city, spawn, run } = setup();
  const metz = city('Metz');
  metz.owner = -1;                                     // a neutral city that shoots at A
  const soldier = spawn(a.id, 'infantry', metz.x - 18, metz.y);
  soldier.hp = 1e6;                                    // survive the arrows for the test
  run(1);
  assert.deepEqual(soldier.target, { k: 'c', id: metz.id }, 'with no enemy units around it attacks the city');

  const enemy = spawn(b.id, 'infantry', metz.x - 70, metz.y);
  enemy.hp = 1e6;
  run(1);
  assert.deepEqual(soldier.target, { k: 'u', id: enemy.id }, 'switches to the enemy unit as soon as it is in sight');
});

test('a direct order to attack a city is obeyed even with enemy units around', () => {
  const { game, a, b, city, spawn, run } = setup();
  const metz = city('Metz');
  metz.owner = -1;
  const soldier = spawn(a.id, 'infantry', metz.x - 18, metz.y);
  soldier.hp = 1e6;
  const enemy = spawn(b.id, 'infantry', metz.x - 60, metz.y);
  enemy.hp = 1e6;
  run(1.5);                                            // the soldier goes for the enemy unit first
  assert.equal(game.status, 'running');
  game.handleCommand(a, { t: 'attack', ids: [soldier.id], k: 'c', id: metz.id });
  run(3);
  assert.equal(soldier.order.kind, 'attack', `order was dropped (now ${soldier.order.kind})`);
  assert.equal(soldier.engaged, -(metz.id + 1), 'keeps hitting the city it was ordered to attack');
});

// Open land with nothing in the way 150 km either side of it and 50 km above and below, at least 200 km
// from every city, so no city's guns take part.
function openField(game) {
  for (let x = -1500; x < 2800; x += 40) {
    for (let y = -1500; y < 2000; y += 40) {
      if (game.cities.some((c) => Math.hypot(c.x - x, c.y - y) < 200)) continue;
      if (nav.los(x - 150, y, x + 150, y) && nav.los(x - 150, y + 50, x + 150, y + 50) && nav.los(x, y - 50, x, y + 50)) return [x, y];
    }
  }
  throw new Error('no open field');
}

test('attack-move: when its target runs off, the unit goes for the nearest enemy instead', () => {
  const { game, a, b, spawn, run } = setup();
  const [x, y] = openField(game);
  const soldier = spawn(a.id, 'infantry', x, y);
  const rider = spawn(b.id, 'cavalry', x + 40, y);       // the nearest at first
  const foot = spawn(b.id, 'infantry', x + 20, y + 50);
  for (const u of [soldier, rider, foot]) u.hp = 1e6;
  game.handleCommand(a, { t: 'move', ids: [soldier.id], x: x + 150, y, amove: true });
  game.handleCommand(b, { t: 'move', ids: [rider.id], x: x + 150, y });   // it rides off at once
  run(0.1);
  assert.deepEqual(soldier.target, { k: 'u', id: rider.id }, 'the nearest first');
  run(2);
  assert.deepEqual(soldier.target, { k: 'u', id: foot.id }, 'then the one now nearest, not the rider it saw first');
  assert.equal(soldier.order.kind, 'amove');
});

test('attack-move: a target that gets out of sight is let go, and the unit walks on', () => {
  const { game, a, b, spawn, run } = setup();
  const [x, y] = openField(game);
  const soldier = spawn(a.id, 'infantry', x, y);
  const rider = spawn(b.id, 'cavalry', x - 40, y);
  for (const u of [soldier, rider]) u.hp = 1e6;
  game.handleCommand(a, { t: 'move', ids: [soldier.id], x: x + 150, y, amove: true });
  game.handleCommand(b, { t: 'move', ids: [rider.id], x: x - 150, y });    // away from where the soldier goes
  run(0.1);
  assert.deepEqual(soldier.target, { k: 'u', id: rider.id }, 'it goes for the rider');
  run(3);                                                // the rider is out of sight (80 km) after ~2 s
  assert.equal(soldier.target, null, 'the rider got away: let go');
  const turned = soldier.x;
  run(3);
  assert.ok(soldier.x - turned > 60, `on its way again (${soldier.x - turned} km in 3 s)`);
  assert.equal(soldier.order.kind, 'amove');
});

test('an attack order still follows its target, nearer enemies or not', () => {
  const { game, a, b, spawn, run } = setup();
  const [x, y] = openField(game);
  const soldier = spawn(a.id, 'infantry', x, y);
  const rider = spawn(b.id, 'cavalry', x + 40, y);
  const foot = spawn(b.id, 'infantry', x + 20, y + 50);
  for (const u of [soldier, rider, foot]) u.hp = 1e6;
  game.handleCommand(a, { t: 'attack', ids: [soldier.id], k: 'u', id: rider.id });
  game.handleCommand(b, { t: 'move', ids: [rider.id], x: x + 150, y });
  run(2);
  assert.equal(soldier.order.kind, 'attack');
  assert.deepEqual(soldier.target, { k: 'u', id: rider.id });
});
