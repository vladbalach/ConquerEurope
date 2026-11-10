// Runs one game in the host player's browser (browser-to-browser play), inside a Web Worker
// (public/js/host-worker.js). The page passes it plain messages: players connecting and leaving,
// their commands, balance and map changes. Whatever the game sends to a player goes out through
// send(to, msg); the page delivers it to the host's own screen or over that player's peer link.
//
// It wraps the same Game class the server tests use, with the same fixed-step loop the server
// used to run. Node tests drive it directly.
//
// Every few seconds the page sends the lobby server a checkpoint of the game (checkpoint()): when the
// host leaves, another player's browser takes the game over from the last one (`save`).
import { Game } from './game.js';
import { NavGrid } from './nav.js';
import { markCityObstacles } from './City.js';
import { GAME } from '../shared/config.js';
import { applyBalance } from '../shared/balance.js';
import { saveGame, restoreGame } from './save.js';
import { encodeMask } from '../shared/mountains.js';

const DT = 1 / GAME.tickRate;

// The land grid with the mountains of the map: /map.json (served from the lobby server's memory) has the
// ones admins painted since the grid file was built too.
const withMountains = (navData, map) => (map.mountains ? { ...navData, mountains: map.mountains.code } : navData);

export class HostEngine {
  // roster: [{ id, color }] from the lobby server (no nicknames). options: the host's game options
  // (shared/options.js). send(to, msg): deliver to a player. onEnded(winner): the game is over, so
  // the page can tell the lobby server.
  // Taking over a game from a host who left: `save` (server/save.js) instead of a roster, and
  // `departed`, the ids of players who left the game through the lobby (their empire falls apart here
  // if the save still has it).
  constructor({ gameId, title, map, navData, balance, roster, hostId, options, save = null, departed = [], send, onEnded }) {
    if (balance) applyBalance(balance);
    this.map = map;
    this.nav = new NavGrid(withMountains(navData, map));
    this.send = send;
    this.onEnded = onEnded || (() => {});
    this.game = save
      ? restoreGame(save, { map, nav: this.nav, hostId })
      : Game.hosted({ id: gameId, title, map, nav: this.nav, roster, hostId, options });
    // Pathfinding tables (about half a second): now, while players are still loading, not on the first order.
    this.nav.buildLandmarks();
    this.reportedEnd = false;
    this.timer = 0;
    this.waitSteps = 0;                 // steps before the start, for the snapshots sent meanwhile
    this.acc = 0;                       // game seconds owed to the simulation (see advance)
    // After a takeover, the players who were online have GAME.startWait seconds to connect to this
    // host before they show as offline (their pages connect again on their own, without "is back").
    this.awaiting = null;
    if (save) {
      for (const id of departed) if (this.game.players.has(id)) this.game.removePlayer(id);
      this.awaiting = new Set([...this.game.players.values()].filter((p) => p.connected && p.id !== hostId).map((p) => p.id));
      this.awaitSteps = GAME.startWait * GAME.tickRate;
    }
  }

  // ---------------------------------------------------------------- checkpoints
  // The game as it is now (server/save.js), for the lobby server: another player's browser takes it
  // over from there if this one goes. Null once the game is over.
  checkpoint() {
    return this.game.status === 'running' ? saveGame(this.game) : null;
  }

  // Players still in the game (not eliminated): the lobby server prefers them as the next host.
  activePlayers() {
    return [...this.game.players.values()].filter((p) => !p.eliminated).map((p) => p.id);
  }

  // ---------------------------------------------------------------- players
  // A player's link is open (the host's own screen, or a peer that connected): they get the
  // full game state. Reconnecting after a drop says "is back" to everyone. Before the start, a
  // first connection means one more player has loaded the game (see Game.stepPrestart).
  connect(id) {
    const g = this.game, p = g.players.get(id);
    if (!p) return;
    const client = { send: (msg) => this.send(id, msg) };
    this.awaiting?.delete(id);
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

  // A message from a player: a command, 'leave' (giving up: their cities become neutral), or
  // 'surrender' (the same, but they stay to watch the game). Both work during the countdown too.
  message(from, msg) {
    const p = this.game.players.get(from);
    if (!p || !msg || typeof msg.t !== 'string') return;
    if (msg.t === 'leave') {
      this.game.removePlayer(from);
      if (this.game.prestart) this.game.sendPrestart();   // one player fewer to wait for
      return;
    }
    if (msg.t === 'surrender') {
      this.game.surrender(from);
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

  // An admin painted mountains on (on) or off at these cells (the lobby server checked them): units walk
  // round them from now on. Every player's page draws them from the same message; on the coast they also
  // change the beaches (none under mountains), which go to the players with the ports.
  editMountains(cells, on) {
    if (!Array.isArray(cells)) return;
    const changed = this.nav.editMountains(cells.filter(Number.isInteger), !!on);
    if (this.map.mountains) this.map.mountains.code = encodeMask(this.nav.mountain);
    if (changed.some((c) => this.nav.isCoast[c])) this.game.sendPorts();
  }

  // The map was rebuilt: new territories, land grid and the areas paths avoid around cities.
  mapRebuilt(map, navData) {
    for (const key of Object.keys(this.map)) delete this.map[key];
    Object.assign(this.map, map);
    Object.assign(this.nav, new NavGrid(withMountains(navData, map)));
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
    if (this.awaiting && --this.awaitSteps <= 0) {
      // A takeover: whoever has not connected to this host by now is offline.
      for (const id of this.awaiting) {
        const p = g.players.get(id);
        if (p && p.connected && !p.client) g.disconnect(p);
      }
      this.awaiting = null;
    }
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
