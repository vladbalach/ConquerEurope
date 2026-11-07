// Delete key: disbanded units lose HP until they die. How the death counts in the stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, DISBAND } from '../shared/config.js';
import { setup } from './helpers.js';

// A spot in the open near Paris (A's city), out of reach of every city.
function field(city) {
  const paris = city('Paris');
  return { x: paris.x + 40, y: paris.y + 120 };
}

// One hit from `attacker`, then the attacker leaves the map so it can't fight on.
function hitOnce(game, unit, attacker, amount = 1) {
  unit.receiveDamage(amount, attacker);
  game.units.delete(attacker.id);
}

test('a disbanded unit loses HP every second without regenerating, then dies as a loss with no kill', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const inf = spawn(a.id, 'infantry', x, y);
  game.handleCommand(a, { t: 'disband', ids: [inf.id] });
  assert.ok(inf.disbanding);

  run(4);
  assert.ok(Math.abs(inf.hp - (UNITS.infantry.hp - 4 * DISBAND.hpPerSecond)) < 0.01, `HP drains at ${DISBAND.hpPerSecond}/s`);
  run(4);                                  // regeneration would have started after 3 s of peace
  assert.ok(Math.abs(inf.hp - (UNITS.infantry.hp - 8 * DISBAND.hpPerSecond)) < 0.01, 'no regeneration while disbanding');

  run(UNITS.infantry.hp / DISBAND.hpPerSecond - 8 + 0.2);
  assert.ok(!game.units.has(inf.id), 'it dies when its HP runs out');
  assert.equal(a.losses, UNITS.infantry.cost, 'a loss for its owner');
  assert.equal(b.kills, 0, 'nobody hit it: no kill for anyone');
});

test('hit by another player 20 s or less before dying: the kill goes to that player', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const knight = spawn(a.id, 'knight', x, y);           // 200 HP: 20 s to bleed out
  const raider = spawn(b.id, 'cavalry', x + 400, y);
  hitOnce(game, knight, raider, 5);                      // 195 HP left: dies 19.5 s after this hit
  game.handleCommand(a, { t: 'disband', ids: [knight.id] });
  run(20);
  assert.ok(!game.units.has(knight.id));
  assert.equal(a.losses, UNITS.knight.cost);
  assert.equal(b.kills, UNITS.knight.cost, 'the last player to hit it gets the kill');
});

test('last hit more than 20 s before dying: only a loss, no kill', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const knight = spawn(a.id, 'knight', x, y);
  const raider = spawn(b.id, 'cavalry', x + 400, y);
  hitOnce(game, knight, raider, 5);
  run(10);                                               // regenerates to full meanwhile
  game.handleCommand(a, { t: 'disband', ids: [knight.id] });
  run(UNITS.knight.hp / DISBAND.hpPerSecond + 0.5);      // dies ~30 s after the hit
  assert.ok(!game.units.has(knight.id));
  assert.equal(a.losses, UNITS.knight.cost);
  assert.equal(b.kills, 0, 'the hit was too long ago');
});

test('a hit by a neutral city gives no kill; the last hit by a player still counts', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const inf = spawn(a.id, 'infantry', x, y);
  const raider = spawn(b.id, 'cavalry', x + 400, y);
  hitOnce(game, inf, raider);
  const neutral = city('Madrid');
  neutral.owner = -1;
  inf.receiveDamage(1, neutral);                          // the neutral city hits it last
  game.handleCommand(a, { t: 'disband', ids: [inf.id] });
  run(UNITS.infantry.hp / DISBAND.hpPerSecond + 0.5);
  assert.ok(!game.units.has(inf.id));
  assert.equal(b.kills, UNITS.infantry.cost, 'B hit it within 20 s, so B gets the kill');
});

test('only your own units can be disbanded, never cities', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const mine = spawn(a.id, 'infantry', x, y);
  game.handleCommand(b, { t: 'disband', ids: [mine.id] });
  assert.ok(!mine.disbanding, "the enemy can't disband my unit");

  const paris = city('Paris');
  game.handleCommand(a, { t: 'disband', city: paris.id, cities: [paris.id] });
  game.handleCommand(a, { t: 'disband', ids: 'all' });
  run(2);
  assert.equal(paris.hp, paris.maxHp, 'a city is not disbanded');
  assert.ok(!mine.disbanding);
  assert.equal(mine.hp, UNITS.infantry.hp);
});
