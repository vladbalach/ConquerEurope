// Browser-to-browser play, lobby server side: handing a started game to the host's browser,
// passing connection messages, and revealing everyone at the end. Runs the real server
// in-process with real WebSocket clients. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const server = await startServer(0);
const port = server.address().port;
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  server.close();
});

const NAMES = ['Alice_P2P', 'Bob_P2P', 'Carol_P2P'];

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
    name, inbox,
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
  };
  return new Promise((resolve) => ws.on('open', () => {
    c.send({ t: 'hello', name });
    resolve(c);
  }));
}

// Three players in one started game: A hosts.
async function startedGame(title) {
  const [a, b, c] = await Promise.all(NAMES.map(connect));
  await Promise.all([a, b, c].map((x) => x.waitFor('welcome')));
  a.send({ t: 'create', title });
  const { gameId } = await a.waitFor('joined');
  b.send({ t: 'join', gameId });
  c.send({ t: 'join', gameId });
  await Promise.all([b.waitFor('joined'), c.waitFor('joined')]);
  // The waiting room lists nicknames (that is allowed before the start): let it arrive first.
  await Promise.all([a, b, c].map((x) => x.waitFor('room', (m) => m.players.length === 3)));
  for (const x of [a, b, c]) x.inbox.length = 0;
  a.send({ t: 'start' });
  const host = await a.waitFor('host');
  const [cb, cc] = await Promise.all([b.waitFor('connectHost'), c.waitFor('connectHost')]);
  return { a, b, c, host, bId: cb.you, cId: cc.you, gameId };
}

const mentionsName = (msgs) => NAMES.some((n) => JSON.stringify(msgs.filter((m) => m.t !== 'games')).includes(n));

test('starting hands the game to the host\'s browser: a roster without nicknames, the others connect to it', async () => {
  const { a, b, c, host, bId, cId, gameId } = await startedGame('p2p one');
  assert.equal(host.gameId, gameId);
  assert.equal(host.roster.length, 3);
  assert.deepEqual(new Set(host.roster.map((r) => r.id)), new Set([host.you, bId, cId]));
  for (const r of host.roster) assert.deepEqual(Object.keys(r).sort(), ['color', 'id'], 'ids and colours only');
  assert.ok(Array.isArray(host.ice.iceServers) && host.ice.iceServers.length, 'ICE servers for WebRTC');

  // Connection messages: a player reaches only the host, the host reaches the player it names.
  b.send({ t: 'signal', data: { sdp: 'offer-from-b' } });
  assert.deepEqual(await a.waitFor('signal', (m) => m.data.sdp === 'offer-from-b'), { t: 'signal', from: bId, data: { sdp: 'offer-from-b' } });
  a.send({ t: 'signal', to: bId, data: { sdp: 'answer-to-b' } });
  assert.equal((await b.waitFor('signal')).from, host.you);
  c.send({ t: 'signal', to: bId, data: { sdp: 'c-tries-b' } });
  await a.waitFor('signal', (m) => m.data.sdp === 'c-tries-b');
  assert.ok(!b.inbox.some((m) => m.t === 'signal' && m.data.sdp === 'c-tries-b'), 'players cannot signal each other');

  // Only the host can end its game; then everyone is revealed.
  b.send({ t: 'gameEnded', winner: bId });
  a.send({ t: 'ping' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!a.inbox.some((m) => m.t === 'reveal'), 'a player cannot end the game');
  assert.ok(!mentionsName([...a.inbox, ...b.inbox, ...c.inbox]), 'no nickname reaches anyone while the game runs');

  a.send({ t: 'gameEnded', winner: bId });
  const reveals = await Promise.all([a, b, c].map((x) => x.waitFor('reveal')));
  for (const r of reveals) {
    assert.equal(r.winner, bId);
    assert.deepEqual(new Set(r.players.map((p) => p.name)), new Set(NAMES));
    assert.ok(r.players.every((p) => /^#/.test(p.color)));
  }
});

test('players without a direct link play through the server relay', async () => {
  const { a, b, c, host, bId, cId } = await startedGame('p2p relay');
  // A player's messages reach only the host, with the player's id.
  b.send({ t: 'relay', msg: { t: 'relayOpen' } });
  assert.deepEqual(await a.waitFor('relay'), { t: 'relay', from: bId, msg: { t: 'relayOpen' } });
  c.send({ t: 'relay', to: bId, msg: { t: 'move', ids: [1] } });
  assert.equal((await a.waitFor('relay', (m) => m.msg.t === 'move')).from, cId);
  // The host's messages reach the player it names.
  a.send({ t: 'relay', to: bId, msg: { t: 'snap', time: 1 } });
  assert.deepEqual(await b.waitFor('relay'), { t: 'relay', msg: { t: 'snap', time: 1 } });
  assert.ok(!c.inbox.some((m) => m.t === 'relay'), 'other players get nothing');
  assert.ok(!b.inbox.some((m) => m.t === 'relay' && m.msg.t === 'move'), 'players cannot reach each other');
  // A relayed player whose connection drops is cut off from the host: the host is told.
  sockets[sockets.length - 2].close();     // B's socket (A, B, C were opened last)
  assert.equal((await a.waitFor('relay', (m) => m.msg.t === 'relayClose')).from, bId);
  assert.equal(host.you !== bId, true);
});

test('a player who gave up is revealed at the end too, for the results screen', async () => {
  const { a, b, c, cId } = await startedGame('p2p leaver');
  c.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 150));
  a.send({ t: 'gameEnded', winner: a.inbox.find((m) => m.t === 'host').you });
  const r = await b.waitFor('reveal');
  const leaver = r.players.find((p) => p.id === cId);
  assert.equal(leaver?.name, NAMES[2], 'their nickname, with their game id');
  assert.ok(/^#/.test(leaver.color));
  assert.equal(r.players.length, 3);
});

test('when the host leaves, the game is over for everyone', async () => {
  const { a, b, c } = await startedGame('p2p two');
  a.send({ t: 'leave' });
  const [rb, rc] = await Promise.all([b.waitFor('reveal'), c.waitFor('reveal')]);
  assert.equal(rb.winner, -1);
  assert.match(rb.reason, /host left/);
  assert.equal(rc.reason, rb.reason);
});
