// While a game is played nobody may learn who is who: the server never sends a nickname to
// game clients, and nothing in the lobby can be matched with the game. Everyone is revealed
// when the game ends (GAME_DESIGN.md, "Anonymous players"). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { PLAYER_COLORS, PLAYER_COLOR_NAMES } from '../shared/config.js';
import { map, nav } from './helpers.js';

const NAMES = ['Nick_Alice', 'Nick_Bob', 'Nick_Carol', 'Nick_Dave', 'Nick_Eve'];

function newGame() {
  const inbox = new Map();                   // nickname -> messages that player's client received
  const game = new Game({ id: '1', title: 'test', map, nav });
  const players = NAMES.map((name) => {
    inbox.set(name, []);
    const client = { name, send: (m) => inbox.get(name).push(m) };
    const { player } = game.addPlayer(client);
    game.broadcastRoom();
    return player;
  });
  return { game, players, inbox };
}

const mentions = (messages) => {
  const text = JSON.stringify(messages);
  return NAMES.filter((n) => text.includes(n));
};

test('no nickname reaches a game client while the game runs', () => {
  const { game, players, inbox } = newGame();
  for (const msgs of inbox.values()) msgs.length = 0;      // the waiting room may show names

  game.start();
  game.broadcastRoom();                                    // what the server does right after start
  for (let i = 0; i < 40; i++) game.tick(0.05);            // snapshots and scores
  game.sendScores();

  const [alice, bob, carol] = players;
  game.disconnect(alice);                                  // "lost connection" event + room update
  const back = { name: alice.name, send: (m) => inbox.get(alice.name).push(m) };
  game.reattach(alice, back);                              // "is back" event, then a rejoin start
  game.broadcastRoom();
  game.sendStart(alice);
  game.removePlayer(bob.id);                               // "left" event + room update
  carol.eliminated = false;
  game.recount();

  for (const [name, msgs] of inbox) {
    assert.ok(msgs.length > 0, `${name} received nothing`);
    assert.deepEqual(mentions(msgs), [], `${name}'s client received a nickname during the game`);
  }
  // Players are still told apart, by id and colour.
  const start = inbox.get(carol.name).find((m) => m.t === 'start');
  for (const p of start.players) {
    assert.ok(PLAYER_COLORS.includes(p.color));
    assert.equal(p.name, undefined);
  }
});

test('every player colour has a name to be called by', () => {
  for (const c of PLAYER_COLORS) assert.ok(PLAYER_COLOR_NAMES[c], `${c} has no name`);
  assert.equal(new Set(Object.values(PLAYER_COLOR_NAMES)).size, PLAYER_COLORS.length, 'two colours share a name');
});

test('in-game ids do not follow join order', () => {
  // In the waiting room ids are join order and are shown with nicknames, so the game must use new ones.
  const firstIds = new Set();
  for (let run = 0; run < 60; run++) {
    const { game, players } = newGame();
    game.start();
    firstIds.add(players[0].id);
    assert.deepEqual([...game.players.keys()].sort(), [0, 1, 2, 3, 4]);
    for (const [id, p] of game.players) assert.equal(p.id, id);
    for (const c of game.cities) if (c.owner >= 0) assert.ok(game.players.has(c.owner));
  }
  assert.ok(firstIds.size >= 4, `the first player to join got only ids ${[...firstIds]}`);
});

test('the lobby lists only nicknames for a game in progress', () => {
  const { game } = newGame();
  game.start();
  const info = game.publicInfo();
  assert.deepEqual(info.players, [...NAMES].sort().map((name) => ({ name })));
  assert.ok(!JSON.stringify(info).includes('#'), 'a colour is in the lobby listing');
});

test('everyone is revealed when the game ends', () => {
  const { game, players, inbox } = newGame();
  game.start();
  game.end(players[2].id);
  const over = inbox.get(players[0].name).find((m) => m.t === 'gameover');
  assert.equal(over.name, players[2].name);
  assert.equal(over.players.length, NAMES.length);
  for (const p of over.players) {
    assert.ok(NAMES.includes(p.name));
    assert.ok(PLAYER_COLORS.includes(p.color));
  }
});
