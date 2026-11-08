// DOM HUD: resource bar, selection panel (city production / units / info), feed, overlays.
import {
  UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, ECONOMY, DISBAND, LIBERATOR, TECHS, TECH_TYPES,
  TECH_TABS, PLAYER_COLOR_NAMES,
} from '/shared/config.js';
import { nextLevel, liberatorIncome, influenceLimit } from '/shared/tech.js';
import { unitIconURL, upgradeIconURL } from './sprites.js';
import { UNIT_CLASSES } from './units/index.js';
import { BalanceEditor } from './balance-editor.js';

const $ = (id) => document.getElementById(id);
const HINT_CLOSED_KEY = 'coe.hintClosed';   // the player closed the "how to play" tip (localStorage)

function loadHintClosed() {
  try { return localStorage.getItem(HINT_CLOSED_KEY) === '1'; } catch { return false; }
}

// Colours too dark to read on the dark HUD panels (contrast below 3.8:1, e.g. Navy, Black, Maroon,
// Purple). Names in such a colour get a light backing instead (CSS .who.dark).
const PANEL_LUMINANCE = 0.0068;      // the feed's background, about #19130c
const darkCache = new Map();
function tooDark(hex) {
  if (!darkCache.has(hex)) {
    const n = parseInt(String(hex).slice(1), 16);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const l = Number.isNaN(n) ? 1 : 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    darkCache.set(hex, (l + 0.05) / (PANEL_LUMINANCE + 0.05) < 3.8);
  }
  return darkCache.get(hex);
}

// A player or city name written in a player's colour, readable on the dark panels.
export function colorTag(text, color) {
  const s = document.createElement('b');
  s.className = `who${tooDark(color) ? ' dark' : ''}`;
  s.style.color = color;
  s.textContent = text;
  return s;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export class Hud {
  constructor(game) {
    this.g = game;
    this.panel = $('panel');
    this.panelKey = null;
    this.picks = new Set();   // unit icons marked with Shift + click: the selection once Shift is released
    // Right-hand column for your selected cities: upgrades on top, units to train below.
    this.buildCol = $('build-col');
    this.upgradeBox = $('upgrade-box');
    this.unitBox = $('unit-box');
    this.colKey = null;
    this.colButtons = null;
    this.hintClosed = loadHintClosed();
    this.lastUpdate = 0;
    this.feedEl = $('feed');
    this.dyn = {};
    this.bannerTimer = 0;

    this.editor = new BalanceEditor(game.net);
    $('btn-edit').hidden = !game.admin;      // admins only

    this.handlers = [
      [$('btn-edit'), 'click', () => (this.editor.isOpen ? this.editor.close() : this.editor.open(this.g.admin))],
      [$('btn-mapedit'), 'click', () => {
        this.g.setMapEdit(!this.g.mapEdit);
        if (this.g.mapEdit) {
          this.banner('Map editing: drag any city to move it. Moves are saved for every game. ' +
            'Press Rebuild navigation to update territories and paths.', 8000);
        }
      }],
      [$('btn-rebuild'), 'click', () => this.g.rebuildMap()],
      [$('btn-scores'), 'click', () => this.showScores($('scoreboard').hidden)],
      [$('btn-tech'), 'click', () => this.toggleTech()],
      [$('btn-help'), 'click', () => this.toggleHelp()],
      [$('help-close'), 'click', () => this.toggleHelp(false)],
      [$('help-tabs'), 'click', (e) => {
        const tab = e.target.closest('[data-page]');
        if (tab) this.showHelpPage(tab.dataset.page);
      }],
      [$('btn-leave'), 'click', () => {
        if (this.g.ended || confirm('Leave this game? Your cities will become neutral.')) this.g.leave();
      }],
      [$('gameover-leave'), 'click', () => this.g.leave()],
      [window, 'keyup', (e) => { if (e.key === 'Shift') this.applyPicks(); }],
      [window, 'blur', () => this.applyPicks()],         // Shift released outside the page
    ];
    for (const [t, ev, fn] of this.handlers) t.addEventListener(ev, fn);

    $('hud-title').textContent = game.title;
    $('stat-gold').title = `Gold. Every ${ECONOMY.turnSeconds} seconds (one turn) each city you hold pays ` +
      `${ECONOMY.goldPerCityPerTurn} gold, +${ECONOMY.regionBonusPerCity} if you hold every city of its region, ` +
      `more with a Farm. F1 → Economy explains it all.`;
    $('stat-turn').title = `Turns passed since the start, and time until the next turn pays out gold ` +
      `(${ECONOMY.goldPerCityPerTurn} per city, more for Farms and whole regions).`;
    $('gameover').hidden = true;
    $('scoreboard').hidden = true;
    $('help').hidden = true;
    $('tech').hidden = true;
    this.techTab = TECH_TABS[0].id;
    this.techKey = null;
    $('banner').hidden = true;
    this.feedEl.textContent = '';
    this.panel.textContent = '';
    this.buildCol.hidden = true;
    this.mapEditChanged();
  }

  // Edit map is shown to admins only; Rebuild navigation only while editing the map.
  mapEditChanged() {
    const g = this.g, st = g.mapState || {};
    const edit = $('btn-mapedit'), rebuild = $('btn-rebuild');
    edit.hidden = !g.admin;
    edit.textContent = g.mapEdit ? 'Stop editing' : 'Edit map';
    edit.classList.toggle('active', g.mapEdit);
    edit.title = g.mapEdit ? 'Leave map editing'
      : 'Edit the map: drag cities to move them (admins only). Moves are saved for every game.';
    rebuild.hidden = !g.admin || !g.mapEdit;
    rebuild.disabled = !!st.busy;
    rebuild.textContent = st.busy ? 'Rebuilding…' : st.pending ? `Rebuild navigation (${st.pending})` : 'Rebuild navigation';
    rebuild.title = 'Rebuild territories, borders and pathfinding from where the cities stand now' +
      (st.pending ? ` (${st.pending} moved since the last rebuild)` : '');
    $('view').classList.toggle('map-editing', g.mapEdit);
  }

  destroy() {
    for (const [t, ev, fn] of this.handlers) t.removeEventListener(ev, fn);
    clearTimeout(this.bannerTimer);
    this.editor.root.remove();
  }

  // New game balance from the server: rebuild everything that shows stats, costs or times.
  balanceChanged(changed) {
    $('btn-edit').hidden = !this.g.admin;
    this.mapEditChanged();
    this.panelKey = null;
    this.colKey = null;
    this.lastUpdate = 0;
    this.renderScores();
    this.editor.refresh(this.g.admin, changed);
    if (changed) this.feed('An admin changed the game balance');
  }

  // ---------------------------------------------------------------- overlays
  showScores(show) {
    $('scoreboard').hidden = !show;
    if (show) this.renderScores();
  }

  // F1 help. It always opens on Controls; Economy is written from the current numbers
  // (an admin may have changed the Farm) and your current cities each time it is shown.
  toggleHelp(force) {
    const h = $('help');
    h.hidden = force === undefined ? !h.hidden : !force;
    if (!h.hidden) this.showHelpPage('controls');
  }

  showHelpPage(page) {
    if (page === 'economy') this.renderEconomyHelp();
    if (page === 'liberator') this.renderLiberatorHelp();
    for (const tab of $('help-tabs').children) {
      const on = tab.dataset.page === page;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const section of $('help').querySelectorAll('.help-page')) section.hidden = section.dataset.page !== page;
  }

  renderEconomyHelp() {
    const g = this.g, E = ECONOMY, farm = CITY_UPGRADES.farm;
    const row = (what, ...how) => el('tr', {}, el('td', {}, what), el('td', {}, ...how));
    const b = (text) => el('b', {}, String(text));

    // Your regions: the ones you hold completely, and the ones you are closest to completing.
    const regions = g.map.countries.map((co, r) => {
      const ids = g.regionCities[r];
      return { name: co.n, size: ids.length, held: ids.filter((i) => g.cityOwner[i] === g.you).length };
    });
    const whole = regions.filter((r) => r.held === r.size);
    const close = regions.filter((r) => r.held > 0 && r.held < r.size)
      .sort((p, q) => (p.size - p.held) - (q.size - q.held) || q.held - p.held)
      .slice(0, 3);
    const wholeText = whole.length
      ? `Whole regions: ${whole.map((r) => r.name).join(', ')} (+${whole.reduce((s, r) => s + r.size, 0) * E.regionBonusPerCity} gold per turn).`
      : 'You hold no whole region yet.';
    const closeText = close.length
      ? ` Closest to complete: ${close.map((r) => `${r.name} ${r.held}/${r.size}`).join(', ')}.`
      : '';

    $('help-economy').replaceChildren(
      el('h3', {}, 'Economy'),
      el('p', {}, 'Gold pays for units and city upgrades. You pay when you order them, and you start with ',
        b(E.startGold), ' gold. Cities are the only source of gold:'),
      el('table', {},
        row('Every city', 'Every ', b(`${E.turnSeconds} seconds`), ' (one turn) each city you hold pays you ',
          b(`${E.goldPerCityPerTurn} gold`), '. The gold of all your cities arrives at once at the end of the turn.'),
        row('Whole region', 'The map is split into regions: their names are printed on the map and dark lines are ' +
          'their borders (faint lines divide the cities of one region). Hold every city of a region and each of them pays ',
          b(`+${E.regionBonusPerCity} gold`), ' more per turn. Lose one of them and the whole region loses the bonus. ' +
          'A one-city region counts too.'),
        row('Farm', 'A city upgrade: ', b(`${farm.cost} gold`), `, ${farm.buildTime} s to build, then `,
          b(`+${farm.goldPerTurn || 0} gold`), ' per turn from that city. It is destroyed when the city is captured.'),
        row('Capture', 'Take neutral and enemy cities: each one pays you from the next turn on (its upgrades are lost).'),
        row('Refunds', 'Click an item in a production queue to cancel it and get its gold back. If one of your cities ' +
          'is captured, you get back the gold of everything still waiting in its queue.')),
      el('h3', { class: 'help-sub' }, 'Your income'),
      el('p', {}, 'Now ', b(`+${g.myIncome()} gold`), ` per turn from ${g.myCityCount()} cities. ${wholeText}${closeText}`),
      el('p', { class: 'muted small' }, 'The top bar shows your gold, your income per turn and the time to the next payout. ' +
        'Tab shows every player\'s income. Select a city to see what it pays and how much of its region its owner holds.'),
    );
  }

  // F1 → Liberator: the game option Death: Liberator and the Rebellion technologies, from the current numbers.
  renderLiberatorHelp() {
    const g = this.g, L = LIBERATOR, T = TECHS;
    const row = (what, ...how) => el('tr', {}, el('td', {}, what), el('td', {}, ...how));
    const b = (text) => el('b', {}, String(text));
    const costs = (key) => T[key].levels.map((l) => l.cost).join(' / ');
    const times = (key) => [...new Set(T[key].levels.map((l) => `${l.time} s`))].join(' / ');
    const on = g.options.death === 'liberator';
    $('help-liberator').replaceChildren(
      el('h3', {}, 'Liberator'),
      el('p', {}, 'With the game option ', b('Death: Liberator'), ' (the default) a player who loses every city and every ' +
        'unit is not out of the game: they become a liberator and can take cities back. With ', b('Death: Spectator'),
        ' they are out and can only watch. ', b(on ? 'This game uses Liberator.' : 'This game uses Spectator: none of this applies.')),
      el('table', {},
        row('Falling', 'You lose all your gold and become a liberator. Every turn you get ', b(`${L.goldPerTurn} gold`), '.'),
        row('Liberating', 'Click any city on the map and press ', b('Liberate'), ': it becomes yours, like a capture ' +
          '(its upgrades are lost and its owner gets the gold of its queue back), and you are back in the game. ' +
          'After a liberation the next one waits ', b(`${L.cooldownTurns} turns`), '.'),
        row('Protection', 'A player who holds ', b(`${L.protectedCities} cities or fewer`), ' is safe from liberators. ' +
          'Neutral cities can always be taken.'),
        row('Falling again', 'All your gold is lost again, and you are a liberator again.'),
        row('Technologies', 'The ', b('Tech'), ' button (', b('T'), ') opens the ', b('Rebellion'), ' tab. You research ' +
          'with gold, one technology at a time, also while you still have cities; they work only while you are a liberator.'),
        row('Supporters', `+${T.supporters.goldPerTurnPerLevel} liberator gold per turn per level (3 levels: `,
          b(`+${T.supporters.goldPerTurnPerLevel}, +${2 * T.supporters.goldPerTurnPerLevel}, +${3 * T.supporters.goldPerTurnPerLevel}`),
          `). Cost ${costs('supporters')} gold, ${times('supporters')} each.`),
        row('Influencer', 'Instead of taking one city, mark (influence) several, one per turn: ',
          b(`${influenceLimit({ influencer: 1 })}, ${influenceLimit({ influencer: 2 })} or ${influenceLimit({ influencer: 3 })}`),
          ' cities with levels 1 to 3. When the last one is marked they all become yours at once; ',
          b('Liberate now'), ' takes the marked ones earlier. Everyone sees the marks on the map (a dashed ring in ' +
          `the liberator's colour). Only one liberator can mark a city. Cost ${costs('influencer')} gold, ${times('influencer')} each.`),
        row('Smuggling', `Mark 1, 2 or 3 cities (levels 1 to 3) to smuggle from: at the end of every turn `,
          b(`${Math.round(T.smuggling.share * 100)}% of each one's income`), ' goes from its owner to you. These marks ' +
          'are separate from influence marks (a gold coin on the map), and only one liberator can smuggle from a city. ' +
          'Click a smuggled city again to stop. Back in the game, your marks are gone. ' +
          `Cost ${costs('smuggling')} gold, ${times('smuggling')} each.`)),
      el('p', { class: 'muted small' }, 'Fallen players are shown as Liberator in the Players list (Tab), with their income.'),
    );
  }

  // ---------------------------------------------------------------- Tech window (T)
  toggleTech(force) {
    const box = $('tech');
    box.hidden = force === undefined ? !box.hidden : !force;
    this.techKey = null;
    this.renderTech();
  }

  // Rebuilt only when what it shows changes (levels, the research running, the tab), so a click
  // never lands on a replaced button; progress and gold are kept current by refreshTech().
  renderTech() {
    const box = $('tech');
    if (box.hidden) return;
    const g = this.g, r = g.research;
    const key = [this.techTab, JSON.stringify(g.myTech()), r ? r.tech : '', g.options.death].join('|');
    if (key === this.techKey) { this.refreshTech(); return; }
    this.techKey = key;
    this.techDyn = [];
    const tabs = el('div', { class: 'help-tabs', role: 'tablist' });
    for (const t of TECH_TABS) {
      const open = !t.death || g.options.death === t.death;
      tabs.append(el('button', {
        type: 'button', role: 'tab', class: t.id === this.techTab ? 'active' : '',
        title: open ? '' : 'Only in games with the option Death: Liberator',
        onclick: () => { this.techTab = t.id; this.techKey = null; this.renderTech(); },
      }, t.name));
    }
    const tab = TECH_TABS.find((t) => t.id === this.techTab);
    const body = el('div', { class: 'tech-page' });
    if (tab.death && g.options.death !== tab.death) {
      body.append(el('p', { class: 'muted' }, `${tab.name} technologies exist only in games with the option ` +
        'Death: Liberator. This game uses Death: Spectator.'));
    } else {
      if (tab.id === 'rebellion') {
        body.append(el('p', { class: 'muted small' }, 'Rebellion technologies work only while you are a liberator ' +
          '(after losing every city and unit). You can research them at any time, also before you fall. ' +
          'One research at a time; cancel it to get its gold back. F1 → Liberator explains it all.'));
      }
      for (const k of TECH_TYPES.filter((t) => TECHS[t].tab === tab.id)) body.append(this.techCard(k));
    }
    box.replaceChildren(el('h3', {}, 'Technologies'), tabs, body,
      el('button', { type: 'button', class: 'primary tech-close', onclick: () => this.toggleTech(false) }, 'Close'));
    this.refreshTech();
  }

  techEffect(key, level) {
    const T = TECHS, max = T[key].levels.length;
    const then = (now, next) => (level < max ? `Now ${now}; next level ${next}.` : `Now ${now}.`);
    if (key === 'supporters') {
      return `As a liberator you get ${T.supporters.goldPerTurnPerLevel} more gold per turn for each level. ` +
        then(`${liberatorIncome({ supporters: level })} gold per turn`, `${liberatorIncome({ supporters: level + 1 })}`);
    }
    if (key === 'influencer') {
      return 'Mark cities to liberate, one per turn, and take them all at once when the last one is marked ' +
        '(or earlier with Liberate now). Everyone sees the marks. ' +
        then(`${influenceLimit({ influencer: level })} ${level ? 'cities' : 'city, taken at once'}`, `${influenceLimit({ influencer: level + 1 })}`);
    }
    return `Mark cities to smuggle from: at the end of every turn ${Math.round(T.smuggling.share * 100)}% of each ` +
      "one's income goes from its owner to you. Separate from influence marks. " +
      then(`${level * T.smuggling.citiesPerLevel} ${level === 1 ? 'city' : 'cities'}`, `${(level + 1) * T.smuggling.citiesPerLevel}`);
  }

  techCard(key) {
    const g = this.g, def = TECHS[key], level = g.myTech()[key] || 0, max = def.levels.length;
    const next = nextLevel(key, level), r = g.research;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const card = el('div', { class: 'tech-card' },
      el('div', { class: 'tech-head' },
        el('b', {}, def.name),
        el('span', { class: 'pips', title: `Level ${level} of ${max}` }, ...def.levels.map((_, i) => el('i', { class: i < level ? 'on' : '' }))),
        el('span', { class: 'muted small' }, `Level ${level}/${max}`)),
      el('div', { class: 'tech-text' }, this.techEffect(key, level)));
    if (r && r.tech === key && next) {
      const fill = el('i'), left = el('span', { class: 'muted small' });
      card.append(el('div', { class: 'tech-actions' },
        el('div', { class: 'tech-progress' }, fill), left,
        el('button', { type: 'button', title: `Stop and get ${next.cost} gold back`, onclick: () => this.g.cancelResearch() }, 'Cancel')));
      this.techDyn.push({ kind: 'progress', fill, left, time: next.time, fmt });
    } else if (next) {
      const btn = el('button', {
        type: 'button', class: 'primary',
        onclick: (e) => { e.currentTarget.disabled = true; this.g.startResearch(key); },
      }, `Research level ${next.level}`);
      card.append(el('div', { class: 'tech-actions' }, btn, el('span', { class: 'muted small' }, `${next.cost} gold · ${fmt(next.time)}`)));
      this.techDyn.push({ kind: 'button', btn, cost: next.cost });
    } else {
      card.append(el('div', { class: 'tech-actions muted small' }, 'Fully researched'));
    }
    return card;
  }

  refreshTech() {
    const g = this.g, r = g.research;
    for (const d of this.techDyn || []) {
      if (d.kind === 'progress') {
        const done = r ? r.progress : 0;
        d.fill.style.width = `${Math.min(1, done / d.time) * 100}%`;
        const text = `${d.fmt(Math.max(0, d.time - done))} left`;
        if (d.left.textContent !== text) d.left.textContent = text;
      } else {
        const busy = !!r, poor = g.gold < d.cost;
        d.btn.disabled = busy || poor;
        d.btn.title = busy ? `Already researching ${TECHS[r.tech].name}: one at a time` : poor ? `Needs ${d.cost} gold` : '';
      }
    }
  }

  closeOverlays() {
    const open = !$('help').hidden || !$('scoreboard').hidden || !$('tech').hidden || this.editor.isOpen;
    $('help').hidden = true;
    $('tech').hidden = true;
    $('scoreboard').hidden = true;
    this.editor.close();
    return open;
  }

  renderScores() {
    const sb = $('scoreboard');
    if (sb.hidden) return;
    const g = this.g;
    const rows = [...g.players.values()].sort((a, b) => b.cities - a.cities || b.units - a.units);
    sb.textContent = '';
    sb.append(el('h3', {}, 'Players'));
    const gold = (n) => Math.round(n || 0).toLocaleString('en-US');
    const incomes = g.incomes();
    const table = el('table', {},
      el('tr', {}, el('th', {}, ''), el('th', {}, 'Player'), el('th', {}, 'Cities'),
        el('th', { class: 'num', title: 'Gold the player\'s cities pay at the end of every turn (Farms and whole regions included)' }, 'Gold/turn'),
        el('th', {}, 'Units'),
        el('th', { class: 'num', title: 'Gold value of enemy units this player destroyed' }, 'Kills'),
        el('th', { class: 'num', title: 'Gold value of units this player lost' }, 'Losses'),
        el('th', {}, '')));
    for (const p of rows) {
      const status = p.eliminated ? 'Eliminated'
        : [p.liberator ? 'Liberator' : '', !p.connected ? 'Disconnected' : ''].filter(Boolean).join(' · ');
      // Players are known by colour; nicknames arrive only once the game is over.
      const who = g.nameOf(p.id);
      table.append(el('tr', { class: p.id === g.you ? 'me-row' : '' },
        el('td', {}, el('span', { class: 'swatch', style: `background:${p.color}` })),
        el('td', {}, who, p.name ? el('span', { class: 'muted' }, ` · ${p.name}`) : null),
        el('td', {}, String(p.cities)),
        el('td', { class: 'num income' }, `+${gold(incomes.get(p.id))}`),
        el('td', {}, String(p.units)),
        el('td', { class: 'num kills' }, gold(p.kills)),
        el('td', { class: 'num losses' }, gold(p.losses)),
        el('td', { class: 'muted small' }, status)));
    }
    sb.append(table);
    const neutral = g.cityOwner.filter((o) => o < 0).length;
    const need = g.citiesToWin();
    sb.append(el('p', { class: 'muted small' },
      `Kills and losses are in gold: the cost of the units destroyed. ${neutral} neutral cities · ` +
      `${need} cities win${g.countdownRunning() ? ', one fewer at the end of every turn' : ''}`));
  }

  // Identities are no longer secret: name the winner and reveal every player's colour and nickname.
  // `name` arrives from the lobby server shortly after the game ends (the host never has it);
  // `reason` explains a game that ended early, e.g. the host left.
  showGameOver(winnerId, name, reason = null) {
    const g = this.g;
    $('gameover').hidden = false;
    if (reason) {
      $('gameover-title').textContent = 'Game over';
      $('gameover-text').textContent = reason;
    } else if (winnerId === g.you) {
      $('gameover-title').textContent = 'Victory!';
      $('gameover-text').textContent = 'Europe bows before you.';
    } else if (winnerId >= 0) {
      $('gameover-title').textContent = 'Defeat';
      $('gameover-text').textContent = name ? `${name} (${g.nameOf(winnerId)}) has conquered Europe.`
        : `${g.nameOf(winnerId)} has conquered Europe.`;
    } else {
      $('gameover-title').textContent = 'Game over';
      $('gameover-text').textContent = 'No one is left standing.';
    }
    const list = $('gameover-players');
    list.textContent = '';
    const rows = [...g.players.values()].sort((a, b) => (b.id === winnerId) - (a.id === winnerId) || b.cities - a.cities);
    for (const p of rows) {
      list.append(el('li', { class: p.id === g.you ? 'me-row' : '' },
        el('span', { class: 'swatch', style: `background:${p.color}` }),
        el('b', {}, PLAYER_COLOR_NAMES[p.color] || '?'),
        el('span', {}, p.name || ''),
        el('span', { class: 'muted small' },
          `${p.id === winnerId ? 'winner · ' : ''}${p.id === g.you ? 'you · ' : ''}${p.cities} cities`)));
    }
    list.hidden = !rows.length;
  }

  banner(text, ms = 6000) {
    const b = $('banner');
    b.textContent = text;
    b.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
  }

  // `parts`: text, or an array of strings and elements (e.g. colorTag) shown in a row.
  feed(parts, cls = '') {
    const d = el('div', { class: cls }, ...(Array.isArray(parts) ? parts : [parts]));
    this.feedEl.append(d);
    while (this.feedEl.children.length > 6) this.feedEl.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0'; }, 7000);
    setTimeout(() => d.remove(), 7700);
  }

  // Cities needed to win, next to your own count. With a countdown it drops every turn (▾).
  updateWinTarget() {
    const g = this.g, o = g.options;
    const need = g.citiesToWin(), running = g.countdownRunning();
    const key = `${need}:${running}`;
    if (key === this.winKey) return;
    this.winKey = key;
    $('hud-win').textContent = `/ ${need}${running ? ' ▾' : ''}`;
    let tip = `Cities you hold. ${need} cities win the game.`;
    if (running) tip += `
The target drops by one city at the end of every turn (it started at ${o.winCities}).`;
    else if (o.countdown === 'turn' && (g.turn || 0) < o.countdownTurn) tip += `
Once turn ${o.countdownTurn} is over, it drops by one city at the end of every turn.`;
    $('stat-cities').title = tip;
  }

  // ---------------------------------------------------------------- per frame
  update(now) {
    if (now - this.lastUpdate < 100) return;
    this.lastUpdate = now;
    const g = this.g;
    const me = g.players.get(g.you);
    const myCities = g.myCityCount();
    $('hud-gold').textContent = String(g.gold);
    $('hud-income').textContent = `+${g.myIncome()}/turn`;
    $('hud-turn').textContent = String(g.turn || 0);
    const left = g.secondsToNextTurn(now);
    if (left !== null) {
      const s = Math.ceil(left);
      $('hud-turn-next').textContent = `next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('stat-turn').classList.toggle('soon', s <= 10);
    }
    $('hud-cities').textContent = String(myCities);
    this.updateWinTarget();
    $('hud-units').textContent = String(g.ownUnitCount());
    // Death: Liberator. Every time you fall, say what you can do now.
    const liberator = g.isLiberator();
    if (liberator && !this.liberatorShown) {
      this.banner(`You have fallen and lost all your gold. As a liberator you get ${liberatorIncome(g.myTech())} gold ` +
        'every turn and can take cities back: click any city and press Liberate. Rebellion technologies (T) make you stronger.', 12000);
    }
    this.liberatorShown = liberator;
    this.renderTech();
    if (me && me.eliminated && !g.ended && !this.eliminatedShown) {
      this.eliminatedShown = true;
      this.banner('You have been eliminated. You can keep watching or leave.', 10000);
    }
    this.updatePanel();
  }

  panelState() {
    const g = this.g;
    if (g.selectedCities.size > 1) {
      const ids = [...g.selectedCities].sort((a, b) => a - b);
      return { key: `cities:${ids.join(',')}`, kind: 'cities', ids };
    }
    if (g.selectedCity >= 0) {
      const ci = g.selectedCity;
      const q = g.myQueues.get(ci);
      return { key: `city:${ci}:${q ? q.queue.join(',') : ''}:${g.cityUpgrades[ci]}`, kind: 'city', id: ci, ids: [ci], q };
    }
    if (g.selection.size) {
      const ids = this.sortedSelection();
      return { key: `units:${ids.join(',')}`, kind: 'units', ids };
    }
    if (g.inspect) {
      const { k, id } = g.inspect;
      // A liberator's buttons change with their marks, limits and the turns they still have to wait.
      const lib = g.isLiberator() && k === 'c' ? this.liberatorKey(id) : '';
      if (k === 'c') return { key: `ic:${id}:${g.cityOwner[id]}:${g.cityUpgrades[id]}:${lib}`, kind: 'icity', id };
      const u = g.unitById.get(id);
      if (u) return { key: `iu:${id}`, kind: 'iunit', u };
    }
    if (g.isLiberator()) return { key: `lib:${this.liberatorKey()}`, kind: 'liberator' };
    return { key: 'none', kind: 'none' };
  }

  // The selected units as the panel shows them: by type, then oldest first, so an icon never moves while you aim at it.
  sortedSelection() {
    const g = this.g;
    const type = (id) => g.unitById.get(id)?.t ?? 0;
    return [...g.selection].sort((a, b) => type(a) - type(b) || a - b);
  }

  // A press on the panel's unit icons (one unit, or every unit of a type). Click: select only them.
  // Ctrl + click: remove them from the selection. Shift + click: mark them (again: unmark); when Shift is
  // released, the marked units become the selection.
  pickUnits(ids, e) {
    const g = this.g;
    if (e.ctrlKey || e.metaKey) {
      for (const id of ids) {
        g.deselect(id);
        this.picks.delete(id);
      }
    } else if (e.shiftKey) {
      const unmark = ids.every((id) => this.picks.has(id));
      for (const id of ids) {
        if (unmark) this.picks.delete(id);
        else this.picks.add(id);
      }
    } else {
      this.picks.clear();
      g.select(ids, false);
    }
    this.updatePanel();
  }

  // Shift released: the units marked on the panel become the selection.
  applyPicks() {
    if (!this.picks.size) return;
    const ids = [...this.picks].filter((id) => this.g.selection.has(id));   // not the ones that died meanwhile
    this.picks.clear();
    if (ids.length) this.g.select(ids, false);
    this.updatePanel();
  }

  updatePanel() {
    const st = this.panelState();
    if (st.key !== this.panelKey) {
      this.panelKey = st.key;
      // A death rebuilds the unit icons: keep them scrolled where they were (read before they leave the page).
      const tiles = this.dyn?.unitTiles;
      const scroll = tiles ? { ids: tiles.byId, top: tiles.box.scrollTop } : null;
      this.dyn = {};
      this.panel.textContent = '';
      // With nothing selected the panel shows a tip; once the tip is closed, the panel only appears for a selection.
      this.panel.hidden = st.kind === 'none' && this.hintClosed;
      if (st.kind === 'city') this.buildCityPanel(st);
      else if (st.kind === 'cities') this.buildCitiesPanel(st);
      else if (st.kind === 'units') {
        this.buildUnitsPanel(st);
        if (scroll && st.ids.every((id) => scroll.ids.has(id))) this.dyn.unitTiles.box.scrollTop = scroll.top;
      }
      else if (st.kind === 'icity') this.buildCityInfo(st.id);
      else if (st.kind === 'iunit') this.buildUnitInfo(st.u);
      else if (st.kind === 'liberator') this.buildLiberatorPanel();
      else if (!this.hintClosed) this.buildHint();
    }
    // The column is rebuilt only when the selected cities change, not on every queue change,
    // so a click does not replace the button under the mouse.
    const own = st.kind === 'city' || st.kind === 'cities';
    const colKey = own ? `${st.kind}:${st.ids.join(',')}` : '';
    if (colKey !== this.colKey) {
      this.colKey = colKey;
      this.buildProduction(own ? st : null);
    }
    this.refreshDynamic(st);
  }

  buildHint() {
    this.panel.append(
      el('button', {
        type: 'button', class: 'panel-close', 'aria-label': 'Close',
        title: 'Close. The panel still opens when you select units or cities.',
        onclick: () => this.closeHint(),
      }, '×'),
      el('div', { class: 'hint' },
        'Click one of your cities to raise troops. Drag to select units, right-click to move or attack.',
        el('br'), 'Press ', el('b', {}, 'F1'), ' for all controls.'));
  }

  closeHint() {
    this.hintClosed = true;
    try { localStorage.setItem(HINT_CLOSED_KEY, '1'); } catch { /* private mode: closed for this page only */ }
    this.panel.hidden = true;
    this.panel.textContent = '';
  }

  cityHeader(ci) {
    const g = this.g;
    const c = g.map.cities[ci];
    const owner = g.cityOwner[ci];
    const ownerName = owner === g.you ? 'yours' : g.nameOf(owner);    // a colour, never a nickname
    this.panel.append(
      el('div', { class: 'head' },
        el('span', { class: 'swatch', style: `background:${g.colorOf(owner)}` }),
        el('h4', {}, c.n),
        el('span', { class: 'sub' }, `${g.map.countries[c.c].n} · ${ownerName}`)),
    );
    const hpFill = el('i');
    const hpText = el('b');
    const built = UPGRADE_TYPES.filter((key) => g.hasUpgrade(ci, key)).map((key) => CITY_UPGRADES[key].name);
    this.panel.append(el('div', { class: 'hpbar' }, hpFill));
    this.panel.append(el('div', { class: 'stats' },
      el('span', {}, 'HP ', hpText),
      el('span', {}, 'Damage ', el('b', {}, `${g.cityDamage(ci)}/s`)),
      el('span', {}, 'Range ', el('b', {}, String(Math.round(g.cityRange(ci))))),
      el('span', {}, 'Regen ', el('b', {}, `${CITY.hpRegen}/s`)),
      el('span', {}, 'Gold ', el('b', {}, `+${g.cityIncome(ci)}/turn`)),
      this.regionStat(ci),
      g.cityTrainRate(ci) > 1
        ? el('span', {}, 'Training ', el('b', {}, `+${Math.round((g.cityTrainRate(ci) - 1) * 100)}%`)) : null,
      el('span', {}, 'Upgrades ', el('b', {}, built.length ? built.join(', ') : 'none'))));
    this.dyn.cityHp = { fill: hpFill, text: hpText, ci };
    // Liberators' marks on this city (kept current in refreshDynamic).
    const marks = el('div', { class: 'city-marks' });
    marks.hidden = true;
    this.panel.append(marks);
    this.dyn.cityMarks = { el: marks, ci, key: null };
  }

  // How much of the city's region its owner holds: all of it makes each of them pay more gold.
  regionStat(ci) {
    const g = this.g;
    const owner = g.cityOwner[ci];
    if (owner < 0) return null;
    const region = g.map.cities[ci].c;
    const ids = g.regionCities[region];
    const held = ids.filter((i) => g.cityOwner[i] === owner).length;
    const name = g.map.countries[region].n;
    const whose = owner === g.you ? 'You hold' : `${g.nameOf(owner)} holds`;
    const bonus = `+${ECONOMY.regionBonusPerCity} gold per turn from each`;
    const all = held === ids.length;
    const title = all
      ? `${whose} every city of ${name}: ${bonus}.`
      : `${whose} ${held} of the ${ids.length} cities of ${name}. Holding all of them gives ${bonus}.`;
    return el('span', { title }, 'Region ', el('b', {}, `${held}/${ids.length}${all ? ' ✓' : ''}`));
  }

  // What an upgrade does, for its button and tooltip.
  upgradeEffect(def) {
    const parts = [];
    if (def.hp) parts.push(`+${def.hp} HP`);
    if (def.rangePercent) parts.push(`+${def.rangePercent}% range`);
    if (def.damage) parts.push(`+${def.damage} damage`);
    if (def.goldPerTurn) parts.push(`+${def.goldPerTurn} gold/turn`);
    if (def.trainSpeedPercent) parts.push(`+${def.trainSpeedPercent}% unit training speed`);
    return parts.join(', ');
  }

  // Unit cost and build time in the selected cities. Barracks shorten the time, so with
  // several cities selected it can be a range.
  unitCostText(def, ids) {
    const fmt = (s) => `${Math.round(s * 10) / 10}s`;
    const times = ids.map((ci) => def.buildTime / this.g.cityTrainRate(ci));
    const lo = Math.min(...times), hi = Math.max(...times);
    const time = hi - lo < 0.05 ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
    return `${def.cost} gold${ids.length > 1 ? ' each' : ''} · ${time}`;
  }

  // Right-hand column for your selected city, or cities: its upgrades on top, the units it can
  // train below. With several cities, one press orders it in each of them. `st` null hides it.
  buildProduction(st) {
    this.colButtons = null;
    this.upgradeBox.textContent = '';
    this.unitBox.textContent = '';
    this.buildCol.hidden = !st;
    if (!st) return;
    const g = this.g;
    const myColor = g.colorOf(g.you);
    const many = st.ids.length > 1;
    const each = many ? ' each' : '';
    const buttons = [];

    // City upgrades: once per city, destroyed when the city is captured.
    this.upgradeBox.append(el('h5', {}, 'Upgrades', el('small', {}, 'once per city')));
    for (const key of UPGRADE_TYPES) {
      const def = CITY_UPGRADES[key];
      const effect = this.upgradeEffect(def);
      const cost = `${def.cost} gold${each} · ${def.buildTime}s`;
      const state = el('span', { class: 'cost' }, cost);
      const btn = el('button', {
        type: 'button', class: 'build-btn',
        title: `${def.name}: ${effect} for the city. Built once per city; destroyed if the city is captured.`,
        onclick: () => g.build(key),
      },
      el('img', { src: upgradeIconURL(key, myColor), alt: '' }),
      el('span', { class: 'nm' }, def.name, def.hotkey ? el('kbd', {}, def.hotkey) : null), state,
      el('span', { class: 'eff' }, effect));
      this.upgradeBox.append(btn);
      buttons.push({ btn, def, item: key, state, cost });
    }

    this.unitBox.append(el('h5', {}, 'Units', many ? el('small', {}, 'one in every city') : null));
    UNIT_TYPES.forEach((type, t) => {
      const def = UNITS[type];
      const range = def.attackRange ? `range ${def.attackRange}` : 'melee';
      const state = el('span', { class: 'cost' }, this.unitCostText(def, st.ids));   // kept current in refreshDynamic
      const btn = el('button', {
        type: 'button', class: 'build-btn', title: UNIT_CLASSES[t].describe(), onclick: () => g.build(type),
      },
      el('img', { src: unitIconURL(myColor, t), alt: '' }),
      el('span', { class: 'nm' }, def.name, el('kbd', {}, def.hotkey)),
      state,
      el('span', { class: 'eff' }, `${def.hp} HP · ${def.damage} dmg/s · ${range}`));
      this.unitBox.append(btn);
      buttons.push({ btn, def, item: type, state });
    });
    this.colButtons = buttons;
  }

  // Several cities selected: the column's orders go to every one of them.
  buildCitiesPanel(st) {
    const g = this.g;
    this.panel.append(el('div', { class: 'head' },
      el('span', { class: 'swatch', style: `background:${g.colorOf(g.you)}` }),
      el('h4', {}, `${st.ids.length} cities selected`)));
    const names = st.ids.map((ci) => g.map.cities[ci].n);
    this.panel.append(el('div', { class: 'stats city-list', title: names.join(', ') }, names.join(' · ')));
    this.panel.append(el('div', { class: 'queue' },
      el('span', { class: 'label' }, 'Each order goes to every selected city, as far as your gold reaches.'),
      el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click map: rally point · Alt + right-click: clear')));
  }

  buildCityPanel(st) {
    const g = this.g, ci = st.id;
    this.cityHeader(ci);
    const myColor = g.colorOf(g.you);

    const queue = el('div', { class: 'queue' }, el('span', { class: 'label' }, 'Queue'));
    const items = st.q ? st.q.queue : [];
    this.dyn.queueProg = null;
    items.forEach((id, idx) => {
      const item = PRODUCTION_ITEMS[id];
      const def = UNITS[item] || CITY_UPGRADES[item];
      const icon = UNITS[item] ? unitIconURL(myColor, UNIT_TYPES.indexOf(item)) : upgradeIconURL(item, myColor);
      const prog = idx === 0 ? el('span', { class: 'prog' }) : null;
      if (prog) this.dyn.queueProg = { el: prog, def };
      queue.append(el('button', {
        type: 'button', class: 'qitem', title: `${def.name} — click to cancel (refund)`,
        onclick: () => g.cancel(ci, idx),
      }, el('img', { src: icon, alt: '' }), prog));
    });
    if (!items.length) queue.append(el('span', { class: 'label' }, '— empty'));
    queue.append(el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click map: rally point · Alt + right-click: clear'));
    this.panel.append(queue);
  }

  buildCityInfo(ci) {
    this.cityHeader(ci);
    const g = this.g;
    const owner = g.cityOwner[ci];
    if (g.isLiberator() && owner !== g.you) {
      this.buildLiberate(ci);
      return;
    }
    this.panel.append(el('div', { class: 'hint small' },
      owner < 0 ? 'Neutral cities defend themselves. Bring its HP to zero to capture it.'
        : 'Enemy city. Select units and right-click it to attack.'));
  }

  // ---------------------------------------------------------------- liberators (Death: Liberator)
  waitText(wait) {
    return wait === 1 ? 'after this turn' : `in ${wait} turns`;
  }

  // What a liberator's panels depend on: rebuilt when it changes.
  liberatorKey(ci = -1) {
    const g = this.g;
    return [g.influenceWait(), g.myInfluence().join(','), g.mySmuggle().join(','), g.influenceLimit(), g.smugglingLimit(),
      ci >= 0 ? `${g.cityOwner[ci]}${g.cityProtected(ci) ? 'p' : ''}${g.otherMark('influence', ci)}:${g.otherMark('smuggle', ci)}` : ''].join('|');
  }

  // One row of a liberator's panel: a button and what it does (or why it can't be used).
  liberatorRow(label, why, text, onclick, primary = true) {
    return el('div', { class: 'liberate' },
      el('button', { type: 'button', class: primary ? 'primary' : '', disabled: why ? '' : null, title: why || text, onclick }, label),
      el('span', { class: 'muted small' }, why || text));
  }

  // "Liberate now": take the cities you marked without waiting for the limit.
  liberateNowRow() {
    const g = this.g, n = g.myInfluence().length, limit = g.influenceLimit();
    if (!n || limit <= 1) return null;
    return this.liberatorRow(`Liberate now (${n})`, '',
      `Take the ${n} marked ${n === 1 ? 'city' : 'cities'} now instead of waiting until ${limit} are marked.`,
      (e) => { e.currentTarget.disabled = true; g.liberateNow(); });
  }

  // A liberator looking at a city: influence (liberate) it, and smuggle from it.
  buildLiberate(ci) {
    const g = this.g, name = g.map.cities[ci].n, owner = g.cityOwner[ci];
    const marks = g.myInfluence(), limit = g.influenceLimit(), wait = g.influenceWait();
    // Not from a small empire (LIBERATOR.protectedCities), and not before the wait is over.
    const held = g.cityProtected(ci) ? g.cityCountOf(owner) : 0;
    let label, text;
    if (limit === 1) {
      label = `Liberate ${name}`;
      text = `It becomes yours, like a capture: its upgrades are lost. After a liberation the next one waits ${LIBERATOR.cooldownTurns} turns.`;
    } else if (marks.length + 1 >= limit) {
      label = `Influence ${name} and liberate all (${limit})`;
      text = `The last mark: all ${limit} marked cities become yours at once, like captures.`;
    } else {
      label = `Influence ${name} (${marks.length + 1}/${limit})`;
      text = `Marks it for liberation (everyone sees it). One mark per turn; when ${limit} are marked they all become yours.`;
    }
    // A city carries one influence mark and one smuggling mark at most: not one another liberator has.
    const rival = g.otherMark('influence', ci), smuggler = g.otherMark('smuggle', ci);
    const why = marks.includes(ci) ? `Marked for liberation (${marks.length}/${limit}).`
      : rival >= 0 ? `${g.nameOf(rival)} has already marked it for liberation: only one liberator can.`
      : held ? `${g.nameOf(owner)} holds only ${held} ${held === 1 ? 'city' : 'cities'}: a liberator can take cities ` +
        `only from players with more than ${LIBERATOR.protectedCities}.`
        : wait > 0 ? `You can ${limit === 1 ? 'take' : 'mark'} another city ${this.waitText(wait)}.` : '';
    this.panel.append(this.liberatorRow(label, why, text, (e) => { e.currentTarget.disabled = true; g.influence(ci); }));
    const now = this.liberateNowRow();
    if (now) this.panel.append(now);

    // Smuggling (its own marks, separate from influence).
    const sLimit = g.smugglingLimit(), smuggling = g.mySmuggle(), on = smuggling.includes(ci);
    if (!sLimit) return;
    const share = Math.round(TECHS.smuggling.share * 100);
    const each = Math.floor(g.cityIncome(ci) * TECHS.smuggling.share);
    const sWhy = on ? ''
      : smuggler >= 0 ? `${g.nameOf(smuggler)} already smuggles from it: only one liberator can.`
        : smuggling.length < sLimit ? '' : `All ${sLimit} smuggling marks are in use: click a smuggled city and stop one first.`;
    const sText = on ? `Stop taking ${share}% of its income.`
      : owner < 0 ? `Pays nothing while neutral; once a player holds it, ${share}% of its income comes to you every turn.`
        : `About ${each} gold per turn from ${g.nameOf(owner)}: ${share}% of the city's income, at the end of every turn.`;
    this.panel.append(this.liberatorRow(on ? 'Stop smuggling' : `Smuggle (${smuggling.length + 1}/${sLimit})`, sWhy, sText,
      () => g.toggleSmuggling(ci), false));
  }

  // A liberator with nothing selected: what they can do.
  buildLiberatorPanel() {
    const g = this.g, marks = g.myInfluence(), limit = g.influenceLimit(), wait = g.influenceWait();
    const sLimit = g.smugglingLimit();
    this.panel.append(el('div', { class: 'head' },
      el('span', { class: 'swatch', style: `background:${g.colorOf(g.you)}` }),
      el('h4', {}, 'Liberator'),
      el('span', { class: 'sub' }, `+${g.myIncome()} gold per turn`)));
    this.panel.append(el('div', { class: 'stats' },
      limit > 1 ? el('span', {}, 'Influenced ', el('b', {}, `${marks.length}/${limit}`)) : null,
      el('span', {}, limit > 1 ? 'Next mark ' : 'Next city ', el('b', {}, wait ? this.waitText(wait) : 'now')),
      el('span', {}, 'Smuggling ', el('b', {}, sLimit ? `${g.mySmuggle().length}/${sLimit}` : 'not researched'))));
    const now = this.liberateNowRow();
    if (now) this.panel.append(now);
    this.panel.append(el('div', { class: 'hint small' },
      'Click any city on the map to ', limit > 1 ? 'influence' : 'liberate', sLimit ? ' or smuggle from' : '', ' it. ',
      `Neutral cities are always free to take; another player's only if they hold more than ${LIBERATOR.protectedCities}. `,
      'Rebellion technologies: ', el('b', {}, 'T'), '.'));
  }

  // Who marked this city: for liberation (influence) and for smuggling. Everyone sees both.
  refreshCityMarks(m) {
    const g = this.g, ci = m.ci;
    const inf = g.marks?.influence.get(ci) || [], sm = g.marks?.smuggle.get(ci) || [];
    const each = sm.length ? g.smuggling().byCity.get(ci) || 0 : 0;
    const key = `${inf.join(',')}|${sm.join(',')}|${each}`;
    if (key === m.key) return;
    m.key = key;
    const parts = [];
    for (const id of inf) {
      const p = g.players.get(id);
      parts.push(el('span', {}, 'Marked for liberation by ', g.who(id), ` (${p.influence.length}/${influenceLimit(p.tech)})`));
    }
    for (const id of sm) parts.push(el('span', {}, 'Smuggled by ', g.who(id), each ? ` (${each} gold per turn)` : ''));
    m.el.replaceChildren(...parts);
    m.el.hidden = !parts.length;
  }

  // Picks on mouse press, not on click: in a battle a death rebuilds the icons, and a click whose press
  // and release land on different buttons is lost. preventDefault keeps the keyboard focus off the button.
  unitPickButton(attrs, ids, ...children) {
    return el('button', {
      type: 'button', ...attrs,
      onmousedown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.pickUnits(ids, e);
      },
    }, ...children);
  }

  // Your selected units: a button per type when there are several, then an icon per unit with its HP.
  // Click one to select only it (or only that type), Ctrl + click to remove it, Shift + click to mark it.
  buildUnitsPanel(st) {
    const g = this.g;
    const myColor = g.colorOf(g.you);
    const n = st.ids.length;
    const marked = el('span', { class: 'sub' });           // "2 marked: release Shift…", kept current
    this.panel.append(el('div', { class: 'head' }, el('h4', {}, `${n} unit${n === 1 ? '' : 's'} selected`), marked));

    const byType = new Map();               // unit type -> its ids, in panel order
    for (const id of st.ids) {
      const t = g.unitById.get(id)?.t ?? 0;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(id);
    }
    const chips = [];
    if (byType.size > 1) {
      const groups = el('div', { class: 'unit-groups' });
      for (const [t, ids] of byType) {
        const def = UNITS[UNIT_TYPES[t]];
        const chip = this.unitPickButton({
          class: 'unit-group',
          title: `${UNIT_CLASSES[t].describe()}\nClick: select only ${def.name.toLowerCase()} · ` +
            'Ctrl + click: remove them · Shift + click: mark them, released Shift selects the marked units',
        }, ids, el('img', { src: unitIconURL(myColor, t), alt: '' }), el('b', {}, String(ids.length)), el('span', {}, def.name));
        groups.append(chip);
        chips.push({ chip, ids });
      }
      this.panel.append(groups);
    }

    const box = el('div', { class: 'unit-tiles' });
    const byId = new Map();
    for (const [t, ids] of byType) {
      const def = UNITS[UNIT_TYPES[t]];
      const img = unitIconURL(myColor, t);
      for (const id of ids) {
        const fill = el('i');
        const tile = this.unitPickButton({ class: 'unit-tile' }, [id],
          el('img', { src: img, alt: def.name }), el('span', { class: 'uhp' }, fill));
        box.append(tile);
        byId.set(id, { tile, fill, def, key: '' });
      }
    }
    this.panel.append(box);
    this.dyn.unitTiles = { box, byId, marked, chips };

    const hpFill = el('i');
    this.panel.append(el('div', { class: 'hpbar', style: 'margin-top:8px' }, hpFill));
    this.dyn.groupHp = hpFill;
    const note = el('div', { class: 'disband-note' });
    note.hidden = true;
    this.panel.append(note);
    this.dyn.groupDisband = note;
    this.panel.append(el('div', { class: 'stats' }, 'Icon: click selects only it · Ctrl + click removes · Shift + click marks, release Shift to select the marked · ' +
      'Right-click: move / attack · A + right-click: attack-move · S: stop · H: hold · Delete: disband · Ctrl+1–9: save group'));
  }

  buildUnitInfo(u) {
    const g = this.g;
    const def = UNITS[UNIT_TYPES[u.t]];
    this.panel.append(el('div', { class: 'head' },
      el('img', { src: unitIconURL(g.colorOf(u.owner), u.t), alt: '', style: 'width:34px;height:34px' }),
      el('h4', {}, def.name),
      el('span', { class: 'sub' }, g.nameOf(u.owner))));
    const hpFill = el('i');
    const hpText = el('b');
    this.panel.append(el('div', { class: 'hpbar' }, hpFill));
    this.panel.append(el('div', { class: 'stats' },
      el('span', {}, 'HP ', hpText),
      el('span', {}, 'Damage ', el('b', {}, `${def.damage}/s`)),
      el('span', {}, 'Range ', el('b', {}, def.attackRange ? String(def.attackRange) : 'melee')),
      el('span', {}, 'Speed ', el('b', {}, String(def.moveSpeed)))));
    const note = el('div', { class: 'disband-note' }, `Disbanding: loses ${DISBAND.hpPerSecond} HP per second until it dies`);
    note.hidden = true;
    this.panel.append(note);
    this.dyn.unitHp = { fill: hpFill, text: hpText, id: u.id, def, note };
  }

  // Each unit icon's HP bar, and which icons are marked with Shift + click.
  refreshUnitTiles(tl) {
    const g = this.g;
    let marked = 0;
    for (const [id, s] of tl.byId) {
      const u = g.unitById.get(id);
      if (!u) continue;
      const picked = this.picks.has(id);
      if (picked) marked++;
      const disbanding = !!(u.flags & 4);
      const key = `${u.hp}|${picked}|${disbanding}`;
      if (key === s.key) continue;
      s.key = key;
      const frac = Math.max(0, Math.min(1, u.hp / s.def.hp));
      s.fill.style.width = `${frac * 100}%`;
      s.fill.style.background = frac > 0.6 ? '#5ccf54' : frac > 0.3 ? '#e8c440' : '#e0503a';   // as the bars on the map
      s.tile.classList.toggle('picked', picked);
      s.tile.classList.toggle('disbanding', disbanding);
      s.tile.title = `${s.def.name}: ${Math.ceil(u.hp)} / ${s.def.hp} HP${disbanding ? ', disbanding' : ''}\n` +
        'Click: select only this unit · Ctrl + click: remove it · Shift + click: mark it, released Shift selects the marked units';
    }
    for (const { chip, ids } of tl.chips) chip.classList.toggle('picked', ids.every((id) => this.picks.has(id)));
    const text = marked ? `${marked} marked: release Shift to select ${marked === 1 ? 'it' : 'them'}` : '';
    if (tl.marked.textContent !== text) tl.marked.textContent = text;
  }

  refreshDynamic(st) {
    const g = this.g, d = this.dyn;
    if (d.cityMarks) this.refreshCityMarks(d.cityMarks);
    if (d.cityHp) {
      const ci = d.cityHp.ci;
      const hp = g.cityHp[ci], maxHp = g.cityMaxHp(ci);
      d.cityHp.fill.style.width = `${(hp / maxHp) * 100}%`;
      d.cityHp.text.textContent = `${Math.ceil(hp)} / ${maxHp}`;
    }
    if (this.colButtons && st.ids) {
      // Usable while there is gold for one and at least one selected city can still take it.
      const full = (ci) => (g.myQueues.get(ci)?.queue.length || 0) >= ECONOMY.maxQueue;
      for (const { btn, def, item, state, cost } of this.colButtons) {
        if (!CITY_UPGRADES[item]) {
          btn.disabled = g.gold < def.cost || st.ids.every(full);
          const text = this.unitCostText(def, st.ids);       // shorter once a Barracks is built
          if (state.textContent !== text) state.textContent = text;
          continue;
        }
        const has = (ci) => g.hasUpgrade(ci, item);
        const queued = (ci) => g.upgradeQueued(ci, item);
        btn.disabled = g.gold < def.cost || st.ids.every((ci) => full(ci) || has(ci) || queued(ci));
        if (st.ids.length === 1) {
          const ci = st.ids[0];
          const text = has(ci) ? 'built' : queued(ci) ? 'in queue' : cost;
          if (state.textContent !== text) state.textContent = text;
          btn.classList.toggle('built', has(ci));
        }
      }
    }
    if (d.queueProg && st.q) {
      d.queueProg.el.style.width = `${Math.min(1, st.q.progress / d.queueProg.def.buildTime) * 100}%`;
    }
    if (d.unitTiles) this.refreshUnitTiles(d.unitTiles);
    if (d.groupHp) {
      let hp = 0, max = 0, disbanding = 0;
      for (const id of g.selection) {
        const u = g.unitById.get(id);
        if (!u) continue;
        hp += u.hp;
        max += UNITS[UNIT_TYPES[u.t]].hp;
        if (u.flags & 4) disbanding++;
      }
      d.groupHp.style.width = `${max ? (hp / max) * 100 : 0}%`;
      d.groupDisband.hidden = !disbanding;
      const text = `${disbanding} disbanding: losing ${DISBAND.hpPerSecond} HP per second until they die`;
      if (disbanding && d.groupDisband.textContent !== text) d.groupDisband.textContent = text;
    }
    if (d.unitHp) {
      const u = g.unitById.get(d.unitHp.id);
      if (u) {
        d.unitHp.fill.style.width = `${(u.hp / d.unitHp.def.hp) * 100}%`;
        d.unitHp.text.textContent = `${u.hp} / ${d.unitHp.def.hp}`;
        d.unitHp.note.hidden = !(u.flags & 4);
      }
    }
  }
}
