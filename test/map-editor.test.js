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
import { UNITS, LABEL_EDIT } from '../shared/config.js';
import { forEachCoastPiece, nearestCell } from '../shared/coastline.js';
import { decodeMask } from '../shared/mountains.js';

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
    mountains: path.join(dir, 'mountain-edits.json'),
    labels: path.join(dir, 'label-edits.json'),
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
  // Somewhere on the coast near Brest: a beach, as all of the coast is.
  const cliff = nav.coastCellsNear(brest.x, brest.y, 120)[0];
  assert.ok(cliff >= 0);
  assert.equal(nav.beach[cliff], 1);
  const [x, y] = nav.center(cliff);

  await editor.handle(player, { t: 'mapBeach', pts: [[x, y]], r: 6, on: false }, clients);
  assert.match(player.inbox.at(-1).msg, /Only admins/);
  assert.equal(nav.beach[cliff], 1, 'nothing changed for a player');

  await editor.handle(admin, { t: 'mapBeach', pts: [[x, y]], r: 6, on: false }, clients);
  const msg = admin.inbox.at(-1);
  assert.equal(msg.t, 'beachEdit');
  assert.ok(msg.cells.includes(cliff) && msg.on === false);
  assert.deepEqual(player.inbox.at(-1), msg, 'every browser is told, so the game hosts do the same');
  assert.equal(nav.beach[cliff], 0, 'a cliff now');
  assert.ok(JSON.parse(editor.mapJson()).beachEdits.cliff.includes(cliff), 'in the map new games load');
  assert.ok(JSON.parse(fs.readFileSync(files.beaches, 'utf8')).cliff.includes(cliff), 'and saved');

  // Paint it back: a beach, saved as such.
  await editor.handle(admin, { t: 'mapBeach', pts: [[x, y]], r: 6, on: true }, clients);
  assert.equal(nav.beach[cliff], 1);
  let saved = JSON.parse(fs.readFileSync(files.beaches, 'utf8'));
  assert.ok(saved.beach.includes(cliff) && !saved.cliff.includes(cliff));

  // Erase it again: a cliff, saved as such.
  await editor.handle(admin, { t: 'mapBeach', pts: [[x, y]], r: 6, on: false }, clients);
  assert.equal(nav.beach[cliff], 0);
  saved = JSON.parse(fs.readFileSync(files.beaches, 'utf8'));
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

test('painted mountains may reach the water: no road along the coast there, and the coast is cliffs', async () => {
  const { map, nav, editor, admin, clients } = setupEditor();
  // A beach of the mainland (its coast lists are the longest) far from any city.
  let coast = -1;
  for (const list of [...nav.landing.values()].sort((p, q) => q.length - p.length)) {
    for (let k = 0; k < list.length && coast < 0; k += 2) {
      const [x, y] = nav.center(list[k]);
      if (map.cities.every((t) => Math.hypot(t.x - x, t.y - y) > 80)) coast = list[k];
    }
    if (coast >= 0) break;
  }
  const [x, y] = nav.center(coast);
  const docks = () => [...nav.landing.values()].some((l) => { for (let k = 0; k < l.length; k += 2) if (l[k] === coast) return true; return false; });
  assert.ok(docks() && nav.beach[coast], 'a beach ships dock at');
  const code = nav.beachCode;
  await editor.handle(admin, { t: 'mapMountain', pts: [[x, y]], r: 8, on: true }, clients);
  const msg = admin.inbox.at(-1);
  assert.equal(msg.t, 'mountainEdit');
  assert.ok(msg.cells.includes(coast), 'right down to the water');
  assert.ok(nav.mountainAt(x, y) && !nav.walkable(x, y), 'nobody walks along the coast there');
  assert.ok(!docks(), 'no ship docks under mountains');
  assert.notEqual(nav.beachCode, code, 'and the coast there is drawn as cliffs');
  // Erased: a beach again.
  await editor.handle(admin, { t: 'mapMountain', pts: [[x, y]], r: 8, on: false }, clients);
  assert.ok(docks() && nav.walkable(x, y));
  assert.equal(nav.beachCode, code);
});

// Mountains: open land far from the sea and any city (47.08 N 2.40 E, by Bourges), and the Alps (the Ortler).
const BOURGES = [-725, 500], ORTLER = [-138, 604];
const drawnMountain = (editor, nav, x, y) => {
  const m = JSON.parse(editor.mapJson()).mountains;
  return decodeMask(m.code, m.w * m.h)[nav.cellOf(x, y)] === 1;
};

test('players without admin rights cannot paint mountains', async () => {
  const { files, nav, editor, player, clients } = setupEditor();
  await editor.handle(player, { t: 'mapMountain', pts: [BOURGES], r: 20, on: true }, clients);
  assert.match(player.inbox.at(-1).msg, /Only admins/);
  assert.ok(nav.walkable(...BOURGES), 'still open land');
  assert.ok(!fs.existsSync(files.mountains), 'nothing was saved');
});

test('admins paint mountains and clear them: units go round them at once, everyone is told, and they hold', async () => {
  const { files, map, nav, editor, admin, player, clients, idOf } = setupEditor();
  const tours = map.cities[idOf('Tours')], limoges = map.cities[idOf('Limoges')];
  assert.equal(nav.los(tours.x, tours.y, BOURGES[0], BOURGES[1]), true, 'open country between them');

  // A range by Bourges.
  const stroke = [[BOURGES[0] - 30, BOURGES[1]], BOURGES, [BOURGES[0] + 30, BOURGES[1]]];
  await editor.handle(admin, { t: 'mapMountain', pts: stroke, r: 15, on: true }, clients);
  const msg = admin.inbox.at(-1);
  assert.equal(msg.t, 'mountainEdit');
  assert.ok(msg.on === true && msg.cells.includes(nav.cellOf(...BOURGES)));
  assert.deepEqual(player.inbox.at(-1), msg, 'every browser is told: pages draw them, game hosts block them');
  assert.ok(nav.mountainAt(...BOURGES) && !nav.walkable(...BOURGES), 'units cannot walk there');
  assert.ok(drawnMountain(editor, nav, ...BOURGES), 'in the map new games and pages load');
  const path = nav.findPath(tours.x, tours.y, limoges.x, limoges.y);
  assert.ok(path, 'a way round');
  let saved = JSON.parse(fs.readFileSync(files.mountains, 'utf8'));
  assert.ok(saved.add.includes(nav.cellOf(...BOURGES)), 'saved');

  // Clear part of it again, and part of the Alps.
  await editor.handle(admin, { t: 'mapMountain', pts: [BOURGES, ORTLER], r: 10, on: false }, clients);
  assert.equal(admin.inbox.at(-1).on, false);
  assert.ok(nav.walkable(...BOURGES) && nav.walkable(...ORTLER), 'open land again');
  assert.ok(nav.mountainAt(BOURGES[0] + 30, BOURGES[1]), 'the rest of the stroke stays');
  saved = JSON.parse(fs.readFileSync(files.mountains, 'utf8'));
  assert.ok(saved.clear.includes(nav.cellOf(...ORTLER)) && !saved.add.includes(nav.cellOf(...BOURGES)));

  // A restart: the built map and land grid from disk get the painted ones back.
  const fresh = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  const nav2 = NavGrid.load(files.nav);
  assert.ok(nav2.mountainAt(...ORTLER) && !nav2.mountainAt(BOURGES[0] + 30, BOURGES[1]), 'not in the built files');
  const editor2 = new MapEditor({ map: fresh, nav: nav2, games: () => [], files });
  assert.ok(nav2.mountainAt(BOURGES[0] + 30, BOURGES[1]) && nav2.walkable(...ORTLER) && nav2.walkable(...BOURGES));
  assert.ok(drawnMountain(editor2, nav2, BOURGES[0] + 30, BOURGES[1]) && !drawnMountain(editor2, nav2, ...ORTLER));

  // A rebuild makes the built mountains anew: the painted ones go back on top.
  const sent = admin.inbox.length;
  await editor.handle(admin, { t: 'mapRebuild' }, clients);
  const replies = admin.inbox.slice(sent).map((m) => m.t);
  assert.ok(replies.includes('mapRebuilt') && !replies.includes('error'), replies.join(', '));
  assert.ok(nav.mountainAt(BOURGES[0] + 30, BOURGES[1]) && nav.walkable(...ORTLER), 'they hold after a rebuild');
  assert.ok(drawnMountain(editor, nav, BOURGES[0] + 30, BOURGES[1]));
});

test('painted mountains keep off the cities, and wall no land in', async () => {
  const { map, nav, editor, admin, clients, idOf } = setupEditor();
  // Beside a city on the coast, and beside one inland: only the land far enough from both takes them.
  // (A disc round a city would make a ring round its clear ground: that walls it in, refused below.)
  const brest = map.cities[idOf('Brest')], lyon = map.cities[idOf('Lyon')];
  await editor.handle(admin, { t: 'mapMountain', pts: [[brest.x + 30, brest.y], [lyon.x + 40, lyon.y]], r: 35, on: true }, clients);
  const cells = admin.inbox.at(-1).cells;
  assert.ok(cells.length > 0, 'some land was far enough');
  for (const c of cells) {
    const [x, y] = nav.center(c);
    for (const t of map.cities) assert.ok(Math.hypot(t.x - x, t.y - y) > 35, `cell ${c} by ${t.n}`);
  }
  assert.ok(nav.walkable(brest.x, brest.y) && nav.walkable(lyon.x, lyon.y));

  // A ring round Madrid would wall it in: refused, nothing changes.
  const madrid = map.cities[idOf('Madrid')];
  const ring = (cx, cy, rad, n) => Array.from({ length: n + 1 }, (_, k) => [cx + rad * Math.cos((k / n) * 2 * Math.PI), cy + rad * Math.sin((k / n) * 2 * Math.PI)]);
  const before = admin.inbox.length;
  await editor.handle(admin, { t: 'mapMountain', pts: ring(madrid.x, madrid.y, 55, 60), r: 10, on: true }, clients);
  assert.equal(admin.inbox.length, before + 1);
  assert.match(admin.inbox.at(-1).msg, /wall land in/);
  assert.ok(nav.walkable(madrid.x + 55, madrid.y), 'the stroke was not painted');
  assert.equal(nav.cutOff().length, 0);

  // A small ring in open country fills: nobody could reach the valley in it.
  await editor.handle(admin, { t: 'mapMountain', pts: ring(BOURGES[0], BOURGES[1], 20, 40), r: 8, on: true }, clients);
  const filled = admin.inbox.at(-1);
  assert.equal(filled.t, 'mountainEdit');
  assert.ok(filled.cells.includes(nav.cellOf(...BOURGES)), 'the valley inside is mountains too');
  assert.ok(nav.mountainAt(...BOURGES));
  assert.equal(nav.cutOff().length, 0, 'no land walled in');
});

test('players without admin rights cannot move or resize region names', async () => {
  const { map, editor, player, clients } = setupEditor();
  const hungary = map.countries.findIndex((co) => co.n === 'Hungary');
  await editor.handle(player, { t: 'mapLabel', region: hungary, x: 0, y: 0, scale: 2 }, clients);
  assert.match(player.inbox.at(-1).msg, /Only admins/);
  assert.equal(map.labelEdits.Hungary, undefined, 'nothing changed');
});

test('an admin moves and resizes a region name: everyone is told, it is saved, and it holds', async () => {
  const { files, map, editor, admin, player, clients } = setupEditor();
  const hungary = map.countries.findIndex((co) => co.n === 'Hungary');
  await editor.handle(admin, { t: 'mapLabel', region: hungary, x: 512.34, y: 300.06, scale: 1.5 }, clients);
  const msg = admin.inbox.at(-1);
  assert.deepEqual(msg, { t: 'labelEdit', region: hungary, edit: { x: 512.3, y: 300.1, scale: 1.5 } });
  assert.deepEqual(player.inbox.at(-1), msg, 'every browser is told');
  assert.deepEqual(JSON.parse(editor.mapJson()).labelEdits.Hungary, msg.edit, 'in the map new pages load');
  assert.deepEqual(JSON.parse(fs.readFileSync(files.labels, 'utf8')), { Hungary: msg.edit }, 'saved by region name');

  // Kept within the map, and within LABEL_EDIT's sizes; nonsense is refused.
  await editor.handle(admin, { t: 'mapLabel', region: hungary, x: 1e9, y: -1e9, scale: 100 }, clients);
  const far = admin.inbox.at(-1).edit;
  assert.deepEqual([far.x, far.y], [map.bounds.x1, map.bounds.y0]);
  assert.equal(far.scale, LABEL_EDIT.maxScale);
  for (const bad of [{ region: 999, x: 0, y: 0, scale: 1 }, { region: hungary, x: 'a', y: 0, scale: 1 }]) {
    await editor.handle(admin, { t: 'mapLabel', ...bad }, clients);
    assert.equal(admin.inbox.at(-1).t, 'error');
  }

  // A restart and a rebuild (the built map knows nothing of it) keep it.
  await editor.handle(admin, { t: 'mapLabel', region: hungary, x: 512, y: 300, scale: 0.8 }, clients);
  const fresh = JSON.parse(fs.readFileSync(files.map, 'utf8'));
  new MapEditor({ map: fresh, nav: NavGrid.load(files.nav), games: () => [], files });
  assert.deepEqual(fresh.labelEdits.Hungary, { x: 512, y: 300, scale: 0.8 }, 'after a restart');
  editor.reload();
  assert.deepEqual(map.labelEdits.Hungary, { x: 512, y: 300, scale: 0.8 }, 'after a rebuild');

  // Back to automatic placing.
  await editor.handle(admin, { t: 'mapLabel', region: hungary, reset: true }, clients);
  assert.deepEqual(admin.inbox.at(-1), { t: 'labelEdit', region: hungary, edit: null });
  assert.equal(map.labelEdits.Hungary, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.labels, 'utf8')), {});
});
