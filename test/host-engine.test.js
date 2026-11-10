// Browser-to-browser play: the game engine that runs in the host player's browser.
// Driven here exactly as the host's Web Worker drives it. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEngine } from '../server/host-engine.js';
import { UNITS, GAME, ECONOMY, HONOR, HERO, TRADITIONS } from '../shared/config.js';

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
  // Everyone loads the game (the host first), and the countdown runs out: the game has started.
  const begin = () => {
    for (const id of [1, 0, 2]) engine.connect(id);
    for (let i = 0; i < (GAME.startCountdown + 1) * GAME.tickRate && engine.game.prestart; i++) engine.step();
    assert.equal(engine.game.prestart, null, 'started');
  };
  return { engine, game: engine.game, inbox, ended, run, kinds, begin };
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

test('the host gets no head start: nothing moves until every player has loaded and the countdown is over', () => {
  const { engine, game, inbox, run } = setupEngine();
  const steps = (n) => { for (let i = 0; i < n; i++) engine.step(); };
  const lefts = (id) => inbox.get(id).filter((m) => m.t === 'prestart').map((m) => m.left);
  engine.connect(1);                                  // the host's own screen has the game at once
  assert.deepEqual(inbox.get(1).find((m) => m.t === 'start').prestart, { loaded: 1, total: 3, left: null });
  const host = game.players.get(1);
  const city = game.cities.find((c) => c.owner === 1);
  host.gold = 100;
  run(10);                                            // the peers are still connecting
  engine.message(1, { t: 'build', cities: [city.id], item: 'infantry' });
  assert.equal(game.time, 0, 'the clock stands still');
  assert.equal(host.gold, 100, 'orders are ignored');
  assert.deepEqual(city.queue, []);
  const snaps = inbox.get(1).filter((m) => m.t === 'snap');
  assert.ok(snaps.length && snaps.every((s) => s.time === 0 && s.c[city.id * 3] === 1), 'the host sees its cities meanwhile');

  engine.connect(0);
  assert.deepEqual(inbox.get(1).filter((m) => m.t === 'prestart').at(-1), { t: 'prestart', loaded: 2, total: 3, left: null });
  assert.deepEqual(inbox.get(0).find((m) => m.t === 'start').prestart, { loaded: 2, total: 3, left: null });
  engine.connect(2);                                  // everyone has loaded: the countdown begins
  steps(GAME.startCountdown * GAME.tickRate);
  assert.ok(game.prestart, 'one step before the start');
  assert.equal(game.time, 0);
  engine.step();
  assert.equal(game.prestart, null, 'started');
  const seconds = Array.from({ length: GAME.startCountdown + 1 }, (_, i) => GAME.startCountdown - i);   // 10 … 0, or just 0
  for (const id of [0, 1, 2]) {
    assert.deepEqual(lefts(id).slice(-seconds.length), seconds, `player ${id} saw every second, then the start`);
  }
  engine.message(1, { t: 'build', cities: [city.id], item: 'infantry' });
  assert.equal(host.gold, 100 - UNITS.infantry.cost, 'orders count now');
  run(1);
  assert.ok(game.time > 0.9, 'and the clock runs');
});

test('a player who never loads the game holds up the start for GAME.startWait seconds at most', () => {
  const { engine, game, inbox } = setupEngine();
  const steps = (n) => { for (let i = 0; i < n; i++) engine.step(); };
  engine.connect(1);
  engine.connect(0);                                  // player 2 never comes
  steps(GAME.startWait * GAME.tickRate - 1);
  assert.equal(game.prestartInfo().left, null, 'still waiting');
  engine.step();
  if (GAME.startCountdown) {          // debug builds have no countdown: they start right away
    assert.deepEqual(game.prestartInfo(), { loaded: 2, total: 3, left: GAME.startCountdown }, 'counting down without them');
    steps(GAME.startCountdown * GAME.tickRate);
  }
  assert.equal(game.prestart, null, 'started');
  engine.connect(2);                                  // late: they join the game in progress
  assert.equal(inbox.get(2).find((m) => m.t === 'start').prestart, null);
});

test('a player who gives up before the start is not waited for', () => {
  const { engine, game, inbox } = setupEngine();
  engine.connect(1);
  engine.connect(0);
  engine.message(0, { t: 'leave' });
  assert.deepEqual(inbox.get(1).filter((m) => m.t === 'prestart').at(-1), { t: 'prestart', loaded: 1, total: 2, left: null });
  engine.connect(2);
  engine.step();
  if (GAME.startCountdown) assert.equal(game.prestartInfo().left, GAME.startCountdown, 'everyone left in the game has loaded it');
  else assert.equal(game.prestart, null, 'everyone left in the game has loaded it: started (no countdown in debug builds)');
});

test('a peer\'s commands run on the host, and every player only ever sees colours', () => {
  const { engine, game, inbox, run, begin } = setupEngine();
  begin();
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

test('surrendering gives up the empire but keeps watching; the last player who has not surrendered or left wins', () => {
  const { engine, game, inbox, ended, run, begin } = setupEngine();
  begin();
  const quitter = game.players.get(0);
  engine.message(0, { t: 'surrender' });
  assert.ok(game.players.has(0), 'still in the game');
  assert.ok(quitter.surrendered && quitter.eliminated);
  assert.ok(game.cities.every((c) => c.owner !== 0), 'its cities are neutral');
  assert.ok(inbox.get(1).some((m) => m.t === 'event' && m.kind === 'surrendered' && m.player === 0), 'everyone is told');
  assert.equal(inbox.get(2).filter((m) => m.t === 'score').at(-1).players.find((p) => p.id === 0).surrendered, true);

  // A spectator: no orders, never a liberator (Death: Liberator is the default), but the game keeps coming.
  quitter.gold = 1000;
  engine.message(0, { t: 'research', tech: 'seafaring' });
  assert.equal(quitter.research, null, 'a spectator gives no orders');
  inbox.get(0).length = 0;
  run(1);
  assert.equal(game.options.death, 'liberator');
  assert.ok(!quitter.liberator, 'a player who surrendered never becomes a liberator');
  assert.ok(inbox.get(0).some((m) => m.t === 'snap'), 'and still watches the game');
  assert.equal(game.status, 'running', 'two players are still in it');

  engine.message(2, { t: 'leave' });                 // the other one gives up for good
  run(0.1);
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, 1, 'the last one in the game wins');
  assert.deepEqual(ended, [1]);
  assert.ok(inbox.get(0).some((m) => m.t === 'gameover' && m.winner === 1), 'the spectator sees the results');
});

test('when everyone else surrenders, the last player wins at once, even during the countdown', () => {
  const { engine, game, ended } = setupEngine();
  for (const id of [1, 0, 2]) engine.connect(id);
  assert.ok(game.prestart, 'not started yet');
  engine.message(0, { t: 'surrender' });
  assert.equal(game.status, 'running');
  engine.message(2, { t: 'surrender' });
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, 1);
  engine.step();
  assert.deepEqual(ended, [1]);
  assert.deepEqual(game.history.toJSON().stats[0].events.map((e) => e[1]), ['surrendered'], 'in the results');
});

test('a game started alone goes on without opponents, and ends when its player surrenders', () => {
  const engine = new HostEngine({
    gameId: '8', title: 'solo', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    roster: [{ id: 0, color: '#e6194b' }], hostId: 0, send() {},
  });
  const game = engine.game;
  engine.connect(0);
  for (let i = 0; i < (GAME.startCountdown + 3) * GAME.tickRate; i++) engine.step();
  assert.equal(game.prestart, null, 'started');
  assert.equal(game.status, 'running', 'being the only player is not winning: one can play alone to try things');
  engine.message(0, { t: 'surrender' });
  assert.equal(game.status, 'ended');
  assert.equal(game.winner, -1, 'nobody wins');
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

// Walkable spots out of reach of every city, at least 400 km apart (the cities are dealt at random).
function openFields(game, n) {
  const out = [], b = game.bounds;
  for (let x = b.x0 + 50; x < b.x1 && out.length < n; x += 25) {
    for (let y = b.y0 + 50; y < b.y1 && out.length < n; y += 25) {
      const room = [[0, 0], [-40, 0], [40, 0], [0, -40], [0, 40]].every(([dx, dy]) => game.nav.walkable(x + dx, y + dy));
      if (room && game.cities.every((c) => Math.hypot(c.x - x, c.y - y) > 140) &&
        out.every(([px, py]) => Math.hypot(px - x, py - y) > 400)) out.push([x, y]);
    }
  }
  return out;
}

test("kill gold and honor reach the host's own top bar and the peers' alike", () => {
  const { game, inbox, run, begin } = setupEngine();
  begin();                                                   // player 1 hosts
  const [f1, f2] = openFields(game, 2);
  const spawn = (owner, type, [x, y], dx = 0) => game.spawnUnit({ owner, rally: null, spawnPoint: () => [x + dx, y] }, type);
  spawn(1, 'knight', f1);                                    // the host kills a peer's infantry
  spawn(0, 'infantry', f1, 20);
  spawn(2, 'knight', f2);                                    // a peer kills the host's archer
  spawn(1, 'archer', f2, 20);
  run(15);
  const snap = (id) => inbox.get(id).filter((m) => m.t === 'snap').at(-1);
  assert.equal(snap(1).h, Math.floor(UNITS.infantry.cost * HONOR.killShare), 'the host');
  assert.equal(snap(1).g, Math.floor(ECONOMY.startGold + UNITS.infantry.cost * ECONOMY.killGoldShare));
  assert.equal(snap(2).h, Math.floor(UNITS.archer.cost * HONOR.killShare), 'the peer who killed');
  assert.equal(snap(2).g, Math.floor(ECONOMY.startGold + UNITS.archer.cost * ECONOMY.killGoldShare));
  assert.equal(snap(0).h, 0, 'the peer who only lost');
  assert.equal(snap(0).g, ECONOMY.startGold);
  assert.equal(game.players.get(2).gold, ECONOMY.startGold + 2.5, 'the half is kept, only the top bar rounds it down');
});

test('the host and a peer learn Cult of Heroes and make a Hero of the kind of their unit the same way', () => {
  const { engine, game, inbox, run, begin } = setupEngine();
  begin();                                                   // player 1 hosts
  const [f1, f2] = openFields(game, 2);
  const spawn = (owner, type, [x, y]) => game.spawnUnit({ owner, rally: null, spawnPoint: () => [x, y] }, type);
  const units = { 1: spawn(1, 'cavalry', f1), 0: spawn(0, 'archer', f2) };
  for (const id of [1, 0]) {
    game.players.get(id).honor = TRADITIONS.heroes.cost + HERO.cost;
    engine.message(id, { t: 'learn', tradition: 'heroes' });
  }
  run(TRADITIONS.heroes.time + 1);
  for (const id of [1, 0]) {
    engine.message(id, { t: 'promote', id: units[id].id });
  }
  run(0.2);
  for (const id of [1, 0]) {
    const who = id === 1 ? 'the host' : 'the peer';
    const hero = game.units.get(units[id].id);
    assert.equal(hero.type, 'hero', who);
    assert.equal(hero.kind, id === 1 ? 'cavalry' : 'archer', `${who}'s Hero keeps the kind of its unit`);
    assert.equal(game.players.get(id).honor, 0, `${who} paid for the tradition and the Hero`);
    const snap = inbox.get(id).filter((m) => m.t === 'snap').at(-1);
    assert.deepEqual(snap.tr, [0], `${who}'s top bar knows the tradition`);
    assert.ok(inbox.get(id).some((m) => m.t === 'event' && m.kind === 'promoted'), `${who} is told`);
  }
});

test('slomo: at 4x the host simulates four times the game time, snapshots keep their pace, and everything runs faster', () => {
  const { engine, game, inbox, begin } = setupEngine();
  begin();
  const snaps = () => inbox.get(0).filter((m) => m.t === 'snap');
  // One real second, as the host's timer delivers it: 40 calls 25 ms apart.
  const realSecond = () => { for (let i = 0; i < 40; i++) engine.advance(0.025); };

  let t0 = game.time, s0 = snaps().length;
  realSecond();
  assert.ok(Math.abs(game.time - t0 - 1) < 0.06, 'normal speed: a second of game time per second');
  const normal = snaps().length - s0;

  game.timeScale = 4;                    // what "slomo 4" sets (debug builds only)
  t0 = game.time; s0 = snaps().length;
  realSecond();
  assert.ok(Math.abs(game.time - t0 - 4) < 0.06, 'four seconds of game time in a real second');
  assert.ok(Math.abs(snaps().length - s0 - normal) <= 1, 'and about as many snapshots as at normal speed');
  assert.equal(snaps().at(-1).ts, 4, 'they carry the speed, so browsers keep their clock in step');

  // Research and traditions run on game time: 30 s ones are done in under 8 real seconds.
  const host = game.players.get(1);
  host.gold = 1000;
  host.honor = TRADITIONS.heroes.cost;
  engine.message(1, { t: 'research', tech: 'seafaring' });
  engine.message(1, { t: 'learn', tradition: 'heroes' });
  for (let i = 0; i < 8; i++) realSecond();
  assert.equal(host.tech.seafaring, 1, 'researched');
  assert.ok(host.traditions.includes('heroes'), 'learned');
});
