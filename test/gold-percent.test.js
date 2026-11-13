// Gold percentage (waiting room): the host sets one for each player, and the gold a player earns in the game
// is scaled by it: turn pay (cities, liberator pay, smuggling) and kill gold. The start gold (a game option)
// and refunds are not. In the game each player learns only their own percentage. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { saveGame, restoreGame } from '../server/save.js';
import { ECONOMY, UNITS } from '../shared/config.js';
import { liberatorIncome } from '../shared/tech.js';
import { GOLD_PERCENT, sanitizeGoldPercent, scaleGold, scaleGoldWhole } from '../shared/options.js';
import { setup, map, nav } from './helpers.js';

// A waiting room with one player per entry of `percents` (undefined: left at 100%), each with an inbox.
function waitingRoom(...percents) {
  const game = new Game({ id: '1', title: 'gold', map, nav });
  const inboxes = [];
  const players = percents.map((pct, i) => {
    const inbox = [];
    inboxes.push(inbox);
    const p = game.addPlayer({ name: `P${i}`, send: (m) => inbox.push(m) }).player;
    if (pct !== undefined) assert.equal(game.setGoldPercent(p.id, pct), true);
    return p;
  });
  return { game, players, inboxes };
}

const income = (game, id) => game.cities.filter((c) => c.owner === id).reduce((s, c) => s + c.goldPerTurn, 0);

test('gold percentages are whole numbers within their limits; anything else is 100%', () => {
  assert.equal(sanitizeGoldPercent(undefined), GOLD_PERCENT.default);
  assert.equal(sanitizeGoldPercent('abc'), GOLD_PERCENT.default);
  assert.equal(sanitizeGoldPercent(''), GOLD_PERCENT.default);
  assert.equal(sanitizeGoldPercent(null), GOLD_PERCENT.default);
  assert.equal(sanitizeGoldPercent('80'), 80);
  assert.equal(sanitizeGoldPercent(72.6), 73);
  assert.equal(sanitizeGoldPercent(0), GOLD_PERCENT.min);
  assert.equal(sanitizeGoldPercent(1e6), GOLD_PERCENT.max);
  assert.equal(scaleGold(2.5, 80), 2, 'exact: halves count');
  assert.equal(scaleGold(2.5, undefined), 2.5);
  assert.equal(scaleGoldWhole(37, 85), 31, '31.45: whole gold');
  assert.equal(scaleGoldWhole(50, 125), 63, '62.5 rounds up');
});

test('the waiting room shows every gold percentage; in the game each player gets only their own', () => {
  const { game, players: [a, b], inboxes: [ia, ib] } = waitingRoom(undefined, 80);
  const room = ia.filter((m) => m.t === 'room').pop();
  assert.deepEqual(room.players.map((p) => [p.id, p.goldPercent]), [[a.id, 100], [b.id, 80]]);
  game.start();
  const [sa, sb] = [ia, ib].map((inbox) => inbox.find((m) => m.t === 'start'));
  assert.equal(sa.goldPercent, 100);
  assert.equal(sb.goldPercent, 80);
  for (const s of [sa, sb]) {
    for (const p of s.players) assert.ok(!('goldPercent' in p), 'nobody else\'s: it would tell who is who');
  }
  game.broadcastRoom();
  for (const p of ib.filter((m) => m.t === 'room').pop().players) assert.ok(!('goldPercent' in p));
  assert.equal(game.setGoldPercent(b.id, 120), false, 'no changes once the game has started');
  assert.equal(b.goldPercent, 80);
});

test('a gold percentage set in the waiting room is sanitized; unknown players are ignored', () => {
  const { game, players: [a] } = waitingRoom(undefined);
  game.setGoldPercent(a.id, 'lots');
  assert.equal(a.goldPercent, 100);
  game.setGoldPercent(a.id, 9999);
  assert.equal(a.goldPercent, GOLD_PERCENT.max);
  assert.equal(game.setGoldPercent(42, 50), false);
});

test('the start gold is the same for everyone, whatever their gold percentage: the game option', () => {
  const { game, players: [a, b, c] } = waitingRoom(undefined, 50, 150);
  game.start();
  for (const p of [a, b, c]) assert.equal(p.gold, ECONOMY.startGold, 'by default as before');

  const room = waitingRoom(undefined, 50);
  room.game.setOptions({ startGold: 300 });
  room.game.start();
  for (const p of room.players) assert.equal(p.gold, 300);
});

test('turn pay is scaled by the gold percentage, in whole gold, and so is what the turn message says', () => {
  const { game, a, b } = setup();
  b.goldPercent = 85;
  const inbox = [];
  b.client = { send: (m) => inbox.push(m) };
  const [ia, ib, ga, gb] = [income(game, a.id), income(game, b.id), a.gold, b.gold];
  game.endTurn();
  assert.equal(a.gold - ga, ia, '100%: as before');
  assert.equal(b.gold - gb, Math.round((ib * 85) / 100));
  assert.notEqual(b.gold - gb, ib);
  assert.equal(inbox.find((m) => m.kind === 'turn').income, b.gold - gb);
  assert.equal(game.history.stat(b.id).goldIncome, b.gold - gb, 'the results screen counts what was paid');
});

test('a liberator\'s pay is scaled by their gold percentage', () => {
  const { game, b } = setup();
  game.options = { ...game.options, countdown: 'none', winCities: game.cities.length, death: 'liberator' };
  b.goldPercent = 150;
  for (const c of game.cities) if (c.owner === b.id) c.owner = -1;
  game.recount();                                  // B falls: a liberator with no gold
  assert.equal(b.liberator, true);
  assert.equal(b.gold, 0);
  game.endTurn();
  assert.equal(b.gold, scaleGoldWhole(liberatorIncome(b.tech), 150));
  assert.notEqual(b.gold, liberatorIncome(b.tech));
});

test('kill gold is scaled by the killer\'s gold percentage; kills and honor are not', () => {
  const { game, a, b, city, spawn } = setup();
  a.goldPercent = 80;
  const paris = city('Paris');
  const archer = spawn(b.id, 'archer', paris.x + 40, paris.y + 120);
  archer.lastHitOwner = a.id;
  const before = a.gold;
  game.recordDeath(archer);
  const full = UNITS.archer.cost * ECONOMY.killGoldShare;
  assert.equal(a.gold - before, scaleGold(full, 80));
  assert.ok(a.gold - before < full);
  assert.equal(a.kills, UNITS.archer.cost, 'kills count the unit\'s whole cost');
  assert.equal(game.history.stat(a.id).goldKills, Math.round(scaleGold(full, 80) * 10) / 10);
});

test('refunds give back exactly what was paid, whatever the gold percentage', () => {
  const { game, a } = setup();
  a.goldPercent = 40;
  a.gold = 1000;
  const mine = game.cities.find((c) => c.owner === a.id);
  game.handleCommand(a, { t: 'build', city: mine.id, item: 'infantry' });
  assert.equal(a.gold, 1000 - UNITS.infantry.cost);
  game.handleCommand(a, { t: 'cancel', city: mine.id, index: 0 });
  assert.equal(a.gold, 1000);
});

test('the host\'s browser gets each gold percentage with the roster, and a takeover keeps it', () => {
  const roster = [{ id: 0, color: '#e6194b', goldPercent: 70 }, { id: 1, color: '#4363d8' }, { id: 2, color: '#3cb44b', goldPercent: 'x' }];
  const game = Game.hosted({ id: '9', title: 'gold', map, nav, roster, hostId: 0, options: { startGold: 120 } });
  assert.deepEqual([0, 1, 2].map((id) => game.players.get(id).goldPercent), [70, 100, 100]);
  assert.deepEqual([0, 1, 2].map((id) => game.players.get(id).gold), [120, 120, 120], 'the start gold option, unscaled');

  const save = saveGame(game);
  const again = restoreGame(JSON.parse(JSON.stringify(save)), { map, nav, hostId: 1 });
  assert.equal(again.players.get(0).goldPercent, 70);
  // A save from before gold percentages: everyone at 100%.
  for (const p of save.players) delete p.goldPercent;
  const old = restoreGame(save, { map, nav, hostId: 1 });
  assert.equal(old.players.get(0).goldPercent, 100);
});
