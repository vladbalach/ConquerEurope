// Spectators: anyone in the lobby may watch a game (Watch), waiting or in progress, beside its players.
// They take no player's place (GAME.maxPlayers stays the limit), get the game from the host's browser like
// a player, play no part in it, and are never its host. Lobby server side with real WebSocket clients, and
// the host's game engine driven as its Web Worker drives it. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, games } from '../server/index.js';
import { Game } from '../server/game.js';
import { HostEngine } from '../server/host-engine.js';
import { GAME } from '../shared/config.js';
import { SPECTATOR_ID_BASE, isSpectatorId } from '../shared/protocol.js';
import { map, nav } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

const server = await startServer(0);
const port = server.address().port;
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  server.close();
});

const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// `hello`: extra fields of the first message (resume).
function connect(name, hello = {}) {
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
    name, inbox, ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    // The first message of this type (and matching `pred`) already received or still to come.
    waitFor(t, pred = () => true, ms = 3000) {
      const match = (m) => m.t === t && pred(m);
      const seen = inbox.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`${name}: no "${t}" message`)), ms);
      });
    },
    async close() {
      ws.close();
      await new Promise((r) => ws.once('close', r));
      await pause(50);
    },
  };
  return new Promise((resolve) => ws.on('open', () => {
    c.send({ t: 'hello', name, ...hello });
    resolve(c);
  }));
}

async function lobby(...names) {
  const list = await Promise.all(names.map((n) => connect(n)));
  await Promise.all(list.map((x) => x.waitFor('welcome')));
  return list;
}

// A waiting room: `players[0]` created it, the others joined; `watchers` watch it.
async function room(title, players, watchers = []) {
  const [first, ...rest] = players;
  first.send({ t: 'create', title });
  const { gameId } = await first.waitFor('joined');
  for (const p of rest) {
    p.send({ t: 'join', gameId });
    await p.waitFor('joined');
  }
  for (const s of watchers) {
    s.send({ t: 'watch', gameId });
    await s.waitFor('joined');
  }
  // The waiting room lists nicknames (allowed before the start): let its last version reach everyone.
  await Promise.all([...players, ...watchers].map((x) => x.waitFor('room',
    (m) => m.players.length === players.length && m.spectators.length === watchers.length)));
  return gameId;
}

test('anyone can watch a waiting game: a spectator has a place of their own, never a player\'s', async () => {
  const [ann, sue, lou] = await lobby('Ann_SP', 'Sue_SP', 'Lou_SP');
  const gameId = await room('watch room', [ann], [sue]);
  const joined = await sue.waitFor('joined');
  assert.equal(joined.spectator, true);
  assert.ok(isSpectatorId(joined.playerId) && joined.playerId >= SPECTATOR_ID_BASE, 'an id no player has');

  const roomMsg = await sue.waitFor('room', (m) => m.spectators.length === 1);
  assert.deepEqual(roomMsg.players.map((p) => p.name), ['Ann_SP'], 'not among the players');
  assert.deepEqual(roomMsg.spectators, [{ id: joined.playerId, name: 'Sue_SP' }]);
  assert.ok(!JSON.stringify(roomMsg.spectators).includes('#'), 'no colour');

  // The lobby lists them by nickname, apart from the players; a place to play is still free.
  const { games: list } = await lou.waitFor('games', (m) => m.games.some((g) => g.id === gameId && g.spectators.length === 1));
  const info = list.find((g) => g.id === gameId);
  assert.deepEqual(info.spectators, ['Sue_SP']);
  assert.equal(info.players.length, 1);
  assert.equal(info.canJoin, true);
  assert.equal(info.canWatch, true);
  assert.equal(info.maxSpectators, GAME.maxSpectators);

  // In the waiting room a spectator may play instead, and back; the only player may not watch.
  sue.inbox.length = 0;
  sue.send({ t: 'setRole', role: 'player' });
  const asPlayer = await sue.waitFor('joined');
  assert.ok(!asPlayer.spectator && asPlayer.playerId < GAME.maxPlayers);
  await ann.waitFor('room', (m) => m.players.length === 2 && m.spectators.length === 0);
  ann.inbox.length = 0;
  ann.send({ t: 'setRole', role: 'spectator' });           // the host, with another player in the room
  await ann.waitFor('joined', (m) => m.spectator);
  const handed = await sue.waitFor('room', (m) => m.players.length === 1 && m.spectators.length === 1);
  assert.equal(handed.hostId, asPlayer.playerId, 'the next player hosts the room');
  sue.inbox.length = 0;
  sue.send({ t: 'setRole', role: 'spectator' });
  assert.match((await sue.waitFor('error')).msg, /at least one player/);
});

test('spectators take none of the 20 places', () => {
  const game = new Game({ id: '1', title: 'full', map, nav });
  for (let i = 0; i < GAME.maxPlayers; i++) assert.ok(game.addPlayer({ name: `P${i}`, send() {} }).player);
  assert.equal(game.addPlayer({ name: 'P20', send() {} }).error, 'Game is full');
  for (let i = 0; i < GAME.maxSpectators; i++) assert.ok(game.addSpectator({ name: `S${i}`, send() {} }).spectator);
  assert.match(game.addSpectator({ name: 'S_more', send() {} }).error, /spectators/);
  assert.equal(game.players.size, GAME.maxPlayers);
  game.start();
  assert.equal(game.startedWith, GAME.maxPlayers, 'spectators are not players of the game');
  for (const s of game.spectators.values()) assert.equal(s.color, undefined, 'no colour for a spectator');
});

test('when the game starts, spectators connect to the host like players, but are not in its roster', async () => {
  const [ann, bob, sue] = await lobby('Ann_SS', 'Bob_SS', 'Sue_SS');
  const gameId = await room('watch start', [ann, bob], [sue]);
  const { playerId: sueId } = await sue.waitFor('joined');
  for (const x of [ann, bob, sue]) x.inbox.length = 0;
  ann.send({ t: 'start' });
  const host = await ann.waitFor('host');
  const toSue = await sue.waitFor('connectHost');
  await bob.waitFor('connectHost');
  assert.equal(toSue.you, sueId);
  assert.equal(toSue.epoch, host.epoch);
  assert.equal(host.roster.length, 2);
  assert.ok(!host.roster.some((r) => r.id === sueId), 'the host\'s game has two players');

  // Connection messages: the spectator reaches only the host, the host reaches the spectator.
  sue.send({ t: 'signal', to: host.you, data: { sdp: 'offer-from-sue' } });
  assert.deepEqual(await ann.waitFor('signal'), { t: 'signal', from: sueId, data: { sdp: 'offer-from-sue' } });
  ann.send({ t: 'signal', to: sueId, data: { sdp: 'answer-to-sue' } });
  assert.equal((await sue.waitFor('signal')).from, host.you);
  // ...and through the relay.
  sue.send({ t: 'relay', msg: { t: 'relayOpen' } });
  assert.deepEqual(await ann.waitFor('relay'), { t: 'relay', from: sueId, msg: { t: 'relayOpen' } });
  ann.send({ t: 'relay', to: sueId, msg: { t: 'snap', time: 1 } });
  assert.deepEqual(await sue.waitFor('relay'), { t: 'relay', msg: { t: 'snap', time: 1 } });
  assert.ok(!bob.inbox.some((m) => m.t === 'relay' || m.t === 'signal'), 'other players get nothing');

  // A spectator can't end the game, nor restart it.
  sue.send({ t: 'gameEnded', winner: 0 });
  await pause();
  assert.equal(games.get(gameId).status, 'running');
  const names = ['Ann_SS', 'Bob_SS', 'Sue_SS'];
  const sent = [...ann.inbox, ...bob.inbox, ...sue.inbox].filter((m) => m.t !== 'games');
  assert.ok(!names.some((n) => JSON.stringify(sent).includes(n)), 'no nickname reaches anyone while the game runs');

  // The end reveals everyone to the spectator too; the spectator is not among them.
  ann.send({ t: 'gameEnded', winner: host.you });
  const reveal = await sue.waitFor('reveal');
  assert.deepEqual(new Set(reveal.players.map((p) => p.name)), new Set(['Ann_SS', 'Bob_SS']));
});

test('a game in progress can be watched; a refresh keeps watching; leaving changes nothing', async () => {
  const [ann, bob, lou] = await lobby('Ann_SR', 'Bob_SR', 'Lou_SR');
  const gameId = await room('watch running', [ann, bob]);
  ann.send({ t: 'start' });
  const host = await ann.waitFor('host');
  await bob.waitFor('connectHost');

  // A started game takes no new player, but anyone may watch it.
  lou.send({ t: 'join', gameId });
  assert.match((await lou.waitFor('error')).msg, /already started/);
  lou.send({ t: 'watch', gameId });
  const joined = await lou.waitFor('joined');
  assert.equal(joined.spectator, true);
  assert.equal(joined.status, 'running');
  const toLou = await lou.waitFor('connectHost');
  assert.equal(toLou.you, joined.playerId);
  assert.equal(toLou.epoch, host.epoch);
  const [lobbyOnly] = await lobby('Max_SR');
  const listed = await lobbyOnly.waitFor('games', (m) => m.games.some((g) => g.id === gameId && g.spectators.length === 1));
  const info = listed.games.find((g) => g.id === gameId);
  assert.deepEqual(info.players, [{ name: 'Ann_SR' }, { name: 'Bob_SR' }], 'the players by nickname only, as before');
  assert.deepEqual(info.spectators, ['Lou_SR']);

  // The page is refreshed: it comes back as the same spectator, by its token.
  await lou.close();
  const again = await connect('Lou_SR', { resume: { gameId, token: joined.token } });
  const back = await again.waitFor('joined');
  assert.equal(back.spectator, true);
  assert.equal(back.playerId, joined.playerId);
  await again.waitFor('connectHost');

  // Leaving: the game goes on as it was.
  again.send({ t: 'leave' });
  await again.waitFor('games');
  const g = games.get(gameId);
  assert.equal(g.status, 'running');
  assert.equal(g.players.size, 2);
  assert.equal(g.spectators.size, 0);
});

test('spectators follow the game when its host leaves, and go back to the lobby when every player has left', async () => {
  const [ann, bob, sue] = await lobby('Ann_SH', 'Bob_SH', 'Sue_SH');
  const gameId = await room('watch handover', [ann, bob], [sue]);
  ann.send({ t: 'start' });
  const host = await ann.waitFor('host');
  const toBob = await bob.waitFor('connectHost');
  await sue.waitFor('connectHost');
  ann.send({ t: 'checkpoint', gameId, epoch: host.epoch, data: 'zSAVE', active: [host.you, toBob.you] });
  await pause(50);

  // The host leaves: the other player's browser takes the game over, and the spectator connects to it.
  sue.inbox.length = 0;
  ann.send({ t: 'leave' });
  const newHost = await bob.waitFor('host', (m) => m.save === 'zSAVE');
  const moved = await sue.waitFor('connectHost');
  assert.equal(moved.moved, true);
  assert.equal(moved.epoch, newHost.epoch);

  // The last player leaves: the game is gone, and so is the spectator, back to the lobby.
  bob.send({ t: 'leave' });
  assert.match((await sue.waitFor('kicked')).msg, /Every player has left/);
  assert.ok(!games.has(gameId));
});

test('a waiting room left by its last player sends its spectators back to the lobby', async () => {
  const [ann, sue] = await lobby('Ann_SL', 'Sue_SL');
  const gameId = await room('watch empty', [ann], [sue]);
  ann.send({ t: 'leave' });
  assert.match((await sue.waitFor('kicked')).msg, /Every player has left/);
  assert.ok(!games.has(gameId));
});

// ------------------------------------------------------------------ the host's browser
test('the host\'s game sends spectators the game, but they have no place in it and give no orders', () => {
  const SPEC = SPECTATOR_ID_BASE + 3;
  const inbox = new Map([[0, []], [1, []], [SPEC, []]]);
  const engine = new HostEngine({
    gameId: '9', title: 'watched', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }], hostId: 1,
    send: (to, msg) => inbox.get(to).push(msg),
  });
  const game = engine.game;
  const steps = (n) => { for (let i = 0; i < n; i++) engine.step(); };

  // The spectator connects first: they get the game, and the start still waits for both players.
  engine.connect(SPEC);
  const start = inbox.get(SPEC).find((m) => m.t === 'start');
  assert.equal(start.you, SPEC);
  assert.equal(start.spectator, true);
  assert.equal(start.goldPercent, undefined);
  assert.deepEqual(start.players.map((p) => p.id), [0, 1], 'a list of the players: the spectator is not one');
  engine.connect(1);
  engine.connect(0);
  assert.deepEqual(game.prestartInfo().total, 2);
  for (let i = 0; i < (GAME.startCountdown + 1) * GAME.tickRate && game.prestart; i++) engine.step();
  assert.equal(game.prestart, null, 'started');
  assert.equal(game.startedWith, 2);

  // Snapshots of what is in their view, and the players list, like a player who owns nothing.
  const c = game.cities.find((city) => city.owner === 0);
  engine.message(SPEC, { t: 'view', x0: c.x - 100, y0: c.y - 100, x1: c.x + 100, y1: c.y + 100 });
  inbox.get(SPEC).length = 0;
  steps(GAME.tickRate);
  const snap = inbox.get(SPEC).find((m) => m.t === 'snap');
  assert.ok(snap, 'snapshots');
  assert.equal(snap.g, 0);
  assert.deepEqual(snap.q, [], 'no cities of their own');
  assert.equal(snap.c[c.id * 3], 0, 'every city\'s owner');
  assert.ok(inbox.get(SPEC).some((m) => m.t === 'score'), 'the players list');

  // Orders do nothing, nor does surrendering; nobody is told a spectator came or went.
  const goldBefore = [...game.players.values()].map((p) => p.gold);
  engine.message(SPEC, { t: 'build', city: c.id, item: 'infantry' });
  engine.message(SPEC, { t: 'surrender' });
  assert.deepEqual([...game.players.values()].map((p) => p.gold), goldBefore);
  assert.ok(![...game.players.values()].some((p) => p.surrendered));
  assert.deepEqual(c.queue, []);
  engine.disconnect(SPEC);
  engine.connect(SPEC);
  const events = [...inbox.get(0), ...inbox.get(1)].filter((m) => m.t === 'event').map((m) => m.kind);
  assert.ok(!events.includes('disconnected') && !events.includes('reconnected'));

  // The end of the game reaches them too; then they leave and get nothing more.
  game.end(0);
  assert.ok(inbox.get(SPEC).some((m) => m.t === 'gameover'));
  engine.message(SPEC, { t: 'leave' });
  assert.ok(!game.spectators.has(SPEC));
  inbox.get(SPEC).length = 0;
  game.sendScores();
  assert.deepEqual(inbox.get(SPEC), []);
});
