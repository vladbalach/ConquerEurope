// Technologies (Tech window) and the Rebellion tab: Supporters, Influencer, Smuggling, Sanctuary. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBERATOR, TECHS, TECH_TYPES, TECH_TABS, ECONOMY } from '../shared/config.js';
import { liberatorIncome, influenceLimit, smugglingLimit, smugglingFlows, safeSeconds, liberatorsOnly, techsInTabOrder } from '../shared/tech.js';
import { setup, map, nav } from './helpers.js';
import { Game } from '../server/game.js';

// Two players (A west, B east, half the cities each), Death: Liberator, nobody wins by cities.
function game2(death = 'liberator') {
  const s = setup();
  s.game.options = { ...s.game.options, countdown: 'none', winCities: s.game.cities.length, death };
  const events = { a: [], b: [] };
  s.a.client = { send: (m) => events.a.push(m) };
  s.b.client = { send: (m) => events.b.push(m) };
  s.strip = (p, keep = 0) => {
    s.game.cities.filter((c) => c.owner === p.id).slice(keep).forEach((c) => { c.owner = -1; });
    s.game.recount();
  };
  s.citiesOf = (p) => s.game.cities.filter((c) => c.owner === p.id);
  s.order = (p, msg) => { p.commandTokens = 20; s.game.handleCommand(p, msg); };
  s.research = (p, tech, levels = 1) => {
    for (let i = 0; i < levels; i++) {
      p.gold += TECHS[tech].levels[p.tech[tech]].cost;
      s.order(p, { t: 'research', tech });
      s.run(TECHS[tech].levels[p.tech[tech]].time + 0.1);
    }
  };
  return { ...s, events };
}

test('research costs gold up front and takes game time; cancelling refunds it', () => {
  const { game, a, strip, order, run, events } = game2();
  strip(a);                                           // a liberator: Rebellion technologies are theirs
  a.gold = 1000;
  order(a, { t: 'research', tech: 'supporters' });
  assert.equal(a.gold, 1000 - TECHS.supporters.levels[0].cost);
  order(a, { t: 'cancelResearch' });
  assert.equal(a.gold, 1000, 'refunded');
  assert.equal(a.research, null);

  order(a, { t: 'research', tech: 'smuggling' });
  run(TECHS.smuggling.levels[0].time - 1);
  assert.equal(a.tech.smuggling, 0, 'not yet');
  run(1.1);
  assert.equal(a.tech.smuggling, 1);
  assert.equal(a.research, null);
  assert.ok(events.a.some((m) => m.kind === 'researched' && m.tech === 'smuggling' && m.level === 1));
  assert.equal(game.playerList().find((p) => p.id === a.id).tech.smuggling, 1, 'levels are public');
});

test('Rebellion technologies are ordered only by a liberator; one ordered goes on if they come back', () => {
  const { game, a, b, strip, citiesOf, order, run, events } = game2();
  const S = TECHS.supporters.levels, sea = TECHS.seafaring.levels[0].cost;
  b.gold = 1000;
  for (const tech of TECH_TYPES.filter(liberatorsOnly)) order(b, { t: 'research', tech });
  assert.equal(b.research, null, 'still in the game: no Rebellion technology');
  assert.equal(b.gold, 1000);
  order(b, { t: 'research', tech: 'seafaring' });
  assert.equal(b.research?.tech, 'seafaring', 'the other tabs: anyone');
  order(b, { t: 'cancelResearch' });

  strip(b);
  assert.ok(b.liberator, 'fallen');
  b.gold = 1000;
  order(b, { t: 'research', tech: 'supporters' });
  order(b, { t: 'research', tech: 'supporters' });
  order(b, { t: 'research', tech: 'seafaring' });
  assert.equal(b.gold, 1000 - S[0].cost - S[1].cost - sea, 'each its price, no discount');

  // Each player's page learns what was paid, for the refunds it shows.
  game.sendSnapshots();
  const snap = events.b.filter((m) => m.t === 'snap').pop();
  assert.deepEqual([snap.r[0], snap.r[2]], [TECH_TYPES.indexOf('supporters'), S[0].cost]);
  assert.deepEqual(snap.rq, [[TECH_TYPES.indexOf('supporters'), S[1].cost], [TECH_TYPES.indexOf('seafaring'), sea]]);

  // Back in the game: what was ordered goes on, but no more Rebellion technologies can be ordered.
  order(b, { t: 'influence', city: citiesOf(a)[0].id });
  assert.equal(b.liberator, false, 'back');
  run(S[0].time + S[1].time + 0.2);
  assert.equal(b.tech.supporters, 2, 'both levels done');
  b.gold = 1000;
  order(b, { t: 'research', tech: 'smuggling' });
  assert.notEqual(b.research?.tech, 'smuggling', 'refused once back');
  assert.ok(!b.researchQueue.some((e) => e.tech === 'smuggling'));
});

test('research ordered while one runs is queued, paid at once, and starts when the one before it is done', () => {
  const { a, strip, order, run } = game2();
  const S = TECHS.supporters.levels, M = TECHS.smuggling.levels;
  strip(a);
  a.gold = 1000;
  for (const tech of ['supporters', 'smuggling', 'supporters']) order(a, { t: 'research', tech });
  assert.equal(a.research.tech, 'supporters', 'one research at a time');
  assert.deepEqual(a.researchQueue.map((e) => [e.tech, e.level]), [['smuggling', 1], ['supporters', 2]], 'the others queued');
  assert.equal(a.gold, 1000 - S[0].cost - M[0].cost - S[1].cost, 'each paid when ordered');

  run(S[0].time + 0.1);
  assert.equal(a.tech.supporters, 1);
  assert.equal(a.research.tech, 'smuggling', 'the next one starts');
  run(M[0].time + 0.1);
  assert.equal(a.tech.smuggling, 1);
  assert.deepEqual([a.research.tech, a.research.level, a.researchQueue], ['supporters', 2, []]);
  run(S[1].time + 0.1);
  assert.equal(a.tech.supporters, 2);
  assert.equal(a.research, null, 'the queue is done');
});

test('the queue stops at the last level; cancelling a level refunds it and the higher levels of it after it', () => {
  const { a, strip, order } = game2();
  const S = TECHS.supporters.levels, M = TECHS.smuggling.levels;
  strip(a);
  a.gold = 10000;
  for (let i = 0; i <= M.length; i++) order(a, { t: 'research', tech: 'smuggling' });
  assert.equal(a.researchQueue.length, M.length - 1, `${M.length} levels in all, no more`);
  for (let i = 1; i <= M.length; i++) order(a, { t: 'cancelResearch', tech: 'smuggling', level: M.length + 1 - i });
  assert.equal(a.gold, 10000, 'every level refunded');

  a.gold = 1000;
  for (const tech of ['smuggling', 'supporters', 'smuggling', 'smuggling']) order(a, { t: 'research', tech });
  order(a, { t: 'cancelResearch', tech: 'smuggling', level: 2 });
  assert.deepEqual(a.researchQueue.map((e) => [e.tech, e.level]), [['supporters', 1]], 'level 3 needs level 2: gone too');
  assert.equal(a.gold, 1000 - M[0].cost - S[0].cost, 'both refunded');

  order(a, { t: 'research', tech: 'smuggling' });
  assert.equal(a.researchQueue.at(-1).level, 2, 'ordered again: level 2 again');
  order(a, { t: 'cancelResearch', tech: 'smuggling', level: 1 });
  assert.deepEqual([a.research.tech, a.research.level, a.research.progress], ['supporters', 1, 0], 'the running one cancelled: the next starts');
  assert.deepEqual(a.researchQueue, [], 'level 2 needs level 1: gone too');
  assert.equal(a.gold, 1000 - S[0].cost);
  order(a, { t: 'cancelResearch', tech: 'nonsense', level: 1 });
  order(a, { t: 'cancelResearch', tech: 'supporters', level: 1 });
  assert.equal(a.research, null);
  assert.equal(a.gold, 1000);
});

test('research needs the gold, stops at the last level, and Rebellion needs Death: Liberator', () => {
  const { a, strip, order, research } = game2();
  strip(a);
  a.gold = 10;
  order(a, { t: 'research', tech: 'supporters' });
  assert.equal(a.research, null, 'not enough gold');
  order(a, { t: 'research', tech: 'nonsense' });
  assert.equal(a.research, null);
  research(a, 'smuggling', TECHS.smuggling.levels.length);
  assert.equal(a.tech.smuggling, 3);
  a.gold = 1000;
  order(a, { t: 'research', tech: 'smuggling' });
  assert.equal(a.research, null, 'no level 4');

  const spect = game2('spectator');
  spect.a.gold = 1000;
  spect.order(spect.a, { t: 'research', tech: 'supporters' });
  assert.equal(spect.a.research, null, 'no Rebellion tab without liberators');
});

test('the Rebellion tab comes last, in the Tech window and in lists of technologies', () => {
  assert.equal(TECH_TABS.at(-1).id, 'rebellion');
  const order = techsInTabOrder();
  assert.deepEqual([...order].sort(), [...TECH_TYPES].sort(), 'every technology once');
  const first = order.findIndex(liberatorsOnly);
  assert.ok(first > 0 && order.slice(first).every(liberatorsOnly), 'the Rebellion ones at the end');
});

test('Supporters: +20 / +40 liberator gold per turn (2 levels)', () => {
  assert.deepEqual([0, 1, 2].map((n) => liberatorIncome({ supporters: n })),
    [LIBERATOR.goldPerTurn, LIBERATOR.goldPerTurn + 20, LIBERATOR.goldPerTurn + 40]);
  assert.equal(TECHS.supporters.levels.length, 2);
  const { game, b, strip, order, research } = game2();
  strip(b);
  assert.equal(b.liberator, true);
  research(b, 'supporters', 2);
  b.gold = 1000;
  order(b, { t: 'research', tech: 'supporters' });
  assert.equal(b.research, null, 'no level 3');
  b.gold = 0;
  game.endTurn();
  assert.equal(b.gold, LIBERATOR.goldPerTurn + 40);
});

test('Influencer: mark cities one per turn; the last one liberates them all, visible to everyone', () => {
  const { game, a, b, strip, citiesOf, order, research, events } = game2();
  strip(b);
  research(b, 'influencer', 2);                       // limit 3
  assert.equal(influenceLimit(b.tech), 3);
  const [c1, c2, c3] = citiesOf(a);
  order(b, { t: 'influence', city: c1.id });
  assert.deepEqual(b.influence, [c1.id]);
  assert.equal(c1.owner, a.id, 'only marked so far');
  assert.ok(events.a.some((m) => m.kind === 'influence' && m.city === c1.id && m.count === 1 && m.limit === 3));
  assert.deepEqual(game.playerList().find((p) => p.id === b.id).influence, [c1.id], 'everyone sees the marks');

  order(b, { t: 'influence', city: c2.id });
  assert.deepEqual(b.influence, [c1.id], 'one mark per turn');
  game.endTurn();
  order(b, { t: 'influence', city: c2.id });
  game.endTurn();
  order(b, { t: 'influence', city: c3.id });           // the third: all three are liberated at once
  assert.deepEqual([c1, c2, c3].map((c) => c.owner), [b.id, b.id, b.id]);
  assert.equal(b.liberator, false);
  assert.deepEqual(b.influence, []);
  assert.equal(b.liberateAt, game.turn + LIBERATOR.cooldownTurns);
});

test('Influencer: "liberate now" takes the marked cities early; protection is checked city by city', () => {
  const { game, a, b, strip, citiesOf, order, research } = game2();
  strip(b);
  research(b, 'influencer', 3);                       // limit 4
  strip(a, LIBERATOR.protectedCities + 1);            // A: 6 cities
  const mine = citiesOf(a);
  for (const c of mine.slice(0, 2)) {
    order(b, { t: 'influence', city: c.id });
    game.endTurn();
  }
  assert.equal(b.influence.length, 2);
  order(b, { t: 'liberate' });
  assert.equal(mine[0].owner, b.id, 'A had 6: allowed');
  assert.equal(mine[1].owner, a.id, 'A had 5 by then: protected');
  assert.equal(a.cityCount, LIBERATOR.protectedCities);
  assert.equal(b.liberator, false);
});

test('Sanctuary: a liberated city is safe 3 or 4 minutes instead of 2; the level when it is liberated counts', () => {
  assert.deepEqual([0, 1, 2].map((n) => safeSeconds({ sanctuary: n })), [120, 180, 240]);
  assert.equal(TECHS.sanctuary.levels.length, 2);
  const { game, a, b, strip, citiesOf, order, research, events } = game2();
  strip(b);
  research(b, 'sanctuary', 1);
  const first = citiesOf(a)[0];
  order(b, { t: 'influence', city: first.id });
  assert.equal(first.owner, b.id);
  assert.equal(first.safeUntil, game.time + 180, '3 minutes');
  assert.equal(events.a.find((m) => m.kind === 'capture' && m.city === first.id).safe, 180, 'everyone is told how long');
  game.sendSnapshots();
  assert.deepEqual(events.a.filter((m) => m.t === 'snap').pop().sc.filter((_, i) => i % 3 !== 1), [first.id, 180]);

  // Level 2, researched after falling again: 4 minutes for the next one.
  strip(b);
  for (let i = 0; i < LIBERATOR.cooldownTurns; i++) game.endTurn();
  research(b, 'sanctuary', 1);
  assert.equal(b.tech.sanctuary, 2);
  b.gold = 1000;
  order(b, { t: 'research', tech: 'sanctuary' });
  assert.equal(b.research, null, 'no level 3');
  const second = citiesOf(a)[0];
  order(b, { t: 'influence', city: second.id });
  assert.equal(second.owner, b.id);
  assert.equal(second.safeFor, 240, '4 minutes');
  assert.equal(second.safeUntil, game.time + 240);
  assert.ok(first.safeUntil < second.safeUntil, 'the city liberated before keeps its own time');
});

test('without Influencer a mark liberates the city at once, as before', () => {
  const { b, a, strip, citiesOf, order } = game2();
  strip(b);
  const c = citiesOf(a)[0];
  order(b, { t: 'influence', city: c.id });
  assert.equal(c.owner, b.id);
});

test(`Smuggling: ${TECHS.smuggling.share * 100}% of a marked city's income goes from its owner to the liberator`, () => {
  const { game, a, b, strip, citiesOf, order, research, events } = game2();
  strip(b);
  research(b, 'smuggling', 2);                        // two marks
  assert.equal(smugglingLimit(b.tech), 2);
  const [c1, c2, c3] = citiesOf(a);
  c1.addUpgrade('farm');
  order(b, { t: 'smuggle', city: c1.id });
  order(b, { t: 'smuggle', city: c2.id });
  order(b, { t: 'smuggle', city: c3.id });
  assert.deepEqual(b.smuggle, [c1.id, c2.id], 'two marks only');
  const share = TECHS.smuggling.share;
  const expected = Math.floor(c1.goldPerTurn * share) + Math.floor(c2.goldPerTurn * share);
  const aIncome = citiesOf(a).reduce((sum, c) => sum + c.goldPerTurn, 0);
  const [aGold, bGold] = [a.gold, b.gold];
  game.endTurn();
  assert.equal(b.gold - bGold, LIBERATOR.goldPerTurn + expected);
  assert.equal(a.gold - aGold, aIncome - expected);
  const turnA = events.a.filter((m) => m.kind === 'turn').pop();
  assert.equal(turnA.smuggledAway, expected);

  order(b, { t: 'smuggle', city: c2.id });            // clicking a marked city again removes the mark
  assert.deepEqual(b.smuggle, [c1.id]);
  assert.deepEqual(b.influence, [], 'smuggling marks are not influence marks');
});

test('Smuggling works only while a liberator, and its marks are gone once back in the game; neutral cities pay nothing', () => {
  const flows = smugglingFlows([{ id: 1, tech: { smuggling: 2 }, cities: [5, 6] }], (ci) => (ci === 6 ? -1 : 0), () => 12);
  const take = Math.floor(12 * TECHS.smuggling.share);
  assert.equal(flows.gain.get(1), take, `${TECHS.smuggling.share * 100}% of 12`);
  assert.equal(flows.loss.get(0), take);
  assert.equal(flows.byCity.has(6), false, 'neutral: nothing');

  const { game, a, b, strip, citiesOf, order, research } = game2();
  research(b, 'smuggling', 1);
  order(b, { t: 'smuggle', city: citiesOf(a)[0].id });
  assert.deepEqual(b.smuggle, [], 'marks only as a liberator');
  strip(b);
  const c = citiesOf(a)[0];
  order(b, { t: 'smuggle', city: c.id });
  // B comes back with a city: the smuggling mark is gone.
  order(b, { t: 'influence', city: citiesOf(a)[1].id });
  assert.equal(b.liberator, false);
  assert.deepEqual(b.smuggle, []);
  const aGold = a.gold;
  const aIncome = citiesOf(a).reduce((sum, x) => sum + x.goldPerTurn, 0);
  game.endTurn();
  assert.equal(a.gold - aGold, aIncome, 'no smuggling while B is back in the game');
  assert.ok(ECONOMY.goldPerCityPerTurn > 0);
});

test('a city carries one influence mark and one smuggling mark at most: two liberators can not share one', () => {
  const game = new Game({ id: '3', title: 'three', map, nav });
  const [a, b, c] = ['A', 'B', 'C'].map((name) => game.addPlayer({ name, send() {} }).player);
  game.start();
  game.options = { ...game.options, countdown: 'none', winCities: 200, death: 'liberator' };
  game.cities.forEach((city, i) => { city.owner = i < 100 ? a.id : -1; });
  game.recount();                                   // B and C hold nothing: both liberators
  assert.ok(b.liberator && c.liberator);
  for (const p of [b, c]) p.tech = { ...p.tech, influencer: 1, smuggling: 2 };
  const order = (p, msg) => { p.commandTokens = 20; game.handleCommand(p, msg); };
  const [x, y, z] = game.cities.filter((city) => city.owner === a.id);

  order(b, { t: 'influence', city: x.id });
  order(c, { t: 'influence', city: x.id });
  assert.deepEqual([b.influence, c.influence], [[x.id], []], 'B has marked it: C can not');
  order(c, { t: 'influence', city: y.id });
  assert.deepEqual(c.influence, [y.id], 'another city is fine');

  order(b, { t: 'smuggle', city: z.id });
  order(c, { t: 'smuggle', city: z.id });
  assert.deepEqual([b.smuggle, c.smuggle], [[z.id], []], 'one smuggler per city');
  order(c, { t: 'smuggle', city: x.id });
  assert.deepEqual(c.smuggle, [x.id], 'smuggling from a city B influences: a different kind of mark');

  order(b, { t: 'liberate' });                      // B takes X and is back in the game: B's marks are gone
  assert.equal(x.owner, b.id);
  assert.deepEqual(b.smuggle, []);
  order(c, { t: 'smuggle', city: z.id });
  assert.deepEqual(c.smuggle, [x.id, z.id], 'Z is free again');
});
