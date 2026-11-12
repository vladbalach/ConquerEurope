// Attack alerts (public/js/alerts.js): one per battle where you aren't looking, never one per hit, and the
// feed and the sound rate-limited; Shift + Space through the last few alerts. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttackWatch, AlertLog, ALERT } from '../public/js/alerts.js';

const YOU = 0, ENEMY = 1;
const TRANSPORT = 5;                      // a type id the tests treat as a ship that carries units
const CARGO_SHIFT = 8;

// A small game seen through its snapshots: your units (id -> unit), two cities, a camera and two clocks.
function game() {
  const g = {
    watch: new AttackWatch(),
    units: new Map(),
    cityOwner: [YOU, ENEMY],
    cityHp: [100, 100],
    cities: [{ x: 0, y: 0 }, { x: 5000, y: 0 }],
    view: null,                           // { x0, y0, x1, y1 } on screen, or null: looking nowhere
    time: 0,                              // game seconds
    now: 0,                               // ms
    unit(id, x, y, extra = {}) {
      g.units.set(id, { id, t: 0, owner: YOU, x, y, hp: 100, flags: 0, ...extra });
      return g.units.get(id);
    },
    // One snapshot `dt` seconds after the last one (game time and real time run together here).
    snap(dt = 0.1) {
      g.time += dt;
      g.now += dt * 1000;
      return g.watch.update({
        time: g.time, now: g.now, units: g.units, you: YOU,
        cityOwner: g.cityOwner, cityHp: g.cityHp, cities: g.cities,
        maxHp: () => 100,
        cargo: (u) => (u.t === TRANSPORT ? u.flags >> CARGO_SHIFT : 0),
        sees: (x, y) => !!g.view && x >= g.view.x0 && x <= g.view.x1 && y >= g.view.y0 && y <= g.view.y1,
      });
    },
    // Snapshots for `seconds` with nothing happening.
    wait(seconds) {
      const out = [];
      for (let t = 0; t < seconds; t += 1) out.push(g.snap(1));
      return out;
    },
  };
  return g;
}

const told = (outs) => outs.flatMap((o) => o.lines);

test('a battle alerts once, when it has cost enough, however long it lasts', () => {
  const g = game();
  const u = g.unit(1, 1000, 1000);
  g.snap();
  u.hp -= 5;                              // a scratch: not yet
  let out = g.snap();
  assert.equal(out.lines.length, 0);
  assert.equal(out.pings.length, 0);
  u.hp -= 15;                             // 20 % of a unit: it counts
  out = g.snap();
  assert.equal(out.pings.length, 1);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].length, 1);
  assert.equal(out.sound, true);
  const lines = [];
  for (let i = 0; i < 100; i++) {         // ten seconds more of the same fight
    u.hp -= 0.5;
    lines.push(...g.snap().lines);
  }
  assert.equal(lines.length, 0);
});

test('a battle that dies down and flares up again alerts again', () => {
  const g = game();
  const u = g.unit(1, 1000, 1000);
  g.snap();
  u.hp -= 30;
  assert.equal(g.snap().lines.length, 1);
  g.wait(ALERT.quiet + 2);
  u.hp -= 30;
  g.now += ALERT.soundEvery;              // the sound has had time to come back too
  const out = g.snap();
  assert.equal(out.lines.length, 1);
  assert.equal(out.sound, true);
});

test('hits close together are one battle, far apart two', () => {
  const g = game();
  const a = g.unit(1, 1000, 1000), b = g.unit(2, 1000 + ALERT.radius / 2, 1000), c = g.unit(3, 3000, 3000);
  g.snap();
  a.hp -= 30; b.hp -= 30; c.hp -= 30;
  const out = g.snap();
  assert.equal(out.pings.length, 2);
  assert.equal(out.lines.length, 1);      // both in one line: "under attack in 2 places"
  assert.equal(out.lines[0].length, 2);
});

test('a battle on screen is not news', () => {
  const g = game();
  g.view = { x0: 0, y0: 0, x1: 2000, y1: 2000 };
  const u = g.unit(1, 1000, 1000);
  g.snap();
  u.hp -= 50;
  const out = g.snap();
  assert.equal(out.lines.length + out.pings.length, 0);
  // Looked at once, it stays told for as long as it goes on, even after the camera moves away.
  g.view = null;
  u.hp -= 20;
  const later = g.snap();
  assert.equal(later.lines.length + later.pings.length, 0);
});

test('battles starting while the feed waits share a line when it may speak again', () => {
  const g = game();
  const a = g.unit(1, 0, 3000), b = g.unit(2, 2000, 3000), c = g.unit(3, 4000, 3000);
  g.snap();
  a.hp -= 30;
  assert.equal(g.snap().lines.length, 1);
  b.hp -= 30;
  let out = g.snap();
  assert.equal(out.lines.length, 0, 'too soon after the last line');
  assert.equal(out.pings.length, 1, 'the minimap pings at once');
  c.hp -= 30;
  g.snap();
  const outs = [];
  for (let i = 0; i < ALERT.lineEvery / 100; i++) {
    a.hp -= 0.1; b.hp -= 0.1; c.hp -= 0.1;
    outs.push(g.snap());
  }
  const lines = told(outs);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 2, 'the two waiting battles in one line');
  assert.ok(!outs.some((o) => o.sound), 'the sound waits longer than the feed');
});

test('a waiting battle the player looks at is dropped', () => {
  const g = game();
  const a = g.unit(1, 0, 3000), b = g.unit(2, 2000, 3000);
  g.snap();
  a.hp -= 30;
  g.snap();
  b.hp -= 30;
  g.snap();
  g.view = { x0: 1500, y0: 2500, x1: 2500, y1: 3500 };
  const outs = [];
  for (let i = 0; i < ALERT.lineEvery / 100 + 5; i++) outs.push(g.snap());
  assert.equal(told(outs).length, 0);
});

test('a city of yours under attack and a loaded transport under fire alert at once', () => {
  const g = game();
  const u = g.unit(1, 3000, 3000);
  g.snap();
  u.hp -= 30;
  assert.equal(g.snap().lines.length, 1);
  g.cityHp[0] -= 1;                       // the first hit on the city: no waiting for the feed
  let out = g.snap(ALERT.urgentSoundGap / 1000 + 1);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0][0].city, 0);
  assert.equal(out.sound, true, 'with its own sound, though the last one was only seconds ago');
  const ship = g.unit(2, 1500, 4000, { t: TRANSPORT, hp: 150, flags: 6 << CARGO_SHIFT });
  g.snap(1);
  ship.hp -= 2;
  out = g.snap();
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0][0].cargo, 6);
  // The enemy's city losing HP is not yours to worry about.
  g.wait(3);
  g.cityHp[1] -= 10;
  assert.equal(g.snap().lines.length, 0);
});

test('two cities attacked at once: two lines, one sound', () => {
  const g = game();
  g.cities.push({ x: 9000, y: 9000 });
  g.cityOwner.push(YOU);
  g.cityHp.push(100);
  g.snap();
  g.cityHp[0] -= 1;
  assert.equal(g.snap().sound, true);
  g.cityHp[2] -= 1;
  const out = g.snap();
  assert.equal(out.lines.length, 1);
  assert.equal(out.sound, false);
});

test('units fighting at a city under attack are in its line', () => {
  const g = game();
  const u = g.unit(1, 50, 50);
  g.snap();
  u.hp -= 30;
  g.cityHp[0] -= 5;
  const out = g.snap();
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0][0].city, 0);
  assert.equal(told([g.snap(ALERT.lineEvery / 1000)]).length, 0);
});

test('a city captured ends its battle', () => {
  const g = game();
  g.snap();
  g.cityHp[0] -= 5;
  g.snap();
  assert.equal(g.watch.battles.length, 1);
  g.cityOwner[0] = ENEMY;
  g.snap();
  assert.equal(g.watch.battles.length, 0);
});

test('hits on units the player sent to fight are not news until they are done', () => {
  const g = game();
  const u = g.unit(1, 1000, 1000);
  g.snap();
  g.watch.ordered([1], true, false, g.now);
  u.flags = 2;                            // on its way
  g.snap();
  u.flags = 1;                            // fighting
  u.hp -= 50;
  assert.equal(g.snap().lines.length, 0);
  u.flags = 0;                            // done: idle again
  g.wait(3);
  u.hp -= 20;                             // now someone attacks it where it stands
  assert.equal(g.snap().lines.length, 1);
});

test('another order ends the fight it was sent to; a queued one does not', () => {
  const g = game();
  const a = g.unit(1, 0, 3000, { flags: 2 }), b = g.unit(2, 3000, 3000, { flags: 2 });
  g.snap();
  g.watch.ordered([1, 2], true, false, g.now);
  g.watch.ordered([1], false, true, g.now);     // Shift + move: after the fight
  g.watch.ordered([2], false, false, g.now);    // a move instead of the fight
  a.hp -= 30; b.hp -= 30;
  const out = g.snap();
  assert.equal(out.pings.length, 1);
  assert.deepEqual([out.pings[0].x, out.pings[0].y], [3000, 3000]);
});

test('a fight order that never gets going lapses', () => {
  const g = game();
  const u = g.unit(1, 1000, 1000);
  g.snap();
  g.watch.ordered([1], true, false, g.now);
  g.wait(ALERT.orderWait / 1000 + 1);     // never moved: the target was gone already
  u.hp -= 30;
  assert.equal(g.snap().lines.length, 1);
});

test('disbanding, a new kind and healing are not hits', () => {
  const g = game();
  const a = g.unit(1, 0, 3000), b = g.unit(2, 3000, 3000), c = g.unit(3, 0, 0);
  g.snap();
  a.flags = 4; a.hp -= 50;                // disbanding
  b.t = 1; b.hp = 40;                     // made a Hero or a Healer: the HP of its new kind
  c.hp = 100;
  const out = g.snap();
  assert.equal(out.lines.length + out.pings.length, 0);
});

test('a unit gone right after a hit died; one gone without a hit went on board', () => {
  const g = game();
  const a = g.unit(1, 0, 3000), b = g.unit(2, 3000, 3000);
  g.snap();
  a.hp -= 5;                              // a scratch, then it is gone: killed
  g.snap();
  g.units.delete(1);
  let out = g.snap();
  assert.equal(out.lines.length, 1);
  g.units.delete(2);                      // never hit: boarded a transport
  out = g.snap(ALERT.lineEvery / 1000);
  assert.equal(out.lines.length + out.pings.length, 0);
  void b;
});

// Shift + Space: what each press goes to, as keys.
const presses = (log, times, from = 0, gap = 500) => {
  const out = [];
  for (let k = 0; k < times; k++) out.push(log.next(from + k * gap)?.e.key);
  return out;
};

test('Shift + Space goes through the last alerts, newest first, then back to the newest', () => {
  const log = new AlertLog();
  assert.equal(log.next(0), null, 'nothing yet');
  for (const key of ['lost Lyon', 'units near Cork', 'lost Paris']) log.add({ key });
  assert.deepEqual(presses(log, 4), ['lost Paris', 'units near Cork', 'lost Lyon', 'lost Paris']);
  const { i, n } = log.next(2000);
  assert.deepEqual([i, n], [1, 3], 'which one of how many, for the feed');
});

test('only the last few alerts are kept', () => {
  const log = new AlertLog();
  for (let k = 1; k <= ALERT.log + 2; k++) log.add({ key: `a${k}` });
  assert.equal(log.list.length, ALERT.log);
  assert.equal(log.list[0].key, `a${ALERT.log + 2}`);
  assert.ok(!log.list.some((e) => e.key === 'a1' || e.key === 'a2'), 'the oldest are gone');
});

test('a pause starts over from the newest; a new alert is next at once', () => {
  const log = new AlertLog();
  for (const key of ['a', 'b', 'c']) log.add({ key });
  assert.deepEqual(presses(log, 2), ['c', 'b']);
  assert.equal(log.next(1000 + ALERT.tourMs).e.key, 'c', 'after a pause');
  assert.equal(log.next(1000 + ALERT.tourMs + 500).e.key, 'b');
  log.add({ key: 'd' });
  assert.equal(log.next(1000 + ALERT.tourMs + 1000).e.key, 'd');
  assert.equal(log.next(1000 + ALERT.tourMs + 1500).e.key, 'a', 'then on where it was');
});

test('the same alert again moves to the front; dropped ones are gone', () => {
  const log = new AlertLog();
  for (const key of ['lost Lyon', 'lost Paris']) log.add({ key, city: key === 'lost Lyon' ? 1 : 2 });
  log.add({ key: 'lost Lyon', city: 1 });                  // retaken and lost again
  assert.deepEqual(log.list.map((e) => e.key), ['lost Lyon', 'lost Paris']);
  log.drop((e) => e.city === 2);
  assert.deepEqual(log.list.map((e) => e.key), ['lost Lyon']);
});
