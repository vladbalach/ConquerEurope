// Pathfinding and crowds at scale: the precomputed steps, the landmark estimates that keep long searches
// small, the search budget per tick, group orders that give every unit its way at once, and collisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, nav, map } from './helpers.js';

const city = (name) => map.cities.find((c) => c.n === name);

test('the step masks allow exactly the steps stepOk and seaStepOk allow', () => {
  const { w, h } = nav;
  let checked = 0;
  for (let c = 0; c < w * h; c += 5) {
    const ci = c % w, cj = (c - ci) / w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const n = nj * w + ni;
        if (nav.landStep(c, n) !== nav.stepOk(c, n)) assert.fail(`land step ${c} -> ${n}`);
        if (nav.seaStep(c, n) !== (n === c ? nav.sea[c] > 0 : nav.seaStepOk(c, n))) assert.fail(`sea step ${c} -> ${n}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 1e6);
});

test('landmark estimates never say more than the way really is', () => {
  nav.buildLandmarks();
  const K = nav.landmarks.length / (nav.w * nav.h);
  const dist = new Int32Array(nav.w * nav.h);
  // From a few cities (land) and a few ports (sea): the walk (sail) to every cell of the same landmass
  // (sea) is at least what any landmark says.
  const starts = [];
  for (const name of ['Paris', 'Helsinki', 'Athens']) starts.push([nav.cellOf(city(name).x, city(name).y), false]);
  for (const name of ['Lisbon', 'Rostock', 'Varna']) {
    const p = nav.nearestSea(city(name).x, city(name).y, 60);
    starts.push([nav.cellOf(p[0], p[1]), true]);
  }
  for (const [a, sea] of starts) {
    nav.distances([a], sea ? nav.seaSteps : nav.landSteps, dist);
    let compared = 0;
    for (let b = 0; b < dist.length; b++) {
      if (dist[b] === 0x7fffffff) continue;
      for (let k = 0; k < K; k++) {
        const va = nav.landmarks[a * K + k], vb = nav.landmarks[b * K + k];
        if (va === 0xffff || vb === 0xffff) continue;
        if (Math.abs(va - vb) > dist[b]) assert.fail(`landmark ${k}: cells ${a} and ${b} are ${dist[b]} apart, estimate ${Math.abs(va - vb)}`);
        compared++;
      }
    }
    assert.ok(compared > 1000, `landmarks cover the landmass (sea) of cell ${a}`);
  }
});

// Going round the Baltic or across the Balkans, the straight line says far too little: without the
// landmarks these searches looked at most of the continent (350,000 to 400,000 cells) and took ~100 ms.
test('long walks round a sea are found with a small search', () => {
  for (const [from, to] of [['Lisbon', 'Stockholm'], ['Rome', 'Oslo'], ['Lisbon', 'Istanbul']]) {
    const a = city(from), b = city(to);
    const path = nav.findPath(a.x + 15, a.y + 15, b.x + 15, b.y + 15);
    assert.ok(path && path.length > 0, `${from} -> ${to}: found`);
    assert.ok(nav.lastExpansions < 200000, `${from} -> ${to}: ${nav.lastExpansions} cells searched`);
  }
});

test('background route searches stop once the work of a tick is spent', () => {
  const lisbon = city('Lisbon'), stockholm = city('Stockholm');
  const ends = ['Istanbul', 'Moscow', 'Helsinki', 'Athens', 'Kyiv', 'Oslo', 'Sevastopol', 'Bucharest', 'Riga', 'Minsk']
    .map(city).filter(Boolean);
  nav.cache.clear();
  nav.beginTick();
  // Player orders (never held back) spend the work of this tick...
  for (let i = 0; nav.expansionBudget > 0 && i < 200; i++) {
    const to = ends[i % ends.length], off = 10 + 20 * Math.floor(i / ends.length);
    nav.findPathCached(lisbon.x + off, lisbon.y + 10, to.x + 10, to.y + off, true);
  }
  assert.ok(nav.expansionBudget <= 0, 'player orders spent the work of the tick');
  // ...so background searches wait for the next one, and player orders still don't.
  assert.equal(nav.findPathCached(lisbon.x + 15, lisbon.y + 15, stockholm.x + 15, stockholm.y + 15), undefined);
  assert.ok(nav.findPathCached(lisbon.x + 15, lisbon.y + 15, stockholm.x + 15, stockholm.y + 15, true), 'a player order never waits');
  nav.beginTick();
  assert.ok(nav.findPathCached(lisbon.x + 20, lisbon.y + 15, stockholm.x + 20, stockholm.y + 20), 'the next tick searches again');
});

// Units of a group that could not see the first waypoint of the group's route used to wait for a
// route search of their own, a few per tick: hundreds of them stood still for up to a second.
test('every unit of a big group order has its way at once', () => {
  const { game, a, spawn } = setup();
  const units = [];
  for (const name of ['Bordeaux', 'Toulouse', 'Lyon', 'Nantes']) {
    const c = city(name);
    for (let i = 0; i < 50; i++) {
      const ang = i * 2.4, d = 25 + (i % 7) * 9;
      const x = c.x + Math.cos(ang) * d, y = c.y + Math.sin(ang) * d;
      if (nav.landmass(x, y) === nav.landmass(c.x, c.y)) units.push(spawn(a.id, 'infantry', x, y));
    }
  }
  const to = city('Warsaw');
  game.handleCommand(a, { t: 'move', ids: units.map((u) => u.id), x: to.x, y: to.y });
  const waiting = units.filter((u) => !u.route && !nav.clear(u.x, u.y, u.order.x, u.order.y));
  assert.equal(waiting.length, 0, `${waiting.length} of ${units.length} units have no way to go yet`);
  game.tick(0.05);
  assert.ok(units.every((u) => u.route), 'all on their way after one tick');
});

// A packed crowd next to a city, on hold (nobody walks off): units 12 km wide, 9 km apart, on land
// and outside the walls.
function crowd(name) {
  const ctx = setup();
  const c = ctx.city(name);
  const units = [];
  for (let row = -7; row <= 7; row++) {
    for (let col = -7; col <= 7; col++) {
      const x = c.x + 20 + col * 9 + (row % 2) * 4.5, y = c.y + row * 9;
      if (nav.walkable(x, y) && Math.hypot(x - c.x, y - c.y) > c.r + 8) units.push(ctx.spawn(ctx.a.id, units.length % 4 ? 'infantry' : 'archer', x, y));
    }
  }
  for (const u of units) u.orderHold();
  ctx.run(6);
  return { c, units };
}

test('a crowd pushes itself apart, clear of the walls', () => {
  const { c, units } = crowd('Lyon');
  let worst = 0;
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const u = units[i], v = units[j];
      worst = Math.max(worst, u.r + v.r - Math.hypot(u.x - v.x, u.y - v.y));
    }
  }
  assert.ok(worst < 0.5, `units overlap by ${worst.toFixed(2)} km at most`);
  assert.ok(units.every((u) => Math.hypot(u.x - c.x, u.y - c.y) >= c.r + u.r - 0.5), 'outside the walls');
});

test('a crowd on the coast is never pushed into the sea', () => {
  const { units } = crowd('Brest');
  assert.ok(units.length > 60);
  for (const u of units) assert.ok(nav.walkable(u.x, u.y), `unit ${u.id} is on land`);
});
