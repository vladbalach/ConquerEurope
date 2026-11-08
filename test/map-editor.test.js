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
import { UNITS } from '../shared/config.js';
import { forEachCoastPiece, nearestCell } from '../shared/coastline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setupEditor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coe-map-'));
  const files = {
    root: ROOT,
    map: path.join(dir, 'map.json'),
    nav: path.join(dir, 'navgrid.json'),
    positions: path.join(dir, 'city-positions.json'),
    coastal: path.join(dir, 'city-coastal.json'),
    beaches: path.join(dir, 'beach-edits.json'),
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

test('players without admin rights cannot make a city coastal or inland', async () => {
  const { files, map, game, editor, player, clients, idOf } = setupEditor();
  const lisbon = idOf('Lisbon');
  await editor.handle(player, { t: 'mapCoast', city: lisbon, coastal: false }, clients);
  assert.match(player.inbox[0].msg, /Only admins/);
  assert.equal(map.cities[lisbon].coastal, undefined);
  assert.ok(game.cities[lisbon].port, 'Lisbon is still coastal');
  assert.ok(!fs.existsSync(files.coastal), 'nothing was saved');
});

test('an admin makes a city coastal or inland: every game and browser uses it, and it is saved', async () => {
  const { files, map, game, editor, admin, player, clients, idOf } = setupEditor();
  const london = idOf('London'), lisbon = idOf('Lisbon');
  assert.equal(game.cities[london].port, null, 'London is inland by its distance to the sea');

  await editor.handle(admin, { t: 'mapCoast', city: london, coastal: true }, clients);
  for (const c of [admin, player]) {
    assert.deepEqual(c.inbox.at(-1), { t: 'cityCoast', city: london, coastal: true, on: true }, `${c.name} is told`);
  }
  assert.ok(game.cities[london].port, 'London builds ships now');
  assert.equal(JSON.parse(editor.mapJson()).cities[london].coastal, true, 'browsers loading the map get it');
  assert.deepEqual(JSON.parse(fs.readFileSync(files.coastal, 'utf8')), { London: true });

  // Inland: no port, and the transport in its queue is cancelled and refunded.
  const p = game.addPlayer({ name: 'P', send() {} }).player;
  game.cities[lisbon].owner = p.id;
  game.cities[lisbon].queue = ['infantry', 'transport'];
  const gold = p.gold;
  await editor.handle(admin, { t: 'mapCoast', city: lisbon, coastal: false }, clients);
  assert.equal(game.cities[lisbon].port, null);
  assert.deepEqual(game.cities[lisbon].queue, ['infantry']);
  assert.equal(p.gold, gold + UNITS.transport.cost);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.coastal, 'utf8')), { London: true, Lisbon: false });

  // Coastal again: that is what its distance to the sea gives anyway, so it is no longer set by hand.
  await editor.handle(admin, { t: 'mapCoast', city: lisbon, coastal: true }, clients);
  assert.deepEqual(admin.inbox.at(-1), { t: 'cityCoast', city: lisbon, coastal: null, on: true });
  assert.ok(game.cities[lisbon].port);
  assert.equal(map.cities[lisbon].coastal, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.coastal, 'utf8')), { London: true });

  // Far from any sea: refused.
  admin.inbox.length = 0;
  await editor.handle(admin, { t: 'mapCoast', city: idOf('Madrid'), coastal: true }, clients);
  assert.match(admin.inbox[0].msg, /no sea within/);
  assert.equal(game.cities[idOf('Madrid')].port, null);
});

test('coastal and inland cities set by an admin hold after a restart and a rebuild', async () => {
  const { files, map, editor, admin, clients, idOf } = setupEditor();
  const lisbon = idOf('Lisbon');
  await editor.handle(admin, { t: 'mapCoast', city: lisbon, coastal: false }, clients);

  // A restart: the server loads the map file again, and the editor puts the setting back.
  const fresh = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  const nav = NavGrid.load(files.nav);
  new MapEditor({ map: fresh, nav, games: () => [], files });
  assert.equal(fresh.cities[lisbon].coastal, false);
  assert.equal(new Game({ id: '2', title: 'new', map: fresh, nav }).cities[lisbon].port, null, 'new games use it');

  // A rebuild reloads the built map, which knows nothing of it: it is put back on top.
  editor.reload();
  assert.equal(map.cities[lisbon].coastal, false);
});

test('admins paint beaches and cliffs on the coast; everyone gets them, and they hold after a restart', async () => {
  const { files, map, nav, editor, admin, player, clients, idOf } = setupEditor();
  const brest = map.cities[idOf('Brest')];
  // Somewhere on the coast near Brest that is a cliff now.
  const cliff = nav.coastCellsNear(brest.x, brest.y, 120).find((c) => !nav.beach[c]);
  assert.ok(cliff >= 0);
  const [x, y] = nav.center(cliff);

  await editor.handle(player, { t: 'mapBeach', pts: [[x, y]], r: 6, on: true }, clients);
  assert.match(player.inbox.at(-1).msg, /Only admins/);
  assert.equal(nav.beach[cliff], 0, 'nothing changed for a player');

  await editor.handle(admin, { t: 'mapBeach', pts: [[x, y]], r: 6, on: true }, clients);
  const msg = admin.inbox.at(-1);
  assert.equal(msg.t, 'beachEdit');
  assert.ok(msg.cells.includes(cliff) && msg.on === true);
  assert.deepEqual(player.inbox.at(-1), msg, 'every browser is told, so the game hosts do the same');
  assert.equal(nav.beach[cliff], 1, 'a beach now');
  assert.ok(JSON.parse(editor.mapJson()).beachEdits.beach.includes(cliff), 'in the map new games load');
  assert.ok(JSON.parse(fs.readFileSync(files.beaches, 'utf8')).beach.includes(cliff), 'and saved');

  // Erase it again: a cliff, saved as such.
  await editor.handle(admin, { t: 'mapBeach', pts: [[x, y]], r: 6, on: false }, clients);
  assert.equal(nav.beach[cliff], 0);
  const saved = JSON.parse(fs.readFileSync(files.beaches, 'utf8'));
  assert.ok(saved.cliff.includes(cliff) && !saved.beach.includes(cliff));

  // A restart: a fresh land grid and map get the painted cells back.
  const fresh = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  const nav2 = NavGrid.load(files.nav);
  new MapEditor({ map: fresh, nav: nav2, games: () => [], files });
  assert.ok(fresh.beachEdits.cliff.includes(cliff));
  new Game({ id: '3', title: 'new', map: fresh, nav: nav2 });
  assert.equal(nav2.beach[cliff], 0, 'new games mark it too');
});

test('erasing a beach along the drawn coast removes all of it: no ship docks there any more', async () => {
  const { map, nav, editor, admin, clients, idOf } = setupEditor();
  const lisbon = map.cities[idOf('Lisbon')];
  // The beach drawn by Lisbon (its harbour): the pieces of drawn coast within 40 km that show as beach.
  const drawnAsBeach = (x, y) => {
    const c = nearestCell(nav, x, y, (k) => nav.shore[k] === 1);
    return c >= 0 && nav.beach[c] === 1;
  };
  const near = [];
  forEachCoastPiece(map, (ax, ay, bx, by) => {
    const x = (ax + bx) / 2, y = (ay + by) / 2;
    if (Math.hypot(x - lisbon.x, y - lisbon.y) < 40) near.push([x, y]);
  });
  assert.ok(near.some(([x, y]) => drawnAsBeach(x, y)), 'a beach is drawn there');
  // Trace it with the smallest brush, as an admin would along what the map shows.
  await editor.handle(admin, { t: 'mapBeach', pts: near.filter((_, i) => i % 3 === 0), r: 8, on: false }, clients);
  for (const [x, y] of near) assert.ok(!drawnAsBeach(x, y), 'nothing there is drawn as beach any more');
  // A transport sent to land at Lisbon docks somewhere else now, at a beach that is drawn.
  const dock = nav.coastNear(lisbon.x, lisbon.y, nav.landmass(lisbon.x, lisbon.y), nav.seaAt(lisbon.x - 30, lisbon.y) || 1);
  assert.ok(dock && dock.d > 30, `the nearest beach is ${dock && dock.d.toFixed(0)} km away`);
  const cell = nav.cellOf(dock.land[0], dock.land[1]);
  assert.ok(nav.shore[cell] && nav.beach[cell], 'on the drawn shore');
});
