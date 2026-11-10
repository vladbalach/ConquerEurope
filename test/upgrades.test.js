// City upgrades (Wall, Tower, Castle). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY, CITY_UPGRADES, UNITS, ECONOMY } from '../shared/config.js';
import { setup } from './helpers.js';

const { wall, wall2, tower, castle, farm } = CITY_UPGRADES;

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
  assert.ok(Math.abs(paris.range - CITY.attackRange * (1 + tower.rangePercent / 100)) < 1e-9, `tower: +${tower.rangePercent}% range`);

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'castle' });
  run(castle.buildTime + 0.1);
  assert.equal(paris.damage, CITY.damage + castle.damage, `castle: +${castle.damage} damage`);
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
  // A holds the whole west of the map, so all of France: the region bonus comes on top.
  assert.ok(paris.hasRegionBonus);
  assert.equal(paris.goldPerTurn, ECONOMY.goldPerCityPerTurn + farm.goldPerTurn + ECONOMY.regionBonusPerCity);

  const mine = game.cities.filter((c) => c.owner === a.id);
  const inWholeRegions = mine.filter((c) => game.cities.every((o) => o.country !== c.country || o.owner === a.id)).length;
  const before = a.gold;
  game.nextTurnAt = game.time;          // end the turn now
  run(0.05);
  assert.equal(a.gold - before,
    mine.length * ECONOMY.goldPerCityPerTurn + farm.goldPerTurn + inWholeRegions * ECONOMY.regionBonusPerCity,
    'every city pays 10, the farmed one 5 more, the cities of whole regions 2 more');

  // Captured: the farm is gone and the city pays its new owner only the base amount.
  game.captureCity(paris, b.id);
  assert.equal(paris.owner, b.id);
  assert.equal(paris.goldPerTurn, ECONOMY.goldPerCityPerTurn);
});

test('Barracks train units faster in their city, while upgrades build at normal speed', () => {
  const { game, a, b, city, run } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  const { barracks } = CITY_UPGRADES;
  const infantry = UNITS.infantry;
  const rate = 1 + barracks.trainSpeedPercent / 100;
  const mine = () => [...game.units.values()].filter((u) => u.owner === a.id).length;
  a.gold = 1000;

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks' });
  assert.equal(a.gold, 1000 - barracks.cost);
  run(barracks.buildTime - 0.5);
  assert.ok(!paris.upgrades.has('barracks'), 'the Barracks themselves build at normal speed');
  run(0.6);
  assert.ok(paris.upgrades.has('barracks'));
  assert.equal(paris.trainRate, rate);
  assert.equal(lyon.trainRate, 1, 'other cities are not affected');

  // Infantry: faster in Paris, normal speed in Lyon.
  const fast = infantry.buildTime / rate;
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id], item: 'infantry' });
  const start = mine();
  run(fast - 0.2);
  assert.equal(mine(), start, 'not trained before buildTime / rate');
  run(0.3);
  assert.equal(mine(), start + 1, 'Paris trained its infantry in buildTime / rate');
  run(infantry.buildTime - fast - 0.3);
  assert.equal(mine(), start + 1, 'Lyon still needs the full build time');
  run(0.3);
  assert.equal(mine(), start + 2);

  // An upgrade queued in Paris is not sped up.
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'wall' });
  run(CITY_UPGRADES.wall.buildTime / rate + 0.5);
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
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'castle' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'castle' });
  assert.deepEqual(lyon.queue, ['castle'], 'a second castle is not queued');
  run(castle.buildTime + 0.1);
  const gold = a.gold;
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'castle' });
  assert.deepEqual(lyon.queue, [], 'no castle once one is built');
  assert.equal(a.gold, gold, 'no gold taken');
});

test('ordering the wall twice queues Wall I and then Wall II; a third order does nothing', () => {
  const { game, a, city, run } = setup();
  const lyon = city('Lyon');
  a.gold = 1000;
  const order = () => game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  order();
  order();
  assert.deepEqual(lyon.queue, ['wall', 'wall2']);
  assert.equal(a.gold, 1000 - wall.cost - wall2.cost);
  order();
  assert.deepEqual(lyon.queue, ['wall', 'wall2'], 'there is no third grade');
  assert.equal(a.gold, 1000 - wall.cost - wall2.cost, 'no gold taken');

  run(wall.buildTime + 0.1);
  assert.ok(lyon.upgrades.has('wall') && !lyon.upgrades.has('wall2'), 'Wall I first');
  assert.equal(lyon.maxHp, CITY.hp + wall.hp);
  run(wall2.buildTime);
  assert.ok(lyon.upgrades.has('wall2'));
  assert.equal(lyon.maxHp, CITY.hp + wall.hp + wall2.hp);
  assert.equal(lyon.hp, CITY.hp + wall.hp + wall2.hp, 'each grade adds its HP straight away');
});

test('the wall grades add up to the old single wall: 20 gold, 10 s, +250 HP', () => {
  assert.equal(wall.cost + wall2.cost, 20);
  assert.equal(wall.buildTime + wall2.buildTime, 10);
  assert.equal(wall.hp + wall2.hp, 250);
  assert.equal(wall2.requires, 'wall');
});

test('a city with Wall I built gets Wall II from the next order', () => {
  const { game, a, city } = setup();
  const lyon = city('Lyon');
  lyon.addUpgrade('wall');
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  assert.deepEqual(lyon.queue, ['wall2']);
  assert.equal(a.gold, 100 - wall2.cost);
});

test('ordering the wall in several cities queues the next grade in each', () => {
  const { game, a, city } = setup();
  const paris = city('Paris'), lyon = city('Lyon'), metz = city('Metz'), dijon = city('Dijon');
  paris.addUpgrade('wall');
  paris.addUpgrade('wall2');
  lyon.addUpgrade('wall');
  metz.queue = ['wall'];
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id, metz.id, dijon.id], item: 'wall' });
  assert.deepEqual(paris.queue, [], 'every grade built');
  assert.deepEqual(lyon.queue, ['wall2']);
  assert.deepEqual(metz.queue, ['wall', 'wall2']);
  assert.deepEqual(dijon.queue, ['wall']);
  assert.equal(a.gold, 100 - 2 * wall2.cost - wall.cost);
});

test('short of gold for Wall II, a cheaper Wall I in another city is still ordered', () => {
  const { game, a, city } = setup();
  const lyon = city('Lyon'), dijon = city('Dijon');
  lyon.addUpgrade('wall');
  a.gold = wall.cost + 1;   // less than Wall II
  game.handleCommand(a, { t: 'build', cities: [lyon.id, dijon.id], item: 'wall' });
  assert.deepEqual(lyon.queue, []);
  assert.deepEqual(dijon.queue, ['wall']);
  assert.equal(a.gold, 1);
});

test('cancelling Wall I also cancels the Wall II queued after it, refunding both', () => {
  const { game, a, city, run } = setup();
  const lyon = city('Lyon');
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'infantry' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'infantry' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  assert.deepEqual(lyon.queue, ['infantry', 'wall', 'infantry', 'wall2']);
  run(1);
  const progress = lyon.progress;
  game.handleCommand(a, { t: 'cancel', city: lyon.id, index: 1 });
  assert.deepEqual(lyon.queue, ['infantry', 'infantry']);
  assert.equal(a.gold, 100 - 2 * UNITS.infantry.cost, 'both grades refunded');
  assert.equal(lyon.progress, progress, 'the unit in production keeps its progress');

  // Cancelling Wall II alone keeps Wall I.
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'wall' });
  game.handleCommand(a, { t: 'cancel', city: lyon.id, index: 3 });
  assert.deepEqual(lyon.queue, ['infantry', 'infantry', 'wall']);
  assert.equal(a.gold, 100 - 2 * UNITS.infantry.cost - wall.cost);
});

test('capturing a city destroys both wall grades', () => {
  const { game, b, city } = setup();
  const rouen = city('Rouen');
  rouen.addUpgrade('wall');
  rouen.addUpgrade('wall2');
  game.captureCity(rouen, b.id);
  assert.equal(rouen.maxHp, CITY.hp);
  game.handleCommand(b, { t: 'build', cities: [rouen.id], item: 'wall' });
  assert.deepEqual(rouen.queue, ['wall'], 'the new owner starts again from Wall I');
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
  paris.addUpgrade('tower');
  metz.queue = ['tower'];
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id, metz.id], item: 'tower' });
  assert.deepEqual(paris.queue, []);
  assert.deepEqual(lyon.queue, ['tower']);
  assert.deepEqual(metz.queue, ['tower']);
  assert.equal(a.gold, 100 - tower.cost, 'paid only for Lyon');
});

test('cancel `last` cancels the last entry in each listed city, refunded', () => {
  const { game, a, b, city, run } = setup();
  const lyon = city('Lyon'), dijon = city('Dijon');
  a.gold = 100;
  game.handleCommand(a, { t: 'build', cities: [lyon.id, dijon.id], item: 'infantry' });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'tower' });
  run(1);
  const progress = lyon.progress;
  const gold = a.gold;
  game.handleCommand(a, { t: 'cancel', cities: [lyon.id, dijon.id], last: true });
  assert.deepEqual(lyon.queue, ['infantry']);
  assert.deepEqual(dijon.queue, []);
  assert.equal(a.gold, gold + tower.cost + UNITS.infantry.cost);
  assert.equal(lyon.progress, progress, 'the unit in production keeps its progress');
  assert.equal(dijon.progress, 0);

  // Empty queues and other players' cities are left alone.
  game.handleCommand(b, { t: 'cancel', cities: [lyon.id], last: true });
  assert.deepEqual(lyon.queue, ['infantry']);
  game.handleCommand(a, { t: 'cancel', cities: [dijon.id], last: true });
  assert.equal(a.gold, gold + tower.cost + UNITS.infantry.cost);
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
