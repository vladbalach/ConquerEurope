// Game options from the waiting room: cities to win and the countdown. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { DEFAULT_OPTIONS, sanitizeOptions, citiesToWin } from '../shared/options.js';
import { GAME } from '../shared/config.js';
import { Game } from '../server/game.js';
import { HostEngine } from '../server/host-engine.js';
import { startServer } from '../server/index.js';
import { setup, map, nav } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('defaults: 120 cities, countdown from the start, turn 10 for "from turn", fallen players become liberators', () => {
  const defaults = { countdown: 'start', countdownTurn: 10, winCities: 120, death: 'liberator' };
  assert.deepEqual({ ...DEFAULT_OPTIONS }, defaults);
  assert.deepEqual(sanitizeOptions(undefined, 208), defaults);
  assert.deepEqual(new Game({ id: '1', title: 't', map, nav }).options, { ...DEFAULT_OPTIONS });
});

test('countdown: none keeps the target, "from start" drops it every turn, "from turn N" after turn N', () => {
  const none = { countdown: 'none', countdownTurn: 10, winCities: 120 };
  const start = { countdown: 'start', countdownTurn: 10, winCities: 120 };
  const fromTurn = { countdown: 'turn', countdownTurn: 10, winCities: 120 };
  for (const t of [0, 1, 50, 500]) assert.equal(citiesToWin(none, t), 120);
  // `turn` is the number of turns over: 120 in the first turn, 119 in the second, ...
  assert.deepEqual([0, 1, 2, 10].map((t) => citiesToWin(start, t)), [120, 119, 118, 110]);
  assert.deepEqual([0, 9, 10, 11, 12, 20].map((t) => citiesToWin(fromTurn, t)), [120, 120, 120, 119, 118, 110]);
  assert.equal(citiesToWin(start, 1000), 1, 'never below one city');
  assert.equal(citiesToWin({ ...start, winCities: 50 }, 3), 47, 'counts down from the chosen target');
});

test('options are checked and clamped: unknown modes, junk and out-of-range numbers', () => {
  assert.deepEqual(sanitizeOptions({ countdown: 'sometimes', countdownTurn: 'x', winCities: null }, 208),
    { ...DEFAULT_OPTIONS });
  assert.deepEqual(sanitizeOptions({ countdown: 'turn', countdownTurn: '25', winCities: '150', death: 'liberator' }, 208),
    { countdown: 'turn', countdownTurn: 25, winCities: 150, death: 'liberator' }, 'numbers from form fields');
  assert.equal(sanitizeOptions({ death: 'zombie' }, 208).death, 'liberator', 'unknown death mode: the default');
  assert.equal(sanitizeOptions({ winCities: 5000 }, 208).winCities, 208, 'not more than the map has');
  assert.equal(sanitizeOptions({ winCities: 3 }, 208).winCities, GAME.startCities + 1, 'more than you start with');
  assert.equal(sanitizeOptions({ countdownTurn: 0 }, 208).countdownTurn, 1);
  assert.equal(sanitizeOptions({ countdownTurn: 12.6 }, 208).countdownTurn, 13);
  assert.equal(sanitizeOptions({ countdownTurn: Infinity }, 208).countdownTurn, DEFAULT_OPTIONS.countdownTurn);
});

// setup() gives A and B half the map each: how many cities a player holds.
const held = (game, p) => game.cities.filter((c) => c.owner === p.id).length;

test('the game ends when someone holds the current target, which the countdown lowers', () => {
  const { game, a, b } = setup();
  const n = held(game, a);                            // A and B hold n cities each
  game.options = { countdown: 'turn', countdownTurn: 5, winCities: n + 5 };
  const from = game.cities.find((c) => c.owner === b.id);
  from.owner = a.id;                                  // A n + 1, B n - 1
  game.turn = 5;
  game.recount();
  assert.equal(game.status, 'running', 'turn 5: still n + 5');
  game.turn = 8;                                      // n + 5 - 3 = n + 2
  game.recount();
  assert.equal(game.status, 'running');
  game.turn = 9;                                      // n + 1
  game.recount();
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, a.id);
  assert.notEqual(game.winner, b.id);
});

test('when the target reaches several players, the most cities win; an exact tie plays on', () => {
  const { game, a, b } = setup();
  const n = held(game, a);                            // n each
  game.options = { countdown: 'start', countdownTurn: 10, winCities: 120 };
  game.turn = 120 - n;                                // target n: both reach it with the same count
  game.recount();
  assert.equal(game.status, 'running', 'a tie is not a win');
  const city = game.cities.find((c) => c.owner === a.id);
  city.owner = b.id;                                  // B pulls ahead: n + 1 to n - 1
  game.recount();
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, b.id);
});

test('without a countdown the target stays where the host set it', () => {
  const { game, a } = setup();
  const n = held(game, a);                            // n each
  game.options = { countdown: 'none', countdownTurn: 10, winCities: n + 1 };
  game.turn = 200;
  game.recount();
  assert.equal(game.status, 'running', 'n cities are not n + 1');
  game.options = { ...game.options, winCities: n };
  game.cities.find((c) => c.owner === 1).owner = 0;   // n + 1 to n - 1: player 0 holds enough
  game.recount();
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, 0);
});

test('the host\'s browser runs the game with the options from the lobby, and tells every player', () => {
  const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
  const sent = [];
  const options = { countdown: 'turn', countdownTurn: 3, winCities: 60, death: 'liberator' };
  const engine = new HostEngine({
    gameId: '9', title: 'opts', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }], hostId: 0, options,
    send: (to, msg) => sent.push(msg), onEnded() {},
  });
  assert.deepEqual(engine.game.options, options);
  engine.connect(0);
  assert.deepEqual(sent.find((m) => m.t === 'start').options, options);
});

// ------------------------------------------------------------------ lobby server
const server = await startServer(0);
const port = server.address().port;
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  server.close();
});

function connect(name) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  sockets.push(ws);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const c = {
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(t, pred = () => true, ms = 3000) {
      const match = (m) => m.t === t && pred(m);
      const seen = inbox.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`${name}: no "${t}" message`)), ms);
      });
    },
  };
  return new Promise((resolve) => ws.on('open', () => {
    c.send({ t: 'hello', name });
    resolve(c);
  }));
}

test('only the host sets the options in the waiting room; everyone sees them and the host\'s game gets them', async () => {
  const [host, guest] = await Promise.all([connect('Host_Opts'), connect('Guest_Opts')]);
  await Promise.all([host.waitFor('welcome'), guest.waitFor('welcome')]);
  host.send({ t: 'create', title: 'options' });
  const { gameId } = await host.waitFor('joined');
  guest.send({ t: 'join', gameId });
  const room = await guest.waitFor('room', (m) => m.players.length === 2);
  assert.deepEqual(room.options, { ...DEFAULT_OPTIONS }, 'a new game has the defaults');

  host.send({ t: 'setOptions', options: { countdown: 'turn', countdownTurn: 15, winCities: 999, death: 'liberator' } });
  const changed = await guest.waitFor('room', (m) => m.options.countdown === 'turn');
  const expected = { countdown: 'turn', countdownTurn: 15, winCities: map.cities.length, death: 'liberator' };
  assert.deepEqual(changed.options, expected, 'clamped');

  guest.inbox.length = 0;
  guest.send({ t: 'setOptions', options: { countdown: 'none' } });
  await assert.rejects(guest.waitFor('room', (m) => m.options.countdown === 'none', 400), 'a guest cannot change them');

  host.send({ t: 'start' });
  const handOver = await host.waitFor('host');
  assert.deepEqual(handOver.options, expected);

  host.send({ t: 'setOptions', options: { countdown: 'none' } });
  host.send({ t: 'list' });
  const { games } = await host.waitFor('games', (m) => m.games.some((g) => g.id === gameId));
  assert.equal(games.find((g) => g.id === gameId).options.countdown, 'turn', 'fixed once the game has started');
});
