// Player colours must be random every game and secret in the lobby
// (GAME_DESIGN.md, "Anonymous players"). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../server/game.js';
import { NavGrid } from '../server/nav.js';
import { PLAYER_COLORS } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'map.json'), 'utf8'));
const nav = NavGrid.load(path.join(ROOT, 'server', 'data', 'navgrid.json'));

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
const RUNS = 100;

// The same five players join a new game in the same order, then the host starts it.
function playGame() {
  const messages = [];
  const game = new Game({ id: '1', title: 'test', map, nav });
  const players = NAMES.map((name) => {
    const { player } = game.addPlayer({ name, send: (m) => messages.push(m) });
    game.broadcastRoom();          // what the lobby does after every join (server/index.js)
    return player;
  });
  const lobby = {
    colors: players.map((p) => p.color),
    publicInfo: game.publicInfo(),
    roomMessages: messages.filter((m) => m.t === 'room'),
  };
  game.start();
  return { lobby, colors: players.map((p) => p.color) };
}

test(`colours differ for players in each of ${RUNS} runs`, () => {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const { colors } = playGame();
    assert.equal(new Set(colors).size, NAMES.length, `run ${i + 1}: two players share a colour`);
    for (const c of colors) assert.ok(PLAYER_COLORS.includes(c), `run ${i + 1}: ${c} is not a player colour`);
    runs.push(colors);
  }

  // No run repeats the colours of the run before it.
  for (let i = 1; i < RUNS; i++) {
    assert.notDeepEqual(runs[i], runs[i - 1], `run ${i + 1} gave every player the same colour as run ${i}`);
  }

  // Each player (same name, same join order every time) gets many different colours.
  NAMES.forEach((name, k) => {
    const seen = new Set(runs.map((r) => r[k]));
    assert.ok(seen.size >= 10, `${name} got only ${seen.size} different colours in ${RUNS} games`);
  });

  // Join order no longer decides colours (it used to: first player red, second blue, ...).
  const joinOrder = PLAYER_COLORS.slice(0, NAMES.length);
  const sameAsJoinOrder = runs.filter((r) => r.every((c, k) => c === joinOrder[k])).length;
  assert.ok(sameAsJoinOrder <= 1, `${sameAsJoinOrder} of ${RUNS} games used join-order colours`);
});

test('the lobby never reveals player colours', () => {
  const { lobby } = playGame();
  assert.deepEqual(lobby.colors, NAMES.map(() => null), 'players already had colours before the game started');
  for (const p of lobby.publicInfo.players) {
    assert.ok(!('color' in p), `lobby game list shows a colour for ${p.name}`);
  }
  assert.ok(lobby.roomMessages.length > 0, 'expected waiting-room updates');
  for (const msg of lobby.roomMessages) {
    for (const p of msg.players) assert.equal(p.color, null, `waiting room shows a colour for ${p.name}`);
  }
});
