// Game option "Death": spectator (out of the game) or liberator (takes cities back). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBERATOR, CITY, UNITS } from '../shared/config.js';
import { setup } from './helpers.js';

// Two players (A west, B east, half the cities each) with the given death option. No one can win by
// cities here (the target is every city on the map), so only falling matters.
function game2(death) {
  const s = setup();
  s.game.options = { ...s.game.options, countdown: 'none', winCities: s.game.cities.length, death };
  const events = { a: [], b: [] };
  s.a.client = { send: (m) => events.a.push(m) };
  s.b.client = { send: (m) => events.b.push(m) };
  // Every city of `p` but `keep` becomes neutral.
  s.strip = (p, keep = 0) => {
    s.game.cities.filter((c) => c.owner === p.id).slice(keep).forEach((c) => { c.owner = -1; });
    s.game.recount();
  };
  s.cityOf = (p) => s.game.cities.find((c) => c.owner === p.id);
  return { ...s, events };
}

test('spectator (default): a fallen player is out, and the last one standing wins', () => {
  const { game, a, b, strip } = game2('spectator');
  strip(b);
  assert.equal(b.eliminated, true);
  assert.equal(b.liberator, false);
  game.handleCommand(b, { t: 'influence', city: game.cities[0].id });
  assert.equal(game.status, 'ended', 'B is out: A is the last one standing');
  assert.equal(game.winner, a.id);
});

test('liberator: falling costs all gold, pays a fixed amount per turn, and the game goes on', () => {
  const { game, a, b, strip, events } = game2('liberator');
  b.gold = 500;
  strip(b);
  assert.equal(game.status, 'running', 'a liberator is still in the game');
  assert.equal(b.eliminated, false);
  assert.equal(b.liberator, true);
  assert.equal(b.gold, 0, 'all gold lost');
  assert.ok(events.a.some((m) => m.t === 'event' && m.kind === 'liberator' && m.player === b.id), 'everyone is told');
  assert.ok(events.a.some((m) => m.t === 'score' && m.players.find((p) => p.id === b.id).liberator), 'the list says so at once');

  const aGold = a.gold;
  game.endTurn();
  assert.equal(b.gold, LIBERATOR.goldPerTurn);
  assert.ok(a.gold > aGold, 'A is paid by their cities as usual');
  const turn = events.b.filter((m) => m.kind === 'turn').pop();
  assert.equal(turn.income, LIBERATOR.goldPerTurn);
  assert.equal(turn.liberator, true);
});

test('a liberator takes any city, even another player\'s, like a capture; then waits before the next one', () => {
  const { game, a, b, strip, cityOf, events } = game2('liberator');
  strip(b);
  const city = cityOf(a);
  city.addUpgrade('farm');
  city.queue = ['infantry', 'archer'];
  const aGold = a.gold;

  game.handleCommand(b, { t: 'influence', city: city.id });
  assert.equal(city.owner, b.id);
  assert.equal(city.hp, CITY.captureHp);
  assert.equal(city.upgrades.size, 0, 'upgrades are lost, as in a capture');
  assert.equal(a.gold, aGold + UNITS.infantry.cost + UNITS.archer.cost, 'A gets the queue refunded');
  assert.equal(b.liberator, false, 'back in the game');
  assert.equal(b.cityCount, 1);
  assert.equal(b.liberateAt, game.turn + LIBERATOR.cooldownTurns);
  const capture = events.a.find((m) => m.kind === 'capture' && m.city === city.id);
  assert.equal(capture.liberated, true);
  assert.equal(capture.from, a.id);

  // Falls again at once: all gold lost again, but the next city must wait for the cooldown.
  b.gold = 77;
  strip(b);
  assert.equal(b.liberator, true);
  assert.equal(b.gold, 0);
  const other = cityOf(a);
  game.handleCommand(b, { t: 'influence', city: other.id });
  assert.equal(other.owner, a.id, 'too soon');
  for (let i = 0; i < LIBERATOR.cooldownTurns; i++) game.endTurn();
  b.commandTokens = 20;
  game.handleCommand(b, { t: 'influence', city: other.id });
  assert.equal(other.owner, b.id, `allowed again ${LIBERATOR.cooldownTurns} turns later`);
});

test('only liberators may take cities; a neutral city works too; bad city ids are ignored', () => {
  const { game, a, b, strip, cityOf } = game2('liberator');
  const target = cityOf(b);
  game.handleCommand(a, { t: 'influence', city: target.id });
  assert.equal(target.owner, b.id, 'A is not a liberator');

  strip(b);
  for (const city of [-1, 9999, 'x', 1.5, null]) game.handleCommand(b, { t: 'liberate', city });
  assert.equal(b.liberator, true, 'nothing taken');
  const neutral = game.cities.find((c) => c.owner < 0);
  game.handleCommand(b, { t: 'influence', city: neutral.id });
  assert.equal(neutral.owner, b.id);
});

test(`a player with ${LIBERATOR.protectedCities} cities or fewer is protected from liberators`, () => {
  const { game, a, b, strip, cityOf } = game2('liberator');
  strip(a, LIBERATOR.protectedCities + 1);       // A holds one city more than the protected number
  strip(b);
  const first = cityOf(a);
  game.handleCommand(b, { t: 'influence', city: first.id });
  assert.equal(first.owner, b.id, 'allowed: A had more than the protected number');
  assert.equal(a.cityCount, LIBERATOR.protectedCities);

  strip(b);                                      // B falls again and waits out the cooldown
  for (let i = 0; i < LIBERATOR.cooldownTurns; i++) game.endTurn();
  b.commandTokens = 20;
  const second = cityOf(a);
  game.handleCommand(b, { t: 'influence', city: second.id });
  assert.equal(second.owner, a.id, `refused: A holds only ${LIBERATOR.protectedCities}`);
  assert.equal(b.liberator, true);
  const neutral = game.cities.find((c) => c.owner < 0);
  game.handleCommand(b, { t: 'influence', city: neutral.id });
  assert.equal(neutral.owner, b.id, 'neutral cities are always free to take');
});
