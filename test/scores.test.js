// Kills and losses per player, counted in gold (the cost of the units destroyed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, ECONOMY, HONOR } from '../shared/config.js';
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

// Kill rewards: every kill pays the killer ECONOMY.killGoldShare of the unit's cost in gold, and
// HONOR.killShare of it in honor (as much as it adds to their Kills). The same kills as above: last
// hit, cities count for their owner.
test('a kill pays the killer a share of the unit\'s cost in gold and gives honor; the victim gets nothing', () => {
  const { game, a, b, city, spawn, run } = setup();
  const paris = city('Paris');
  const x = paris.x + 40, y = paris.y + 120;
  spawn(a.id, 'knight', x, y);
  const first = spawn(b.id, 'archer', x + 20, y);
  runUntilDead(game, first, run);
  assert.equal(a.gold, ECONOMY.startGold + UNITS.archer.cost * ECONOMY.killGoldShare, 'an archer pays 2.5 gold: halves count');
  assert.equal(a.honor, UNITS.archer.cost * HONOR.killShare, 'honor: the cost of the unit killed');
  const second = spawn(b.id, 'infantry', x + 20, y);
  runUntilDead(game, second, run);
  assert.equal(a.gold, ECONOMY.startGold + (UNITS.archer.cost + UNITS.infantry.cost) * ECONOMY.killGoldShare);
  assert.equal(a.honor, (UNITS.archer.cost + UNITS.infantry.cost) * HONOR.killShare, 'it adds up, like the Kills column');
  assert.equal(a.honor, a.kills * HONOR.killShare);
  assert.equal(b.gold, ECONOMY.startGold);
  assert.equal(b.honor, 0);
});

test("a city's kill pays its owner; a neutral city's kill pays nobody", () => {
  const { game, a, b, city, spawn, run } = setup();
  const lyon = city('Lyon');                         // A's city
  const raider = spawn(b.id, 'cavalry', lyon.x - 40, lyon.y);
  raider.update = () => {};
  runUntilDead(game, raider, run);
  assert.equal(a.gold, ECONOMY.startGold + UNITS.cavalry.cost * ECONOMY.killGoldShare);
  assert.equal(a.honor, UNITS.cavalry.cost * HONOR.killShare);

  const metz = city('Metz');
  metz.owner = -1;
  const scout = spawn(a.id, 'archer', metz.x - 40, metz.y);
  scout.update = () => {};
  runUntilDead(game, scout, run);
  assert.equal(a.honor, UNITS.cavalry.cost * HONOR.killShare, 'no honor for losing a unit');
  assert.equal(b.honor, 0);
  assert.equal(b.gold, ECONOMY.startGold);
});

test('your snapshot carries your honor and gold, nobody else\'s', () => {
  const { game, a, b, city, spawn, run } = setup();
  const snaps = new Map([[a.id, []], [b.id, []]]);
  a.client = { send: (m) => snaps.get(a.id).push(m) };
  b.client = { send: (m) => snaps.get(b.id).push(m) };
  const paris = city('Paris');
  const x = paris.x + 40, y = paris.y + 120;
  spawn(a.id, 'knight', x, y);
  const victim = spawn(b.id, 'infantry', x + 20, y);
  runUntilDead(game, victim, run);
  game.sendSnapshots();
  const last = (id) => snaps.get(id).filter((m) => m.t === 'snap').at(-1);
  assert.equal(last(a.id).h, Math.floor(UNITS.infantry.cost * HONOR.killShare));
  assert.equal(last(a.id).g, Math.floor(ECONOMY.startGold + UNITS.infantry.cost * ECONOMY.killGoldShare));
  assert.equal(last(b.id).h, 0);
  assert.equal(last(b.id).g, ECONOMY.startGold);
});

// Kills and deaths by count, for the standings at the top right: the same kills as above, and a death for every
// unit that fell (a disbanded one only when an enemy gets the kill).
test('kills and deaths are counted by unit too, and reach the standings', () => {
  const { game, a, b, city, spawn, run } = setup();
  const paris = city('Paris');
  const x = paris.x + 40, y = paris.y + 120;
  spawn(a.id, 'knight', x, y);
  runUntilDead(game, spawn(b.id, 'infantry', x + 20, y), run);
  runUntilDead(game, spawn(b.id, 'archer', x + 20, y), run);
  assert.equal(a.killCount, 2);
  assert.equal(b.deathCount, 2);
  assert.equal(a.deathCount, 0);
  assert.equal(b.killCount, 0);
  const sent = game.playerList();
  assert.equal(sent.find((p) => p.id === a.id).killCount, 2, 'kills reach the standings');
  assert.equal(sent.find((p) => p.id === b.id).deathCount, 2, 'deaths reach the standings');
});

test('a neutral city\'s kill is a death for the victim and nobody\'s kill', () => {
  const { game, a, b, city, spawn, run } = setup();
  const metz = city('Metz');
  metz.owner = -1;
  const scout = spawn(a.id, 'archer', metz.x - 40, metz.y);
  scout.update = () => {};
  runUntilDead(game, scout, run);
  assert.equal(a.deathCount, 1);
  assert.equal(a.killCount + b.killCount, 0);
});

test('a disbanded unit is no death, unless an enemy gets the kill', () => {
  const { game, a, b, city, spawn, run } = setup();
  const paris = city('Paris');
  const x = paris.x + 40, y = paris.y + 120;
  const quiet = spawn(a.id, 'infantry', x, y);
  game.handleCommand(a, { t: 'disband', ids: [quiet.id] });
  runUntilDead(game, quiet, run, 60);
  assert.equal(a.losses, UNITS.infantry.cost, 'still a loss in gold');
  assert.equal(a.deathCount, 0, 'but it did not fall');

  const hit = spawn(a.id, 'infantry', x, y);
  const raider = spawn(b.id, 'cavalry', x + 400, y);
  hit.receiveDamage(UNITS.infantry.hp - 5, raider);
  game.units.delete(raider.id);                      // one hit, then the raider is gone
  game.handleCommand(a, { t: 'disband', ids: [hit.id] });
  runUntilDead(game, hit, run);
  assert.equal(a.deathCount, 1, 'disbanded right after an enemy hit it: it fell');
  assert.equal(b.killCount, 1, 'and it is that enemy\'s kill');
});
