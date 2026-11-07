// Map editing for admins (Edit map in a game): move cities, then rebuild what depends on where
// they stand. Every request is checked for admin rights in server/index.js before it gets here.
//
// - A move takes effect at once: in the server's map (served as /map.json), in every game, and in
//   every browser. It is saved to server/data/city-positions.json, so it holds for all games,
//   after restarts, and in later `npm run build-map` runs.
// - "Rebuild navigation" runs tools/build-map.js with those positions: territories, borders,
//   country labels and the land grid are rebuilt, then the server reloads them and marks the
//   areas around cities that paths avoid at the new places.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NavGrid } from './nav.js';
import { markCityObstacles } from './City.js';
import { CITY } from '../shared/config.js';

const SNAP_DIST = 40;                    // km: a drop in the sea this close to land lands on the shore
const MIN_CITY_GAP = CITY.size * 2 + 4;  // cities may not be dropped on top of each other

const r1 = (v) => Math.round(v * 10) / 10;

export { markCityObstacles };

export class MapEditor {
  // map: the server's map object (shared with every game); nav: the shared NavGrid;
  // games(): the running games; files: { root, map, nav, positions } paths.
  constructor({ map, nav, games, files }) {
    this.map = map;
    this.nav = nav;
    this.games = games;
    this.files = files;
    this.positions = this.loadPositions();
    this.pending = new Set();     // cities moved since the last rebuild
    this.busy = false;
    this.json = null;
    // map.json may predate moves saved since its last build: put those cities where they belong.
    this.applyPositions();
  }

  loadPositions() {
    try {
      const data = JSON.parse(fs.readFileSync(this.files.positions, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  savePositions() {
    fs.mkdirSync(path.dirname(this.files.positions), { recursive: true });
    fs.writeFileSync(this.files.positions, `${JSON.stringify(this.positions, null, 2)}\n`);
  }

  applyPositions() {
    this.map.cities.forEach((c) => {
      const p = this.positions[c.n];
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) { c.x = p[0]; c.y = p[1]; }
    });
    this.json = null;
  }

  // The map as browsers load it (/map.json), with every move applied.
  mapJson() {
    if (!this.json) this.json = JSON.stringify(this.map);
    return this.json;
  }

  state() {
    return { pending: this.pending.size, busy: this.busy };
  }

  // ---------------------------------------------------------------- messages from browsers
  // A map-editing message ('mapMove' or 'mapRebuild'). Admins only: anyone else gets an error and
  // nothing changes, whatever their page shows. `clients` are all connected clients
  // ({ name, admin, send }). Returns a promise that settles when the request is done.
  handle(client, msg, clients) {
    if (!client.admin) {
      client.send({ t: 'error', msg: 'Only admins can edit the map' });
      return Promise.resolve();
    }
    const sendAll = (m) => { for (const c of clients) if (c.name) c.send(m); };
    const sendState = () => { for (const c of clients) if (c.name && c.admin) c.send({ t: 'mapState', ...this.state() }); };

    if (msg.t === 'mapMove') {
      // Everyone sees the city at its new place at once; if refused, the mover's city goes back.
      const id = msg.city;
      const res = this.move(id, Number(msg.x), Number(msg.y));
      if (res.error) {
        client.send({ t: 'error', msg: res.error });
        const c = Number.isInteger(id) ? this.map.cities[id] : null;
        if (c) client.send({ t: 'cityMoved', city: id, x: c.x, y: c.y });
        return Promise.resolve();
      }
      sendAll({ t: 'cityMoved', city: id, x: res.x, y: res.y });
      sendState();
      return Promise.resolve();
    }

    if (msg.t === 'mapRebuild') {
      if (this.busy) {
        client.send({ t: 'error', msg: 'A rebuild is already running' });
        return Promise.resolve();
      }
      const moved = this.pending.size;
      const done = this.rebuild();
      sendState();                       // every admin sees "Rebuilding…"
      return done.then(({ ms }) => {
        console.log(`Map rebuilt by an admin in ${ms} ms (${moved} moved cities)`);
        sendAll({ t: 'mapRebuilt', ms });
      }).catch((e) => {
        console.warn(e.message);
        client.send({ t: 'error', msg: e.message });
      }).finally(sendState);
    }
    return Promise.resolve();
  }

  // Moves city `id` to (x, y), snapped onto land. Returns { x, y } or { error }.
  move(id, x, y) {
    const city = Number.isInteger(id) ? this.map.cities[id] : null;
    if (!city) return { error: 'No such city' };
    if (this.busy) return { error: 'The map is being rebuilt; try again in a moment' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'Invalid position' };
    const b = this.map.bounds;
    x = Math.max(b.x0, Math.min(b.x1, x));
    y = Math.max(b.y0, Math.min(b.y1, y));
    const spot = this.nav.nearestWalkable(x, y, SNAP_DIST);
    if (!spot) return { error: 'Cities must stand on land: drop it on land' };
    [x, y] = [r1(spot[0]), r1(spot[1])];
    const other = this.map.cities.find((c) => c !== city && Math.hypot(c.x - x, c.y - y) < MIN_CITY_GAP);
    if (other) return { error: `Too close to ${other.n}` };

    city.x = x;
    city.y = y;
    this.positions[city.n] = [x, y];
    this.savePositions();
    this.pending.add(id);
    this.json = null;
    for (const g of this.games()) g.moveCity(id, x, y);
    return { x, y };
  }

  // Rebuilds territories, borders and the land grid from the current city positions and
  // reloads them. Resolves with { ms }, rejects with an Error (the old map stays in use).
  rebuild() {
    if (this.busy) return Promise.reject(new Error('A rebuild is already running'));
    this.busy = true;
    const started = Date.now();
    const { root, map: mapFile, nav: navFile, positions } = this.files;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'tools', 'build-map.js')], {
        cwd: root,
        env: { ...process.env, MAP_OUT: mapFile, NAV_OUT: navFile, CITY_POSITIONS: positions },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', (d) => { log += d; });
      child.stderr.on('data', (d) => { log += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          const line = log.split('\n').find((l) => /Error/.test(l)) || `exit code ${code}`;
          reject(new Error(`Map build failed: ${line.trim()}`));
          return;
        }
        try {
          this.reload();
          resolve({ ms: Date.now() - started });
        } catch (e) {
          reject(e);
        }
      });
    }).finally(() => { this.busy = false; });
  }

  // Loads the freshly built map and land grid into the objects every game already uses.
  reload() {
    const fresh = JSON.parse(fs.readFileSync(this.files.map, 'utf8'));
    for (const key of Object.keys(this.map)) delete this.map[key];
    Object.assign(this.map, fresh);
    this.json = null;
    Object.assign(this.nav, NavGrid.load(this.files.nav));
    markCityObstacles(this.nav, this.map.cities);
    for (const g of this.games()) {
      this.map.cities.forEach((c, i) => {
        const gc = g.cities[i];
        if (gc && (gc.x !== c.x || gc.y !== c.y)) g.moveCity(i, c.x, c.y);
      });
    }
    this.pending.clear();
    this.json = null;
  }
}
