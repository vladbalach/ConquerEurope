// DOM HUD: resource bar, selection panel (city production / units / info), feed, overlays.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, PRODUCTION_ITEMS, ECONOMY, DISBAND, PLAYER_COLOR_NAMES } from '/shared/config.js';
import { unitIconURL, upgradeIconURL } from './sprites.js';
import { UNIT_CLASSES } from './units/index.js';
import { BalanceEditor } from './balance-editor.js';

const $ = (id) => document.getElementById(id);
const HINT_CLOSED_KEY = 'coe.hintClosed';   // the player closed the "how to play" tip (localStorage)

function loadHintClosed() {
  try { return localStorage.getItem(HINT_CLOSED_KEY) === '1'; } catch { return false; }
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
      [$('btn-help'), 'click', () => this.toggleHelp()],
      [$('help-close'), 'click', () => this.toggleHelp(false)],
      [$('btn-leave'), 'click', () => {
        if (this.g.ended || confirm('Leave this game? Your cities will become neutral.')) this.g.leave();
      }],
      [$('gameover-leave'), 'click', () => this.g.leave()],
    ];
    for (const [t, ev, fn] of this.handlers) t.addEventListener(ev, fn);

    $('hud-title').textContent = game.title;
    $('stat-gold').title = `Gold. Every ${ECONOMY.turnSeconds} seconds (one turn) each city you hold pays ` +
      `${ECONOMY.goldPerCityPerTurn} gold.`;
    $('stat-turn').title = `Turns passed since the start, and time until the next turn pays out gold ` +
      `(${ECONOMY.goldPerCityPerTurn} per city).`;
    $('gameover').hidden = true;
    $('scoreboard').hidden = true;
    $('help').hidden = true;
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

  toggleHelp(force) {
    const h = $('help');
    h.hidden = force === undefined ? !h.hidden : !force;
  }

  closeOverlays() {
    const open = !$('help').hidden || !$('scoreboard').hidden || this.editor.isOpen;
    $('help').hidden = true;
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
    const table = el('table', {},
      el('tr', {}, el('th', {}, ''), el('th', {}, 'Player'), el('th', {}, 'Cities'), el('th', {}, 'Units'),
        el('th', { class: 'num', title: 'Gold value of enemy units this player destroyed' }, 'Kills'),
        el('th', { class: 'num', title: 'Gold value of units this player lost' }, 'Losses'),
        el('th', {}, '')));
    for (const p of rows) {
      const status = p.eliminated ? 'Eliminated' : !p.connected ? 'Disconnected' : '';
      // Players are known by colour; nicknames arrive only once the game is over.
      const who = g.nameOf(p.id);
      table.append(el('tr', { class: p.id === g.you ? 'me-row' : '' },
        el('td', {}, el('span', { class: 'swatch', style: `background:${p.color}` })),
        el('td', {}, who, p.name ? el('span', { class: 'muted' }, ` · ${p.name}`) : null),
        el('td', {}, String(p.cities)),
        el('td', {}, String(p.units)),
        el('td', { class: 'num kills' }, gold(p.kills)),
        el('td', { class: 'num losses' }, gold(p.losses)),
        el('td', { class: 'muted small' }, status)));
    }
    sb.append(table);
    const neutral = g.cityOwner.filter((o) => o < 0).length;
    sb.append(el('p', { class: 'muted small' },
      `Kills and losses are in gold: the cost of the units destroyed. ${neutral} neutral cities · first to 120 cities wins`));
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

  feed(text, cls = '') {
    const d = el('div', { class: cls }, text);
    this.feedEl.append(d);
    while (this.feedEl.children.length > 6) this.feedEl.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0'; }, 7000);
    setTimeout(() => d.remove(), 7700);
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
    $('hud-units').textContent = String(g.ownUnitCount());
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
      const counts = UNIT_TYPES.map(() => 0);
      for (const id of g.selection) {
        const u = g.unitById.get(id);
        if (u) counts[u.t]++;
      }
      return { key: `units:${counts.join(',')}`, kind: 'units', counts };
    }
    if (g.inspect) {
      const { k, id } = g.inspect;
      if (k === 'c') return { key: `ic:${id}:${g.cityOwner[id]}:${g.cityUpgrades[id]}`, kind: 'icity', id };
      const u = g.unitById.get(id);
      if (u) return { key: `iu:${id}`, kind: 'iunit', u };
    }
    return { key: 'none', kind: 'none' };
  }

  updatePanel() {
    const st = this.panelState();
    if (st.key !== this.panelKey) {
      this.panelKey = st.key;
      this.dyn = {};
      this.panel.textContent = '';
      // With nothing selected the panel shows a tip; once the tip is closed, the panel only appears for a selection.
      this.panel.hidden = st.kind === 'none' && this.hintClosed;
      if (st.kind === 'city') this.buildCityPanel(st);
      else if (st.kind === 'cities') this.buildCitiesPanel(st);
      else if (st.kind === 'units') this.buildUnitsPanel(st);
      else if (st.kind === 'icity') this.buildCityInfo(st.id);
      else if (st.kind === 'iunit') this.buildUnitInfo(st.u);
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
        el('br'), 'Press ', el('b', {}, 'H'), ' to jump between your cities, ', el('b', {}, 'F1'), ' for all controls.'));
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
      g.cityTrainRate(ci) > 1
        ? el('span', {}, 'Training ', el('b', {}, `+${Math.round((g.cityTrainRate(ci) - 1) * 100)}%`)) : null,
      el('span', {}, 'Upgrades ', el('b', {}, built.length ? built.join(', ') : 'none'))));
    this.dyn.cityHp = { fill: hpFill, text: hpText, ci };
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
      el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click map: rally point')));
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
    queue.append(el('span', { class: 'label', style: 'margin-left:auto' }, 'Right-click map: rally point'));
    this.panel.append(queue);
  }

  buildCityInfo(ci) {
    this.cityHeader(ci);
    const g = this.g;
    const owner = g.cityOwner[ci];
    this.panel.append(el('div', { class: 'hint small' },
      owner < 0 ? 'Neutral cities defend themselves. Bring its HP to zero to capture it.'
        : 'Enemy city. Select units and right-click it to attack.'));
  }

  buildUnitsPanel(st) {
    const g = this.g;
    const total = st.counts.reduce((a, b) => a + b, 0);
    const myColor = g.colorOf(g.you);
    this.panel.append(el('div', { class: 'head' },
      el('h4', {}, `${total} unit${total === 1 ? '' : 's'} selected`)));
    const groups = el('div', { class: 'unit-groups' });
    st.counts.forEach((n, t) => {
      if (!n) return;
      const def = UNITS[UNIT_TYPES[t]];
      groups.append(el('button', {
        type: 'button', class: 'unit-group', title: `${UNIT_CLASSES[t].describe()}\nClick to select only ${def.name.toLowerCase()}.`,
        onclick: () => g.select([...g.selection].filter((id) => g.unitById.get(id)?.t === t), false),
      }, el('img', { src: unitIconURL(myColor, t), alt: '' }), el('b', {}, String(n)), el('span', {}, def.name)));
    });
    this.panel.append(groups);
    const hpFill = el('i');
    this.panel.append(el('div', { class: 'hpbar', style: 'margin-top:8px' }, hpFill));
    this.dyn.groupHp = hpFill;
    const note = el('div', { class: 'disband-note' });
    note.hidden = true;
    this.panel.append(note);
    this.dyn.groupDisband = note;
    this.panel.append(el('div', { class: 'stats' }, 'Right-click: move / attack · A + right-click: attack-move · S: stop · Delete: disband · Ctrl+1–9: save group'));
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

  refreshDynamic(st) {
    const g = this.g, d = this.dyn;
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
