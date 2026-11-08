// Region names on the map: kept off the cities and each other, inside their own region.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionIndex, regionLabelSizes, placeLabels, regionOutlines, SEA } from '../public/js/map-labels.js';
import { map } from './helpers.js';

const index = regionIndex(map);
const area = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const boxOf = (l) => ({ x0: l.x - l.w / 2, y0: l.y - l.h / 2, x1: l.x + l.w / 2, y1: l.y + l.h / 2 });

test('cities lie in their own region', () => {
  const wrong = map.cities.filter((c) => index.at(c.x, c.y) !== c.c);
  // A few cities stand just off the coast of their landmass (see tools/build-map.js).
  assert.ok(wrong.length <= 3, `outside their region: ${wrong.map((c) => c.n).join(', ')}`);
});

test('a name over a city moves off it and stays in its region', () => {
  const c = map.cities.find((x) => x.n === 'Kyiv');
  const city = { x0: c.x - 40, y0: c.y - 40, x1: c.x + 40, y1: c.y + 40 };
  const [l] = placeLabels([{ region: c.c, x: c.x, y: c.y, w: 200, h: 40 }], [city], index);
  assert.equal(area(boxOf(l), city), 0);
  assert.equal(index.at(l.x, l.y), c.c);
  assert.ok(Math.hypot(l.x - c.x, l.y - c.y) < 120, 'it moves only as far as it needs');
});

test('on the real map, names cover no city and no other name', () => {
  // Rough sizes of what the renderer measures: cities as drawn at zoom 0.5 (a castle 36 wide,
  // its name below it), names about 0.9 of their size per letter.
  const cities = map.cities.flatMap((c) => [
    { x0: c.x - 24, y0: c.y - 32, x1: c.x + 24, y1: c.y + 10 },
    { x0: c.x - c.n.length * 6.5 - 9, y0: c.y + 1, x1: c.x + c.n.length * 6.5 + 9, y1: c.y + 35 },
  ]);
  const sizes = regionLabelSizes(index);
  const labels = map.countries.map((co, i) => ({
    region: i, x: co.x, y: co.y - sizes[i] * 0.8, w: (co.n.length * 0.9 + 0.3) * sizes[i], h: sizes[i],
  }));
  const before = labels.reduce((s, l) => s + cities.reduce((t, b) => t + area(boxOf(l), b), 0), 0);
  placeLabels(labels, cities, index);
  const after = labels.reduce((s, l) => s + cities.reduce((t, b) => t + area(boxOf(l), b), 0), 0);
  assert.ok(before > 0);
  assert.ok(after <= before * 0.01, `overlap with cities ${before.toFixed(0)} -> ${after.toFixed(0)}`);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i], name = map.countries[i].n;
    for (let j = i + 1; j < labels.length; j++) assert.equal(area(boxOf(l), boxOf(labels[j])), 0);
    if (index.area[i] >= l.w * l.h) assert.equal(index.at(l.x, l.y), i, `${name} is in its region`);
    else assert.ok([i, SEA].includes(index.at(l.x, l.y)), `${name}, too small for its name, has it beside it`);
  }
  for (const name of ['Malta', 'Shetland']) {
    const i = map.countries.findIndex((co) => co.n === name);
    assert.ok(index.area[i] < labels[i].w * labels[i].h, `${name} is smaller than its name`);
    assert.equal(cities.reduce((t, b) => t + area(boxOf(labels[i]), b), 0), 0, `${name}'s name is off its city`);
  }
});

// The outline that lights up when a player takes a whole region (render.js).
const outlines = regionOutlines(map, index);
const segments = (s) => Array.from({ length: s.length / 4 }, (_, k) => s.slice(4 * k, 4 * k + 4));

test('every region outline is closed: each end meets another one', () => {
  map.countries.forEach((co, r) => {
    const ends = segments(outlines[r]).flatMap(([ax, ay, bx, by]) => [[ax, ay], [bx, by]]);
    assert.ok(ends.length >= 6, `${co.n} has an outline`);
    const loose = ends.filter((p, a) => !ends.some((q, b) => b !== a && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1));
    assert.equal(loose.length, 0, `${co.n}: loose ends at ${loose.map((p) => p.join(',')).join(' ')}`);
  });
});

test('a region outline has its own land on one side and other land or sea on the other', () => {
  map.countries.forEach((co, r) => {
    const segs = segments(outlines[r]).filter(([ax, ay, bx, by]) => Math.hypot(bx - ax, by - ay) > 3);
    const wrong = segs.filter(([ax, ay, bx, by]) => {
      const len = Math.hypot(bx - ax, by - ay), mx = (ax + bx) / 2, my = (ay + by) / 2;
      const nx = (ay - by) / len * 0.5, ny = (bx - ax) / len * 0.5;
      return (index.at(mx + nx, my + ny) === r) === (index.at(mx - nx, my - ny) === r);
    });
    assert.ok(wrong.length <= segs.length * 0.02, `${co.n}: ${wrong.length} of ${segs.length} segments are not on its edge`);
  });
});

test('a one-city island region is outlined by its coast', () => {
  const r = map.countries.findIndex((co) => co.n === 'Malta');
  const ci = map.cities.findIndex((c) => c.c === r);
  const perimeter = map.polys.filter((p) => p.c.length === 1 && p.c[0] === ci)
    .flatMap((p) => p.r).reduce((s, ring) => {
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length;
        s += Math.hypot(ring[j] - ring[i], ring[j + 1] - ring[i + 1]);
      }
      return s;
    }, 0);
  const length = segments(outlines[r]).reduce((s, [ax, ay, bx, by]) => s + Math.hypot(bx - ax, by - ay), 0);
  assert.ok(perimeter > 0);
  assert.ok(Math.abs(length - perimeter) < 1e-6, `${length} vs ${perimeter}`);
});
