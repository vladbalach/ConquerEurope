// DOM HUD: resource bar, selection panel (city production / units / info), feed, overlays.
import {
  UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, ECONOMY, DISBAND, LIBERATOR, TECHS, TECH_TYPES,
  TECH_TABS, NAVAL, HONOR, TRADITIONS, TRADITION_TYPES, HERO, HEALER, GAME, DEBUG,
} from '/shared/config.js';
import { nextLevel, liberatorIncome, influenceLimit } from '/shared/tech.js';
import { upgradeGrades, higherGrades, topGrades } from '/shared/upgrades.js';
import { CARGO_SHIFT } from '/shared/protocol.js';
import { GOLD_PERCENT } from '/shared/options.js';
import { unitIconURL, unitEmblemURL, upgradeIconURL, techIconURL, traditionIconURL, traditionSmallIconURL } from './sprites.js';
import { UNIT_CLASSES } from './units/index.js';
import { heroName } from './units/Hero.js';
import { BalanceEditor } from './balance-editor.js';
import { Results } from './results.js';
import { HelpWiki } from './help/wiki.js';

const $ = (id) => document.getElementById(id);
const HINT_CLOSED_KEY = 'coe.hintClosed';   // the player closed the "how to play" tip (localStorage)

// The share of a killed unit's cost its killer gets in gold (ECONOMY.killGoldShare), e.g. "25%".
const killShareText = () => `${Math.round(ECONOMY.killGoldShare * 1000) / 10}%`;
// The honor a kill gives (HONOR.killShare of the unit's cost): "its cost", or e.g. "50% of its cost".
const honorShareText = () => (HONOR.killShare === 1 ? 'its cost' : `${Math.round(HONOR.killShare * 1000) / 10}% of its cost`);
const honorFor = (type) => Math.floor(UNITS[type].cost * HONOR.killShare);
// Seconds as m:ss, rounded up (a cooldown shows 0:01 until it is really over).
const clock = (sec) => { const s = Math.ceil(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// How research goes, on every tab of the Tech window.
const RESEARCH_QUEUE_TEXT = 'One research at a time; order more meanwhile and they are queued, each paid when ordered, ' +
  'and researched one after another. Cancel or remove one to get its gold back.';

function loadHintClosed() {
  try { return localStorage.getItem(HINT_CLOSED_KEY) === '1'; } catch { return false; }
}

// Colours too dark to read on the dark HUD panels (contrast below 3.8:1, e.g. Navy, Black, Maroon,
// Purple). Names in such a colour get a light backing instead (CSS .who.dark).
const PANEL_LUMINANCE = 0.0068;      // the feed's background, about #19130c
const darkCache = new Map();
export function tooDark(hex) {
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

export function el(tag, attrs = {}, ...children) {
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
    this.hintClosed = game.spectator || loadHintClosed();   // the tip is how to play: not for a spectator
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
          this.banner('Map editing: drag any city to move it, or click it to make it coastal or inland. Drag a region\'s ' +
            'name to move it, turn the mouse wheel over it to resize it, double-click it to put it back. Paint beach / ' +
            'Erase beach: drag along the coast. Paint mountains / Erase mountains: drag over the land; they block ' +
            'units at once. Changes are saved for every game. Press Rebuild navigation to update territories and ' +
            'paths after moving cities.', 11000);
        }
      }],
      [$('btn-rebuild'), 'click', () => this.g.rebuildMap()],
      [$('btn-beach-add'), 'click', () => this.g.setBrush('beach-add')],
      [$('btn-beach-del'), 'click', () => this.g.setBrush('beach-del')],
      [$('btn-mountain-add'), 'click', () => this.g.setBrush('mountain-add')],
      [$('btn-mountain-del'), 'click', () => this.g.setBrush('mountain-del')],
      [$('btn-scores'), 'click', () => this.showScores($('scoreboard').hidden)],
      [$('btn-tech'), 'click', () => this.toggleTech()],
      [$('stat-honor'), 'click', () => this.toggleHonor()],
      [$('btn-help'), 'click', () => this.toggleHelp()],
      [$('btn-leave'), 'click', () => this.leaveClicked()],
      [window, 'keyup', (e) => { if (e.key === 'Shift') this.applyPicks(); }],
      [window, 'blur', () => this.applyPicks()],         // Shift released outside the page
    ];
    for (const [t, ev, fn] of this.handlers) t.addEventListener(ev, fn);

    // A spectator has no empire: no gold, honor, cities, units or technologies of their own to show.
    $('topbar').classList.toggle('spectating', game.spectator);
    this.speedChanged();                     // the title
    $('stat-gold').title = `Gold. Every ${ECONOMY.turnSeconds} seconds (one turn) each city you hold pays ` +
      `${ECONOMY.goldPerCityPerTurn} gold, +${ECONOMY.regionBonusPerCity} if you hold every city of its region, ` +
      `more with a Farm. Every kill pays ${killShareText()} of the unit's cost.` +
      (game.goldPercent !== GOLD_PERCENT.default ? ` The host set your gold to ${game.goldPercent}%: all of it is scaled by that.` : '') +
      ' F1 → Economy explains it all.';
    $('stat-honor').title = `Honor: every enemy unit you destroy (your units and cities alike) gives you ${honorShareText()} ` +
      `in honor: ${UNITS.infantry.name} ${honorFor('infantry')}, ${UNITS.knight.name} ${honorFor('knight')}. ` +
      'Click (or O) for the Honor window: learn traditions with it, such as Heroes.';
    $('stat-turn').title = `Turns passed since the start, and time until the next turn pays out gold ` +
      `(${ECONOMY.goldPerCityPerTurn} per city, more for Farms and whole regions).`;
    // Once the game is over: every player's stats and the timeline, full screen or as a bar at the top.
    this.results = new Results(game);
    // F1: the help, a wiki of the game with animated demos (help/wiki.js).
    this.help = new HelpWiki(game, $('help'));
    $('scoreboard').hidden = true;
    $('help').hidden = true;
    $('tech').hidden = true;
    $('honor').hidden = true;
    $('leave').hidden = true;
    this.honorKey = null;
    this.techTab = TECH_TABS[0].id;
    this.techKey = null;
    $('banner').hidden = true;
    $('race').hidden = true;
    $('prestart').hidden = true;
    this.prestartTimer = 0;
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
      : 'Edit the map: drag cities and region names to move them (admins only). Changes are saved for every game.';
    rebuild.hidden = !g.admin || !g.mapEdit;
    rebuild.disabled = !!st.busy;
    rebuild.textContent = st.busy ? 'Rebuilding…' : st.pending ? `Rebuild navigation (${st.pending})` : 'Rebuild navigation';
    rebuild.title = 'Rebuild territories, borders and pathfinding from where the cities stand now' +
      (st.pending ? ` (${st.pending} moved since the last rebuild)` : '');
    // The brushes (Edit map only): paint beaches or erase them by dragging along the coast, mountains over
    // the land.
    for (const mode of ['beach-add', 'beach-del', 'mountain-add', 'mountain-del']) {
      const id = `btn-${mode}`;
      $(id).hidden = !g.admin || !g.mapEdit;
      $(id).classList.toggle('active', g.brush === mode);
    }
    $('view').classList.toggle('map-editing', g.mapEdit);
  }

  destroy() {
    for (const [t, ev, fn] of this.handlers) t.removeEventListener(ev, fn);
    clearTimeout(this.bannerTimer);
    clearTimeout(this.prestartTimer);
    $('prestart').hidden = true;
    this.help.close();
    this.editor.root.remove();
    this.results.destroy();
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
    if (show && this.results.isOpen) return;     // the results screen has every player already
    $('scoreboard').hidden = !show;
    if (show) this.renderScores();
  }

  // Leave, during a game. With an empire to give up, a dialog asks first: surrender and watch the rest of
  // the game, or leave for the lobby. With nothing at stake (the game is over, or you only watch it) you go
  // at once. The host too: the game goes on in another player's browser (main.js, leaveGame).
  leaveClicked() {
    const g = this.g;
    if (g.ended || g.isOut()) g.leave();
    else this.showLeave(true);
  }

  showLeave(show) {
    const box = $('leave');
    box.hidden = !show;
    if (!show) return;
    const g = this.g, out = g.isOut();
    const others = [...g.players.keys()].some((id) => id !== g.you);
    const close = () => this.showLeave(false);
    const option = (button, text) => el('div', { class: 'leave-option' }, button, el('p', {}, text));
    box.replaceChildren(
      el('h3', { id: 'leave-title' }, 'Leave the game?'),
      out ? null : option(
        el('button', { type: 'button', class: 'primary', onclick: () => { close(); g.surrender(); } }, 'Surrender and watch'),
        'Your cities become neutral and your units are gone, but you stay as a spectator and see how the game ends. ' +
        (others ? 'Once everyone else has surrendered or left, the last player wins.' : 'Playing alone, this ends the game.')),
      option(
        el('button', { type: 'button', onclick: () => { close(); g.leave(); } }, 'Leave game'),
        out ? 'Stop watching and go back to the lobby.' : 'Your cities become neutral and you go back to the lobby.'),
      el('div', { class: 'leave-actions' }, el('button', { type: 'button', onclick: close }, 'Cancel')));
  }

  // F1: the help (help/wiki.js). It opens on the page it last showed.
  toggleHelp(force) {
    this.help.toggle(force);
  }

  // ---------------------------------------------------------------- Tech window (T)
  // `tab`: open on this tab (e.g. 'sea' from a ship's locked build button).
  toggleTech(force, tab) {
    const box = $('tech');
    box.hidden = force === undefined ? !box.hidden : !force;
    if (this.g.spectator) box.hidden = true;         // nothing to research: a spectator has no empire
    if (!box.hidden) $('honor').hidden = true;       // the Honor window opens in the same place
    if (tab) this.techTab = tab;
    this.techKey = null;
    this.renderTech();
  }

  // Rebuilt only when what it shows changes (levels, the research running and queued, the tab), so a
  // click never lands on a replaced button; progress and gold are kept current by refreshTech().
  renderTech() {
    const box = $('tech');
    if (box.hidden) return;
    const g = this.g, r = g.research;
    const key = [this.techTab, JSON.stringify(g.myTech()), r ? r.tech : '', g.researchQueue.join(','), g.options.death,
      g.isLiberator()].join('|');     // falling, or coming back, changes the price of Rebellion technologies
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
          '(after losing every city and unit). You can research them at any time, also before you fall, but as a ' +
          `liberator you pay only ${Math.round(LIBERATOR.rebellionCost * 100)}% of their price. ` +
          `${RESEARCH_QUEUE_TEXT} F1 → Liberator explains it all.`));
      } else if (tab.id === 'sea') {
        body.append(el('p', { class: 'muted small' }, 'Ships and the sea. Sea technologies work as soon as they are ' +
          `researched. ${RESEARCH_QUEUE_TEXT}`));
      } else if (tab.id === 'land') {
        body.append(el('p', { class: 'muted small' }, 'Your lands and the armies that cross them. Land technologies work ' +
          `as soon as they are researched. ${RESEARCH_QUEUE_TEXT}`));
      }
      for (const k of TECH_TYPES.filter((t) => TECHS[t].tab === tab.id)) body.append(this.techCard(k));
    }
    box.replaceChildren(...[el('h3', {}, 'Technologies'), tabs, this.researchQueueLine(), body,
      el('button', { type: 'button', class: 'primary tech-close', onclick: () => this.toggleTech(false) }, 'Close')].filter(Boolean));
    this.refreshTech();
  }

  // The levels queued after the research running, in order and across tabs, each with ✕ to take it out
  // of the queue (with the higher levels of it after it). Null when none is queued.
  researchQueueLine() {
    const g = this.g, queued = g.researchPlan().slice(1);
    if (!queued.length) return null;
    return el('div', { class: 'plan-queue' }, el('span', { class: 'muted small' }, 'Queued:'),
      ...queued.map((e, i) => {
        const def = TECHS[e.tech];
        const higher = queued.some((o) => o.tech === e.tech && o.level > e.level);
        return el('span', { class: 'plan-item' }, `${i + 1}. ${def.name}${def.levels.length > 1 ? ` ${e.level}` : ''}`,
          el('button', {
            type: 'button', 'aria-label': 'Remove',
            title: `Take it out of the queue: ${e.cost} gold back${higher ? ' (and the higher levels after it, as they need it)' : ''}`,
            onclick: () => g.cancelResearch(e.tech, e.level),
          }, '✕'));
      }));
  }

  techEffect(key, level) {
    const T = TECHS, max = T[key].levels.length;
    const then = (now, next) => (level < max ? `Now ${now}; next level ${next}.` : `Now ${now}.`);
    if (key === 'seafaring') {
      const t = UNITS.transport;
      return `Coastal cities (marked with an anchor) build transports (${t.hotkey}, ${t.cost} gold): ships that carry ` +
        `${t.capacity} units across the sea. Right-click your transport with units selected to take them on board ` +
        '(or Autoload, L, for the idle units around it), and Unload (U) to land them on another coast, islands included.';
    }
    if (key === 'warships') {
      const b = UNITS.battleship;
      return `Coastal cities build battleships (${b.hotkey}, ${b.cost} gold): warships with ${b.hp} HP whose ballistas ` +
        `shoot a ${b.damage} damage bolt every ${b.reload} s at ships, troops ashore and cities up to ${b.attackRange} km ` +
        'away. A bolt does its damage when it lands; it follows its target and can\'t be dodged. They reload while ' +
        'they sail, so you can shoot, pull back and come in again. They take coastal cities; an inland city in range ' +
        'they bring down to 1 HP, and troops must take it. A city does not regenerate between their shots.';
    }
    if (key === 'gunnery') {
      const G = T.gunnery, b = UNITS.battleship;
      return 'Your battleships get cannons, the ones already at sea too: at troops ashore and at cities they fire ' +
        `shells instead of bolts (at ships, still bolts). Like a bolt, a shell follows its target: it does the ` +
        `battleship's ${b.damage} damage to it, and ${Math.round(G.splashShare * 100)}% of it to every other enemy ` +
        `within ${G.splashRadius} km. A shell at a city bursts on its walls: no harm to the units around it.`;
    }
    if (key === 'navigation') {
      const p = T.navigation.speedPercent, fast = (type) => Math.round((UNITS[type].moveSpeed * (100 + p)) / 10) / 10;
      return `All your ships sail ${p}% faster, the ones already at sea too: transports ${UNITS.transport.moveSpeed} → ` +
        `${fast('transport')}, battleships ${UNITS.battleship.moveSpeed} → ${fast('battleship')}. A battleship still ` +
        `takes ${UNITS.battleship.accelTime} s to reach full speed after a stop.`;
    }
    if (key === 'roads') {
      const p = T.roads.speedPercent, fast = (type) => Math.round((UNITS[type].moveSpeed * (100 + p)) / 10) / 10;
      return `Your land units march ${p}% faster in every region you hold whole (every city of it), the ones already ` +
        `on the march too: infantry ${UNITS.infantry.moveSpeed} → ${fast('infantry')}, cavalry ${UNITS.cavalry.moveSpeed} → ` +
        `${fast('cavalry')}. Lose one city of a region and its roads are no longer yours. Dark lines on the map are the ` +
        "regions' borders; a city's panel says how much of its region you hold. Ships are not affected.";
    }
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

  // What a technology is for, in a few words (the card's second line, under its name).
  techSummary(key) {
    const T = TECHS;
    if (key === 'seafaring') return 'Build ships and carry your units across the sea';
    if (key === 'warships') return 'Build battleships whose ballistas shoot ships and coasts';
    if (key === 'navigation') return `All your ships sail ${T.navigation.speedPercent}% faster`;
    if (key === 'gunnery') return `Battleships fire shells at land targets: ${Math.round(T.gunnery.splashShare * 100)}% splash`;
    if (key === 'roads') return `Land units march ${T.roads.speedPercent}% faster in the regions you hold whole`;
    if (key === 'supporters') return `+${T.supporters.goldPerTurnPerLevel} gold per turn as a liberator, for each level`;
    if (key === 'influencer') return 'Liberate several cities at once';
    return `Take ${Math.round(T.smuggling.share * 100)}% of the income of the cities you mark`;
  }

  // A technology: its picture, name and level, what it is for, the details, and research: the level
  // running (progress, Cancel), the levels queued, and the next level to order (queued while one runs).
  techCard(key) {
    const g = this.g, def = TECHS[key], level = g.myTech()[key] || 0, max = def.levels.length;
    const r = g.research, running = r && r.tech === key ? nextLevel(key, level) : null;
    const plan = g.researchPlan().slice(1).filter((e) => e.tech === key), queued = plan.map((e) => e.level);
    const next = nextLevel(key, g.plannedTechLevel(key), g.isLiberator());     // a liberator pays less for Rebellion
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    // The price of the next level: the full one struck out next to it when a liberator pays less.
    const full = next ? def.levels[next.level - 1].cost : 0;
    const price = () => (next.cost < full
      ? el('span', { class: 'tech-price', title: `As a liberator you pay ${next.cost} gold instead of ${full}` },
        el('s', {}, String(full)), ` ${next.cost} gold · ${fmt(next.time)}`)
      : el('span', { class: 'tech-price' }, `${next.cost} gold · ${fmt(next.time)}`));
    const body = el('div', { class: 'tech-body' },
      el('div', { class: 'tech-head' },
        el('b', {}, def.name),
        max > 1 ? el('span', { class: 'pips', title: `Level ${level} of ${max}` }, ...def.levels.map((_, i) => el('i', { class: i < level ? 'on' : '' }))) : null,
        max > 1 ? el('span', { class: 'muted small' }, `Level ${level}/${max}`) : null),
      el('div', { class: 'tech-summary' }, this.techSummary(key)),
      el('div', { class: 'tech-text' }, this.techEffect(key, level)));
    const card = el('div', { class: `tech-card${level < max ? '' : ' done'}` },
      el('img', { class: 'tech-icon', src: techIconURL(key, g.colorOf(g.you)), alt: '' }), body);
    if (running) {
      const fill = el('i'), left = el('span', { class: 'muted small' });
      const also = queued.length ? ' (and the higher levels queued after it, as they need it)' : '';
      body.append(el('div', { class: 'tech-actions' },
        el('div', { class: 'tech-progress' }, fill), left,
        el('button', { type: 'button', title: `Stop and get ${r.cost} gold back${also}`, onclick: () => g.cancelResearch(key, running.level) }, 'Cancel')));
      this.techDyn.push({ kind: 'progress', fill, left, time: running.time, fmt });
    }
    if (queued.length) {
      const last = queued.at(-1), cost = plan.at(-1).cost;     // the gold paid for it
      body.append(el('div', { class: 'tech-actions' },
        el('span', { class: 'tech-queued' }, max > 1 ? `Queued: level ${queued.join(', ')}` : 'Queued'),
        el('button', {
          type: 'button', title: `Take ${max > 1 ? `level ${last}` : 'it'} out of the queue: ${cost} gold back`,
          onclick: () => g.cancelResearch(key, last),
        }, 'Remove')));
    }
    const need = def.requires && g.plannedTechLevel(def.requires) < 1 ? TECHS[def.requires] : null;
    if (next && need) {
      // It needs another technology first (Warships: Seafaring): researched, or ordered before it.
      body.append(el('div', { class: 'tech-actions' },
        el('span', { class: 'tech-locked' }, `🔒 Needs ${need.name} first`), price()));
    } else if (next) {
      // While a research runs, the next one ordered is queued after it (and the queue).
      const btn = el('button', {
        type: 'button', class: 'primary',
        onclick: (e) => { e.currentTarget.disabled = true; g.startResearch(key); },
      }, `${r ? 'Queue' : 'Research'}${max > 1 ? ` level ${next.level}` : ''}`);
      body.append(el('div', { class: 'tech-actions' }, btn, price()));
      this.techDyn.push({ kind: 'button', btn, cost: next.cost });
    } else if (level >= max) {
      body.append(el('div', { class: 'tech-actions tech-done' }, max > 1 ? '✓ Fully researched' : '✓ Researched'));
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
        const poor = g.gold < d.cost;
        d.btn.disabled = poor;
        d.btn.title = poor ? `Needs ${d.cost} gold`
          : r ? `Paid now; it starts once ${TECHS[r.tech].name}${g.researchQueue.length ? ' and the queue' : ''} is done. ` +
            'Take it out of the queue to get the gold back.' : '';
      }
    }
  }

  // ---------------------------------------------------------------- Honor window (O, or click the honor star)
  // Traditions, learned with honor. Rebuilt only when what it shows changes (traditions learned, the one
  // being learned), so a click never lands on a replaced button; refreshHonor() keeps the rest current.
  toggleHonor(force) {
    const box = $('honor');
    box.hidden = force === undefined ? !box.hidden : !force;
    if (this.g.spectator) box.hidden = true;         // nor honor to spend
    if (!box.hidden) $('tech').hidden = true;        // the Tech window opens in the same place
    this.honorKey = null;
    this.renderHonor();
  }

  renderHonor() {
    const box = $('honor');
    if (box.hidden) return;
    const g = this.g, l = g.learning;
    const key = [[...g.traditions].join(','), l ? l.tradition : '', g.learnQueue.join(',')].join('|');
    if (key === this.honorKey) { this.refreshHonor(); return; }
    this.honorKey = key;
    const amount = el('b');
    this.honorDyn = [{ kind: 'amount', amount }];
    box.replaceChildren(
      el('h3', {}, 'Honor'),
      el('div', { class: 'honor-have' }, el('span', { class: 'honor' }), amount,
        el('span', { class: 'muted small' }, `honor · every enemy unit you or your cities destroy gives ${honorShareText()} ` +
          `(${UNITS.infantry.name} ${honorFor('infantry')}, ${UNITS.knight.name} ${honorFor('knight')})`)),
      el('p', { class: 'muted small' }, 'Traditions are learned once and kept for the whole game. They cost honor, not ' +
        'gold, and take a while to learn: one at a time, alongside your research. Order more meanwhile and they are ' +
        'queued, each paid when ordered, and learned one after another. Cancel or remove one to get its honor back.'),
      el('h4', { class: 'honor-sub' }, 'Traditions'),
      ...TRADITION_TYPES.map((k) => this.traditionCard(k)),
      el('button', { type: 'button', class: 'primary tech-close', onclick: () => this.toggleHonor(false) }, 'Close'));
    this.refreshHonor();
  }

  // What a tradition is for, in a few words (under its name), and what it does.
  traditionSummary(key) {
    if (key === 'heroes') return 'Make any of your land units a Hero';
    if (key === 'brotherhood') return 'Build Barracks with honor instead of gold';
    if (key === 'mercy') return 'Turn any of your land units into a Healer';
    if (key === 'honoredDead') return 'Your fallen units bring you honor';
    if (key === 'eternalGlory') return 'Train any unit with honor instead of gold';
    return '';
  }

  traditionText(key) {
    if (key === 'heroes') {
      const h = UNITS.hero;
      return `Then select one of your land units and press Make Hero in its panel (${HERO.cost} honor each): it becomes ` +
        `a Hero where it stands, keeping its orders and its share of HP. A Hero has ${h.hp} HP and ${h.damage} damage/s, ` +
        `and the speed and range of what it was: infantry and archers make Infantry and Archer Heroes, cavalry and ` +
        `knights make Cavalry Heroes. All the time, every land unit of yours within ${HERO.auraRadius} km of a Hero, ` +
        `the Hero too, deals +${Math.round(HERO.auraBonus * 100)}% damage. Several Heroes don't add up.`;
    }
    if (key === 'mercy') {
      const h = UNITS.healer;
      return `Then select one of your land units and press Make Healer in its panel (${HEALER.cost} honor each): it ` +
        `becomes a Healer where it stands, keeping its orders and its share of HP. A Healer (${h.hp} HP, ${h.damage} ` +
        `damage/s, speed ${h.moveSpeed}) restores ${HEALER.hpPerSecond} HP per second to every land unit of yours within ` +
        `${HEALER.radius} km, itself included, even in the middle of a fight. Several Healers don't add up: a unit gets ` +
        `${HEALER.hpPerSecond} HP per second at most.`;
    }
    if (key === 'brotherhood') {
      const b = CITY_UPGRADES.barracks, { barracksHonor: price, barracksBuildSpeed: speed } = TRADITIONS.brotherhood;
      return `Then any of your cities can build its ${b.name} for ${price} honor instead of ${b.cost} gold: the same ` +
        `building, and units train twice as fast there. Pay with gold or with honor, as you like (Shift + G, or the ` +
        `honor button under ${b.name}); either way it builds ${speed} times faster, in ${b.buildTime / speed} s instead ` +
        `of ${b.buildTime} s. Cancel it in the queue to get the honor back. A captured city loses its ${b.name}, and ` +
        `the honor spent on it is lost.`;
    }
    if (key === 'eternalGlory') {
      const f = TRADITIONS.eternalGlory.unitHonorFactor;
      const ex = ['infantry', 'archer', 'cavalry', 'knight', 'transport', 'battleship'].map((t) => `${UNITS[t].name} ${UNITS[t].cost * f}`);
      return `Then every city can train any unit for honor, at ${f} times its gold cost: ${ex.join(', ')}. Use the ` +
        `Gold / Honor switch in the Units box, or Shift + the unit's key.`;
    }
    if (key === 'honoredDead') {
      const share = TRADITIONS.honoredDead.lossShare, pct = Math.round(share * 1000) / 10;
      const ex = ['infantry', 'archer', 'cavalry', 'knight'].map((t) => `${UNITS[t].name} ${Math.round(UNITS[t].cost * share * 10) / 10}`);
      return `From then on, every unit of yours that falls in battle gives you ${pct}% of its cost in honor: ` +
        `${ex.join(', ')}. Units on board a sunk ship count too. Units you disband don't count, unless an enemy hit ` +
        `them in their last ${DISBAND.killCreditSeconds} seconds.`;
    }
    return '';
  }

  // A tradition, one row as tall as its picture: the picture, name and what it is for, then learning it on
  // the right. The details are the row's tooltip.
  traditionCard(key) {
    const g = this.g, def = TRADITIONS[key], learned = g.hasTradition(key), l = g.learning, queuedAt = g.learnQueue.indexOf(key);
    const icon = traditionIconURL(key, g.colorOf(g.you));
    const price = el('span', { class: 'tech-price' }, `${def.cost} honor · ${clock(def.time)}`);
    const body = el('div', { class: 'tech-body' },
      el('div', { class: 'tech-head' }, el('b', { class: def.ultimate ? 'ultimate' : '' }, def.name),
        def.ultimate ? el('span', { class: 'ultimate-tag' }, 'Tier II') : null),
      el('div', { class: 'tech-summary' }, this.traditionSummary(key)));
    const actions = el('div', { class: 'tech-actions' });
    const card = el('div', { class: `tech-card honor-card${learned ? ' done' : ''}`, title: this.traditionText(key) },
      el('img', { class: 'tech-icon', src: icon, alt: '' }), body, actions);
    // An ultimate (tier II) tradition waits for every tier I one: learned, or queued ahead of it.
    const missing = def.ultimate ? TRADITION_TYPES.filter((k) => !TRADITIONS[k].ultimate && !g.plansTradition(k)) : [];
    // A tier I tradition cancelled takes the queued tier II ones with it.
    const also = !def.ultimate && g.learnQueue.some((k) => TRADITIONS[k].ultimate) ? ' (and the tier II traditions queued, as they need it)' : '';
    if (learned) {
      actions.classList.add('tech-done');
      actions.append('✓ Learned');
    } else if (l && l.tradition === key) {
      const fill = el('i'), left = el('span', { class: 'muted small' });
      actions.append(el('div', { class: 'tech-progress' }, fill), left,
        el('button', { type: 'button', title: `Stop and get ${def.cost} honor back${also}`, onclick: () => g.cancelLearning(key) }, 'Cancel'));
      this.honorDyn.push({ kind: 'progress', fill, left, time: def.time });
    } else if (queuedAt >= 0) {
      actions.append(el('span', { class: 'tech-queued' }, `Queued #${queuedAt + 1}`),
        el('button', { type: 'button', title: `Take it out of the queue: ${def.cost} honor back${also}`, onclick: () => g.cancelLearning(key) }, 'Remove'));
    } else if (missing.length) {
      actions.append(price, el('span', {
        class: 'ultimate-lock',
        title: `Learn or queue every tier I tradition first. Missing: ${missing.map((k) => TRADITIONS[k].name).join(', ')}`,
      }, '🔒 Locked'));
    } else {
      // While one is learned, the next one ordered is queued after it (and the queue).
      const btn = el('button', {
        type: 'button', class: 'primary',
        onclick: (e) => { e.currentTarget.disabled = true; g.startLearning(key); },
      }, l ? 'Queue' : 'Learn');
      actions.append(price, btn);
      this.honorDyn.push({ kind: 'button', btn, cost: def.cost });
    }
    return card;
  }

  refreshHonor() {
    const g = this.g, l = g.learning;
    for (const d of this.honorDyn || []) {
      if (d.kind === 'amount') {
        const text = String(g.honor);
        if (d.amount.textContent !== text) d.amount.textContent = text;
      } else if (d.kind === 'progress') {
        const done = l ? l.progress : 0;
        d.fill.style.width = `${Math.min(1, done / d.time) * 100}%`;
        const text = `${clock(Math.max(0, d.time - done))} left`;
        if (d.left.textContent !== text) d.left.textContent = text;
      } else {
        const poor = g.honor < d.cost;
        d.btn.disabled = poor;
        const why = poor ? `Needs ${d.cost} honor (you have ${g.honor})`
          : l ? `Paid now; learned once ${TRADITIONS[l.tradition].name}${g.learnQueue.length ? ' and the queue' : ''} is done. ` +
            'Take it out of the queue to get the honor back.' : '';
        // No reason: no tooltip of its own, so the row's details show over the button too.
        if (why) d.btn.title = why;
        else { d.btn.removeAttribute('title'); delete d.btn.dataset.tip; }
      }
    }
  }

  closeOverlays() {
    const results = this.results.isOpen;
    const open = !$('help').hidden || !$('scoreboard').hidden || !$('tech').hidden || !$('honor').hidden || !$('leave').hidden ||
      this.editor.isOpen || results;
    this.help.close();
    $('tech').hidden = true;
    $('honor').hidden = true;
    $('leave').hidden = true;
    $('scoreboard').hidden = true;
    this.editor.close();
    if (results) this.results.collapse();   // the game is over: Esc folds the results to look around, like the button
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
        el('th', { title: 'Traditions the player has learned (Honor window). Everyone sees them.' }, 'Traditions'),
        el('th', {}, '')));
    for (const p of rows) {
      const status = p.surrendered ? 'Surrendered' : p.eliminated ? 'Eliminated'
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
        this.traditionsCell(p),
        el('td', { class: 'muted small' }, status)));
    }
    sb.append(table);
    const neutral = g.cityOwner.filter((o) => o < 0).length;
    const need = g.citiesToWin();
    sb.append(el('p', { class: 'muted small' },
      `Kills and losses are in gold: the cost of the units destroyed. ${neutral} neutral cities · ` +
      `${need} cities held at the end of the turn win${g.countdownRunning() ? ', one fewer after every turn' : ''}`));
  }

  // A player's traditions for the Players list: an icon each (the name on hover; the ultimate ones framed
  // in red), and while they are learning an ultimate one, its name and countdown.
  traditionsCell(p) {
    const td = el('td', { class: 'trads' });
    for (const k of p.traditions || []) {
      const def = TRADITIONS[k];
      td.append(el('img', {
        src: traditionSmallIconURL(k, p.color), alt: def.name, title: def.name, class: def.ultimate ? 'ultimate-icon' : '',
      }));
    }
    const ultimate = TRADITIONS[p.ultimate] ? p.ultimate : null;
    if (p.ultimateLeft > 0 && ultimate) {
      td.append(el('span', { class: 'ultimate learning', title: `Learning ${TRADITIONS[ultimate].name}` },
        `${TRADITIONS[ultimate].name} ${clock(p.ultimateLeft)}`));
    }
    if (!td.childNodes.length) td.append(el('span', { class: 'muted small' }, '—'));
    return td;
  }

  // Identities are no longer secret: the results screen names the winner and every player with their
  // nickname, in their colour, with their stats and the timeline of the game (results.js). `reason`
  // explains a game that ended early, e.g. the host left. Called again when the nicknames arrive from the
  // lobby server (the host never has them): the screen keeps where the player is.
  showGameOver(winnerId, reason = null) {
    clearTimeout(this.prestartTimer);
    $('prestart').hidden = true;         // e.g. the host left before the start
    $('scoreboard').hidden = true;
    $('leave').hidden = true;            // nothing to give up any more
    this.panelKey = null;                // the how-to-play tip goes: the game is over
    this.results.show(winnerId, reason);
  }

  // Before a hosted game starts (info from the host, null once it has): how many players have
  // loaded it, then the countdown. `go`: it has just started, say so for a moment.
  renderPrestart(info, go = false) {
    const box = $('prestart');
    clearTimeout(this.prestartTimer);
    box.classList.toggle('go', go);
    if (go) {
      box.replaceChildren(el('b', {}, 'Go!'));
      box.hidden = false;
      this.prestartTimer = setTimeout(() => { box.hidden = true; }, 1200);
      return;
    }
    box.hidden = !info;
    if (!info) return;
    if (info.left === null) {
      box.replaceChildren(
        el('div', { class: 'label' }, 'Waiting for every player to load the game'),
        el('b', {}, `${info.loaded} / ${info.total}`),
        el('div', { class: 'muted small' }, GAME.startCountdown
          ? `Then a ${GAME.startCountdown}-second countdown, and the game starts for everyone at once.`
          : 'Then the game starts for everyone at once.'));
    } else {
      box.replaceChildren(
        el('div', { class: 'label' }, 'The game starts in'),
        el('b', {}, String(info.left)),
        el('div', { class: 'muted small' }, 'Look around and plan: orders count from the start.'));
    }
  }

  // `text`: a string, or an array of strings and elements (e.g. colorTag) as in feed().
  banner(text, ms = 6000) {
    const b = $('banner');
    b.replaceChildren(...(Array.isArray(text) ? text : [text]));
    b.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
  }

  // The guide at the start of a game (client.js startGuide): `parts` as in feed(), shown until the
  // next step replaces them; null hides it. × hides it for the rest of the game.
  guide(parts) {
    const box = $('guide');
    if (!parts) { box.hidden = true; box.replaceChildren(); return; }
    box.replaceChildren(
      el('span', {}, ...parts),
      el('button', {
        type: 'button', class: 'guide-close', 'aria-label': 'Hide the guide', title: 'Hide the guide',
        onclick: () => this.g.endGuide(true),
      }, '×'));
    box.hidden = false;
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
    let tip = `Cities you hold. Hold ${need} when the turn ends to win the game.`;
    if (running) tip += `
The target drops by one city at the end of every turn (it started at ${o.winCities}).`;
    else if (o.countdown === 'turn' && (g.turn || 0) < o.countdownTurn) tip += `
Once turn ${o.countdownTurn} is over, it drops by one city at the end of every turn.`;
    $('stat-cities').title = tip;
  }

  // Top centre, for everyone: every player within GAME.closeToWinCities of the target, closest first
  // ("Maroon needs 10 more cities to win"). Holding the target wins only when the turn ends
  // (server/game.js, checkCityVictory), so the player who would win then gets a red line with the
  // time left and how many cities they can still lose. Players are named by colour only.
  updateRace(now) {
    const g = this.g, box = $('race');
    const need = g.citiesToWin();
    const held = new Map();
    for (const o of g.cityOwner) if (o >= 0) held.set(o, (held.get(o) || 0) + 1);
    const close = g.ended ? [] : [...held]
      .filter(([id, n]) => g.players.has(id) && need - n <= GAME.closeToWinCities)
      .sort((a, b) => b[1] - a[1]);
    // The same rule as the server: the one player with the most cities among those holding the target.
    const top = close.filter(([, n]) => n >= need);
    const winner = top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : -1;
    const left = g.secondsToNextTurn(now);
    const s = left === null ? null : Math.ceil(left);
    const clock = s === null ? '' : ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
    const key = `${need}|${close.map(([id, n]) => `${id}:${n}`).join(',')}|${winner >= 0 ? clock : ''}`;
    if (key === this.raceKey) return;
    this.raceKey = key;
    box.textContent = '';
    box.hidden = !close.length;
    const cities = (n) => `${n} ${n === 1 ? 'city' : 'cities'}`;
    const MAX_LINES = 4;
    for (const [id, n] of close.slice(0, MAX_LINES)) {
      const you = id === g.you;
      let parts;
      if (id === winner) {
        const spare = n - need + 1;     // losing this many puts them below the target
        parts = [you ? ` win when the turn ends${clock} unless you lose ${cities(spare)}`
          : ` wins when the turn ends${clock} unless they lose ${cities(spare)}`];
      } else if (n >= need) {
        const verb = you ? 'hold' : 'holds';
        parts = winner >= 0 ? [` ${verb} enough cities, but `, g.who(winner), ` ${winner === g.you ? 'hold' : 'holds'} more`]
          : [` ${verb} enough cities, but ${you ? 'are' : 'is'} tied for the most: a tie plays on`];
      } else {
        parts = [` ${you ? 'need' : 'needs'} ${need - n} more ${need - n === 1 ? 'city' : 'cities'} to win`];
      }
      box.append(el('div', { class: `${id === winner ? 'wins' : ''}${you ? ' me' : ''}` }, g.who(id), ...parts));
    }
    if (close.length > MAX_LINES) {
      const more = close.length - MAX_LINES;
      box.append(el('div', { class: 'more' }, `and ${more} more ${more === 1 ? 'player' : 'players'} within ${GAME.closeToWinCities} cities`));
    }
  }

  // The game speed (developer console "slomo") shows next to the title while it is not normal, and a
  // spectator is reminded that they only watch.
  speedChanged() {
    const s = this.g.timeScale;
    $('hud-title').textContent = this.g.title + (this.g.spectator ? ' · spectating' : '') + (s === 1 ? '' : ` · speed ${s}×`);
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
    $('hud-honor').textContent = String(g.honor);
    $('hud-turn').textContent = String(g.turn || 0);
    const left = g.secondsToNextTurn(now);
    if (left !== null) {
      const s = Math.ceil(left);
      $('hud-turn-next').textContent = `next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      $('stat-turn').classList.toggle('soon', s <= 10);
    }
    $('hud-cities').textContent = String(myCities);
    this.updateWinTarget();
    this.updateRace(now);
    $('hud-units').textContent = String(g.ownUnitCount());
    // Death: Liberator. Every time you fall, say what you can do now.
    const liberator = g.isLiberator();
    if (liberator && !this.liberatorShown) {
      this.banner(`You have fallen and lost all your gold. As a liberator you get ${g.myIncome()} gold ` +
        'every turn and can take cities back: click any city and press Liberate. Rebellion technologies (T) make you stronger.', 12000);
    }
    this.liberatorShown = liberator;
    this.renderTech();
    this.renderHonor();
    if (me && me.eliminated && !g.ended && !this.eliminatedShown) {
      this.eliminatedShown = true;
      this.banner(me.surrendered ? 'You surrendered. You are watching the game as a spectator; press Leave to go back to the lobby.'
        : 'You have been eliminated. You can keep watching or leave.', 10000);
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
      return {
        key: `city:${ci}:${q ? q.queue.join(',') : ''}:${g.cityUpgrades[ci]}:${this.coastKey(ci)}:${this.regionKey(ci)}`,
        kind: 'city', id: ci, ids: [ci], q,
      };
    }
    if (g.selection.size) {
      const ids = this.sortedSelection();
      // Rebuilt when a unit becomes a Hero, or once Heroes can be made (the Hero buttons).
      const promoted = ids.filter((id) => g.isPromoted(g.unitById.get(id)?.t)).length;
      // ...and once Seafaring is researched (the Board button). `rest`: all but the units (dropUnitTiles).
      const rest = `${promoted}:${g.hasTradition('heroes')}:${g.hasTradition('mercy')}:${g.hasSeafaring()}`;
      return { key: `units:${ids.join(',')}:${rest}`, kind: 'units', ids, rest };
    }
    if (g.inspect) {
      const { k, id } = g.inspect;
      // A liberator's buttons change with their marks, limits and the turns they still have to wait.
      const lib = g.isLiberator() && k === 'c' ? this.liberatorKey(id) : '';
      if (k === 'c') {
        return { key: `ic:${id}:${g.cityOwner[id]}:${g.cityUpgrades[id]}:${lib}:${this.coastKey(id)}:${this.regionKey(id)}`, kind: 'icity', id };
      }
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
    // Selected units killed (or gone on board), nothing else: only their icons go (dropUnitTiles).
    if (st.key !== this.panelKey && st.kind === 'units' && this.dyn?.unitTiles?.rest === st.rest && this.dropUnitTiles(st.ids)) {
      this.panelKey = st.key;
    }
    if (st.key !== this.panelKey) {
      this.panelKey = st.key;
      // A death rebuilds the unit icons: keep them scrolled where they were (read before they leave the page).
      const tiles = this.dyn?.unitTiles;
      const scroll = tiles ? { ids: tiles.byId, top: tiles.box.scrollTop } : null;
      this.dyn = {};
      this.g.hoverRegion = -1;     // the Region stat under the mouse is about to leave the page
      this.panel.textContent = '';
      // With nothing selected the panel shows a tip; once the tip is closed, the panel only appears for a selection.
      this.panel.hidden = st.kind === 'none' && (this.hintClosed || this.g.ended);
      this.panel.classList.toggle('units', st.kind === 'units');   // compact, with a height limit
      if (st.kind === 'city') this.buildCityPanel(st);
      else if (st.kind === 'cities') this.buildCitiesPanel(st);
      else if (st.kind === 'units') {
        this.buildUnitsPanel(st);
        if (scroll && st.ids.every((id) => scroll.ids.has(id))) this.dyn.unitTiles.box.scrollTop = scroll.top;
      }
      else if (st.kind === 'icity') this.buildCityInfo(st.id);
      else if (st.kind === 'iunit') this.buildUnitInfo(st.u);
      else if (st.kind === 'liberator') this.buildLiberatorPanel();
      else if (!this.hintClosed && !this.g.ended) this.buildHint();
    }
    // The column is rebuilt only when the selected cities change, not on every queue change,
    // so a click does not replace the button under the mouse.
    const own = st.kind === 'city' || st.kind === 'cities';
    // Also once Brotherhood of Arms is learned: the column gets the honor Barracks button.
    const colKey = own ? `${st.kind}:${st.ids.join(',')}:${this.g.hasTradition('brotherhood')}:${this.g.hasTradition('eternalGlory')}` : '';
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
    // Only the top grade built: "Wall II", not "Wall I, Wall II".
    const built = topGrades(UPGRADE_TYPES.filter((key) => g.hasUpgrade(ci, key))).map((key) => CITY_UPGRADES[key].name);
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
      g.isCoastal(ci)
        ? el('span', { title: 'A coastal city: it builds ships, launched at its pier' }, 'Port ', el('b', {}, '⚓ ships')) : null,
      el('span', {}, 'Upgrades ', el('b', {}, built.length ? built.join(', ') : 'none'))));
    this.dyn.cityHp = { fill: hpFill, text: hpText, ci };
    if (g.mapEdit) this.panel.append(this.coastEditRow(ci));
    // Liberators' marks on this city (kept current in refreshDynamic).
    const marks = el('div', { class: 'city-marks' });
    marks.hidden = true;
    this.panel.append(marks);
    this.dyn.cityMarks = { el: marks, ci, key: null };
  }

  // What a city panel shows about the coast in Edit map: rebuilt when it changes.
  coastKey(ci) {
    const g = this.g;
    return g.mapEdit ? `e${g.isCoastal(ci) ? 1 : 0}${g.map.cities[ci].coastal ?? ''}` : '';
  }

  // Edit map (admins): make the city coastal or inland, whatever its distance to the sea.
  coastEditRow(ci) {
    const g = this.g, c = g.map.cities[ci], on = g.isCoastal(ci);
    const why = typeof c.coastal === 'boolean' ? 'set in Edit map'
      : `from its distance to the sea: ${on ? 'within' : 'more than'} ${NAVAL.portRange} km`;
    const text = on
      ? `Coastal (${why}): it builds ships, launched at its pier. Make inland: no ships, and the ships in its queue are refunded.`
      : `Inland (${why}). Make coastal: it builds ships (the sea must be within ${NAVAL.editPortRange} km).`;
    return el('div', { class: 'liberate' },
      el('button', { type: 'button', title: text, onclick: () => g.setCoastal(ci, !on) }, on ? 'Make inland' : 'Make coastal'),
      el('span', { class: 'muted small' }, text));
  }

  // Debug builds: make any city yours at once, to test without conquering it. Everyone is told.
  ownRow(ci) {
    const text = 'Debug: this city becomes yours now, like a capture (its upgrades are lost, its queue is refunded).';
    return el('div', { class: 'liberate' },
      el('button', { type: 'button', title: text, onclick: () => this.g.takeCity(ci) }, 'Own'),
      el('span', { class: 'muted small' }, text));
  }

  // How much of the city's region its owner holds: all of it makes each of them pay more gold. For a
  // neutral city, how much of it you hold; a spectator or liberator (who earn no region gold) sees
  // what the region is made of. Hovering it lights the region up on the map (render.js drawRegionHover).
  regionStat(ci) {
    const g = this.g;
    const region = g.map.cities[ci].c;
    const ids = g.regionCities[region];
    const name = g.map.countries[region].n;
    const bonus = `+${ECONOMY.regionBonusPerCity} gold per turn from each, and with ${TECHS.roads.name} (Tech, Land tab) ` +
      `its holder's land units march ${TECHS.roads.speedPercent}% faster in it`;
    // A city with whoever holds it now.
    const where = (i) => {
      const o = g.cityOwner[i];
      return `${g.map.cities[i].n} (${o === g.you ? 'yours' : g.nameOf(o)})`;
    };
    const me = g.players.get(g.you);
    const playing = !!me && !me.eliminated && !me.liberator;
    const owner = g.cityOwner[ci] >= 0 ? g.cityOwner[ci] : playing ? g.you : -1;
    let text, title;
    if (owner < 0) {
      text = `${ids.length} cities`;
      title = `${name} has ${ids.length} cities: ${ids.map(where).join(', ')}. Holding all of them gives ${bonus}.`;
    } else {
      const held = ids.filter((i) => g.cityOwner[i] === owner).length;
      const whose = owner === g.you ? 'You hold' : `${g.nameOf(owner)} holds`;
      const all = held === ids.length;
      text = `${held}/${ids.length}${all ? ' ✓' : ''}`;
      title = all
        ? `${whose} every city of ${name}: ${bonus}.`
        : `${whose} ${held} of the ${ids.length} cities of ${name}. Holding all of them gives ${bonus}.\n` +
          `Still to take: ${ids.filter((i) => g.cityOwner[i] !== owner).map(where).join(', ')}.`;
    }
    return el('span', {
      title, class: 'region-stat',
      onmouseenter: () => { g.hoverRegion = region; g.hoverCity = ci; },
      onmouseleave: () => { if (g.hoverRegion === region) g.hoverRegion = -1; },
    }, 'Region ', el('b', {}, text));
  }

  // The owners of the city's region, for the panel key: the Region stat is rebuilt when one changes hands.
  regionKey(ci) {
    const g = this.g;
    return g.regionCities[g.map.cities[ci].c].map((i) => g.cityOwner[i]).join('.');
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

  // Cost and build time of the upgrades an order queues: a range when the selected cities get
  // different grades (Wall I in some, Wall II in others).
  upgradeCostText(defs, many) {
    const range = (values, unit) => {
      const lo = Math.min(...values), hi = Math.max(...values);
      return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`;
    };
    return `${range(defs.map((d) => d.cost), '')} gold${many ? ' each' : ''} · ${range(defs.map((d) => this.g.upgradeBuildTime(d)), 's')}`;
  }

  // Tooltip of an upgrade button. An upgrade with grades lists them: each order queues the next one.
  upgradeTitle(key) {
    const grades = upgradeGrades(key);
    const def = CITY_UPGRADES[key];
    if (grades.length === 1) {
      return `${def.name}: ${this.upgradeEffect(def)} for the city. Built once per city; destroyed if the city is captured.`;
    }
    const lines = grades.map((k) => {
      const d = CITY_UPGRADES[k];
      return `${d.name}: ${this.upgradeEffect(d)} for the city (${d.cost} gold, ${d.buildTime}s)`;
    });
    const names = grades.map((k) => CITY_UPGRADES[k].name);
    const times = grades.length === 2 ? 'twice' : `${grades.length} times`;
    return `${lines.join('\n')}\nEach order queues the next grade: ${def.hotkey ? `press ${def.hotkey}` : 'click'} ${times} ` +
      `for ${names.join(', then ')}. Each grade is built once per city; all are destroyed if the city is captured.`;
  }

  // Why a ship's build button is locked: its technology `key` (Seafaring, Warships) is missing, still
  // being researched, or queued.
  techLock(key) {
    const g = this.g, r = g.research, name = TECHS[key].name;
    if (r && r.tech === key) {
      const s = Math.max(0, Math.ceil(TECHS[key].levels[0].time - r.progress));
      return `Researching ${name}: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
    }
    if (g.researchQueue.includes(key)) return `${name} is queued in Technologies`;
    return `Needs ${name}: click to research it`;
  }

  // Unit cost and build time in the selected cities. Barracks shorten the time (not for ships), so
  // with several cities selected it can be a range. Ships: only the coastal ones count.
  // `honor`: the price in honor (Eternal Glory), shown after the honor star.
  unitCostText(def, ids, honor = false) {
    if (def.tech && !this.g.myTech()[def.tech]) return `🔒 ${TECHS[def.tech].name}`;
    if (def.naval) {
      ids = ids.filter((ci) => this.g.isCoastal(ci));
      if (!ids.length) return 'coastal cities only';
    }
    const fmt = (s) => `${Math.round(s * 10) / 10}s`;
    const times = ids.map((ci) => def.buildTime / (def.naval ? 1 : this.g.cityTrainRate(ci)));
    const lo = Math.min(...times), hi = Math.max(...times);
    const time = hi - lo < 0.05 ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
    const price = honor ? `${def.cost * TRADITIONS.eternalGlory.unitHonorFactor}` : `${def.cost} gold`;
    return `${price}${ids.length > 1 ? ' each' : ''} · ${time}`;
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
    const buttons = [];

    // City upgrades: once per city, destroyed when the city is captured. An upgrade with grades
    // (Wall I, Wall II) has one button for all of them: it shows and orders the next grade
    // (kept current in refreshDynamic).
    this.upgradeBox.append(el('h5', {}, 'Upgrades', el('small', {}, 'once per city')));
    for (const key of UPGRADE_TYPES) {
      const def = CITY_UPGRADES[key];
      if (def.requires) continue;
      const name = el('span', {}, def.name);
      const img = el('img', { src: upgradeIconURL(key, myColor), alt: '' });
      const state = el('span', { class: 'cost' }, this.upgradeCostText([def], many));
      const eff = el('span', { class: 'eff' }, this.upgradeEffect(def));
      const btn = el('button', {
        type: 'button', class: 'build-btn', title: this.upgradeTitle(key),
        onclick: () => g.build(key),
      },
      img, el('span', { class: 'nm' }, name, def.hotkey ? el('kbd', {}, def.hotkey) : null), state, eff);
      this.upgradeBox.append(btn);
      buttons.push({ btn, def, item: key, state, eff, name, img, shown: key, color: myColor });
      if (key === 'barracks' && g.hasTradition('brotherhood')) this.upgradeBox.append(this.honorBarracksButton(buttons, many));
    }

    this.unitBox.append(el('h5', {}, 'Units', many ? el('small', {}, 'one in every city') : null));
    if (g.hasTradition('eternalGlory')) this.unitBox.append(this.paySwitch());
    UNIT_TYPES.forEach((type, t) => {
      const def = UNITS[type];
      if (def.promoted) return;            // Hero, Healer: made from a unit for honor, never trained
      // Ships only where they can be built: at least one of the selected cities is coastal.
      if (def.naval && !st.ids.some((ci) => g.isCoastal(ci))) return;
      const range = def.attackRange ? `range ${def.attackRange}` : 'melee';
      const state = el('span', { class: 'cost' }, this.unitCostText(def, st.ids));   // kept current in refreshDynamic
      const about = def.capacity
        ? `${def.hp} HP · carries ${def.capacity} units · ${many ? 'in coastal cities' : 'ship'}`
        : def.reload ? `${def.hp} HP · ${def.damage} dmg / ${def.reload}s · ${range}`
          : `${def.hp} HP · ${def.damage} dmg/s · ${range}`;
      const eff = el('span', { class: 'eff' }, about);
      // A ship without its technology is locked (see refreshDynamic): a click opens its tab of the Tech window instead.
      const btn = el('button', {
        type: 'button', class: 'build-btn', title: UNIT_CLASSES[t].describe(),
        onclick: () => (g.canTrain(type) ? g.build(type, this.unitsForHonor()) : this.toggleTech(true, TECHS[def.tech].tab)),
      },
      el('img', { src: unitIconURL(myColor, t), alt: '' }),
      el('span', { class: 'nm' }, def.name, el('kbd', {}, def.hotkey)),
      state,
      eff);
      // Along the bottom: how far this unit is in training, in a selected city (kept current in refreshDynamic).
      const prog = el('span', { class: 'prog', hidden: '' });
      btn.append(prog);
      this.unitBox.append(btn);
      buttons.push({ btn, def, item: type, state, eff, about, prog, title: UNIT_CLASSES[t].describe() });
    });
    this.colButtons = buttons;
  }

  // Eternal Glory: the Units box pays with gold or with honor (TRADITIONS.eternalGlory.unitHonorFactor
  // times the gold cost). Shift + a unit's key pays with honor either way. Kept for the whole session.
  paySwitch() {
    const pick = (honor) => {
      this.payHonor = honor;
      gold.classList.toggle('active', !honor);
      star.classList.toggle('active', honor);
    };
    const factor = TRADITIONS.eternalGlory.unitHonorFactor;
    const gold = el('button', { type: 'button', title: 'Pay for units with gold', onclick: () => pick(false) }, 'Gold');
    const star = el('button', {
      type: 'button', title: `Pay for units with honor: ${factor} times their gold cost (${TRADITIONS.eternalGlory.name}). ` +
        'Shift + a unit\'s key pays with honor either way.',
      onclick: () => pick(true),
    }, el('span', { class: 'honor' }), 'Honor');
    pick(!!this.payHonor);
    return el('div', { class: 'pay-switch' }, el('span', { class: 'muted small' }, 'Pay with'), gold, star);
  }

  // Do the unit buttons pay with honor right now?
  unitsForHonor() {
    return !!this.payHonor && this.g.hasTradition('eternalGlory');
  }

  // Brotherhood of Arms: the same Barracks, paid with honor (Shift + G), in the Honor window's colours.
  // Kept current in refreshDynamic, like the other buttons of the column.
  honorBarracksButton(buttons, many) {
    const g = this.g, price = TRADITIONS.brotherhood.barracksHonor, def = CITY_UPGRADES.barracks;
    const amount = el('span', {}, `${price}${many ? ' each' : ''}`);
    const state = el('span', { class: 'cost' }, el('span', { class: 'honor' }), amount);
    const btn = el('button', {
      type: 'button', class: 'build-btn honor-buy',
      title: `${def.name} for ${price} honor instead of ${def.cost} gold (${TRADITIONS.brotherhood.name}): the same ` +
        `building, ${this.upgradeEffect(def)} for the city. Cancel it in the queue to get the honor back.`,
      onclick: () => g.build('barracks', true),
    },
    el('img', { src: upgradeIconURL('barracks', g.colorOf(g.you)), alt: '' }),
    el('span', { class: 'nm' }, def.name, el('kbd', {}, 'Shift G')),
    state,
    el('span', { class: 'eff' }, `for honor · ${g.upgradeBuildTime(def)}s`));
    buttons.push({ btn, honorBarracks: true, amount, many, price });
    return btn;
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
      el('span', { class: 'label' }, 'Each order goes to every selected city, as far as your gold reaches. C cancels the last one in each.'),
      el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click land: rally point · water: rally point for ships · Alt + right-click: clear')));
  }

  buildCityPanel(st) {
    const g = this.g, ci = st.id;
    this.cityHeader(ci);
    const myColor = g.colorOf(g.you);

    const queue = el('div', { class: 'queue' },
      el('span', { class: 'label', title: 'Click an entry to cancel it · C cancels the last one' }, 'Queue'));
    const items = st.q ? st.q.queue : [];
    this.dyn.queueProg = null;
    items.forEach((id, idx) => {
      const item = PRODUCTION_ITEMS[id];
      const def = UNITS[item] || CITY_UPGRADES[item];
      const icon = UNITS[item] ? unitIconURL(myColor, UNIT_TYPES.indexOf(item)) : upgradeIconURL(item, myColor);
      const prog = idx === 0 ? el('span', { class: 'prog' }) : null;
      if (prog) this.dyn.queueProg = { el: prog, def };
      // Cancelling a grade cancels the higher grades queued after it too (Wall II needs Wall I).
      const along = higherGrades(item).filter((k) => items.includes(PRODUCTION_ITEMS.indexOf(k)))
        .map((k) => CITY_UPGRADES[k].name);
      const paidHonor = st.q.honorPaid?.[idx] || 0;
      const refund = paidHonor ? `${paidHonor} honor back` : 'refund';
      queue.append(el('button', {
        type: 'button', class: `qitem${paidHonor ? ' honor-paid' : ''}`,
        title: `${def.name}${paidHonor ? ` (paid with ${paidHonor} honor)` : ''} — click to cancel` +
          `${along.length ? ` it and the ${along.join(', ')} after it` : ''} (${refund})`,
        onclick: () => g.cancel(ci, idx),
      }, el('img', { src: icon, alt: '' }), prog, paidHonor ? el('span', { class: 'honor' }) : null));
    });
    if (!items.length) queue.append(el('span', { class: 'label' }, '— empty'));
    queue.append(el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click land: rally point · water: rally point for ships · Alt + right-click: clear'));
    this.panel.append(queue);
  }

  buildCityInfo(ci) {
    this.cityHeader(ci);
    const g = this.g;
    const owner = g.cityOwner[ci];
    if (DEBUG && g.canTakeCity(ci)) this.panel.append(this.ownRow(ci));
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
    const head = el('h4', {}, `${n} unit${n === 1 ? '' : 's'} selected`);
    this.panel.append(el('div', { class: 'head' }, head, marked));

    const byType = new Map();               // unit type -> its ids, in panel order
    for (const id of st.ids) {
      const t = g.unitById.get(id)?.t ?? 0;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(id);
    }
    const chips = [];
    let groups = null;
    if (byType.size > 1) {
      groups = el('div', { class: 'unit-groups' });
      for (const [t, ids] of byType) {
        const def = UNITS[UNIT_TYPES[t]];
        const count = el('b', {}, String(ids.length));
        const chip = this.unitPickButton({
          class: 'unit-group',
          title: `${UNIT_CLASSES[t].describe()}\nClick: select only ${def.name.toLowerCase()} · ` +
            'Ctrl + click: remove them · Shift + click: mark them, released Shift selects the marked units',
        }, ids, el('img', { src: unitEmblemURL(t), alt: '' }), count, el('span', {}, def.name));
        groups.append(chip);
        chips.push({ chip, ids, count });
      }
      this.panel.append(groups);
    }

    const box = el('div', { class: 'unit-tiles' });
    const byId = new Map();
    for (const [t, ids] of byType) {
      const def = UNITS[UNIT_TYPES[t]];
      const img = unitEmblemURL(t);         // just the emblem: easier to read than a grid of small cones
      for (const id of ids) {
        const fill = el('i');
        // A transport's tile shows how many units are on board (kept current in refreshUnitTiles).
        const count = def.capacity ? el('b', { class: 'tile-count' }) : null;
        if (count) count.hidden = true;
        // A Hero's tile shows its kind's mark (the group chip above keeps the plain crown: kinds mix there).
        const u = def.hero ? g.unitById.get(id) : null;
        const tile = this.unitPickButton({ class: 'unit-tile' }, [id],
          el('img', { src: u ? unitEmblemURL(t, g.heroKind(u)) : img, alt: def.name }), el('span', { class: 'uhp' }, fill), count);
        box.append(tile);
        byId.set(id, { tile, fill, count, def, key: '' });
      }
    }
    this.panel.append(box);
    this.dyn.unitTiles = { box, byId, marked, chips, head, groups, rest: st.rest };

    const hpFill = el('i');
    this.panel.append(el('div', { class: 'hpbar', style: 'margin-top:8px' }, hpFill));
    this.dyn.groupHp = hpFill;
    const note = el('div', { class: 'disband-note' });
    note.hidden = true;
    this.panel.append(note);
    this.dyn.groupDisband = note;
    this.buildHeroRow();
    const ships = st.ids.filter((id) => {
      const u = g.unitById.get(id);
      return u && u.owner === g.you && UNITS[UNIT_TYPES[u.t]].capacity;
    });
    if (ships.length) this.buildCargo(ships, myColor);
    else if (g.hasSeafaring() && g.selectedLandUnits().length) {
      // Land units without transports: Board (L) sends them to your transports around them.
      this.panel.append(el('div', { class: 'hero-row' }, el('button', {
        type: 'button',
        title: `The selected land units find your transports with room within ${NAVAL.autoboardRange} km (lying idle or ` +
          'waiting at a beach) and go on board, each the nearest one. Each transport sails to the beach nearest to its share.',
        onclick: () => g.commandAutoload(),
      }, 'Board transports', el('kbd', {}, 'L'))));
    }
    const help = el('div', { class: 'stats unit-help' },'Icon: click selects only it · Ctrl + click removes · Shift + click marks, release Shift to select the marked · ' +
      'Right-click: move / attack · Hold right button: see where they go, drag to turn the formation (longer drag: wider) · A + right-click: attack-move · Shift + right-click: queue orders · S: stop · H: hold · Delete: disband · Ctrl+1–9: save group · ' +
      'Right-click your transport near a coast: go on board · L: transports take idle units nearby on board, land units find transports · Right-click land with units on board, or U: unload · Ctrl + B: drop ships · Shift + B: only ships · Ctrl + F: drop full transports · Shift + F: only full ones');
    this.panel.append(help);
    // Many units: the panel has a height limit, and the icons need the room more than the help
    // line does. If keeping it would make them scroll, it goes.
    if (box.scrollHeight > box.clientHeight + 1) help.remove();
  }

  // Some of the selected units are gone (killed, or on board a transport) and none came: their icons leave the
  // panel, which is not built again. Building it for hundreds of units takes long, and in a battle every death
  // did it: the game stalled again and again. False when it has to be built again: a unit added, a transport
  // gone (the cargo row lists them), or no unit left to make a Hero or Healer (that row goes).
  dropUnitTiles(ids) {
    const tl = this.dyn.unitTiles, keep = new Set(ids);
    if (ids.some((id) => !tl.byId.has(id))) return false;
    const gone = [...tl.byId.keys()].filter((id) => !keep.has(id));
    if (!gone.length || gone.some((id) => tl.byId.get(id).def.capacity)) return false;
    if (this.dyn.hero && !this.g.promotionCandidates().length) return false;
    for (const id of gone) {
      tl.byId.get(id).tile.remove();
      tl.byId.delete(id);
    }
    tl.head.textContent = `${ids.length} unit${ids.length === 1 ? '' : 's'} selected`;
    // The type buttons: their ids (the same arrays their clicks use) without the gone ones, and their counts.
    tl.chips = tl.chips.filter((c) => {
      for (let i = c.ids.length - 1; i >= 0; i--) if (!keep.has(c.ids[i])) c.ids.splice(i, 1);
      if (!c.ids.length) { c.chip.remove(); return false; }
      c.count.textContent = String(c.ids.length);
      return true;
    });
    if (tl.groups && tl.chips.length < 2) {         // one type left: no type buttons, as when built so
      tl.groups.remove();
      tl.groups = null;
      tl.chips = [];
    }
    return true;
  }

  // Make Hero (Cult of Heroes) and Make Healer (Order of Mercy) for a single selected plain land unit,
  // once the tradition is learned. Kept current in refreshHeroRow().
  buildHeroRow() {
    const g = this.g;
    const plain = g.promotionCandidates().length > 0;
    const canMake = g.hasTradition('heroes') && plain;
    const canHeal = g.hasTradition('mercy') && plain;
    if (!canMake && !canHeal) return;
    const row = el('div', { class: 'hero-row' });
    const d = {};
    if (canMake) {
      d.make = el('button', { type: 'button', onclick: () => g.promote('hero') },
        'Make Hero ', el('span', { class: 'honor' }), ` ${HERO.cost}`, el('kbd', {}, 'C'));
      row.append(d.make);
    }
    if (canHeal) {
      d.heal = el('button', { type: 'button', onclick: () => g.promote('healer') },
        'Make Healer ', el('span', { class: 'honor' }), ` ${HEALER.cost}`);
      row.append(d.heal);
    }
    this.panel.append(row);
    this.dyn.hero = d;
  }

  refreshHeroRow(d) {
    const g = this.g;
    if (d.heal) {
      const n = g.promotionCandidates().length, h = UNITS.healer;
      d.heal.disabled = n !== 1 || g.honor < HEALER.cost;
      d.heal.title = n !== 1 ? 'Select a single land unit to make it a Healer'
        : g.honor < HEALER.cost ? `A Healer costs ${HEALER.cost} honor: you have ${g.honor}`
          : `This unit becomes a Healer for ${HEALER.cost} honor: ${h.hp} HP, ${h.damage} damage/s. Your land units within ` +
            `${HEALER.radius} km heal ${HEALER.hpPerSecond} HP per second. It keeps its place, its orders and its share of HP.`;
    }
    if (d.make) {
      const ids = g.promotionCandidates(), n = ids.length, h = UNITS.hero;
      const from = n === 1 ? g.unitById.get(ids[0]) : null;
      const kind = from ? HERO.kinds[UNIT_TYPES[from.t]] || 'infantry' : 'infantry';
      d.make.disabled = n !== 1 || g.honor < HERO.cost;
      d.make.title = n !== 1 ? 'Select a single land unit to make it a Hero'
        : g.honor < HERO.cost ? `A Hero costs ${HERO.cost} honor: you have ${g.honor}`
          : `This unit becomes ${heroName(kind, true)} for ${HERO.cost} honor: ${h.hp} HP, ${h.damage} damage/s, with its ` +
            `speed and range. Your land units within ${HERO.auraRadius} km of it deal +${Math.round(HERO.auraBonus * 100)}% ` +
            'damage. It keeps its place, its orders and its share of HP.';
    }
  }

  // Your selected transports and the Unload button (U), which asks where to land them. With one
  // transport selected, a place per unit it carries shows who is on board; with several, their
  // tiles only show how many.
  buildCargo(ships, myColor) {
    const g = this.g;
    const box = el('div', { class: 'cargo' });
    const rows = [];
    for (const id of ships.length === 1 ? ships : []) {
      const u = g.unitById.get(id);
      const row = el('div', { class: 'cargo-row' }, el('img', { class: 'cargo-ship', src: unitIconURL(myColor, u.t), alt: '' }));
      const slots = [];
      for (let k = 0; k < UNITS[UNIT_TYPES[u.t]].capacity; k++) {
        const img = el('img', { alt: '' });
        const fill = el('i');
        const slot = el('span', { class: 'cargo-slot empty', title: 'Empty place' }, img, el('span', { class: 'uhp' }, fill));
        row.append(slot);
        slots.push({ slot, img, fill });
      }
      box.append(row);
      rows.push({ id, slots, key: null });
    }
    const unload = el('button', {
      type: 'button', class: 'primary', title: 'Pick any land or city: the transports land their units on the nearest coast and send them there',
      onclick: () => g.startUnload(),
    }, 'Unload', el('kbd', {}, 'U'));
    const autoload = el('button', {
      type: 'button',
      title: `Your idle land units within ${NAVAL.autoloadRange} km of the selected transports go on board, ` +
        `each to the nearest transport with room. Units with orders stay. With land units selected too, they go instead: they find your transports with room within ${NAVAL.autoboardRange} km.`,
      onclick: () => g.commandAutoload(),
    }, 'Autoload', el('kbd', {}, 'L'));
    const note = el('span', { class: 'muted small' });
    box.append(el('div', { class: 'cargo-actions' }, autoload, unload, note));
    this.panel.append(box);
    this.dyn.cargo = { rows, unload, autoload, note, ships };
  }

  refreshCargo(cg) {
    const g = this.g;
    for (const row of cg.rows) {
      const list = g.cargoOf(row.id);
      const key = list.map((c) => `${c.t}:${c.hp}`).join(',');
      if (key === row.key) continue;
      row.key = key;
      row.slots.forEach((s, k) => {
        const c = list[k];
        s.slot.classList.toggle('empty', !c);
        if (!c) {
          s.img.removeAttribute('src');
          s.fill.style.width = '0';
          s.slot.title = 'Empty place';
          return;
        }
        const def = UNITS[UNIT_TYPES[c.t]];
        const src = unitEmblemURL(c.t);
        if (s.img.getAttribute('src') !== src) s.img.src = src;
        const frac = Math.max(0, Math.min(1, c.hp / def.hp));
        s.fill.style.width = `${frac * 100}%`;
        s.fill.style.background = frac > 0.6 ? '#5ccf54' : frac > 0.3 ? '#e8c440' : '#e0503a';
        s.slot.title = `${def.name}: ${c.hp} / ${def.hp} HP, on board`;
      });
    }
    let aboard = 0, room = 0;
    for (const id of cg.ships) {
      const u = g.unitById.get(id);
      if (!u) continue;
      aboard += u.flags >> CARGO_SHIFT;
      room += UNITS[UNIT_TYPES[u.t]].capacity;
    }
    cg.unload.disabled = !aboard;
    cg.autoload.disabled = aboard >= room && !g.selectedLandUnits().length;   // land units selected: they look for transports
    const text = aboard ? `${aboard} of ${room} places taken. Unload, then click land or a city.`
      : 'Empty. Autoload takes idle units nearby on board, or select units and right-click the transport.';
    if (cg.note.textContent !== text) cg.note.textContent = text;
  }

  buildUnitInfo(u) {
    const g = this.g;
    const def = g.unitStats(u);         // a Hero: the speed and range of its kind
    this.panel.append(el('div', { class: 'head' },
      el('img', { src: unitIconURL(g.colorOf(u.owner), u.t, g.spriteVariant(u)), alt: '', style: 'width:34px;height:34px' }),
      el('h4', {}, def.hero ? heroName(g.heroKind(u)) : def.name),
      el('span', { class: 'sub' }, g.nameOf(u.owner))));
    const hpFill = el('i');
    const hpText = el('b');
    // Its speed where it is now: faster on roads (kept current in refreshDynamic).
    const speedText = el('b', {}, String(def.moveSpeed)), roads = el('span', {}, ' on roads');
    roads.hidden = true;
    this.panel.append(el('div', { class: 'hpbar' }, hpFill));
    this.panel.append(el('div', { class: 'stats' },
      el('span', {}, 'HP ', hpText),
      // How many are on board: only its owner knows (the snapshot says 0 for other players' ships).
      def.capacity ? el('span', { title: u.owner === g.you ? '' : 'Only its owner sees how many units are on board' }, 'On board ',
        el('b', {}, u.owner === g.you ? `${u.flags >> CARGO_SHIFT} / ${def.capacity}` : `? / ${def.capacity}`))
        : el('span', {}, 'Damage ', el('b', {}, def.reload ? `${def.damage} / ${def.reload}s` : `${def.damage}/s`)),
      def.capacity ? null : el('span', {}, 'Range ', el('b', {}, def.attackRange ? String(def.attackRange) : 'melee')),
      el('span', {
        title: def.naval ? '' : `With ${TECHS.roads.name} (Tech, Land tab), land units march ${TECHS.roads.speedPercent}% ` +
          'faster in the regions their owner holds whole',
      }, 'Speed ', speedText, roads)));
    const note = el('div', { class: 'disband-note' }, `Disbanding: loses ${DISBAND.hpPerSecond} HP per second until it dies`);
    note.hidden = true;
    this.panel.append(note);
    this.dyn.unitHp = { fill: hpFill, text: hpText, id: u.id, def, note, speedText, roads };
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
      const aboard = s.count ? u.flags >> CARGO_SHIFT : 0;
      const key = `${u.hp}|${picked}|${disbanding}|${aboard}`;
      if (key === s.key) continue;
      s.key = key;
      const frac = Math.max(0, Math.min(1, u.hp / s.def.hp));
      s.fill.style.width = `${frac * 100}%`;
      s.fill.style.background = frac > 0.6 ? '#5ccf54' : frac > 0.3 ? '#e8c440' : '#e0503a';   // as the bars on the map
      s.tile.classList.toggle('picked', picked);
      s.tile.classList.toggle('disbanding', disbanding);
      if (s.count) {
        s.count.textContent = String(aboard);
        s.count.hidden = !aboard;
      }
      const load = s.count ? `, ${aboard} of ${s.def.capacity} on board` : '';
      s.tile.title = `${s.def.name}: ${Math.ceil(u.hp)} / ${s.def.hp} HP${load}${disbanding ? ', disbanding' : ''}\n` +
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
      for (const b of this.colButtons) {
        if (b.honorBarracks) {
          const open = st.ids.filter((ci) => g.nextUpgrade(ci, 'barracks') && !full(ci));
          b.btn.disabled = !open.length || g.honor < b.price;
          const one = st.ids.length === 1 && !g.nextUpgrade(st.ids[0], 'barracks');
          const built = one && g.hasUpgrade(st.ids[0], 'barracks');
          const text = one ? (built ? 'built' : 'in queue') : `${b.price}${b.many ? ' each' : ''}`;
          if (b.amount.textContent !== text) b.amount.textContent = text;
          b.btn.classList.toggle('built', built);
          continue;
        }
        const { btn, def, item, state, eff, about, title } = b;
        if (!CITY_UPGRADES[item]) {
          const ids = def.naval ? st.ids.filter((ci) => g.isCoastal(ci)) : st.ids;   // ships: coastal cities
          // Training: how far the one at the head of a selected city's queue is (with several, the furthest along).
          let done = -1;
          for (const ci of ids) {
            const q = g.myQueues.get(ci);
            if (q?.queue.length && PRODUCTION_ITEMS[q.queue[0]] === item) done = Math.max(done, q.progress / def.buildTime);
          }
          b.prog.hidden = done < 0;
          if (done >= 0) b.prog.style.width = `${Math.min(1, done) * 100}%`;
          // The guide's first step (client.js startGuide), first game of the session: this is the button.
          btn.classList.toggle('guide-pulse', item === 'infantry' && g.guideHighlight && g.guideStep === 1);
          // Ships without their technology: not greyed out but locked, saying why; a click opens the Sea tab.
          const locked = !g.canTrain(item);
          const honor = !locked && this.unitsForHonor();
          const price = honor ? def.cost * TRADITIONS.eternalGlory.unitHonorFactor : def.cost;
          btn.classList.toggle('locked', locked);
          btn.classList.toggle('honor-buy', honor);
          btn.disabled = !locked && ((honor ? g.honor : g.gold) < price || !ids.length || ids.every(full));
          const text = locked ? `🔒 ${TECHS[def.tech].name}` : this.unitCostText(def, st.ids, honor);   // shorter once a Barracks is built
          if (b.shownCost !== `${honor}|${text}`) {
            b.shownCost = `${honor}|${text}`;
            state.replaceChildren(...(honor ? [el('span', { class: 'honor' }), text] : [text]));
          }
          const line = locked ? this.techLock(def.tech) : about;
          if (eff.textContent !== line) eff.textContent = line;
          const tech = locked ? TECHS[def.tech] : null;
          const first = tech?.requires && !g.myTech()[tech.requires] ? ` It needs ${TECHS[tech.requires].name} first.` : '';
          const tip = locked ? `${def.name}: needs the ${tech.name} technology ` +
            `(${tech.levels[0].cost} gold, ${tech.levels[0].time} s).${first} Click to open Technologies on the Sea tab.` : title;
          if (btn.title !== tip) btn.title = tip;
          continue;
        }
        // An upgrade: what an order queues in each city, its next grade (null: every grade is built
        // or queued). The button shows the lowest of them, or the top grade once all are ordered.
        const next = st.ids.map((ci) => g.nextUpgrade(ci, item));
        const grades = upgradeGrades(item);
        const shown = grades.find((k) => next.includes(k)) || grades.at(-1);
        const sd = CITY_UPGRADES[shown];
        if (b.shown !== shown) {
          b.shown = shown;
          b.name.textContent = sd.name;
          b.img.src = upgradeIconURL(shown, b.color);
        }
        const effect = this.upgradeEffect(sd);
        if (eff.textContent !== effect) eff.textContent = effect;
        // Usable while one of the cities can take a grade and there is gold for the cheapest of them.
        const open = next.map((k, i) => (k && !full(st.ids[i]) ? CITY_UPGRADES[k] : null)).filter(Boolean);
        btn.disabled = !open.length || g.gold < Math.min(...open.map((d) => d.cost));
        let text = this.upgradeCostText(open.length ? open : [sd], st.ids.length > 1);
        const all = st.ids.length === 1 && !next[0];
        const built = all && g.hasUpgrade(st.ids[0], shown);
        if (all) text = built ? 'built' : 'in queue';
        if (state.textContent !== text) state.textContent = text;
        btn.classList.toggle('built', built);
      }
    }
    if (d.queueProg && st.q) {
      d.queueProg.el.style.width = `${Math.min(1, st.q.progress / d.queueProg.def.buildTime) * 100}%`;
    }
    if (d.unitTiles) this.refreshUnitTiles(d.unitTiles);
    if (d.cargo) this.refreshCargo(d.cargo);
    if (d.hero) this.refreshHeroRow(d.hero);
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
        const f = g.roadFactor(u), speed = String(Math.round(d.unitHp.def.moveSpeed * f * 10) / 10);
        if (d.unitHp.speedText.textContent !== speed) d.unitHp.speedText.textContent = speed;
        d.unitHp.roads.hidden = f === 1;
      }
    }
  }
}
