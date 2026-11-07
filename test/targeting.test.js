// Target priority: enemy units first, cities only on order or when no enemy unit is in sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

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
