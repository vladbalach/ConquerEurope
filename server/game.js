// One match: players, cities, units, the simulation tick and network snapshots.
// Unit behaviour lives in server/units/, city behaviour in server/City.js.
//
// This file and everything it imports also run in the host player's browser (served as /sim/),
// where the game is simulated for browser-to-browser play: no Node-only modules here.
import {
  UNITS, CITY, CITY_UPGRADES, PRODUCTION_ITEMS, GAME, ECONOMY, DISBAND, LIBERATOR, TECHS, TECH_TYPES, PLAYER_COLORS, DEBUG, NAVAL, HONOR,
  TRADITIONS, TRADITION_TYPES, HERO, HERO_KINDS, HEALER,
} from '../shared/config.js';
import {
  noTech, nextLevel, techAvailable, liberatorIncome, influenceLimit, smugglingLimit, smugglingFlows, hasSeafaring, canTrain,
} from '../shared/tech.js';
import {
  sanitizeOptions, citiesToWin, GOLD_PERCENT, sanitizeGoldPercent, scaleGold, scaleGoldWhole,
} from '../shared/options.js';
import { higherGrades } from '../shared/upgrades.js';
import { formationSlots, formationRole, SHIP_SPACING } from '../shared/formation.js';
import { City, markCityObstacles } from './City.js';
import { regionCities, regionHolder } from '../shared/regions.js';
import { createUnit } from './units/index.js';
import { HERO_KIND_SHIFT, CARGO_SHIFT } from '../shared/protocol.js';
import { History } from './history.js';

// Secret token a player rejoins with.
function randomToken() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('-');
}

// Cost and build time of anything a city can produce (a unit type or an upgrade).
const itemDef = (item) => (PRODUCTION_ITEMS.includes(item) ? UNITS[item] || CITY_UPGRADES[item] : null);

const GRID_CELL = 40;              // spatial hash cell (km) for neighbour queries
const COLLISION_MARGIN = 12;       // km a unit may be pushed in one resolveCollisions and still be found by its neighbours
const VIEW_MARGIN = 150;           // km around a player's viewport that is included in snapshots
const SHARE_RADIUS = 50;           // a unit that can't walk straight to its place follows a path found for one this close
const JOIN_POINTS = 3;             // ...joining it at one of its first points that it can see
const SLOT_SEARCH = 400;           // km round a group's destination searched for ground for places that fall in the sea
// A* work that group moves may spend on paths for units that can't walk straight to their place, beyond the
// search work of a tick (NavGrid.expansionBudget): shared by all the orders of a tick, so several at once
// don't add up.
const JOIN_EXPANSIONS = 40000;
const COMMANDS_PER_SECOND = 20;    // per player; protects the server from command spam
const MAX_DEBUG_GOLD = 1e9;        // developer console "gold N": the most it may set
const MIN_SPEED = 0.1, MAX_SPEED = 10;   // developer console "slomo N": game speed limits
const LANDING_STEP = 8;             // km between the places tried when units step ashore
const LANDING_RETRY = 0.5;          // seconds between two tries to land the units still on board
const DOCK_MARGIN = 2;              // km of water left between two docked ships
const r1 = (v) => Math.round(v * 10) / 10;

// A player's state at the start: gold, counters, connection.
function newPlayer(id, client) {
  return {
    id, name: undefined, color: null, token: null, client, connected: true, disconnectedAt: 0,
    gold: ECONOMY.startGold, eliminated: false, cityCount: 0, unitCount: 0, view: null,
    // Gold percentage the host set in the waiting room (shared/options.js): all gold received is scaled by it.
    goldPercent: GOLD_PERCENT.default,
    surrendered: false,          // gave up (Leave → Surrender) and watches the game: eliminated too
    // Game option "Death: Liberator": fallen and taking cities back. influence: cities marked for
    // liberation; the next mark is allowed once the turn counter reaches both liberateAt (after a
    // liberation) and influenceAt (one mark per turn). smuggle: cities smuggled from (separate marks).
    liberator: false, liberateAt: 0, influence: [], influenceAt: 0, smuggle: [],
    // Technologies (shared/tech.js): levels, the level being researched { tech, level, time, progress, cost },
    // and the levels queued after it [{ tech, level, cost }], each paid when queued.
    tech: noTech(), research: null, researchQueue: [],
    commandTokens: COMMANDS_PER_SECOND,
    kills: 0, losses: 0,         // gold value of enemy units destroyed / own units lost
    honor: 0,                    // earned by kills (HONOR.killShare of each unit's cost); private, shown in the top bar
    // Traditions (Honor window): the ones learned, the one being learned { tradition, time, progress, cost },
    // and the ones queued after it [{ tradition, cost }], each paid when queued.
    traditions: [], learning: null, learnQueue: [],
  };
}

class Grid {
  constructor() { this.cells = new Map(); }
  clear() { this.cells.clear(); }
  static key(cx, cy) { return (cx + 4096) * 8192 + (cy + 4096); }
  insert(o) {
    const k = Grid.key(Math.floor(o.x / GRID_CELL), Math.floor(o.y / GRID_CELL));
    let a = this.cells.get(k);
    if (!a) this.cells.set(k, (a = []));
    a.push(o);
  }
  forEachNear(x, y, r, fn) {
    const cx0 = Math.floor((x - r) / GRID_CELL), cx1 = Math.floor((x + r) / GRID_CELL);
    const cy0 = Math.floor((y - r) / GRID_CELL), cy1 = Math.floor((y + r) / GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const a = this.cells.get(Grid.key(cx, cy));
        if (a) for (let i = 0; i < a.length; i++) fn(a[i]);
      }
    }
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  constructor({ id, title, map, nav, options }) {
    this.id = id;
    this.title = title;
    this.status = 'lobby';            // lobby | running | ended
    // A hosted game before its start (see Game.hosted): { wait, countdown } in ticks, countdown null
    // while players are still loading. Nothing moves and orders are ignored until it is null.
    this.prestart = null;
    // Victory rules the host picks in the waiting room (shared/options.js).
    this.options = sanitizeOptions(options, map.cities.length);
    this.players = new Map();         // slot id (0..19) -> player
    this.hostId = null;
    this.bounds = map.bounds;
    this.nav = nav;
    this.cities = map.cities.map((c, i) => new City(this, i, c));
    this.regionCities = regionCities(map);   // region -> its city ids
    // City walls are obstacles for pathfinding (same cities in every game, so mark once).
    if (!nav.obstacle) markCityObstacles(nav, this.cities, map);
    this.cityGrid = new Grid();
    for (const c of this.cities) this.cityGrid.insert(c);
    this.updatePorts();
    this.units = new Map();
    this.unitGrid = new Grid();
    this.boarding = [];               // [unit, ship] close enough to go on board this tick
    this.unloading = [];              // transports at their landing place this tick
    this.nextUnitId = 1;
    this.time = 0;
    this.tickCount = 0;
    this.perf = { tickMs: 0, ticks: 0 };    // simulation time since the last snapshot (debug stats)
    this.turn = 0;                          // turns completed since the start
    this.nextTurnAt = ECONOMY.turnSeconds;  // game time of the next payout
    this.winner = -1;
    this.startedWith = 0;
    this.pendingDeaths = [];
    // Game speed (developer console "slomo N"): game time runs this many times as fast as real time. The
    // host's loop (HostEngine.advance) runs that many more fixed steps per second, so everything that
    // counts game time (moving, fighting, building, research, traditions, turns, cooldowns) speeds up alike.
    this.timeScale = 1;
    this.endedAt = 0;
    this.emptySince = 0;
    // What happened, turn by turn, for the results screen once the game is over (server/history.js).
    this.history = new History();
  }

  // The player who holds every city of this region, or -1 (their cities there pay more gold).
  regionHolder(region) {
    return regionHolder(this.regionCities[region], (id) => this.cities[id].owner);
  }

  // ------------------------------------------------------------ membership
  freeCities() { return this.cities.filter((c) => c.owner < 0); }

  // New players can only join before the game starts; afterwards only rejoins are allowed.
  canJoin() {
    if (this.status === 'running') return 'This game has already started';
    if (this.status === 'ended') return 'This game has ended';
    if (this.players.size >= GAME.maxPlayers) return 'Game is full';
    return null;
  }

  addPlayer(client) {
    const err = this.canJoin();
    if (err) return { error: err };
    let slot = 0;
    while (this.players.has(slot)) slot++;
    const player = {
      ...newPlayer(slot, client), name: client.name, token: randomToken(),   // colour is dealt at start()
    };
    this.players.set(slot, player);
    if (this.hostId === null) this.hostId = slot;
    return { player };
  }

  // Browser-to-browser play: the host player's browser runs the game. The lobby server has
  // already shuffled the ids and dealt the colours; the roster has no nicknames, so the host
  // never learns who is who. Players start offline and come online as they connect.
  static hosted({ id, title, map, nav, roster, hostId, options }) {
    const game = new Game({ id, title, map, nav, options });
    for (const r of roster) {
      const p = { ...newPlayer(r.id, null), color: r.color, goldPercent: sanitizeGoldPercent(r.goldPercent), connected: false };
      game.players.set(r.id, p);
    }
    game.hostId = hostId;
    game.status = 'running';
    for (const p of game.players.values()) game.giveStartingCities(p);
    for (const p of game.players.values()) game.giveStartingGold(p);
    game.startedWith = game.players.size;
    // The host's own screen has the game at once, the others only once their link opens: wait for
    // them, so the host gets no head start.
    game.prestart = { wait: GAME.startWait * GAME.tickRate, countdown: null };
    return game;
  }

  // ------------------------------------------------------------ the start of a hosted game
  // One step (one tick of real time) of the start: wait until every player has loaded the game (or
  // GAME.startWait is over, for a player who never comes), then count GAME.startCountdown down.
  // Every player is told how many have loaded, then each second of the countdown, then the start.
  stepPrestart() {
    const s = this.prestart;
    if (!s) return;
    if (s.countdown === null) {
      s.wait--;
      if (s.wait > 0 && [...this.players.values()].some((p) => !p.everConnected)) return;
      s.countdown = GAME.startCountdown * GAME.tickRate;
      if (s.countdown <= 0) this.prestart = null;      // no countdown (debug builds): start at once
      this.sendPrestart();
      return;
    }
    s.countdown--;
    if (s.countdown <= 0) {
      this.prestart = null;
      this.sendPrestart();
    } else if (s.countdown % GAME.tickRate === 0) {
      this.sendPrestart();
    }
  }

  // For the players: { loaded, total, left } (left: whole seconds of the countdown, null while
  // players are still loading), or null once the game has started.
  prestartInfo() {
    const s = this.prestart;
    if (!s) return null;
    const list = [...this.players.values()];
    return {
      loaded: list.filter((p) => p.everConnected).length, total: list.length,
      left: s.countdown === null ? null : Math.ceil(s.countdown / GAME.tickRate),
    };
  }

  sendPrestart() {
    this.broadcast({ t: 'prestart', ...(this.prestartInfo() || { left: 0 }) });
  }

  // A player who dropped out of a running game can come back: by their secret token,
  // or by name if a player with that name is currently offline.
  findRejoinable(name, token) {
    if (this.status !== 'running') return null;
    if (typeof token === 'string' && token) {
      for (const p of this.players.values()) if (p.token === token) return p;
    }
    const lower = (name || '').toLowerCase();
    if (!lower) return null;
    for (const p of this.players.values()) {
      if (!p.connected && p.name.toLowerCase() === lower) return p;
    }
    return null;
  }

  reattach(player, client) {
    if (player.client && player.client !== client) {
      player.client.game = null;
      player.client.player = null;
      player.client.send({ t: 'kicked', msg: 'You opened this game in another tab' });
    }
    const wasOffline = !player.connected;
    player.client = client;
    player.connected = true;
    player.disconnectedAt = 0;
    if (wasOffline && this.status === 'running') {
      this.broadcast({ t: 'event', kind: 'reconnected', player: player.id });
    }
    return player;
  }

  // Before the game starts a dropped player simply leaves the room. In a running game
  // they keep their empire (it can still be conquered) and may rejoin until the game ends.
  disconnect(player) {
    if (this.status === 'lobby') {
      this.removePlayer(player.id);
      return;
    }
    player.client = null;
    player.connected = false;
    player.disconnectedAt = Date.now();
    if (this.status === 'running') {
      this.broadcast({ t: 'event', kind: 'disconnected', player: player.id });
    }
    this.broadcastRoom();
  }

  // Player leaves for good: in a running game their empire falls apart.
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.status !== 'lobby') {
      this.history.event(this, id, 'left');
      this.releaseEmpire(id);
      this.broadcast({ t: 'event', kind: 'left', player: id });
    }
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    this.broadcastRoom();
  }

  // A player gives up (Leave → Surrender): their empire falls apart as if they had left, but they stay
  // in the game and watch it as a spectator. They are out for good: eliminated, never a liberator, and
  // they give no more orders. When everyone else has surrendered or left, the last player wins (recount;
  // only in a game started by 2 or more, so one player can still play alone).
  surrender(id) {
    const p = this.players.get(id);
    if (!p || p.surrendered || this.status !== 'running') return;
    p.surrendered = true;
    p.eliminated = true;
    p.liberator = false;
    p.influence = [];
    p.smuggle = [];
    p.research = null;
    p.researchQueue = [];
    p.learning = null;
    p.learnQueue = [];
    this.history.event(this, id, 'surrendered');
    this.releaseEmpire(id);
    this.broadcast({ t: 'event', kind: 'surrendered', player: id });
    this.recount();                      // may end the game: the last player standing wins
    if (this.status === 'running') this.sendScores();
  }

  // A player's empire falls apart: their cities become neutral (queues and rallies gone), their units vanish.
  releaseEmpire(id) {
    for (const c of this.cities) {
      if (c.owner !== id) continue;
      c.owner = -1; c.queue = []; c.queueHonor = []; c.progress = 0; c.rally = null; c.seaRally = null;
    }
    for (const [uid, u] of this.units) if (u.owner === id) this.units.delete(uid);
  }

  // A finished game starts again with the same players (a duel's Restart, server/index.js): started as
  // from the waiting room, with new random ids and colours.
  restart() {
    if (this.status !== 'ended') return false;
    this.status = 'lobby';
    this.winner = -1;
    this.endedAt = 0;
    return this.beginStart();
  }

  // The host changed the game options in the waiting room. Everyone there sees them at once.
  setOptions(raw) {
    if (this.status !== 'lobby' || !raw || typeof raw !== 'object') return false;
    this.options = sanitizeOptions({ ...this.options, ...raw }, this.cities.length);
    this.broadcastRoom();
    return true;
  }

  // The host set a player's gold percentage in the waiting room. Everyone there sees it at once.
  setGoldPercent(id, raw) {
    const p = this.players.get(id);
    if (this.status !== 'lobby' || !p) return false;
    p.goldPercent = sanitizeGoldPercent(raw);
    this.broadcastRoom();
    return true;
  }

  // Cities needed to win right now: the countdown lowers it as turns pass.
  citiesToWin() {
    return citiesToWin(this.options, this.turn);
  }

  // An admin moved a city on the map (Edit map): it stands at the new place in this game at once.
  // It may have become coastal, or stopped being so (the host then sends everyone the ports).
  moveCity(id, x, y) {
    const c = this.cities[id];
    if (!c) return;
    c.x = x;
    c.y = y;
    this.refreshPort(c);
    this.cityGrid = new Grid();
    for (const city of this.cities) this.cityGrid.insert(city);
  }

  // ------------------------------------------------------------ ports
  // Coastal cities (the sea within NAVAL.portRange) build ships, which are launched at the port.
  updatePorts() {
    for (const c of this.cities) this.refreshPort(c);
  }

  // An admin made a city coastal (true), inland (false), or set it back to automatic (null).
  setPortOverride(id, value) {
    const c = this.cities[id];
    if (!c) return;
    c.portOverride = typeof value === 'boolean' ? value : null;
    this.refreshPort(c);
  }

  // A city that is no longer coastal can't launch the ships in its queue: they are cancelled and
  // what was paid for them (gold, or honor) goes back to the owner.
  refreshPort(c) {
    c.updatePort();
    if (c.seaRally && (!c.port || this.nav.seaAt(c.seaRally.x, c.seaRally.y) !== c.port.sea)) c.seaRally = null;
    if (c.port || !c.queue.some((item) => UNITS[item]?.naval)) return;
    const owner = this.players.get(c.owner);
    if (UNITS[c.queue[0]]?.naval) c.progress = 0;
    const queue = [], honor = [];
    c.queue.forEach((item, i) => {
      if (!UNITS[item]?.naval) { queue.push(item); honor.push(c.queueHonor[i] || 0); }
      else this.giveBack(owner, item, c.queueHonor[i]);
    });
    c.queue = queue;
    c.queueHonor = honor;
  }

  // For the browsers: [city id, port x, port y] of every coastal city.
  portList() {
    return this.cities.filter((c) => c.port).map((c) => [c.id, r1(c.port.x), r1(c.port.y)]);
  }

  // `shore`: with the shore cells too (after a map rebuild); every player got them at the start.
  sendPorts(shore = false) {
    this.broadcast({ t: 'ports', ports: this.portList(), beaches: this.nav.beachData(shore) });
  }

  giveStartingCities(player) {
    const free = shuffle(this.freeCities()).slice(0, GAME.startCities);
    for (const c of free) {
      c.owner = player.id;
      c.hp = CITY.hp;
    }
    player.cityCount = free.length;
  }

  // The start gold the host picked in the waiting room: the same for everyone (gold percentages scale what
  // is earned in the game, not this).
  giveStartingGold(player) {
    player.gold = this.options.startGold;
  }

  // Colours are dealt at random when the game starts, so they never depend on join order
  // and nobody can know them in the lobby (see GAME_DESIGN.md, "Anonymous players").
  dealColors() {
    const colors = shuffle([...PLAYER_COLORS]);
    let k = 0;
    for (const p of this.players.values()) p.color = colors[k++];
  }

  // In the lobby, player ids follow join order and the room lists them with nicknames. New random
  // ids at the start keep anyone from matching those ids to the colours the game reveals.
  shuffleIds() {
    const host = this.players.get(this.hostId);
    const list = shuffle([...this.players.values()]);
    list.forEach((p, i) => { p.id = i; });
    this.players = new Map(list.map((p) => [p.id, p]));
    this.hostId = host ? host.id : null;
  }

  // The waiting room becomes a game: new random ids and colours (secret from the lobby).
  // The lobby server stops here for browser-to-browser play and hands the game to the host.
  beginStart() {
    if (this.status !== 'lobby' || this.players.size === 0) return false;
    this.status = 'running';
    this.shuffleIds();
    this.dealColors();
    this.startedWith = this.players.size;
    return true;
  }

  // Start and simulate here (tests, and anything that runs a game in one place).
  start() {
    if (!this.beginStart()) return;
    for (const p of this.players.values()) this.giveStartingCities(p);
    for (const p of this.players.values()) this.giveStartingGold(p);
    for (const p of this.players.values()) this.sendStart(p);
  }

  sendStart(p) {
    if (!p.client) return;
    p.client.send({
      t: 'start', you: p.id, title: this.title, options: this.options, players: this.playerList(), ports: this.portList(),
      goldPercent: p.goldPercent,               // yours only: the others' would tell who is who
      beaches: this.nav.beachData(true),        // where ships can take units on board and land them
      prestart: this.prestartInfo(),            // not started yet: waiting for players, or counting down
    });
  }

  // Players as game clients see them. While the game runs nobody may learn who is who
  // (GAME_DESIGN.md, "Anonymous players"): ids and colours only, never a nickname, and no gold
  // percentage (the waiting room showed them by nickname). In the waiting room there are no colours
  // yet, and once the game has ended everyone is revealed.
  playerList() {
    const secret = this.status === 'running';
    return [...this.players.values()].map((p) => ({
      id: p.id, ...(secret ? {} : { name: p.name, goldPercent: p.goldPercent }), color: p.color, connected: p.connected,
      eliminated: p.eliminated, surrendered: p.surrendered, cities: p.cityCount, units: p.unitCount, kills: p.kills, losses: p.losses,
      liberator: p.liberator, liberateAt: p.liberateAt, influence: p.influence, influenceAt: p.influenceAt,
      smuggle: p.smuggle, tech: p.tech,
      // Traditions are public; so is an ultimate one being learned: which (null: none) and the seconds left.
      traditions: p.traditions,
      ultimate: p.learning && TRADITIONS[p.learning.tradition].ultimate ? p.learning.tradition : null,
      ultimateLeft: p.learning && TRADITIONS[p.learning.tradition].ultimate ? Math.ceil(p.learning.time - p.learning.progress) : 0,
    }));
  }

  publicInfo() {
    const host = this.players.get(this.hostId);
    // No colours here: the lobby must not reveal which colour belongs to whom. For a game in
    // progress it lists nicknames only, alphabetically: no ids, no order, no city counts, no
    // connection or elimination status that could be matched with what happens in the game.
    const players = this.status === 'running'
      ? [...this.players.values()].map((p) => ({ name: p.name })).sort((a, b) => a.name.localeCompare(b.name))
      : [...this.players.values()].map((p) => ({
        name: p.name, connected: p.connected, eliminated: p.eliminated, cities: p.cityCount,
      }));
    return {
      id: this.id, title: this.title, status: this.status, host: host ? host.name : '-',
      max: GAME.maxPlayers, canJoin: !this.canJoin(), options: this.options, players,
    };
  }

  broadcast(msg) {
    for (const p of this.players.values()) if (p.client) p.client.send(msg);
  }

  // While a game runs, nobody is told which player hosts it: the lobby names the host.
  broadcastRoom() {
    this.broadcast({
      t: 'room', id: this.id, title: this.title, status: this.status, ...(this.status === 'running' ? {} : { hostId: this.hostId }),
      options: this.options, players: this.playerList(),
    });
  }

  // ------------------------------------------------------------ commands
  ownedUnits(player, ids) {
    if (!Array.isArray(ids)) return [];
    const out = [];
    for (const id of ids.slice(0, ECONOMY.maxUnitsPerPlayer)) {   // an order may name every unit you have
      const u = this.units.get(id);
      if (u && u.owner === player.id) out.push(u);
    }
    return out;
  }

  // Cities named by msg.cities (array) or msg.city that belong to the player, without duplicates.
  ownedCities(player, msg) {
    const ids = Array.isArray(msg.cities) ? msg.cities.slice(0, this.cities.length) : [msg.city];
    const out = [];
    for (const id of new Set(ids)) {
      const c = this.cities[id];
      if (c && c.owner === player.id) out.push(c);
    }
    return out;
  }

  clampX(x) { return Math.max(this.bounds.x0, Math.min(this.bounds.x1, x)); }
  clampY(y) { return Math.max(this.bounds.y0, Math.min(this.bounds.y1, y)); }

  handleCommand(player, msg) {
    if (this.status !== 'running') return;
    if (this.prestart && msg.t !== 'view') return;     // nobody gives orders before the start
    if (player.surrendered && msg.t !== 'view') return;   // a spectator only watches
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (msg.t !== 'view') {
      if (player.commandTokens < 1) return;
      player.commandTokens--;
    }
    switch (msg.t) {
      case 'view': {
        if (![msg.x0, msg.y0, msg.x1, msg.y1].every(num)) return;
        player.view = { x0: msg.x0, y0: msg.y0, x1: Math.min(msg.x1, msg.x0 + 8000), y1: Math.min(msg.y1, msg.y0 + 8000) };
        return;
      }
      case 'move': {
        if (!num(msg.x) || !num(msg.y)) return;
        const units = this.ownedUnits(player, msg.ids);
        const x = this.clampX(msg.x), y = this.clampY(msg.y);
        const facing = num(msg.f) ? msg.f : null;      // the way the formation faces (the right button dragged)
        const land = units.filter((u) => !u.naval), ships = units.filter((u) => u.naval);
        // Transports carrying units, a click on land: the first one, with or without Shift, is where they
        // land them (park there; with Shift after the sails queued before, Game.orderUnload `queue`). Once
        // they have a landing ahead (Ship.landing), every Shift + click on land is for the units on board:
        // where they go once ashore, one after another (Ship.queueLanding). The others, and Shift on the
        // water, sail to the nearest water (after the landing, with Shift); battleships attack-move there
        // with `amove`.
        const onLand = !this.nav.seaAt(x, y), sea = hasSeafaring(player.tech);
        const ahead = msg.queue && onLand ? ships.filter((s) => s.landing) : [];
        const landing = onLand && sea ? ships.filter((s) => s.cargo.length && !ahead.includes(s)) : [];
        const sailing = ships.filter((s) => !landing.includes(s) && !ahead.includes(s));
        // `queue` (Shift): after the orders the units already have, not instead of them.
        if (land.length) this.orderGroupMove(land, x, y, !!msg.amove, !!msg.queue, facing);
        if (landing.length) this.orderUnload(player, landing, x, y, null, true, !!msg.queue, facing);   // they attack-move there
        if (ahead.length) this.queueLandingMove(ahead, x, y, !!msg.amove, facing);
        if (sailing.length) this.orderSail(sailing, x, y, !!msg.queue, !!msg.amove, facing);
        return;
      }
      case 'board': {
        // Right-click on your transport with units selected: they come on board. `keep`: the same
        // selection already sent units to transports, and those stay with theirs. Needs Seafaring.
        if (!hasSeafaring(player.tech)) return;
        if (Number.isInteger(msg.ship)) this.orderBoard(player, msg.ship, msg.ids, !!msg.keep);
        return;
      }
      case 'autoload': {
        // Autoload (L): selected transports take the idle land units around them on board; selected land
        // units go on board your transports around them (or the selected ones). Needs Seafaring.
        if (!hasSeafaring(player.tech)) return;
        this.autoload(player, msg.ids);
        return;
      }
      case 'unload': {
        // Your transports land their units on the coast nearest to (x, y), or to the city. Needs Seafaring.
        if (!hasSeafaring(player.tech)) return;
        const city = Number.isInteger(msg.city) && this.cities[msg.city] ? this.cities[msg.city] : null;
        if (!city && (!num(msg.x) || !num(msg.y))) return;
        const ships = this.ownedUnits(player, msg.ids).filter((u) => u.naval && u.cargo.length);
        const x = city ? city.x : this.clampX(msg.x), y = city ? city.y : this.clampY(msg.y);
        if (ships.length) this.orderUnload(player, ships, x, y, city);
        return;
      }
      case 'attack': {
        const k = msg.k === 'c' ? 'c' : 'u';
        const units = this.ownedUnits(player, msg.ids);
        const target = this.resolve(k, msg.id, player.id);
        if (!units.length || !target) return;
        // Transports have no guns: they ignore it (unless they land units, below). With Shift, transports
        // with a landing ahead pass an attack on a target on land to the units on board, for once they are
        // ashore (Ship.queueLanding).
        const ahead = msg.queue && !target.naval ? units.filter((u) => u.landing) : [];
        for (const u of units) {
          if (ahead.includes(u)) u.queueLanding({ kind: 'attack', tk: k, tid: msg.id });
          else if (msg.queue && u.armed) u.queueOrder({ kind: 'attack', tk: k, tid: msg.id });
          else u.orderAttack(k, msg.id);
        }
        // Transports carrying units, right-click on an enemy city: they land them to storm it (with Shift,
        // and no landing ahead yet: after the sails queued before).
        const landing = k === 'c' && hasSeafaring(player.tech) ? units.filter((u) => u.naval && u.cargo.length && !ahead.includes(u)) : [];
        if (landing.length) this.orderUnload(player, landing, target.x, target.y, target, false, !!msg.queue);
        return;
      }
      case 'stop': {
        for (const u of this.ownedUnits(player, msg.ids)) u.makeIdle();
        return;
      }
      case 'hold': {
        for (const u of this.ownedUnits(player, msg.ids)) u.orderHold();
        return;
      }
      case 'disband': {
        // Units only: ids name units, never cities.
        for (const u of this.ownedUnits(player, msg.ids)) u.disband();
        return;
      }
      case 'build': {
        // One unit or upgrade in each listed city, in order, as far as the gold reaches. An upgrade
        // queues its next grade in each city (Wall I, or Wall II where Wall I is built or queued),
        // and is skipped where every grade is; a ship is skipped in cities that are not coastal.
        // Ships need their technology (canTrain: Seafaring for transports, Gunnery for battleships).
        // `honor`: paid with honor instead of gold, as far as the honor reaches (honorPrice: Barracks
        // with Brotherhood of Arms, units with Eternal Glory).
        const item = msg.item;
        if (!itemDef(item) || !canTrain(item, player.tech)) return;
        const honor = msg.honor === true;
        if (honor && this.honorPrice(player, item) === null) return;
        for (const c of this.ownedCities(player, msg)) {
          if (c.queue.length >= ECONOMY.maxQueue) continue;
          const key = CITY_UPGRADES[item] ? c.nextUpgrade(item) : item;
          if (!key || !c.canBuild(key)) continue;
          let paidHonor = 0;
          if (honor) {
            paidHonor = this.honorPrice(player, key);
            if (paidHonor === null || player.honor < paidHonor) continue;
            player.honor -= paidHonor;
          } else {
            const { cost } = itemDef(key);
            if (player.gold < cost) continue;   // grades differ in cost: a cheaper one may still fit
            player.gold -= cost;
          }
          c.queue.push(key);
          c.queueHonor[c.queue.length - 1] = paidHonor;
        }
        return;
      }
      case 'cancel': {
        // `last` (the C key): the last entry of each listed city's queue. Otherwise entry `index` of `city`.
        if (msg.last === true) {
          for (const c of this.ownedCities(player, msg)) {
            if (c.queue.length) this.cancelQueued(player, c, c.queue.length - 1);
          }
          return;
        }
        const c = this.cities[msg.city];
        if (!c || c.owner !== player.id || !Number.isInteger(msg.index)) return;
        if (msg.index < 0 || msg.index >= c.queue.length) return;
        this.cancelQueued(player, c, msg.index);
        return;
      }
      case 'influence': {
        // A liberator marks a city for liberation (game option "Death: Liberator").
        const c = Number.isInteger(msg.city) ? this.cities[msg.city] : null;
        if (c) this.influence(player, c);
        return;
      }
      case 'liberate':
        // Liberate every influenced city now, without waiting for the limit.
        if (player.liberator && player.influence.length) this.liberateInfluenced(player);
        return;
      case 'smuggle': {
        const c = Number.isInteger(msg.city) ? this.cities[msg.city] : null;
        if (c) this.toggleSmuggling(player, c);
        return;
      }
      case 'research':
        this.startResearch(player, msg.tech);
        return;
      case 'cancelResearch':
        // `tech` and `level`: that level, queued or running (none: the one running).
        this.cancelResearch(player, msg.tech, msg.level);
        return;
      case 'learn':
        this.startLearning(player, msg.tradition);
        return;
      case 'cancelLearn':
        // `tradition`: that one, queued or being learned (none: the one being learned).
        this.cancelLearning(player, msg.tradition);
        return;
      case 'promote':
        // Make Hero / Make Healer: one of your plain land units becomes a Hero (tradition Cult of Heroes)
        // or, with `to: 'healer'`, a Healer (Order of Mercy), for honor.
        if (Number.isInteger(msg.id)) this.promote(player, msg.id, msg.to === 'healer' ? 'healer' : 'hero');
        return;
      case 'resetHp':
        // Developer console "reset hp" (debug builds only, like the rest of the debug tools).
        if (DEBUG) this.resetHp(player.id);
        return;
      case 'setGold':
        // Developer console "gold N" (debug builds only).
        if (DEBUG && num(msg.gold)) this.setGold(player.id, msg.gold);
        return;
      case 'setHonor':
        // Developer console "honor N" (debug builds only).
        if (DEBUG && num(msg.honor)) this.setHonor(player.id, msg.honor);
        return;
      case 'setSpeed':
        // Developer console "slomo N" (debug builds only).
        if (DEBUG && num(msg.speed)) this.setSpeed(player.id, msg.speed);
        return;
      case 'takeCity':
        // "Own" on a city's panel (debug builds only): the city becomes the sender's.
        if (DEBUG && Number.isInteger(msg.city)) this.takeCity(player, msg.city);
        return;
      case 'rally': {
        // Right-click with cities selected. On land: the rally point of the units they train. On the
        // sea: the rally point of their ships (coastal cities on that sea). No position: clear both.
        const cities = this.ownedCities(player, msg);
        if (!num(msg.x) || !num(msg.y)) {
          for (const c of cities) { c.rally = null; c.seaRally = null; }
          return;
        }
        const x = this.clampX(msg.x), y = this.clampY(msg.y);
        const sea = this.nav.seaAt(x, y);
        if (!sea) {
          for (const c of cities) {
            const p = this.nav.nearestWalkable(x, y, 150, this.nav.landmass(c.x, c.y));
            c.rally = p ? { x: p[0], y: p[1] } : null;
          }
          return;
        }
        let set = 0;
        for (const c of cities) {
          if (!c.port || c.port.sea !== sea) continue;
          c.seaRally = { x, y };
          set++;
        }
        if (!set && cities.length) this.tell(player, { kind: 'rally', reason: cities.some((c) => c.port) ? 'otherSea' : 'inland' });
        return;
      }
      default:
    }
  }

  // ------------------------------------------------------------ liberators
  // Game option "Death: Liberator": a player who lost every city and unit marks ("influences")
  // cities, one per turn, and liberates them all at once: when as many are marked as their
  // Influencer limit allows (1 without it: the city is taken at once), or earlier on request.
  // After a liberation the next mark waits LIBERATOR.cooldownTurns turns.
  canInfluence(p) {
    return this.status === 'running' && this.options.death === 'liberator' && p.liberator &&
      this.turn >= p.liberateAt && this.turn >= p.influenceAt && p.influence.length < influenceLimit(p.tech);
  }

  // The liberator (other than `p`) who already has this kind of mark ('influence' or 'smuggle') on
  // the city, or null. A city carries at most one mark of each kind.
  markedBy(kind, cityId, p) {
    for (const q of this.players.values()) if (q !== p && q[kind].includes(cityId)) return q;
    return null;
  }

  influence(p, c) {
    if (!this.canInfluence(p) || c.owner === p.id || p.influence.includes(c.id) || !this.liberable(c)) return;
    if (this.markedBy('influence', c.id, p)) return;
    p.influence.push(c.id);
    p.influenceAt = this.turn + 1;
    const limit = influenceLimit(p.tech);
    // Everyone sees which cities are about to be liberated.
    this.broadcast({ t: 'event', kind: 'influence', player: p.id, city: c.id, count: p.influence.length, limit });
    if (p.influence.length >= limit) this.liberateInfluenced(p);
    else this.sendScores();
  }

  // Every influenced city changes hands like a capture (upgrades lost, the previous owner gets the
  // gold of its queue back), and the liberator is back in the game. The protection of small empires
  // is checked city by city, so nobody is taken below LIBERATOR.protectedCities this way.
  liberateInfluenced(p) {
    const cities = p.influence.map((id) => this.cities[id]);
    p.influence = [];
    let taken = 0;
    for (const c of cities) {
      if (this.status !== 'running') break;
      if (c.owner === p.id || !this.liberable(c)) continue;
      this.captureCity(c, p.id, true);
      taken++;
      this.recount();           // city counts for the next protection check
    }
    if (taken) {
      this.revive(p);
      p.liberateAt = this.turn + LIBERATOR.cooldownTurns;
    }
    this.recount();
    this.sendScores();          // everyone sees at once that they are back
  }

  // Back in the game: no longer a liberator, and their marks are gone, so other liberators may
  // mark those cities (a city carries one mark of each kind).
  revive(p) {
    if (p.liberator) this.history.event(this, p.id, 'back');
    p.liberator = false;
    p.influence = [];
    p.smuggle = [];
  }

  // Smuggling marks (separate from influence marks): click a city again to stop.
  toggleSmuggling(p, c) {
    if (this.status !== 'running' || this.options.death !== 'liberator' || !p.liberator) return;
    const i = p.smuggle.indexOf(c.id);
    if (i >= 0) p.smuggle.splice(i, 1);
    else if (c.owner !== p.id && p.smuggle.length < smugglingLimit(p.tech) && !this.markedBy('smuggle', c.id, p)) p.smuggle.push(c.id);
    else return;
    this.sendScores();
  }

  // ------------------------------------------------------------ technologies
  // Research is paid up front and runs on game time, one level at a time. Ordering more while one runs
  // queues them (paid at once too); each starts when the one before it is done. Rebellion technologies
  // exist only with Death: Liberator (techAvailable). One that `requires` another (Gunnery: Seafaring)
  // can be ordered once that one is researched or ordered.
  startResearch(p, key) {
    if (!TECH_TYPES.includes(key) || p.eliminated || !techAvailable(key, this.options)) return;
    const need = TECHS[key].requires;
    if (need && this.plannedLevel(p, need) < 1) return;
    const next = nextLevel(key, this.plannedLevel(p, key), p.liberator);    // a liberator pays less for Rebellion
    if (!next || p.gold < next.cost) return;
    p.gold -= next.cost;
    if (p.research) p.researchQueue.push({ tech: key, level: next.level, cost: next.cost });
    else p.research = { tech: key, level: next.level, time: next.time, progress: 0, cost: next.cost };
  }

  // The level of `key` once the research running and the queue are done.
  plannedLevel(p, key) {
    return [p.research, ...p.researchQueue].reduce((n, e) => (e && e.tech === key ? n + 1 : n), p.tech[key]);
  }

  // Cancels a level (running or queued) and the higher levels of that technology queued after it, as
  // they need it: their gold comes back. Cancelling the first level of a technology not researched yet
  // cancels the ones that require it too (Seafaring: Gunnery). The one running cancelled, the next in
  // the queue starts.
  cancelResearch(p, key = p.research?.tech, level = p.research?.level) {
    if (!TECH_TYPES.includes(key) || !Number.isInteger(level)) return;
    const from = new Map([[key, level]]);       // technology -> the lowest of its levels cancelled
    for (let more = true; more;) {
      more = false;
      for (const k of TECH_TYPES) {
        const need = TECHS[k].requires;
        if (need && !from.has(k) && from.get(need) <= 1 && !p.tech[need]) { from.set(k, 1); more = true; }
      }
    }
    const gone = (e) => from.has(e.tech) && e.level >= from.get(e.tech);
    for (const e of p.researchQueue.filter(gone)) p.gold += e.cost;
    p.researchQueue = p.researchQueue.filter((e) => !gone(e));
    if (p.research && gone(p.research)) {
      p.gold += p.research.cost;
      p.research = null;
      this.nextResearch(p);
    }
  }

  // The next level in the queue starts (paid when it was queued).
  nextResearch(p) {
    const e = p.researchQueue.shift();
    if (!e) return;
    const next = nextLevel(e.tech, e.level - 1);
    if (next) p.research = { ...e, time: next.time, progress: 0 };
    else { p.gold += e.cost; this.nextResearch(p); }    // no such level any more (balance changed): refunded
  }

  advanceResearch(dt) {
    for (const p of this.players.values()) {
      const r = p.research;
      if (!r) continue;
      r.progress += dt;
      if (r.progress < r.time) continue;
      p.tech = { ...p.tech, [r.tech]: p.tech[r.tech] + 1 };
      p.research = null;
      this.history.researched(this, p.id, r.tech, p.tech[r.tech], r.cost);
      if (p.client) p.client.send({ t: 'event', kind: 'researched', tech: r.tech, level: p.tech[r.tech] });
      this.sendScores();        // levels are public: they change what liberators can do
      this.nextResearch(p);
    }
  }

  // Neutral cities can always be taken; another player's only while they hold more than
  // LIBERATOR.protectedCities cities, so a small empire is not finished off this way.
  liberable(c) {
    const owner = this.players.get(c.owner);
    return !owner || owner.cityCount > LIBERATOR.protectedCities;
  }

  // Every unit and city of the game back to full HP (developer console, debug builds only).
  // Everyone is told, so nobody wonders why a siege suddenly failed.
  resetHp(by) {
    for (const u of this.units.values()) {
      u.hp = u.maxHp;
      if (u.naval) for (const c of u.cargo) c.hp = c.maxHp;
    }
    for (const c of this.cities) c.hp = c.maxHp;
    this.broadcast({ t: 'event', kind: 'hpReset', player: by });
  }

  // Every player's gold set to the same amount (developer console, debug builds only).
  setGold(by, amount) {
    const gold = Math.round(Math.min(MAX_DEBUG_GOLD, Math.max(0, amount)));
    for (const p of this.players.values()) p.gold = gold;
    this.broadcast({ t: 'event', kind: 'goldSet', player: by, gold });
  }

  // Every player's honor set to the same amount (developer console, debug builds only).
  setHonor(by, amount) {
    const honor = Math.round(Math.min(MAX_DEBUG_GOLD, Math.max(0, amount)));
    for (const p of this.players.values()) p.honor = honor;
    this.broadcast({ t: 'event', kind: 'honorSet', player: by, honor });
  }

  // The game speed (developer console "slomo N", debug builds only): N times normal, from MIN_SPEED to
  // MAX_SPEED (the host's browser has to simulate that many more steps). Everyone is told.
  setSpeed(by, speed) {
    this.timeScale = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
    this.broadcast({ t: 'event', kind: 'speedSet', player: by, speed: this.timeScale });
  }

  // A city becomes `p`'s at once, like a capture (debug builds only: the "Own" button on a city's
  // panel). Not for spectators. Everyone is told; the game's statistics don't count it.
  takeCity(p, ci) {
    const c = this.cities[ci];
    if (!c || c.owner === p.id || p.eliminated) return;
    this.captureCity(c, p.id, false, true);
  }

  // ------------------------------------------------------------ honor: traditions and heroes
  // Traditions are paid in honor up front and learned on game time, one at a time (alongside any
  // research). Learning more while one is learned queues them (paid at once too); each starts when the
  // one before it is done. Cancelling gives the honor back.
  startLearning(p, key) {
    if (!TRADITION_TYPES.includes(key) || p.eliminated || this.plansTradition(p, key)) return;
    const def = TRADITIONS[key];
    if (p.honor < def.cost || (def.ultimate && !this.readyForUltimate(p, true))) return;
    p.honor -= def.cost;
    if (p.learning) p.learnQueue.push({ tradition: key, cost: def.cost });
    else this.beginLearning(p, key, def.cost);
  }

  beginLearning(p, key, cost) {
    p.learning = { tradition: key, time: TRADITIONS[key].time, progress: 0, cost };
    // Nobody is told; the Players list (public) shows the countdown of an ultimate one from now on.
    if (TRADITIONS[key].ultimate) this.sendScores();
  }

  // Learned, being learned or queued?
  plansTradition(p, key) {
    return p.traditions.includes(key) || p.learning?.tradition === key || p.learnQueue.some((e) => e.tradition === key);
  }

  // Cancels a tradition, being learned or queued: its honor comes back. A tier I one takes the queued
  // tier II ones with it, as they need it. The one being learned cancelled, the next in the queue starts.
  cancelLearning(p, key = p.learning?.tradition) {
    if (!TRADITION_TYPES.includes(key)) return;
    const gone = (e) => e.tradition === key || (!TRADITIONS[key].ultimate && TRADITIONS[e.tradition].ultimate);
    for (const e of p.learnQueue.filter(gone)) p.honor += e.cost;
    p.learnQueue = p.learnQueue.filter((e) => !gone(e));
    if (p.learning && p.learning.tradition === key) {
      p.honor += p.learning.cost;
      p.learning = null;
      if (TRADITIONS[key].ultimate) this.sendScores();     // its countdown leaves the Players list
      this.nextLearning(p);
    }
  }

  // The next tradition in the queue starts (paid when it was queued).
  nextLearning(p) {
    const e = p.learnQueue.shift();
    if (e) this.beginLearning(p, e.tradition, e.cost);
  }

  // The ultimate (tier II) traditions open once every tier I tradition is learned. `planned`: or being
  // learned, or queued (so ahead of a tier II one queued now).
  readyForUltimate(p, planned = false) {
    return TRADITION_TYPES.every((k) => TRADITIONS[k].ultimate || (planned ? this.plansTradition(p, k) : p.traditions.includes(k)));
  }

  // Everyone is told when a player has learned an ultimate tradition (starting or cancelling it is only
  // seen in the Players list, as its countdown).
  announceUltimate(p, key) {
    this.broadcast({ t: 'event', kind: 'ultimate', player: p.id, tradition: key, state: 'learned' });
    this.sendScores();
  }

  // Has player `id` learned tradition `key`?
  hasTradition(id, key) {
    const p = this.players.get(id);
    return !!p && p.traditions.includes(key);
  }

  advanceLearning(dt) {
    for (const p of this.players.values()) {
      const l = p.learning;
      if (!l) continue;
      l.progress += dt;
      if (l.progress < l.time) continue;
      p.traditions = [...p.traditions, l.tradition];
      p.learning = null;
      this.history.learned(this, p.id, l.tradition, l.cost);
      this.tell(p, { kind: 'learned', tradition: l.tradition });
      if (TRADITIONS[l.tradition].ultimate) this.announceUltimate(p, l.tradition);
      else this.sendScores();             // traditions are public (Players list)
      this.nextLearning(p);
    }
  }

  // One of your plain land units becomes a Hero or a Healer (`to`) where it stands, keeping its id (so it
  // stays selected), its orders and its share of HP (Unit.takeOver). Not a ship, not a unit being
  // disbanded, not a Hero or Healer already. Each needs its tradition and costs honor. A Hero keeps the
  // speed and range of its kind (HERO.kinds: a knight makes a cavalry Hero).
  promote(p, id, to) {
    const rule = to === 'healer' ? { tradition: 'mercy', cost: HEALER.cost } : { tradition: 'heroes', cost: HERO.cost };
    if (!p.traditions.includes(rule.tradition) || p.honor < rule.cost) return;
    const u = this.units.get(id);
    if (!u || u.owner !== p.id || u.naval || u.stats.promoted || u.disbanding || u.hp <= 0) return;
    p.honor -= rule.cost;
    const made = createUnit(to, this, u.id, u.owner, u.x, u.y);
    if (to === 'hero') made.kind = HERO.kinds[u.type] || 'infantry';
    made.takeOver(u);
    this.units.set(u.id, made);             // same key: the unit keeps its place in the list
    this.history.promoted(p.id, to, rule.cost);
    this.tell(p, { kind: 'promoted', unit: made.id, from: u.type, to });
  }

  // Healers (Order of Mercy): every land unit of a Healer's owner within HEALER.radius of it, the Healer
  // too, regains HEALER.hpPerSecond HP per second, in combat too. Several Healers don't add up. Not
  // ships, not units being disbanded. Uses the unit grid of this tick; the units that went on board
  // this tick are still in it, so they are checked against the map.
  heal(dt) {
    const healed = new Set();
    for (const h of this.units.values()) {
      if (h.type !== 'healer') continue;
      this.unitGrid.forEachNear(h.x, h.y, HEALER.radius + 12, (u) => {
        if (u.owner !== h.owner || u.naval || u.disbanding || healed.has(u) || !this.units.has(u.id)) return;
        if (Math.hypot(u.x - h.x, u.y - h.y) <= HEALER.radius) healed.add(u);
      });
    }
    for (const u of healed) u.hp = Math.min(u.maxHp, u.hp + HEALER.hpPerSecond * dt);
  }

  // Heroes (Cult of Heroes), all the time: every land unit of a Hero's owner within HERO.auraRadius of
  // it, the Hero too, is `inspired` and deals HERO.auraBonus more damage (Unit.damage). Several Heroes
  // don't add up. Run each tick on the fresh unit grid, before the units fight.
  inspire() {
    for (const u of this.units.values()) u.inspired = false;
    for (const h of this.units.values()) {
      if (h.type !== 'hero') continue;
      this.unitGrid.forEachNear(h.x, h.y, HERO.auraRadius + 12, (u) => {
        if (u.owner === h.owner && !u.naval && Math.hypot(u.x - h.x, u.y - h.y) <= HERO.auraRadius) u.inspired = true;
      });
    }
  }

  // Send a group to (tx, ty) in formation. The units of one landmass form one formation round the open
  // land nearest to (tx, ty) on their landmass, however spread out they are (two formations round the same
  // place would stand on each other); with none within 200 km, or no way there, they ignore the order.
  // Each unit goes its own way to its place (groupRoute): no unit walks to a common gathering point first,
  // so a big army doesn't jam on one spot. Once there it keeps its place (Unit.settle).
  // With `queue` (Shift), units busy with an order go there once it is done (queueGroupMove).
  // `facing`: the way the formations face, in radians (formationSlots); null: the way each group goes.
  orderGroupMove(units, tx, ty, amove, queue = false, facing = null) {
    if (queue) {
      const later = units.filter((u) => u.busy);
      if (later.length) this.queueGroupMove(later, tx, ty, amove, facing);
      units = units.filter((u) => !u.busy);
    }
    const nav = this.nav;
    const byLand = new Map();
    for (const u of units) {
      const land = nav.landOf(u.x, u.y);                 // in the mountains: the landmass round them
      if (!byLand.has(land)) byLand.set(land, []);
      byLand.get(land).push(u);
    }
    for (const [land, group] of byLand) {
      const dest = nav.nearestWalkable(tx, ty, 200, land);
      if (!dest) continue;
      const found = [];               // paths searched for this formation (groupRoute)
      const slots = this.landSlots(group, dest[0], dest[1], land, undefined, facing);
      for (const u of group) {
        const [sx, sy] = slots.get(u);
        const route = this.groupRoute(u, sx, sy, dest, found);
        if (route !== undefined) u.orderMove(sx, sy, amove, route, group.length > 1);
      }
    }
  }

  // A group-moved unit's way to its place (sx, sy) in the formation round `dest`: straight when nothing is
  // in the way. Otherwise round what is: along the path found for a unit within SHARE_RADIUS of it (`found`,
  // the paths searched for this order), joined at the farthest of its first JOIN_POINTS points this one
  // can see; or a path of its own to `dest`, then on to its place (searched now while the order's share
  // of search work lasts, JOIN_EXPANSIONS). Null: the unit plans its own over the next ticks (Unit.travel).
  // Undefined: no way there from where it stands.
  groupRoute(u, sx, sy, dest, found) {
    const nav = this.nav;
    const route = (pts) => ({ pts, idx: 0, gx: sx, gy: sy, time: this.time });
    if (nav.clear(u.x, u.y, sx, sy)) return route(null);
    for (const f of found) {
      if (Math.hypot(f.x - u.x, f.y - u.y) > SHARE_RADIUS) continue;
      for (let k = Math.min(f.path.length, JOIN_POINTS) - 1; k >= 0; k--) {
        if (nav.clear(u.x, u.y, f.path[k][0], f.path[k][1])) return route(k ? f.path.slice(k) : f.path);
      }
    }
    if (nav.expansionBudget <= -JOIN_EXPANSIONS) return null;
    const path = nav.findPathCached(u.x, u.y, dest[0], dest[1], true);
    if (path === null) return undefined;
    if (path.length) {
      found.push({ x: u.x, y: u.y, path });
      return route(path);
    }
    // `dest` is in sight but its place is not: a path to the place itself.
    const own = nav.findPathCached(u.x, u.y, sx, sy, true);
    return own && own.length ? route(own) : null;
  }

  // (x, y) moved out of the walls of any city it is in, for a unit of radius r: to just outside them,
  // straight away from the city's centre, when that is on `land`. Formation places in a city would
  // leave their units pressed against its walls for good.
  outsideWalls(x, y, r, land) {
    this.cityGrid.forEachNear(x, y, CITY.size + r + 1, (c) => {
      const d = Math.hypot(x - c.x, y - c.y), min = c.r + r + 1;
      if (d >= min) return;
      const ax = d > 0.01 ? (x - c.x) / d : 0, ay = d > 0.01 ? (y - c.y) / d : -1;
      const px = c.x + ax * min, py = c.y + ay * min;
      if (this.nav.landmass(px, py) === land) { x = px; y = py; }
    });
    return [x, y];
  }

  // Inside the walls of a city, for a unit of radius r?
  inWalls(x, y, r) {
    let inside = false;
    this.cityGrid.forEachNear(x, y, CITY.size + r + 1, (c) => {
      if (Math.hypot(x - c.x, y - c.y) < c.r + r + 1) inside = true;
    });
    return inside;
  }

  // A place for each of `units` in a formation round (tx, ty) (formation; `at`: where each sets off from),
  // every one on open ground of `land` and outside city walls. A place that falls in the sea or in the
  // mountains goes to the free open ground nearest to it, round (tx, ty): a formation by the coast spreads
  // along the land instead of sending those units all to one spot. Map unit -> [x, y].
  landSlots(units, tx, ty, land, at = (u) => [u.x, u.y], facing = null) {
    const nav = this.nav, S = GAME.formationSpacing;
    const slots = this.formation(units, tx, ty, S, at, facing);
    const open = (x, y) => nav.landmass(x, y) === land && nav.walkable(x, y);
    const taken = new Map();          // grid cell of S km -> places taken in it
    const cell = (i, j) => `${i},${j}`;
    const take = (x, y) => {
      const k = cell(Math.floor(x / S), Math.floor(y / S));
      if (!taken.has(k)) taken.set(k, []);
      taken.get(k).push([x, y]);
    };
    const free = (x, y) => {
      const i = Math.floor(x / S), j = Math.floor(y / S);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (const [px, py] of taken.get(cell(i + di, j + dj)) || []) if (Math.hypot(px - x, py - y) < S * 0.7) return false;
        }
      }
      return true;
    };
    const homeless = [];
    for (const u of units) {
      const [x, y] = this.outsideWalls(...slots.get(u), u.r, land);
      if (open(x, y)) { slots.set(u, [x, y]); take(x, y); } else homeless.push(u);
    }
    if (!homeless.length) return slots;
    // Free open ground round (tx, ty), ring by ring, until there is plenty of it to choose from.
    const spots = [];
    const r = Math.max(...homeless.map((u) => u.r));
    for (let ring = 0; spots.length < homeless.length * 2 && ring * S <= SLOT_SEARCH; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const x = tx + i * S, y = ty + j * S;
          if (open(x, y) && free(x, y) && !this.inWalls(x, y, r)) spots.push([x, y]);
        }
      }
    }
    // The places nearest to (tx, ty) first, each to the free spot nearest to it.
    const d2 = (p) => (p[0] - tx) ** 2 + (p[1] - ty) ** 2;
    homeless.sort((p, q) => d2(slots.get(p)) - d2(slots.get(q)));
    for (const u of homeless) {
      const [px, py] = slots.get(u);
      let best = -1, bd = Infinity;
      for (let k = 0; k < spots.length; k++) {
        if (!spots[k]) continue;
        const d = (spots[k][0] - px) ** 2 + (spots[k][1] - py) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) {
        slots.set(u, spots[best]);
        spots[best] = null;
      } else {
        slots.set(u, nav.nearestWalkable(px, py, 60, land) || [tx, ty]);   // no free ground left near
      }
    }
    return slots;
  }

  // Shift + move for units busy with other orders. Each gets its slot of the formation around
  // (tx, ty) as seen from where its orders end (Unit.planEnd), on the landmass it will be on then
  // (one formation per landmass, landSlots), and goes there when those orders are done. Each plans
  // its own route when it sets off.
  queueGroupMove(units, tx, ty, amove, facing = null) {
    const nav = this.nav;
    const ends = new Map(units.map((u) => [u, u.planEnd()]));
    const byLand = new Map();
    for (const u of units) {
      const [ex, ey] = ends.get(u);
      const land = nav.landOf(ex, ey) || nav.landOf(u.x, u.y);
      if (!byLand.has(land)) byLand.set(land, []);
      byLand.get(land).push(u);
    }
    for (const [land, group] of byLand) {
      const dest = nav.nearestWalkable(tx, ty, 200, land);
      if (!dest) continue;            // no way there from where they will be
      const slots = this.landSlots(group, dest[0], dest[1], land, (u) => ends.get(u), facing);
      for (const u of group) {
        const [sx, sy] = slots.get(u);
        u.queueOrder({ kind: amove ? 'amove' : 'move', x: sx, y: sy, ...(group.length > 1 ? { place: true } : {}) });
      }
    }
  }

  // Shift + move on land for transports landing units (Ship.queueLanding): one formation round (tx, ty) for
  // everyone on board them, each from where it will stand by then (Ship.cargoEnd), as queueGroupMove does
  // for units ashore: no two of them, from any of the transports, get the same place.
  queueLandingMove(ships, tx, ty, amove, facing = null) {
    const nav = this.nav, ends = new Map(), byLand = new Map();
    for (const s of ships) {
      for (const u of s.cargo) {
        const end = s.cargoEnd(u);
        ends.set(u, end);
        const land = s.landingOrder.land || nav.landOf(end[0], end[1]);
        if (!byLand.has(land)) byLand.set(land, []);
        byLand.get(land).push(u);
      }
    }
    const slots = new Map();
    for (const [land, group] of byLand) {
      const dest = nav.nearestWalkable(tx, ty, 200, land);
      if (!dest) continue;
      for (const [u, p] of this.landSlots(group, dest[0], dest[1], land, (u) => ends.get(u), facing)) slots.set(u, p);
    }
    for (const s of ships) {
      const own = {};
      for (const u of s.cargo) if (slots.has(u)) own[u.id] = slots.get(u);
      s.queueLanding({ kind: amove ? 'amove' : 'move', x: tx, y: ty, slots: own });
    }
  }

  // Ships sail to (tx, ty) in formation, each on the sea it is on: to the nearest water of that
  // sea when (tx, ty) is on land. Each ship plans its own route. With `queue` (Shift), ships busy
  // sailing or landing units go there afterwards, from where that leaves them. With `amove`, armed
  // ships (battleships) attack-move: they fight what they meet on the way.
  orderSail(ships, tx, ty, queue = false, amove = false, facing = null) {
    const nav = this.nav, bySea = new Map();
    const from = (s) => (queue && s.busy ? s.planEnd() : [s.x, s.y]);
    for (const s of ships) {
      const [x, y] = from(s);
      const sea = nav.seaAt(x, y) || nav.seaAt(s.x, s.y);
      if (!bySea.has(sea)) bySea.set(sea, []);
      bySea.get(sea).push(s);
    }
    for (const [sea, group] of bySea) {
      const dest = sea ? nav.nearestSea(tx, ty, 300, sea) : null;
      if (!dest) continue;
      const slots = this.formation(group, dest[0], dest[1], SHIP_SPACING, from, facing);
      for (const s of group) {
        let [sx, sy] = slots.get(s);
        if (nav.seaAt(sx, sy) !== sea) [sx, sy] = nav.nearestSea(sx, sy, 60, sea) || dest;
        if (queue) s.queueOrder({ kind: amove && s.armed ? 'amove' : 'move', x: sx, y: sy });
        else s.orderMove(sx, sy, amove);
      }
    }
  }

  // Tell one player why an order did not work (or how it went): an event only they get.
  tell(player, msg) {
    if (player.client) player.client.send({ t: 'event', ...msg });
  }

  // Units the player sent to this transport that have not come on board yet.
  boardersOf(ship) {
    const out = [];
    for (const u of this.units.values()) {
      if (u.owner === ship.owner && u.order.kind === 'board' && u.order.ship === ship.id) out.push(u);
    }
    return out;
  }

  // Right-click on your transport with units selected, wherever it is. The units pick the free beach
  // nearest to them (to the middle of the group) and gather on the shore there, and the transport sails
  // to it, however far (refused only when its sea has no beach of their land). A transport already
  // waiting at a dock for units of that land keeps it: new ones join them there. Only as many units as
  // still fit are sent, the closest first; the others keep their orders.
  // Several transports clicked in a row with the same selection share the units out: with `keep`,
  // units already on their way to a transport stay with it and only the others are sent. Without it
  // (a new selection) any selected unit may be sent, leaving the transport it was going to.
  orderBoard(player, shipId, ids, keep = false) {
    const ship = this.units.get(shipId);
    if (!ship || ship.owner !== player.id || !ship.naval || !ship.capacity) return;
    const selected = this.ownedUnits(player, ids).filter((u) => !u.naval && !u.disbanding);
    const units = keep ? selected.filter((u) => u.order.kind !== 'board') : selected;
    if (!units.length) {
      if (selected.length) this.tell(player, { kind: 'board', ship: shipId, count: 0, reason: 'assigned' });
      return;
    }
    const sent = this.sendToBoard(ship, units, this.dockClaims(new Set([ship])));
    this.tell(player, sent.reason ? { kind: 'board', ship: shipId, count: 0, reason: sent.reason }
      : { kind: 'board', ship: shipId, count: sent.count, skipped: sent.skipped });
  }

  // Autoload (L, or the Autoload / Board buttons): land units go on board transports, each unit the nearest
  // transport that still has room, as if right-clicked onto it (sendToBoard). Which ones, by the selection:
  //  - any land units in it: they find your transports with room (lying idle, or already waiting at a beach)
  //    within NAVAL.autoboardRange of them, whatever transports are selected with them (full ones, often);
  //  - transports only: they take your idle land units within NAVAL.autoloadRange of them.
  // Units already on their way to a transport keep it. A fleet shares out the troops: a transport takes
  // units of one landmass only (the one it already waits at, otherwise that of the nearest unit it gets) and
  // sails to the free beach nearest to its share. The player is told how many go, once for all.
  autoload(player, ids) {
    const nav = this.nav;
    const picked = this.ownedUnits(player, ids);
    const pickedLand = picked.filter((u) => !u.naval && !u.disbanding);
    const pickedUnits = pickedLand.filter((u) => u.order.kind !== 'board');
    const findShips = pickedLand.length > 0, findUnits = !findShips;
    const units = findShips ? pickedUnits : [];
    const ships = findShips ? [] : picked.filter((s) => s.naval && s.capacity && !s.disbanding);
    if (findShips && !units.length) { this.tell(player, { kind: 'autoload', count: 0, reason: 'assigned' }); return; }
    if (findUnits && !ships.length) return;
    const range = findShips ? NAVAL.autoboardRange : NAVAL.autoloadRange;
    const waiting = new Map();                     // ship id -> units on their way to it
    for (const u of this.units.values()) {
      if (u.owner !== player.id) continue;
      if (u.naval) {
        const k = u.order.kind;
        if (findShips && u.capacity && !u.disbanding && (k === 'idle' || k === 'dock')) ships.push(u);
      } else if (u.order.kind === 'board') {
        waiting.set(u.order.ship, (waiting.get(u.order.ship) || 0) + 1);
      } else if (findUnits && u.order.kind === 'idle' && !u.disbanding) {
        units.push(u);
      }
    }
    const room = new Map(), land = new Map();      // ship -> free places; ship -> the landmass it loads from
    for (const s of ships) {
      room.set(s, s.capacity - s.cargo.length - (waiting.get(s.id) || 0));
      if (s.order.kind === 'dock' && s.gather) land.set(s, s.gather.land);
    }
    const open = ships.filter((s) => room.get(s) > 0);
    if (!open.length) {
      this.tell(player, { kind: 'autoload', count: 0, reason: findShips ? 'noship' : 'full' });
      return;
    }

    // Every pair of a transport and a unit within reach whose land has a beach on the transport's sea,
    // nearest first: each unit goes to the first transport that still has room for it.
    const seas = open.map((s) => nav.seaAt(s.x, s.y));
    const pairs = [];
    for (const u of units) {
      const l = nav.landmass(u.x, u.y);
      if (!l) continue;
      open.forEach((s, k) => {
        const d = Math.hypot(u.x - s.x, u.y - s.y);
        if (d <= range && seas[k] && nav.hasBeach(l, seas[k])) pairs.push([d, s, u, l]);
      });
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const share = new Map(), taken = new Set();     // ship -> the units it gets, in the order they were picked
    for (const [, s, u, l] of pairs) {
      if (taken.has(u)) continue;
      const list = share.get(s) || [];
      if (list.length >= room.get(s) || (land.has(s) && land.get(s) !== l)) continue;
      land.set(s, l);
      list.push(u);
      share.set(s, list);
      taken.add(u);
    }
    // Each transport picks its dock in turn, clear of the docks the ones before it got. The ones still to
    // pick don't claim the water where they lie: they are about to sail off.
    const pending = new Set(share.keys());
    let count = 0, loaded = 0;
    for (const [s, list] of share) {
      const sent = this.sendToBoard(s, list, this.dockClaims(pending));
      pending.delete(s);
      if (sent.count) { count += sent.count; loaded++; }
    }
    // Selected units that found no place: no transport in reach on their sea, or all of them full.
    const left = findShips ? units.length - count : 0;
    this.tell(player, count ? { kind: 'autoload', count, ships: loaded, ...(left ? { left } : {}) }
      : { kind: 'autoload', count: 0, reason: findShips ? 'noship' : 'none' });
  }

  // Send `units` (land units of the transport's owner) on board `ship`; `claims`: the water other ships
  // use (dockClaims). { count, skipped }: how many go and how many don't fit, or { reason } when none go:
  // 'far' (no beach of their land on the transport's sea) or 'full'.
  sendToBoard(ship, units, claims) {
    const nav = this.nav;
    // Units may stand on several landmasses: use the one most of them are on (that the transport's sea
    // has a beach of), then the beach nearest to them.
    const sea = nav.seaAt(ship.x, ship.y);
    const byLand = new Map();
    for (const u of units) {
      const land = nav.landmass(u.x, u.y);
      if (!land) continue;
      if (!byLand.has(land)) byLand.set(land, []);
      byLand.get(land).push(u);
    }
    // A dock no other ship uses, as close to the units as possible; or the one this transport is
    // already waiting at for units of that land.
    let best = null;
    const docked = ship.order.kind === 'dock' && ship.gather;
    for (const [land, list] of byLand) {
      if (best && list.length < best.list.length) continue;
      let coast = null;
      if (docked && ship.gather.land === land) {
        coast = { land: [ship.gather.x, ship.gather.y], water: [ship.order.x, ship.order.y], d: 0 };
      } else if (sea) {
        const cx = list.reduce((s, u) => s + u.x, 0) / list.length, cy = list.reduce((s, u) => s + u.y, 0) / list.length;
        coast = this.freeCoast(cx, cy, land, sea, ship.r, claims);
      }
      if (coast && (!best || list.length > best.list.length || coast.d < best.coast.d)) best = { land, list, coast };
    }
    if (!best) return { count: 0, reason: 'far' };

    // Free slots: what is on board and the units still on their way from that shore count.
    const sending = new Set(best.list);
    const waiting = this.boardersOf(ship).filter((u) => !sending.has(u) && u.order.land === best.land);
    const free = ship.capacity - ship.cargo.length - waiting.length;
    if (free <= 0) return { count: 0, reason: 'full' };

    const [gx, gy] = best.coast.land;
    const go = best.list
      .sort((p, q) => Math.hypot(p.x - gx, p.y - gy) - Math.hypot(q.x - gx, q.y - gy))
      .slice(0, free);
    if (!(docked && ship.gather.land === best.land)) {
      ship.orderDock(best.coast.water[0], best.coast.water[1], { x: gx, y: gy, land: best.land });
    }
    for (const u of go) u.orderBoard(ship.id, best.land);
    return { count: go.length, skipped: units.length - go.length };
  }

  // Unload: every transport sails to a free dock on the coast nearest to (x, y) that it can reach on
  // its sea, lands its units there and sends them on: to attack `city` when it is an enemy's,
  // otherwise to (x, y). The transports nearest to the place get the docks nearest to it; each keeps
  // clear of the docks of the others, so they don't jam. `amove` (right-click on land): the units
  // attack-move to (x, y), fighting anything they meet on the way.
  // Everyone on board all of them gets a place of their own in one formation round the place (landSlots),
  // each as seen from where its transport lands it: the units of a fleet landing along a long coast spread
  // round the place instead of every transport's units heading for the same few spots.
  // `queue` (Shift): each transport lands them after the sails queued before (from where those end), and
  // keeps them: a landing queued like any other order (Ship.startQueued).
  orderUnload(player, ships, x, y, city, amove = false, queue = false, facing = null) {
    const nav = this.nav;
    const spot = nav.nearestWalkable(x, y, 200);
    const land = spot ? nav.landmass(spot[0], spot[1]) : 0;
    const claims = this.dockClaims(new Set(ships));
    const at = new Map(ships.map((s) => [s, queue && s.busy ? s.planEnd() : [s.x, s.y]]));   // where each sets off from
    const dist = (s) => Math.hypot(at.get(s)[0] - spot[0], at.get(s)[1] - spot[1]);
    const byDistance = [...ships].sort((p, q) => (land ? dist(p) - dist(q) : 0));
    let failed = 0;
    const landing = [];               // [ship, coast] for every transport that has somewhere to land
    for (const s of byDistance) {
      const sea = nav.seaAt(...at.get(s)) || nav.seaAt(s.x, s.y);
      const coast = land && sea ? this.freeCoast(spot[0], spot[1], land, sea, s.r, claims) : null;
      if (!coast) { failed++; continue; }
      claims.push([coast.water[0], coast.water[1], s.r]);
      landing.push([s, coast]);
    }
    const from = new Map();           // unit on board -> where its transport lands it
    for (const [s, coast] of landing) for (const u of s.cargo) from.set(u, coast.land);
    const slots = from.size ? this.landSlots([...from.keys()], spot[0], spot[1], land, (u) => from.get(u), facing) : new Map();
    for (const [s, coast] of landing) {
      const own = {};
      for (const u of s.cargo) own[u.id] = slots.get(u);
      const o = {
        x: coast.water[0], y: coast.water[1], lx: coast.land[0], ly: coast.land[1], land,
        tx: spot[0], ty: spot[1], city: city && city.owner !== player.id ? city.id : -1, amove, slots: own,
      };
      if (queue) s.queueOrder({ kind: 'unload', ...o, then: [] });
      else s.orderUnload(o);
    }
    if (failed) this.tell(player, { kind: 'unload', failed, reason: land ? 'sea' : 'land' });
  }

  // Water other ships use, [x, y, r] each: the docks of those taking units on board or landing them,
  // and where idle ships lie. Ships in `except` are left out (they are getting new orders).
  dockClaims(except) {
    const out = [];
    for (const u of this.units.values()) {
      if (!u.naval || except.has(u)) continue;
      const k = u.order.kind;
      if (k === 'dock' || k === 'unload') out.push([u.order.x, u.order.y, u.r]);
      else if (k === 'idle') out.push([u.x, u.y, u.r]);
    }
    return out;
  }

  // The coast nearest to (x, y) (of `land` on `sea`, within maxDist) whose dock leaves room for a ship of
  // radius r next to every claim. When none is free, the nearest one anyway: the ship waits its turn there.
  freeCoast(x, y, land, sea, r, claims, maxDist = Infinity) {
    const free = (wx, wy) => claims.every(([cx, cy, cr]) => Math.hypot(cx - wx, cy - wy) >= cr + r + DOCK_MARGIN);
    return this.nav.coastNear(x, y, land, sea, maxDist, free) || this.nav.coastNear(x, y, land, sea, maxDist);
  }

  // After this tick's moves: units next to their transport go on board, and transports at their
  // landing place put everyone ashore.
  boardAndLand() {
    for (const [u, ship] of this.boarding) {
      if (!this.units.has(u.id) || u.hp <= 0 || ship.hp <= 0 || !this.units.has(ship.id)) continue;
      if (ship.cargo.length >= ship.capacity) { u.makeIdle(); continue; }
      this.units.delete(u.id);
      u.makeIdle();
      ship.cargo.push(u);
    }
    this.boarding.length = 0;
    const taken = [];                 // ground taken by units landed this tick (not in the grid yet)
    for (const ship of this.unloading) {
      if (ship.hp > 0 && this.units.has(ship.id)) this.landUnits(ship, taken);
    }
    this.unloading.length = 0;
  }

  // Units on board step ashore around the coast cell, each only where there is room for it: on that
  // landmass, within NAVAL.boardRadius of the coast cell, clear of other units and of city walls.
  // The ones that don't fit stay on board and the transport tries again every LANDING_RETRY seconds
  // (the player is told once); with everyone ashore it carries on with what Shift queued for it.
  // The ones ashore walk on to the target, or attack the city.
  landUnits(ship, taken) {
    const o = ship.order;
    if (this.time < (o.retryAt || 0)) return;
    // Storming a city: nobody stays on board, where the city's guns would sink them with the transport (nor
    // waits there for good once the city has fallen and the victors crowd the beach). Those that find no room
    // by the beach squeeze in among the others there (the crowd pushes itself apart), or step ashore farther
    // along it, or at last anywhere on that ground outside the walls.
    const storm = o.city >= 0;
    const landed = [];
    for (const u of ship.cargo) {
      let spot = this.landingSpot(o, u.r, taken);
      if (!spot && storm) {
        spot = this.landingSpot(o, u.r, taken, 1, 0.5) || this.landingSpot(o, u.r, taken, 2) || this.landingSpot(o, u.r, taken, 2, 0);
      }
      if (!spot) continue;
      taken.push({ x: spot[0], y: spot[1], r: u.r });
      landed.push([u, spot]);
    }
    const left = ship.cargo.length - landed.length;
    if (left) {
      o.retryAt = this.time + LANDING_RETRY;
      if (!o.crowded) {
        o.crowded = true;
        const p = this.players.get(ship.owner);
        if (p) this.tell(p, { kind: 'unload', reason: 'crowded', left });
      }
    }
    if (!landed.length) return;
    const units = landed.map(([u]) => u);
    ship.cargo = ship.cargo.filter((u) => !units.includes(u));
    for (const [u, [x, y]] of landed) {
      u.x = x; u.y = y;
      u.px = x; u.py = y;
      u.makeIdle();
      this.units.set(u.id, u);
    }
    if (!ship.cargo.length) ship.done();     // sails on if Shift queued more for it
    // What Shift gave them to do while they were on board (Ship.queueLanding). After a landing on land those
    // orders replace the march to the place clicked: that click only picked where the transports land (park
    // there; Shift + click: go there), so the units set off from the beach for the first of them. Storming a
    // city, they take it first.
    const then = o.then || [];
    const fromBeach = o.city < 0 && then.length > 0;      // `o`: the ship may have sailed on already (done)
    if (o.city >= 0 && this.resolve('c', o.city, ship.owner)) {
      for (const u of units) u.orderAttack('c', o.city);
    } else if (!fromBeach) {
      // Each to its own place in the formation of the whole landing (orderUnload), its way found from where
      // it stepped ashore; the units of one transport share the searches.
      this.sendToPlaces(units, o.slots, o.tx, o.ty, !!o.amove);
    }
    // Then those orders, one after another: moves to their own places in the formation each was given
    // (Game.queueLandingMove). Straight from the beach, the first starts now.
    then.forEach((q, i) => {
      const now = fromBeach && i === 0;
      if (q.kind === 'attack') {
        for (const u of units) {
          if (now) u.orderAttack(q.tk, q.tid);
          else u.queueOrder({ ...q });
        }
        return;
      }
      if (now) {
        this.sendToPlaces(units, q.slots, q.x, q.y, q.kind === 'amove');
        return;
      }
      const rest = [];
      for (const u of units) {
        const p = q.slots?.[u.id];
        if (p) u.queueOrder({ kind: q.kind, x: p[0], y: p[1], place: true });
        else rest.push(u);
      }
      if (rest.length) this.queueGroupMove(rest, q.x, q.y, q.kind === 'amove');
    });
  }

  // Landed units off to their places (`slots`: { unit id: [x, y] }, round (tx, ty)), each with its way found
  // from where it stands (groupRoute; the units of one landing share the searches). Units without a place
  // make a formation of their own there (orderGroupMove).
  sendToPlaces(units, slots, tx, ty, amove) {
    const found = [], rest = [];
    for (const u of units) {
      const p = slots?.[u.id];
      if (!p) { rest.push(u); continue; }
      const route = this.groupRoute(u, p[0], p[1], p, found);
      if (route !== undefined) u.orderMove(p[0], p[1], amove, route, true);
    }
    if (rest.length) this.orderGroupMove(rest, tx, ty, amove);
  }

  // Free ground for a unit of radius r near the coast cell of an unload order, nearest first, or null.
  // `reach`: how many times NAVAL.boardRadius from the coast cell to look; `squeeze`: see roomAt.
  landingSpot(o, r, taken, reach = 1, squeeze = 1) {
    for (let ring = 0; ring * LANDING_STEP <= NAVAL.boardRadius * reach; ring++) {
      const n = ring ? ring * 6 : 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.5;
        const x = o.lx + Math.cos(a) * ring * LANDING_STEP, y = o.ly + Math.sin(a) * ring * LANDING_STEP;
        if (this.nav.landmass(x, y) === o.land && this.roomAt(x, y, r, taken, squeeze)) return [x, y];
      }
    }
    return null;
  }

  // Room for a unit of radius r at (x, y): no unit on land, city wall or spot in `taken` overlaps it.
  // `squeeze` < 1: it may overlap other units (and spots in `taken`) that much, as if it were that much
  // smaller (the crowd then pushes itself apart); 0: they don't count at all. City walls always do.
  roomAt(x, y, r, taken, squeeze = 1) {
    let free = true;
    const ru = r * squeeze;
    if (squeeze > 0) {
      this.unitGrid.forEachNear(x, y, ru + 12, (u) => {
        if (free && !u.naval && this.units.has(u.id) && Math.hypot(u.x - x, u.y - y) < u.r * squeeze + ru) free = false;
      });
    }
    if (free) {
      this.cityGrid.forEachNear(x, y, CITY.size + r, (c) => {
        if (Math.hypot(c.x - x, c.y - y) < c.r + r) free = false;
      });
    }
    return free && (squeeze <= 0 || taken.every((t) => Math.hypot(t.x - x, t.y - y) >= (t.r + r) * squeeze));
  }

  // A place for each of `units` in a formation round (tx, ty) (shared/formation.js): infantry in front,
  // archers behind, cavalry on the wings. `at(u)` is where a unit sets off from: where it stands, or for a
  // queued order where its earlier orders end. `facing`: the way the formation faces, in radians; null: the
  // way the group goes.
  formation(units, tx, ty, spacing = GAME.formationSpacing, at = (u) => [u.x, u.y], facing = null) {
    return formationSlots(units, tx, ty, { spacing, facing, pos: at, role: (u) => formationRole(u.type, u.kind) });
  }

  resolve(k, id, owner) {
    if (k === 'u') {
      const t = this.units.get(id);
      return t && t.hp > 0 && t.owner !== owner ? t : null;
    }
    const c = this.cities[id];
    return c && c.owner !== owner ? c : null;
  }

  // ------------------------------------------------------------ simulation
  tick(dt) {
    if (!this.history.started) this.history.begin(this);   // the map as the game really starts
    this.time += dt;
    this.tickCount++;
    this.nav.beginTick();

    for (const p of this.players.values()) {
      p.commandTokens = Math.min(COMMANDS_PER_SECOND, p.commandTokens + COMMANDS_PER_SECOND * dt);
    }
    if (this.time >= this.nextTurnAt) {
      this.endTurn();
      if (this.status !== 'running') return;    // someone held the target to the end of the turn
    }
    this.advanceResearch(dt);
    this.advanceLearning(dt);

    for (const c of this.cities) {
      if (c.owner < 0 || !c.queue.length) continue;
      const p = this.players.get(c.owner);
      const item = c.queue[0];
      const upgrade = CITY_UPGRADES[item];
      if (!p || (!upgrade && p.unitCount >= ECONOMY.maxUnitsPerPlayer)) continue;   // unit limit pauses units only
      // Progress counts base build seconds; Barracks make units (not upgrades or ships) advance faster,
      // and Brotherhood of Arms makes a Barracks itself build faster (paid with gold or honor alike).
      let rate = 1;
      if (item === 'barracks') {
        if (p.traditions.includes('brotherhood')) rate = TRADITIONS.brotherhood.barracksBuildSpeed;
      } else if (!upgrade && !UNITS[item].naval) rate = c.trainRate;
      c.progress += dt * rate;
      if (c.progress >= itemDef(item).buildTime) {
        const paidHonor = c.queueHonor[0] || 0;
        c.queue.shift();
        c.queueHonor.shift();
        c.progress = 0;
        // What it cost (in gold, or in honor), for the results screen.
        this.history.honorSpent(p.id, paidHonor);
        const gold = paidHonor ? 0 : itemDef(item).cost;
        if (upgrade) {
          c.addUpgrade(item);
          this.history.built(p.id, item, gold);
        } else {
          this.spawnUnit(c, item);
          p.unitCount++;
          this.history.trained(p.id, item, gold);
        }
      }
    }

    this.unitGrid.clear();
    for (const u of this.units.values()) this.unitGrid.insert(u);
    this.inspire();

    for (const u of this.units.values()) {
      u.px = u.x;
      u.py = u.y;
      u.update(dt);
    }
    this.boardAndLand();

    this.resolveCollisions();

    for (const u of this.units.values()) {
      if (u.wantMove > 0) {
        const moved = Math.hypot(u.x - u.px, u.y - u.py);
        if (moved < u.wantMove * 0.3) u.stuck += dt;
        else u.stuck = Math.max(0, u.stuck - dt * 2);
      } else {
        u.stuck = 0;
      }
    }

    for (const c of this.cities) c.update(dt);

    for (const [id, u] of this.units) {
      if (u.hp > 0) continue;
      this.units.delete(id);
      this.pendingDeaths.push(u);
      this.recordDeath(u);
      // A sunk transport takes everyone on board down with it; whoever sank it gets the kills.
      if (u.naval) {
        for (const c of u.cargo) {
          c.hp = 0;
          c.disbanding = u.disbanding;
          c.lastHitOwner = u.lastHitOwner;
          c.lastPlayerHit = u.lastPlayerHit;
          this.recordDeath(c);
        }
        u.cargo = [];
      }
    }

    for (const u of this.units.values()) u.regenerate(dt);
    this.heal(dt);                    // Healers, after the dead are gone: nobody is healed back to life
    for (const c of this.cities) c.regenerate(dt);

    this.recount();
  }

  // Kills and losses are counted in gold: the cost of the unit that died. The kill goes to
  // the player who landed the last hit (a player's city counts as that player; a kill by a
  // neutral city is only a loss for the victim).
  // A disbanded unit (Delete key) is always a loss. It is a kill only for the last player who
  // hit it, and only if that hit was within DISBAND.killCreditSeconds before it died.
  // Every kill pays the killer a share of the unit's cost in gold (ECONOMY.killGoldShare, times the
  // killer's gold percentage) and gives them honor for it too (HONOR.killShare of its cost: as much as
  // it adds to their Kills).
  // A Hero is worth the gold of the unit it was made from (Unit.takeOver).
  // Honored Dead (tradition): a unit that fell gives its owner TRADITIONS.honoredDead.lossShare of its
  // value in honor. It fell unless it was disbanded; a disbanded one still fell when it counts as an
  // enemy's kill (hit by another player in its last seconds).
  recordDeath(u) {
    const value = u.value ?? UNITS[u.type].cost;
    const loser = this.players.get(u.owner);
    if (loser) loser.losses += value;
    let killerId = u.lastHitOwner;
    if (u.disbanding) {
      const hit = u.lastPlayerHit;
      killerId = hit && this.time - hit.time <= DISBAND.killCreditSeconds ? hit.owner : -1;
    }
    const killer = killerId !== u.owner ? this.players.get(killerId) : null;
    const fell = !u.disbanding || !!killer;
    if (loser && fell && loser.traditions.includes('honoredDead')) {
      loser.honor += value * TRADITIONS.honoredDead.lossShare;
      this.history.honoredDead(loser.id, value * TRADITIONS.honoredDead.lossShare);
    }
    const gold = killer ? scaleGold(value * ECONOMY.killGoldShare, killer.goldPercent) : 0;
    this.history.died(u.owner, u.type, killer ? killer.id : -1, gold, value * HONOR.killShare);
    if (!killer) return;
    killer.kills += value;
    killer.gold += gold;
    killer.honor += value * HONOR.killShare;
  }

  // The end of a turn first decides whether someone has won (checkCityVictory). If not, each city
  // pays its owner (more with a Farm, and more when the owner holds its whole region); the gold
  // arrives all at once, scaled by each player's gold percentage (whole gold).
  endTurn() {
    this.checkCityVictory();
    if (this.status !== 'running') return;
    this.turn++;
    this.nextTurnAt += ECONOMY.turnSeconds;
    const income = new Map(), fromRegions = new Map();
    const add = (map, id, gold) => map.set(id, (map.get(id) || 0) + gold);
    for (const c of this.cities) {
      if (c.owner < 0) continue;
      add(income, c.owner, c.goldPerTurn);
      if (c.hasRegionBonus) add(fromRegions, c.owner, ECONOMY.regionBonusPerCity);
    }
    // Smugglers (liberators with Smuggling) take a share of the income of the cities they marked.
    const smugglers = [...this.players.values()].filter((p) => p.liberator && p.smuggle.length)
      .map((p) => ({ id: p.id, tech: p.tech, cities: p.smuggle }));
    const smuggled = smugglingFlows(smugglers, (ci) => this.cities[ci].owner, (ci) => this.cities[ci].goldPerTurn);
    const paid = new Map();
    for (const p of this.players.values()) {
      if (p.eliminated) continue;
      // A liberator has no cities: they get a fixed amount instead (more with Supporters).
      // Smuggling moves the cities' own gold; what each side ends up with is then scaled by their percentage.
      const gain = smuggled.gain.get(p.id) || 0, loss = smuggled.loss.get(p.id) || 0;
      const pct = p.goldPercent, scaled = (v) => scaleGoldWhole(v, pct);
      const gold = scaled(p.liberator ? liberatorIncome(p.tech) + gain : (income.get(p.id) || 0) - loss);
      p.gold += gold;
      paid.set(p.id, gold);
      if (p.client) {
        p.client.send({
          t: 'event', kind: 'turn', turn: this.turn, income: gold, regionBonus: scaled(fromRegions.get(p.id) || 0),
          ...(p.liberator ? { liberator: true } : {}), ...(gain ? { smuggled: scaled(gain) } : {}),
          ...(loss ? { smuggledAway: scaled(loss) } : {}),
        });
      }
    }
    this.history.turnEnded(this, paid);
  }

  spawnUnit(city, type) {
    const naval = UNITS[type].naval;
    const [x, y] = naval ? city.launchPoint() : city.spawnPoint(UNITS[type].size);
    const u = createUnit(type, this, this.nextUnitId++, city.owner, x, y);
    this.units.set(u.id, u);
    // New units attack-move to the rally point, fighting anything they meet on the way. New ships
    // sail to the city's rally point at sea (battleships attack-move there too), or stay in the port.
    if (naval) {
      if (city.seaRally) {
        this.orderSail([u], city.seaRally.x + (Math.random() - 0.5) * 30, city.seaRally.y + (Math.random() - 0.5) * 30, false, true);
      }
    } else if (city.rally) {
      const jx = city.rally.x + (Math.random() - 0.5) * 24, jy = city.rally.y + (Math.random() - 0.5) * 24;
      const p = this.nav.walkable(jx, jy) ? [jx, jy] : [city.rally.x, city.rally.y];
      u.orderMove(p[0], p[1], true);
    }
    return u;
  }

  // Units are circles that never overlap, nobody is ever pushed into the water, and no ship is
  // pushed onto land. Ships only bump into ships, land units only into land units and cities.
  // There are thousands of units close together, so this works on flat arrays (positions, radii,
  // weights) and its own hash grid instead of the unit objects, and writes the positions back at the end.
  resolveCollisions() {
    const nav = this.nav, n = this.units.size;
    if (!n) return;
    const B = this.collisionBuffers(n);
    const { list, X, Y, R, W, ID, SEA } = B;
    let maxR = 0, i = 0;
    for (const u of this.units.values()) {
      list[i] = u;
      X[i] = u.x; Y[i] = u.y;
      const r = u.r;
      R[i] = r;
      if (r > maxR) maxR = r;
      // Fighting units hold their ground and units on Hold don't budge; walkers flow around them.
      W[i] = u.holding ? 0 : u.attacking ? 0.25 : 1;
      ID[i] = u.id;
      SEA[i] = u.naval ? 1 : 0;
      i++;
    }
    // Grid cells big enough that a unit's neighbours lie in the 3 x 3 cells around it, even after the
    // pushes of this call (COLLISION_MARGIN km).
    const { x0, y0, x1, y1 } = this.bounds;
    const size = 2 * maxR + COLLISION_MARGIN;
    const gw = Math.ceil((x1 - x0) / size) + 1, gh = Math.ceil((y1 - y0) / size) + 1;
    const gx = (x) => Math.min(gw - 1, Math.max(0, Math.floor((x - x0) / size)));
    const gy = (y) => Math.min(gh - 1, Math.max(0, Math.floor((y - y0) / size)));
    const { start, order, cellOf } = B.grid(gw * gh);
    for (let k = 0; k < n; k++) { const c = gy(Y[k]) * gw + gx(X[k]); cellOf[k] = c; start[c + 1]++; }
    for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c];
    const fill = B.fill;
    fill.set(start.subarray(0, gw * gh));
    for (let k = 0; k < n; k++) order[fill[cellOf[k]]++] = k;

    const canGo = (k, x, y) => (SEA[k] ? nav.canSail(X[k], Y[k], x, y) : nav.canStep(X[k], Y[k], x, y));
    const tryMove = (k, x, y) => {
      if (!canGo(k, x, y)) return false;
      X[k] = x; Y[k] = y;
      return true;
    };
    const cityCells = this.cityGrid.cells;
    for (let iter = 0; iter < 2; iter++) {
      for (let a = 0; a < n; a++) {
        const ca = gx(X[a]), ra = gy(Y[a]);
        for (let row = Math.max(0, ra - 1); row <= Math.min(gh - 1, ra + 1); row++) {
          for (let col = Math.max(0, ca - 1); col <= Math.min(gw - 1, ca + 1); col++) {
            const c = row * gw + col;
            for (let s = start[c], e = start[c + 1]; s < e; s++) {
              const b = order[s];
              if (ID[b] <= ID[a] || SEA[a] !== SEA[b]) continue;
              const dx = X[b] - X[a], dy = Y[b] - Y[a];
              const min = R[a] + R[b];
              const d2 = dx * dx + dy * dy;
              if (d2 >= min * min) continue;
              let d = Math.sqrt(d2), nx, ny;
              if (d < 1e-4) {
                const ang = Math.random() * Math.PI * 2;
                nx = Math.cos(ang); ny = Math.sin(ang); d = 0;
              } else {
                nx = dx / d; ny = dy / d;
              }
              const overlap = min - d;
              const wa = W[a], wb = W[b];
              const sa = wa + wb > 0 ? wa / (wa + wb) : 0.5, sb = 1 - sa;
              const ax = X[a] - nx * overlap * sa, ay = Y[a] - ny * overlap * sa;
              const bx = X[b] + nx * overlap * sb, by = Y[b] + ny * overlap * sb;
              const aOk = canGo(a, ax, ay), bOk = canGo(b, bx, by);
              if (aOk && bOk) {
                X[a] = ax; Y[a] = ay; X[b] = bx; Y[b] = by;
              } else if (bOk) {
                if (!tryMove(b, X[b] + nx * overlap, Y[b] + ny * overlap)) tryMove(b, bx, by);
              } else if (aOk) {
                if (!tryMove(a, X[a] - nx * overlap, Y[a] - ny * overlap)) tryMove(a, ax, ay);
              }
            }
          }
        }
        if (!SEA[a]) {
          // City walls (the cities' own grid, as Grid.forEachNear walks it).
          const reach = CITY.size + R[a];
          const cx0 = Math.floor((X[a] - reach) / GRID_CELL), cx1 = Math.floor((X[a] + reach) / GRID_CELL);
          const cy0 = Math.floor((Y[a] - reach) / GRID_CELL), cy1 = Math.floor((Y[a] + reach) / GRID_CELL);
          for (let cx = cx0; cx <= cx1; cx++) {
            for (let cy = cy0; cy <= cy1; cy++) {
              const cities = cityCells.get(Grid.key(cx, cy));
              if (!cities) continue;
              for (const city of cities) {
                const dx = X[a] - city.x, dy = Y[a] - city.y;
                const min = city.r + R[a];
                const d = Math.hypot(dx, dy);
                if (d >= min || d < 1e-4) continue;
                tryMove(a, city.x + (dx / d) * min, city.y + (dy / d) * min);
              }
            }
          }
        }
        X[a] = this.clampX(X[a]);
        Y[a] = this.clampY(Y[a]);
      }
    }
    for (let k = 0; k < n; k++) {
      const u = list[k];
      u.x = X[k]; u.y = Y[k];
      list[k] = null;
    }
  }

  // Typed arrays for resolveCollisions, kept between ticks and grown when there are more units.
  // grid(cells): the hash grid's arrays, `start` cleared (start[c]..start[c + 1]: cell c's units in `order`).
  collisionBuffers(n) {
    let B = this.collision;
    if (!B || B.X.length < n) {
      const cap = Math.max(256, 2 * n);
      B = this.collision = {
        list: new Array(cap).fill(null),
        X: new Float64Array(cap), Y: new Float64Array(cap), R: new Float64Array(cap), W: new Float64Array(cap),
        ID: new Int32Array(cap), SEA: new Uint8Array(cap), order: new Int32Array(cap), cellOf: new Int32Array(cap),
        start: new Int32Array(1), fill: new Int32Array(1),
        grid(cells) {
          if (this.start.length < cells + 1) { this.start = new Int32Array(cells + 1); this.fill = new Int32Array(cells + 1); }
          this.start.fill(0, 0, cells + 1);
          return this;
        },
      };
    }
    return B;
  }

  // Cancel entry `index` of the city's production queue and refund it. Cancelling an upgrade also
  // cancels its higher grades in the queue (they need it), refunded too.
  cancelQueued(player, c, index) {
    const [item] = c.queue.splice(index, 1);
    this.giveBack(player, item, c.queueHonor.splice(index, 1)[0]);
    for (const key of higherGrades(item)) {
      const i = c.queue.indexOf(key);   // always after `item`: it was queued later
      if (i < 0) continue;
      c.queue.splice(i, 1);
      this.giveBack(player, key, c.queueHonor.splice(i, 1)[0]);
    }
    if (index === 0) c.progress = 0;
  }

  // A cancelled (or lost) queue item goes back to the player as it was paid: the honor paid for it
  // (`paidHonor`, from City.queueHonor), or else its gold. Returns { gold, honor }.
  giveBack(player, item, paidHonor) {
    const back = paidHonor > 0 ? { gold: 0, honor: paidHonor } : { gold: itemDef(item).cost, honor: 0 };
    if (player) { player.gold += back.gold; player.honor += back.honor; }
    return back;
  }

  // What this player pays in honor for this item (a unit type or the upgrade key it queues), or null
  // when honor can't pay for it: Barracks with Brotherhood of Arms, any trained unit with Eternal Glory.
  honorPrice(p, item) {
    if (item === 'barracks' && p.traditions.includes('brotherhood')) return TRADITIONS.brotherhood.barracksHonor;
    const unit = UNITS[item];
    if (unit && !unit.promoted && p.traditions.includes('eternalGlory')) return unit.cost * TRADITIONS.eternalGlory.unitHonorFactor;
    return null;
  }

  // The previous owner gets back what they paid for everything still in the queue (gold, or honor
  // for a Barracks bought with it). `liberated`: taken by a liberator rather than by force.
  // `debug`: given by the "Own" button (debug builds): not counted in the game's statistics.
  captureCity(c, newOwner, liberated = false, debug = false) {
    const prev = c.owner;
    const loser = this.players.get(prev);
    let refund = 0, refundHonor = 0;
    if (loser) {
      c.queue.forEach((item, i) => {
        const back = this.giveBack(loser, item, c.queueHonor[i]);
        refund += back.gold;
        refundHonor += back.honor;
      });
    }
    c.capture(newOwner);
    if (!debug) this.history.captured(prev, newOwner, liberated);
    this.broadcast({
      t: 'event', kind: 'capture', city: c.id, from: prev, to: newOwner, refund,
      ...(refundHonor ? { refundHonor } : {}), ...(liberated ? { liberated: true } : {}), ...(debug ? { debug: true } : {}),
    });
  }

  recount() {
    for (const p of this.players.values()) { p.cityCount = 0; p.unitCount = 0; }
    for (const c of this.cities) {
      if (c.owner < 0) continue;
      const p = this.players.get(c.owner);
      if (p) p.cityCount++;
    }
    for (const u of this.units.values()) {
      const p = this.players.get(u.owner);
      if (p) p.unitCount += 1 + (u.naval ? u.cargo.length : 0);     // units on board count too
    }
    if (this.status !== 'running') return;

    // A player with no city and no unit has fallen. Depending on the game option "Death" they are
    // out (spectator), or they lose all their gold and become a liberator, who stays in the game.
    const liberators = this.options.death === 'liberator';
    let fell = false;
    for (const p of this.players.values()) {
      if (p.surrendered) continue;       // out for good, already eliminated
      const dead = p.cityCount === 0 && p.unitCount === 0;
      if (liberators) {
        if (dead && !p.liberator) {
          p.liberator = true;
          p.gold = 0;
          fell = true;
          this.history.event(this, p.id, 'fell');
          this.broadcast({ t: 'event', kind: 'liberator', player: p.id });
        } else if (!dead && p.liberator) {
          this.revive(p);
        }
      } else if (!p.eliminated && dead) {
        p.eliminated = true;
        this.history.event(this, p.id, 'out');
        this.broadcast({ t: 'event', kind: 'eliminated', player: p.id });
      }
    }
    if (fell) this.sendScores();
    // The last player standing wins at once (holding the target is only checked at the end of a
    // turn: checkCityVictory). Liberators are never eliminated: while one of them is left, the game goes on.
    // Players who surrendered are eliminated, and those who left are gone: when everyone else has done
    // either, the last one wins. Not in a game started alone (to practise): it goes on until its player is out too.
    const alive = [...this.players.values()].filter((p) => !p.eliminated);
    if (this.startedWith >= 2 && alive.length === 1) this.end(alive[0].id);
    else if (alive.length === 0) this.end(-1);
  }

  // At the end of every turn: whoever holds the target number of cities of the turn that is ending
  // wins. Reaching it during the turn is not enough: a player who lost cities again before the
  // turn ended has not won, and the game goes on. When several players hold the target, the one
  // with the most cities wins; if they hold exactly as many, the game goes on to the next turn.
  checkCityVictory() {
    this.recount();
    if (this.status !== 'running') return;
    const need = this.citiesToWin();
    let best = null, tied = false;
    for (const p of this.players.values()) {
      if (p.cityCount < need) continue;
      if (!best || p.cityCount > best.cityCount) { best = p; tied = false; }
      else if (p.cityCount === best.cityCount) tied = true;
    }
    if (best && !tied) this.end(best.id);
  }

  end(winnerId) {
    this.status = 'ended';
    this.winner = winnerId;
    this.endedAt = Date.now();
    this.history.finish(this, winnerId);
    this.sendSnapshots();   // final state, since ended games stop ticking
    this.sendScores();      // status is 'ended': the list now carries every nickname with its colour
    this.broadcast(this.gameOverMessage());
  }

  // Who won, everyone revealed, and what happened during the game (the results screen).
  gameOverMessage() {
    const w = this.players.get(this.winner);
    return {
      t: 'gameover', winner: this.winner, name: w ? w.name : null, players: this.playerList(), history: this.history.toJSON(),
    };
  }

  // ------------------------------------------------------------ networking
  sendSnapshots() {
    // Shots fired since the last snapshot (battleships) are flagged in this one.
    const shotsSince = this.lastSnapshotAt ?? -1;
    this.lastSnapshotAt = this.time;
    // Per city: owner, HP, upgrade flags (bit per UPGRADE_TYPES entry; max HP and damage follow from them).
    const cityArr = new Array(this.cities.length * 3);
    this.cities.forEach((c, i) => {
      cityArr[i * 3] = c.owner;
      cityArr[i * 3 + 1] = Math.ceil(c.hp);
      cityArr[i * 3 + 2] = c.upgradeFlags;
    });
    const time = Math.round(this.time * 1000) / 1000;
    // Debug builds report the average simulation tick time for `stat unit` / `stat unitgraph`.
    const debug = {};
    if (DEBUG && this.perf.ticks) {
      debug.st = Math.round((this.perf.tickMs / this.perf.ticks) * 100) / 100;
      this.perf.tickMs = 0;
      this.perf.ticks = 0;
    }

    for (const p of this.players.values()) {
      if (!p.client) continue;
      const v = p.view;
      const inView = (x, y) => v && x > v.x0 - VIEW_MARGIN && x < v.x1 + VIEW_MARGIN && y > v.y0 - VIEW_MARGIN && y < v.y1 + VIEW_MARGIN;
      const us = [], cargo = [], plans = [], docks = [], landPlans = [];
      for (const u of this.units.values()) {
        if (u.owner !== p.id && !inView(u.x, u.y)) continue;
        // Your own units with orders queued (Shift): where they go, one point per order, for the map.
        if (u.owner === p.id && u.queue.length) plans.push([u.id, ...u.planPoints()]);
        // Flags: 1 attacking, 2 moving, 4 disbanding, 8 on hold, 16 fired a shot. From bit HERO_KIND_SHIFT:
        // a Hero's kind; from bit CARGO_SHIFT up: a ship's cargo count (shared/protocol.js), only for your own
        // ships: nobody else sees how many are on board.
        let flags = (u.attacking ? 1 : 0) | (u.wantMove > 0 ? 2 : 0) | (u.disbanding ? 4 : 0) | (u.holding ? 8 : 0) |
          (u.shotAt > shotsSince ? 16 : 0);
        if (u.type === 'hero') flags |= Math.max(0, HERO_KINDS.indexOf(u.kind)) << HERO_KIND_SHIFT;
        if (u.naval) {
          if (u.owner === p.id) flags |= u.cargo.length << CARGO_SHIFT;
          // Your own transports: who is on board (type and HP), for the panel.
          if (u.owner === p.id && u.cargo.length) cargo.push([u.id, u.cargo.flatMap((c) => [c.t, Math.ceil(c.hp)])]);
          // Your own ships taking units on board (0) or landing them (1): their dock and the shore
          // point next to it, so you see where each will be.
          const k = u.order.kind;
          if (u.owner === p.id && (k === 'dock' || k === 'unload')) {
            const shore = k === 'dock' ? u.gather : { x: u.order.lx, y: u.order.ly };
            if (shore) docks.push(u.id, r1(u.order.x), r1(u.order.y), r1(shore.x), r1(shore.y), k === 'dock' ? 0 : 1);
          }
          // Your transports landing units that Shift gave orders for once ashore: where those units go.
          if (u.owner === p.id && u.landingOrder?.then?.length) landPlans.push([u.id, ...u.landingPlan()]);
        }
        us.push(u.id, u.t, u.owner, r1(u.x), r1(u.y), Math.ceil(u.hp), flags, u.engaged);
      }
      const shots = [];
      for (const c of this.cities) if (c.target && inView(c.x, c.y)) shots.push(c.id, c.target);
      const deaths = [];
      for (const u of this.pendingDeaths) if (inView(u.x, u.y)) deaths.push(r1(u.x), r1(u.y), u.owner, u.t);
      const q = [];
      for (const c of this.cities) {
        if (c.owner !== p.id || (!c.queue.length && !c.rally && !c.seaRally)) continue;
        // Last: the honor paid for each queue entry, or 0 when all of it was paid in gold.
        q.push([c.id, r1(c.progress), c.queue.map((item) => PRODUCTION_ITEMS.indexOf(item)),
          c.rally ? r1(c.rally.x) : null, c.rally ? r1(c.rally.y) : null,
          c.seaRally ? r1(c.seaRally.x) : null, c.seaRally ? r1(c.seaRally.y) : null,
          c.queueHonor.some((h) => h > 0) ? c.queue.map((_, i) => c.queueHonor[i] || 0) : 0]);
      }
      p.client.send({
        t: 'snap', time, u: us, c: cityArr, s: shots, d: deaths, g: Math.floor(p.gold), h: Math.floor(p.honor), q, b: cargo, w: plans, k: docks,
        ...(landPlans.length ? { wl: landPlans } : {}),
        turn: this.turn, next: this.nextTurnAt, ...debug, ...(this.timeScale !== 1 ? { ts: this.timeScale } : {}),
        // Your research (private): technology id, seconds done and the gold paid; the levels queued after it,
        // in order: [id, gold paid] (a liberator pays less for Rebellion technologies, so the refund differs).
        r: p.research ? [TECH_TYPES.indexOf(p.research.tech), r1(p.research.progress), p.research.cost] : null,
        ...(p.researchQueue.length ? { rq: p.researchQueue.map((e) => [TECH_TYPES.indexOf(e.tech), e.cost]) } : {}),
        // Honor (private): traditions learned (ids), the one being learned [id, seconds done], the queued ones.
        tr: p.traditions.map((k) => TRADITION_TYPES.indexOf(k)),
        tl: p.learning ? [TRADITION_TYPES.indexOf(p.learning.tradition), r1(p.learning.progress)] : null,
        ...(p.learnQueue.length ? { lq: p.learnQueue.map((e) => TRADITION_TYPES.indexOf(e.tradition)) } : {}),
      });
    }
    this.pendingDeaths.length = 0;
  }

  sendScores() {
    this.broadcast({ t: 'score', players: this.playerList() });
  }
}
