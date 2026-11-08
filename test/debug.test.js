// Developer console commands that change the game. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG, CITY_UPGRADES } from '../shared/config.js';
import { setup } from './helpers.js';

test('"reset hp" gives every unit and city full HP, and tells everyone who did it (debug builds only)', () => {
  const { game, a, b, spawn } = setup();
  const events = [];
  b.client = { send: (m) => { if (m.t === 'event') events.push(m); } };
  const unitA = spawn(a.id, 'knight', 1000, 1000);
  const unitB = spawn(b.id, 'archer', 1100, 1000);
  unitA.hp = 7;
  unitB.hp = 1;
  const plain = game.cities[0], walled = game.cities[1];
  walled.addUpgrade('wall');
  plain.hp = 3;
  walled.hp = 5;

  game.handleCommand(a, { t: 'resetHp' });

  if (!DEBUG) {
    assert.equal(unitA.hp, 7, 'ignored outside debug builds');
    assert.equal(events.length, 0);
    return;
  }
  assert.equal(unitA.hp, unitA.maxHp);
  assert.equal(unitB.hp, unitB.maxHp);
  assert.equal(plain.hp, plain.maxHp);
  assert.equal(walled.hp, walled.maxHp, 'upgrades count');
  assert.ok(walled.maxHp > plain.maxHp && CITY_UPGRADES.wall.hp > 0);
  assert.ok(game.cities.every((c) => c.hp === c.maxHp));
  assert.deepEqual(events, [{ t: 'event', kind: 'hpReset', player: a.id }]);
});

test('"gold N" sets every player\'s gold to N, and tells everyone who did it (debug builds only)', () => {
  const { game, a, b } = setup();
  const events = [];
  a.client = { send: (m) => { if (m.t === 'event') events.push(m); } };
  a.gold = 3;
  b.gold = 999;

  game.handleCommand(b, { t: 'setGold', gold: 1500 });
  if (!DEBUG) {
    assert.deepEqual([a.gold, b.gold], [3, 999], 'ignored outside debug builds');
    return;
  }
  assert.deepEqual([a.gold, b.gold], [1500, 1500]);
  assert.deepEqual(events, [{ t: 'event', kind: 'goldSet', player: b.id, gold: 1500 }]);

  game.handleCommand(b, { t: 'setGold', gold: -50 });
  assert.deepEqual([a.gold, b.gold], [0, 0], 'never below zero');
  game.handleCommand(b, { t: 'setGold', gold: 12.6 });
  assert.equal(a.gold, 13, 'whole gold');
  game.handleCommand(b, { t: 'setGold', gold: 'lots' });
  game.handleCommand(b, { t: 'setGold', gold: Infinity });
  assert.equal(a.gold, 13, 'not a number: ignored');
});
