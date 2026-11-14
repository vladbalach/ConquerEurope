// What happened in a game, for the results screen once it is over (public/js/results.js):
//  - frames: the map turn by turn (the Timeline). The first frame is the start, then one at the end of
//    every turn, and a last one when the game ends. A frame keeps only the cities that changed hands
//    since the frame before it.
//  - every player's numbers in each frame, for the graphs: cities, units, army value, income (the gold per
//    turn their cities pay at that moment, or a liberator's pay), kills and losses so far, and the gold in
//    their treasury (private while the game runs; the results screen shows everyone's).
//  - every player's totals, for their page of advanced stats: units trained, lost and destroyed by type,
//    city upgrades built, cities taken and lost, gold earned and spent, honor, when each technology and
//    tradition was learned, Heroes and Healers made, War Cries, and when they fell (or renounced), surrendered or left.
// Players who leave keep their history (colour, numbers until then). It all goes out once, with the
// game-over message (Game.end).
//
// Runs in the host's browser too (served as /sim/): no Node-only modules here.
import { UNITS } from '../shared/config.js';
import { liberatorIncome } from '../shared/tech.js';
import { scaleGoldWhole } from '../shared/options.js';

// The numbers kept for every player in every frame, in this order (results.js reads them by name).
export const SERIES = ['cities', 'units', 'army', 'income', 'kills', 'losses', 'gold'];
// The numbers of a save from before saves named them.
const OLD_SERIES = ['cities', 'units', 'army', 'income', 'kills', 'losses'];

// Frames kept with other numbers (a save from an older version), in the order of SERIES; a number they
// did not keep is null (no line there in the graphs).
export function repackFrames(frames, series = OLD_SERIES) {
  if (!Array.isArray(series) || series.join() === SERIES.join()) return frames;
  const stride = 1 + series.length, at = SERIES.map((k) => series.indexOf(k));
  return frames.map((f) => {
    const old = f.p || [], p = [];
    for (let i = 0; i + stride <= old.length; i += stride) p.push(old[i], ...at.map((j) => (j < 0 ? null : old[i + 1 + j])));
    return { ...f, p };
  });
}

const round = (v) => Math.round(v * 10) / 10;
const add = (obj, key, n = 1) => { obj[key] = round((obj[key] || 0) + n); };

function newStats() {
  return {
    trained: {}, lost: {}, killed: {}, built: {},      // unit type (or upgrade) -> how many
    captured: 0, liberated: 0, citiesLost: 0,           // cities taken by force, liberated, lost
    goldIncome: 0, goldKills: 0,                        // gold earned: paid by turns (cities, liberator pay), by kills
    spentUnits: 0, spentUpgrades: 0, spentResearch: 0,  // gold spent on what was finished (cancelled items are refunded)
    honorKills: 0, honorDead: 0, honorSpent: 0,         // honor earned by kills, by Honored Dead; spent on anything
    heroes: 0, healers: 0,
    events: [],                                          // [turn, kind, what, level]: research, tradition, fell, renounced, back, out, surrendered, left, won
  };
}

export class History {
  constructor() {
    this.frames = [];
    this.owners = null;          // city owners at the last frame
    this.roster = new Map();     // player id -> colour, everyone who played (also those who left)
    this.stats = new Map();      // player id -> totals (newStats)
  }

  get started() { return this.owners !== null; }

  stat(id) {
    if (!Number.isInteger(id) || id < 0) return null;
    let s = this.stats.get(id);
    if (!s) this.stats.set(id, (s = newStats()));
    return s;
  }

  // The turn being played now, counted from 1 (turn 1 is the first): when something happened.
  static turnOf(game) { return game.turn + 1; }

  // ------------------------------------------------------------ frames
  // The first frame: who holds what when the game really starts (after the countdown).
  begin(game) {
    if (this.started) return;
    for (const p of game.players.values()) { this.roster.set(p.id, p.color); this.stat(p.id); }
    this.owners = game.cities.map(() => -1);
    this.frame(game, 0);
  }

  // `turn`: the turns completed when the frame is taken (0 at the start).
  frame(game, turn) {
    if (!this.started) return;
    const own = [];
    game.cities.forEach((c, i) => {
      if (c.owner === this.owners[i]) return;
      this.owners[i] = c.owner;
      own.push(i, c.owner);
    });
    const income = new Map(), army = new Map();
    for (const c of game.cities) if (c.owner >= 0) income.set(c.owner, (income.get(c.owner) || 0) + c.goldPerTurn);
    for (const u of game.units.values()) {
      let v = u.value ?? UNITS[u.type].cost;
      if (u.naval) for (const c of u.cargo) v += c.value ?? UNITS[c.type].cost;
      army.set(u.owner, (army.get(u.owner) || 0) + v);
    }
    const p = [];
    for (const pl of game.players.values()) {
      this.roster.set(pl.id, pl.color);
      const gold = scaleGoldWhole(pl.liberator ? liberatorIncome(pl.tech) : income.get(pl.id) || 0, pl.goldPercent);
      p.push(pl.id, pl.cityCount, pl.unitCount, round(army.get(pl.id) || 0), round(gold), round(pl.kills), round(pl.losses),
        Math.floor(pl.gold || 0));   // whole gold, as the player's own screen shows it
    }
    this.frames.push({ t: turn, s: Math.round(game.time), o: own, p });
  }

  // The end of a turn: what each player was paid, then the frame.
  turnEnded(game, paid) {
    for (const [id, gold] of paid) {
      const s = this.stat(id);
      if (s) s.goldIncome = round(s.goldIncome + gold);
    }
    this.frame(game, game.turn);
  }

  // The game is over: the last frame, and the winner. It is labelled with the turn being played (the one
  // ending, when the target was held as the turn ended), like everything that happened in it.
  finish(game, winner) {
    if (!this.started) this.begin(game);
    this.frame(game, History.turnOf(game));
    this.frames[this.frames.length - 1].end = true;
    if (winner >= 0) this.event(game, winner, 'won');
  }

  // ------------------------------------------------------------ what players did
  event(game, id, kind, what = null, level = null) {
    const s = this.stat(id);
    if (!s) return;
    const e = [History.turnOf(game), kind];
    if (what !== null) e.push(what);
    if (level !== null) e.push(level);
    s.events.push(e);
  }

  trained(id, type, gold) {
    const s = this.stat(id);
    if (!s) return;
    add(s.trained, type);
    s.spentUnits = round(s.spentUnits + gold);
  }

  built(id, key, gold) {
    const s = this.stat(id);
    if (!s) return;
    add(s.built, key);
    s.spentUpgrades = round(s.spentUpgrades + gold);
  }

  honorSpent(id, honor) {
    const s = this.stat(id);
    if (s && honor > 0) s.honorSpent = round(s.honorSpent + honor);
  }

  // A unit died: a loss for its owner, a kill for `killer` (or nobody: -1) with what it paid them.
  died(owner, type, killer, gold, honor) {
    const lost = this.stat(owner);
    if (lost) add(lost.lost, type);
    const k = this.stat(killer);
    if (!k) return;
    add(k.killed, type);
    k.goldKills = round(k.goldKills + gold);
    k.honorKills = round(k.honorKills + honor);
  }

  honoredDead(id, honor) {
    const s = this.stat(id);
    if (s) s.honorDead = round(s.honorDead + honor);
  }

  captured(from, to, liberated) {
    const s = this.stat(to);
    if (s) { if (liberated) s.liberated++; else s.captured++; }
    const l = this.stat(from);
    if (l) l.citiesLost++;
  }

  researched(game, id, tech, level, gold) {
    const s = this.stat(id);
    if (!s) return;
    s.spentResearch = round(s.spentResearch + gold);
    this.event(game, id, 'research', tech, level);
  }

  learned(game, id, tradition, honor) {
    this.honorSpent(id, honor);
    this.event(game, id, 'tradition', tradition);
  }

  promoted(id, to, honor) {
    const s = this.stat(id);
    if (!s) return;
    if (to === 'healer') s.healers++;
    else s.heroes++;
    this.honorSpent(id, honor);
  }

  // For the game-over message.
  toJSON() {
    return {
      series: SERIES,              // the order of each player's numbers in a frame
      roster: [...this.roster].map(([id, color]) => [id, color]),
      frames: this.frames,
      stats: Object.fromEntries(this.stats),
    };
  }
}
