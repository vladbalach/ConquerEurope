// Roads (TECHS.roads): land units march faster in the regions their owner holds whole; and where a region's
// land is (shared/regions.js), looked up in the land grid's cells or in the map's territories.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, TECHS } from '../shared/config.js';
import { regionGrid, regionAtPoint, NO_REGION } from '../shared/regions.js';
import { saveGame, restoreGame } from '../server/save.js';
import { setup, map, nav, DT } from './helpers.js';

const ROADS = TECHS.roads, FASTER = 1 + ROADS.speedPercent / 100;
const regionOf = (name) => map.countries.findIndex((c) => c.n === name);
const HUNGARY = regionOf('Hungary');

test('every city stands in its own region; sea and land of no city are in none', () => {
  const { game, city } = setup();
  for (const c of game.cities) assert.equal(game.regionAt(c.x, c.y), c.country, c.name);
  const lis = city('Lisbon');
  assert.equal(game.regionAt(lis.x - 200, lis.y), -1, 'the Atlantic');
  assert.equal(game.regionAt(map.bounds.x0 - 100, map.bounds.y0 - 100), -1, 'off the map');
});

test("the land grid's regions are the map's territories (away from their borders, where a cell can be either)", () => {
  const grid = regionGrid(map, nav), R = 2;          // a point whose 5x5 cells all agree is not near a border
  let tested = 0;
  const b = map.bounds;
  for (let y = b.y0; y < b.y1; y += 13) {
    for (let x = b.x0; x < b.x1; x += 13) {
      const c = nav.cellOf(x, y);
      if (c < 0) continue;
      const i = c % nav.w, j = (c - i) / nav.w;
      let inside = true;
      for (let dj = -R; dj <= R && inside; dj++) {
        for (let di = -R; di <= R && inside; di++) {
          const ii = i + di, jj = j + dj;
          inside = ii >= 0 && jj >= 0 && ii < nav.w && jj < nav.h && grid[jj * nav.w + ii] === grid[c];
        }
      }
      if (!inside) continue;
      tested++;
      assert.equal(regionAtPoint(map, x, y), grid[c] === NO_REGION ? -1 : grid[c], `at ${x.toFixed(0)}, ${y.toFixed(0)}`);
    }
  }
  assert.ok(tested > 50000, `${tested} points`);
});

test('the region grid is made once per land grid: games share it, a rebuilt map gets its own', () => {
  assert.equal(regionGrid(map, nav), regionGrid(map, nav));
  const rebuilt = { ...nav, poly: new Uint16Array(nav.poly) };
  const again = regionGrid(map, rebuilt);
  assert.notEqual(again, regionGrid(map, nav));
  assert.equal(Buffer.compare(again, regionGrid(map, nav)), 0, 'the same land: the same regions');
});

// The two-player game of helpers.js with all of Hungary A's. Places near Budapest well inside Hungary, on land.
function hungaryGame() {
  const ctx = setup();
  for (const c of ctx.game.cities) if (c.country === HUNGARY) c.owner = ctx.a.id;
  const bp = ctx.city('Budapest');
  const at = (dx, dy) => {
    const p = [bp.x + dx, bp.y + dy];
    assert.equal(ctx.game.regionAt(...p), HUNGARY);
    assert.ok(nav.walkable(...p));
    return p;
  };
  // A unit sent 30 km east.
  ctx.march = (owner, type, [x, y]) => {
    const u = ctx.spawn(owner.id, type, x, y);
    owner.commandTokens = 20;
    ctx.game.handleCommand(owner, { t: 'move', ids: [u.id], x: x + 30, y });
    return u;
  };
  // One tick of the game: how far `u` went in it.
  ctx.stride = (u) => {
    const [px, py] = [u.x, u.y];
    ctx.game.tick(DT);
    return Math.hypot(u.x - px, u.y - py);
  };
  return { ...ctx, at };
}

const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-6, `${what}: ${got} km per tick, not ${want}`);

test(`Roads: land units march ${ROADS.speedPercent}% faster in a region their owner holds whole, at once`, () => {
  const { a, march, stride, at } = hungaryGame();
  const inf = march(a, 'infantry', at(0, 30));
  const cav = march(a, 'cavalry', at(0, -30));
  near(stride(inf), UNITS.infantry.moveSpeed * DT, 'without Roads');
  a.tech = { ...a.tech, roads: 1 };              // researched while they march
  near(stride(inf), UNITS.infantry.moveSpeed * FASTER * DT, 'infantry on roads');
  near(stride(cav), UNITS.cavalry.moveSpeed * FASTER * DT, 'cavalry on roads');
});

test("Roads: not in a region someone else holds, nor in one held only in part; never at sea", () => {
  const { game, a, b, march, stride, at, city, spawn } = hungaryGame();
  a.tech = { ...a.tech, roads: 1 };
  b.tech = { ...b.tech, roads: 1 };
  // B's cavalry in A's Hungary: B has Roads too, but not this region.
  const theirs = march(b, 'cavalry', at(-30, 0));
  near(stride(theirs), UNITS.cavalry.moveSpeed * DT, "another player's region");

  // One city of Hungary lost: from the next tick, A's units there are as fast as without Roads.
  const mine = march(a, 'infantry', at(0, 30));
  near(stride(mine), UNITS.infantry.moveSpeed * FASTER * DT, 'whole');
  game.captureCity(city('Szeged'), b.id);
  near(stride(mine), UNITS.infantry.moveSpeed * DT, 'one city lost');

  // Ships never have roads, whatever their owner holds.
  const lis = city('Lisbon');
  const ship = spawn(a.id, 'transport', lis.x - 200, lis.y);
  assert.equal(ship.moveSpeed, UNITS.transport.moveSpeed);
});

test('Roads is researched on the Land tab like any technology; a save from before it has it unresearched', () => {
  const { game, a, run } = setup();
  const sent = [];
  a.client.send = (m) => sent.push(m);
  a.gold = 1000;
  a.commandTokens = 20;
  game.handleCommand(a, { t: 'research', tech: 'roads' });
  assert.equal(a.research?.tech, 'roads', 'no other technology needed first');
  assert.equal(a.gold, 1000 - ROADS.levels[0].cost);
  run(ROADS.levels[0].time + 0.1);
  assert.equal(a.tech.roads, 1);
  assert.ok(sent.some((m) => m.kind === 'researched' && m.tech === 'roads'));

  const save = JSON.parse(JSON.stringify(saveGame(game)));
  for (const p of save.players) delete p.tech.roads;
  const copy = restoreGame(save, { map, nav, hostId: 0 });
  assert.equal(copy.players.get(a.id).tech.roads, 0);
});
