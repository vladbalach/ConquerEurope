// Shift + right-click: orders queued behind the current one, carried out one after another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, nav, DT } from './helpers.js';

const dist = (u, x, y) => Math.hypot(u.x - x, u.y - y);

// A field west of Lyon (player A's side), and `order` for several commands in a row.
function field() {
  const s = setup();
  const lyon = s.city('Lyon');
  const order = (msg) => {
    s.a.commandTokens = 10;
    s.game.handleCommand(s.a, msg);
  };
  // Tick until `done()` is true (or the time is up); `each` runs after every tick.
  const until = (done, seconds, each = () => {}) => {
    for (let t = 0; t < seconds && !done(); t += DT) {
      s.game.tick(DT);
      each();
    }
  };
  return { ...s, order, until, x: lyon.x - 60, y: lyon.y };
}

test('Shift-queued moves are walked one after another', () => {
  const { a, spawn, order, until, x, y } = field();
  const u = spawn(a.id, 'infantry', x, y);
  order({ t: 'move', ids: [u.id], x: x - 30, y });
  order({ t: 'move', ids: [u.id], x: x - 30, y: y + 30, queue: true });
  assert.equal(u.order.kind, 'move');
  assert.equal(u.queue.length, 1, 'the second move waits');
  let first = false;
  until(() => u.order.kind === 'idle', 15, () => { if (dist(u, x - 30, y) < 3) first = true; });
  assert.ok(first, 'went to the first place');
  assert.ok(dist(u, x - 30, y + 30) < 3, `then to the second (${dist(u, x - 30, y + 30).toFixed(1)} away)`);
});

test('a unit with nothing to do starts a Shift order at once', () => {
  const { a, spawn, order, x, y } = field();
  const u = spawn(a.id, 'infantry', x, y);
  order({ t: 'move', ids: [u.id], x: x - 30, y, queue: true });
  assert.equal(u.order.kind, 'move');
  assert.equal(u.queue.length, 0);
});

test('an order without Shift replaces the queue, and so does stop', () => {
  const { a, spawn, order, x, y } = field();
  const u = spawn(a.id, 'infantry', x, y);
  order({ t: 'move', ids: [u.id], x: x - 30, y });
  order({ t: 'move', ids: [u.id], x: x - 30, y: y + 30, queue: true });
  order({ t: 'move', ids: [u.id], x: x + 20, y });
  assert.equal(u.order.x, x + 20);
  assert.equal(u.queue.length, 0);
  order({ t: 'move', ids: [u.id], x: x - 30, y, queue: true });
  assert.equal(u.queue.length, 1);
  order({ t: 'stop', ids: [u.id] });
  assert.equal(u.order.kind, 'idle');
  assert.equal(u.queue.length, 0);
});

test('a queued attack starts after the move, and the next order once the target is dead', () => {
  const { a, b, spawn, order, until, x, y } = field();
  const u = spawn(a.id, 'infantry', x, y);
  const enemy = spawn(b.id, 'infantry', x - 60, y);
  enemy.orderHold();
  enemy.hp = 5;
  order({ t: 'move', ids: [u.id], x: x - 30, y });
  order({ t: 'attack', ids: [u.id], k: 'u', id: enemy.id, queue: true });
  order({ t: 'move', ids: [u.id], x: x - 30, y: y + 30, queue: true });
  assert.equal(u.order.kind, 'move', 'walks first');
  until(() => u.order.kind === 'attack', 10);
  assert.equal(u.order.kind, 'attack');
  assert.ok(dist(u, x - 30, y) < 5, 'having got to the first place');
  until(() => u.order.kind === 'idle', 20);
  assert.ok(enemy.hp <= 0, 'the enemy is dead');
  assert.ok(dist(u, x - 30, y + 30) < 3, 'and the unit walked on to the last place');
});

test('a queued attack on a target that is already gone is skipped', () => {
  const { a, b, game, spawn, order, until, x, y } = field();
  const u = spawn(a.id, 'infantry', x, y);
  const enemy = spawn(b.id, 'infantry', x - 80, y);
  enemy.orderHold();
  order({ t: 'move', ids: [u.id], x: x - 30, y });
  order({ t: 'attack', ids: [u.id], k: 'u', id: enemy.id, queue: true });
  order({ t: 'move', ids: [u.id], x: x - 30, y: y + 30, queue: true });
  enemy.hp = 0;
  game.tick(DT);
  let attacked = false;
  until(() => u.order.kind === 'idle', 15, () => { if (u.order.kind === 'attack') attacked = true; });
  assert.ok(!attacked, 'never went after the dead enemy');
  assert.ok(dist(u, x - 30, y + 30) < 3);
});

test('queued moves keep the group in formation', () => {
  const { a, spawn, order, until, x, y } = field();
  const group = [-6, -2, 2, 6].map((dy) => spawn(a.id, 'infantry', x, y + dy));
  const ids = group.map((u) => u.id);
  order({ t: 'move', ids, x: x - 30, y });
  order({ t: 'move', ids, x: x - 30, y: y + 30, queue: true });
  const spots = group.map((u) => [u.queue[0].x, u.queue[0].y]);
  assert.equal(new Set(spots.map((p) => p.join())).size, group.length, 'each unit has its own spot');
  until(() => group.every((u) => u.order.kind === 'idle'), 20);
  group.forEach((u, i) => assert.ok(dist(u, ...spots[i]) < 8, `unit ${i} got to its spot`));
});

test('snapshots show your units\' queued orders', () => {
  const { a, game, spawn, order, x, y } = field();
  const sent = [];
  a.client = { send: (m) => sent.push(m) };
  const u = spawn(a.id, 'infantry', x, y);
  const idle = spawn(a.id, 'infantry', x, y + 10);
  order({ t: 'move', ids: [u.id], x: x - 30, y });
  order({ t: 'move', ids: [u.id], x: x - 30, y: y + 30, amove: true, queue: true });
  game.sendSnapshots();
  const snap = sent.filter((m) => m.t === 'snap').pop();
  const r = Math.round;
  assert.deepEqual(snap.w, [[u.id, 0, r(x - 30), r(y), 1, r(x - 30), r(y + 30)]], 'only units with a queue');
  assert.ok(!snap.w.some(([id]) => id === idle.id));
});

test('ships sail Shift-queued legs one after another', () => {
  const { a, city, spawn, order, until } = field();
  const brest = city('Brest');
  const sea = brest.port.sea;
  const start = nav.nearestSea(brest.port.x - 60, brest.port.y, 40, sea);
  const p1 = nav.nearestSea(brest.port.x - 100, brest.port.y, 40, sea);
  const p2 = nav.nearestSea(brest.port.x - 100, brest.port.y + 40, 40, sea);
  const ship = spawn(a.id, 'transport', ...start);
  order({ t: 'move', ids: [ship.id], x: p1[0], y: p1[1] });
  order({ t: 'move', ids: [ship.id], x: p2[0], y: p2[1], queue: true });
  assert.equal(ship.queue.length, 1);
  let first = false;
  until(() => ship.order.kind === 'idle', 40, () => { if (dist(ship, ...p1) < 5) first = true; });
  assert.ok(first, 'sailed to the first place');
  assert.ok(dist(ship, ...p2) < 5, 'then to the second');
});
