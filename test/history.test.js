// The game's history, for the results screen once it is over (server/history.js): the map turn by turn,
// every player's numbers per turn, and their totals. Also: long messages (the game-over message carries
// the history) travel between browsers in pieces (public/js/p2p.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, TECHS, ECONOMY } from '../shared/config.js';
import { splitMessage, Parts, PART_SIZE } from '../public/js/p2p.js';
import { setup } from './helpers.js';

// A game that only ends when a test says so: no countdown to a lower target.
function quietSetup() {
  const s = setup();
  s.game.options = { ...s.game.options, countdown: 'none', winCities: 200 };
  return s;
}

// The numbers of player `id` in a frame, by name (frames keep them in the order of `series`).
function numbers(history, frame, id) {
  const { series } = history.toJSON();
  const p = frame.p, stride = 1 + series.length;
  for (let i = 0; i < p.length; i += stride) {
    if (p[i] === id) return Object.fromEntries(series.map((k, j) => [k, p[i + 1 + j]]));
  }
  return null;
}

test('a frame when the game starts, one at the end of every turn with the cities that changed hands, and one at the end', () => {
  const { game, a, b, city, run } = quietSetup();
  const h = game.history;
  run(0.05);
  assert.equal(h.frames.length, 1, 'the first tick takes the start');
  const start = h.frames[0];
  assert.equal(start.t, 0);
  assert.equal(start.o.length, game.cities.length * 2, 'the start lists every owned city with its owner');
  assert.equal(numbers(h, start, a.id).cities, a.cityCount);
  assert.deepEqual(new Map(h.toJSON().roster), new Map([[a.id, a.color], [b.id, b.color]]));

  const paris = city('Paris');
  game.captureCity(paris, b.id);
  game.recount();
  game.endTurn();
  assert.equal(h.frames.length, 2);
  const turn1 = h.frames[1];
  assert.equal(turn1.t, 1);
  assert.deepEqual(turn1.o, [paris.id, b.id], 'only the city that changed hands');
  assert.equal(numbers(h, turn1, b.id).cities, b.cityCount);
  assert.ok(numbers(h, turn1, b.id).income > 0, 'what the turn paid');
  assert.equal(h.stats.get(b.id).captured, 1);
  assert.equal(h.stats.get(a.id).citiesLost, 1);
  assert.equal(h.stats.get(b.id).goldIncome, numbers(h, turn1, b.id).income);

  game.endTurn();
  assert.deepEqual(h.frames[2].o, [], 'a quiet turn changes nothing');

  game.end(b.id);
  const last = h.frames[h.frames.length - 1];
  assert.equal(last.end, true);
  assert.equal(last.t, 3, 'the turn being played when it ended');
  assert.deepEqual(h.stats.get(b.id).events.at(-1), [3, 'won']);
});

test('the game-over message carries the history, and it survives JSON', () => {
  const { game, b, run } = quietSetup();
  run(0.05);
  game.endTurn();
  game.end(b.id);
  const msg = JSON.parse(JSON.stringify(game.gameOverMessage()));
  assert.equal(msg.t, 'gameover');
  assert.equal(msg.winner, b.id);
  assert.equal(msg.history.frames.length, 3);
  assert.deepEqual(msg.history.series, ['cities', 'units', 'army', 'income', 'kills', 'losses']);
  assert.ok(msg.history.stats[b.id], 'stats by player id');
});

test('units trained, destroyed and lost are counted by type, with the gold they cost and earned', () => {
  const { game, a, b, city, spawn, run } = quietSetup();
  const lyon = city('Lyon');
  game.handleCommand(a, { t: 'build', item: 'infantry', cities: [lyon.id] });
  run(UNITS.infantry.buildTime + 0.5);
  const sa = game.history.stats.get(a.id);
  assert.equal(sa.trained.infantry, 1);
  assert.equal(sa.spentUnits, UNITS.infantry.cost);

  const paris = city('Paris');
  const x = paris.x + 40, y = paris.y + 120;
  spawn(a.id, 'knight', x, y);
  const victim = spawn(b.id, 'archer', x + 20, y);
  for (let t = 0; t < 30 && game.units.has(victim.id); t += 0.5) run(0.5);
  assert.ok(!game.units.has(victim.id));
  assert.equal(sa.killed.archer, 1);
  assert.equal(game.history.stats.get(b.id).lost.archer, 1);
  assert.equal(sa.goldKills, UNITS.archer.cost * ECONOMY.killGoldShare, 'kill gold, as the game paid it');
  game.endTurn();
  const army = numbers(game.history, game.history.frames.at(-1), a.id).army;
  assert.ok(army >= UNITS.knight.cost + UNITS.infantry.cost, 'army value counts every unit');
});

test('research is dated by the turn it was finished in, with its cost', () => {
  const { game, a, run } = quietSetup();
  run(0.05);
  game.endTurn();                                  // turn 1 is over: research now finishes in turn 2
  game.handleCommand(a, { t: 'research', tech: 'seafaring' });
  run(TECHS.seafaring.levels[0].time + 0.5);
  const s = game.history.stats.get(a.id);
  assert.deepEqual(s.events.find((e) => e[1] === 'research'), [2, 'research', 'seafaring', 1]);
  assert.equal(s.spentResearch, TECHS.seafaring.levels[0].cost);
});

test('a player who leaves keeps their history', () => {
  const { game, a, run } = quietSetup();
  run(0.05);
  game.removePlayer(a.id);
  game.endTurn();
  const h = game.history.toJSON();
  assert.ok(h.roster.some(([id]) => id === a.id), 'their colour stays known');
  assert.deepEqual(h.stats[a.id].events.at(-1), [1, 'left']);
  assert.equal(numbers(game.history, h.frames.at(-1), a.id), null, 'no numbers once they are gone');
  assert.ok(h.frames.at(-1).o.length > 0, 'their cities fell neutral');
});

test('long messages travel in pieces and come back whole; short ones in one', () => {
  assert.equal(splitMessage(JSON.stringify({ t: 'snap', n: 1 })), null);
  const big = { t: 'gameover', history: { frames: Array.from({ length: 4000 }, (_, i) => ({ t: i, o: [i, i % 7] })) } };
  const parts = splitMessage(JSON.stringify(big));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(JSON.stringify(p).length < 2 * PART_SIZE + 200, 'each piece fits in one data channel message');
  const inbox = new Parts();
  const got = parts.map((p) => inbox.add(JSON.parse(JSON.stringify(p))));
  assert.deepEqual(got.slice(0, -1), parts.slice(0, -1).map(() => null), 'nothing until the last piece');
  assert.deepEqual(got.at(-1), big);
  // A new message drops an unfinished one.
  const again = splitMessage(JSON.stringify(big));
  inbox.add(again[0]);
  const other = splitMessage(JSON.stringify({ ...big, t: 'other' }));
  let whole = null;
  for (const p of other) whole = inbox.add(p) || whole;
  assert.equal(whole.t, 'other');
});
