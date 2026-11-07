// Edit map (admins): moving cities and rebuilding territories and navigation. Works on copies of
// the map files in a temporary folder, so the real ones are never touched. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapEditor } from '../server/map-editor.js';
import { NavGrid } from '../server/nav.js';
import { Game } from '../server/game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setupEditor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-map-'));
  const files = {
    root: ROOT,
    map: path.join(dir, 'map.json'),
    nav: path.join(dir, 'navgrid.json'),
    positions: path.join(dir, 'city-positions.json'),
  };
  fs.copyFileSync(path.join(ROOT, 'public', 'map.json'), files.map);
  fs.copyFileSync(path.join(ROOT, 'server', 'data', 'navgrid.json'), files.nav);
  const map = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  const nav = NavGrid.load(files.nav);
  const game = new Game({ id: '1', title: 'test', map, nav });
  const editor = new MapEditor({ map, nav, games: () => [game], files });
  const client = (name, admin) => {
    const inbox = [];
    return { name, admin, inbox, send: (m) => inbox.push(m) };
  };
  const admin = client('Admin', true);
  const player = client('Player', false);
  const clients = [admin, player];
  const idOf = (name) => map.cities.findIndex((c) => c.n === name);
  return { dir, files, map, nav, game, editor, admin, player, clients, idOf };
}

test('players without admin rights cannot move cities or rebuild the map, even by sending the messages', async () => {
  const { files, map, game, editor, player, clients, idOf } = setupEditor();
  const lyon = idOf('Lyon');
  const before = { ...map.cities[lyon] };
  const mapFile = fs.readFileSync(files.map, 'utf8');

  await editor.handle(player, { t: 'mapMove', city: lyon, x: before.x + 30, y: before.y }, clients);
  await editor.handle(player, { t: 'mapRebuild' }, clients);

  assert.deepEqual(player.inbox.map((m) => m.t), ['error', 'error']);
  assert.match(player.inbox[0].msg, /Only admins/);
  assert.deepEqual(map.cities[lyon], before, 'the city did not move');
  assert.equal(game.cities[lyon].x, before.x, 'not in the game either');
  assert.ok(!fs.existsSync(files.positions), 'nothing was saved');
  assert.equal(fs.readFileSync(files.map, 'utf8'), mapFile, 'no rebuild ran');
  assert.equal(editor.pending.size, 0);
});

test('an admin moves a city: everyone sees it, every game uses it, and it is saved', async () => {
  const { files, map, nav, game, editor, admin, player, clients, idOf } = setupEditor();
  const lyon = idOf('Lyon');
  const { x, y } = map.cities[lyon];

  await editor.handle(admin, { t: 'mapMove', city: lyon, x: x + 30, y: y + 10 }, clients);
  const moved = { x: map.cities[lyon].x, y: map.cities[lyon].y };
  assert.deepEqual(moved, { x: Math.round((x + 30) * 10) / 10, y: Math.round((y + 10) * 10) / 10 });
  assert.deepEqual([game.cities[lyon].x, game.cities[lyon].y], [moved.x, moved.y], 'running games use the new place');
  for (const c of clients) {
    assert.deepEqual(c.inbox.find((m) => m.t === 'cityMoved'), { t: 'cityMoved', city: lyon, ...moved });
  }
  assert.ok(!player.inbox.some((m) => m.t === 'mapState'), 'only admins get the editing state');
  assert.equal(admin.inbox.find((m) => m.t === 'mapState').pending, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.positions, 'utf8')), { Lyon: [moved.x, moved.y] });
  assert.equal(JSON.parse(editor.mapJson()).cities[lyon].x, moved.x, 'browsers loading /map.json get it too');

  // A new editor (server restart) puts the city back where it was moved.
  const fresh = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  new MapEditor({ map: fresh, nav, games: () => [], files });
  assert.deepEqual([fresh.cities[lyon].x, fresh.cities[lyon].y], [moved.x, moved.y]);

  // Dropped far out at sea: refused, and the admin's city goes back.
  let sea = null;
  for (let sx = map.bounds.x0 + 20; !sea && sx < map.bounds.x1; sx += 50) {
    for (let sy = map.bounds.y0 + 20; !sea && sy < map.bounds.y1; sy += 50) {
      if (!nav.nearestWalkable(sx, sy, 40)) sea = [sx, sy];
    }
  }
  admin.inbox.length = 0;
  await editor.handle(admin, { t: 'mapMove', city: lyon, x: sea[0], y: sea[1] }, clients);
  assert.match(admin.inbox[0].msg, /land/);
  assert.deepEqual(admin.inbox[1], { t: 'cityMoved', city: lyon, ...moved });
  assert.equal(map.cities[lyon].x, moved.x);

  // On top of another city: refused.
  const dijon = map.cities[idOf('Dijon')];
  admin.inbox.length = 0;
  await editor.handle(admin, { t: 'mapMove', city: lyon, x: dijon.x + 3, y: dijon.y }, clients);
  assert.match(admin.inbox[0].msg, /Too close to Dijon/);
});

test('rebuilding the map moves territories and the areas paths avoid to the new city positions', async () => {
  const { files, map, nav, editor, admin, clients, idOf } = setupEditor();
  const lyon = idOf('Lyon');
  const old = { x: map.cities[lyon].x, y: map.cities[lyon].y };
  const oldCells = JSON.stringify(map.polys);
  await editor.handle(admin, { t: 'mapMove', city: lyon, x: old.x + 40, y: old.y - 20 }, clients);
  const moved = { x: map.cities[lyon].x, y: map.cities[lyon].y };
  assert.equal(nav.obstacle[nav.cellOf(old.x, old.y)], 1, 'before the rebuild, paths still avoid the old place');

  admin.inbox.length = 0;
  await editor.handle(admin, { t: 'mapRebuild' }, clients);
  assert.ok(admin.inbox.some((m) => m.t === 'mapRebuilt'), JSON.stringify(admin.inbox));
  assert.deepEqual([map.cities[lyon].x, map.cities[lyon].y], [moved.x, moved.y], 'the rebuilt map keeps the move');
  assert.notEqual(JSON.stringify(map.polys), oldCells, 'territories were split again');
  assert.equal(nav.obstacle[nav.cellOf(moved.x, moved.y)], 1, 'paths now avoid the new place');
  assert.equal(nav.obstacle[nav.cellOf(old.x, old.y)], 0, 'and no longer the old one');
  assert.equal(editor.pending.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(files.map, 'utf8')).cities[lyon].x, moved.x, 'saved in the map file');
  assert.deepEqual(map.bounds, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'map.json'), 'utf8')).bounds,
    'the map size does not change');
});
