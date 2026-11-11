// Regions: the gold bonus for holding every city of one, and the borders drawn on the map.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY } from '../shared/config.js';
import { regionCities, regionHolder } from '../shared/regions.js';
import { setup, map } from './helpers.js';

const base = ECONOMY.goldPerCityPerTurn, bonus = ECONOMY.regionBonusPerCity;
const regionOf = (name) => map.countries.findIndex((c) => c.n === name);

test('regionHolder: the one player who holds every city, or -1', () => {
  assert.equal(regionHolder([0, 1, 2], (i) => [3, 3, 3][i]), 3);
  assert.equal(regionHolder([0, 1, 2], (i) => [3, 1, 3][i]), -1, 'two owners');
  assert.equal(regionHolder([0, 1], (i) => [-1, -1][i]), -1, 'neutral');
  assert.equal(regionHolder([0, 1], (i) => [2, -1][i]), -1, 'one neutral city left');
  const ids = regionCities(map);
  assert.equal(ids.flat().length, map.cities.length, 'every city is in exactly one region');
  assert.deepEqual(ids[regionOf('Hungary')].map((i) => map.cities[i].n).sort(),
    ['Budapest', 'Cluj', 'Debrecen', 'Košice', 'Pécs', 'Szeged']);
});

test('holding every city of a region makes each of them pay +2 gold per turn, until one is lost', () => {
  const { game, a, b, run } = setup();
  const hungary = game.cities.filter((c) => c.country === regionOf('Hungary'));
  for (const c of hungary) c.owner = a.id;
  const [budapest, cluj] = [hungary.find((c) => c.name === 'Budapest'), hungary.find((c) => c.name === 'Cluj')];
  assert.equal(game.regionHolder(regionOf('Hungary')), a.id);
  for (const c of hungary) assert.equal(c.goldPerTurn, base + bonus, c.name);

  // The turn pays it, and the turn event says how much of the income came from whole regions.
  const sent = [];
  a.client.send = (m) => sent.push(m);
  const mine = game.cities.filter((c) => c.owner === a.id);
  const whole = mine.filter((c) => game.cities.every((o) => o.country !== c.country || o.owner === a.id)).length;
  const before = a.gold;
  game.nextTurnAt = game.time;
  run(0.05);
  assert.equal(a.gold - before, mine.length * base + whole * bonus);
  const turn = sent.find((m) => m.kind === 'turn');
  assert.equal(turn.income, a.gold - before);
  assert.equal(turn.regionBonus, whole * bonus);
  assert.ok(turn.regionBonus >= hungary.length * bonus);

  // One city lost: no city of the region has the bonus, for either player.
  game.captureCity(cluj, b.id);
  assert.equal(game.regionHolder(regionOf('Hungary')), -1);
  assert.equal(budapest.goldPerTurn, base);
  assert.equal(cluj.goldPerTurn, base);
});

test('a one-city region counts as a whole region; neutral cities never have the bonus', () => {
  const { game, a, b } = setup();
  const nicosia = game.cities.find((c) => c.name === 'Nicosia');
  assert.equal(game.cities.filter((c) => c.country === nicosia.country).length, 1);
  nicosia.owner = b.id;
  assert.ok(nicosia.hasRegionBonus);
  assert.equal(nicosia.goldPerTurn, base + bonus);
  nicosia.owner = -1;
  assert.ok(!nicosia.hasRegionBonus);
  game.captureCity(nicosia, a.id);
  assert.equal(nicosia.goldPerTurn, base + bonus);
});

// ---------------------------------------------------------------- borders on the map
function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Whose territory a point is in: a city id, -1 for neutral land, null for the sea.
function territoryAt(x, y) {
  for (const p of map.polys) {
    if (!inRings(p.r, x, y)) continue;
    if (p.c.length < 2) return p.c.length ? p.c[0] : -1;
    let best = -1, bd = Infinity;
    for (const ci of p.c) {
      const d = (map.cities[ci].x - x) ** 2 + (map.cities[ci].y - y) ** 2;
      if (d < bd) { bd = d; best = ci; }
    }
    return best;
  }
  return null;
}

test('map lines: region borders divide regions, faint lines divide cities of one region, nothing else', () => {
  const s = map.segs;
  let checked = 0, sea = 0;
  const kinds = [0, 0];
  for (let i = 0; i < s.length; i += 5) {
    const [x0, y0, x1, y1, kind] = s.slice(i, i + 5);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 2) continue;                       // too short to probe both sides reliably
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, nx = -(y1 - y0) / len * 0.4, ny = (x1 - x0) / len * 0.4;
    const left = territoryAt(mx + nx, my + ny), right = territoryAt(mx - nx, my - ny);
    if (left === null || right === null) { sea++; continue; }
    assert.notEqual(left, right, `segment ${i / 5} lies inside the territory of one city`);
    const regionBorder = left < 0 || right < 0 || map.cities[left].c !== map.cities[right].c;
    const what = `${left < 0 ? 'neutral' : map.cities[left].n} | ${right < 0 ? 'neutral' : map.cities[right].n}`;
    assert.equal(kind, regionBorder ? 1 : 0, `segment ${i / 5}: ${what}`);
    kinds[kind]++;
    checked++;
  }
  assert.ok(checked > 1000, `checked ${checked}`);
  assert.ok(sea < checked * 0.02, `${sea} segments touch the sea`);
  assert.ok(kinds[0] > 100 && kinds[1] > 500, JSON.stringify(kinds));
});

test('map lines: today\'s border between Debrecen and Cluj (both Hungary) is no region border', () => {
  // Cluj is in Romania today. The Hungary/Romania border between the two cities is drawn faint,
  // and the Cluj/Brașov line (Hungary/Wallachia) is a region border.
  const city = (n) => map.cities.findIndex((c) => c.n === n);
  const between = (a, b) => {
    const s = map.segs, out = [];
    for (let i = 0; i < s.length; i += 5) {
      const [x0, y0, x1, y1, kind] = s.slice(i, i + 5);
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 2) continue;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, nx = -(y1 - y0) / len * 0.4, ny = (x1 - x0) / len * 0.4;
      const sides = [territoryAt(mx + nx, my + ny), territoryAt(mx - nx, my - ny)];
      if (sides.includes(a) && sides.includes(b)) out.push(kind);
    }
    return out;
  };
  const dc = between(city('Debrecen'), city('Cluj'));
  assert.ok(dc.length > 0 && dc.every((k) => k === 0), JSON.stringify(dc));
  const cb = between(city('Cluj'), city('Brașov'));
  assert.ok(cb.length > 0 && cb.every((k) => k === 1), JSON.stringify(cb));
});
