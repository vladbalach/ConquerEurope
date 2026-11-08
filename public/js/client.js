// In-game client state: snapshot interpolation, selection, commands, effects.
import {
  UNITS, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, ECONOMY, LIBERATOR, TECHS, TECH_TYPES,
  NEUTRAL_COLOR, PLAYER_COLOR_NAMES,
} from '/shared/config.js';
import { liberatorIncome, influenceLimit, smugglingLimit, smugglingFlows } from '/shared/tech.js';
import { sanitizeOptions, citiesToWin, describeOptions } from '/shared/options.js';
import { regionCities, regionHolder } from '/shared/regions.js';
import { UNIT_CLASSES } from './units/index.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Hud, colorTag } from './hud.js';
import { playSound } from './sound.js';

const INTERP_DELAY = 0.13;   // seconds behind the newest snapshot
const TICK_SECONDS = 3;      // a clock tick sounds in each of the last seconds of a turn

export class GameClient {
  constructor({ map, net, link, gameId, you, title, options, players, onLeave, debug = null, admin = false, mapState = null }) {
    this.map = map;
    this.net = net;              // the lobby server: balance and map edits
    this.link = link || net;     // the game, run by the host's browser: orders go here (p2p.js)
    this.debug = debug;          // debug tools (stats overlays) or null in production
    this.admin = admin;          // may edit the game balance (Edit button) and the map (Edit map)
    this.mapEdit = false;        // Edit map mode: drag cities to move them (admins only)
    this.mapState = mapState || { pending: 0, busy: false };
    this.serverTickMs = 0;
    this.gameId = gameId;
    this.you = you;
    this.title = title;
    this.options = sanitizeOptions(options, map.cities.length);   // victory rules the host picked
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
    this.renderUnits = [];
    this.unitById = new Map();
    this.myQueues = new Map();
    this.gold = 0;
    this.cityShots = [];

    this.selection = new Set();
    this.selectedCities = new Set();   // own cities; several can be selected at once
    this.inspect = null;
    this.groups = new Map();

    this.effects = { shots: [], sparks: [], deaths: [], markers: [], flashes: [] };
    this.unitTimers = new Map();
    this.cityTimers = new Map();

    this.ended = false;
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

    this.lastFrame = performance.now();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
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

  onSnap(msg) {
    const now = performance.now();
    const sample = now - msg.time * 1000;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;

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
    if (msg.st !== undefined) this.serverTickMs = msg.st;
    this.turn = msg.turn;
    this.nextTurnAt = msg.next;
    this.research = msg.r ? { tech: TECH_TYPES[msg.r[0]], progress: msg.r[1] } : null;   // yours, if any
    this.myQueues.clear();
    for (const [city, progress, queue, rx, ry] of msg.q) {
      this.myQueues.set(city, { progress, queue, rally: rx == null ? null : [rx, ry] });
    }
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
      const took = msg.liberated ? 'liberated' : 'captured';      // a liberator took it (Death: Liberator)
      if (msg.to === this.you) {
        this.hud.feed([this.who(this.you), ` ${took} ${city.n}`, ...from], cls);
        // You took the city you were looking at: select it, so you can build there at once.
        if (msg.liberated && this.inspect?.k === 'c' && this.inspect.id === msg.city) this.selectCity(msg.city);
      } else if (msg.from === this.you) {
        playSound('city-lost');     // wherever the city is, on screen or not
        const refund = msg.refund ? ` (+${msg.refund} gold from its queue refunded)` : '';
        this.hud.feed([this.who(msg.to), ` ${took} your city ${city.n}!${refund}`], cls);
      }
      else this.hud.feed([this.who(msg.to), ` ${took} ${city.n}`, ...from]);
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
    } else if (msg.kind === 'researched') {
      this.hud.feed(`Research complete: ${TECHS[msg.tech].name} ${msg.level}`, 'good');
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
    } else if (msg.kind === 'left') {
      // Sent before the updated player list, so the leaver's colour is still known here.
      this.hud.feed([this.who(msg.player), ' left — their cities are now neutral']);
    }
  }

  // A capture completed your hold on a region, or broke it: say so in the feed.
  regionChanged(msg) {
    const region = this.map.cities[msg.city].c;
    const before = this.cityOwner.slice(), after = this.cityOwner.slice();
    before[msg.city] = msg.from;
    after[msg.city] = msg.to;
    const had = this.regionHolder(region, before) === this.you, has = this.regionHolder(region, after) === this.you;
    if (had === has) return;
    const name = this.map.countries[region].n, count = this.regionCities[region].length;
    const each = `+${ECONOMY.regionBonusPerCity} gold per turn`;
    if (has) {
      const all = count > 1 ? `all ${count} cities of ${name}` : `${name}, a one-city region`;
      this.hud.feed(`You hold ${all}: ${count > 1 ? 'each pays' : 'it pays'} ${each} more`, 'good');
    } else {
      this.hud.feed(`You no longer hold all of ${name}: its cities lose the ${each} region bonus`, 'bad');
    }
  }

  // The game is over: everyone is revealed, nicknames with colours.
  onGameOver(msg) {
    this.ended = true;
    if (msg.players) this.setPlayers(msg.players);
    this.winner = msg.winner;
    this.hud.showGameOver(msg.winner, this.revealedName(msg.winner));
  }

  // The lobby server reveals every nickname once the game is over (the host's browser never had
  // them). Shown on the game-over screen and in the Players overlay.
  onReveal(msg) {
    this.revealed = new Map(msg.players.map((p) => [p.id, p.name]));
    for (const p of this.players.values()) if (this.revealed.has(p.id)) p.name = this.revealed.get(p.id);
    this.hud.renderScores();
    if (msg.reason) {
      this.ended = true;
      this.hud.showGameOver(-1, null, msg.reason);
    } else if (this.ended) {
      this.hud.showGameOver(this.winner, this.revealedName(this.winner));
    }
  }

  revealedName(id) {
    return (this.revealed && this.revealed.get(id)) || null;
  }

  // The link to the host broke (the host closed the game, or the network failed).
  onHostLost(text) {
    if (this.ended) return;
    this.ended = true;
    this.hud.showGameOver(-1, null, text);
  }

  leave() {
    this.onLeave();
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
    const rt = (now - this.offset) / 1000 - INTERP_DELAY;
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
      const ru = { id: u.id, t: u.t, owner: u.owner, x, y, dx: x, dy: y, hp: u.hp, flags: u.flags, tgt: u.tgt };
      list.push(ru);
      this.unitById.set(u.id, ru);
    }
    // Melee attackers lunge at their target.
    const tsec = now / 1000;
    for (const u of list) {
      if (!(u.flags & 1) || UNIT_CLASSES[u.t].isRanged || !u.tgt) continue;
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
      if (!(u.flags & 1) || !u.tgt) continue;
      const next = this.unitTimers.get(u.id) || 0;
      if (now < next) continue;
      const tp = this.targetPos(u.tgt);
      if (!tp) continue;
      if (UNIT_CLASSES[u.t].isRanged) {
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
    const alive = (arr, life) => arr.filter((e) => now - e.t0 < (e.dur || life));
    fx.shots = alive(fx.shots, 1000);
    fx.sparks = alive(fx.sparks, 260);
    fx.deaths = alive(fx.deaths, 900);
    fx.markers = alive(fx.markers, 550);
    fx.flashes = alive(fx.flashes, 1600);
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
  startResearch(key) { this.link.send({ t: 'research', tech: key }); }
  cancelResearch() { this.link.send({ t: 'cancelResearch' }); }

  // The game balance changed (already applied to the config by main.js): redraw everything
  // that shows stats, costs or build times.
  onBalance(msg) {
    this.admin = !!msg.admin;
    if (!this.admin) this.setMapEdit(false);
    this.hud.balanceChanged(msg.changed);
  }

  // ---------------------------------------------------------------- map editing (admins)
  // Edit map mode: cities can be dragged to new places. The server checks admin rights again.
  setMapEdit(on) {
    this.mapEdit = !!on && this.admin;
    if (!this.mapEdit && this.input) this.input.cityDrag = null;
    this.hud?.mapEditChanged();
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

  // A city moved (main.js already updated map.cities). Cities are drawn from the map every frame;
  // territories follow on the next rebuild.
  onCityMoved() {}

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
    if (this.offset === null || this.nextTurnAt == null) return null;
    return Math.max(0, this.nextTurnAt - (now - this.offset) / 1000);
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

  ownUnitCount() {
    let n = 0;
    for (const u of this.renderUnits) if (u.owner === this.you) n++;
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
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    if (this.selection.size) { this.selectedCities.clear(); this.inspect = null; }
  }

  deselect(id) {
    this.selection.delete(id);
  }

  // Select one of your cities; with `add` (Shift) toggle it in the current city selection.
  selectCity(ci, add = false) {
    this.selection.clear();
    this.inspect = null;
    if (!add) this.selectedCities.clear();
    if (add && this.selectedCities.has(ci)) this.selectedCities.delete(ci);
    else this.selectedCities.add(ci);
  }

  selectCities(ids, add = false) {
    this.selection.clear();
    this.inspect = null;
    if (!add) this.selectedCities.clear();
    for (const ci of ids) this.selectedCities.add(ci);
  }

  inspectThing(thing) {
    this.selection.clear();
    this.selectedCities.clear();
    this.inspect = thing;
  }

  clearSelection() {
    this.selection.clear();
    this.selectedCities.clear();
    this.inspect = null;
  }

  // ---------------------------------------------------------------- commands
  marker(x, y, color) {
    this.effects.markers.push({ x, y, color, t0: performance.now() });
  }

  commandMove(x, y, amove) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.link.send({ t: 'move', ids, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, amove: !!amove });
    this.marker(x, y, amove ? '#ff9a3c' : '#9dff6a');
  }

  commandAttack(k, id, x, y) {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.link.send({ t: 'attack', ids, k, id });
    this.marker(x, y, '#ff4a3a');
  }

  // Selected infantry go inside one of our cities; other selected units walk next to it.
  commandStop() {
    const ids = [...this.selection];
    if (ids.length) this.link.send({ t: 'stop', ids });
  }

  // H key: the selected units stand where they are until their next move, attack or stop order.
  commandHold() {
    const ids = [...this.selection].filter((id) => this.unitById.get(id)?.owner === this.you);
    if (!ids.length) return;
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
    this.link.send({ t: 'disband', ids });
    this.hud.feed(`${ids.length} unit${ids.length === 1 ? ' is' : 's are'} disbanding`);
  }

  // Upgrade already built in a city, or waiting in its production queue.
  hasUpgrade(ci, key) {
    return !!(this.cityUpgrades[ci] & (1 << UPGRADE_TYPES.indexOf(key)));
  }
  upgradeQueued(ci, key) {
    const q = this.myQueues.get(ci);
    return !!q && q.queue.includes(PRODUCTION_ITEMS.indexOf(key));
  }

  // Queue one unit or upgrade (`item`) in every selected city, as far as the gold reaches.
  // An upgrade is skipped in cities that already have it or have it queued.
  build(item) {
    const cities = [...this.selectedCities].filter((ci) => this.cityOwner[ci] === this.you);
    if (!cities.length) return;
    const isUpgrade = !!CITY_UPGRADES[item];
    const def = UNITS[item] || CITY_UPGRADES[item];
    const queued = [];
    let gold = this.gold, full = 0, done = 0;
    for (const ci of cities) {
      const q = this.myQueues.get(ci);
      if (q && q.queue.length >= ECONOMY.maxQueue) { full++; continue; }
      if (isUpgrade && (this.hasUpgrade(ci, item) || this.upgradeQueued(ci, item))) { done++; continue; }
      if (gold < def.cost) break;
      gold -= def.cost;
      queued.push(ci);
    }
    if (!queued.length) {
      const msg = done === cities.length ? `${def.name} is already built or on its way`
        : full + done === cities.length ? 'Production queue is full'
          : `Not enough gold for ${def.name.toLowerCase()} (${def.cost})`;
      this.hud.feed(msg, 'bad');
      return;
    }
    this.link.send({ t: 'build', cities: queued, item });
    // Optimistic update so rapid key presses reflect immediately; the next snapshot corrects it.
    this.gold = gold;
    for (const ci of queued) {
      const entry = this.myQueues.get(ci) || { progress: 0, queue: [], rally: null };
      entry.queue = entry.queue.concat([PRODUCTION_ITEMS.indexOf(item)]);
      this.myQueues.set(ci, entry);
    }
    if (cities.length > 1 && queued.length + done < cities.length) {
      this.hud.feed(`${def.name} queued in ${queued.length} of ${cities.length} cities` +
        (queued.length + full + done < cities.length ? ' — not enough gold for the rest' : ''), 'bad');
    }
  }

  cancel(ci, index) {
    this.link.send({ t: 'cancel', city: ci, index });
  }

  // Set (or with x = null clear) the rally point of the given cities.
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
