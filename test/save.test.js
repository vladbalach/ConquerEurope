// Host handover, the game side: a running game saved as plain data (a checkpoint) and taken over from it
// by another player's browser (server/save.js, HostEngine with a `save`). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveGame, restoreGame, packSave, unpackSave } from '../server/save.js';
import { HostEngine } from '../server/host-engine.js';
import { Hero } from '../server/units/Hero.js';
import { Transport } from '../server/units/Transport.js';
import { GAME, HERO, TRADITIONS } from '../shared/config.js';
import { setup, map, nav } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

// A game with a bit of everything: units on the march, a Hero, a transport with units on board, a city
// building, research and a tradition under way, a few seconds of history.
function busyGame() {
  const s = setup();
  const { game, a, b, spawn, run } = s;
  const mine = game.cities.filter((c) => c.owner === a.id);
  const theirs = game.cities.filter((c) => c.owner === b.id);
  const walkers = [];
  for (let i = 0; i < 12; i++) {
    const c = mine[i];
    const u = spawn(a.id, ['infantry', 'archer', 'cavalry', 'knight'][i % 4], c.x + 25, c.y);
    game.orderGroupMove([u], theirs[i].x, theirs[i].y, true);
    walkers.push(u);
  }
  a.traditions = ['heroes'];
  a.honor = HERO.cost + TRADITIONS.mercy.cost;
  game.promote(a, walkers[0].id, 'hero');
  game.startLearning(a, 'mercy');
  const port = game.cities.find((c) => c.port && c.owner === b.id);
  const ship = spawn(b.id, 'transport', port.port.x, port.port.y);
  const rider = spawn(b.id, 'cavalry', port.x + 25, port.y);
  game.units.delete(rider.id);
  ship.cargo.push(rider);
  b.gold = 1000;
  game.startResearch(b, 'seafaring');
  assert.equal(b.research?.tech, 'seafaring');
  game.handleCommand(b, { t: 'build', cities: [theirs[0].id], item: 'infantry' });
  game.handleCommand(b, { t: 'build', cities: [theirs[0].id], item: 'wall' });
  run(3);
  return { ...s, walkers, ship };
}

test('a game saved and restored is the same game, down to every unit\'s orders and route', () => {
  const { game, ship } = busyGame();
  const save = JSON.parse(JSON.stringify(saveGame(game)));       // as it travels: plain JSON
  const copy = restoreGame(save, { map, nav, hostId: 1 });
  const again = saveGame(copy);
  assert.equal(again.game.nextUnitId, save.game.nextUnitId + 1000, 'new ids leave a gap: pages may know ids made after the save');
  again.game.nextUnitId = save.game.nextUnitId;
  assert.deepEqual(again, save);

  const hero = [...copy.units.values()].find((u) => u.type === 'hero');
  assert.ok(hero instanceof Hero, 'units come back as their own class');
  assert.equal(hero.kind, 'infantry');
  const boat = copy.units.get(ship.id);
  assert.ok(boat instanceof Transport);
  assert.equal(boat.cargo.length, 1);
  assert.equal(boat.cargo[0].type, 'cavalry', 'with the units on board');
  assert.ok(boat.cargo[0].game === copy && hero.game === copy, 'in the new game');
  assert.ok(copy.cities.every((c) => c.upgrades instanceof Set));
  assert.equal(copy.history.started, true, 'the history goes on');
  assert.ok([...copy.players.values()].every((p) => p.client === null), 'nobody is connected yet');
  assert.ok(save.players.every((p) => !('name' in p) && p.token === null), 'no nickname, no rejoin token in a save');
});

test('a restored game plays on: units keep marching, research and production finish', () => {
  const { game, b, walkers } = busyGame();
  const copy = restoreGame(JSON.parse(JSON.stringify(saveGame(game))), { map, nav, hostId: 0 });
  const dist = (g, u) => {
    const v = g.units.get(u.id);
    return Math.hypot(v.order.x - v.x, v.order.y - v.y);
  };
  const before = walkers.map((u) => dist(copy, u));
  const wall = copy.cities.find((c) => c.queue.includes('wall'));
  for (let t = 0; t < 30; t += 0.05) copy.tick(0.05);   // Seafaring takes 30 s
  // Attack-moving units stop to fight what they meet on the way: most of them, not all, get far.
  const marched = walkers.filter((u, i) => copy.units.get(u.id)?.order.kind === 'amove' && dist(copy, u) < before[i] - 100);
  assert.ok(marched.length >= walkers.length / 2, `${marched.length} of ${walkers.length} marched on`);
  const p = copy.players.get(b.id);
  assert.equal(p.tech.seafaring, 1, 'the research finished');
  assert.ok(wall.upgrades.has('wall'), 'the queue was built');
  assert.ok([...copy.units.values()].some((u) => u.id >= game.nextUnitId + 1000), 'new units get new ids');
});

test('a save packs to a few kilobytes and back', async () => {
  const { game } = busyGame();
  const save = saveGame(game);
  const packed = await packSave(save);
  assert.equal(typeof packed, 'string');
  assert.ok(packed.length < JSON.stringify(save).length / 3, 'compressed');
  assert.deepEqual(await unpackSave(packed), JSON.parse(JSON.stringify(save)));
});

// ---------------------------------------------------------------- HostEngine
function engine(opts, inbox) {
  return new HostEngine({
    gameId: '7', title: 'handover', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    send: (to, msg) => { if (!inbox.has(to)) inbox.set(to, []); inbox.get(to).push(msg); },
    ...opts,
  });
}
const steps = (e, seconds) => { for (let i = 0; i < seconds * GAME.tickRate; i++) e.step(); };
const events = (inbox, id) => (inbox.get(id) || []).filter((m) => m.t === 'event').map((m) => m.kind);

test('another browser takes the game over: the players come back without "is back", the old host and leavers do not', () => {
  // Player 1 hosts a game of three; everyone has loaded it and it runs.
  const inbox1 = new Map();
  const old = engine({ roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }, { id: 2, color: '#3cb44b' }], hostId: 1 }, inbox1);
  for (const id of [1, 0, 2]) old.connect(id);
  steps(old, GAME.startCountdown + 2);
  assert.equal(old.game.prestart, null);
  const cities2 = old.game.cities.filter((c) => c.owner === 2).map((c) => c.id);
  const save = JSON.parse(JSON.stringify(old.checkpoint()));
  assert.deepEqual(old.activePlayers().sort(), [0, 1, 2]);

  // Player 1's page is gone and player 2 left through the lobby: player 0 takes the game over.
  const inbox = new Map();
  const next = engine({ save, departed: [2], hostId: 0 }, inbox);
  assert.equal(next.game.time, save.game.time, 'from the checkpoint');
  assert.deepEqual([...next.game.players.keys()].sort(), [0, 1], 'the player who left is gone');
  assert.ok(cities2.every((id) => next.game.cities[id].owner === -1), 'and their empire with them');
  next.connect(0);                                           // the new host's own screen
  const start = inbox.get(0).find((m) => m.t === 'start');
  assert.equal(start.you, 0);
  assert.equal(start.prestart, null, 'the game is under way');
  steps(next, 1);
  assert.ok(next.game.time > save.game.time, 'and runs on');
  assert.ok(!events(inbox, 0).includes('reconnected'), 'nobody "is back": they never left');

  // The old host never comes back: once GAME.startWait is over, it shows as offline.
  steps(next, GAME.startWait - 2);
  assert.ok(!events(inbox, 0).includes('disconnected'), 'not yet');
  steps(next, 2);
  assert.equal(events(inbox, 0).filter((k) => k === 'disconnected').length, 1);
  assert.equal(next.game.players.get(1).connected, false);
  next.connect(1);                                           // ...until it rejoins, as any other player
  assert.ok(events(inbox, 0).includes('reconnected'));
  assert.equal(inbox.get(1).find((m) => m.t === 'start').you, 1);
});

test('a player who connects to the new host in time is never shown as offline', () => {
  const inbox1 = new Map();
  const old = engine({ roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }], hostId: 1 }, inbox1);
  for (const id of [1, 0]) old.connect(id);
  steps(old, GAME.startCountdown + 1);
  const inbox = new Map();
  const next = engine({ save: JSON.parse(JSON.stringify(old.checkpoint())), hostId: 0 }, inbox);
  next.connect(0);
  steps(next, 3);
  next.connect(1);                                           // the old host's page, reloaded
  steps(next, GAME.startWait);
  assert.deepEqual(events(inbox, 0), [], 'no "disconnected", no "is back"');
  assert.ok(next.game.players.get(1).connected);
  assert.ok(inbox.get(1).some((m) => m.t === 'snap'), 'it plays');
});
