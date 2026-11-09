// Developer console commands that change the game. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG, CITY, CITY_UPGRADES, UNITS } from '../shared/config.js';
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

test('"honor N" sets every player\'s honor to N, and tells everyone who did it (debug builds only)', () => {
  const { game, a, b } = setup();
  const events = [];
  a.client = { send: (m) => { if (m.t === 'event') events.push(m); } };
  a.honor = 3;
  b.honor = 999;

  game.handleCommand(b, { t: 'setHonor', honor: 2000 });
  if (!DEBUG) {
    assert.deepEqual([a.honor, b.honor], [3, 999], 'ignored outside debug builds');
    return;
  }
  assert.deepEqual([a.honor, b.honor], [2000, 2000]);
  assert.deepEqual(events, [{ t: 'event', kind: 'honorSet', player: b.id, honor: 2000 }]);

  game.handleCommand(b, { t: 'setHonor', honor: -50 });
  assert.deepEqual([a.honor, b.honor], [0, 0], 'never below zero');
  game.handleCommand(b, { t: 'setHonor', honor: 12.6 });
  assert.equal(a.honor, 13, 'whole honor');
  game.handleCommand(b, { t: 'setHonor', honor: 'lots' });
  game.handleCommand(b, { t: 'setHonor', honor: Infinity });
  assert.equal(a.honor, 13, 'not a number: ignored');
});

test('"slomo N" sets the game speed, within limits, and tells everyone who did it (debug builds only)', () => {
  const { game, a, b } = setup();
  const events = [];
  a.client = { send: (m) => { if (m.t === 'event') events.push(m); } };

  game.handleCommand(b, { t: 'setSpeed', speed: 4 });
  if (!DEBUG) {
    assert.equal(game.timeScale, 1, 'ignored outside debug builds');
    return;
  }
  assert.equal(game.timeScale, 4);
  assert.deepEqual(events, [{ t: 'event', kind: 'speedSet', player: b.id, speed: 4 }]);

  game.handleCommand(b, { t: 'setSpeed', speed: 50 });
  assert.equal(game.timeScale, 10, 'at most 10 times normal');
  game.handleCommand(b, { t: 'setSpeed', speed: 0 });
  assert.equal(game.timeScale, 0.1, 'at least a tenth');
  game.handleCommand(b, { t: 'setSpeed', speed: 'fast' });
  assert.equal(game.timeScale, 0.1, 'not a number: ignored');
  game.handleCommand(b, { t: 'setSpeed', speed: 1 });
  assert.equal(game.timeScale, 1, 'back to normal');
});

test('"Own" makes any city the sender\'s at once, like a capture, tells everyone and is not counted (debug builds only)', () => {
  const { game, a, b, city } = setup();
  const events = [];
  a.client = { send: (m) => { if (m.t === 'event') events.push(m); } };
  const paris = city('Paris');
  assert.equal(paris.owner, a.id);
  a.gold = UNITS.infantry.cost;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry' });
  paris.addUpgrade('wall');
  assert.equal(a.gold, 0);

  game.handleCommand(b, { t: 'takeCity', city: paris.id });
  if (!DEBUG) {
    assert.equal(paris.owner, a.id, 'ignored outside debug builds');
    assert.equal(events.length, 0);
    return;
  }
  assert.equal(paris.owner, b.id);
  assert.equal(paris.hp, CITY.captureHp, 'like a capture');
  assert.equal(paris.upgrades.size, 0, 'its upgrades are lost');
  assert.deepEqual(paris.queue, []);
  assert.equal(a.gold, UNITS.infantry.cost, 'the previous owner gets the queue refunded');
  assert.deepEqual(events, [{
    t: 'event', kind: 'capture', city: paris.id, from: a.id, to: b.id, refund: UNITS.infantry.cost, debug: true,
  }]);
  const history = game.history;
  assert.equal(history.stat(b.id).captured, 0, 'not a capture in the statistics');
  assert.equal(history.stat(a.id).citiesLost, 0);
  game.recount();
  assert.equal(b.cityCount + a.cityCount, game.cities.length);

  events.length = 0;
  game.handleCommand(b, { t: 'takeCity', city: paris.id });
  game.handleCommand(b, { t: 'takeCity', city: 99999 });
  game.handleCommand(b, { t: 'takeCity', city: 'Paris' });
  assert.equal(events.length, 0, 'already yours, no such city, not an id: ignored');

  a.eliminated = true;
  game.handleCommand(a, { t: 'takeCity', city: paris.id });
  assert.equal(paris.owner, b.id, 'not for spectators');
});
