// Runs one game in the host player's browser (browser-to-browser play), inside a Web Worker
// (public/js/host-worker.js). The page passes it plain messages: players connecting and leaving,
// their commands, balance and map changes. Whatever the game sends to a player goes out through
// send(to, msg); the page delivers it to the host's own screen or over that player's peer link.
//
// It wraps the same Game class the server tests use, with the same fixed-step loop the server
// used to run. Node tests drive it directly.
import { Game } from './game.js';
import { NavGrid } from './nav.js';
import { markCityObstacles } from './City.js';
import { GAME } from '../shared/config.js';
import { applyBalance } from '../shared/balance.js';

const DT = 1 / GAME.tickRate;

export class HostEngine {
  // roster: [{ id, color }] from the lobby server (no nicknames). options: the host's game options
  // (shared/options.js). send(to, msg): deliver to a player. onEnded(winner): the game is over, so
  // the page can tell the lobby server.
  constructor({ gameId, title, map, navData, balance, roster, hostId, options, send, onEnded }) {
    if (balance) applyBalance(balance);
    this.map = map;
    this.nav = new NavGrid(navData);
    this.send = send;
    this.onEnded = onEnded || (() => {});
    this.game = Game.hosted({ id: gameId, title, map, nav: this.nav, roster, hostId, options });
    // Pathfinding tables (about half a second): now, while players are still loading, not on the first order.
    this.nav.buildLandmarks();
    this.reportedEnd = false;
    this.timer = 0;
    this.waitSteps = 0;                 // steps before the start, for the snapshots sent meanwhile
    this.acc = 0;                       // game seconds owed to the simulation (see advance)
  }

  // ---------------------------------------------------------------- players
  // A player's link is open (the host's own screen, or a peer that connected): they get the
  // full game state. Reconnecting after a drop says "is back" to everyone. Before the start, a
  // first connection means one more player has loaded the game (see Game.stepPrestart).
  connect(id) {
    const g = this.game, p = g.players.get(id);
    if (!p) return;
    const client = { send: (msg) => this.send(id, msg) };
    if (!p.everConnected) {
      p.everConnected = true;
      p.client = client;
      p.connected = true;
      g.broadcastRoom();
      if (g.prestart) g.sendPrestart();
    } else if (p.connected) {
      p.client = client;                // a new link replaced the old one
    } else {
      g.reattach(p, client);
    }
    g.sendStart(p);
  }

  disconnect(id) {
    const p = this.game.players.get(id);
    if (p && p.connected) this.game.disconnect(p);
  }

  // A message from a player: a command, or 'leave' (giving up: their cities become neutral).
  message(from, msg) {
    const p = this.game.players.get(from);
    if (!p || !msg || typeof msg.t !== 'string') return;
    if (msg.t === 'leave') {
      this.game.removePlayer(from);
      if (this.game.prestart) this.game.sendPrestart();   // one player fewer to wait for
      return;
    }
    this.game.handleCommand(p, msg);
  }

  // ---------------------------------------------------------------- live changes by admins
  balance(values) {
    applyBalance(values);
  }

  moveCity(id, x, y) {
    const c = this.map.cities[id];
    if (c) { c.x = x; c.y = y; }
    this.game.moveCity(id, x, y);
    this.game.sendPorts();              // the city may have become coastal, or stopped being so
  }

  // An admin made a city coastal (true), inland (false), or set it back to automatic (null).
  setCoastal(id, coastal) {
    const c = this.map.cities[id];
    if (!c) return;
    if (typeof coastal === 'boolean') c.coastal = coastal;
    else delete c.coastal;
    this.game.setPortOverride(id, coastal);
    this.game.sendPorts();
  }

  // An admin painted these coast cells as beaches (on) or cliffs: the same here, and every player
  // gets the new beaches with the ports.
  editBeaches(cells, on) {
    if (!Array.isArray(cells)) return;
    this.nav.editBeaches(cells.filter(Number.isInteger), !!on);
    this.game.sendPorts();
  }

  // The map was rebuilt: new territories, land grid and the areas paths avoid around cities.
  mapRebuilt(map, navData) {
    for (const key of Object.keys(this.map)) delete this.map[key];
    Object.assign(this.map, map);
    Object.assign(this.nav, new NavGrid(navData));
    markCityObstacles(this.nav, this.map.cities, this.map);
    this.map.cities.forEach((c, i) => {
      const gc = this.game.cities[i];
      if (gc && (gc.x !== c.x || gc.y !== c.y)) this.game.moveCity(i, c.x, c.y);
      if (gc) gc.portOverride = typeof c.coastal === 'boolean' ? c.coastal : null;
    });
    this.game.updatePorts();            // the seas and coasts come from the new land grid
    this.game.sendPorts(true);          // with the shore: the land grid is new
    this.nav.buildLandmarks();          // for the new land grid
  }

  // ---------------------------------------------------------------- loop
  // One simulation step, with snapshots and scores as the server sent them. Before the start the
  // game stands still, but players still get snapshots: their cities, gold, a city that fell
  // neutral because its player left.
  step() {
    const g = this.game;
    if (g.status === 'running' && g.prestart) {
      g.stepPrestart();
      if (++this.waitSteps % GAME.snapshotEvery === 0) g.sendSnapshots();
    } else if (g.status === 'running') {
      const t0 = performance.now();
      g.tick(DT);
      g.perf.tickMs += performance.now() - t0;
      g.perf.ticks++;
      // Faster than normal (slomo): snapshots and scores keep their pace in real time, not in ticks,
      // so a faster game doesn't send more data.
      const scale = Math.max(1, g.timeScale);
      if (g.tickCount % Math.round(GAME.snapshotEvery * scale) === 0) g.sendSnapshots();
      if (g.tickCount % Math.round(GAME.tickRate * scale) === 0) g.sendScores();
    }
    if (g.status === 'ended' && !this.reportedEnd) {
      this.reportedEnd = true;
      this.onEnded(g.winner);
    }
  }

  // `realSeconds` passed: run the fixed steps they are worth, times the game speed (Game.timeScale,
  // developer console "slomo"). At most a quarter of a second of real time at once, so a tab that
  // stalled doesn't make the game race to catch up.
  advance(realSeconds) {
    const scale = this.game.timeScale || 1;
    this.acc = Math.min(this.acc + realSeconds * scale, 0.25 * Math.max(1, scale));
    while (this.acc >= DT) {
      this.acc -= DT;
      this.step();
    }
  }

  start() {
    let last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.advance((now - last) / 1000);
      last = now;
    }, 1000 / GAME.tickRate / 2);
  }

  stop() {
    clearInterval(this.timer);
  }
}
