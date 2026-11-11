// Mountains (tools/mountains.js, marked by tools/build-map.js): land no unit can cross. The cells the map
// draws are the cells the game blocks; they keep off the coast and the cities and wall nobody in; units
// walk round them or through their passes. Also Norway's simpler coast (SMOOTH_COASTS in build-map.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, nav, map, DT } from './helpers.js';
import { NavGrid } from '../server/nav.js';
import { encodeMask, decodeMask } from '../shared/mountains.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const navData = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'navgrid.json'), 'utf8'));
const city = (name) => map.cities.find((c) => c.n === name);
// A game in which A holds every city but Lisbon: no city shoots at A's units on their way.
function quiet() {
  const ctx = setup();
  for (const c of ctx.game.cities) c.owner = ctx.a.id;
  ctx.city('Lisbon').owner = ctx.b.id;
  return ctx;
}

// Map points (km) of these latitudes and longitudes, as tools/build-map.js projects them.
const AT = {
  ortler: [-138, 604],        // 46.55 N 10.2 E: the Alps
  tauern: [45, 542],          // 47.12 N 12.6 E
  caucasus: [2398, 467],      // 43.3 N 42.5 E
  pyrenees: [-899, 972],      // 42.65 N 1.0 E
  brenner: [-38, 556],        // 47.0 N 11.5 E: passes
  gotthard: [-253, 600],      // 46.55 N 8.7 E
  darial: [2575, 453],        // 42.75 N 44.6 E
  hardanger: [-314, -940],    // 60.35 N 6.3 E: the Hardangerfjord, filled
  trondheim: [-70, -1288],    // 63.6 N 10.6 E: the Trondheimsfjord, filled
};

test('the mountains the map draws are exactly the cells units cannot cross', () => {
  const m = map.mountains;
  assert.equal(m.code, navData.mountains, 'map.json and navgrid.json carry the same cells');
  assert.deepEqual([m.cell, m.x0, m.y0, m.w, m.h], [nav.cell, nav.x0, nav.y0, nav.w, nav.h], 'on the same grid');
  const mask = decodeMask(m.code, nav.w * nav.h);
  let mountains = 0;
  for (let c = 0; c < mask.length; c++) {
    if (mask[c]) {
      mountains++;
      if (!nav.poly[c] || nav.ground[c] || nav.comp[c] || nav.sea[c]) assert.fail(`cell ${c}: mountains are land nobody walks on`);
    } else if (nav.poly[c] && !nav.ground[c]) {
      assert.fail(`cell ${c}: land without mountains is walkable`);
    }
  }
  assert.ok(mountains > 10000, `${mountains} mountain cells`);
  for (const k of ['ortler', 'tauern', 'caucasus', 'pyrenees']) assert.ok(nav.mountainAt(...AT[k]), `${k}: mountains`);
  for (const k of ['brenner', 'gotthard', 'darial']) assert.ok(nav.walkable(...AT[k]), `${k}: a pass, open`);
});

test('mountain cells code and decode', () => {
  const mask = new Uint8Array(5000);
  for (let k = 0; k < mask.length; k++) mask[k] = (k * 7919) % 13 < 4 || (k > 4000 && k < 4400) ? 1 : 0;
  assert.deepEqual(decodeMask(encodeMask(mask), mask.length), mask);
  mask[0] = 1;
  assert.deepEqual(decodeMask(encodeMask(mask), mask.length), mask, 'starting with a mountain');
  assert.deepEqual(decodeMask(undefined, 10), new Uint8Array(10), 'no mountains');
});

test('mountains keep off the sea and the cities, and wall no land in', () => {
  const { w, h, cell } = nav;
  for (let c = 0; c < w * h; c++) {
    if (!nav.mountain[c]) continue;
    const [x, y] = nav.center(c);
    const ci = c % w, cj = (c - ci) / w;
    // Two cells of land at least between them and any water: a road along every coast.
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        if (di * di + dj * dj > 4 || ci + di < 0 || ci + di >= w || cj + dj < 0 || cj + dj >= h) continue;
        if (!nav.poly[c + dj * w + di]) assert.fail(`mountain cell ${c} is ${Math.hypot(di, dj) * cell} km from the water`);
      }
    }
    for (const t of map.cities) if (Math.hypot(t.x - x, t.y - y) <= 35) assert.fail(`mountain cell ${c} by ${t.n}`);
  }
  // Every landmass of the land grid is still one piece, mountains or not: each city still reaches every
  // other city it reached before.
  const open = new NavGrid({ ...navData, mountains: undefined });
  const pieces = new Map();
  for (let c = 0; c < w * h; c++) {
    if (!nav.comp[c]) continue;
    if (!pieces.has(open.comp[c])) pieces.set(open.comp[c], new Set());
    pieces.get(open.comp[c]).add(nav.comp[c]);
  }
  for (const [land, ids] of pieces) assert.equal(ids.size, 1, `landmass ${land} is one piece (${ids.size})`);
  for (const t of map.cities) assert.ok(nav.walkable(t.x, t.y), `${t.n} stands on open land`);
});

test('units cannot step into mountains, and paths go round them or through a pass', () => {
  // A step from open land onto a mountain cell is refused; so is a straight walk across the Alps.
  let refused = 0;
  for (let c = 0; c < nav.w * nav.h && refused < 50; c++) {
    if (!nav.ground[c] || !nav.mountain[c + 1]) continue;
    const [x, y] = nav.center(c);
    assert.equal(nav.canStep(x, y, x + nav.cell, y), false, `cell ${c}: step onto the mountains`);
    refused++;
  }
  assert.equal(refused, 50);
  const munich = city('Munich'), milan = city('Milan');
  assert.equal(nav.los(munich.x, munich.y, milan.x, milan.y), false, 'no straight way across the Alps');
  const pathAcross = nav.findPath(munich.x, munich.y, milan.x, milan.y);
  assert.ok(pathAcross && pathAcross.length, 'a way round');
  let [x, y] = [munich.x, munich.y], length = 0;
  for (const [px, py] of [...pathAcross, [milan.x, milan.y]]) {
    const steps = Math.ceil(Math.hypot(px - x, py - y));
    for (let s = 1; s <= steps; s++) {
      if (nav.mountainAt(x + ((px - x) * s) / steps, y + ((py - y) * s) / steps)) assert.fail('the path crosses mountains');
    }
    length += Math.hypot(px - x, py - y);
    [x, y] = [px, py];
  }
  const straight = Math.hypot(milan.x - munich.x, milan.y - munich.y);
  assert.ok(length > straight * 1.02 && length < straight * 1.6, `a detour, not a trek (${length.toFixed(0)} km for ${straight.toFixed(0)})`);
});

test('marching across the Alps, units never set foot on a mountain', () => {
  const { game, a, spawn } = quiet();
  const munich = city('Munich'), milan = city('Milan');
  const units = [0, 1, 2].map((k) => spawn(a.id, k === 2 ? 'cavalry' : 'infantry', munich.x + 25, munich.y + 10 * k));
  game.handleCommand(a, { t: 'move', ids: units.map((u) => u.id), x: milan.x, y: milan.y - 30 });
  for (let t = 0; t < 60; t += DT) {
    game.tick(DT);
    for (const u of units) if (nav.mountainAt(u.x, u.y)) assert.fail(`unit ${u.id} in the mountains at ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
  }
  for (const u of units) {
    assert.ok(Math.hypot(u.x - milan.x, u.y - milan.y + 30) < 40, `unit ${u.id} got there (${u.x.toFixed(0)},${u.y.toFixed(0)})`);
  }
});

test('an order into the mountains takes units to the open land nearest to it', () => {
  const { game, a, spawn, run } = quiet();
  const munich = city('Munich');
  const u = spawn(a.id, 'cavalry', munich.x + 25, munich.y);
  game.handleCommand(a, { t: 'move', ids: [u.id], x: AT.tauern[0], y: AT.tauern[1] });
  run(30);
  assert.ok(nav.walkable(u.x, u.y), 'it stands on open land');
  const d = Math.hypot(u.x - AT.tauern[0], u.y - AT.tauern[1]);
  assert.ok(d < 70, `at the edge of the range, not far off (${d.toFixed(0)} km from the point)`);
});

test('a unit caught in the mountains (the map was rebuilt under it) walks out', () => {
  const { game, a, spawn, run } = quiet();
  const u = spawn(a.id, 'infantry', AT.ortler[0], AT.ortler[1]);
  assert.ok(nav.mountainAt(u.x, u.y));
  game.handleCommand(a, { t: 'move', ids: [u.id], x: AT.brenner[0], y: AT.brenner[1] });
  run(30);
  assert.ok(nav.walkable(u.x, u.y), `out on open land (${u.x.toFixed(0)},${u.y.toFixed(0)})`);
  assert.ok(Math.hypot(u.x - AT.brenner[0], u.y - AT.brenner[1]) < 30, 'and on its way');
});

test("Norway's coast is simpler: the fjords are land, and its ports keep their sea", () => {
  assert.ok(nav.walkable(...AT.hardanger), 'the Hardangerfjord is land');
  assert.ok(nav.walkable(...AT.trondheim), 'the Trondheimsfjord is land');
  // The mainland (the landmass of Oslo): far fewer points than Natural Earth's coast had (554).
  const oslo = city('Oslo');
  const inRing = (r, x, y) => {
    let inside = false;
    for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const norway = map.polys.find((p) => inRing(p.r[0], oslo.x, oslo.y));
  assert.ok(norway.r[0].length / 2 < 554, `${norway.r[0].length / 2} points`);
  const { city: gameCity } = setup();
  for (const name of ['Bergen', 'Bodø', 'Tromsø']) assert.ok(gameCity(name).port, `${name} has a port`);
});

// Mountains changed on a running grid (Edit map, NavGrid.editMountains), and walled-in land opened again
// (NavGrid.openWalls, which the build uses too). On a grid of its own: `nav` is shared by the other tests.
const ring = (cx, cy, rad, n) => Array.from({ length: n }, (_, k) => [cx + rad * Math.cos((k / n) * 2 * Math.PI), cy + rad * Math.sin((k / n) * 2 * Math.PI)]);
const ringCells = (g, cx, cy, rad, width) => {
  const out = new Set();
  for (const [x, y] of ring(cx, cy, rad, 90)) for (const c of g.cellsNear(x, y, width)) out.add(c);
  return [...out];
};
const BOURGES = [-725, 500];

test('mountains raised on a running grid block units at once, and walled-in land is opened again', () => {
  const g = new NavGrid(navData);
  const madrid = city('Madrid'), valladolid = city('Valladolid'), zaragoza = city('Zaragoza');
  const beaches = g.landing.size;
  // A ring round Madrid walls it in: no way from Valladolid any more.
  g.editMountains(ringCells(g, madrid.x, madrid.y, 55, 10), true);
  assert.ok(g.mountainAt(madrid.x + 55, madrid.y));
  assert.equal(g.findPath(valladolid.x, valladolid.y, madrid.x, madrid.y), null, 'walled in');
  assert.ok(g.cutOff().length > 0);
  // And a small ring in open country walls in a valley without a city.
  g.editMountains(ringCells(g, BOURGES[0], BOURGES[1], 20, 8), true);
  const res = g.openWalls(map.cities);
  assert.equal(res.passes, 1, 'a pass to Madrid');
  assert.equal(res.pockets, 1, 'the valley filled');
  assert.equal(g.cutOff().length, 0, 'no land walled in');
  assert.ok(g.mountainAt(...BOURGES), 'the valley is mountains now');
  assert.ok(g.findPath(valladolid.x, valladolid.y, madrid.x, madrid.y), 'Madrid can be reached again');
  assert.ok(g.findPath(zaragoza.x, zaragoza.y, madrid.x, madrid.y), 'from every side it was before');
  assert.equal(g.landing.size, beaches, 'the coasts and their beaches are as they were');
  // Changed bit by bit, the grid is the one a fresh start with these mountains makes.
  const fresh = new NavGrid({ ...navData, mountains: encodeMask(g.mountain) });
  assert.deepEqual(g.landSteps, fresh.landSteps, 'the same steps');
  const docks = (n) => [...n.landing].map(([k, v]) => [k, [...v]]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(docks(g), docks(fresh), 'the same coasts, by landmass');
  // Clearing them again opens the land.
  g.editMountains(ringCells(g, madrid.x, madrid.y, 55, 10), false);
  assert.ok(g.walkable(madrid.x + 55, madrid.y));
});

test('a hole an admin erased in a range is left open, unless a city is cut off', () => {
  const g = new NavGrid(navData);
  const hole = g.cellsNear(AT.ortler[0], AT.ortler[1], 10);
  g.editMountains(hole, false);
  assert.ok(g.cutOff().length, 'an open hole in the Alps, walled in');
  const res = g.openWalls(map.cities, undefined, new Set(hole));
  assert.equal(res.pockets + res.passes, 0, 'left as it is');
  assert.ok(g.walkable(...AT.ortler));
  g.openWalls(map.cities);
  assert.ok(g.mountainAt(...AT.ortler), 'without that, the walled-in valley is filled');
});

// A wall of mountains on a grid of its own: the cells within `half` km of x, from y0 to y1.
function walled(x, y0, y1, half) {
  const g = new NavGrid(navData), cells = [];
  for (let y = y0; y <= y1; y += g.cell) for (let dx = -half; dx <= half; dx += g.cell / 2) cells.push(g.cellOf(x + dx, y));
  g.editMountains(cells, true);
  return g;
}
// A game like quiet() on that grid.
function quietOn(g) {
  const ctx = setup(g);
  for (const c of ctx.game.cities) c.owner = ctx.a.id;
  ctx.city('Lisbon').owner = ctx.b.id;
  return ctx;
}

test('archers do not shoot over mountains: they go round them for a clear shot', () => {
  const [bx, by] = BOURGES;
  const g = walled(bx, by - 80, by + 80, 6);
  assert.equal(g.lineOfFire(bx - 25, by, bx + 25, by), false, 'the wall is in the way');
  // On hold, 50 km apart (in range) with the wall between: no shot.
  const ctx = quietOn(g);
  const archer = ctx.spawn(ctx.a.id, 'archer', bx - 25, by);
  const foot = ctx.spawn(ctx.b.id, 'infantry', bx + 25, by);
  ctx.game.handleCommand(ctx.a, { t: 'hold', ids: [archer.id] });
  ctx.run(5);
  assert.equal(foot.hp, foot.maxHp, 'not hit over the mountains');
  // The same without the wall: hit.
  const open = quiet();
  const a2 = open.spawn(open.a.id, 'archer', bx - 25, by), f2 = open.spawn(open.b.id, 'infantry', bx + 25, by);
  open.game.handleCommand(open.a, { t: 'hold', ids: [a2.id] });
  open.run(5);
  assert.ok(f2.hp < f2.maxHp, 'hit in the open');
  // Ordered to attack, it walks round the wall and shoots once it has a clear line, never before.
  const hits = [];
  const take = foot.receiveDamage.bind(foot);
  foot.receiveDamage = (amount, from) => { hits.push(g.lineOfFire(from.x, from.y, foot.x, foot.y)); take(amount, from); };
  ctx.game.handleCommand(ctx.a, { t: 'attack', ids: [archer.id], k: 'u', id: foot.id });
  ctx.run(25);
  assert.ok(hits.length > 0, 'it got its shot');
  assert.ok(hits.every(Boolean), 'every arrow on a clear line');
});

test('cities do not shoot over mountains either', () => {
  const tours = city('Tours');
  const g = walled(tours.x + 25, tours.y - 50, tours.y + 50, 5);
  for (const grid of [g, null]) {
    const ctx = grid ? quietOn(grid) : quiet();
    ctx.city('Tours').owner = ctx.b.id;
    const u = ctx.spawn(ctx.a.id, 'infantry', tours.x + 50, tours.y);
    ctx.run(3);
    if (grid) assert.equal(u.hp, u.maxHp, 'behind the mountains: not shot');
    else assert.ok(u.hp < u.maxHp, 'in the open: shot');
  }
});

test("a game's host takes the map's painted mountains, and new ones at once", async () => {
  const { HostEngine } = await import('../server/host-engine.js');
  const painted = JSON.parse(JSON.stringify(map));
  const mask = decodeMask(painted.mountains.code, nav.w * nav.h);
  const cells = nav.cellsNear(BOURGES[0], BOURGES[1], 15);
  for (const c of cells) mask[c] = 1;
  painted.mountains.code = encodeMask(mask);
  const engine = new HostEngine({
    gameId: '9', title: 'peaks', map: painted, navData,
    roster: [{ id: 0, color: '#e6194b' }, { id: 1, color: '#4363d8' }], hostId: 0, send() {},
  });
  assert.ok(engine.nav.mountainAt(...BOURGES), 'from /map.json, painted after the grid file was built');
  engine.editMountains(cells, false);
  assert.ok(engine.nav.walkable(...BOURGES), 'erased while the game runs');
  assert.ok(!decodeMask(engine.map.mountains.code, mask.length)[nav.cellOf(...BOURGES)], 'and its map follows');
});
