// The standings, at the top right of the game: every player's cities, kills and deaths, the most cities first.
// Everyone sees them, players and spectators alike, with players named by colour only, as in the Players list
// (GAME_DESIGN.md, "Anonymous players").
// - Kills and deaths count units (server/game.js recordDeath): enemy units destroyed, and your own units that
//   fell (a disbanded one only when an enemy gets the kill). Hovering one shows the gold it was worth: the
//   Kills and Losses of the Players list (Tab). They come with the scores, once a second.
// - Cities are counted as the map shows them, like the top bar's.
// - A disconnected player's name shows in their colour half faded (style.css, tr.gone).
// - Its head folds it away to just the head, and back; the page remembers that (localStorage).
// - Gone once the game is over: the results screen has it all.
import { el } from './hud.js';

const FOLDED_KEY = 'coe.standingsFolded';
const EVERY_MS = 250;         // how often it looks for changes
const GAP = 8;                // px kept free above the build column and the window's bottom

const num = (n) => Math.round(n || 0).toLocaleString('en-US');
const count = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function loadFolded() {
  try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
}

function saveFolded(folded) {
  try {
    if (folded) localStorage.setItem(FOLDED_KEY, '1');
    else localStorage.removeItem(FOLDED_KEY);
  } catch { /* private mode: for this page only */ }
}

// Why a player's line looks the way it does (its name's tooltip); '' for a player simply playing.
function statusOf(p) {
  if (p.surrendered) return 'Surrendered';
  if (p.eliminated) return 'Eliminated';
  return [p.liberator ? 'Liberator: fallen, taking cities back' : '', p.connected === false ? 'Disconnected' : '']
    .filter(Boolean).join(' · ');
}

// Sets an element's text or tooltip only when it changes: the tooltip of a cell under the mouse stays put
// (tooltip.js moves `title` to `data-tip`, so the last one set is kept here).
function setText(e, text) {
  if (e.textContent !== text) e.textContent = text;
}
function setTip(e, tip) {
  if (e._tip === tip) return;
  e._tip = tip;
  if (tip) e.setAttribute('title', tip);
  else { e.removeAttribute('title'); delete e.dataset.tip; }
}

export class Standings {
  constructor(game) {
    this.g = game;
    this.root = document.getElementById('standings');
    this.rows = new Map();       // player id -> { tr, name, cities, kills, deaths, label }
    this.order = '';             // the player ids in the order shown
    this.lastUpdate = 0;
    this.toggle = el('button', { type: 'button', class: 'standings-toggle', onclick: () => this.setFolded(!this.folded) });
    this.body = el('tbody');
    this.root.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, this.toggle),
        el('th', { title: 'Cities held' }, 'Cities'),
        el('th', { title: 'Enemy units destroyed: whoever lands the last hit gets the kill, and a city\'s kills count ' +
          'for its owner. Hover a number for the gold they were worth.' }, 'Kills'),
        el('th', { title: 'Units fallen: killed, or disbanded while an enemy got the kill. Hover a number for the ' +
          'gold lost.' }, 'Deaths'))),
      this.body));
    this.setFolded(loadFolded(), false);
    this.root.hidden = game.ended;
  }

  setFolded(folded, remember = true) {
    this.folded = folded;
    this.root.classList.toggle('folded', folded);
    this.toggle.textContent = folded ? 'Standings ▾' : 'Standings ▴';
    this.toggle.title = folded ? 'Show every player\'s cities, kills and deaths' : 'Hide the standings';
    this.toggle.setAttribute('aria-expanded', String(!folded));
    if (remember) saveFolded(folded);
    this.lastUpdate = 0;         // unfolded: up to date at once
  }

  destroy() {
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  update(now) {
    if (now - this.lastUpdate < EVERY_MS) return;
    this.lastUpdate = now;
    const g = this.g;
    this.root.hidden = g.ended;  // the results screen has every player's stats
    if (g.ended || this.folded) return;
    // No lower than the build column (your city selected, bottom right): past that it scrolls.
    const col = document.getElementById('build-col');
    const bottom = col.hidden ? window.innerHeight : col.getBoundingClientRect().top;
    const maxHeight = `${Math.max(80, Math.floor(bottom - GAP - this.root.offsetTop))}px`;
    if (this.root.style.maxHeight !== maxHeight) this.root.style.maxHeight = maxHeight;

    // Cities as the map shows them.
    const held = new Map();
    for (const o of g.cityOwner) if (o >= 0) held.set(o, (held.get(o) || 0) + 1);
    // Players still in the game first, the most cities first (then the most kills); the fallen at the bottom.
    const list = [...g.players.values()].map((p) => ({ p, cities: held.get(p.id) || 0 }))
      .sort((a, b) => !!a.p.eliminated - !!b.p.eliminated || b.cities - a.cities ||
        (b.p.killCount || 0) - (a.p.killCount || 0) || a.p.id - b.p.id);

    for (const { p, cities } of list) {
      let r = this.rows.get(p.id);
      if (!r) {
        r = { tr: el('tr'), name: el('td', { class: 'name' }), cities: el('td'), kills: el('td', { class: 'kills' }),
          deaths: el('td', { class: 'deaths' }), label: '' };
        r.tr.append(r.name, r.cities, r.kills, r.deaths);
        this.rows.set(p.id, r);
      }
      const label = `${g.nameOf(p.id)}|${p.color}`;
      if (r.label !== label) {
        r.label = label;
        r.name.replaceChildren(g.who(p.id));
      }
      r.tr.className = [p.id === g.you ? 'me' : '', p.eliminated ? 'out' : '', p.connected === false ? 'gone' : '']
        .filter(Boolean).join(' ');
      setTip(r.name, statusOf(p));
      setText(r.cities, num(cities));
      const kills = p.killCount || 0, deaths = p.deathCount || 0;
      setText(r.kills, num(kills));
      setTip(r.kills, `${count(kills, 'enemy unit')} destroyed, worth ${num(p.kills)} gold`);
      setText(r.deaths, num(deaths));
      setTip(r.deaths, `${count(deaths, 'unit')} fallen. Lost in all, disbanded units included: ${num(p.losses)} gold`);
    }

    const order = list.map(({ p }) => p.id).join(',');
    if (order !== this.order) {
      this.order = order;
      this.body.replaceChildren(...list.map(({ p }) => this.rows.get(p.id).tr));
      for (const id of this.rows.keys()) if (!g.players.has(id)) this.rows.delete(id);
    }
  }
}
