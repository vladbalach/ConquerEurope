// Honor: traditions learned with it (Honor window), Heroes made from units, and the Hero's aura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNITS, ECONOMY, HERO, HERO_KINDS, HEALER, HONOR, TRADITIONS, TRADITION_TYPES, PRODUCTION_ITEMS, TECHS, CITY_UPGRADES, DISBAND,
} from '../shared/config.js';
import { CARGO_SHIFT, heroKindOf } from '../shared/protocol.js';
import { setup } from './helpers.js';

const HEROES = TRADITIONS.heroes;

// A spot in the open near Paris (A's city): no city shoots A's units there.
function field(city) {
  const paris = city('Paris');
  return { x: paris.x + 40, y: paris.y + 120 };
}

// Damage `u` deals in one second of fighting, measured on a target far from everything.
function damageOf(ctx, u) {
  const target = ctx.spawn(u.owner === ctx.a.id ? ctx.b.id : ctx.a.id, 'knight', 5000, 5000);
  const hp = target.hp;
  u.hit(target, 1);
  ctx.game.units.delete(target.id);
  return hp - target.hp;
}

// Damage with a bonus such as x1.1 is not exact in floating point.
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);
}

test('a tradition costs honor, takes its time, one at a time; cancelling gives the honor back', () => {
  const { game, a, b, run } = setup();
  a.honor = HEROES.cost + 500;
  game.handleCommand(a, { t: 'learn', tradition: 'heroes' });
  assert.equal(a.honor, 500, 'paid when learning starts');
  assert.equal(a.learning.tradition, 'heroes');
  game.handleCommand(a, { t: 'cancelLearn' });
  assert.equal(a.honor, HEROES.cost + 500, 'cancelled: the honor is back');
  assert.equal(a.learning, null);

  game.handleCommand(a, { t: 'learn', tradition: 'heroes' });
  run(HEROES.time - 1);
  assert.deepEqual(a.traditions, [], 'not yet');
  run(1.1);
  assert.deepEqual(a.traditions, ['heroes'], 'learned after its time');
  assert.equal(a.learning, null);
  game.handleCommand(a, { t: 'learn', tradition: 'heroes' });
  assert.equal(a.honor, 500, 'a tradition is learned once');

  b.honor = HEROES.cost - 1;
  game.handleCommand(b, { t: 'learn', tradition: 'heroes' });
  assert.equal(b.learning, null, 'not enough honor');
  game.handleCommand(b, { t: 'learn', tradition: 'nonsense' });
  assert.equal(b.honor, HEROES.cost - 1);
});

test('traditions ordered while one is learned are queued, paid at once, and learned one after another', () => {
  const { game, a, run } = setup();
  const T = TRADITIONS;
  a.honor = T.heroes.cost + T.mercy.cost + 10;
  for (const k of ['heroes', 'mercy', 'mercy', 'heroes']) game.handleCommand(a, { t: 'learn', tradition: k });
  assert.equal(a.learning.tradition, 'heroes', 'one at a time');
  assert.deepEqual(a.learnQueue.map((e) => e.tradition), ['mercy'], 'the other one queued, once');
  assert.equal(a.honor, 10, 'each paid when ordered');
  game.handleCommand(a, { t: 'learn', tradition: 'brotherhood' });
  assert.equal(a.learnQueue.length, 1, 'not without the honor');

  run(T.heroes.time + 0.1);
  assert.deepEqual(a.traditions, ['heroes']);
  assert.equal(a.learning.tradition, 'mercy', 'the next one starts');
  run(T.mercy.time + 0.1);
  assert.deepEqual(a.traditions, ['heroes', 'mercy']);
  assert.equal(a.learning, null, 'the queue is done');
  assert.deepEqual(a.learnQueue, []);
});

test('tier II traditions can be queued behind the tier I ones; cancelling a tier I one takes them out too', () => {
  const { game, a } = setup();
  const T = TRADITIONS, tier1 = TRADITION_TYPES.filter((k) => !T[k].ultimate);
  const learn = (k) => game.handleCommand(a, { t: 'learn', tradition: k });
  a.honor = 100000;
  learn('lastStand');
  assert.equal(a.learning, null, 'not before every tier I one is learned or queued');
  tier1.slice(0, -1).forEach(learn);
  learn('lastStand');
  assert.ok(!a.learnQueue.some((e) => e.tradition === 'lastStand'), 'one tier I one still missing');
  learn(tier1.at(-1));
  learn('lastStand');
  learn('eternalGlory');
  assert.deepEqual([a.learning.tradition, ...a.learnQueue.map((e) => e.tradition)], [...tier1, 'lastStand', 'eternalGlory']);

  const honor = a.honor;
  game.handleCommand(a, { t: 'cancelLearn', tradition: tier1[2] });
  assert.deepEqual(a.learnQueue.map((e) => e.tradition), [tier1[1], tier1[3]], 'the tier II ones need it: gone too');
  assert.equal(a.honor, honor + T[tier1[2]].cost + T.lastStand.cost + T.eternalGlory.cost, 'all refunded');
  game.handleCommand(a, { t: 'cancelLearn', tradition: tier1[0] });
  assert.deepEqual([a.learning.tradition, a.learning.progress], [tier1[1], 0], 'the one being learned cancelled: the next starts');
  game.handleCommand(a, { t: 'cancelLearn', tradition: 'nonsense' });
  assert.deepEqual(a.learnQueue.map((e) => e.tradition), [tier1[3]]);
});

test('learning a tradition and researching a technology run side by side', () => {
  const { game, a } = setup();
  a.honor = HEROES.cost;
  a.gold = TECHS.seafaring.levels[0].cost;
  game.handleCommand(a, { t: 'learn', tradition: 'heroes' });
  game.handleCommand(a, { t: 'research', tech: 'seafaring' });
  assert.ok(a.learning && a.research, 'both started');
  assert.equal(a.gold, 0, 'research is paid in gold');
  assert.equal(a.honor, 0, 'traditions in honor');
});

test('Make Hero needs the tradition and the honor; the unit becomes a Hero where it stands', () => {
  const { game, a, city, spawn } = setup();
  const { x, y } = field(city);
  const archer = spawn(a.id, 'archer', x, y);
  archer.orderMove(x + 50, y, false);
  archer.hp = UNITS.archer.hp / 2;
  a.honor = HERO.cost * 2;

  game.handleCommand(a, { t: 'promote', id: archer.id });
  assert.equal(game.units.get(archer.id).type, 'archer', 'not without the tradition');
  assert.equal(a.honor, HERO.cost * 2);

  a.traditions = ['heroes'];
  game.handleCommand(a, { t: 'promote', id: archer.id });
  const hero = game.units.get(archer.id);
  assert.equal(hero.type, 'hero', 'same id, now a Hero');
  assert.equal(a.honor, HERO.cost);
  assert.equal(hero.maxHp, UNITS.hero.hp);
  assert.equal(hero.hp, UNITS.hero.hp / 2, 'the same share of HP');
  assert.equal(hero.stats.damage, UNITS.hero.damage);
  assert.equal(hero.kind, 'archer', 'an Archer Hero');
  assert.equal(hero.stats.moveSpeed, UNITS.archer.moveSpeed, 'as fast as an archer');
  assert.equal(hero.stats.attackRange, UNITS.archer.attackRange, 'and it shoots as far');
  assert.ok(hero.isRanged);
  assert.deepEqual([hero.x, hero.y], [x, y], 'where it stood');
  assert.equal(hero.order.kind, 'move', 'with its orders');
  assert.equal(hero.order.x, x + 50);
});

test('only your own land units can be made Heroes, one honor payment each', () => {
  const { game, a, b, city, spawn } = setup();
  const { x, y } = field(city);
  a.traditions = ['heroes'];
  a.honor = HERO.cost * 10;
  const ship = spawn(a.id, 'transport', x, y);
  const enemy = spawn(b.id, 'infantry', x + 300, y);
  const dying = spawn(a.id, 'cavalry', x + 20, y);
  game.handleCommand(a, { t: 'disband', ids: [dying.id] });
  for (const u of [ship, enemy, dying]) {
    game.handleCommand(a, { t: 'promote', id: u.id });
    assert.notEqual(game.units.get(u.id).type, 'hero', `${u.type} stays what it is`);
  }
  const knight = spawn(a.id, 'knight', x, y + 30);
  game.handleCommand(a, { t: 'promote', id: knight.id });
  game.handleCommand(a, { t: 'promote', id: knight.id });
  assert.equal(game.units.get(knight.id).type, 'hero');
  assert.equal(a.honor, HERO.cost * 9, 'a Hero is not made a Hero again');

  a.honor = HERO.cost - 1;
  const inf = spawn(a.id, 'infantry', x, y + 60);
  game.handleCommand(a, { t: 'promote', id: inf.id });
  assert.equal(game.units.get(inf.id).type, 'infantry', 'not enough honor');
});

test('cities never train Heroes', () => {
  const { game, a, city } = setup();
  const paris = city('Paris');
  a.gold = 1000;
  assert.ok(!PRODUCTION_ITEMS.includes('hero'));
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'hero' });
  assert.deepEqual(paris.queue, []);
  assert.equal(a.gold, 1000);
});

test("a Hero's aura: your land units within 80 km of it, the Hero too, deal 10% more damage, all the time", () => {
  const ctx = setup();
  const { game, a, b, city, spawn, run } = ctx;
  const { x, y } = field(city);
  const hero = spawn(a.id, 'hero', x, y);
  const near = spawn(a.id, 'infantry', x + HERO.auraRadius - 10, y);
  const far = spawn(a.id, 'infantry', x + HERO.auraRadius + 30, y);
  const ship = spawn(a.id, 'transport', x, y + 40);
  const enemy = spawn(b.id, 'infantry', x, y - 40);
  for (const u of [hero, near, far, enemy]) u.update = () => {};   // everyone stands there: nobody is hit

  assert.equal(damageOf(ctx, near), UNITS.infantry.damage, 'before the first tick: as before');
  run(0.1);
  const bonus = 1 + HERO.auraBonus;
  assertClose(damageOf(ctx, near), UNITS.infantry.damage * bonus, 'near: +10%');
  assertClose(damageOf(ctx, hero), UNITS.hero.damage * bonus, 'the Hero too');
  assert.equal(damageOf(ctx, far), UNITS.infantry.damage, 'out of reach: as before');
  assert.ok(!ship.inspired, 'not ships');
  assert.ok(!enemy.inspired, "not the other player's units");

  run(30);
  assert.ok(near.inspired, 'all the time: no cooldown, nothing to press');
  const second = spawn(a.id, 'hero', x + 20, y);
  second.update = () => {};
  run(0.1);
  assertClose(damageOf(ctx, near), UNITS.infantry.damage * bonus, "two Heroes don't add up");

  game.units.delete(hero.id);
  game.units.delete(second.id);
  run(0.1);
  assert.equal(damageOf(ctx, near), UNITS.infantry.damage, 'no Hero left: as before');
});

test('a Hero keeps the speed and range of what it was made from; a knight makes a cavalry Hero', () => {
  const { game, a, city, spawn } = setup();
  const { x, y } = field(city);
  a.traditions = ['heroes'];
  a.honor = HERO.cost * 4;
  const made = {};
  for (const [i, type] of ['infantry', 'archer', 'cavalry', 'knight'].entries()) {
    const u = spawn(a.id, type, x + i * 30, y);
    game.handleCommand(a, { t: 'promote', id: u.id });
    made[type] = game.units.get(u.id);
  }
  const expect = { infantry: 'infantry', archer: 'archer', cavalry: 'cavalry', knight: 'cavalry' };
  for (const [from, kind] of Object.entries(expect)) {
    const h = made[from];
    assert.equal(h.type, 'hero', from);
    assert.equal(h.kind, kind, `a ${from} makes a ${kind} Hero`);
    assert.equal(h.stats.moveSpeed, UNITS[kind].moveSpeed, `${from}: speed of ${kind}`);
    assert.equal(h.stats.attackRange, UNITS[kind].attackRange, `${from}: range of ${kind}`);
    assert.equal(h.maxHp, UNITS.hero.hp, `${from}: the HP of a Hero`);
    assert.equal(h.stats.damage, UNITS.hero.damage, `${from}: the damage of a Hero`);
  }
  // A balance change reaches the Heroes already on the map.
  const speed = UNITS.cavalry.moveSpeed;
  UNITS.cavalry.moveSpeed = speed + 7;
  try {
    assert.equal(made.knight.stats.moveSpeed, speed + 7);
  } finally {
    UNITS.cavalry.moveSpeed = speed;
  }
});

test("a Hero is worth the gold of the unit it was made from in the Kills and Losses stats", () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  a.traditions = ['heroes'];
  a.honor = HERO.cost;
  const knight = spawn(a.id, 'knight', x, y);
  game.handleCommand(a, { t: 'promote', id: knight.id });
  const hero = game.units.get(knight.id);
  const raider = spawn(b.id, 'archer', x + 400, y);
  hero.receiveDamage(hero.hp + 1, raider);
  game.units.delete(raider.id);
  run(0.1);
  assert.ok(!game.units.has(hero.id));
  assert.equal(a.losses, UNITS.knight.cost);
  assert.equal(b.kills, UNITS.knight.cost);
  assert.equal(b.gold, ECONOMY.startGold + UNITS.knight.cost * ECONOMY.killGoldShare);
  assert.equal(b.honor, UNITS.knight.cost * HONOR.killShare, 'and its honor');
});

test("snapshots: your traditions and learning are yours; a Hero's kind is in its flags, for all to see", () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const snaps = new Map([[a.id, []], [b.id, []]]);
  a.client = { send: (m) => snaps.get(a.id).push(m) };
  b.client = { send: (m) => snaps.get(b.id).push(m) };
  b.view = { x0: x - 200, y0: y - 200, x1: x + 200, y1: y + 200 };   // B looks at the Heroes
  a.traditions = ['heroes'];
  a.honor = HEROES.cost + HERO.cost * 2;
  game.handleCommand(a, { t: 'learn', tradition: 'heroes' });          // learned already: refused
  const knight = spawn(a.id, 'knight', x, y);
  const archer = spawn(a.id, 'archer', x + 30, y);
  game.handleCommand(a, { t: 'promote', id: knight.id });
  game.handleCommand(a, { t: 'promote', id: archer.id });
  for (const id of [knight.id, archer.id]) game.units.get(id).update = () => {};
  run(1);
  game.sendSnapshots();
  const last = (id) => snaps.get(id).filter((m) => m.t === 'snap').at(-1);
  const flagsOf = (snap, id) => {
    for (let i = 0; i < snap.u.length; i += 8) if (snap.u[i] === id) return snap.u[i + 6];
    return null;
  };
  const sa = last(a.id), sb = last(b.id);
  assert.deepEqual(sa.tr, [0]);
  assert.equal(sa.tl, null);
  assert.deepEqual(sb.tr, [], "B learns nothing of A's traditions");
  for (const snap of [sa, sb]) {
    assert.equal(heroKindOf(flagsOf(snap, knight.id)), HERO_KINDS.indexOf('cavalry'), 'the knight: a cavalry Hero');
    assert.equal(heroKindOf(flagsOf(snap, archer.id)), HERO_KINDS.indexOf('archer'), 'the archer: an archer Hero');
    assert.equal(flagsOf(snap, archer.id) >> CARGO_SHIFT, 0, 'no cargo count: the map shows no number by it');
    assert.ok(!('hc' in snap) && !('cr' in snap), 'no War Cry left in snapshots');
  }
});

// ---------------------------------------------------------------- Brotherhood of Arms: Barracks for honor
const BROTHERHOOD = TRADITIONS.brotherhood;
const BARRACKS = CITY_UPGRADES.barracks;

test('Brotherhood of Arms: once learned, Barracks can be paid with honor instead of gold', () => {
  const { game, a, city, run } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  const ids = [paris.id, lyon.id];
  a.honor = BROTHERHOOD.cost + 3 * BROTHERHOOD.barracksHonor;
  a.gold = BARRACKS.cost;

  game.handleCommand(a, { t: 'build', cities: ids, item: 'barracks', honor: true });
  assert.deepEqual(paris.queue, [], 'not before the tradition is learned');

  game.handleCommand(a, { t: 'learn', tradition: 'brotherhood' });
  assert.equal(a.honor, 3 * BROTHERHOOD.barracksHonor, 'the tradition costs honor');
  run(BROTHERHOOD.time + 0.1);
  assert.ok(a.traditions.includes('brotherhood'));

  game.handleCommand(a, { t: 'build', cities: ids, item: 'barracks', honor: true });
  assert.deepEqual([paris.queue, lyon.queue], [['barracks'], ['barracks']]);
  assert.equal(a.honor, BROTHERHOOD.barracksHonor, 'paid in honor, one each');
  assert.equal(a.gold, BARRACKS.cost, 'not in gold');

  game.handleCommand(a, { t: 'cancel', city: paris.id, index: 0 });
  assert.equal(a.honor, 2 * BROTHERHOOD.barracksHonor, 'cancelled: the honor comes back');
  assert.equal(a.gold, BARRACKS.cost, 'and no gold');

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks' });
  assert.deepEqual(paris.queue, ['barracks'], 'gold still works');
  assert.equal(a.gold, 0);
  run(BARRACKS.buildTime + 0.1);
  assert.ok(paris.upgrades.has('barracks') && lyon.upgrades.has('barracks'), 'the same building either way');
  assert.deepEqual(lyon.queueHonor, [], 'built: nothing to give back any more');
  game.handleCommand(a, { t: 'build', cities: ids, item: 'barracks', honor: true });
  assert.equal(a.honor, 2 * BROTHERHOOD.barracksHonor, 'one per city');
});

test('Brotherhood of Arms: Barracks build barracksBuildSpeed times faster, paid with gold or honor', () => {
  const { game, a, city, run } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  const fast = BARRACKS.buildTime / BROTHERHOOD.barracksBuildSpeed;
  a.honor = BROTHERHOOD.barracksHonor;
  a.gold = 2 * BARRACKS.cost;

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks' });
  run(fast + 0.1);
  assert.ok(!paris.upgrades.has('barracks'), 'not before the tradition is learned');
  run(BARRACKS.buildTime - fast);
  assert.ok(paris.upgrades.has('barracks'), 'normal build time without it');

  a.traditions = ['brotherhood'];
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'barracks', honor: true });
  run(fast - 0.2);
  assert.deepEqual(lyon.queue, ['barracks'], 'not quite yet');
  run(0.3);
  assert.ok(lyon.upgrades.has('barracks'), 'paid with honor: built in half the time');

  const lille = city('Lille');
  game.handleCommand(a, { t: 'build', cities: [lille.id], item: 'barracks' });
  run(fast + 0.1);
  assert.ok(lille.upgrades.has('barracks'), 'paid with gold: just as fast');
});

test('honor only pays for Barracks, and only as far as it reaches', () => {
  const { game, a, city } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  a.traditions = ['brotherhood'];
  a.honor = BROTHERHOOD.barracksHonor + 10;
  a.gold = 0;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'wall', honor: true });
  assert.deepEqual(paris.queue, [], 'a wall is not for honor');
  game.handleCommand(a, { t: 'build', cities: [paris.id, lyon.id], item: 'barracks', honor: true });
  assert.deepEqual([paris.queue, lyon.queue], [['barracks'], []], 'honor for one of them');
  assert.equal(a.honor, 10);
});

test('a city captured with an honor Barracks in its queue gives its owner the honor back', () => {
  const { game, a, b, city } = setup();
  const paris = city('Paris');
  const events = [];
  b.client = { send: (m) => { if (m.t === 'event' && m.kind === 'capture') events.push(m); } };
  a.traditions = ['brotherhood'];
  a.honor = BROTHERHOOD.barracksHonor;
  a.gold = UNITS.infantry.cost;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry' });
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks', honor: true });
  assert.deepEqual([a.gold, a.honor], [0, 0]);
  game.captureCity(paris, b.id);
  assert.equal(a.gold, UNITS.infantry.cost, 'the infantry: gold back');
  assert.equal(a.honor, BROTHERHOOD.barracksHonor, 'the Barracks: honor back');
  assert.deepEqual(paris.queueHonor, [], 'the queue and what was paid for it are gone');
  assert.equal(events[0].refund, UNITS.infantry.cost);
  assert.equal(events[0].refundHonor, BROTHERHOOD.barracksHonor);
});

test('your snapshot says what each queue entry was paid with in honor', () => {
  const { game, a, city } = setup();
  const paris = city('Paris'), lyon = city('Lyon');
  const snaps = [];
  a.client = { send: (m) => { if (m.t === 'snap') snaps.push(m); } };
  a.traditions = ['brotherhood'];
  a.honor = BROTHERHOOD.barracksHonor;
  a.gold = BARRACKS.cost;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'barracks', honor: true });
  game.handleCommand(a, { t: 'build', cities: [lyon.id], item: 'barracks' });
  game.sendSnapshots();
  const q = (id) => snaps.at(-1).q.find(([ci]) => ci === id);
  assert.deepEqual(q(paris.id)[7], [BROTHERHOOD.barracksHonor], 'per queue entry');
  assert.equal(q(lyon.id)[7], 0, 'paid in gold');
});

// ---------------------------------------------------------------- Order of Mercy: Healers
test('Make Healer needs Order of Mercy and the honor; only plain land units, never a Hero', () => {
  const { game, a, city, spawn } = setup();
  const { x, y } = field(city);
  const archer = spawn(a.id, 'archer', x, y);
  archer.orderMove(x + 50, y, false);
  archer.hp = UNITS.archer.hp / 2;
  a.honor = HEALER.cost * 3 + HERO.cost;

  game.handleCommand(a, { t: 'promote', id: archer.id, to: 'healer' });
  assert.equal(game.units.get(archer.id).type, 'archer', 'not without the tradition');

  a.traditions = ['heroes', 'mercy'];
  game.handleCommand(a, { t: 'promote', id: archer.id, to: 'healer' });
  const healer = game.units.get(archer.id);
  assert.equal(healer.type, 'healer');
  assert.equal(a.honor, HEALER.cost * 2 + HERO.cost);
  assert.equal(healer.hp, UNITS.healer.hp / 2, 'the same share of HP');
  assert.equal(healer.order.kind, 'move', 'with its orders');

  game.handleCommand(a, { t: 'promote', id: healer.id });
  assert.equal(game.units.get(healer.id).type, 'healer', 'a Healer is not made a Hero');
  const knight = spawn(a.id, 'knight', x, y + 30);
  game.handleCommand(a, { t: 'promote', id: knight.id });
  game.handleCommand(a, { t: 'promote', id: knight.id, to: 'healer' });
  assert.equal(game.units.get(knight.id).type, 'hero', 'nor a Hero a Healer');
  assert.equal(a.honor, HEALER.cost * 2, 'only the Hero was paid for');
  assert.ok(!PRODUCTION_ITEMS.includes('healer'), 'cities never train Healers');
});

test('a Healer mends your land units around it by 2 HP a second, in combat too; several do not add up', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const healer = spawn(a.id, 'healer', x, y);
  const near = spawn(a.id, 'infantry', x + HEALER.radius - 5, y);
  const far = spawn(a.id, 'infantry', x + HEALER.radius + 30, y);
  const enemy = spawn(b.id, 'infantry', x, y + 40);
  const ship = spawn(a.id, 'transport', x, y - 40);
  const dying = spawn(a.id, 'cavalry', x - 30, y);
  game.handleCommand(a, { t: 'disband', ids: [dying.id] });
  const all = [healer, near, far, enemy, ship, dying];
  for (const u of all) {
    u.update = () => {};                 // everyone stands still, and nobody fights
    u.lastCombat = Infinity;             // "in combat": no regeneration of their own
    u.hp = u.maxHp / 2;
  }
  const before = new Map(all.map((u) => [u, u.hp]));
  run(1);
  const gained = (u) => Math.round((u.hp - before.get(u)) * 100) / 100;
  assert.equal(gained(near), HEALER.hpPerSecond, 'near: 2 HP in a second, in combat');
  assert.equal(gained(healer), HEALER.hpPerSecond, 'the Healer itself');
  assert.equal(gained(far), 0, 'out of reach');
  assert.equal(gained(enemy), 0, 'not the enemy');
  assert.equal(gained(ship), 0, 'not ships');
  assert.equal(gained(dying), 0, 'not a unit being disbanded (its drain is off here: update does nothing)');

  const second = spawn(a.id, 'healer', x + 10, y);
  second.update = () => {};
  second.lastCombat = Infinity;
  const hp = near.hp;
  run(1);
  assert.equal(Math.round((near.hp - hp) * 100) / 100, HEALER.hpPerSecond, 'two Healers: still 2 HP a second');

  near.hp = near.maxHp - 0.5;
  run(1);
  assert.equal(near.hp, near.maxHp, 'never above full HP');
});

// ---------------------------------------------------------------- Honored Dead: honor for your fallen
const SHARE = TRADITIONS.honoredDead.lossShare;

// One hit from `attacker` that kills `unit`, then the attacker leaves the map so it can't fight on.
function killWith(game, unit, attacker) {
  unit.receiveDamage(unit.hp + 1, attacker);
  game.units.delete(attacker.id);
}

test('Honored Dead: a unit of yours that falls gives you 25% of its cost in honor; only with the tradition', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  killWith(game, spawn(a.id, 'infantry', x, y), spawn(b.id, 'knight', x + 400, y));
  run(0.1);
  assert.equal(a.honor, 0, 'not without the tradition');
  assert.equal(b.honor, UNITS.infantry.cost * HONOR.killShare, 'the killer gets their honor as always');

  a.traditions = ['honoredDead'];
  killWith(game, spawn(a.id, 'knight', x, y + 30), spawn(b.id, 'knight', x + 400, y + 30));
  run(0.1);
  assert.equal(a.honor, UNITS.knight.cost * SHARE, 'a knight: 37.5');
  assert.equal(b.honor, (UNITS.infantry.cost + UNITS.knight.cost) * HONOR.killShare, "and the killer's honor is unchanged");
});

test('Honored Dead: a death by a neutral city counts too', () => {
  const { game, a, city, spawn, run } = setup();
  a.traditions = ['honoredDead'];
  const metz = city('Metz');
  metz.owner = -1;
  const scout = spawn(a.id, 'archer', metz.x - 40, metz.y);
  scout.update = () => {};
  for (let t = 0; t < 30 && game.units.has(scout.id); t += 0.5) run(0.5);
  assert.ok(!game.units.has(scout.id));
  assert.equal(a.honor, UNITS.archer.cost * SHARE);
});

test('Honored Dead: a disbanded unit counts only when an enemy hit it in its last 20 seconds', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  a.traditions = ['honoredDead'];
  const quiet = spawn(a.id, 'infantry', x, y);
  game.handleCommand(a, { t: 'disband', ids: [quiet.id] });
  run(UNITS.infantry.hp / DISBAND.hpPerSecond + 0.5);
  assert.ok(!game.units.has(quiet.id));
  assert.equal(a.honor, 0, 'disbanded with nobody around: no honor (no turning gold into honor)');

  const hit = spawn(a.id, 'infantry', x, y + 30);
  const raider = spawn(b.id, 'cavalry', x + 400, y + 30);
  hit.receiveDamage(UNITS.infantry.hp - 50, raider);       // 50 HP left: dies 5 s after this hit
  game.units.delete(raider.id);
  game.handleCommand(a, { t: 'disband', ids: [hit.id] });
  run(6);
  assert.ok(!game.units.has(hit.id));
  assert.equal(a.honor, UNITS.infantry.cost * SHARE, 'hit by the enemy just before: it fell');
});

test('Honored Dead: a sunk transport gives honor for the ship and everyone on board; a Hero counts as its unit', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  a.traditions = ['honoredDead', 'heroes'];
  const paris = city('Paris');
  const ship = spawn(a.id, 'transport', paris.x, paris.y);
  for (let i = 0; i < 3; i++) {
    const inf = spawn(a.id, 'infantry', x + i * 20, y);
    game.units.delete(inf.id);
    ship.cargo.push(inf);
  }
  killWith(game, ship, spawn(b.id, 'archer', x + 400, y));
  run(0.1);
  const sunk = UNITS.transport.cost + 3 * UNITS.infantry.cost;
  assert.equal(a.honor, sunk * SHARE, 'the ship and its three passengers');

  a.honor += HERO.cost;
  const knight = spawn(a.id, 'knight', x, y + 60);
  game.handleCommand(a, { t: 'promote', id: knight.id });
  killWith(game, game.units.get(knight.id), spawn(b.id, 'archer', x + 400, y + 60));
  run(0.1);
  assert.equal(a.honor, (sunk + UNITS.knight.cost) * SHARE, 'a Hero made from a knight: as a knight');
});

// ---------------------------------------------------------------- Eternal Glory: the ultimate tradition
const GLORY = TRADITIONS.eternalGlory;
const OTHERS = Object.keys(TRADITIONS).filter((k) => !TRADITIONS[k].ultimate);

test('Eternal Glory opens only once every other tradition is learned', () => {
  const { game, a } = setup();
  a.honor = GLORY.cost;
  a.traditions = OTHERS.slice(0, -1);
  game.handleCommand(a, { t: 'learn', tradition: 'eternalGlory' });
  assert.equal(a.learning, null, 'one tradition missing: locked');
  assert.equal(a.honor, GLORY.cost);
  a.traditions = [...OTHERS];
  game.handleCommand(a, { t: 'learn', tradition: 'eternalGlory' });
  assert.equal(a.learning.tradition, 'eternalGlory');
  assert.equal(a.honor, 0, `it costs ${GLORY.cost} honor`);
  assert.equal(GLORY.time, 120, 'and takes 2 minutes');
});

test('Eternal Glory: nobody is told when it is started or cancelled, only its countdown shows; everyone is told once it is learned', () => {
  const { game, a, b, run } = setup();
  const told = new Map([[a.id, []], [b.id, []]]);
  for (const p of [a, b]) p.client = { send: (m) => { if (m.t === 'event' && m.kind === 'ultimate') told.get(p.id).push(m.state); } };
  const listed = () => game.playerList().find((p) => p.id === a.id);
  a.traditions = [...OTHERS];
  a.honor = GLORY.cost;

  game.handleCommand(a, { t: 'learn', tradition: 'eternalGlory' });
  assert.deepEqual(told.get(b.id), [], 'starting it is not announced');
  assert.equal(listed().ultimateLeft, GLORY.time, 'the Players list counts down');
  assert.deepEqual(listed().traditions, OTHERS, 'traditions are public');

  game.handleCommand(a, { t: 'cancelLearn' });
  assert.deepEqual(told.get(b.id), [], 'nor is cancelling it');
  assert.equal(listed().ultimateLeft, 0);
  assert.equal(a.honor, GLORY.cost, 'cancelled: honor back');

  game.handleCommand(a, { t: 'learn', tradition: 'eternalGlory' });
  run(GLORY.time / 2);
  assert.ok(Math.abs(listed().ultimateLeft - GLORY.time / 2) <= 1, 'half way');
  run(GLORY.time / 2 + 0.1);
  assert.deepEqual(told.get(b.id), ['learned'], 'learning it is announced to everyone');
  assert.deepEqual(told.get(a.id), ['learned'], 'the player who learned it too');
  assert.ok(listed().traditions.includes('eternalGlory'));
  assert.equal(listed().ultimateLeft, 0);

  // A plain tradition is not announced, but the Players list shows it too.
  game.handleCommand(b, { t: 'learn', tradition: 'heroes' });
  assert.equal(told.get(a.id).length, 1);
});

test('Eternal Glory: any unit a city trains can be paid with twice its gold cost in honor', () => {
  const { game, a, city } = setup();
  const paris = city('Paris');
  a.gold = 1000;
  a.honor = 1000;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry', honor: true });
  assert.deepEqual(paris.queue, [], 'not without the tradition');

  a.traditions = ['eternalGlory'];
  const price = (t) => UNITS[t].cost * GLORY.unitHonorFactor;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry', honor: true });
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'archer' });
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'knight', honor: true });
  assert.deepEqual(paris.queue, ['infantry', 'archer', 'knight']);
  assert.equal(a.honor, 1000 - price('infantry') - price('knight'));
  assert.equal(a.gold, 1000 - UNITS.archer.cost, 'the archer in gold');
  assert.deepEqual(paris.queueHonor, [price('infantry'), 0, price('knight')]);

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'wall', honor: true });
  assert.equal(paris.queue.length, 3, 'honor pays for units, not for a wall');

  game.handleCommand(a, { t: 'cancel', city: paris.id, index: 2 });
  assert.equal(a.honor, 1000 - price('infantry'), 'the knight cancelled: its honor back');
  assert.deepEqual(paris.queueHonor, [price('infantry'), 0]);
});

test('Eternal Glory: what is lost from the queue goes back as it was paid', () => {
  const { game, a, b, city, run } = setup();
  const paris = city('Paris');
  a.traditions = ['eternalGlory'];
  a.honor = UNITS.infantry.cost * GLORY.unitHonorFactor * 2;
  a.gold = UNITS.archer.cost;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry', honor: true });
  run(UNITS.infantry.buildTime + 0.1);
  assert.ok([...game.units.values()].some((u) => u.owner === a.id && u.type === 'infantry'), 'trained like any other');
  assert.deepEqual(paris.queueHonor, [], 'and its entry is gone');

  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'archer' });
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'infantry', honor: true });
  assert.deepEqual([a.gold, a.honor], [0, 0]);
  game.captureCity(paris, b.id);
  assert.deepEqual([a.gold, a.honor], [UNITS.archer.cost, UNITS.infantry.cost * GLORY.unitHonorFactor], 'gold for gold, honor for honor');
});

test('Eternal Glory: a ship paid with honor in a city that stops being coastal gives the honor back', () => {
  const { game, a, city } = setup();
  const lisbon = city('Lisbon');
  a.traditions = ['eternalGlory'];
  a.tech = { ...a.tech, seafaring: 1 };
  a.honor = UNITS.transport.cost * GLORY.unitHonorFactor;
  a.gold = 0;
  game.handleCommand(a, { t: 'build', cities: [lisbon.id], item: 'transport', honor: true });
  assert.deepEqual(lisbon.queue, ['transport']);
  game.setPortOverride(lisbon.id, false);
  assert.deepEqual(lisbon.queue, []);
  assert.deepEqual([a.honor, a.gold], [UNITS.transport.cost * GLORY.unitHonorFactor, 0]);
  game.setPortOverride(lisbon.id, null);
});

// ---------------------------------------------------------------- Last Stand: the second ultimate tradition
const STAND = TRADITIONS.lastStand;

test('Last Stand opens once every tier I tradition is learned; the two tier II traditions need not each other', () => {
  const { game, a, b } = setup();
  for (const p of [a, b]) p.honor = STAND.cost;
  a.traditions = OTHERS.slice(1);
  game.handleCommand(a, { t: 'learn', tradition: 'lastStand' });
  assert.equal(a.learning, null, 'one tier I tradition missing: locked');
  a.traditions = [...OTHERS];
  game.handleCommand(a, { t: 'learn', tradition: 'lastStand' });
  assert.equal(a.learning.tradition, 'lastStand', 'Eternal Glory is not needed');
  assert.equal(a.honor, 0, `it costs ${STAND.cost} honor`);
  assert.equal(STAND.time, 120, 'and takes 2 minutes');
  const listed = (p) => game.playerList().find((q) => q.id === p.id);
  assert.equal(listed(a).ultimate, 'lastStand', 'the Players list names the one being learned');
  assert.equal(listed(a).ultimateLeft, STAND.time);

  b.traditions = [...OTHERS, 'lastStand'];
  game.handleCommand(b, { t: 'learn', tradition: 'eternalGlory' });
  assert.equal(b.learning.tradition, 'eternalGlory', 'nor Last Stand for Eternal Glory');
  assert.equal(listed(b).ultimate, 'eternalGlory');
  game.handleCommand(b, { t: 'cancelLearn' });
  assert.equal(listed(b).ultimate, null);
});

test("Last Stand: every unit deals 30% more damage, on top of a Hero's aura", () => {
  const ctx = setup();
  const { a, b, city, spawn } = ctx;
  const { x, y } = field(city);
  const archer = spawn(a.id, 'archer', x, y);
  const knight = spawn(b.id, 'knight', x + 300, y);
  assert.equal(damageOf(ctx, archer), UNITS.archer.damage, 'without it: as before');
  a.traditions = ['lastStand'];
  assert.equal(damageOf(ctx, archer), UNITS.archer.damage * (1 + STAND.damageBonus), '+30%');
  assert.equal(damageOf(ctx, knight), UNITS.knight.damage, "not the other player's units");
  archer.inspired = true;                   // near a Hero of A's (Game.inspire sets it every tick)
  assertClose(damageOf(ctx, archer), UNITS.archer.damage * (1 + STAND.damageBonus + HERO.auraBonus), "a Hero's aura adds up: +40%");
});

test('Last Stand: outnumbered 2 to 1 within 80 km, a unit takes 30% less damage and its snapshot flag shows it to all', () => {
  const { game, a, b, city, spawn, run } = setup();
  const { x, y } = field(city);
  const snaps = new Map([[a.id, []], [b.id, []]]);
  for (const p of [a, b]) p.client = { send: (m) => snaps.get(p.id).push(m) };
  b.view = { x0: x - 200, y0: y - 200, x1: x + 200, y1: y + 200 };
  const flagOf = (p, id) => {
    const snap = snaps.get(p.id).filter((m) => m.t === 'snap').at(-1);
    for (let i = 0; i < snap.u.length; i += 8) if (snap.u[i] === id) return snap.u[i + 6] & 32;
    return null;
  };
  const still = (u) => { u.update = () => {}; u.regenerate = () => {}; return u; };
  a.traditions = ['lastStand'];
  const mine = still(spawn(a.id, 'infantry', x, y));
  const foes = [still(spawn(b.id, 'infantry', x + 30, y + 40))];
  const hitFor = (u, amount) => { const hp = u.hp; u.receiveDamage(amount, foes[0]); const lost = hp - u.hp; u.hp = hp; return lost; };
  run(0.6);
  assert.ok(!mine.standFirm, 'one enemy against one unit: not outnumbered');
  assert.equal(hitFor(mine, 10), 10);

  foes.push(still(spawn(b.id, 'archer', x - 30, y + 60)));
  run(0.6);
  assert.ok(mine.standFirm, 'two enemies against one: standing firm');
  assert.ok(Math.abs(hitFor(mine, 10) - 10 * (1 - STAND.damageCut)) < 1e-9, '30% less damage');
  assert.ok(!foes[0].standFirm, "the other player hasn't learned it");
  game.sendSnapshots();
  assert.ok(flagOf(a, mine.id), 'its owner sees it');
  assert.ok(flagOf(b, mine.id), 'and so does the enemy');
  assert.ok(!flagOf(b, foes[0].id));

  const friend = still(spawn(a.id, 'infantry', x + 10, y - 20));
  foes.push(still(spawn(b.id, 'infantry', x + 20, y + 70)));
  run(0.6);
  assert.ok(!mine.standFirm && !friend.standFirm, 'three enemies against two: not 2 to 1');
  foes.push(still(spawn(b.id, 'infantry', x - 10, y + STAND.radius - 2)));
  run(0.6);
  assert.ok(mine.standFirm, 'four against two');
  friend.x += 2000;
  foes.at(-1).y += 2000;
  run(0.6);
  assert.ok(mine.standFirm, 'only units within 80 km count: three against one');
  game.units.delete(friend.id);
  game.units.delete(foes.at(-1).id);
  a.traditions = [];
  run(0.6);
  assert.ok(!mine.standFirm, 'without the tradition nobody stands firm');
  assert.equal(hitFor(mine, 10), 10);
});
