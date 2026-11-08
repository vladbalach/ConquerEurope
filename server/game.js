// One match: players, cities, units, the simulation tick and network snapshots.
// Unit behaviour lives in server/units/, city behaviour in server/City.js.
//
// This file and everything it imports also run in the host player's browser (served as /sim/),
// where the game is simulated for browser-to-browser play: no Node-only modules here.
import {
  UNITS, CITY, CITY_UPGRADES, PRODUCTION_ITEMS, GAME, ECONOMY, DISBAND, LIBERATOR, TECH_TYPES, PLAYER_COLORS, DEBUG,
} from '../shared/config.js';
import {
  noTech, nextLevel, techAvailable, liberatorIncome, influenceLimit, smugglingLimit, smugglingFlows,
} from '../shared/tech.js';
import { sanitizeOptions, citiesToWin } from '../shared/options.js';
import { City, markCityObstacles } from './City.js';
import { regionCities, regionHolder } from '../shared/regions.js';
import { createUnit } from './units/index.js';

// Secret token a player rejoins with.
function randomToken() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('-');
}

// Cost and build time of anything a city can produce (a unit type or an upgrade).
const itemDef = (item) => (PRODUCTION_ITEMS.includes(item) ? UNITS[item] || CITY_UPGRADES[item] : null);

const GRID_CELL = 40;              // spatial hash cell (km) for neighbour queries
const VIEW_MARGIN = 150;           // km around a player's viewport that is included in snapshots
const CLUSTER_RADIUS = 150;        // units this close share one path in a group move
const COMMANDS_PER_SECOND = 20;    // per player; protects the server from command spam
const MAX_DEBUG_GOLD = 1e9;        // developer console "gold N": the most it may set
const r1 = (v) => Math.round(v * 10) / 10;

// A player's state at the start: gold, counters, connection.
function newPlayer(id, client) {
  return {
    id, name: undefined, color: null, token: null, client, connected: true, disconnectedAt: 0,
    gold: ECONOMY.startGold, eliminated: false, cityCount: 0, unitCount: 0, view: null,
    // Game option "Death: Liberator": fallen and taking cities back. influence: cities marked for
    // liberation; the next mark is allowed once the turn counter reaches both liberateAt (after a
    // liberation) and influenceAt (one mark per turn). smuggle: cities smuggled from (separate marks).
    liberator: false, liberateAt: 0, influence: [], influenceAt: 0, smuggle: [],
    // Technologies (shared/tech.js): levels, and the one being researched { tech, time, progress, cost }.
    tech: noTech(), research: null,
    commandTokens: COMMANDS_PER_SECOND,
    kills: 0, losses: 0,         // gold value of enemy units destroyed / own units lost
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
    // Victory rules the host picks in the waiting room (shared/options.js).
    this.options = sanitizeOptions(options, map.cities.length);
    this.players = new Map();         // slot id (0..19) -> player
    this.hostId = null;
    this.bounds = map.bounds;
    this.nav = nav;
    this.cities = map.cities.map((c, i) => new City(this, i, c));
    this.regionCities = regionCities(map);   // region -> its city ids
    // City walls are obstacles for pathfinding (same cities in every game, so mark once).
    if (!nav.obstacle) markCityObstacles(nav, this.cities);
    this.cityGrid = new Grid();
    for (const c of this.cities) this.cityGrid.insert(c);
    this.units = new Map();
    this.unitGrid = new Grid();
    this.nextUnitId = 1;
    this.time = 0;
    this.tickCount = 0;
    this.perf = { tickMs: 0, ticks: 0 };    // simulation time since the last snapshot (debug stats)
    this.turn = 0;                          // turns completed since the start
    this.nextTurnAt = ECONOMY.turnSeconds;  // game time of the next payout
    this.winner = -1;
    this.startedWith = 0;
    this.pendingDeaths = [];
    this.endedAt = 0;
    this.emptySince = 0;
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
      const p = { ...newPlayer(r.id, null), color: r.color, connected: false };
      game.players.set(r.id, p);
    }
    game.hostId = hostId;
    game.status = 'running';
    for (const p of game.players.values()) game.giveStartingCities(p);
    game.startedWith = game.players.size;
    return game;
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
      for (const c of this.cities) {
        if (c.owner !== id) continue;
        c.owner = -1; c.queue = []; c.progress = 0; c.rally = null;
      }
      for (const [uid, u] of this.units) if (u.owner === id) this.units.delete(uid);
      this.broadcast({ t: 'event', kind: 'left', player: id });
    }
    if (this.hostId === id) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    this.broadcastRoom();
  }

  // The host changed the game options in the waiting room. Everyone there sees them at once.
  setOptions(raw) {
    if (this.status !== 'lobby' || !raw || typeof raw !== 'object') return false;
    this.options = sanitizeOptions({ ...this.options, ...raw }, this.cities.length);
    this.broadcastRoom();
    return true;
  }

  // Cities needed to win right now: the countdown lowers it as turns pass.
  citiesToWin() {
    return citiesToWin(this.options, this.turn);
  }

  // An admin moved a city on the map (Edit map): it stands at the new place in this game at once.
  moveCity(id, x, y) {
    const c = this.cities[id];
    if (!c) return;
    c.x = x;
    c.y = y;
    this.cityGrid = new Grid();
    for (const city of this.cities) this.cityGrid.insert(city);
  }

  giveStartingCities(player) {
    const free = shuffle(this.freeCities()).slice(0, GAME.startCities);
    for (const c of free) {
      c.owner = player.id;
      c.hp = CITY.hp;
    }
    player.cityCount = free.length;
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
    for (const p of this.players.values()) this.sendStart(p);
  }

  sendStart(p) {
    if (!p.client) return;
    p.client.send({ t: 'start', you: p.id, title: this.title, options: this.options, players: this.playerList() });
  }

  // Players as game clients see them. While the game runs nobody may learn who is who
  // (GAME_DESIGN.md, "Anonymous players"): ids and colours only, never a nickname. In the
  // waiting room there are no colours yet, and once the game has ended everyone is revealed.
  playerList() {
    const secret = this.status === 'running';
    return [...this.players.values()].map((p) => ({
      id: p.id, ...(secret ? {} : { name: p.name }), color: p.color, connected: p.connected,
      eliminated: p.eliminated, cities: p.cityCount, units: p.unitCount, kills: p.kills, losses: p.losses,
      liberator: p.liberator, liberateAt: p.liberateAt, influence: p.influence, influenceAt: p.influenceAt,
      smuggle: p.smuggle, tech: p.tech,
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

  broadcastRoom() {
    this.broadcast({
      t: 'room', id: this.id, title: this.title, status: this.status, hostId: this.hostId,
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
        if (units.length) this.orderGroupMove(units, this.clampX(msg.x), this.clampY(msg.y), !!msg.amove);
        return;
      }
      case 'attack': {
        const k = msg.k === 'c' ? 'c' : 'u';
        const units = this.ownedUnits(player, msg.ids);
        if (!units.length || !this.resolve(k, msg.id, player.id)) return;
        for (const u of units) u.orderAttack(k, msg.id);
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
        // One unit or upgrade in each listed city, in order, for as long as the gold lasts.
        // An upgrade is skipped in cities that already have it or have it queued.
        const item = msg.item;
        const def = itemDef(item);
        if (!def) return;
        for (const c of this.ownedCities(player, msg)) {
          if (player.gold < def.cost) break;
          if (c.queue.length >= ECONOMY.maxQueue) continue;
          if (CITY_UPGRADES[item] && !c.canQueueUpgrade(item)) continue;
          player.gold -= def.cost;
          c.queue.push(item);
        }
        return;
      }
      case 'cancel': {
        const c = this.cities[msg.city];
        if (!c || c.owner !== player.id || !Number.isInteger(msg.index)) return;
        if (msg.index < 0 || msg.index >= c.queue.length) return;
        const [item] = c.queue.splice(msg.index, 1);
        player.gold += itemDef(item).cost;
        if (msg.index === 0) c.progress = 0;
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
        this.cancelResearch(player);
        return;
      case 'resetHp':
        // Developer console "reset hp" (debug builds only, like the rest of the debug tools).
        if (DEBUG) this.resetHp(player.id);
        return;
      case 'setGold':
        // Developer console "gold N" (debug builds only).
        if (DEBUG && num(msg.gold)) this.setGold(player.id, msg.gold);
        return;
      case 'rally': {
        for (const c of this.ownedCities(player, msg)) {
          let p = null;
          if (num(msg.x) && num(msg.y)) {
            p = this.nav.nearestWalkable(this.clampX(msg.x), this.clampY(msg.y), 150, this.nav.landmass(c.x, c.y));
          }
          c.rally = p ? { x: p[0], y: p[1] } : null;
        }
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
      this.recount();           // city counts for the next protection check (and a possible win)
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
  // Research is paid up front and runs on game time; one at a time. Rebellion technologies exist
  // only with Death: Liberator (techAvailable).
  startResearch(p, key) {
    if (!TECH_TYPES.includes(key) || p.research || p.eliminated || !techAvailable(key, this.options)) return;
    const next = nextLevel(key, p.tech[key]);
    if (!next || p.gold < next.cost) return;
    p.gold -= next.cost;
    p.research = { tech: key, time: next.time, progress: 0, cost: next.cost };
  }

  cancelResearch(p) {
    if (!p.research) return;
    p.gold += p.research.cost;
    p.research = null;
  }

  advanceResearch(dt) {
    for (const p of this.players.values()) {
      const r = p.research;
      if (!r) continue;
      r.progress += dt;
      if (r.progress < r.time) continue;
      p.tech = { ...p.tech, [r.tech]: p.tech[r.tech] + 1 };
      p.research = null;
      if (p.client) p.client.send({ t: 'event', kind: 'researched', tech: r.tech, level: p.tech[r.tech] });
      this.sendScores();        // levels are public: they change what liberators can do
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
    for (const u of this.units.values()) u.hp = u.maxHp;
    for (const c of this.cities) c.hp = c.maxHp;
    this.broadcast({ t: 'event', kind: 'hpReset', player: by });
  }

  // Every player's gold set to the same amount (developer console, debug builds only).
  setGold(by, amount) {
    const gold = Math.round(Math.min(MAX_DEBUG_GOLD, Math.max(0, amount)));
    for (const p of this.players.values()) p.gold = gold;
    this.broadcast({ t: 'event', kind: 'goldSet', player: by, gold });
  }

  // Send a group to (tx, ty) in formation. Nearby units share one path; units on
  // another landmass than the destination cannot get there and ignore the order.
  orderGroupMove(units, tx, ty, amove) {
    const nav = this.nav;
    const left = new Set(units);
    for (const seed of units) {
      if (!left.has(seed)) continue;
      const cluster = [...left].filter((u) => Math.hypot(u.x - seed.x, u.y - seed.y) < CLUSTER_RADIUS);
      for (const u of cluster) left.delete(u);

      const land = nav.landmass(seed.x, seed.y);
      const dest = nav.nearestWalkable(tx, ty, 200, land);
      if (!dest) continue;
      let cx = 0, cy = 0;
      for (const u of cluster) { cx += u.x; cy += u.y; }
      cx /= cluster.length; cy /= cluster.length;
      let leader = cluster[0];
      for (const u of cluster) if (Math.hypot(u.x - cx, u.y - cy) < Math.hypot(leader.x - cx, leader.y - cy)) leader = u;

      const path = nav.findPathCached(leader.x, leader.y, dest[0], dest[1], true);
      if (path === null) continue;
      const slots = this.formation(cluster, dest[0], dest[1]);
      for (const u of cluster) {
        let [sx, sy] = slots.get(u);
        if (nav.landmass(sx, sy) !== land) [sx, sy] = nav.nearestWalkable(sx, sy, 60, land) || dest;
        const route = path.length && nav.clear(u.x, u.y, path[0][0], path[0][1])
          ? { pts: path, idx: 0, gx: sx, gy: sy, time: this.time }
          : null;                                // plans its own route on the next tick
        u.orderMove(sx, sy, amove, route);
      }
    }
  }

  // Rows perpendicular to the travel direction; melee in front, archers behind.
  formation(units, tx, ty) {
    const slots = new Map();
    if (units.length === 1) { slots.set(units[0], [tx, ty]); return slots; }
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x; cy += u.y; }
    cx /= units.length; cy /= units.length;
    let dx = tx - cx, dy = ty - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const px = -dy, py = dx;
    const spacing = GAME.formationSpacing;
    const cols = Math.max(1, Math.round(Math.sqrt(units.length * 2)));
    const fwd = (u) => (u.x - cx) * dx + (u.y - cy) * dy;
    const side = (u) => (u.x - cx) * px + (u.y - cy) * py;
    const melee = units.filter((u) => !u.isRanged).sort((a, b) => fwd(b) - fwd(a));
    const ranged = units.filter((u) => u.isRanged).sort((a, b) => fwd(b) - fwd(a));
    const ordered = melee.concat(ranged);
    const rows = Math.ceil(ordered.length / cols);
    for (let r = 0; r < rows; r++) {
      const row = ordered.slice(r * cols, (r + 1) * cols).sort((a, b) => side(a) - side(b));
      const back = ((rows - 1) / 2 - r) * spacing;
      row.forEach((u, i) => {
        const off = (i - (row.length - 1) / 2) * spacing;
        slots.set(u, [tx + px * off + dx * back, ty + py * off + dy * back]);
      });
    }
    return slots;
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
    this.time += dt;
    this.tickCount++;
    this.nav.beginTick();

    for (const p of this.players.values()) {
      p.commandTokens = Math.min(COMMANDS_PER_SECOND, p.commandTokens + COMMANDS_PER_SECOND * dt);
    }
    if (this.time >= this.nextTurnAt) this.endTurn();
    this.advanceResearch(dt);

    for (const c of this.cities) {
      if (c.owner < 0 || !c.queue.length) continue;
      const p = this.players.get(c.owner);
      const item = c.queue[0];
      const upgrade = CITY_UPGRADES[item];
      if (!p || (!upgrade && p.unitCount >= ECONOMY.maxUnitsPerPlayer)) continue;   // unit limit pauses units only
      // Progress counts base build seconds; Barracks make units (not upgrades) advance faster.
      c.progress += upgrade ? dt : dt * c.trainRate;
      if (c.progress >= itemDef(item).buildTime) {
        c.queue.shift();
        c.progress = 0;
        if (upgrade) {
          c.addUpgrade(item);
        } else {
          this.spawnUnit(c, item);
          p.unitCount++;
        }
      }
    }

    this.unitGrid.clear();
    for (const u of this.units.values()) this.unitGrid.insert(u);

    for (const u of this.units.values()) {
      u.px = u.x;
      u.py = u.y;
      u.update(dt);
    }

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
    }

    for (const u of this.units.values()) u.regenerate(dt);
    for (const c of this.cities) c.regenerate(dt);

    this.recount();
  }

  // Kills and losses are counted in gold: the cost of the unit that died. The kill goes to
  // the player who landed the last hit (a player's city counts as that player; a kill by a
  // neutral city is only a loss for the victim).
  // A disbanded unit (Delete key) is always a loss. It is a kill only for the last player who
  // hit it, and only if that hit was within DISBAND.killCreditSeconds before it died.
  recordDeath(u) {
    const value = UNITS[u.type].cost;
    const loser = this.players.get(u.owner);
    if (loser) loser.losses += value;
    let killerId = u.lastHitOwner;
    if (u.disbanding) {
      const hit = u.lastPlayerHit;
      killerId = hit && this.time - hit.time <= DISBAND.killCreditSeconds ? hit.owner : -1;
    }
    const killer = killerId !== u.owner ? this.players.get(killerId) : null;
    if (killer) killer.kills += value;
  }

  // Every turn each city pays its owner (more with a Farm, and more when the owner holds its
  // whole region); the gold arrives all at once.
  endTurn() {
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
    for (const p of this.players.values()) {
      if (p.eliminated) continue;
      // A liberator has no cities: they get a fixed amount instead (more with Supporters).
      const gain = smuggled.gain.get(p.id) || 0, loss = smuggled.loss.get(p.id) || 0;
      const gold = p.liberator ? liberatorIncome(p.tech) + gain : (income.get(p.id) || 0) - loss;
      p.gold += gold;
      if (p.client) {
        p.client.send({
          t: 'event', kind: 'turn', turn: this.turn, income: gold, regionBonus: fromRegions.get(p.id) || 0,
          ...(p.liberator ? { liberator: true } : {}), ...(gain ? { smuggled: gain } : {}), ...(loss ? { smuggledAway: loss } : {}),
        });
      }
    }
  }

  spawnUnit(city, type) {
    const [x, y] = city.spawnPoint(UNITS[type].size);
    const u = createUnit(type, this, this.nextUnitId++, city.owner, x, y);
    this.units.set(u.id, u);
    // New units attack-move to the rally point, fighting anything they meet on the way.
    if (city.rally) {
      const jx = city.rally.x + (Math.random() - 0.5) * 24, jy = city.rally.y + (Math.random() - 0.5) * 24;
      const p = this.nav.walkable(jx, jy) ? [jx, jy] : [city.rally.x, city.rally.y];
      u.orderMove(p[0], p[1], true);
    }
    return u;
  }

  // Units are circles that never overlap, and nobody is ever pushed into the water.
  resolveCollisions() {
    const nav = this.nav;
    const tryMove = (u, x, y) => {
      if (!nav.canStep(u.x, u.y, x, y)) return false;
      u.x = x; u.y = y;
      return true;
    };
    for (let iter = 0; iter < 2; iter++) {
      for (const a of this.units.values()) {
        this.unitGrid.forEachNear(a.x, a.y, a.r + 12, (b) => {
          if (b.id <= a.id) return;
          const dx = b.x - a.x, dy = b.y - a.y;
          const min = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) return;
          let d = Math.sqrt(d2), nx, ny;
          if (d < 1e-4) {
            const ang = Math.random() * Math.PI * 2;
            nx = Math.cos(ang); ny = Math.sin(ang); d = 0;
          } else {
            nx = dx / d; ny = dy / d;
          }
          const overlap = min - d;
          // Fighting units hold their ground and units on Hold don't budge; walkers flow around them.
          const wa = a.holding ? 0 : a.attacking ? 0.25 : 1, wb = b.holding ? 0 : b.attacking ? 0.25 : 1;
          const sa = wa + wb > 0 ? wa / (wa + wb) : 0.5, sb = 1 - sa;
          const ax = a.x - nx * overlap * sa, ay = a.y - ny * overlap * sa;
          const bx = b.x + nx * overlap * sb, by = b.y + ny * overlap * sb;
          const aOk = nav.canStep(a.x, a.y, ax, ay), bOk = nav.canStep(b.x, b.y, bx, by);
          if (aOk && bOk) {
            a.x = ax; a.y = ay; b.x = bx; b.y = by;
          } else if (bOk) {
            if (!tryMove(b, b.x + nx * overlap, b.y + ny * overlap)) tryMove(b, bx, by);
          } else if (aOk) {
            if (!tryMove(a, a.x - nx * overlap, a.y - ny * overlap)) tryMove(a, ax, ay);
          }
        });
        this.cityGrid.forEachNear(a.x, a.y, CITY.size + a.r, (c) => {
          const dx = a.x - c.x, dy = a.y - c.y;
          const min = c.r + a.r;
          const d = Math.hypot(dx, dy);
          if (d >= min || d < 1e-4) return;
          tryMove(a, c.x + (dx / d) * min, c.y + (dy / d) * min);
        });
        a.x = this.clampX(a.x);
        a.y = this.clampY(a.y);
      }
    }
  }

  // The previous owner gets back the gold for every queued unit that was not finished.
  // `liberated`: taken by a liberator rather than by force.
  captureCity(c, newOwner, liberated = false) {
    const prev = c.owner;
    const loser = this.players.get(prev);
    const refund = loser ? c.queue.reduce((sum, item) => sum + itemDef(item).cost, 0) : 0;
    if (loser) loser.gold += refund;
    c.capture(newOwner);
    this.broadcast({
      t: 'event', kind: 'capture', city: c.id, from: prev, to: newOwner, refund, ...(liberated ? { liberated: true } : {}),
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
      if (p) p.unitCount++;
    }
    if (this.status !== 'running') return;

    // A player with no city and no unit has fallen. Depending on the game option "Death" they are
    // out (spectator), or they lose all their gold and become a liberator, who stays in the game.
    const liberators = this.options.death === 'liberator';
    let fell = false;
    for (const p of this.players.values()) {
      const dead = p.cityCount === 0 && p.unitCount === 0;
      if (liberators) {
        if (dead && !p.liberator) {
          p.liberator = true;
          p.gold = 0;
          fell = true;
          this.broadcast({ t: 'event', kind: 'liberator', player: p.id });
        } else if (!dead && p.liberator) {
          this.revive(p);
        }
      } else if (!p.eliminated && dead) {
        p.eliminated = true;
        this.broadcast({ t: 'event', kind: 'eliminated', player: p.id });
      }
    }
    if (fell) this.sendScores();
    // Whoever holds the target number of cities wins. When the countdown brings the target down to
    // several players at once, the one with the most cities wins; if they hold exactly as many,
    // the game goes on until one of them pulls ahead.
    const need = this.citiesToWin();
    let best = null, tied = false;
    for (const p of this.players.values()) {
      if (p.cityCount < need) continue;
      if (!best || p.cityCount > best.cityCount) { best = p; tied = false; }
      else if (p.cityCount === best.cityCount) tied = true;
    }
    if (best && !tied) { this.end(best.id); return; }
    // Liberators are never eliminated: while one of them is left, the game goes on.
    const alive = [...this.players.values()].filter((p) => !p.eliminated);
    if (this.startedWith >= 2 && alive.length === 1) this.end(alive[0].id);
    else if (alive.length === 0) this.end(-1);
  }

  end(winnerId) {
    this.status = 'ended';
    this.winner = winnerId;
    this.endedAt = Date.now();
    const w = this.players.get(winnerId);
    this.sendSnapshots();   // final state, since ended games stop ticking
    this.sendScores();      // status is 'ended': the list now carries every nickname with its colour
    this.broadcast({ t: 'gameover', winner: winnerId, name: w ? w.name : null, players: this.playerList() });
  }

  // ------------------------------------------------------------ networking
  sendSnapshots() {
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
      const us = [];
      for (const u of this.units.values()) {
        if (u.owner !== p.id && !inView(u.x, u.y)) continue;
        us.push(u.id, u.t, u.owner, r1(u.x), r1(u.y), Math.ceil(u.hp),
          (u.attacking ? 1 : 0) | (u.wantMove > 0 ? 2 : 0) | (u.disbanding ? 4 : 0) | (u.holding ? 8 : 0), u.engaged);
      }
      const shots = [];
      for (const c of this.cities) if (c.target && inView(c.x, c.y)) shots.push(c.id, c.target);
      const deaths = [];
      for (const u of this.pendingDeaths) if (inView(u.x, u.y)) deaths.push(r1(u.x), r1(u.y), u.owner, u.t);
      const q = [];
      for (const c of this.cities) {
        if (c.owner !== p.id || (!c.queue.length && !c.rally)) continue;
        q.push([c.id, r1(c.progress), c.queue.map((item) => PRODUCTION_ITEMS.indexOf(item)),
          c.rally ? r1(c.rally.x) : null, c.rally ? r1(c.rally.y) : null]);
      }
      p.client.send({
        t: 'snap', time, u: us, c: cityArr, s: shots, d: deaths, g: Math.floor(p.gold), q,
        turn: this.turn, next: this.nextTurnAt, ...debug,
        // Your research (private): technology id and seconds done.
        r: p.research ? [TECH_TYPES.indexOf(p.research.tech), r1(p.research.progress)] : null,
      });
    }
    this.pendingDeaths.length = 0;
  }

  sendScores() {
    this.broadcast({ t: 'score', players: this.playerList() });
  }
}
