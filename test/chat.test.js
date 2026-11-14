// Chat in the waiting room and in the game, through the lobby server. In the waiting room by nickname; while the
// game runs by id and colour only (GAME_DESIGN.md, "Anonymous players"), and spectators talk among themselves;
// once the game is over the nicknames are back. Real WebSocket clients. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, chatText } from '../server/index.js';
import { CHAT } from '../shared/config.js';

const server = await startServer(0);
const port = server.address().port;
const sockets = [];
after(() => {
  for (const ws of sockets) ws.terminate();
  server.close();
});

const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

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
    name, inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    say: (text) => ws.send(JSON.stringify({ t: 'chat', text })),
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
    chats: () => inbox.filter((m) => m.t === 'chat'),
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

// A waiting room: `players[0]` created it, the others joined; `watchers` watch it. Returns the game id and
// everyone's `joined` message by name.
async function room(title, players, watchers = []) {
  const [first, ...rest] = players;
  first.send({ t: 'create', title });
  const joined = { [first.name]: await first.waitFor('joined') };
  const { gameId } = joined[first.name];
  for (const p of rest) {
    p.send({ t: 'join', gameId });
    joined[p.name] = await p.waitFor('joined');
  }
  for (const s of watchers) {
    s.send({ t: 'watch', gameId });
    joined[s.name] = await s.waitFor('joined');
  }
  await Promise.all([...players, ...watchers].map((x) => x.waitFor('room',
    (m) => m.players.length === players.length && m.spectators.length === watchers.length)));
  return { gameId, joined };
}

const said = (x, text) => x.waitFor('chat', (m) => m.text === text);

test('what is typed is cleaned up: no control characters or direction overrides, spaces collapsed, cut to length', () => {
  assert.equal(chatText('  hello \n\t world  '), 'hello world');
  assert.equal(chatText('a‮b⁦c\u0007d'), 'a b c d');
  assert.equal(chatText('<b>hi</b> & <3'), '<b>hi</b> & <3', 'shown as text, never as HTML');
  assert.equal(chatText('x'.repeat(500)).length, CHAT.maxLength);
  assert.equal(chatText('😀'.repeat(300)), '😀'.repeat(CHAT.maxLength), 'whole characters, never half of one');
  assert.equal(chatText('   '), '');
  assert.equal(chatText(42), '');
});

test('the waiting room chats by nickname, players and spectators alike; newcomers read what was said', async () => {
  const [ann, bob, sue, cat] = await lobby('Ann_CH', 'Bob_CH', 'Sue_CH', 'Cat_CH');
  const { gameId, joined } = await room('chat room', [ann, bob], [sue]);
  for (const x of [ann, bob, sue]) assert.deepEqual((await x.waitFor('chatLog')).messages, [], 'a new room: nothing said yet');

  ann.say('  hello   everyone ');
  const m = await said(bob, 'hello everyone');
  assert.deepEqual(m, { t: 'chat', from: joined.Ann_CH.playerId, text: 'hello everyone', name: 'Ann_CH' }, 'no colour before the game');
  await said(ann, 'hello everyone');                  // back to its writer too
  await said(sue, 'hello everyone');

  sue.say('can I play next time?');
  const s = await said(ann, 'can I play next time?');
  assert.equal(s.name, 'Sue_CH');
  assert.equal(s.spectator, true);
  await said(bob, 'can I play next time?');

  ann.say('   ');                                     // nothing to say: nothing sent
  await pause();
  assert.equal(bob.chats().length, 2);

  cat.send({ t: 'join', gameId });
  const log = await cat.waitFor('chatLog');
  assert.deepEqual(log.messages.map((x) => [x.name, x.text]),
    [['Ann_CH', 'hello everyone'], ['Sue_CH', 'can I play next time?']]);
});

test('in a running game: colours, never nicknames; spectators talk among themselves; nicknames again once it is over', async () => {
  const NAMES = ['Ann_CG', 'Bob_CG', 'Sue_CG', 'Lou_CG'];
  const [ann, bob, sue, lou] = await lobby(...NAMES);
  const { gameId, joined } = await room('chat game', [ann, bob], [sue, lou]);
  ann.say('ready?');
  // Everyone has it (by nickname: still the waiting room) before the inboxes are emptied: one that came in
  // after would look like a nickname sent during the game.
  await Promise.all([ann, bob, sue, lou].map((x) => said(x, 'ready?')));

  for (const x of [ann, bob, sue, lou]) x.inbox.length = 0;
  ann.send({ t: 'start' });
  const host = await ann.waitFor('host');
  const bobId = (await bob.waitFor('connectHost')).you;
  const sueId = (await sue.waitFor('connectHost')).you;
  const colorOf = new Map(host.roster.map((r) => [r.id, r.color]));
  for (const x of [ann, bob, sue, lou]) {
    assert.deepEqual((await x.waitFor('chatLog')).messages, [], `${x.name}: the waiting room's chat is gone`);
  }

  bob.say('good luck');
  const gl = await said(ann, 'good luck');
  assert.deepEqual(gl, { t: 'chat', from: bobId, text: 'good luck', color: colorOf.get(bobId) });
  await said(bob, 'good luck');
  await said(sue, 'good luck');                       // spectators read the players
  await said(lou, 'good luck');

  sue.say('Red is about to lose Paris');
  const tip = await said(lou, 'Red is about to lose Paris');
  assert.deepEqual(tip, { t: 'chat', from: sueId, text: 'Red is about to lose Paris', spectator: true });
  await said(sue, 'Red is about to lose Paris');
  await pause();
  for (const p of [ann, bob]) {
    assert.ok(!p.chats().some((x) => x.spectator), `${p.name}: players never read the spectators, nor learn one is there`);
  }
  const everything = JSON.stringify([ann, bob, sue, lou].flatMap((x) => x.inbox));
  for (const n of NAMES) assert.ok(!everything.includes(n), `no nickname while the game runs: ${n}`);

  // Back after a refresh: the game's chat so far, without what the spectators said for a player.
  const bob2 = await connect('Bob_CG', { resume: { gameId, token: joined.Bob_CG.token } });
  assert.deepEqual((await bob2.waitFor('chatLog')).messages, [gl]);
  const lou2 = await connect('Lou_CG', { resume: { gameId, token: joined.Lou_CG.token } });
  assert.deepEqual((await lou2.waitFor('chatLog')).messages, [gl, tip]);

  // Over: everyone is revealed, in the chat too, and spectators reach everyone again.
  ann.send({ t: 'gameEnded', winner: host.you });
  await ann.waitFor('reveal');
  ann.say('gg');
  const gg = await said(bob2, 'gg');
  assert.deepEqual(gg, { t: 'chat', from: host.you, text: 'gg', name: 'Ann_CG', color: colorOf.get(host.you) });
  sue.say('well played');
  const wp = await said(ann, 'well played');
  assert.equal(wp.name, 'Sue_CG');
  assert.equal(wp.spectator, true);
});

test('nobody floods the chat: a few messages in a row, then the server says to slow down', async () => {
  const [ann, bob] = await lobby('Ann_CF', 'Bob_CF');
  await room('chat flood', [ann, bob]);
  for (let i = 0; i < 8; i++) ann.say(`spam ${i}`);
  assert.match((await ann.waitFor('error')).msg, /too fast/);
  await pause();
  assert.deepEqual(bob.chats().map((m) => m.text), ['spam 0', 'spam 1', 'spam 2', 'spam 3', 'spam 4']);
});

test('only members of a game chat in it', async () => {
  const [ann, out] = await lobby('Ann_CO', 'Out_CO');
  await room('chat members', [ann]);
  out.say('hello?');                                   // in the lobby, in no game
  await pause();
  assert.equal(ann.chats().length, 0);
  assert.equal(out.chats().length, 0);
});
