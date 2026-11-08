// Browser-to-browser play: the game engine that runs in the host player's browser.
// Driven here exactly as the host's Web Worker drives it. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEngine } from '../server/host-engine.js';
import { UNITS, GAME } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

// Three players from the lobby server: ids and colours only. Player 1 hosts.
function setupEngine() {
  const inbox = new Map([[0, []], [1, []], [2, []]]);
  const ended = [];
  const engine = new HostEngine({
    gameId: '7', title: 'p2p', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }, { id: 2, color: '#3cb44b' }],
    hostId: 1,
    send: (to, msg) => inbox.get(to).push(msg),
    onEnded: (winner) => ended.push(winner),
  });
  const run = (seconds) => { for (let i = 0; i < seconds * GAME.tickRate; i++) engine.step(); };
  const kinds = (id) => inbox.get(id).map((m) => (m.t === 'event' ? `event:${m.kind}` : m.t));
  return { engine, game: engine.game, inbox, ended, run, kinds };
}

test('players get the game when their link opens; only a reconnect says "is back"', () => {
  const { engine, game, inbox, kinds } = setupEngine();
  assert.equal(game.status, 'running');
  assert.equal(game.players.size, 3);
  for (const p of game.players.values()) assert.equal(p.cityCount, GAME.startCities, 'everyone has starting cities');

  engine.connect(1);                                  // the host's own screen
  engine.connect(0);                                  // a peer whose link opened
  const start = inbox.get(0).find((m) => m.t === 'start');
  assert.equal(start.you, 0);
  assert.deepEqual(start.players.map((p) => p.color), ['#e6194b', '#4363d8', '#3cb44b']);
  assert.ok(!kinds(1).includes('event:reconnected'), 'a first connection is not a return');

  inbox.get(1).length = 0;
  engine.disconnect(0);
  engine.connect(0);
  assert.deepEqual(kinds(1).filter((k) => k.startsWith('event')), ['event:disconnected', 'event:reconnected']);
  assert.ok(!kinds(0).includes('kicked'), 'a reconnect is never kicked');
});

test('a peer\'s commands run on the host, and every player only ever sees colours', () => {
  const { engine, game, inbox, run } = setupEngine();
  engine.connect(1);
  engine.connect(0);
  engine.connect(2);
  const peer = game.players.get(0);
  const city = game.cities.find((c) => c.owner === 0);
  peer.gold = 100;
  engine.message(0, { t: 'build', cities: [city.id], item: 'infantry' });
  assert.equal(peer.gold, 100 - UNITS.infantry.cost);
  run(UNITS.infantry.buildTime + 0.5);
  assert.equal([...game.units.values()].filter((u) => u.owner === 0).length, 1, 'the infantry was trained');
  const snap = inbox.get(0).filter((m) => m.t === 'snap').pop();
  assert.ok(snap.u.length >= 8, 'and the peer sees it in its snapshot');

  for (const [id, msgs] of inbox) {
    for (const m of msgs) {
      if (Array.isArray(m.players)) for (const p of m.players) assert.equal(p.name, undefined, `a name reached player ${id}`);
    }
  }
});

test('leaving gives up the empire; the end of the game is reported to the page', () => {
  const { engine, game, inbox, ended, run } = setupEngine();
  engine.connect(1);
  engine.connect(0);
  engine.message(0, { t: 'leave' });
  assert.ok(!game.players.has(0));
  assert.ok(game.cities.every((c) => c.owner !== 0), 'its cities are neutral');
  assert.ok(inbox.get(1).some((m) => m.t === 'event' && m.kind === 'left' && m.player === 0));

  game.end(1);
  run(0.1);
  assert.deepEqual(ended, [1]);
  assert.ok(inbox.get(1).some((m) => m.t === 'gameover' && m.winner === 1));
});

test('an admin makes a city inland or coastal: the host sends everyone the new ports', () => {
  const { engine, game, inbox } = setupEngine();
  engine.connect(0);
  const lisbon = game.cities.find((c) => c.name === 'Lisbon');
  const ports = () => inbox.get(0).filter((m) => m.t === 'ports').at(-1).ports.map(([id]) => id);
  assert.ok(inbox.get(0).find((m) => m.t === 'start').ports.some(([id]) => id === lisbon.id), 'coastal at the start');
  engine.setCoastal(lisbon.id, false);
  assert.ok(!ports().includes(lisbon.id), 'inland now');
  assert.equal(engine.map.cities[lisbon.id].coastal, false);
  engine.setCoastal(lisbon.id, null);
  assert.ok(ports().includes(lisbon.id), 'and coastal again');
});
