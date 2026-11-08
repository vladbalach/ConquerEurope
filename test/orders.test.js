// Unit orders: hold position (H key) and the attack-move from a city to its rally point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const moved = (u, x, y) => Math.hypot(u.x - x, u.y - y);

test('new units attack-move from their city to the rally point', () => {
  const { game, a, city, run } = setup();
  const paris = city('Paris');
  game.handleCommand(a, { t: 'rally', cities: [paris.id], x: paris.x - 60, y: paris.y });
  const u = game.spawnUnit(paris, 'infantry');
  assert.equal(u.order.kind, 'amove', 'walks there ready to fight, not as a plain move');
  run(6);
  assert.ok(moved(u, paris.rally.x, paris.rally.y) < 30, 'and gets there');
});

test('a unit on hold does not chase an enemy out of reach', () => {
  const { game, a, b, city, spawn, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const mine = spawn(a.id, 'infantry', x, y);
  const enemy = spawn(b.id, 'infantry', x - 50, y);      // in sight, out of reach
  game.handleCommand(a, { t: 'hold', ids: [mine.id] });
  enemy.orderHold();
  run(3);
  assert.equal(mine.order.kind, 'hold');
  assert.ok(moved(mine, x, y) < 0.5, `stood still (moved ${moved(mine, x, y).toFixed(2)})`);
  assert.equal(enemy.hp, enemy.maxHp, 'nothing to hit from here');
});

test('a unit on hold hits an enemy within reach', () => {
  const { a, b, city, spawn, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const archer = spawn(a.id, 'archer', x, y);
  const enemy = spawn(b.id, 'infantry', x - archer.stats.attackRange + 2, y);
  archer.orderHold();
  enemy.orderHold();
  enemy.hp = 1e6;
  run(2);
  assert.ok(enemy.hp < 1e6, 'the enemy took damage');
  assert.ok(moved(archer, x, y) < 0.5, 'without stepping forward');
});

test('walking units cannot push a unit on hold aside', () => {
  const { a, city, spawn, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const post = spawn(a.id, 'infantry', x, y);
  post.orderHold();
  const walkers = [];
  for (let i = 0; i < 6; i++) {
    const w = spawn(a.id, 'infantry', x + 40, y + (i - 2.5) * 4);
    w.orderMove(x - 40, y, false);
    walkers.push(w);
  }
  run(4);
  assert.ok(moved(post, x, y) < 0.5, `held its spot (moved ${moved(post, x, y).toFixed(2)})`);
  assert.ok(walkers.every((w) => w.x < x), 'the others went around it');
});

// Clicking the same spot again and again must not hold the units up: every new order sets off
// on the next tick, not once the last route search is REPLAN_INTERVAL old.
test('repeated move orders do not stall the units', () => {
  const { game, a, city, spawn, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const units = [spawn(a.id, 'infantry', x, y), spawn(a.id, 'infantry', x, y + 8), spawn(a.id, 'archer', x + 8, y + 4)];
  const ids = units.map((u) => u.id);
  const tx = x - 80;
  let stalled = 0;
  for (let i = 0; i < 20; i++) {          // a click every 0.1 s for 2 s
    game.handleCommand(a, { t: 'move', ids, x: tx, y });
    const before = units.map((u) => u.x);
    run(0.05);
    stalled += units.filter((u, k) => u.x === before[k]).length;
    run(0.05);
  }
  assert.equal(stalled, 0, `units stood still on ${stalled} ticks right after an order`);
  const speed = units[0].stats.moveSpeed;
  assert.ok(x - units[0].x > speed * 2 * 0.8, `kept walking (moved ${(x - units[0].x).toFixed(1)} of ${speed * 2})`);
});

test('a move order ends hold', () => {
  const { game, a, city, spawn, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const u = spawn(a.id, 'infantry', x, y);
  game.handleCommand(a, { t: 'hold', ids: [u.id] });
  game.handleCommand(a, { t: 'move', ids: [u.id], x: x - 40, y });
  assert.equal(u.order.kind, 'move');
  run(3);
  assert.ok(moved(u, x - 40, y) < 5, 'walked to the new spot');
});
