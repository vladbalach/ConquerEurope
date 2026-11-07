// Kills and losses per player, counted in gold (the cost of the units destroyed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS } from '../shared/config.js';
import { setup } from './helpers.js';

// Runs until `unit` is dead (or the time runs out).
function runUntilDead(game, unit, run, seconds = 30) {
  for (let t = 0; t < seconds && game.units.has(unit.id); t += 0.5) run(0.5);
  assert.ok(!game.units.has(unit.id), `${unit.type} should have died`);
}

test('a unit killing another: the killer gets kills, the victim losses, in gold', () => {
  const { game, a, b, city, spawn, run } = setup();
  const paris = city('Paris');
  // Fight in the open, far enough from every city that only the two units are involved.
  const x = paris.x + 40, y = paris.y + 120;
  const knight = spawn(a.id, 'knight', x, y);
  const victim = spawn(b.id, 'infantry', x + 20, y);
  runUntilDead(game, victim, run);
  assert.ok(game.units.has(knight.id), 'the knight wins');
  assert.equal(a.kills, UNITS.infantry.cost);
  assert.equal(b.losses, UNITS.infantry.cost);
  assert.equal(a.losses, 0);
  assert.equal(b.kills, 0);

  const sent = game.playerList();
  assert.equal(sent.find((p) => p.id === a.id).kills, UNITS.infantry.cost, 'kills reach the players overlay');
  assert.equal(sent.find((p) => p.id === b.id).losses, UNITS.infantry.cost, 'losses reach the players overlay');
});

test("a city's kill counts for its owner", () => {
  const { game, a, b, city, spawn, run } = setup();
  const lyon = city('Lyon');                         // A's city
  const raider = spawn(b.id, 'cavalry', lyon.x - 40, lyon.y);
  raider.update = () => {};                          // stands still under the arrows
  runUntilDead(game, raider, run);
  assert.equal(a.kills, UNITS.cavalry.cost);
  assert.equal(b.losses, UNITS.cavalry.cost);
});

test('a kill by a neutral city is only a loss for the victim', () => {
  const { game, a, b, city, spawn, run } = setup();
  const metz = city('Metz');
  metz.owner = -1;
  const scout = spawn(a.id, 'archer', metz.x - 40, metz.y);
  scout.update = () => {};
  runUntilDead(game, scout, run);
  assert.equal(a.losses, UNITS.archer.cost);
  assert.equal(a.kills, 0);
  assert.equal(b.kills, 0);
});
