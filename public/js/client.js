// In-game client state: snapshot interpolation, selection, commands, effects.
import {
  UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, ECONOMY, LIBERATOR, TECHS, TECH_TYPES,
  NEUTRAL_COLOR, PLAYER_COLOR_NAMES, TRADITIONS, TRADITION_TYPES, HERO, HERO_KINDS, HEALER, NAVAL, GAME,
} from '/shared/config.js';
import { formationSlots, formationRole, SHIP_SPACING } from '/shared/formation.js';
import { liberatorIncome, influenceLimit, smugglingLimit, smugglingFlows, hasSeafaring, canTrain, shipSpeedFactor } from '/shared/tech.js';
import { sanitizeOptions, citiesToWin, describeOptions, sanitizeGoldPercent, scaleGoldWhole } from '/shared/options.js';
import { regionCities, regionHolder } from '/shared/regions.js';
import { nearestCell } from '/shared/coastline.js';
import { CARGO_SHIFT, heroKindOf } from '/shared/protocol.js';
import { nextGrade, upgradeGrades } from '/shared/upgrades.js';
import { heroName } from './units/Hero.js';
import { Renderer, REGION_GLOW, LOST_PING } from './render.js';
import { Input } from './input.js';
import { Hud, colorTag } from './hud.js';
import { playSound } from './sound.js';

const INTERP_DELAY = 0.13;   // seconds behind the newest snapshot
const TICK_SECONDS = 3;      // a clock tick sounds in each of the last seconds of a turn

export class GameClient {
  constructor({
    map, net, link, gameId, you, title, options, players, ports, beaches, onLeave, debug = null, admin = false, mapState = null,
    prestart = null, goldPercent = undefined,
  }) {
    this.map = map;
    this.net = net;              // the lobby server: balance, map edits, a duel's Restart
    this.hostLink = link || net; // the game, run by the host's browser (p2p.js)
    this.link = { send: (msg) => this.order(msg) };   // orders go here, on to the host once the game has started
    // Before the start (hosted games): { loaded, total, left } from the host, null once it has started.
    this.prestart = prestart && prestart.left !== 0 ? prestart : null;
    this.prestartLeft = null;    // the last second of the countdown shown (clock ticks)
    this.waitToldAt = -Infinity; // when an order before the start last said "not yet"
    this.debug = debug;          // debug tools (stats overlays) or null in production
    this.admin = admin;          // may edit the game balance (Edit button) and the map (Edit map)
    this.mapEdit = false;        // Edit map mode: drag cities to move them (admins only)
    this.mapState = mapState || { pending: 0, busy: false };
    this.serverTickMs = 0;
    this.gameId = gameId;
    this.you = you;
    this.title = title;
    this.options = sanitizeOptions(options, map.cities.length);   // victory rules the host picked
    // Your gold percentage (set by the host in the waiting room): all the gold you receive is scaled by it.
    // Only yours: the others' would give away who is who.
    this.goldPercent = sanitizeGoldPercent(goldPercent);
    this.turn = 0;
    this.onLeave = onLeave;
    this.players = new Map();
    this.setPlayers(players);

    const n = map.cities.length;
    this.cityOwner = new Int16Array(n).fill(-1);
    this.regionCities = regionCities(map);       // region -> its city ids
    this.cityHp = new Float32Array(n).fill(CITY.hp);
    this.cityUpgrades = new Uint8Array(n);     // built upgrades per city: bit per UPGRADE_TYPES entry
    this.upgradesVersion = 0;
    this.territoryVersion = 0;

    this.snaps = [];
    this.offset = null;
    this.timeScale = 1;          // game speed (developer console "slomo"): see gameClock
    this.renderUnits = [];
    this.unitById = new Map();
    this.myQueues = new Map();
    this.gold = 0;
    this.honor = 0;              // from kills; spent in the Honor window and on Heroes
    this.traditions = new Set(); // traditions learned (Honor window)
    this.learning = null;        // { tradition, progress }: the one being learned, if any
    this.learnQueue = [];        // traditions queued after it, in order
    this.researchQueue = [];     // technologies queued after the research running, one entry per level, in order
    this.cityShots = [];
    this.cargo = new Map();          // your transports: ship id -> [{ t, hp }] of the units on board
    this.plans = new Map();          // your units with Shift-queued orders: id -> [kind, x, y, ...], current order first
    // Your transports with a landing ahead that Shift gave orders for: ship id -> { from: [x, y] the beach where
    // they land, points: [kind, x, y, ...] where they go from there }.
    this.landPlans = new Map();
    this.setPorts(ports || []);
    this.setBeaches(beaches);        // before the renderer: it draws them on the map

    this.selection = new Set();
    this.selectedCities = new Set();   // own cities; several can be selected at once
    this.inspect = null;
    this.hoverRegion = -1;             // the region whose stat the mouse is on, in the city panel: lit on the map
    this.hoverCity = -1;               // the city of that panel: the light spreads from it
    // Goes up whenever the player changes the selection (not when units leave it by dying or going
    // on board). boardRound: the selection version that sent the last board order, or -1 after any
    // other order. Transports clicked in a row by the same selection share its units out.
    this.selectionVersion = 0;
    this.boardRound = -1;
    this.groups = new Map();

    // regions: regions you just took whole, lit up for a moment ({ region, city taken last, t0 }).
    // lost: your cities just captured, pinging on the minimap ({ city, t0 }, render.js LOST_PING).
    // blasts: a battleship's gun smoke, and where its shot lands ({ x, y, t0, dur, kind }, render.js drawBlasts).
    this.effects = { shots: [], sparks: [], deaths: [], markers: [], flashes: [], regions: [], lost: [], blasts: [] };
    this.lostCity = -1;              // your city captured last: Shift + Space shows it
    this.toldLostKey = false;        // the feed said so (with the first city you lose)
    this.unitTimers = new Map();
    this.cityTimers = new Map();
    this.volleys = new Map();        // battleship id -> time of the snapshot whose shot was drawn

    this.ended = false;
    // A finished duel (two players): { votes: [ids of players who pressed Restart], open: both still
    // there } from the lobby server, else null. restarting: both pressed it, the new game is on its way.
    this.restart = null;
    this.restarting = false;
    this.firstSnap = true;
    this.turnSecond = null;      // whole seconds left in the turn at the last frame (countdown ticks)
    this.viewSentAt = 0;
    this.viewDirty = true;

    this.canvas = document.getElementById('view');
    const b = map.bounds;
    this.cam = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, zoom: 0.3 };
    this.renderer = new Renderer(this, this.canvas, document.getElementById('minimap'));
    this.hud = new Hud(this);
    this.input = new Input(this);
    this.input.clampCamera();

    this.hud.renderPrestart(this.prestart);

    this.lastFrame = performance.now();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  // Orders for the host. Before the start it ignores them (it waits for every player), so say why
  // instead. The view always goes: snapshots follow the camera.
  order(msg) {
    if (this.prestart && msg.t !== 'view') {
      const now = performance.now();
      if (now - this.waitToldAt > 3000) {
        this.waitToldAt = now;
        this.hud.feed('The game has not started yet: orders count once the countdown is over', 'bad');
      }
      return;
    }
    this.hostLink.send(msg);
  }

  // How a hosted game's start goes: players loading it, then the countdown, then the start itself
  // (info null, or left 0). Clock ticks for the last 3 seconds, as for the end of a turn.
  onPrestart(info) {
    const waiting = !!this.prestart;
    this.prestart = info && info.left !== 0 ? info : null;
    const left = this.prestart ? this.prestart.left : null;
    const lower = left !== null && (this.prestartLeft === null || left < this.prestartLeft);
    if (lower && left >= 1 && left <= TICK_SECONDS) playSound('tick');
    this.prestartLeft = left;
    const go = waiting && !this.prestart;
    if (go) {
      // The game clock starts now; until then every snapshot stood at time 0.
      this.snaps = [];
      this.offset = null;
    }
    this.hud.renderPrestart(this.prestart, go);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.input.destroy();
    this.hud.destroy();
  }

  // ---------------------------------------------------------------- server messages
  setPlayers(list) {
    this.players.clear();
    for (const p of list) this.players.set(p.id, p);
    this.indexMarks();
    this.hud?.renderScores();
    this.hud?.renderTech();
  }

  // Liberators' marks by city, for the map and the city panels: city -> [player ids]. Influence
  // marks (cities about to be liberated) and smuggling marks are separate. Smuggling marks count
  // only while their liberator is one (they stay when the player comes back, doing nothing).
  indexMarks() {
    const influence = new Map(), smuggle = new Map();
    const add = (m, ci, id) => { if (!m.has(ci)) m.set(ci, []); m.get(ci).push(id); };
    for (const p of this.players.values()) {
      if (!p.liberator) continue;
      for (const ci of p.influence || []) add(influence, ci, p.id);
      for (const ci of (p.smuggle || []).slice(0, smugglingLimit(p.tech))) add(smuggle, ci, p.id);
    }
    this.marks = { influence, smuggle };
  }

  // Coastal cities and where their port is: [[city id, x, y], ...] from the host (sent again
  // when an admin moves a city or rebuilds the map).
  setPorts(list) {
    this.ports = new Map(list.map(([ci, x, y]) => [ci, { x, y }]));
  }

  onPorts(msg) {
    this.setPorts(msg.ports || []);
    this.hud.colKey = null;           // the Transport button depends on which cities are coastal
    if (msg.beaches && msg.beaches.code !== this.beaches?.code) {
      this.setBeaches(msg.beaches);
      this.renderer.buildPaths(this.map);       // redraw the coast with the new beaches
      this.renderer.mapKey = '';
      this.renderer.miniVersion = -1;
    }
  }

  // Beaches from the host (NavGrid.beachData): the shore cells (coast cells on the drawn coastline,
  // sent at the start and after a map rebuild) and those of them that are beaches, where ships take
  // units on board and land them. Both as base-36 steps from one cell index to the next.
  setBeaches(b) {
    if (!b || !b.code) { this.beaches = null; return; }
    const decode = (code) => {
      const cells = new Set();
      let c = 0;
      for (const step of code.split(',')) { c += parseInt(step, 36); cells.add(c); }
      return cells;
    };
    const shore = b.shore ? decode(b.shore) : this.beaches?.shore || null;
    this.beaches = { cell: b.cell, x0: b.x0, y0: b.y0, w: b.w, code: b.code, cells: decode(b.code), shore };
  }

  // Is the coast at (x, y) a beach? Exactly as the host decides: the shore cell nearest to that piece
  // of coastline (shared/coastline.js), beach or cliff.
  isBeachAt(x, y) {
    const b = this.beaches;
    if (!b || !b.shore) return false;
    const c = nearestCell(b, x, y, (k) => b.shore.has(k));
    return c >= 0 && b.cells.has(c);
  }

  isCoastal(ci) {
    return this.ports.has(ci);
  }

  isNaval(t) {
    return !!UNITS[UNIT_TYPES[t]]?.naval;
  }

  // Units on board one of your transports (none for others' ships, whose cargo is a count in the flags).
  cargoOf(id) {
    return this.cargo.get(id) || [];
  }

  colorOf(owner) {
    if (owner < 0) return NEUTRAL_COLOR;
    const p = this.players.get(owner);
    return (p && p.color) || NEUTRAL_COLOR;     // colours are dealt at random by the server
  }

  // How a player is called during the game: by colour only, never by nickname
  // (GAME_DESIGN.md, "Anonymous players"). Your own empire is "You".
  nameOf(owner) {
    if (owner < 0) return 'neutral';
    if (owner === this.you) return 'You';
    const color = this.players.get(owner)?.color;
    return PLAYER_COLOR_NAMES[color] || 'Someone';
  }

  // The page's estimate of the game clock runs on this, not on performance.now(): real milliseconds
  // times the game speed (developer console "slomo"), so it keeps pace with a faster or slower game.
  gameClock(now) {
    if (this.clockAt === undefined) { this.clockAt = now; this.clockMs = now; }
    if (now > this.clockAt) {
      this.clockMs += (now - this.clockAt) * this.timeScale;
      this.clockAt = now;
    }
    return this.clockMs;
  }

  onSnap(msg) {
    const now = performance.now();
    this.gameClock(now);                 // up to now at the old speed, then the new one
    const speed = msg.ts || 1;
    if (speed !== this.timeScale) {
      this.timeScale = speed;
      this.offset = null;                // the clock ran at the old speed until now: anchor it again
      this.hud.speedChanged();
    }
    const sample = this.gameClock(now) - msg.time * 1000;
    // Before the start the game clock stands still: no estimate of it until it runs.
    if (this.prestart) this.offset = null;
    else if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
    this.snapTime = msg.time;

    const units = new Map();
    const a = msg.u;
    for (let i = 0; i < a.length; i += 8) {
      units.set(a[i], { id: a[i], t: a[i + 1], owner: a[i + 2], x: a[i + 3], y: a[i + 4], hp: a[i + 5], flags: a[i + 6], tgt: a[i + 7] });
    }
    this.snaps.push({ time: msg.time, units });
    if (this.snaps.length > 8) this.snaps.shift();

    let changed = false;
    for (let i = 0; i < this.cityOwner.length; i++) {
      const o = msg.c[i * 3];
      if (o !== this.cityOwner[i]) { this.cityOwner[i] = o; changed = true; }
      this.cityHp[i] = msg.c[i * 3 + 1];
      if (msg.c[i * 3 + 2] !== this.cityUpgrades[i]) {
        this.cityUpgrades[i] = msg.c[i * 3 + 2];
        this.upgradesVersion++;
      }
    }
    if (changed) this.territoryVersion++;

    this.cityShots = msg.s;
    this.gold = msg.g;
    this.honor = msg.h || 0;
    this.traditions = new Set((msg.tr || []).map((i) => TRADITION_TYPES[i]));
    this.learning = msg.tl ? { tradition: TRADITION_TYPES[msg.tl[0]], progress: msg.tl[1] } : null;
    this.learnQueue = (msg.lq || []).map((i) => TRADITION_TYPES[i]);
    if (msg.st !== undefined) this.serverTickMs = msg.st;
    this.turn = msg.turn;
    this.nextTurnAt = msg.next;
    this.research = msg.r ? { tech: TECH_TYPES[msg.r[0]], progress: msg.r[1], cost: msg.r[2] } : null;   // yours, if any
    this.researchQueue = (msg.rq || []).map(([i]) => TECH_TYPES[i]);
    this.researchQueueCosts = (msg.rq || []).map(([, cost]) => cost);     // the gold paid for each
    this.myQueues.clear();
    for (const [city, progress, queue, rx, ry, sx, sy, honorPaid] of msg.q) {
      // honorPaid: the honor paid for each queue entry (0: gold), or 0 when all of it was paid in gold.
      this.myQueues.set(city, {
        progress, queue, rally: rx == null ? null : [rx, ry], seaRally: sx == null ? null : [sx, sy],
        honorPaid: Array.isArray(honorPaid) ? honorPaid : [],
      });
    }
    this.cargo.clear();
    for (const [id, list] of msg.b || []) {
      const units = [];
      for (let i = 0; i < list.length; i += 2) units.push({ t: list[i], hp: list[i + 1] });
      this.cargo.set(id, units);
    }
    // Your ships taking units on board or landing them: where each will dock, and the shore point next to it.
    this.docks = new Map();
    const k = msg.k || [];
    for (let i = 0; i < k.length; i += 6) this.docks.set(k[i], { x: k[i + 1], y: k[i + 2], lx: k[i + 3], ly: k[i + 4], load: k[i + 5] === 0 });
    this.plans.clear();
    for (const [id, ...points] of msg.w || []) this.plans.set(id, points);
    this.landPlans.clear();
    for (const [id, x, y, ...points] of msg.wl || []) this.landPlans.set(id, { from: [x, y], points });
    for (let i = 0; i < msg.d.length; i += 4) {
      this.effects.deaths.push({ x: msg.d[i], y: msg.d[i + 1], color: this.colorOf(msg.d[i + 2]), t0: now });
    }

    // Own units are always included, so a missing id means the unit died.
    for (const id of this.selection) if (!units.has(id)) this.selection.delete(id);
    let lost = -1;
    for (const ci of this.selectedCities) {
      if (this.cityOwner[ci] !== this.you) { this.selectedCities.delete(ci); lost = ci; }
    }
    if (lost >= 0 && !this.selectedCities.size && !this.selection.size) this.inspect = { k: 'c', id: lost };

    if (this.firstSnap) {
      this.firstSnap = false;
      this.focusHome();
      this.hud.banner('Your 10 cities are scattered across Europe, marked in your colour. Press H to jump between them.', 9000);
      this.hud.feed(describeOptions(this.options));
    }
  }

  // A player's name for the feed, "Red" or "You", written in their colour.
  who(owner) {
    return colorTag(this.nameOf(owner), this.colorOf(owner));
  }

  onEvent(msg) {
    const now = performance.now();
    if (msg.kind === 'capture') {
      const city = this.map.cities[msg.city];
      this.effects.flashes.push({ city: msg.city, color: this.colorOf(msg.to), t0: now });
      const cls = msg.to === this.you ? 'good' : msg.from === this.you ? 'bad' : '';
      const from = msg.from >= 0 ? [' from ', this.who(msg.from)] : [];
      // A liberator took it (Death: Liberator), or someone pressed "Own" on it (debug builds).
      const took = msg.debug ? 'took' : msg.liberated ? 'liberated' : 'captured';
      const how = msg.debug ? ' (developer: Own)' : '';
      if (msg.to === this.you) {
        this.hud.feed([this.who(this.you), ` ${took} ${city.n}`, ...from, how], cls);
        // You took the city you were looking at: select it, so you can build there at once.
        if ((msg.liberated || msg.debug) && this.inspect?.k === 'c' && this.inspect.id === msg.city) this.selectCity(msg.city);
      } else if (msg.from === this.you) {
        playSound('city-lost');     // wherever the city is, on screen or not
        this.cityLost(msg.city, now);
        const back = [msg.refund ? `+${msg.refund} gold` : '', msg.refundHonor ? `+${msg.refundHonor} honor` : ''].filter(Boolean);
        const refund = back.length ? ` (${back.join(', ')} from its queue refunded)` : '';
        // The first time, how to get there.
        const look = this.toldLostKey ? '' : ' Shift + Space shows it.';
        this.toldLostKey = true;
        this.hud.feed([this.who(msg.to), ` ${took} your city ${city.n}!${refund}${how}${look}`], cls);
      }
      else this.hud.feed([this.who(msg.to), ` ${took} ${city.n}`, ...from, how]);
      this.regionChanged(msg);
    } else if (msg.kind === 'turn') {
      const need = this.citiesToWin(msg.turn);
      const drop = need < this.citiesToWin(msg.turn - 1) ? ` · now ${need} cities win` : '';
      const regions = msg.regionBonus ? ` (${msg.regionBonus} of it for whole regions)` : '';
      if (msg.liberator) {
        const smuggled = msg.smuggled ? ` (${msg.smuggled} of it smuggled)` : '';
        this.hud.feed(`Turn ${msg.turn} complete — +${msg.income} gold as a liberator${smuggled}${drop}`, 'good');
      } else {
        const away = msg.smuggledAway ? ` · smugglers took ${msg.smuggledAway}` : '';
        this.hud.feed(`Turn ${msg.turn} complete — your cities paid ${msg.income} gold${regions}${away}${drop}`, 'good');
      }
    } else if (msg.kind === 'eliminated') {
      this.hud.feed(msg.player === this.you ? 'You have been eliminated' : [this.who(msg.player), ' has been eliminated'], 'bad');
    } else if (msg.kind === 'influence') {
      // A liberator marked a city for liberation: everyone is told.
      const name = this.map.cities[msg.city].n, n = `(${msg.count}/${msg.limit})`;
      if (msg.player === this.you) this.hud.feed(`You are stirring up ${name} ${n}`, 'good');
      else if (this.cityOwner[msg.city] === this.you) this.hud.feed([this.who(msg.player), ` is stirring up your city ${name} ${n}!`], 'bad');
      else this.hud.feed([this.who(msg.player), ` is stirring up ${name} ${n}`]);
    } else if (msg.kind === 'board') {
      // Your units sent to a transport (only you get this).
      if (msg.reason === 'far') {
        this.hud.feed('This transport can\'t reach a beach of your units\' land from its sea', 'bad');
      } else if (msg.reason === 'full') {
        this.hud.feed('This transport is full', 'bad');
      } else if (msg.reason === 'assigned') {
        this.hud.feed('Every selected unit is already on its way to a transport. Select them again to send them elsewhere');
      } else {
        const skipped = msg.skipped ? ` · ${msg.skipped} more don't fit and stay` : '';
        this.hud.feed(`${msg.count} unit${msg.count === 1 ? ' heads' : 's head'} to the transport${skipped}`);
      }
    } else if (msg.kind === 'autoload') {
      // Autoload (L): how many of your units head to transports (only you get this).
      if (msg.reason === 'full') {
        this.hud.feed('The selected transports are full', 'bad');
      } else if (msg.reason === 'none') {
        this.hud.feed(`No idle units within ${NAVAL.autoloadRange} km of the selected transports that they can take on board`, 'bad');
      } else if (msg.reason === 'noship') {
        this.hud.feed(`No transport with room within ${NAVAL.autoboardRange} km of the selected units ` +
          '(only transports lying idle or waiting at a beach come)', 'bad');
      } else if (msg.reason === 'assigned') {
        this.hud.feed('Every selected unit is already on its way to a transport');
      } else {
        const left = msg.left ? ` · ${msg.left} more find no place and stay` : '';
        this.hud.feed(`Autoload: ${msg.count} unit${msg.count === 1 ? ' heads' : 's head'} to ` +
          `${msg.ships === 1 ? 'a transport' : `${msg.ships} transports`}${left}`);
      }
    } else if (msg.kind === 'rally') {
      // A right-click on the water with cities selected that can't send ships there.
      this.hud.feed(msg.reason === 'inland' ? 'A rally point on the water is for ships: only coastal cities have one'
        : 'Ships from these cities can\'t sail to that sea', 'bad');
    } else if (msg.kind === 'unload') {
      if (msg.reason === 'crowded') {
        this.hud.feed(`No room ashore: ${msg.left} unit${msg.left === 1 ? ' waits' : 's wait'} on board until there is space`, 'bad');
      } else {
        this.hud.feed(msg.reason === 'land' ? 'Pick a place on land or a city to land the units'
          : 'The transport can\'t reach a beach of that land from its sea', 'bad');
      }
    } else if (msg.kind === 'researched') {
      const def = TECHS[msg.tech];
      const what = msg.tech === 'seafaring' ? ': coastal cities build transports (B), and your units can go on board'
        : msg.tech === 'gunnery' ? `: coastal cities build battleships (${UNITS.battleship.hotkey})`
          : msg.tech === 'navigation' ? `: your ships sail ${TECHS.navigation.speedPercent}% faster` : '';
      this.hud.feed(`Research complete: ${def.name}${def.levels.length > 1 ? ` ${msg.level}` : ''}${what}`, 'good');
      playSound('tech-learned');
    } else if (msg.kind === 'liberator') {
      // Death: Liberator. The banner and the panel explain it to the fallen player (hud.js).
      if (msg.player === this.you) this.hud.feed('You have fallen and lost all your gold. You are now a liberator.', 'bad');
      else this.hud.feed([this.who(msg.player), ' has fallen and becomes a liberator'], 'bad');
    } else if (msg.kind === 'disconnected') {
      if (msg.player !== this.you) this.hud.feed([this.who(msg.player), ' lost connection — their empire stays until they return']);
    } else if (msg.kind === 'reconnected') {
      if (msg.player !== this.you) this.hud.feed([this.who(msg.player), ' is back']);
    } else if (msg.kind === 'hpReset') {
      this.hud.feed([this.who(msg.player), ' reset the HP of every unit and city (developer console)']);
    } else if (msg.kind === 'goldSet') {
      this.hud.feed([this.who(msg.player), ` set every player's gold to ${msg.gold.toLocaleString('en-US')} (developer console)`]);
    } else if (msg.kind === 'speedSet') {
      this.hud.feed([this.who(msg.player), ` set the game speed to ${msg.speed}× (developer console)`]);
    } else if (msg.kind === 'honorSet') {
      this.hud.feed([this.who(msg.player), ` set every player's honor to ${msg.honor.toLocaleString('en-US')} (developer console)`]);
    } else if (msg.kind === 'learned') {
      const what = msg.tradition === 'heroes' ? `: select one of your land units and press Make Hero (${HERO.cost} honor)`
        : msg.tradition === 'mercy' ? `: select one of your land units and press Make Healer (${HEALER.cost} honor)`
          : msg.tradition === 'honoredDead' ? `: each of your units that falls now gives you ${Math.round(TRADITIONS.honoredDead.lossShare * 100)}% ` +
            'of its cost in honor'
            : msg.tradition === 'brotherhood' ? `: Barracks now cost ${TRADITIONS.brotherhood.barracksHonor} honor (Shift + G) or ` +
              `gold, and build ${TRADITIONS.brotherhood.barracksBuildSpeed} times faster` : '';
      this.hud.feed(`Tradition learned: ${TRADITIONS[msg.tradition].name}${what}`, 'good');
      playSound('tradition-learned');
    } else if (msg.kind === 'ultimate') {
      // Someone (maybe you) has learned an ultimate tradition: everyone is told. (Learning it only shows
      // as its countdown in the Players list.)
      const def = TRADITIONS[msg.tradition], me = msg.player === this.you, their = me ? 'your' : 'their';
      const what = ` ${me ? 'have' : 'has'} learned ${def.name}: ${their} cities train any unit with honor`;
      this.hud.banner(`${me ? 'You' : this.nameOf(msg.player)}${what}`, 10000);
      this.hud.feed([this.who(msg.player), what], 'ultimate');
    } else if (msg.kind === 'promoted') {
      const what = msg.to === 'healer' ? `a Healer: your units within ${HEALER.radius} km heal`
        : `${heroName(HERO.kinds[msg.from], true)}: your units within ${HERO.auraRadius} km deal ` +
          `+${Math.round(HERO.auraBonus * 100)}% damage`;
      this.hud.feed(`Your ${UNITS[msg.from].name.toLowerCase()} became ${what}`, 'good');
    } else if (msg.kind === 'left') {
      // Sent before the updated player list, so the leaver's colour is still known here.
      this.hud.feed([this.who(msg.player), ' left — their cities are now neutral']);
    } else if (msg.kind === 'surrendered') {
      if (msg.player === this.you) this.hud.feed('You surrendered — your cities are now neutral', 'bad');
      else this.hud.feed([this.who(msg.player), ' surrendered — their cities are now neutral']);
    }
  }

  // A capture completed your hold on a region, or broke it: say so in the feed. A region you
  // complete also lights up on the map (render.js, REGION_GLOW), so you see which cities it is.
  regionChanged(msg) {
    const region = this.map.cities[msg.city].c;
    const before = this.cityOwner.slice(), after = this.cityOwner.slice();
    before[msg.city] = msg.from;
    after[msg.city] = msg.to;
    const had = this.regionHolder(region, before) === this.you, has = this.regionHolder(region, after) === this.you;
    if (had === has) return;
    const name = this.map.countries[region].n, count = this.regionCities[region].length;
    const each = `+${ECONOMY.regionBonusPerCity} gold per turn`;
    const fx = this.effects;
    fx.regions = fx.regions.filter((e) => e.region !== region);
    if (has) {
      const all = count > 1 ? `all ${count} cities of ${name}` : `${name}, a one-city region`;
      this.hud.feed(`You hold ${all}: ${count > 1 ? 'each pays' : 'it pays'} ${each} more`, 'good');
      fx.regions.push({ region, city: msg.city, t0: performance.now() });
    } else {
      this.hud.feed(`You no longer hold all of ${name}: its cities lose the ${each} region bonus`, 'bad');
    }
  }

  // The game is over: everyone is revealed, nicknames with colours.
  // `history`: what happened turn by turn, for the results screen (server/history.js).
  onGameOver(msg) {
    this.ended = true;
    if (msg.players) this.setPlayers(msg.players);
    this.winner = msg.winner;
    this.history = msg.history || null;
    this.hud.showGameOver(msg.winner);
  }

  // The lobby server reveals every nickname once the game is over (the host's browser never had
  // them). Shown on the game-over screen and in the Players overlay.
  onReveal(msg) {
    this.revealed = new Map(msg.players.map((p) => [p.id, p.name]));
    for (const p of this.players.values()) if (this.revealed.has(p.id)) p.name = this.revealed.get(p.id);
    this.hud.renderScores();
    if (msg.reason) {
      this.ended = true;
      this.hud.showGameOver(-1, msg.reason);
    } else if (this.ended) {
      this.hud.showGameOver(this.winner);
    }
  }

  // The link to the host broke, and no other browser took the game over (main.js waits for one first).
  onHostLost(text) {
    if (this.ended) return;
    this.ended = true;
    this.hud.showGameOver(-1, text);
  }

  // Connected to the game again: to its host after a dropped link, or to the player's browser that took
  // the game over when the host left. That one runs from the host's last checkpoint, a few seconds behind
  // what we saw: the timeline starts afresh from its snapshots.
  reconnected(link) {
    this.hostLink = link;
    this.snaps = [];
    this.offset = null;
  }

  leave() {
    this.onLeave();
  }

  // Give up but stay to watch (Leave → Surrender): the host makes our cities neutral and us a spectator.
  // Straight to the host, also during the countdown (order() would hold it back then).
  surrender() {
    if (!this.ended && !this.isOut()) this.hostLink.send({ t: 'surrender' });
  }

  // Out of the game: eliminated, or surrendered. Such a player only watches.
  isOut() {
    return !!this.players.get(this.you)?.eliminated;
  }

  // A finished duel: who has pressed Restart, from the lobby server (results.js shows it).
  onRestartVotes(msg) {
    this.restart = { votes: Array.isArray(msg.votes) ? msg.votes : [], open: !!msg.open };
    this.hud.results.renderRestart();
  }

  // Restart pressed: the lobby server starts the duel again once the other player presses it too.
  requestRestart() {
    if (!this.restart || !this.restart.open || this.restarting || this.restart.votes.includes(this.you)) return;
    this.restart.votes.push(this.you);   // shown at once; the server confirms it with restartVotes
    this.net.send({ t: 'restart' });
    this.hud.results.renderRestart();
  }

  // Both pressed Restart: the new game is on its way (main.js replaces this one when it arrives).
  onRestarting() {
    this.restarting = true;
    this.hud.results.renderRestart();
  }

  // Cities needed to win once `turn` turns are over (now, by default): the countdown lowers it.
  citiesToWin(turn = this.turn) {
    return citiesToWin(this.options, turn);
  }

  // Does the target drop by one at the end of the current turn?
  countdownRunning() {
    return this.citiesToWin(this.turn + 1) < this.citiesToWin(this.turn);
  }

  // ---------------------------------------------------------------- frame
  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const t0 = performance.now();
    this.input.update(dt);
    this.interpolate(now);
    this.spawnEffects(now);
    const t1 = performance.now();
    this.renderer.draw(now);
    const t2 = performance.now();
    this.hud.update(now);
    this.turnCountdown(now);
    if (this.viewDirty && now - this.viewSentAt > 150) this.sendView(now);
    if (this.debug) {
      const t3 = performance.now();
      this.debug.frame(now, { game: (t1 - t0) + (t3 - t2), draw: t2 - t1, server: this.serverTickMs });
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  interpolate(now) {
    if (!this.snaps.length) return;
    // Faster games send snapshots further apart in game time: the delay stretches with them.
    const rt = (this.gameClock(now) - this.offset) / 1000 - INTERP_DELAY * Math.max(1, this.timeScale);
    const snaps = this.snaps;
    let s0 = snaps[0], s1 = snaps[0];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].time <= rt) { s0 = snaps[i]; s1 = snaps[i + 1] || snaps[i]; break; }
    }
    const span = s1.time - s0.time;
    const a = span > 0 ? Math.max(0, Math.min(1, (rt - s0.time) / span)) : 1;

    const list = [];
    this.unitById.clear();
    for (const u of s1.units.values()) {
      const p = s0.units.get(u.id);
      let x = u.x, y = u.y;
      if (p && p !== u) { x = p.x + (u.x - p.x) * a; y = p.y + (u.y - p.y) * a; }
      const vx = p && p !== u ? u.x - p.x : 0;     // ships face the way they sail
      // shot: a battleship fired (flag 16) in the snapshot of that time, drawn once (spawnEffects).
      const shot = u.flags & 16 ? s1.time : 0;
      const ru = { id: u.id, t: u.t, owner: u.owner, x, y, dx: x, dy: y, vx, hp: u.hp, flags: u.flags, tgt: u.tgt, shot };
      list.push(ru);
      this.unitById.set(u.id, ru);
    }
    // Melee attackers lunge at their target.
    const tsec = now / 1000;
    for (const u of list) {
      if (!(u.flags & 1) || this.unitStats(u).attackRange > 0 || !u.tgt) continue;
      const tp = this.targetPos(u.tgt);
      if (!tp) continue;
      const dx = tp[0] - u.x, dy = tp[1] - u.y, d = Math.hypot(dx, dy) || 1;
      const lunge = Math.max(0, Math.sin(tsec * 9 + u.id)) * 1.8;
      u.dx = u.x + (dx / d) * lunge;
      u.dy = u.y + (dy / d) * lunge;
    }
    list.sort((p, q) => p.dy - q.dy);
    this.renderUnits = list;
  }

  // A unit's numbers (UNITS). A Hero has its own HP and damage but the speed and range of its kind, which
  // its snapshot flags carry (shared/protocol.js). A ship is faster while its owner has Navigation.
  unitStats(u) {
    const def = UNITS[UNIT_TYPES[u.t]];
    if (def.naval) {
      const f = shipSpeedFactor(this.players.get(u.owner)?.tech);
      return f === 1 ? def : { ...def, moveSpeed: Math.round(def.moveSpeed * f * 10) / 10 };
    }
    if (!def.hero) return def;
    const kind = UNITS[this.heroKind(u)];
    return { ...def, moveSpeed: kind.moveSpeed, attackRange: kind.attackRange };
  }

  // What a Hero was made from (HERO_KINDS: infantry, archer or cavalry).
  heroKind(u) { return HERO_KINDS[heroKindOf(u.flags)] || 'infantry'; }

  targetPos(tgt) {
    if (tgt > 0) {
      const t = this.unitById.get(tgt);
      return t ? [t.x, t.y] : null;
    }
    if (tgt < 0) {
      const c = this.map.cities[-tgt - 1];
      return c ? [c.x, c.y] : null;
    }
    return null;
  }

  spawnEffects(now) {
    const fx = this.effects;
    for (const u of this.renderUnits) {
      // Battleships fire single shots: one cannonball for each shot the host reports, none in between.
      if (u.shot && this.volleys.get(u.id) !== u.shot) {
        this.volleys.set(u.id, u.shot);
        this.cannonShot(u, now);
      }
      if (!(u.flags & 1) || !u.tgt || this.unitStats(u).reload) continue;
      const next = this.unitTimers.get(u.id) || 0;
      if (now < next) continue;
      const tp = this.targetPos(u.tgt);
      if (!tp) continue;
      if (this.unitStats(u).attackRange > 0) {
        const d = Math.hypot(tp[0] - u.x, tp[1] - u.y);
        fx.shots.push({
          x0: u.x, y0: u.y - 4, x1: tp[0] + (Math.random() - 0.5) * 4, y1: tp[1] - 3 + (Math.random() - 0.5) * 4,
          t0: now, dur: Math.max(120, d * 6), arc: d * 0.18, city: false,
        });
        this.unitTimers.set(u.id, now + 650 + Math.random() * 300);
      } else {
        fx.sparks.push({
          x: (u.x + tp[0]) / 2 + (Math.random() - 0.5) * 4, y: (u.y + tp[1]) / 2 - 3 + (Math.random() - 0.5) * 4,
          t0: now, rot: Math.random() * Math.PI,
        });
        this.unitTimers.set(u.id, now + 300 + Math.random() * 350);
      }
    }
    const s = this.cityShots;
    for (let i = 0; i < s.length; i += 2) {
      const ci = s[i];
      const next = this.cityTimers.get(ci) || 0;
      if (now < next) continue;
      const t = this.unitById.get(s[i + 1]);
      if (!t) continue;
      const c = this.map.cities[ci];
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      fx.shots.push({ x0: c.x, y0: c.y - 14, x1: t.x, y1: t.y - 3, t0: now, dur: Math.max(140, d * 5), arc: d * 0.25, city: true });
      this.cityTimers.set(ci, now + 450 + Math.random() * 150);
    }

    if (this.unitTimers.size > 4000) {
      for (const id of this.unitTimers.keys()) if (!this.unitById.has(id)) this.unitTimers.delete(id);
    }
    if (this.volleys.size > 500) {
      for (const id of this.volleys.keys()) if (!this.unitById.has(id)) this.volleys.delete(id);
    }
    const alive = (arr, life) => arr.filter((e) => now - e.t0 < (e.dur || life));
    fx.shots = alive(fx.shots, 1000);
    fx.blasts = alive(fx.blasts, 700);
    fx.sparks = alive(fx.sparks, 260);
    fx.deaths = alive(fx.deaths, 900);
    fx.markers = alive(fx.markers, 550);
    fx.flashes = alive(fx.flashes, 1600);
    fx.regions = alive(fx.regions, REGION_GLOW.ms);
    fx.lost = alive(fx.lost, LOST_PING.ms);
  }

  // A battleship's shot at its target: smoke at its guns, a cannonball flying in an arc, and where it
  // lands a splash (on a ship) or a burst of fire and dust (on land).
  cannonShot(u, now) {
    const tp = this.targetPos(u.tgt);
    if (!tp) return;
    const fx = this.effects;
    const dx = tp[0] - u.x, dy = tp[1] - u.y, d = Math.hypot(dx, dy) || 1;
    const x0 = u.x + (dx / d) * 4, y0 = u.y - 3;                     // its side facing the target
    const x1 = tp[0] + (Math.random() - 0.5) * 5, y1 = tp[1] - 2 + (Math.random() - 0.5) * 4;
    const dur = Math.max(220, d * 7);
    const target = u.tgt > 0 ? this.unitById.get(u.tgt) : null;
    fx.shots.push({ x0, y0, x1, y1, t0: now, dur, arc: d * 0.22, cannon: true });
    fx.blasts.push({ x: x0, y: y0, t0: now, dur: 650, kind: 'muzzle' });
    fx.blasts.push({ x: x1, y: y1, t0: now + dur, dur: 600, kind: target && this.isNaval(target.t) ? 'splash' : 'hit' });
  }

  // One of your cities was captured, wherever it is: it pings on the minimap (render.js drawLostPing),
  // whose frame glows red, and Shift + Space now shows it.
  cityLost(ci, now) {
    this.lostCity = ci;
    const fx = this.effects;
    fx.lost = fx.lost.filter((e) => e.city !== ci);
    fx.lost.push({ city: ci, t0: now });
    this.renderer.alertMinimap();
  }

  // Shift + Space: the camera goes to your city captured last, and a red ring flashes on it.
  showLostCity() {
    const ci = this.lostCity;
    if (ci < 0) {
      this.hud.feed('None of your cities has been captured yet');
      return;
    }
    const c = this.map.cities[ci];
    this.input.centerOn(c.x, c.y);
    this.effects.flashes.push({ city: ci, color: '#ff4a3a', t0: performance.now() });
  }

  // ---------------------------------------------------------------- view
  viewChanged() {
    this.viewDirty = true;
  }

  sendView(now) {
    this.viewDirty = false;
    this.viewSentAt = now;
    const v = this.renderer.viewRect();
    const r = (x) => Math.round(x);
    this.link.send({ t: 'view', x0: r(v.x0), y0: r(v.y0), x1: r(v.x1), y1: r(v.y1) });
  }

  // City stats including its upgrades.
  cityBonus(ci, stat) {
    let sum = 0;
    UPGRADE_TYPES.forEach((key, i) => { if (this.cityUpgrades[ci] & (1 << i)) sum += CITY_UPGRADES[key][stat] || 0; });
    return sum;
  }
  cityMaxHp(ci) { return CITY.hp + this.cityBonus(ci, 'hp'); }
  cityDamage(ci) { return CITY.damage + this.cityBonus(ci, 'damage'); }
  cityRange(ci) { return CITY.attackRange * (1 + this.cityBonus(ci, 'rangePercent') / 100); }
  cityIncome(ci) {
    return ECONOMY.goldPerCityPerTurn + this.cityBonus(ci, 'goldPerTurn') + (this.cityHasRegionBonus(ci) ? ECONOMY.regionBonusPerCity : 0);
  }
  // The player who holds every city of a region, or -1. `owners`: city owners to use instead
  // of the current ones (a capture event arrives before the snapshot that shows it).
  regionHolder(region, owners = this.cityOwner) {
    return regionHolder(this.regionCities[region], (i) => owners[i]);
  }
  // Does the city's owner hold its whole region (so it pays ECONOMY.regionBonusPerCity more)?
  cityHasRegionBonus(ci) {
    const o = this.cityOwner[ci];
    return o >= 0 && this.regionHolder(this.map.cities[ci].c) === o;
  }
  // Units train this many times faster here (Barracks); upgrades always build at normal speed.
  cityTrainRate(ci) { return 1 + this.cityBonus(ci, 'trainSpeedPercent') / 100; }

  // Gold all your cities will pay at the end of the turn (Farms included). A liberator gets a fixed amount.
  myIncome() {
    return this.incomes().get(this.you) || 0;
  }

  // Smuggling at the end of this turn, exactly as the host will count it (shared/tech.js).
  smuggling() {
    const smugglers = [...this.players.values()].filter((p) => p.liberator && p.smuggle?.length)
      .map((p) => ({ id: p.id, tech: p.tech, cities: p.smuggle }));
    return smugglingFlows(smugglers, (ci) => this.cityOwner[ci], (ci) => this.cityIncome(ci));
  }

  // Gold every player's cities pay at the end of the turn (Farms included), by player id.
  // City owners and upgrades of the whole map are in every snapshot, so this is known for everyone.
  // Yours is scaled by your gold percentage, as the host pays it; the others' gold percentages are
  // secret, so theirs are shown as their cities pay it.
  incomes() {
    const out = new Map();
    for (let i = 0; i < this.cityOwner.length; i++) {
      const o = this.cityOwner[i];
      if (o >= 0) out.set(o, (out.get(o) || 0) + this.cityIncome(i));
    }
    const flows = this.smuggling();
    for (const [id, gold] of flows.loss) out.set(id, (out.get(id) || 0) - gold);
    for (const p of this.players.values()) {
      if (p.liberator) out.set(p.id, liberatorIncome(p.tech) + (flows.gain.get(p.id) || 0));
    }
    if (out.has(this.you)) out.set(this.you, scaleGoldWhole(out.get(this.you), this.goldPercent));
    return out;
  }

  // ---------------------------------------------------------------- liberators (Death: Liberator)
  // Are you a liberator, i.e. fallen in a game where the fallen take cities back?
  isLiberator() {
    return !this.ended && this.options.death === 'liberator' && !!this.players.get(this.you)?.liberator;
  }

  myTech() {
    return this.players.get(this.you)?.tech || {};
  }

  // Seafaring (Tech, Sea tab): transports, boarding and landing. The feed says so when it is missing.
  hasSeafaring(tell = false) {
    const ok = hasSeafaring(this.myTech());
    if (!ok && tell) this.hud.feed(`Ships need ${TECHS.seafaring.name}: research it in the Tech window (T), Sea tab`, 'bad');
    return ok;
  }

  // May your cities train this unit type: its technology (UNITS `tech`: transports Seafaring, battleships
  // Gunnery) is researched? The feed says which one is missing.
  canTrain(type, tell = false) {
    const ok = canTrain(type, this.myTech());
    const need = UNITS[type]?.tech;
    if (!ok && tell) {
      const tab = TECHS[need].tab === 'sea' ? 'Sea' : 'Rebellion';
      this.hud.feed(`${UNITS[type].name} needs ${TECHS[need].name}: research it in the Tech window (T), ${tab} tab`, 'bad');
    }
    return ok;
  }

  // Cities you have marked for liberation, and how many you may mark before they are all liberated.
  myInfluence() { return this.players.get(this.you)?.influence || []; }
  influenceLimit() { return influenceLimit(this.myTech()); }
  // Cities you smuggle from, and how many you may (Smuggling level).
  mySmuggle() { return this.players.get(this.you)?.smuggle || []; }
  smugglingLimit() { return smugglingLimit(this.myTech()); }

  // Turns until you may mark another city (0: now): one mark per turn, and a wait after a
  // liberation. Counted on the turn counter, like the host does.
  influenceWait() {
    const me = this.players.get(this.you);
    return Math.max(0, Math.max(me?.liberateAt || 0, me?.influenceAt || 0) - (this.turn || 0));
  }

  // Cities the player holds right now (from the latest snapshot).
  cityCountOf(owner) {
    let n = 0;
    for (const o of this.cityOwner) if (o === owner) n++;
    return n;
  }

  // A liberator can't take a city from a player with LIBERATOR.protectedCities cities or fewer.
  cityProtected(ci) {
    const o = this.cityOwner[ci];
    return o >= 0 && this.cityCountOf(o) <= LIBERATOR.protectedCities;
  }

  // Mark a city for liberation (without Influencer this takes it at once). The host checks that you may.
  influence(ci) {
    if (!this.isLiberator() || this.influenceWait() > 0 || this.cityOwner[ci] === this.you || this.cityProtected(ci)) return;
    if (this.myInfluence().includes(ci) || this.otherMark('influence', ci) >= 0) return;
    this.link.send({ t: 'influence', city: ci });
  }

  // Liberate every city you have marked, now.
  liberateNow() {
    if (this.isLiberator() && this.myInfluence().length) this.link.send({ t: 'liberate' });
  }

  // "Own" (debug builds): the city becomes yours at once. The host ignores it outside debug builds.
  canTakeCity(ci) {
    return this.cityOwner[ci] !== this.you && !this.ended && !this.players.get(this.you)?.eliminated;
  }

  takeCity(ci) {
    if (this.canTakeCity(ci)) this.link.send({ t: 'takeCity', city: ci });
  }

  // Start or stop smuggling from a city (its mark is separate from influence marks).
  toggleSmuggling(ci) {
    if (this.isLiberator() && this.otherMark('smuggle', ci) < 0) this.link.send({ t: 'smuggle', city: ci });
  }

  // Another liberator who already has this kind of mark ('influence' or 'smuggle') on the city, or -1.
  // A city carries at most one mark of each kind.
  otherMark(kind, ci) {
    const ids = this.marks?.[kind].get(ci) || [];
    const other = ids.find((id) => id !== this.you);
    return other === undefined ? -1 : other;
  }

  // Technologies (Tech window).
  // Research (or queue, while one runs) the next level of `key` not yet planned.
  startResearch(key) { this.link.send({ t: 'research', tech: key }); }
  // Cancels that level of `key`, running or queued, and the higher levels of it queued after it.
  cancelResearch(key, level) { this.link.send({ t: 'cancelResearch', tech: key, level }); }
  // The research running and the queue after it, in order: [{ tech, level, cost }] (cost: the gold paid,
  // what cancelling gives back).
  researchPlan() {
    const levels = { ...this.myTech() };
    const keys = this.research ? [this.research.tech, ...this.researchQueue] : [];
    const costs = this.research ? [this.research.cost, ...(this.researchQueueCosts || [])] : [];
    return keys.map((tech, i) => ({ tech, level: levels[tech] = (levels[tech] || 0) + 1, cost: costs[i] ?? 0 }));
  }
  // The level of `key` once the research running and the queue are done.
  plannedTechLevel(key) {
    return this.researchPlan().reduce((n, e) => (e.tech === key ? Math.max(n, e.level) : n), this.myTech()[key] || 0);
  }

  // ---------------------------------------------------------------- honor (Honor window, Heroes)
  hasTradition(key) { return this.traditions.has(key); }
  // Seconds an upgrade takes to build: Barracks build barracksBuildSpeed times faster with Brotherhood of Arms.
  upgradeBuildTime(def) {
    const fast = def === CITY_UPGRADES.barracks && this.hasTradition('brotherhood');
    return fast ? def.buildTime / TRADITIONS.brotherhood.barracksBuildSpeed : def.buildTime;
  }
  // Learn `key`, or queue it while another is learned.
  startLearning(key) { this.link.send({ t: 'learn', tradition: key }); }
  // Cancels `key`, being learned or queued (a tier I one takes the queued tier II ones with it).
  cancelLearning(key) { this.link.send({ t: 'cancelLearn', tradition: key }); }
  // Learned, being learned or queued?
  plansTradition(key) {
    return this.hasTradition(key) || this.learning?.tradition === key || this.learnQueue.includes(key);
  }

  isHealer(t) { return !!UNITS[UNIT_TYPES[t]]?.healer; }
  // Made from another unit (Hero, Healer): can't be made one again.
  isPromoted(t) { return !!UNITS[UNIT_TYPES[t]]?.promoted; }

  // Your selected plain land units: the ones that could be made a Hero or a Healer (not disbanding).
  promotionCandidates() {
    return this.selectedLandUnits().filter((id) => !this.isPromoted(this.unitById.get(id).t));
  }

  // Make Hero / Make Healer (`to`): the one selected plain land unit becomes a Hero (tradition Cult of
  // Heroes, HERO.cost honor) or a Healer (Order of Mercy, HEALER.cost honor).
  promote(to = 'hero') {
    const ids = this.promotionCandidates();
    const rule = to === 'healer' ? { tradition: 'mercy', cost: HEALER.cost } : { tradition: 'heroes', cost: HERO.cost };
    const name = UNITS[to].name;
    if (!this.hasTradition(rule.tradition)) {
      this.hud.feed(`${name}s need the tradition ${TRADITIONS[rule.tradition].name}: learn it in the Honor window (O)`, 'bad');
    } else if (ids.length !== 1) {
      this.hud.feed(`Select a single land unit to make it a ${name}`, 'bad');
    } else if (this.honor < rule.cost) {
      this.hud.feed(`A ${name} costs ${rule.cost} honor: you have ${this.honor}`, 'bad');
    } else {
      this.link.send({ t: 'promote', id: ids[0], ...(to === 'healer' ? { to } : {}) });
    }
  }

  // The game balance changed (already applied to the config by main.js): redraw everything
  // that shows stats, costs or build times.
  onBalance(msg) {
    this.admin = !!msg.admin;
    if (!this.admin) this.setMapEdit(false);
    this.hud.balanceChanged(msg.changed);
  }

  // ---------------------------------------------------------------- map editing (admins)
  // Edit map mode: cities and region names can be dragged to new places. The server checks admin rights again.
  setMapEdit(on) {
    if (!on && this.mapEdit && this.input) this.input.flushLabelWheel();   // a name being resized is kept
    this.mapEdit = !!on && this.admin;
    if (!this.mapEdit && this.input) {
      this.input.cityDrag = null;
      if (this.input.labelDrag) { this.input.labelDrag = null; this.onLabelEdit(); }   // back where it was
      this.input.hoverLabel = -1;
    }
    if (!this.mapEdit) this.brush = null;
    this.hud?.mapEditChanged();
  }

  // Edit map: the brush. 'beach-add' paints beaches, 'beach-del' erases them (cliffs), 'mountain-add'
  // paints mountains, 'mountain-del' clears them; null drags cities. Pressing the active one again turns
  // it off.
  setBrush(mode) {
    this.brush = this.mapEdit && mode !== this.brush ? mode : null;
    this.hud?.mapEditChanged();
  }

  // One brush stroke (points in map km, radius r km). The server works out the cells, saves them, and
  // tells every browser: game hosts apply them (beaches go to their players with the ports), and every
  // page draws the new mountains.
  paintStroke(pts, r) {
    if (!this.admin || !this.mapEdit || !this.brush || !pts.length) return;
    const [kind, op] = this.brush.split('-');
    this.net.send({ t: kind === 'mountain' ? 'mapMountain' : 'mapBeach', pts, r: Math.round(r * 10) / 10, on: op === 'add' });
  }

  // Mountains were painted on or off (main.js has put them into the map): draw them anew.
  onMountainEdit() {
    this.renderer.mountainsChanged();
  }

  // Edit map: region `region`'s name put at (edit.x, edit.y), its centre in map units, edit.scale times its own
  // size; or given back to automatic placing (edit null). Shown at once; unless `send` is false (a resize
  // still going on) the server saves it and tells everyone.
  editLabel(region, edit, send = true) {
    if (!this.admin || !this.mapEdit || !this.map.countries[region]) return;
    const name = this.map.countries[region].n;
    this.map.labelEdits = this.map.labelEdits || {};
    if (edit) this.map.labelEdits[name] = edit;
    else delete this.map.labelEdits[name];
    this.onLabelEdit();
    if (send) this.net.send(edit ? { t: 'mapLabel', region, ...edit } : { t: 'mapLabel', region, reset: true });
  }

  // A region's name was moved or resized (main.js has put it into the map): place the names anew.
  onLabelEdit() {
    this.renderer.placeCountryLabels(this.map);
    this.renderer.mapKey = '';
  }

  // Drop of a dragged city. Shown at once; the server answers with the final place (snapped onto
  // land) or puts it back.
  moveCity(ci, x, y) {
    const c = this.map.cities[ci];
    c.x = Math.round(x * 10) / 10;
    c.y = Math.round(y * 10) / 10;
    this.net.send({ t: 'mapMove', city: ci, x: c.x, y: c.y });
  }

  rebuildMap() {
    if (this.admin) this.net.send({ t: 'mapRebuild' });
  }

  // Edit map: make a city coastal (it builds ships) or inland. The server checks admin rights again.
  setCoastal(ci, coastal) {
    if (this.admin && this.mapEdit) this.net.send({ t: 'mapCoast', city: ci, coastal });
  }

  // An admin changed whether a city is coastal (main.js already updated map.cities). The new ports
  // come from the game's host; until then the panel shows who set it.
  onCityCoast(msg) {
    this.hud.feed(`Map edit: ${this.map.cities[msg.city].n} is now ${msg.on ? 'coastal' : 'inland'}`);
  }

  // A city moved (main.js already updated map.cities). Cities are drawn from the map every frame;
  // territories follow on the next rebuild. Country names make room for it at once.
  onCityMoved() {
    this.renderer.placeCountryLabels(this.map);
    this.renderer.mapKey = '';
  }

  onMapState(msg) {
    this.mapState = msg;
    this.hud.mapEditChanged();
  }

  // New territories and borders: rebuild the cached map paths and layers.
  onMapRebuilt() {
    this.renderer.buildPaths(this.map);
    this.renderer.mapKey = '';
    this.renderer.miniVersion = -1;
    this.territoryVersion++;
    if (this.debug && this.debug.mapChanged) this.debug.mapChanged();
    this.hud.feed('Map rebuilt: territories and navigation updated', 'good');
  }

  // Seconds until the next turn pays out, from the server clock estimate.
  secondsToNextTurn(now = performance.now()) {
    if (this.prestart && this.nextTurnAt != null) return this.nextTurnAt - this.snapTime;   // stopped until the start
    if (this.offset === null || this.nextTurnAt == null) return null;
    return Math.max(0, this.nextTurnAt - (this.gameClock(now) - this.offset) / 1000);
  }

  // A clock tick as the countdown reaches 3, 2 and 1 seconds, the moments the top bar shows them.
  // Only when the count goes down, so a clock correction can't tick a second twice. Nothing for
  // a player out of the game: the turn pays them nothing.
  turnCountdown(now) {
    const left = this.secondsToNextTurn(now);
    const s = left === null ? null : Math.ceil(left);
    const prev = this.turnSecond;
    this.turnSecond = s;
    if (s === null || prev === null || s >= prev || s < 1 || s > TICK_SECONDS) return;
    if (this.ended || this.players.get(this.you)?.eliminated) return;
    playSound('tick');
  }

  myCities() {
    const out = [];
    for (let i = 0; i < this.cityOwner.length; i++) if (this.cityOwner[i] === this.you) out.push(i);
    return out;
  }

  myCityCount() {
    let n = 0;
    for (let i = 0; i < this.cityOwner.length; i++) if (this.cityOwner[i] === this.you) n++;
    return n;
  }

  // Your units, counting the ones on board your transports.
  ownUnitCount() {
    let n = 0;
    for (const u of this.renderUnits) if (u.owner === this.you) n += 1 + (u.flags >> CARGO_SHIFT);
    return n;
  }

  focusHome() {
    const mine = this.myCities();
    if (!mine.length) return;
    let cx = 0, cy = 0;
    for (const i of mine) { cx += this.map.cities[i].x; cy += this.map.cities[i].y; }
    cx /= mine.length; cy /= mine.length;
    let best = mine[0], bd = Infinity;
    for (const i of mine) {
      const c = this.map.cities[i];
      const d = Math.hypot(c.x - cx, c.y - cy);
      if (d < bd) { bd = d; best = i; }
    }
    this.cam.zoom = 1.1;
    const c = this.map.cities[best];
    this.input.centerOn(c.x, c.y);
  }

  centerOnSelection() {
    if (this.selection.size) {
      let x = 0, y = 0, n = 0;
      for (const id of this.selection) {
        const u = this.unitById.get(id);
        if (u) { x += u.x; y += u.y; n++; }
      }
      if (n) this.input.centerOn(x / n, y / n);
    } else if (this.selectedCities.size) {
      let x = 0, y = 0;
      for (const ci of this.selectedCities) { x += this.map.cities[ci].x; y += this.map.cities[ci].y; }
      this.input.centerOn(x / this.selectedCities.size, y / this.selectedCities.size);
    }
  }

  // ---------------------------------------------------------------- selection
  // The single selected city, or -1 when none or several are selected.
  get selectedCity() {
    return this.selectedCities.size === 1 ? this.selectedCities.values().next().value : -1;
  }

  select(ids, add) {
    this.selectionVersion++;
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    if (this.selection.size) { this.selectedCities.clear(); this.inspect = null; }
  }

  deselect(id) {
    this.selectionVersion++;
    this.selection.delete(id);
  }

  // Select one of your cities; with `add` (Shift) toggle it in the current city selection.
  selectCity(ci, add = false) {
    this.selectionVersion++;
    this.selection.clear();
    this.inspect = null;
    if (!add) this.selectedCities.clear();
    if (add && this.selectedCities.has(ci)) this.selectedCities.delete(ci);
    else this.selectedCities.add(ci);
  }

  selectCities(ids, add = false) {
    this.selectionVersion++;
    this.selection.clear();
    this.inspect = null;
    if (!add) this.selectedCities.clear();
    for (const ci of ids) this.selectedCities.add(ci);
  }

  inspectThing(thing) {
    this.selectionVersion++;
    this.selection.clear();
    this.selectedCities.clear();
    this.inspect = thing;
  }

  clearSelection() {
    this.selectionVersion++;
    this.selection.clear();
    this.selectedCities.clear();
    this.inspect = null;
  }

  // ---------------------------------------------------------------- commands
  marker(x, y, color) {
    this.effects.markers.push({ x, y, color, t0: performance.now() });
  }

  // `queue` (Shift held): the units do it after the orders they already have, one after another.
  // `facing`: the way their formation faces there, in radians (the right button dragged); null: the way they go.
  commandMove(x, y, amove, queue = false, facing = null) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.boardRound = -1;
    this.link.send({
      t: 'move', ids, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, amove: !!amove, ...(queue ? { queue: true } : {}),
      ...(Number.isFinite(facing) ? { f: Math.round(facing * 1000) / 1000 } : {}),
    });
    this.marker(x, y, amove ? '#ff9a3c' : '#9dff6a');
  }

  // Where your selected units would go for a move to (x, y) (commandMove): [{ u, x, y }], for the grey
  // ghosts shown while the right button is held. The formations are laid out as the host lays them out
  // (shared/formation.js), and grouped the same way: land units in one (with Shift, those busy with orders in
  // another, from where their orders end), ships in another. The page
  // doesn't know the land grid: a place that falls in the sea or the mountains (which the host moves to
  // open ground near it) is shown where the formation puts it. Transports that will land their units
  // (a move onto land) are left out.
  formationPreview(x, y, facing = null, queue = false) {
    const units = [...this.selection].map((id) => this.unitById.get(id)).filter((u) => u && u.owner === this.you);
    const role = (u) => formationRole(UNIT_TYPES[u.t], this.heroKind(u));
    const end = (u) => {
      const p = queue ? this.plans.get(u.id) : null;
      return p && p.length >= 3 ? [p[p.length - 2], p[p.length - 1]] : [u.x, u.y];
    };
    const out = [];
    const add = (group, spacing) => {
      for (const [u, [px, py]] of formationSlots(group, x, y, { spacing, facing, pos: end, role })) out.push({ u, x: px, y: py });
    };
    const land = units.filter((u) => !this.isNaval(u.t));
    const onLand = this.renderer.isLand(x, y);
    const ships = units.filter((u) => this.isNaval(u.t) && !(onLand && u.flags >> CARGO_SHIFT && hasSeafaring(this.myTech())));
    const later = queue ? land.filter((u) => this.plans.has(u.id) || u.flags & 3) : [];   // queued orders, moving or attacking
    add(later, GAME.formationSpacing);
    add(land.filter((u) => !later.includes(u)), GAME.formationSpacing);
    add(ships, SHIP_SPACING);
    return out;
  }

  commandAttack(k, id, x, y, queue = false) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.boardRound = -1;
    this.link.send({ t: 'attack', ids, k, id, ...(queue ? { queue: true } : {}) });
    this.marker(x, y, '#ff4a3a');
  }

  // S key: the selected units stop.
  commandStop() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.boardRound = -1;
    this.link.send({ t: 'stop', ids });
  }

  // H key: the selected units stand where they are until their next move, attack or stop order.
  commandHold() {
    const ids = [...this.selection].filter((id) => this.unitById.get(id)?.owner === this.you);
    if (!ids.length) return;
    this.boardRound = -1;
    this.link.send({ t: 'hold', ids });
    this.hud.feed(`${ids.length} unit${ids.length === 1 ? ' holds' : 's hold'} position`);
  }

  // Delete key: the selected units lose HP until they die. Cities are never disbanded.
  commandDisband() {
    const ids = [...this.selection].filter((id) => {
      const u = this.unitById.get(id);
      return u && u.owner === this.you && !(u.flags & 4);
    });
    if (!ids.length) return;
    this.boardRound = -1;
    this.link.send({ t: 'disband', ids });
    const aboard = ids.reduce((n, id) => n + (this.unitById.get(id).flags >> CARGO_SHIFT), 0);
    this.hud.feed(`${ids.length} unit${ids.length === 1 ? ' is' : 's are'} disbanding` +
      (aboard ? ` — the ${aboard} on board will sink with ${ids.length === 1 ? 'it' : 'them'}` : ''), aboard ? 'bad' : '');
  }

  // ---------------------------------------------------------------- navy
  // Your selected land units that could go on board (not the ones disbanding).
  selectedLandUnits() {
    return [...this.selection].filter((id) => {
      const u = this.unitById.get(id);
      return u && u.owner === this.you && !this.isNaval(u.t) && !(u.flags & 4);
    });
  }

  // Ctrl + B (ships = false): the selection without its ships. Shift + B (ships = true): only its
  // ships. A selection that would end up empty is kept as it is.
  filterSelection(ships) {
    const ids = [...this.selection].filter((id) => {
      const u = this.unitById.get(id);
      return u && this.isNaval(u.t) === ships;
    });
    if (ids.length === this.selection.size) return;
    if (!ids.length) {
      this.hud.feed(ships ? 'No ships in the selection' : 'Only ships are selected');
      return;
    }
    this.select(ids, false);
  }

  // Ctrl + F (full = false): the selection without its full transports. Shift + F (full = true): only
  // its full transports. A selection that would end up empty is kept as it is.
  filterFull(full) {
    const isFull = (u) => {
      const cap = UNITS[UNIT_TYPES[u.t]].capacity;
      return cap > 0 && u.flags >> CARGO_SHIFT >= cap;
    };
    const ids = [...this.selection].filter((id) => {
      const u = this.unitById.get(id);
      return u && isFull(u) === full;
    });
    if (ids.length === this.selection.size) return;
    if (!ids.length) {
      this.hud.feed(full ? 'No full transports in the selection' : 'Only full transports are selected');
      return;
    }
    this.select(ids, false);
  }

  // Your selected transports, and the ones with units on board.
  selectedTransports(loaded = false) {
    return [...this.selection].filter((id) => {
      const u = this.unitById.get(id);
      return u && u.owner === this.you && UNITS[UNIT_TYPES[u.t]].capacity > 0 && (!loaded || u.flags >> CARGO_SHIFT > 0);
    });
  }

  // Right-click on your transport with units selected: the transport sails to their shore and they
  // come on board (the host sends only the units that fit, and tells how many go). Transports clicked
  // one after another with the same selection share it out: units already sent to one keep going
  // there (`keep`). A new selection, or any other order in between, lets every selected unit go.
  commandBoard(ship) {
    const ids = this.selectedLandUnits();
    if (!ids.length || !this.hasSeafaring(true)) return;
    if (ship.flags >> CARGO_SHIFT >= UNITS[UNIT_TYPES[ship.t]].capacity) {
      this.hud.feed('This transport is full', 'bad');
      return;
    }
    const keep = this.boardRound === this.selectionVersion;
    this.boardRound = this.selectionVersion;
    this.link.send({ t: 'board', ship: ship.id, ids, keep });
    this.marker(ship.x, ship.y, '#7fd8ff');
  }

  // Autoload (L, the Autoload and Board buttons), each unit to the nearest transport with room: selected land
  // units find your transports around them (within NAVAL.autoboardRange), whatever transports are selected
  // with them; selected transports alone take your idle land units around them (within NAVAL.autoloadRange).
  // The host says how many go.
  commandAutoload() {
    const land = this.selectedLandUnits(), ships = land.length ? [] : this.selectedTransports();
    if ((!ships.length && !land.length) || !this.hasSeafaring(true)) return;
    this.boardRound = -1;
    this.link.send({ t: 'autoload', ids: land.length ? land : ships });
    for (const id of ships) {
      const u = this.unitById.get(id);
      if (u) this.marker(u.x, u.y, '#7fd8ff');
    }
  }

  // Unload button (U): the next click on land or a city picks where the units go ashore.
  startUnload() {
    if (!this.hasSeafaring(true)) return;
    if (!this.selectedTransports(true).length) {
      this.hud.feed('No units on board the selected transports', 'bad');
      return;
    }
    this.input.setTargetMode('unload');
    this.hud.banner('Unload: click any land or city. The transport lands its units on the nearest coast and ' +
      'they march there. Right-click or Esc cancels.', 6000);
  }

  // The transports sail to the coast nearest to (x, y) (or to the city), land their units and send
  // them there; to attack, when it is an enemy city.
  commandUnload(x, y, city) {
    const ids = this.selectedTransports(true);
    if (!ids.length) return;
    this.link.send({ t: 'unload', ids, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, city });
    const enemy = city >= 0 && this.cityOwner[city] !== this.you;
    this.marker(x, y, enemy ? '#ff4a3a' : '#7fd8ff');
  }

  // Upgrade already built in a city, or waiting in its production queue.
  hasUpgrade(ci, key) {
    return !!(this.cityUpgrades[ci] & (1 << UPGRADE_TYPES.indexOf(key)));
  }
  upgradeQueued(ci, key) {
    const q = this.myQueues.get(ci);
    return !!q && q.queue.includes(PRODUCTION_ITEMS.indexOf(key));
  }
  // The grade of an upgrade an order queues in a city ('wall2' once a Wall I is built or queued),
  // or null when every grade is built or queued. As the host decides (City.nextUpgrade).
  nextUpgrade(ci, key) {
    return nextGrade(key, (k) => this.hasUpgrade(ci, k) || this.upgradeQueued(ci, k));
  }

  // Queue one unit or upgrade (`item`) in every selected city, as far as the gold reaches.
  // An upgrade queues its next grade in each city and is skipped where every grade is built or
  // queued; ships are built only in coastal cities. `honor`: paid with honor instead of gold, as far as
  // the honor reaches (honorPrice: Barracks with Brotherhood of Arms, units with Eternal Glory).
  build(item, honor = false) {
    let cities = [...this.selectedCities].filter((ci) => this.cityOwner[ci] === this.you);
    if (!cities.length) return;
    if (honor && this.honorPrice(item) === null) return;
    if (!this.canTrain(item, true)) return;
    if (UNITS[item]?.naval) {
      cities = cities.filter((ci) => this.isCoastal(ci));
      if (!cities.length) {
        this.hud.feed('Ships are built only in coastal cities (marked with an anchor)', 'bad');
        return;
      }
    }
    const isUpgrade = !!CITY_UPGRADES[item];
    const defOf = (key) => UNITS[key] || CITY_UPGRADES[key];
    const queued = [];       // [city, what it queues]: an upgrade's grade can differ from city to city
    // What is spent: gold, or honor for honor Barracks. priceOf(def) is what one costs in it.
    const money = honor ? 'honor' : 'gold';
    const priceOf = (key) => (honor ? this.honorPrice(key) : defOf(key).cost);
    let left = honor ? this.honor : this.gold, full = 0, done = 0, short = null;
    for (const ci of cities) {
      const q = this.myQueues.get(ci);
      if (q && q.queue.length >= ECONOMY.maxQueue) { full++; continue; }
      const key = isUpgrade ? this.nextUpgrade(ci, item) : item;
      if (!key) { done++; continue; }
      const price = priceOf(key);
      if (left < price) { short ||= key; continue; }
      left -= price;
      queued.push([ci, key]);
    }
    // Units are named in lower case inside a sentence ("not enough gold for infantry"), upgrades not ("Wall II").
    const inText = (def) => (isUpgrade ? def.name : def.name.toLowerCase());
    if (!queued.length) {
      const top = defOf(isUpgrade ? upgradeGrades(item).at(-1) : item);
      const msg = done === cities.length ? `${top.name} is already built or on its way`
        : full + done === cities.length ? 'Production queue is full'
          : `Not enough ${money} for ${inText(defOf(short))} (${priceOf(short)})`;
      this.hud.feed(msg, 'bad');
      return;
    }
    this.link.send({ t: 'build', cities: queued.map(([ci]) => ci), item, ...(honor ? { honor: true } : {}) });
    // Optimistic update so rapid key presses reflect immediately; the next snapshot corrects it.
    if (honor) this.honor = left;
    else this.gold = left;
    for (const [ci, key] of queued) {
      const entry = this.myQueues.get(ci) || { progress: 0, queue: [], rally: null, seaRally: null, honorPaid: [] };
      const paid = entry.queue.map((_, i) => entry.honorPaid[i] || 0);
      entry.queue = entry.queue.concat([PRODUCTION_ITEMS.indexOf(key)]);
      entry.honorPaid = paid.concat([honor ? priceOf(key) : 0]);
      this.myQueues.set(ci, entry);
    }
    if (cities.length > 1 && queued.length + done < cities.length) {
      const names = [...new Set(queued.map(([, key]) => defOf(key).name))].join(' / ');
      this.hud.feed(`${names} queued in ${queued.length} of ${cities.length} cities` +
        (queued.length + full + done < cities.length ? ` — not enough ${money} for the rest` : ''), 'bad');
    }
  }

  cancel(ci, index) {
    this.link.send({ t: 'cancel', city: ci, index });
  }

  // C with cities selected: cancel the last unit or upgrade in each selected city's queue, refunded.
  cancelLast() {
    const owned = [...this.selectedCities].filter((ci) => this.cityOwner[ci] === this.you);
    if (!owned.length) return;
    const cities = owned.filter((ci) => this.myQueues.get(ci)?.queue.length);
    if (!cities.length) {
      this.hud.feed(owned.length > 1 ? 'Nothing queued in the selected cities' : 'Nothing queued to cancel', 'bad');
      return;
    }
    this.link.send({ t: 'cancel', cities, last: true });
    // Optimistic update, as in build(), so rapid presses show at once; the next snapshot corrects it.
    for (const ci of cities) {
      const entry = this.myQueues.get(ci);
      const last = entry.queue.length - 1;
      const key = PRODUCTION_ITEMS[entry.queue[last]];
      const paidHonor = entry.honorPaid?.[last] || 0;
      if (paidHonor) this.honor += paidHonor;
      else this.gold += (UNITS[key] || CITY_UPGRADES[key]).cost;
      entry.queue = entry.queue.slice(0, last);
      entry.honorPaid = (entry.honorPaid || []).slice(0, last);
      if (!last) entry.progress = 0;
    }
    if (cities.length > 1) this.hud.feed(`Last order cancelled in ${cities.length} cities`);
  }

  // What honor pays for this item (a unit type or an upgrade key), or null when it can't: Barracks with
  // Brotherhood of Arms, any trained unit with Eternal Glory (the host's Game.honorPrice).
  honorPrice(key) {
    if (key === 'barracks' && this.hasTradition('brotherhood')) return TRADITIONS.brotherhood.barracksHonor;
    const unit = UNITS[key];
    if (unit && !unit.promoted && this.hasTradition('eternalGlory')) return unit.cost * TRADITIONS.eternalGlory.unitHonorFactor;
    return null;
  }

  // Set (or with x = null clear) the rally points of the given cities: on land for the units they
  // train, on the water for their ships (the host tells which from the place). Clearing clears both.
  setRally(cities, x, y) {
    if (x == null) {
      this.link.send({ t: 'rally', cities, x: null, y: null });
      this.hud.feed(cities.length > 1 ? 'Rally points cleared' : 'Rally point cleared');
      return;
    }
    this.link.send({ t: 'rally', cities, x: Math.round(x), y: Math.round(y) });
    this.marker(x, y, '#ffffff');
  }
}
