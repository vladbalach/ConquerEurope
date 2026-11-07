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
  // roster: [{ id, color }] from the lobby server (no nicknames). send(to, msg): deliver to a
  // player. onEnded(winner): the game is over, so the page can tell the lobby server.
  constructor({ gameId, title, map, navData, balance, roster, hostId, send, onEnded }) {
    if (balance) applyBalance(balance);
    this.map = map;
    this.nav = new NavGrid(navData);
    this.send = send;
    this.onEnded = onEnded || (() => {});
    this.game = Game.hosted({ id: gameId, title, map, nav: this.nav, roster, hostId });
    this.reportedEnd = false;
    this.timer = 0;
  }

  // ---------------------------------------------------------------- players
  // A player's link is open (the host's own screen, or a peer that connected): they get the
  // full game state. Reconnecting after a drop says "is back" to everyone.
  connect(id) {
    const g = this.game, p = g.players.get(id);
    if (!p) return;
    const client = { send: (msg) => this.send(id, msg) };
    if (!p.everConnected) {
      p.everConnected = true;
      p.client = client;
      p.connected = true;
      g.broadcastRoom();
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
  }

  // The map was rebuilt: new territories, land grid and the areas paths avoid around cities.
  mapRebuilt(map, navData) {
    for (const key of Object.keys(this.map)) delete this.map[key];
    Object.assign(this.map, map);
    Object.assign(this.nav, new NavGrid(navData));
    markCityObstacles(this.nav, this.map.cities);
    this.map.cities.forEach((c, i) => {
      const gc = this.game.cities[i];
      if (gc && (gc.x !== c.x || gc.y !== c.y)) this.game.moveCity(i, c.x, c.y);
    });
  }

  // ---------------------------------------------------------------- loop
  // One simulation step, with snapshots and scores as the server sent them.
  step() {
    const g = this.game;
    if (g.status === 'running') {
      const t0 = performance.now();
      g.tick(DT);
      g.perf.tickMs += performance.now() - t0;
      g.perf.ticks++;
      if (g.tickCount % GAME.snapshotEvery === 0) g.sendSnapshots();
      if (g.tickCount % GAME.tickRate === 0) g.sendScores();
    }
    if (g.status === 'ended' && !this.reportedEnd) {
      this.reportedEnd = true;
      this.onEnded(g.winner);
    }
  }

  start() {
    let last = performance.now(), acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      while (acc >= DT) {
        acc -= DT;
        this.step();
      }
    }, 1000 / GAME.tickRate / 2);
  }

  stop() {
    clearInterval(this.timer);
  }
}
