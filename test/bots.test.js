// Bots: the game option "With bots" in the waiting room, bots handed to the host's browser with the roster,
// and what they do there (server/bots.js). Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Game } from '../server/game.js';
import { HostEngine } from '../server/host-engine.js';
import { Bots } from '../server/bots.js';
import { saveGame } from '../server/save.js';
import { startServer } from '../server/index.js';
import { BOTS, GAME, PLAYER_COLORS, UNITS } from '../shared/config.js';
import { botCount } from '../shared/options.js';
import { map, nav, setup } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const MAP = readJson('public', 'map.json');
const NAV = readJson('server', 'data', 'navgrid.json');
const client = (name) => ({ name, send() {} });

test('"With bots" follows the waiting room (on while the host is alone) until the host sets it', () => {
  const g = new Game({ id: '1', title: 't', map, nav });
  assert.equal(g.options.bots, true, 'on in a new room');
  g.addPlayer(client('A'));
  assert.equal(g.options.bots, true, 'the host alone');
  const b = g.addPlayer(client('B')).player;
  assert.equal(g.options.bots, false, 'off once someone joins');
  g.setOptions({ countdown: 'none' });
  assert.equal(g.options.bots, false, 'another option changed: still in step with the room');
  g.removePlayer(b.id);
  assert.equal(g.options.bots, true, 'on again when the host is alone again');

  g.setOptions({ bots: false });
  const c = g.addPlayer(client('C')).player;
  g.removePlayer(c.id);
  assert.equal(g.options.bots, false, 'set by hand to No: it stays so, alone again or not');
  g.setOptions({ bots: true });
  const d = g.addPlayer(client('D')).player;
  assert.equal(g.options.bots, true, 'set by hand to Yes: it stays so when someone joins...');
  g.removePlayer(d.id);
  assert.equal(g.options.bots, true, '...and leaves');
});

test('a game started with bots gets BOTS.count of them, with ids and colours dealt together with the players', () => {
  const g = new Game({ id: '1', title: 't', map, nav });
  g.addPlayer(client('A'));
  assert.ok(g.beginStart());
  assert.equal(g.bots.length, BOTS.count);
  assert.equal(g.players.size, 1, 'the lobby keeps its players apart from its bots');
  const ids = [...g.players.keys(), ...g.bots.map((x) => x.id)];
  assert.deepEqual([...ids].sort((x, y) => x - y), [...Array(1 + BOTS.count).keys()], 'ids 0.. without gaps');
  const colors = [...g.players.values(), ...g.bots].map((x) => x.color);
  assert.equal(new Set(colors).size, colors.length, 'a colour each');
  assert.ok(colors.every((c) => PLAYER_COLORS.includes(c)));

  const none = new Game({ id: '2', title: 't', map, nav });
  none.addPlayer(client('A'));
  none.setOptions({ bots: false });
  none.beginStart();
  assert.equal(none.bots.length, 0, 'With bots: No');
  assert.equal(botCount({ bots: true }, GAME.maxPlayers - 2), 2, 'only as many as there is room for');
  assert.equal(botCount({ bots: true }, GAME.maxPlayers), 0);
});

// A game run by the host's browser: player 0 hosts, the others are bots.
function botGame(bots = 2, options = {}) {
  const inbox = [];
  const ended = [];
  const roster = [{ id: 0, color: PLAYER_COLORS[0] }];
  for (let i = 1; i <= bots; i++) roster.push({ id: i, color: PLAYER_COLORS[i], bot: true });
  const engine = new HostEngine({
    gameId: '5', title: 'bots', map: MAP, navData: NAV, roster, hostId: 0, options,
    send: (to, msg) => inbox.push(msg), onEnded: (w) => ended.push(w),
  });
  const run = (seconds) => { for (let i = 0; i < seconds * GAME.tickRate && engine.game.status === 'running'; i++) engine.step(); };
  return { engine, game: engine.game, inbox, ended, run };
}

test('the host\'s browser has the bots as players: online, known as bots, and the start waits for nobody else', () => {
  const { engine, game, inbox, run } = botGame(2);
  const bot = game.players.get(1);
  assert.equal(bot.bot, true);
  assert.equal(bot.connected, true, 'a bot is never offline');
  engine.connect(0);
  const start = inbox.find((m) => m.t === 'start');
  assert.deepEqual(start.prestart, { loaded: 1, total: 1, left: null }, 'bots are not players to wait for');
  assert.deepEqual(start.players.map((p) => !!p.bot), [false, true, true], 'everyone sees who is a bot');
  assert.ok(start.players.every((p) => p.name === undefined), 'nobody has a nickname in the game');
  run(GAME.startCountdown + 1);
  assert.equal(game.prestart, null, 'started');

  engine.connect(1);                                  // nobody connects as a bot...
  engine.disconnect(1);
  engine.message(1, { t: 'surrender' });
  assert.equal(bot.connected, true, '...or speaks for one');
  assert.equal(bot.surrendered, false);
});

test('bots train units with their own gold and take neutral cities', () => {
  const { engine, game, run } = botGame(3);
  const bots = [...game.players.values()].filter((p) => p.bot);
  engine.connect(0);
  run(GAME.startCountdown + 3);
  for (const b of bots) {
    assert.ok(b.gold < game.options.startGold, 'it spends its gold...');
    assert.ok(game.cities.some((c) => c.owner === b.id && c.queue.length), '...on units in its cities');
  }
  run(4 * 60);
  assert.ok(bots.every((b) => b.unitCount > 0), 'every bot has an army');
  assert.ok(bots.some((b) => b.cityCount > GAME.startCities), 'and some have taken cities');
  assert.equal(game.status, 'running');
  const ids = new Set(bots.map((b) => b.id));
  const trained = [...[...game.units.values()].filter((u) => ids.has(u.owner)).map((u) => u.type),
    ...game.cities.filter((c) => ids.has(c.owner)).flatMap((c) => c.queue)];
  assert.ok(trained.length && !trained.includes('cavalry'), 'never cavalry');
});

test('in the first turn a bot trains infantry only, 4 of them in one city, and once they are out they attack', () => {
  const { engine, game, run } = botGame(1);
  const bot = game.players.get(1);
  engine.connect(0);
  run(GAME.startCountdown + 3);
  const queues = game.cities.filter((c) => c.owner === bot.id && c.queue.length).map((c) => c.queue);
  assert.ok(queues.flat().every((item) => item === 'infantry'), 'infantry only');
  assert.equal(queues.flat().length, Math.floor(game.options.startGold / UNITS.infantry.cost), 'all its start gold');
  assert.equal(Math.max(...queues.map((q) => q.length)), BOTS.queue, '4 in one city: its first army');
  // Trained one after another; once the 4th is out, they march on a neutral city. (A city shooting at them
  // before that, they may take it on their own.)
  run(BOTS.queue * UNITS.infantry.buildTime + BOTS.thinkSeconds + 1);
  const sent = [...game.ai.minds.get(bot.id).sent.values()];
  assert.ok(sent.length === BOTS.queue || bot.cityCount > GAME.startCities, 'the 4 infantry attack');
  assert.ok(sent.every((id) => id === sent[0]), 'all against one city');
  assert.equal(game.turn, 0, 'all in the first turn');
});

test('in the first turns a bot marches on neutral cities only; later on players\' too', () => {
  const { game, a, b } = setup();
  const p = game.players.get(b.id);
  p.bot = true;
  const ai = new Bots(game);
  const land = ai.cityLand();
  // One of B's cities with one of A's close by, on the same land: B's army stands next to it.
  const pairs = game.cities.filter((c) => c.owner === b.id).flatMap((c) => game.cities
    .filter((o) => o.owner === a.id && land[o.id] && land[o.id] === land[c.id]).map((o) => [c, o, Math.hypot(c.x - o.x, c.y - o.y)]));
  const [home, enemy] = pairs.sort((x, y) => x[2] - y[2])[0];
  const at = { x: (home.x + enemy.x) / 2, y: (home.y + enemy.y) / 2 };
  for (const c of game.cities) if (c.owner < 0) c.owner = a.id;    // no neutral city anywhere: only A's
  game.unitGrid.clear();                              // no unit defends A's cities
  const army = (infantry, archers = 0) => [
    ...Array.from({ length: infantry }, () => ({ type: 'infantry' })), ...Array.from({ length: archers }, () => ({ type: 'archer' }))];
  const target = (units) => ai.pickTarget(p, units, at, land[home.id], land);
  game.turn = 0;
  assert.equal(target(army(BOTS.maxArmy)), null, 'no neutral city: it waits');
  game.turn = BOTS.graceTurns;
  assert.equal(target(army(BOTS.maxArmy))?.owner, a.id, 'after the grace turns: a player\'s city');
  assert.equal(target(army(1)), null, 'one unit is not an army');
  assert.equal(target(army(0, BOTS.maxArmy)), null, 'never without infantry');
  assert.equal(target(army(1, BOTS.attackPlayer))?.owner, a.id, 'a player\'s city: units of any kind, infantry among them');

  // A neutral city by the army: 4 infantry are enough; archers don't count.
  enemy.owner = -1;
  game.turn = 0;
  assert.equal(target(army(BOTS.attackNeutral)), enemy);
  assert.equal(target(army(BOTS.attackNeutral - 1, BOTS.maxArmy)), null, 'infantry is what counts');
  assert.equal(target(army(0, BOTS.maxArmy)), null);
});

test('once no player is left in the game, the bot with the most cities wins', () => {
  const { engine, game, ended, run } = botGame(2);
  engine.connect(0);
  run(GAME.startCountdown + 1);
  const leader = game.players.get(2);
  game.cities.find((c) => c.owner < 0).owner = leader.id;            // one city more than the other bot
  engine.message(0, { t: 'surrender' });
  assert.equal(game.status, 'ended', 'the bots don\'t play on by themselves');
  assert.equal(game.winner, leader.id);
  engine.step();
  assert.deepEqual(ended, [leader.id], 'the page tells the lobby server');
});

test('a takeover keeps the bots: still bots, still online, and they play on in the new host\'s browser', () => {
  const inbox = new Map([[0, []], [1, []]]);
  const roster = [{ id: 0, color: PLAYER_COLORS[0] }, { id: 1, color: PLAYER_COLORS[1] }, { id: 2, color: PLAYER_COLORS[2], bot: true }];
  const make = (hostId, save = null) => new HostEngine({
    gameId: '6', title: 'handover', map: MAP, navData: NAV, roster: save ? undefined : roster, hostId, save,
    send: (to, msg) => inbox.get(to)?.push(msg), onEnded() {},
  });
  const first = make(0);
  first.connect(0);
  first.connect(1);
  for (let i = 0; i < (GAME.startCountdown + 5) * GAME.tickRate; i++) first.step();
  const second = make(1, saveGame(first.game));
  second.connect(1);
  inbox.get(1).length = 0;
  for (let i = 0; i < (GAME.startWait + 5) * GAME.tickRate; i++) second.step();
  const bot = second.game.players.get(2);
  assert.equal(bot.bot, true);
  assert.equal(bot.connected, true, 'not offline after the wait for players to come back');
  const events = inbox.get(1).filter((m) => m.t === 'event' && m.player === 2).map((m) => m.kind);
  assert.ok(!events.includes('disconnected'), 'nobody is told a bot lost its connection');
  assert.ok(second.game.ai instanceof Bots, 'the new host plays the bot');
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

test('a host who starts alone gets the bots in the roster; the end reveals them as bots, without a nickname', async () => {
  const [host, guest] = await Promise.all([connect('Solo_Bots'), connect('Guest_Bots')]);
  await Promise.all([host.waitFor('welcome'), guest.waitFor('welcome')]);
  host.send({ t: 'create', title: 'bots' });
  const { gameId } = await host.waitFor('joined');
  assert.equal((await host.waitFor('room')).options.bots, true, 'alone in the room: with bots');
  guest.send({ t: 'join', gameId });
  assert.equal((await host.waitFor('room', (m) => m.players.length === 2)).options.bots, false, 'someone joined: without');
  host.inbox.length = 0;
  guest.send({ t: 'leave' });
  assert.equal((await host.waitFor('room', (m) => m.players.length === 1)).options.bots, true, 'alone again: with bots again');

  host.send({ t: 'start' });
  const handOver = await host.waitFor('host');
  const bots = handOver.roster.filter((r) => r.bot);
  assert.equal(bots.length, BOTS.count);
  assert.equal(handOver.roster.length, 1 + BOTS.count);
  for (const r of bots) assert.deepEqual(Object.keys(r).sort(), ['bot', 'color', 'id'], 'no nickname, no gold percentage');

  host.send({ t: 'gameEnded', winner: bots[0].id });
  const reveal = await host.waitFor('reveal');
  assert.equal(reveal.winner, bots[0].id);
  const revealed = reveal.players.filter((p) => p.bot);
  assert.deepEqual(revealed.map((p) => p.id).sort(), bots.map((r) => r.id).sort());
  assert.ok(revealed.every((p) => p.name === null && p.color), 'bots by colour only');
  assert.ok(reveal.players.some((p) => p.name === 'Solo_Bots'));
});
