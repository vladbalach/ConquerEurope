// The results screen, once a game is over. It covers the whole screen with two tabs:
//  - Players: every player's numbers (what the Players list shows, plus technologies and the peak of
//    their empire) and a graph of the whole game. Click a player for their own page of stats.
//  - Timeline: the map turn by turn, as cities changed hands, with a slider and Play.
// "Look at the map" (or Esc) folds it into a bar at the top of the screen; the bar's button opens it again.
// Everything comes from the game-over message: the players, and the game's history, recorded by the host
// (server/history.js). Without a history (the host left) only the players' last numbers are shown.
import {
  UNITS, UNIT_TYPES, UPGRADE_TYPES, CITY_UPGRADES, TECHS, TECH_TYPES, TRADITIONS, TRADITION_TYPES,
  PLAYER_COLOR_NAMES, NEUTRAL_COLOR,
} from '/shared/config.js';
import { unitIconURL, upgradeIconURL, techIconURL, traditionSmallIconURL } from './sprites.js';
import { SEA } from './render.js';
import { el } from './hud.js';

const $ = (id) => document.getElementById(id);
const num = (n) => Math.round(n || 0).toLocaleString('en-US');
// Short numbers for chart axes: 950, 12.5k, 1.2M.
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (a >= 1e4) return `${Math.round(n / 1e2) / 10}k`;
  return num(n);
}
// Game time as h:mm:ss or m:ss.
function clock(sec) {
  const s = Math.max(0, Math.round(sec || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

const MUTED = '#b9ab8a';           // --muted
const GRID = 'rgba(255,255,255,0.07)';
const DIM_LINE = 'rgba(185,171,138,0.3)';
const KILLS_COLOR = '#8fdc8f';     // as the Kills column of the Players list
const LOSSES_COLOR = '#f0a090';    // as its Losses column

// Player colours as this screen writes them. On its dark background, colours too dark to read (Black, Navy,
// Maroon, Purple...) are lightened, keeping their hue, until names and lines read well; next to a name, a
// dot in the exact colour ties it to the map. (The game's HUD puts a light box behind such names instead.)
const BACKGROUND_LUMINANCE = 0.0075;   // about #1c150e, the page behind the text
const READABLE = 4.5;                  // the contrast every name and line reaches
const inks = new Map();
function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ink(hex) {
  if (!inks.has(hex)) {
    const n = parseInt(String(hex).slice(1), 16);
    const c = Number.isNaN(n) ? [140, 140, 140] : [n >> 16, (n >> 8) & 255, n & 255];
    let out = c;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      out = c.map((v) => Math.round(v + (255 - v) * t));
      if ((luminance(out) + 0.05) / (BACKGROUND_LUMINANCE + 0.05) >= READABLE) break;
    }
    inks.set(hex, `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }
  return inks.get(hex);
}

// The graphs of the Players tab: one number per player and turn (server/history.js SERIES).
const METRICS = [
  { key: 'cities', name: 'Cities', tip: 'Cities held at the end of each turn' },
  { key: 'units', name: 'Units', tip: 'Units commanded at the end of each turn (units on board ships too)' },
  { key: 'army', name: 'Army value', tip: 'Gold value of every unit the player commanded at the end of each turn' },
  { key: 'income', name: 'Gold per turn', tip: 'Gold per turn the player\'s cities paid (Farms and whole regions included; a liberator: their pay)' },
  { key: 'kills', name: 'Kills', tip: 'Gold value of the enemy units destroyed so far' },
  { key: 'losses', name: 'Losses', tip: 'Gold value of the units lost so far' },
];
const SPEEDS = [1, 2, 4, 8];       // Timeline: turns per second while playing

// ------------------------------------------------------------------ the game's history, decoded
// frames: [{ turn, time, end, owners (Int16Array), changes: [{ city, from, to }], players: Map id -> numbers }]
function decodeFrames(history, cityCount) {
  if (!history || !Array.isArray(history.frames)) return [];
  const series = history.series || [];
  const stride = 1 + series.length;
  const owners = new Int16Array(cityCount).fill(-1);
  return history.frames.map((f) => {
    const changes = [];
    const o = f.o || [];
    for (let i = 0; i + 1 < o.length; i += 2) {
      const city = o[i], to = o[i + 1];
      if (city < 0 || city >= cityCount) continue;
      changes.push({ city, from: owners[city], to });
      owners[city] = to;
    }
    const players = new Map();
    const p = f.p || [];
    for (let i = 0; i + stride <= p.length; i += stride) {
      const v = {};
      series.forEach((k, j) => { v[k] = p[i + 1 + j]; });
      players.set(p[i], v);
    }
    return { turn: f.t || 0, time: f.s || 0, end: !!f.end, owners: owners.slice(), changes, players };
  });
}

// Technology levels and traditions from a player's history, for players who left (no live numbers).
function techFromEvents(events) {
  const tech = {};
  for (const [, kind, what, level] of events || []) if (kind === 'research') tech[what] = Math.max(tech[what] || 0, level || 1);
  return tech;
}
const traditionsFromEvents = (events) => (events || []).filter((e) => e[1] === 'tradition').map((e) => e[2]);

// Everything the screen shows about the players, from the live player list and the history.
function buildModel(g, winner) {
  const history = g.history || null;
  const frames = decodeFrames(history, g.map.cities.length);
  const colors = new Map();
  for (const [id, color] of history?.roster || []) colors.set(id, color);
  for (const p of g.players.values()) if (p.color) colors.set(p.id, p.color);
  const series = history?.series || [];
  const incomes = g.incomes();
  const last = frames[frames.length - 1] || null;
  const players = [...colors].map(([id, color]) => {
    const live = g.players.get(id) || null;
    const stats = history?.stats?.[id] || null;
    const values = {};
    for (const k of series) values[k] = frames.map((f) => (f.players.has(id) ? f.players.get(id)[k] : null));
    // The most cities held in a frame, and the first turn it was reached.
    let peak = -1, peakTurn = 0;
    (values.cities || []).forEach((v, i) => { if (v !== null && v > peak) { peak = v; peakTurn = frames[i].turn; } });
    if (peak < 0) { peak = live ? live.cities : 0; peakTurn = last ? last.turn : 0; }
    const lastNumbers = [...frames].reverse().find((f) => f.players.has(id))?.players.get(id) || {};
    return {
      id, color, live, stats, values, peak, peakTurn,
      name: live?.name || g.revealed?.get(id) || null,
      colorName: PLAYER_COLOR_NAMES[color] || 'Someone',
      cities: live ? live.cities : 0,
      units: live ? live.units : 0,
      income: live ? incomes.get(id) || 0 : 0,
      kills: live ? live.kills : lastNumbers.kills || 0,
      losses: live ? live.losses : lastNumbers.losses || 0,
      tech: live?.tech || techFromEvents(stats?.events),
      traditions: live?.traditions || traditionsFromEvents(stats?.events),
      status: id === winner ? 'Winner' : !live ? 'Left' : live.eliminated ? 'Eliminated' : live.liberator ? 'Liberator'
        : !live.connected ? 'Disconnected' : '',
    };
  });
  players.sort((a, b) => (b.id === winner) - (a.id === winner) || b.cities - a.cities || b.peak - a.peak || b.kills - a.kills);
  return { frames, players, byId: new Map(players.map((p) => [p.id, p])), colors, series };
}

// ------------------------------------------------------------------ line chart
// Nice round steps for an axis from 0 to `max`: [0, step, 2 * step, ...] up to at least max.
function ticks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// One line per series over the frames of the game (x: frame index). Hover: a crosshair snaps to the
// nearest turn and a tooltip lists every series' value there. A series with `dim` is drawn in grey
// behind the others; `highlight` (a series id) fades every other line. `cursor`: a frame marked with
// a gold line (the Timeline's). onPick(index): a click on the chart.
class LineChart {
  constructor({ height = 220, format = compact, onPick = null } = {}) {
    this.height = height;
    this.format = format;
    this.onPick = onPick;
    this.data = null;
    this.hover = -1;
    this.highlight = null;
    this.canvas = el('canvas', { class: 'chart-canvas' });
    this.tip = el('div', { class: 'chart-tip' });
    this.tip.hidden = true;
    this.root = el('div', { class: `chart${onPick ? ' pickable' : ''}` }, this.canvas, this.tip);
    this.root.style.height = `${height}px`;
    this.canvas.addEventListener('pointermove', (e) => this.pointer(e));
    this.canvas.addEventListener('pointerleave', () => this.setHover(-1));
    if (onPick) this.canvas.addEventListener('click', (e) => { const i = this.indexAt(e); if (i >= 0) onPick(i); });
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.root);
  }

  // data: { count, label(i), series: [{ id, name, color, values, dim }], cursor }
  set(data) {
    this.data = data;
    this.draw();
  }

  setHighlight(id) {
    if (id === this.highlight) return;
    this.highlight = id;
    this.draw();
  }

  destroy() { this.observer.disconnect(); }

  layout() {
    const w = this.root.clientWidth, h = this.height;
    const d = this.data;
    let max = 0;
    for (const s of d.series) for (const v of s.values) if (v !== null && v > max) max = v;
    const ys = ticks(max);
    const top = ys[ys.length - 1] || 1;
    const pad = { l: 46, r: 14, t: 10, b: 24 };
    const n = Math.max(1, d.count - 1);
    return {
      w, h, pad, ys,
      x: (i) => pad.l + (d.count <= 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / n),
      y: (v) => pad.t + (1 - v / top) * (h - pad.t - pad.b),
    };
  }

  indexAt(e) {
    if (!this.data || !this.data.count) return -1;
    const r = this.canvas.getBoundingClientRect();
    const { pad, w } = this.layout();
    const n = this.data.count - 1;
    if (n <= 0) return 0;
    const t = (e.clientX - r.left - pad.l) / (w - pad.l - pad.r);
    return Math.max(0, Math.min(n, Math.round(t * n)));
  }

  pointer(e) { this.setHover(this.indexAt(e)); }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this.draw();
    this.renderTip();
  }

  draw() {
    const d = this.data;
    const w = this.root.clientWidth;
    if (!d || !w) return;
    const dpr = window.devicePixelRatio || 1;
    const L = this.layout();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(L.h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${L.h}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, L.h);
    ctx.font = '11px system-ui, "Segoe UI", sans-serif';

    // Recessive grid and axis labels.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of L.ys) {
      const y = Math.round(L.y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,0.2)' : GRID;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.pad.l, y); ctx.lineTo(w - L.pad.r, y); ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(this.format(v), L.pad.l - 7, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labels = Math.max(2, Math.min(d.count, Math.floor((w - L.pad.l - L.pad.r) / 70)));
    const shown = new Set();
    for (let k = 0; k < labels; k++) shown.add(Math.round((k * (d.count - 1)) / Math.max(1, labels - 1)));
    for (const i of shown) {
      const x = L.x(i);
      ctx.fillStyle = MUTED;
      ctx.textAlign = i === 0 ? 'left' : i === d.count - 1 ? 'right' : 'center';
      ctx.fillText(d.label(i, true), x, L.h - L.pad.b + 7);
    }

    if (d.cursor !== undefined && d.cursor !== null) {
      const x = Math.round(L.x(d.cursor)) + 0.5;
      ctx.strokeStyle = 'rgba(201,162,74,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, L.pad.t); ctx.lineTo(x, L.h - L.pad.b); ctx.stroke();
    }

    // Dim lines first, then the coloured ones, the highlighted one last (on top).
    const order = [...d.series].sort((a, b) => (b.dim ? 1 : 0) - (a.dim ? 1 : 0)
      || (a.id === this.highlight) - (b.id === this.highlight));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of order) {
      const faded = this.highlight !== null && s.id !== this.highlight && !s.dim;
      const path = new Path2D();
      let open = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined) { open = false; return; }
        const x = L.x(i), y = L.y(v);
        if (open) path.lineTo(x, y); else path.moveTo(x, y);
        open = true;
      });
      ctx.globalAlpha = faded ? 0.18 : 1;
      ctx.strokeStyle = s.dim ? DIM_LINE : s.color;
      ctx.lineWidth = s.dim ? 1.25 : s.id === this.highlight ? 3 : 2;
      ctx.stroke(path);
      if (s.values.filter((v) => v !== null && v !== undefined).length === 1) {
        const i = s.values.findIndex((v) => v !== null && v !== undefined);
        ctx.fillStyle = s.dim ? DIM_LINE : s.color;
        ctx.beginPath(); ctx.arc(L.x(i), L.y(s.values[i]), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // The crosshair, with a dot on each coloured line.
    if (this.hover >= 0 && this.hover < d.count) {
      const x = Math.round(L.x(this.hover)) + 0.5;
      ctx.strokeStyle = 'rgba(245,236,214,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, L.pad.t); ctx.lineTo(x, L.h - L.pad.b); ctx.stroke();
      for (const s of d.series) {
        const v = s.values[this.hover];
        if (s.dim || v === null || v === undefined) continue;
        ctx.fillStyle = s.color;
        ctx.strokeStyle = '#19130c';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(L.x(this.hover), L.y(v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  // Every coloured series' value at the turn under the pointer, the biggest first.
  renderTip() {
    const d = this.data, i = this.hover;
    if (!d || i < 0) { this.tip.hidden = true; return; }
    const rows = d.series.filter((s) => !s.dim && s.values[i] !== null && s.values[i] !== undefined)
      .sort((a, b) => b.values[i] - a.values[i]);
    if (!rows.length) { this.tip.hidden = true; return; }
    const MAX = 10;
    this.tip.replaceChildren(el('div', { class: 'chart-tip-head' }, d.label(i, false)),
      ...rows.slice(0, MAX).map((s) => el('div', { class: 'chart-tip-row' },
        el('i', { class: 'line-key', style: `background:${s.color}` }),
        el('b', {}, this.format(s.values[i])),
        el('span', {}, s.name))));
    if (rows.length > MAX) this.tip.append(el('div', { class: 'muted small' }, `and ${rows.length - MAX} more`));
    this.tip.hidden = false;
    const L = this.layout(), x = L.x(i);
    const tw = this.tip.offsetWidth;
    const left = x + 14 + tw > L.w ? x - 14 - tw : x + 14;
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${L.pad.t}px`;
  }
}

// ------------------------------------------------------------------ the results screen
export class Results {
  constructor(game) {
    this.g = game;
    this.root = $('results');
    this.root.hidden = true;
    this.root.textContent = '';
    this.root.classList.remove('open');
    $('screen-game').classList.remove('game-over');
    this.open = false;
    this.tab = 'players';
    this.detail = null;            // the player whose page is open (Players tab), or null
    this.metric = 'cities';
    this.frame = null;             // the Timeline's frame (null: the last one)
    this.speed = 2;
    this.charts = [];
    this.timeline = null;
  }

  get shown() { return !this.root.hidden; }
  get isOpen() { return this.shown && this.open; }

  // The game is over (again when the nicknames arrive from the lobby server). The first time it opens
  // full screen; after that it keeps where the player is (tab, player page, Timeline turn, folded).
  show(winner, reason = null) {
    const first = !this.shown;
    if (this.g.history !== this.history) this.frame = null;     // another game's history: the Timeline starts at its end
    this.history = this.g.history;
    this.winner = winner;
    this.reason = reason;
    this.model = buildModel(this.g, winner);
    if (first) this.open = true;
    this.render();
  }

  collapse() { this.open = false; this.render(); }
  expand() { this.open = true; this.render(); }

  destroy() {
    this.clear();
    this.root.hidden = true;
    this.root.textContent = '';
    $('screen-game').classList.remove('game-over');
  }

  clear() {
    for (const c of this.charts) c.destroy();
    this.charts = [];
    if (this.timeline) this.timeline.destroy();
    this.timeline = null;
  }

  chart(opts) {
    const c = new LineChart(opts);
    this.charts.push(c);
    return c;
  }

  // A player's nickname in their colour, made readable (ink), after a dot in their exact colour. Their
  // colour's name until the nicknames arrive. `dot`: false where a line key already shows the colour.
  tag(p, you = true, dot = true) {
    const t = el('span', { class: 'pname', title: p.name ? p.colorName : null },
      dot ? el('i', { class: 'pdot', style: `background:${p.color}` }) : null,
      el('b', { style: `color:${ink(p.color)}` }, p.name || p.colorName));
    if (you && p.id === this.g.you) t.append(el('span', { class: 'muted' }, ' (you)'));
    return t;
  }

  tagOf(id) {
    const p = this.model.byId.get(id);
    return p ? this.tag(p, false) : el('span', { class: 'muted' }, 'neutral');
  }

  render() {
    this.clear();
    this.root.hidden = false;
    $('screen-game').classList.add('game-over');
    this.root.classList.toggle('open', this.open);
    this.root.replaceChildren(this.open ? this.renderFull() : this.renderBar());
  }

  // Title and one line: who won, or why the game ended.
  headline() {
    const g = this.g, w = this.model.byId.get(this.winner);
    if (this.reason) return { title: 'Game over', text: [this.reason] };
    if (this.winner === g.you) return { title: 'Victory!', text: ['Europe bows before you.'] };
    if (w) return { title: 'Defeat', text: [this.tag(w, false), ' has conquered Europe.'] };
    return { title: 'Game over', text: ['No one is left standing.'] };
  }

  // How long the game lasted, from its last frame.
  duration() {
    const last = this.model.frames[this.model.frames.length - 1];
    return last ? `${plural(last.turn, 'turn')} · ${clock(last.time)}` : '';
  }

  renderBar() {
    const h = this.headline();
    return el('div', { class: 'results-bar' },
      el('b', { class: 'results-title' }, h.title),
      el('span', { class: 'results-line' }, ...h.text),
      el('span', { class: 'muted small results-time' }, this.duration()),
      el('span', { class: 'results-gap' }),
      el('button', { type: 'button', class: 'results-toggle', title: 'Every player\'s stats and the timeline of the game', onclick: () => this.expand() }, 'Show results ▾'),
      el('button', { type: 'button', class: 'primary', onclick: () => this.g.leave() }, 'Back to lobby'));
  }

  renderFull() {
    const h = this.headline();
    const tab = (id, name) => el('button', {
      type: 'button', role: 'tab', class: this.tab === id ? 'active' : '', 'aria-selected': String(this.tab === id),
      onclick: () => { this.tab = id; this.render(); },
    }, name);
    const head = el('header', { class: 'results-head' },
      el('div', { class: 'results-heading' },
        el('h2', {}, h.title),
        el('p', { class: 'results-line' }, ...h.text, this.duration() ? el('span', { class: 'muted' }, ` · ${this.duration()}`) : null)),
      el('div', { class: 'help-tabs results-tabs', role: 'tablist' }, tab('players', 'Players'), tab('timeline', 'Timeline')),
      el('div', { class: 'results-actions' },
        el('button', { type: 'button', title: 'Fold the results into a bar at the top and look at the map (Esc)', onclick: () => this.collapse() }, 'Look at the map ▴'),
        el('button', { type: 'button', class: 'primary', onclick: () => this.g.leave() }, 'Back to lobby')));
    let body;
    if (this.tab === 'timeline') {
      body = el('div', { class: 'results-body timeline-body' });
      if (this.model.frames.length) {
        this.timeline = new Timeline(this);
        body.append(this.timeline.root);
      } else {
        body.append(this.noHistory());
      }
    } else {
      body = el('div', { class: 'results-body' },
        el('div', { class: 'results-page' }, this.detail !== null && this.model.byId.has(this.detail) ? this.renderDetail(this.detail) : this.renderPlayers()));
    }
    const full = el('div', { class: 'results-full' }, head, body);
    if (this.timeline) requestAnimationFrame(() => this.timeline && this.timeline.start());
    return full;
  }

  noHistory() {
    return el('p', { class: 'empty results-empty' }, 'No timeline for this game: it ended before the host could send its history.');
  }

  openDetail(id) {
    this.detail = id;
    this.render();
    this.root.querySelector('.results-body')?.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- Players tab
  techCell(p) {
    const td = el('td', { class: 'icons' });
    for (const k of TECH_TYPES) {
      const level = p.tech[k] || 0;
      if (!level) continue;
      const def = TECHS[k], max = def.levels.length;
      const name = max > 1 ? `${def.name} ${level}/${max}` : def.name;
      td.append(el('span', { class: 'icon-badge', title: name },
        el('img', { src: techIconURL(k, p.color), alt: name }),
        max > 1 ? el('small', {}, String(level)) : null));
    }
    if (!td.childNodes.length) td.append(el('span', { class: 'muted small' }, '—'));
    return td;
  }

  traditionsCell(p) {
    const td = el('td', { class: 'icons' });
    for (const k of p.traditions) {
      const def = TRADITIONS[k];
      if (!def) continue;
      td.append(el('span', { class: `icon-badge${def.ultimate ? ' ultimate-icon' : ''}`, title: def.name },
        el('img', { src: traditionSmallIconURL(k, p.color), alt: def.name })));
    }
    if (!td.childNodes.length) td.append(el('span', { class: 'muted small' }, '—'));
    return td;
  }

  renderPlayers() {
    const g = this.g, m = this.model;
    const th = (text, title = '', cls = '') => el('th', { class: cls, title }, text);
    const table = el('table', { class: 'results-table' },
      el('thead', {}, el('tr', {},
        th('#', '', 'num'), th('Player'),
        th('Cities', 'Cities held at the end', 'num'),
        th('Peak', 'The most cities held at the end of a turn, and when', 'num'),
        th('Gold/turn', 'Gold the player\'s cities paid per turn at the end (Farms and whole regions included)', 'num'),
        th('Units', 'Units commanded at the end', 'num'),
        th('Kills', 'Gold value of enemy units this player destroyed', 'num'),
        th('Losses', 'Gold value of units this player lost', 'num'),
        th('Technologies'), th('Traditions'), th(''))));
    const tbody = el('tbody');
    m.players.forEach((p, i) => {
      const open = () => this.openDetail(p.id);
      tbody.append(el('tr', {
        class: `clickable${p.id === g.you ? ' me-row' : ''}${p.id === this.winner ? ' winner-row' : ''}`,
        tabindex: '0', title: 'Click for this player\'s stats', onclick: open,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
      },
      el('td', { class: 'num muted' }, String(i + 1)),
      el('td', { class: 'who-cell' }, this.tag(p), p.status ? el('span', { class: `status ${p.status.toLowerCase()}` }, p.status) : null),
      el('td', { class: 'num' }, num(p.cities)),
      el('td', { class: 'num', title: m.frames.length ? `${p.peakTurn ? `Turn ${p.peakTurn}` : 'At the start'}` : '' }, num(p.peak),
        m.frames.length ? el('span', { class: 'muted small' }, p.peakTurn ? ` · t${p.peakTurn}` : ' · start') : null),
      el('td', { class: 'num income' }, `+${num(p.income)}`),
      el('td', { class: 'num' }, num(p.units)),
      el('td', { class: 'num kills' }, num(p.kills)),
      el('td', { class: 'num losses' }, num(p.losses)),
      this.techCell(p),
      this.traditionsCell(p),
      el('td', { class: 'go' }, '›')));
    });
    table.append(tbody);
    const neutral = g.cityOwner.filter((o) => o < 0).length;
    const out = [
      el('div', { class: 'table-wrap' }, table),
      el('p', { class: 'muted small' }, `Click a player for their own stats. Kills and losses are in gold: the cost of the ` +
        `units destroyed. ${neutral} cities were neutral at the end.`),
    ];
    if (m.frames.length > 1) out.push(this.renderOverTime());
    return el('div', {}, ...out);
  }

  // A graph of the whole game: one line per player, for the number picked above it.
  renderOverTime() {
    const m = this.model;
    const metric = METRICS.find((x) => x.key === this.metric) || METRICS[0];
    const chart = this.chart({ height: 260 });
    const seg = el('div', { class: 'segmented', role: 'tablist' }, ...METRICS.map((x) => el('button', {
      type: 'button', role: 'tab', class: x.key === metric.key ? 'active' : '', title: x.tip,
      onclick: () => { this.metric = x.key; this.render(); },
    }, x.name)));
    const legend = el('div', { class: 'chart-legend' }, ...m.players.map((p) => el('span', {
      class: 'legend-item', onpointerenter: () => chart.setHighlight(p.id), onpointerleave: () => chart.setHighlight(null),
      onclick: () => this.openDetail(p.id), title: 'Click for this player\'s stats',
    }, el('i', { class: 'line-key', style: `background:${ink(p.color)}` }), this.tag(p, false, false))));
    chart.set({
      count: m.frames.length, label: (i, short) => this.frameLabel(i, short),
      series: m.players.map((p) => ({ id: p.id, name: p.name || p.colorName, color: ink(p.color), values: p.values[metric.key] || [] })),
    });
    return el('section', { class: 'results-section' },
      el('div', { class: 'section-head' }, el('h3', {}, 'Over the game'), seg),
      el('p', { class: 'muted small chart-note' }, metric.tip),
      chart.root, legend);
  }

  frameLabel(i, short = false) {
    const f = this.model.frames[i];
    if (!f) return '';
    if (i === 0) return 'Start';
    if (short) return f.end ? `End` : String(f.turn);
    return f.end ? `End of the game (turn ${f.turn}, ${clock(f.time)})` : `Turn ${f.turn} (${clock(f.time)})`;
  }

  // ---------------------------------------------------------------- a player's page
  renderDetail(id) {
    const g = this.g, m = this.model, p = m.byId.get(id), s = p.stats;
    const nav = el('div', { class: 'detail-nav' },
      el('button', { type: 'button', onclick: () => this.openDetail(null) }, '← All players'),
      el('div', { class: 'detail-switch' }, ...m.players.map((q) => el('button', {
        type: 'button', class: `player-chip${q.id === id ? ' active' : ''}`, onclick: () => this.openDetail(q.id),
      }, el('span', { class: 'swatch', style: `background:${q.color}` }), q.name || q.colorName))));
    const status = [p.colorName, p.status, p.id === g.you ? 'you' : ''].filter(Boolean).join(' · ');
    const head = el('div', { class: 'detail-head' }, el('h3', {}, this.tag(p, false)),
      el('span', { class: 'muted' }, status));
    if (!s) {
      return el('div', {}, nav, head, this.tiles([
        ['Cities', num(p.cities)], ['Units', num(p.units)], ['Kills', `${num(p.kills)} gold`], ['Losses', `${num(p.losses)} gold`],
      ]), el('p', { class: 'muted' }, 'No detailed stats for this game: it ended before the host could send its history.'));
    }
    const trained = sum(s.trained), killed = sum(s.killed), lost = sum(s.lost);
    const goldEarned = s.goldIncome + s.goldKills, goldSpent = s.spentUnits + s.spentUpgrades + s.spentResearch;
    const tiles = [
      ['Cities at the end', num(p.cities), m.frames.length ? `peak ${num(p.peak)} on ${p.peakTurn ? `turn ${p.peakTurn}` : 'the start'}` : ''],
      ['Cities taken', num(s.captured + s.liberated), s.liberated ? `${num(s.liberated)} of them liberated` : 'by force'],
      ['Cities lost', num(s.citiesLost)],
      ['Units trained', num(trained), s.heroes || s.healers ? `and ${plural(s.heroes, 'Hero', 'Heroes')}, ${plural(s.healers, 'Healer')} made` : ''],
      ['Enemy units destroyed', num(killed), `worth ${num(p.kills)} gold`],
      ['Units lost', num(lost), `worth ${num(p.losses)} gold`],
      ['Gold earned', num(goldEarned), `${num(s.goldIncome)} from turns · ${num(s.goldKills)} from kills`],
      ['Gold spent', num(goldSpent), `units ${num(s.spentUnits)} · buildings ${num(s.spentUpgrades)} · research ${num(s.spentResearch)}`],
      ['Honor earned', num(s.honorKills + s.honorDead), `spent ${num(s.honorSpent)}`],
    ];
    const parts = [nav, head, this.tiles(tiles)];
    if (m.frames.length > 1) parts.push(this.detailCharts(p));
    parts.push(el('div', { class: 'detail-columns' },
      el('section', { class: 'results-section' }, el('h3', {}, 'Army'), this.armyTable(p)),
      el('div', {},
        el('section', { class: 'results-section' }, el('h3', {}, 'Buildings'), this.buildings(p)),
        el('section', { class: 'results-section' }, el('h3', {}, 'Milestones'), this.milestones(p)))));
    return el('div', {}, ...parts);
  }

  tiles(list) {
    return el('div', { class: 'tiles' }, ...list.map(([label, value, sub]) => el('div', { class: 'tile' },
      el('div', { class: 'tile-label' }, label), el('div', { class: 'tile-value' }, value),
      sub ? el('div', { class: 'tile-sub' }, sub) : null)));
  }

  // This player's line in their colour over everyone else's in grey; kills and losses side by side.
  detailCharts(p) {
    const m = this.model;
    const label = (i, short) => this.frameLabel(i, short);
    const against = (key) => [
      ...m.players.filter((q) => q.id !== p.id).map((q) => ({ id: q.id, name: q.name || q.colorName, color: q.color, values: q.values[key] || [], dim: true })),
      { id: p.id, name: p.name || p.colorName, color: ink(p.color), values: p.values[key] || [] },
    ];
    const card = (title, tip, series, legend) => {
      const c = this.chart({ height: 190 });
      c.set({ count: m.frames.length, label, series });
      return el('div', { class: 'chart-card' }, el('div', { class: 'chart-card-head' }, el('h4', { title: tip }, title), legend), c.root);
    };
    const key = (color, text) => el('span', { class: 'legend-item' }, el('i', { class: 'line-key', style: `background:${color}` }), text);
    const mine = key(ink(p.color), this.tag(p, false, false));
    const others = key(DIM_LINE, el('span', { class: 'muted' }, 'other players'));
    const legend = () => el('div', { class: 'chart-legend inline' }, mine.cloneNode(true), others.cloneNode(true));
    return el('section', { class: 'results-section' },
      el('div', { class: 'chart-grid' },
        card('Cities', METRICS[0].tip, against('cities'), legend()),
        card('Army value', METRICS[2].tip, against('army'), legend()),
        card('Gold per turn', METRICS[3].tip, against('income'), legend()),
        card('Kills and losses', 'Gold value of the enemy units destroyed and of the units lost, so far', [
          { id: 'kills', name: 'Kills', color: KILLS_COLOR, values: p.values.kills || [] },
          { id: 'losses', name: 'Losses', color: LOSSES_COLOR, values: p.values.losses || [] },
        ], el('div', { class: 'chart-legend inline' }, key(KILLS_COLOR, 'Kills'), key(LOSSES_COLOR, 'Losses')))));
  }

  armyTable(p) {
    const s = p.stats;
    const made = { hero: s.heroes, healer: s.healers };
    const rows = UNIT_TYPES.filter((t) => (s.trained[t] || made[t] || s.killed[t] || s.lost[t]));
    if (!rows.length) return el('p', { class: 'muted' }, 'No units trained, destroyed or lost.');
    const table = el('table', { class: 'results-table compact' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Unit'),
        el('th', { class: 'num', title: 'Trained in this player\'s cities (Heroes and Healers: made)' }, 'Trained'),
        el('th', { class: 'num', title: 'Enemy units of this type this player destroyed' }, 'Destroyed'),
        el('th', { class: 'num', title: 'This player\'s units of this type that were destroyed' }, 'Lost'))));
    const tbody = el('tbody');
    for (const t of rows) {
      tbody.append(el('tr', {},
        el('td', { class: 'unit-cell' }, el('img', { src: unitIconURL(p.color, UNIT_TYPES.indexOf(t)), alt: '' }), UNITS[t].name),
        el('td', { class: 'num' }, num(s.trained[t] || made[t] || 0)),
        el('td', { class: 'num kills' }, num(s.killed[t] || 0)),
        el('td', { class: 'num losses' }, num(s.lost[t] || 0))));
    }
    tbody.append(el('tr', { class: 'total-row' }, el('td', {}, 'Total'),
      el('td', { class: 'num' }, num(sum(s.trained) + s.heroes + s.healers)),
      el('td', { class: 'num kills' }, num(sum(s.killed))), el('td', { class: 'num losses' }, num(sum(s.lost)))));
    table.append(tbody);
    return table;
  }

  buildings(p) {
    const s = p.stats;
    const list = UPGRADE_TYPES.filter((k) => s.built[k]);
    if (!list.length) return el('p', { class: 'muted' }, 'No city upgrades built.');
    return el('div', { class: 'build-list' }, ...list.map((k) => el('span', { class: 'build-item', title: CITY_UPGRADES[k].name },
      el('img', { src: upgradeIconURL(k, p.color), alt: '' }), el('span', {}, CITY_UPGRADES[k].name), el('b', {}, `× ${num(s.built[k])}`))));
  }

  // Research, traditions, falling and coming back, leaving, winning: in the order they happened.
  milestones(p) {
    const events = p.stats.events || [];
    if (!events.length) return el('p', { class: 'muted' }, 'Nothing to tell yet.');
    const list = el('ol', { class: 'milestones' });
    for (const [turn, kind, what, level] of events) {
      let icon = null, text;
      if (kind === 'research' && TECHS[what]) {
        const def = TECHS[what];
        icon = techIconURL(what, p.color);
        text = `Researched ${def.name}${def.levels.length > 1 ? ` ${level}` : ''}`;
      } else if (kind === 'tradition' && TRADITIONS[what]) {
        icon = traditionSmallIconURL(what, p.color);
        text = `Learned ${TRADITIONS[what].name}`;
      } else {
        text = {
          fell: 'Fell and became a liberator', back: 'Back in the game', out: 'Eliminated', left: 'Left the game', won: 'Won the game',
        }[kind];
      }
      if (!text) continue;
      list.append(el('li', { class: kind },
        el('span', { class: 'm-turn' }, `Turn ${turn}`),
        icon ? el('img', { src: icon, alt: '' }) : el('i', { class: 'm-dot' }),
        el('span', {}, text)));
    }
    return list;
  }
}

// ------------------------------------------------------------------ Timeline tab
// The map turn by turn: territories in their owners' colours, and beside it the standings and what
// happened in the turn. Play steps through the turns.
class Timeline {
  constructor(results) {
    this.r = results;
    this.g = results.g;
    const m = results.model;
    this.frames = m.frames;
    if (results.frame === null || results.frame >= this.frames.length) results.frame = this.frames.length - 1;
    this.index = results.frame;
    this.playing = false;
    this.raf = 0;
    this.lastStep = 0;
    this.colorOf = (o) => (o < 0 ? NEUTRAL_COLOR : m.colors.get(o) || NEUTRAL_COLOR);

    this.canvas = el('canvas', { class: 'tl-canvas' });
    this.tip = el('div', { class: 'chart-tip tl-tip' });
    this.tip.hidden = true;
    this.mapBox = el('div', { class: 'tl-map' }, this.canvas, this.tip);
    this.canvas.addEventListener('pointermove', (e) => this.hoverCity(e));
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; });

    const btn = (text, title, fn) => el('button', { type: 'button', title, onclick: fn }, text);
    this.playBtn = btn('▶ Play', 'Play the game turn by turn', () => this.toggle());
    this.slider = el('input', {
      type: 'range', min: '0', max: String(this.frames.length - 1), step: '1', value: String(this.index),
      'aria-label': 'Turn', class: 'tl-slider',
    });
    this.slider.addEventListener('input', () => { this.pause(); this.go(Number(this.slider.value)); });
    const speed = el('select', { class: 'tl-speed', title: 'Turns per second while playing' },
      ...SPEEDS.map((v) => el('option', { value: String(v) }, `${v} turn${v === 1 ? '' : 's'}/s`)));
    speed.value = String(this.r.speed);
    speed.addEventListener('change', () => { this.r.speed = Number(speed.value); });
    this.label = el('span', { class: 'tl-label' });
    const controls = el('div', { class: 'tl-controls' },
      btn('⏮', 'The start', () => { this.pause(); this.go(0); }),
      btn('‹', 'Previous turn', () => { this.pause(); this.go(this.index - 1); }),
      this.playBtn,
      btn('›', 'Next turn', () => { this.pause(); this.go(this.index + 1); }),
      btn('⏭', 'The end', () => { this.pause(); this.go(this.frames.length - 1); }),
      this.slider, this.label, speed);

    this.standings = el('ol', { class: 'tl-standings' });
    this.events = el('div', { class: 'tl-events' });
    this.turnHead = el('h3', {});
    this.chart = new LineChart({ height: 130, onPick: (i) => { this.pause(); this.go(i); } });
    const side = el('aside', { class: 'tl-side' },
      this.turnHead,
      el('h4', {}, 'Cities held'), this.standings,
      el('h4', {}, 'This turn'), this.events,
      el('h4', { title: 'Click the graph to go to that turn' }, 'Cities over the game'), this.chart.root);
    this.root = el('div', { class: 'timeline' }, el('div', { class: 'tl-main' }, this.mapBox, controls), side);

    this.chart.set({
      count: this.frames.length, label: (i, short) => results.frameLabel(i, short), cursor: this.index,
      series: m.players.map((p) => ({ id: p.id, name: p.name || p.colorName, color: ink(p.color), values: p.values.cities || [] })),
    });
    this.observer = new ResizeObserver(() => this.draw(performance.now()));
    this.observer.observe(this.mapBox);
    this.loop = this.loop.bind(this);
  }

  start() {
    this.go(this.index, true);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.chart.destroy();
    this.playing = false;
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (this.index >= this.frames.length - 1) this.go(0);
    this.playing = true;
    this.lastStep = performance.now();
    this.playBtn.textContent = '⏸ Pause';
    this.kick();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.playBtn.textContent = '▶ Play';
  }

  go(i) {
    const n = Math.max(0, Math.min(this.frames.length - 1, i));
    this.index = n;
    this.r.frame = n;
    this.slider.value = String(n);
    this.chart.set({ ...this.chart.data, cursor: n });
    this.renderSide();
    this.kick();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  // Steps through the turns while playing; draws the turn shown.
  loop(now) {
    this.raf = 0;
    if (!this.root.isConnected) return;
    if (this.playing && now - this.lastStep >= 1000 / this.r.speed) {
      this.lastStep = now;
      if (this.index >= this.frames.length - 1) this.pause();
      else this.go(this.index + 1);
    }
    this.draw();
    if (this.playing) this.kick();
  }

  // Map scale and offset to fit the whole map in the box.
  fit() {
    const b = this.g.map.bounds, W = this.mapBox.clientWidth, H = this.mapBox.clientHeight;
    const s = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0));
    return { W, H, s, ox: (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s, oy: (H - (b.y1 - b.y0) * s) / 2 - b.y0 * s };
  }

  // The turn's map: territories, cities, the shade around the map. Painted only when the turn or the
  // size of the box changed.
  draw() {
    const f = this.frames[this.index];
    const { W, H, s, ox, oy } = this.fit();
    if (!f || !W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    const key = `${this.index}|${cw}|${ch}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const r = Math.max(2, Math.min(4, s * 18));
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, cw, ch);
    // The map within its bounds only (the land beyond them is cut off at odd places), shaded around.
    const b = this.g.map.bounds;
    const bx = b.x0 * s + ox, by = b.y0 * s + oy, bw = (b.x1 - b.x0) * s, bh = (b.y1 - b.y0) * s;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    this.g.renderer.paintMap(ctx, s, 0.85, false, f.owners, this.colorOf);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(8,16,26,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(bx, by, bw, bh);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(201,162,74,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bw) - 1, Math.round(bh) - 1);
    const cities = this.g.map.cities;
    ctx.strokeStyle = 'rgba(20,12,6,0.9)';
    ctx.lineWidth = 1;
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i];
      ctx.fillStyle = this.colorOf(f.owners[i]);
      ctx.beginPath(); ctx.arc(c.x * s + ox, c.y * s + oy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // A city under the pointer: its name and who held it at this turn.
  hoverCity(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { s, ox, oy } = this.fit();
    let best = -1, bd = 10;
    this.g.map.cities.forEach((c, i) => {
      const d = Math.hypot(c.x * s + ox - mx, c.y * s + oy - my);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) { this.tip.hidden = true; return; }
    const f = this.frames[this.index], c = this.g.map.cities[best], o = f.owners[best];
    const region = this.g.map.countries[c.c]?.n;
    const taken = this.index > 0 && f.changes.some((x) => x.city === best);
    this.tip.replaceChildren(el('div', { class: 'chart-tip-head' }, c.n, region ? el('span', { class: 'muted' }, ` · ${region}`) : null),
      el('div', {}, o >= 0 ? this.r.tagOf(o) : el('span', { class: 'muted' }, 'neutral'), taken ? el('span', { class: 'muted' }, ' · taken this turn') : null));
    this.tip.hidden = false;
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${mx + 14 + w > rect.width ? mx - 14 - w : mx + 14}px`;
    this.tip.style.top = `${Math.max(0, my - 10)}px`;
  }

  // The turn, the standings, and what happened in it.
  renderSide() {
    const f = this.frames[this.index], prev = this.frames[this.index - 1];
    const label = this.index === 0 ? 'The start' : f.end ? 'The end' : `Turn ${f.turn}`;
    this.turnHead.replaceChildren(label, el('span', { class: 'muted small' }, `  ${clock(f.time)}`));
    this.label.textContent = `${this.index === 0 ? 'Start' : f.end ? `End (turn ${f.turn})` : `Turn ${f.turn}`} · ${this.index + 1}/${this.frames.length}`;

    // Standings: cities held at this turn, the most first.
    const rows = [...f.players].sort((a, b) => b[1].cities - a[1].cities);
    const top = Math.max(1, ...rows.map(([, v]) => v.cities));
    const neutral = f.owners.filter((o) => o < 0).length;
    this.standings.replaceChildren(...rows.map(([id, v]) => {
      const color = this.colorOf(id);
      const was = prev?.players.get(id)?.cities;
      const delta = prev && was !== undefined ? v.cities - was : 0;
      return el('li', {},
        el('span', { class: 'tl-name' }, this.r.tagOf(id)),
        el('span', { class: 'tl-bar' }, el('i', { style: `width:${(v.cities / top) * 100}%;background:${ink(color)}` })),
        el('b', {}, num(v.cities)),
        el('small', { class: delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted' }, delta ? `${delta > 0 ? '+' : ''}${delta}` : ''));
    }), el('li', { class: 'muted small tl-neutral' }, `${neutral} neutral`));

    // What happened: cities that changed hands, grouped by who took them from whom, then players' events.
    const out = [];
    if (this.index === 0) {
      out.push(el('p', { class: 'muted' }, 'Every player starts with their first cities.'));
    } else {
      const groups = new Map();
      for (const c of f.changes) {
        const k = `${c.to}|${c.from}`;
        if (!groups.has(k)) groups.set(k, { to: c.to, from: c.from, cities: [] });
        groups.get(k).cities.push(this.g.map.cities[c.city].n);
      }
      const list = [...groups.values()].sort((a, b) => b.cities.length - a.cities.length);
      for (const gr of list) {
        const names = gr.cities.join(', ');
        if (gr.to < 0) out.push(el('p', {}, names, ' became neutral', gr.from >= 0 ? el('span', {}, ' (held by ', this.r.tagOf(gr.from), ')') : null));
        else if (gr.from < 0) out.push(el('p', {}, this.r.tagOf(gr.to), ` took ${names}`, el('span', { class: 'muted' }, ' (neutral)')));
        else out.push(el('p', {}, this.r.tagOf(gr.to), ` took ${names} from `, this.r.tagOf(gr.from)));
      }
      const from = prev ? prev.turn : 0;
      for (const p of this.r.model.players) {
        for (const [turn, kind, what, level] of p.stats?.events || []) {
          if (turn <= from || (!f.end && turn > f.turn)) continue;
          const text = kind === 'research' && TECHS[what]
            ? ` researched ${TECHS[what].name}${TECHS[what].levels.length > 1 ? ` ${level}` : ''}`
            : kind === 'tradition' && TRADITIONS[what] ? ` learned ${TRADITIONS[what].name}`
              : { fell: ' fell and became a liberator', back: ' is back in the game', out: ' was eliminated', left: ' left the game', won: ' won the game' }[kind];
          if (text) out.push(el('p', { class: `ev ${kind}` }, this.r.tagOf(p.id), text));
        }
      }
      if (!out.length) out.push(el('p', { class: 'muted' }, 'No city changed hands.'));
    }
    this.events.replaceChildren(...out);
  }
}
