// City upgrades (Wall, Tower, Castle). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY, CITY_UPGRADES, UNITS, ECONOMY } from '../shared/config.js';
import { setup } from './helpers.js';

const { wall, tower, castle, farm } = CITY_UPGRADES;

test('each upgrade is built through the production queue and gives its bonus', () => {
  const { game, a, city, run } = setup();
  assert.equal(game.status, 'running');
  const paris = city('Paris');
  a.gold = 1000;

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'wall' });
  assert.equal(a.gold, 1000 - wall.cost);
  assert.deepEqual(paris.queue, ['wall']);
  run(wall.buildTime - 1);
  assert.ok(!paris.upgrades.has('wall'), 'not finished before its build time');
  run(1.1);
  assert.ok(paris.upgrades.has('wall'));
  assert.equal(paris.maxHp, CITY.hp + wall.hp);
  assert.equal(paris.hp, CITY.hp + wall.hp, 'a new wall adds its HP straight away');

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'tower' });
  run(tower.buildTime + 0.1);
  assert.ok(Math.abs(paris.range - CITY.attackRange * 1.2) < 1e-9, 'tower: +20% range');

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'castle' });
  run(castle.buildTime + 0.1);
  assert.equal(paris.damage, CITY.damage + castle.damage, 'castle: +15 damage');
  assert.equal(game.status, 'running', 'the game is still on, so orders were really processed');
});

test('a Farm adds 5 gold per turn to its city, paid at the end of the turn', () => {
  const { game, a, b, city, run } = setup();
  const paris = city('Paris');
  a.gold = 1000;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'farm' });
  assert.equal(a.gold, 1000 - farm.cost, 'a farm costs 50');
  run(farm.buildTime + 0.1);
  assert.ok(paris.upgrades.has('farm'));
  assert.equal(paris.goldPerTurn, ECONOMY.goldPerCityPerTurn + farm.goldPerTurn);

  const cities = game.cities.filter((c) => c.owner === a.id).length;
  const before = a.gold;
  game.nextTurnAt = game.time;          // end the turn now
  run(0.05);
  assert.equal(a.gold - before, cities * ECONOMY.goldPerCityPerTurn + farm.goldPerTurn,
    'every city pays 10, the farmed one 5 more');

  // Captured: the farm is gone and the city pays its new owner only the base amount.
  game.captureCity(paris, b.id);
  assert.equal(paris.owner, b.id);
  assert.equal(paris.goldPerTurn, ECONOMY.goldPerCityPerTurn);
});

test('Barracks train units 40% faster in their city, while upgrades build at normal speed', () => {
  const { game, a, b, city, run } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  const { barracks } = CITY_UPGRADES;
  const infantry = UNITS.infantry;
  const mine = () => [...game.units.values()].filter((u) => u.owner === a.id).length;
  a.gold = 1000;

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks' });
  assert.equal(a.gold, 1000 - 50, 'Barracks cost 50');
  run(barracks.buildTime - 0.5);
  assert.ok(!paris.upgrades.has('barracks'), 'the Barracks themselves build at normal speed (20 s)');
  run(0.6);
  assert.ok(paris.upgrades.has('barracks'));
  assert.equal(paris.trainRate, 1.4);
  assert.equal(lyon.trainRate, 1, 'other cities are not affected');

  // Infantry: 1.4x speed in Paris, normal speed in Lyon.
  const fast = infantry.buildTime / 1.4;
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id], item: 'infantry' });
  const start = mine();
  run(fast - 0.2);
  assert.equal(mine(), start, 'not trained before buildTime / 1.4');
  run(0.3);
  assert.equal(mine(), start + 1, 'Paris trained its infantry in buildTime / 1.4');
  run(infantry.buildTime - fast - 0.3);
  assert.equal(mine(), start + 1, 'Lyon still needs the full build time');
  run(0.3);
  assert.equal(mine(), start + 2);

  // An upgrade queued in Paris is not sped up.
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'wall' });
  run(CITY_UPGRADES.wall.buildTime / 1.4 + 0.5);
  assert.ok(!paris.upgrades.has('wall'), 'upgrades do not get the training bonus');
  run(CITY_UPGRADES.wall.buildTime);
  assert.ok(paris.upgrades.has('wall'));

  // Captured: the Barracks are gone.
  game.captureCity(paris, b.id);
  assert.equal(paris.trainRate, 1);
});

test('an upgrade can be built only once per city', () => {
  const { game, a, city, run } = setup();
  const lyon = city('Lyon');
  a.gold = 1000;
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  assert.deepEqual(lyon.queue, ['wall'], 'a second wall is not queued');
  run(wall.buildTime + 0.1);
  const gold = a.gold;
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  assert.deepEqual(lyon.queue, [], 'no wall once one is built');
  assert.equal(a.gold, gold, 'no gold taken');
});

test('a Tower shoots further and a Castle hits harder', () => {
  const { game, a, b, city, spawn, run } = setup();
  const dijon = city('Dijon');
  // An enemy just beyond the normal range (edge at ~75 km) but inside the Tower's 84 km.
  const enemy = spawn(b.id, 'infantry', dijon.x - 81, dijon.y);
  enemy.hp = 1e6;
  enemy.makeIdle = () => {};          // keep it standing still for the measurement
  enemy.update = () => {};
  run(0.5);
  assert.equal(dijon.target, 0, 'out of range without a tower');

  dijon.addUpgrade('tower');
  dijon.addUpgrade('castle');
  const before = enemy.hp;
  run(1);
  assert.equal(dijon.target, enemy.id, 'in range with a tower');
  const dealt = before - enemy.hp;
  assert.ok(Math.abs(dealt - (CITY.damage + castle.damage)) < 1, `castle city deals 35/s, dealt ${dealt}`);
});

test('capturing a city destroys its upgrades and refunds what was still queued', () => {
  const { game, a, b, city } = setup();
  const rouen = city('Rouen');
  rouen.addUpgrade('wall');
  rouen.addUpgrade('castle');
  rouen.queue = ['tower', 'infantry'];
  const gold = a.gold;
  game.captureCity(rouen, b.id);
  assert.equal(rouen.upgrades.size, 0);
  assert.equal(rouen.maxHp, CITY.hp);
  assert.equal(rouen.damage, CITY.damage);
  assert.equal(rouen.range, CITY.attackRange);
  assert.equal(a.gold, gold + tower.cost + UNITS.infantry.cost, 'unfinished tower and infantry are refunded');
});

test('ordering an upgrade for several cities skips the ones that already have it', () => {
  const { game, a, city } = setup();
  const paris = city('Paris'), lyon = city('Lyon'), metz = city('Metz');
  paris.addUpgrade('wall');
  metz.queue = ['wall'];
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id, metz.id], item: 'wall' });
  assert.deepEqual(paris.queue, []);
  assert.deepEqual(lyon.queue, ['wall']);
  assert.deepEqual(metz.queue, ['wall']);
  assert.equal(a.gold, 100 - wall.cost, 'paid only for Lyon');
});

test('cancelling a queued upgrade gives the gold back', () => {
  const { game, a, city } = setup();
  const nantes = city('Nantes');
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [nantes.id], item: 'castle' });
  assert.equal(a.gold, 100 - castle.cost);
  game.handleCommand(a, { t: 'cancel', city: nantes.id, index: 0 });
  assert.equal(a.gold, 100);
  assert.deepEqual(nantes.queue, []);
});
