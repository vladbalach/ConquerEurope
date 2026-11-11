// Group moves in formation (shared/formation.js): infantry in front, archers behind, cavalry on the wings,
// facing the way the right button was dragged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formationSlots, formationRole } from '../shared/formation.js';
import { setup, nav } from './helpers.js';

const S = 17;
// Where a place is in the formation's own terms: `f` ahead of (tx, ty) the way it faces, `s` to its right.
const local = ([x, y], tx, ty, facing) => {
  const dx = Math.cos(facing), dy = Math.sin(facing);
  return { f: (x - tx) * dx + (y - ty) * dy, s: (x - tx) * -dy + (y - ty) * dx };
};

// A mixed group standing in a square west of (0, 0), as { type, x, y }.
function army(counts) {
  const out = [];
  let i = 0;
  for (const [type, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++, i++) out.push({ type, x: -300 + (i % 6) * 10, y: Math.floor(i / 6) * 10 });
  }
  return out;
}
const lay = (units, facing = null) => formationSlots(units, 0, 0, {
  spacing: S, facing, pos: (u) => [u.x, u.y], role: (u) => formationRole(u.type, u.kind),
});

test('roles: infantry in front, archers behind, Healers at the back, riders on the wings', () => {
  assert.equal(formationRole('infantry'), 'front');
  assert.equal(formationRole('archer'), 'back');
  assert.equal(formationRole('healer'), 'rear');
  assert.equal(formationRole('cavalry'), 'wing');
  assert.equal(formationRole('knight'), 'wing');
  assert.equal(formationRole('hero', 'archer'), 'back');
  assert.equal(formationRole('hero', 'cavalry'), 'wing');
  assert.equal(formationRole('hero', 'infantry'), 'front');
  assert.equal(formationRole('battleship'), 'front');
  assert.equal(formationRole('transport'), 'back');
});

for (const facing of [0, Math.PI / 2, 2.4, -1]) {
  test(`infantry ahead of the archers, cavalry beside them, facing ${facing}`, () => {
    const units = army({ infantry: 8, archer: 6, cavalry: 4, healer: 1 });
    const slots = lay(units, facing);
    assert.equal(slots.size, units.length);
    const at = (u) => local(slots.get(u), 0, 0, facing);
    const of = (type) => units.filter((u) => u.type === type).map(at);
    const inf = of('infantry'), arch = of('archer'), cav = of('cavalry'), heal = of('healer');
    const minInf = Math.min(...inf.map((p) => p.f)), maxArch = Math.max(...arch.map((p) => p.f));
    assert.ok(minInf > maxArch, 'every infantry place is ahead of every archer place');
    assert.ok(heal[0].f < Math.min(...arch.map((p) => p.f)), 'the Healer is behind the archers');
    const middle = [...inf, ...arch, ...heal];
    const left = Math.min(...middle.map((p) => p.s)), right = Math.max(...middle.map((p) => p.s));
    assert.equal(cav.filter((p) => p.s < left).length, 2, 'two riders on the left wing');
    assert.equal(cav.filter((p) => p.s > right).length, 2, 'two riders on the right wing');
    // Every unit has its own place.
    const keys = new Set([...slots.values()].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`));
    assert.equal(keys.size, units.length);
  });
}

test('without a facing, the formation faces the way the group goes', () => {
  const units = army({ infantry: 4, archer: 4 });
  const slots = lay(units);                  // the group is west of (0, 0): it goes east
  for (const u of units) {
    const { f } = local(slots.get(u), 0, 0, 0);
    if (u.type === 'infantry') assert.ok(f > 0, 'infantry east of the place');
    else assert.ok(f < 0, 'archers west of it');
  }
});

test('riders alone form a block, not two wings', () => {
  const units = army({ cavalry: 6 });
  const slots = lay(units, 0);
  const s = [...slots.values()].map((p) => local(p, 0, 0, 0).s);
  assert.ok(Math.max(...s) - Math.min(...s) <= S * 3, 'as wide as a block');
});

// A big mixed army in a crowd 150 km wide west of Samara, all A's.
function bigArmy(counts) {
  const s = setup();
  const samara = s.city('Samara');
  for (const c of s.game.cities) if (Math.hypot(c.x - samara.x, c.y - samara.y) < 400) c.owner = s.a.id;
  const units = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [type, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 50; tries++) {
        const x = samara.x - 220 + rand() * 150, y = samara.y - 100 + rand() * 150;
        if (nav.walkable(x, y)) { units.push(s.spawn(s.a.id, type, x, y)); break; }
      }
    }
  }
  s.run(1);
  return { ...s, units, tx: samara.x - 120, ty: samara.y - 260 };
}

test('a big army ends in its formation: everyone at their place, infantry ahead of the archers', () => {
  const { game, a, units, run, tx, ty } = bigArmy({ infantry: 70, archer: 50, cavalry: 30 });
  const facing = Math.PI / 2;               // facing back the way they came: the archers walk through the infantry
  a.commandTokens = 10;
  game.handleCommand(a, { t: 'move', ids: units.map((u) => u.id), x: tx, y: ty, f: facing });
  const place = new Map(units.map((u) => [u, [u.order.x, u.order.y]]));
  const pts = [...place.values()];
  let stacked = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < 8) stacked++;
  }
  assert.ok(stacked <= 2, `one formation, not several on top of each other (${stacked} places on top of others)`);
  run(60);
  const off = units.map((u) => Math.hypot(u.x - place.get(u)[0], u.y - place.get(u)[1]));
  assert.ok(Math.max(...off) < 8, `every unit at its place (the farthest is ${Math.max(...off).toFixed(1)} km off)`);
  const dx = Math.cos(facing), dy = Math.sin(facing);
  const fwd = (u) => u.x * dx + u.y * dy;
  const inf = units.filter((u) => u.type === 'infantry').map(fwd), arch = units.filter((u) => u.type === 'archer').map(fwd);
  assert.ok(Math.min(...inf) > Math.max(...arch), 'every infantry unit stands ahead of every archer');
});

test('a unit pushed off its place in a formation walks back to it', () => {
  const { game, a, spawn, city, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const units = [0, 1, 2, 3].map((k) => spawn(a.id, 'infantry', x, y - 12 + k * 8));
  game.handleCommand(a, { t: 'move', ids: units.map((u) => u.id), x: x - 30, y });
  run(10);
  const u = units[0];
  assert.ok(u.post && u.order.kind === 'idle', 'idle at its place, which it keeps');
  const [px, py] = [u.post.x, u.post.y];
  u.x += 12;                                // shoved aside
  run(5);
  assert.ok(Math.hypot(u.x - px, u.y - py) < 1, 'back at its place');
  // A new order ends it: a stop leaves the unit standing where it is.
  game.handleCommand(a, { t: 'stop', ids: [u.id] });
  assert.equal(u.post, null);
});

test('a unit walks through a formation standing at its places, which closes behind it', () => {
  const { game, a, spawn, city, run } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 80, y = lyon.y;
  const block = [];
  for (let i = 0; i < 25; i++) block.push(spawn(a.id, 'infantry', x - 20 + (i % 5) * 9, y - 20 + Math.floor(i / 5) * 9));
  game.handleCommand(a, { t: 'move', ids: block.map((u) => u.id), x, y });
  run(15);
  assert.ok(block.every((u) => u.post && u.order.kind === 'idle'), 'the formation stands at its places');
  const walker = spawn(a.id, 'cavalry', x, y - 90);       // north of it, straight across it to the south
  game.handleCommand(a, { t: 'move', ids: [walker.id], x, y: y + 90 });
  run(12);
  assert.equal(walker.order.kind, 'idle');
  assert.ok(Math.hypot(walker.x - x, walker.y - (y + 90)) < 5, 'it got through to the far side');
  run(8);
  const off = block.map((u) => Math.hypot(u.x - u.post.x, u.y - u.post.y));
  assert.ok(Math.max(...off) <= 3.5, `the formation closed behind it (the farthest is ${Math.max(...off).toFixed(1)} km off)`);
});

test('units sent to one spot (a rally point, a single unit) keep no place', () => {
  const { game, a, spawn, city, run } = setup();
  const lyon = city('Lyon');
  const u = spawn(a.id, 'infantry', lyon.x - 60, lyon.y);
  game.handleCommand(a, { t: 'move', ids: [u.id], x: lyon.x - 90, y: lyon.y });
  run(5);
  assert.equal(u.order.kind, 'idle');
  assert.equal(u.post, null, 'a single unit stops where it gets to');
});

test('a move order with `f` turns the formation that way', () => {
  const { game, a, city, spawn } = setup();
  const lyon = city('Lyon');
  const x = lyon.x - 60, y = lyon.y;
  const units = [];
  for (let i = 0; i < 9; i++) {
    const type = i < 4 ? 'infantry' : i < 7 ? 'archer' : 'cavalry';
    const ux = x - 40 + (i % 3) * 8, uy = y - 8 + Math.floor(i / 3) * 8;
    if (nav.walkable(ux, uy)) units.push(spawn(a.id, type, ux, uy));
  }
  const tx = x, ty = y + 20;
  // The group goes east; the formation is told to face north.
  const facing = -Math.PI / 2;
  game.handleCommand(a, { t: 'move', ids: units.map((u) => u.id), x: tx, y: ty, f: facing });
  const dest = nav.nearestWalkable(tx, ty, 200, nav.landOf(units[0].x, units[0].y));
  const at = (u) => local([u.order.x, u.order.y], dest[0], dest[1], facing);
  const inf = units.filter((u) => u.type === 'infantry').map(at), arch = units.filter((u) => u.type === 'archer').map(at);
  assert.ok(inf.length && arch.length);
  assert.ok(Math.min(...inf.map((p) => p.f)) > Math.max(...arch.map((p) => p.f)), 'infantry north of the archers');
});
