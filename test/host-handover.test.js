// Host handover, lobby server side: the host's browser sends checkpoints; when the host leaves, its page
// is closed or reloaded, or its connection stays gone, another player's browser takes the game over from
// the last one, and the old host comes back as any other player. Runs the real server in-process with real
// WebSocket clients. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, games, timing } from '../server/index.js';

const server = await startServer(0);
const port = server.address().port;
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  server.close();
});
timing.hostGrace = 300;

const NAMES = ['Ann_HO', 'Ben_HO', 'Cid_HO'];
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const SAVE = 'zSAVEDGAME';                 // what a host's page sends: packed, never read by the server

// `hello`: extra fields of the first message (resume, hosting).
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
    // Closed: wait until the server has seen it.
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

// Three players in one started game: A hosts and has sent a checkpoint.
async function startedGame(title, checkpoint = true) {
  const [a, b, c] = await Promise.all(NAMES.map((n) => connect(n)));
  await Promise.all([a, b, c].map((x) => x.waitFor('welcome')));
  a.send({ t: 'create', title });
  const joinedA = await a.waitFor('joined');
  const gameId = joinedA.gameId;
  b.send({ t: 'join', gameId });
  c.send({ t: 'join', gameId });
  const [joinedB, joinedC] = await Promise.all([b.waitFor('joined'), c.waitFor('joined')]);
  await Promise.all([a, b, c].map((x) => x.waitFor('room', (m) => m.players.length === 3)));
  for (const x of [a, b, c]) x.inbox.length = 0;
  a.send({ t: 'start' });
  const host = await a.waitFor('host');
  const [cb, cc] = await Promise.all([b.waitFor('connectHost'), c.waitFor('connectHost')]);
  assert.equal(host.epoch, 1);
  assert.equal(cb.epoch, 1);
  if (checkpoint) {
    a.send({ t: 'checkpoint', gameId, epoch: 1, data: SAVE, active: [host.you, cb.you, cc.you] });
    await pause(50);
    assert.equal(games.get(gameId).checkpoint.data, SAVE);
  }
  for (const x of [a, b, c]) x.inbox.length = 0;
  const tokens = { a: joinedA.token, b: joinedB.token, c: joinedC.token };
  return { a, b, c, gameId, tokens, ids: { a: host.you, b: cb.you, c: cc.you } };
}

const mentionsName = (msgs) => NAMES.some((n) => JSON.stringify(msgs.filter((m) => m.t !== 'games')).includes(n));

// After a handover: exactly one of `players` hosts the game now (with the save), the others connect to it.
async function newHost(players, epoch) {
  await Promise.any(players.map((x) => x.waitFor('host')));
  await pause(50);
  const hosts = players.filter((x) => x.inbox.some((m) => m.t === 'host'));
  assert.equal(hosts.length, 1, 'one new host');
  const msg = hosts[0].inbox.find((m) => m.t === 'host');
  assert.equal(msg.save, SAVE, 'it gets the last checkpoint');
  assert.equal(msg.epoch, epoch);
  for (const x of players) {
    if (x === hosts[0]) continue;
    const m = await x.waitFor('connectHost');
    assert.equal(m.epoch, epoch);
    assert.equal(m.moved, true);
  }
  return { host: hosts[0], msg };
}

test('the host leaves: another player takes the game over from the last checkpoint, nobody is revealed', async () => {
  const { a, b, c, gameId, ids } = await startedGame('handover leave');
  a.send({ t: 'leave', gameId });
  const { host, msg } = await newHost([b, c], 2);
  assert.deepEqual(msg.departed, [ids.a], 'the host who left: its empire falls apart in the new host\'s game');
  assert.equal(games.get(gameId).hostId, msg.you);
  assert.ok(![b, c].some((x) => x.inbox.some((m) => m.t === 'reveal')), 'the game goes on');
  assert.ok(!mentionsName([...b.inbox, ...c.inbox]), 'no nickname reaches anyone');

  // The new host is the host now: its checkpoints and its results count, an old epoch's don't.
  host.send({ t: 'checkpoint', gameId, epoch: 1, data: 'zOLD', active: [] });
  await pause(50);
  assert.equal(games.get(gameId).checkpoint.data, SAVE, 'an old hosting\'s checkpoint is ignored');
  const other = host === b ? c : b;
  other.send({ t: 'checkpoint', gameId, epoch: 2, data: 'zNOT', active: [] });
  await pause(50);
  assert.equal(games.get(gameId).checkpoint.data, SAVE, 'a player who does not host cannot send one');
  host.send({ t: 'checkpoint', gameId, epoch: 2, data: 'zNEW', active: [] });
  other.send({ t: 'signal', data: { sdp: 'offer' } });
  assert.equal((await host.waitFor('signal')).from, other === b ? ids.b : ids.c, 'players connect to the new host');
  host.send({ t: 'gameEnded', winner: msg.you });
  const r = await other.waitFor('reveal');
  assert.equal(r.winner, msg.you);
  assert.equal(r.players.length, 3, 'the host who left is revealed too');
});

test('the host\'s connection drops for a moment: it stays the host, and relayed players pick the relay up again', async () => {
  const { a, b, c, gameId, tokens, ids } = await startedGame('handover blip');
  await a.close();
  const back = await connect(NAMES[0], { resume: { gameId, token: tokens.a }, hosting: { gameId, epoch: 1 } });
  await back.waitFor('joined');
  const [mb, mc] = await Promise.all([b.waitFor('connectHost'), c.waitFor('connectHost')]);
  assert.equal(mb.epoch, 1, 'the same host');
  assert.equal(mc.epoch, 1);
  assert.ok(!mb.moved);
  await pause(timing.hostGrace + 200);
  assert.ok(![back, b, c].some((x) => x.inbox.some((m) => m.t === 'host')), 'nothing moved');
  assert.equal(games.get(gameId).hostId, ids.a);
});

test('the host\'s connection stays gone: the game moves once the grace period is over; the old host comes back as a player', async () => {
  const { a, b, c, gameId, tokens, ids } = await startedGame('handover gone');
  a.ws.terminate();
  await pause(timing.hostGrace / 2);
  assert.ok(![b, c].some((x) => x.inbox.some((m) => m.t === 'host' || m.t === 'connectHost')), 'not before the grace period is over');
  const { msg } = await newHost([b, c], 2);
  assert.deepEqual(msg.departed, [], 'nobody left: the old host keeps its empire');

  // Its page still ran the old game, and comes back late: it is a player now, told to connect to the new host.
  const back = await connect(NAMES[0], { resume: { gameId, token: tokens.a }, hosting: { gameId, epoch: 1 } });
  const m = await back.waitFor('connectHost');
  assert.equal(m.epoch, 2);
  assert.equal(m.you, ids.a);
  await pause();
  assert.ok(!back.inbox.some((x) => x.t === 'host'));
  assert.equal(games.get(gameId).hostId, msg.you);
});

test('the host\'s page is closed or reloaded: the game moves at once, and the reloaded page joins as a player', async () => {
  timing.hostGrace = 5000;
  try {
    const { a, b, c, gameId, tokens, ids } = await startedGame('handover reload');
    a.send({ t: 'hostGone' });
    await a.close();
    const { msg } = await newHost([b, c], 2);                // long before the grace period
    const back = await connect(NAMES[0], { resume: { gameId, token: tokens.a } });
    const m = await back.waitFor('connectHost');
    assert.equal(m.epoch, 2);
    assert.equal(m.you, ids.a);
    assert.notEqual(msg.you, ids.a);
  } finally {
    timing.hostGrace = 300;
  }
});

test('a reloaded host page with nobody else online takes its own game back from the checkpoint', async () => {
  const { a, b, c, gameId, tokens, ids } = await startedGame('handover alone');
  await b.close();
  await c.close();
  await a.close();
  await pause(timing.hostGrace + 100);
  assert.equal(games.get(gameId).hostId, null, 'nobody runs the game');
  const back = await connect(NAMES[1], { resume: { gameId, token: tokens.b } });
  const m = await back.waitFor('host');
  assert.equal(m.you, ids.b, 'the first player back runs it');
  assert.equal(m.save, SAVE);
  assert.equal(m.epoch, 2);
  const a2 = await connect(NAMES[0], { resume: { gameId, token: tokens.a } });
  assert.equal((await a2.waitFor('connectHost')).epoch, 2, 'the next one connects to it');
});

test('without a checkpoint yet, the host leaving ends the game; a late leave does not touch the next game', async () => {
  const { a, b, gameId } = await startedGame('handover early', false);
  a.send({ t: 'create', title: 'handover next' });         // the host goes straight on to a new game...
  const { gameId: next } = await a.waitFor('joined', (m) => m.gameId !== gameId);
  assert.match((await b.waitFor('reveal')).reason, /host left/);
  a.send({ t: 'leave', gameId });                          // ...and its old page's leave arrives late
  await pause();
  assert.ok(games.get(next).players.size === 1, 'still in the new game');
});
