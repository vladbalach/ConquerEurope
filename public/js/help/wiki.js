// The help (F1): a small wiki of the game. A list of pages on the left (with a search box), the page on the
// right. Pages are written from the current numbers each time they are shown (an admin may have changed the
// balance, and Economy and Winning speak of your game), with the game's own icons, and with animated demos
// (demo.js, scenes.js) of the controls and rules, played on the real map as if recorded from a game.
// Advanced details sit in tooltips: a dotted underline, or a small ⓘ.
import {
  UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, ECONOMY, GAME, TECHS, TECH_TABS, TRADITIONS, TRADITION_TYPES,
  HERO, HEALER, LIBERATOR, NAVAL, COMBAT, DISBAND, PLAYER_COLOR_NAMES,
} from '/shared/config.js';
import { liberatorIncome, influenceLimit, techCost } from '/shared/tech.js';
import { describeOptions, GOLD_PERCENT } from '/shared/options.js';
import { unitIconURL, upgradeIconURL, techIconURL, traditionIconURL } from '../sprites.js';
import { Demo, DEMO_W, DEMO_H, demoColors } from './demo.js';
import { SCENES } from './scenes.js';

// ------------------------------------------------------------------ small DOM helpers
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
const p = (...c) => el('p', {}, ...c);
const b = (text) => el('b', {}, String(text));
const note = (...c) => el('p', { class: 'muted small' }, ...c);
const li = (...c) => el('li', {}, ...c);
const ul = (...items) => el('ul', { class: 'wiki-list' }, ...items);
// A key, or keys pressed together: k('Ctrl', '1') → Ctrl + 1.
const k = (...names) => el('span', { class: 'keys' }, ...names.flatMap((n, i) => (i ? [' + ', el('kbd', {}, n)] : [el('kbd', {}, n)])));
const mouse = (what) => el('kbd', { class: 'mouse' }, what);
// A word with more behind it: hover for the details.
const term = (text, tip) => el('span', { class: 'term', title: tip }, text);
const more = (tip) => el('span', { class: 'more', title: tip, 'aria-label': 'More' }, 'i');
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const gold = (n) => `${Math.round(n * 10) / 10} gold`;
const secs = (s) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);

// ------------------------------------------------------------------ the window
export class HelpWiki {
  constructor(g, root) {
    this.g = g;
    this.root = root;
    this.demos = [];
    this.page = 'welcome';
    this.built = false;
  }

  get open() { return !this.root.hidden; }

  toggle(force) {
    const show = force === undefined ? this.root.hidden : force;
    if (!show) { this.close(); return; }
    if (!this.built) this.build();
    this.root.hidden = false;
    this.show(this.page);
    this.search.value = '';
    this.filter('');
  }

  close() {
    this.root.hidden = true;
    this.stopDemos();
  }

  build() {
    this.built = true;
    this.nav = el('nav', { class: 'wiki-nav', 'aria-label': 'Help pages' });
    this.search = el('input', {
      type: 'search', class: 'wiki-search', placeholder: 'Search the help', 'aria-label': 'Search the help',
      oninput: () => this.filter(this.search.value),
    });
    this.links = new Map();
    let group = null, list = null;
    for (const page of PAGES) {
      if (page.group !== group) {
        group = page.group;
        list = el('div', { class: 'wiki-group' }, el('h5', {}, group));
        this.nav.append(list);
      }
      const link = el('button', { type: 'button', class: 'wiki-link', onclick: () => this.show(page.id) },
        el('span', { class: `wiki-ico ico-${page.icon}` }), page.title);
      this.links.set(page.id, link);
      list.append(link);
    }
    this.noMatch = el('p', { class: 'muted small wiki-nomatch', hidden: '' }, 'No page mentions that.');
    this.article = el('article', { class: 'wiki-page', tabindex: '-1' });
    const side = el('div', { class: 'wiki-side' }, el('h2', {}, 'Help'), this.search, this.nav, this.noMatch);
    const close = el('button', { type: 'button', class: 'wiki-close', title: 'Close (F1 or Esc)', 'aria-label': 'Close', onclick: () => this.close() }, '×');
    this.root.replaceChildren(side, this.article, close);
  }

  // Search: the pages whose words include all of the words typed.
  filter(query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!this.texts) this.texts = new Map(PAGES.map((pg) => [pg.id, this.pageText(pg)]));
    let shown = 0;
    for (const [id, link] of this.links) {
      const hit = !words.length || words.every((w) => this.texts.get(id).includes(w));
      link.hidden = !hit;
      if (hit) shown++;
    }
    for (const group of this.nav.children) group.hidden = ![...group.querySelectorAll('.wiki-link')].some((l) => !l.hidden);
    this.noMatch.hidden = shown > 0;
  }

  pageText(page) {
    const box = el('div', {}, ...page.build(this.helpers(true)));
    return `${page.title} ${box.textContent} ${[...box.querySelectorAll('[title]')].map((e) => e.title).join(' ')}`.toLowerCase();
  }

  show(id) {
    const page = PAGES.find((pg) => pg.id === id) || PAGES[0];
    this.page = page.id;
    for (const [pid, link] of this.links) link.classList.toggle('active', pid === page.id);
    this.stopDemos();
    const h = this.helpers(false);
    this.article.replaceChildren(el('h1', {}, page.title), ...page.build(h));
    this.article.scrollTop = 0;
    this.startDemos();
  }

  // ---------------------------------------------------------------- demos
  // A demo plays while at least a third of it is in view; the others wait (and cost nothing).
  startDemos() {
    const figures = [...this.article.querySelectorAll('figure.demo')];
    if (!figures.length) return;
    this.colors = demoColors(this.g);
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const fig = e.target;
        if (e.isIntersecting && !fig.demo) {
          const scene = SCENES[fig.dataset.scene];
          if (!scene) continue;
          fig.demo = new Demo(scene, fig.querySelector('canvas'), { g: this.g, colors: this.colors, caption: fig.querySelector('figcaption') });
          this.demos.push(fig.demo);
        }
        if (fig.demo) fig.demo.playing = e.isIntersecting;
      }
      this.loop();
    }, { root: this.article, threshold: 0.33 });
    for (const f of figures) this.observer.observe(f);
  }

  loop() {
    if (this.raf) return;
    let last = performance.now();
    const frame = (now) => {
      this.raf = 0;
      if (!this.open) return;
      const dt = now - last;
      last = now;
      let any = false;
      for (const d of this.demos) if (d.playing) { d.tick(dt); any = true; }
      if (any) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stopDemos() {
    this.observer?.disconnect();
    this.observer = null;
    for (const d of this.demos) d.destroy();
    this.demos = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---------------------------------------------------------------- what pages are made of
  helpers(indexOnly) {
    const g = this.g, wiki = this;
    const myColor = g.colorOf(g.you) || '#4363d8';
    return {
      g, myColor,
      link: (id, text) => el('button', { type: 'button', class: 'wiki-goto', onclick: () => wiki.show(id) }, text),
      // A section: a demo on the left (if any), what it shows on the right.
      card(opts, ...body) {
        const fig = opts.demo && !indexOnly ? demoFigure(opts.demo) : null;
        return el('section', { class: `wiki-card${fig ? ' has-demo' : ''}` },
          fig, el('div', { class: 'wiki-card-body' }, opts.title ? el('h3', {}, opts.title) : null, ...body));
      },
      unitIcon: (type) => el('img', { class: 'wiki-icon', src: unitIconURL(myColor, UNIT_TYPES.indexOf(type)), alt: '' }),
      upgradeIcon: (key) => el('img', { class: 'wiki-icon', src: upgradeIconURL(key, myColor), alt: '' }),
      techIcon: (key) => el('img', { class: 'wiki-icon big', src: techIconURL(key, myColor), alt: '' }),
      traditionIcon: (key) => el('img', { class: 'wiki-icon big', src: traditionIconURL(key, myColor), alt: '' }),
    };
  }
}

function demoFigure(scene) {
  const canvas = el('canvas', { width: DEMO_W, height: DEMO_H, 'aria-label': `Animation: ${scene}` });
  canvas.style.width = `${DEMO_W}px`;
  canvas.style.height = `${DEMO_H}px`;
  // The screen, ↻ over it, and under it what is being shown (demo.js say()).
  const fig = el('figure', { class: 'demo', 'data-scene': scene },
    el('div', { class: 'demo-screen' }, canvas,
      el('button', { type: 'button', class: 'demo-replay', title: 'Play it again', 'aria-label': 'Play it again',
        onclick: () => fig.demo?.restart() }, '↻')),
    el('figcaption', { class: 'demo-caption', 'aria-live': 'polite' }));
  return fig;
}

const table = (head, rows, cls = '') => el('table', { class: `wiki-table ${cls}` },
  head ? el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))) : null,
  el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c))))));

// A row of the key tables: what to press, what it does.
const keyRow = (keys, what) => [keys, what];

// ------------------------------------------------------------------ the pages
const PAGES = [
  // ================================================================ getting started
  {
    id: 'welcome', group: 'Getting started', title: 'Welcome', icon: 'crown',
    build(h) {
      const g = h.g, o = g.options || {};
      const color = g.colorOf(g.you), name = PLAYER_COLOR_NAMES[color];
      return [
        el('p', { class: 'wiki-lead' }, 'Conquest of Europa is a real-time strategy game on a map of Europe. Everyone ' +
          'starts with a few cities. Train armies, storm cities, and be the first to hold enough of them.'),
        g.spectator ? null : p('You are ', el('b', { class: 'who', style: `color:${color}` }, name || 'your colour'),
          '. Your cities, territory and units are drawn in that colour; on the minimap your cities are outlined in white.'),
        h.card({ title: 'How to win' },
          p('Hold ', b(`${o.winCities ?? GAME.winCities} cities`), ' when a turn ends. ',
            term('More on the target', describeOptions(o)), '.'),
          ul(
            li('A turn lasts ', b(secs(ECONOMY.turnSeconds)), '. At its end every city pays its owner ', b(`${ECONOMY.goldPerCityPerTurn} gold`), '.'),
            li('Gold trains units and builds city upgrades. You start with ', b(`${o.startGold ?? ECONOMY.startGold} gold`), '.'),
            li('More cities: more gold, a bigger army, more cities. ', h.link('winning', 'Winning'), ' has the details.'))),
        h.card({ demo: 'conquest', title: 'Your first conquest' },
          el('ol', { class: 'wiki-steps' },
            li(mouse('Left-click'), ' one of your cities.'),
            li('Press ', k('Q'), ' a few times: infantry. The bar under the city shows the training.'),
            li('Drag a frame round your new units to select them.'),
            li(mouse('Right-click'), ' a grey city near you. Your units storm it.'),
            li('When its HP reach zero the city is yours.')),
          note('The demos are played faster than the game when they say ×2 or ×3. ↻ plays one again.')),
        h.card({ title: 'Where to go next' },
          el('div', { class: 'wiki-next' },
            h.link('selecting', 'Selecting'), h.link('moving', 'Moving'), h.link('fighting', 'Fighting'),
            h.link('cities', 'Cities'), h.link('units', 'Units'), h.link('navy', 'Navy'), h.link('economy', 'Economy'),
            h.link('keys', 'All keys'))),
      ];
    },
  },
  {
    id: 'screen', group: 'Getting started', title: 'Your screen', icon: 'screen',
    build(h) {
      const top = document.getElementById('topbar');
      let bar = null;
      if (top) {
        bar = top.cloneNode(true);
        bar.removeAttribute('id');
        bar.classList.add('wiki-topbar');
        for (const e of bar.querySelectorAll('[id]')) e.removeAttribute('id');
        for (const e of bar.querySelectorAll('button')) { e.disabled = true; e.hidden = !['Tech', 'Players', 'Help', 'Leave'].includes(e.textContent); }
        [...bar.querySelectorAll('.stat')].forEach((s, i) => s.prepend(el('i', { class: 'callout' }, String(i + 1))));
      }
      return [
        h.card({ title: 'The top bar' },
          bar,
          el('ol', { class: 'wiki-steps' },
            li(b('Turns'), ' played, and the time to the end of this one: then every city pays its gold.'),
            li(b('Gold'), ', and how much you get at the end of the turn. Hover it for where it comes from.'),
            li(b('Honor'), ' (the silver star): earned by kills, spent on traditions. Click it, or press ', k('O'), '.'),
            li(b('Cities'), ' you hold, next to the number that wins (▾ while it is counting down).'),
            li(b('Units'), ' you command, those on board your ships included.')),
          p(b('Tech'), ' (', k('T'), '): technologies. ', b('Players'), ' (', k('Tab'), '): everyone\'s cities, units, income and traditions. ',
            b('Help'), ' (', k('F1'), '): this. ', b('Leave'), ': surrender, or go back to the lobby.')),
        h.card({ title: 'Around the map' },
          ul(
            li(b('Bottom: the panel.'), ' What you selected: a city (HP, damage, range, income, queue) or units (their icons and HP). Click an icon to pick that unit out.'),
            li(b('Right: the build column.'), ' With your city selected: its upgrades and the units it can train, each with its key, price and time.'),
            li(b('Bottom left: the minimap.'), ' All of Europe. ', mouse('Left-click'), ' it to look there, ', mouse('right-click'), ' it to send the selected units. Drag its top right corner to resize it.'),
            li(b('Above the minimap: the chat.'), ' New messages show there for a few seconds, each player by colour. ', k('Enter'),
              ' opens it to write and to read back; ', k('Enter'), ' sends, ', k('Esc'), ' closes it. Spectators talk among themselves until the game is over.'),
            li(b('Top left: the feed.'), ' What just happened: captures, kills, research done, alerts.'),
            li(b('Top centre: the race.'), ' Players close to winning, and big news such as a tradition someone learned.'),
            li(b('Top right: the standings.'), ' Every player\'s cities, kills and deaths, counted in units, the most cities first. ',
              'Hover a number for the gold it was worth. Click its head to fold it away, and again to bring it back.'))),
        h.card({ title: 'Reading the map' },
          ul(
            li(b('Your colour'), ' tints the land of your cities. Grey castles are ', b('neutral'), ': nobody\'s, and they shoot at everyone who comes near.'),
            li(b('Dark lines'), ' are the borders of ', h.link('economy', 'regions'), ' (their names are printed on the map); faint lines split one region\'s cities.'),
            li(b('Mountains'), ' (rocky ground with hill signs) can\'t be crossed: units walk round them or through their passes. ',
              more('Nothing shoots over mountains either: archers, battleships and cities need a clear line to their target.')),
            li(b('Coasts'), ': a sandy line with teal shallows is a beach, where ships take units on board and land them. A rock face is a cliff: no landing there.'),
            li('An ', b('anchor'), ' next to a city: it is coastal, and builds ships.'))),
      ];
    },
  },

  // ================================================================ controls
  {
    id: 'selecting', group: 'Controls', title: 'Selecting', icon: 'cursor',
    build(h) {
      return [
        p('Everything starts with a selection: what you select takes your next order.'),
        h.card({ demo: 'select-click', title: 'Click' },
          p(mouse('Left-click'), ' a unit of yours to select it. ', k('Shift'), ' + click adds a unit to the selection, or takes it out.'),
          p(mouse('Left-click'), ' empty ground (or press ', k('Esc'), ') to clear the selection. Clicking someone else\'s unit or city shows its panel.')),
        h.card({ demo: 'select-box', title: 'Drag a frame' },
          p('Drag with the left button: all your units inside the frame are selected. ', k('Shift'), ' + drag adds them to what you have.')),
        h.card({ demo: 'select-double', title: 'Double-click and F2' },
          p(mouse('Double-click'), ' a unit: all your units of that kind on screen. On your city: all your cities on screen. ', k('Shift'), ' adds them.'),
          p(k('F2'), ' selects every unit you have.')),
        h.card({ demo: 'select-cities', title: 'Cities' },
          p(mouse('Left-click'), ' your city to select it. A frame with none of your units in it selects your cities in it; ',
            k('Alt'), ' + drag selects only cities, even with units inside.'),
          p('With several cities selected, one key trains a unit (or builds an upgrade) in each of them.')),
        h.card({ demo: 'groups', title: 'Control groups' },
          p(k('Ctrl', '1'), ' … ', k('Ctrl', '9'), ' saves the selection as a group. ', k('1'), ' … ', k('9'), ' selects it again; press it twice quickly to centre the view on it. ',
            k('Shift', '1'), ' adds the group to the selection.')),
        h.card({ demo: 'filters', title: 'Ships or land units only' },
          table(null, [
            keyRow(k('Shift', 'B'), 'Keep only the ships'),
            keyRow(k('Ctrl', 'B'), 'Remove the ships'),
            keyRow(k('Shift', 'F'), 'Keep only the full transports'),
            keyRow(k('Ctrl', 'F'), 'Remove the full transports'),
          ], 'keys'),
          note('A selection that would end up empty stays as it is.')),
        h.card({ title: 'Picking out of a selection' },
          p('With several units selected, the panel at the bottom shows an icon for each (or for each kind, in a big selection):'),
          table(null, [
            keyRow(el('span', {}, mouse('Click'), ' an icon'), 'Select only that unit (or that kind)'),
            keyRow(el('span', {}, k('Ctrl'), ' + ', mouse('click'), ' an icon'), 'Take it out of the selection'),
            keyRow(el('span', {}, k('Shift'), ' + ', mouse('click'), ' icons'), 'Mark several; when you let go of Shift, the marked ones become the selection'),
          ], 'keys')),
      ];
    },
  },
  {
    id: 'moving', group: 'Controls', title: 'Moving', icon: 'arrow',
    build(h) {
      return [
        p('With units selected, the right mouse button gives orders. A green ring where you click: a move.'),
        h.card({ demo: 'move', title: 'Right-click to move' },
          p(mouse('Right-click'), ' the ground: your selected units go there. A group spreads into a ', b('formation'),
            ' round the place: infantry in front, archers behind, Healers at the back, cavalry and knights on the two wings.'),
          p('Each unit finds its own way: round lakes and mountains, through ',
            term('passes', 'Gaps in the great ranges where the real passes are: Mont Cenis, Gotthard, Brenner, Somport, Dukla, Shipka, Darial, the Cilician Gates...'),
            ', but never across the sea: islands such as Britain or Sicily need ', h.link('navy', 'transports'), '.')),
        h.card({ demo: 'formation', title: 'Hold and drag: shape the formation' },
          p('Hold the right button: grey ghosts show where each unit will stand. Drag, and the formation faces the way you drag. The ',
            b('length'), ' of the drag sets its ', b('width'), ': twice as wide as the drag is long. A short drag: a deep column; a long one: a wide line.'),
          p('Let go to give the order; ', k('Esc'), ' before that cancels it.')),
        h.card({ demo: 'queue', title: 'Queue orders with Shift' },
          p(k('Shift'), ' + ', mouse('right-click'), ': the order waits until the ones before it are done. Selected units show their queue as a dashed route (green: move, orange: attack-move, red: attack).'),
          p('An order without Shift (or ', k('S'), ', ', k('H'), ') replaces the whole queue.')),
        h.card({ title: 'Also' },
          ul(
            li(k('Space'), ' centres the view on the selection.'),
            li(mouse('Right-click'), ' the minimap: the selected units go there.'),
            li('Units on a move don\'t fight back. To fight on the way, use an ', h.link('fighting', 'attack-move'), '.'))),
      ];
    },
  },
  {
    id: 'fighting', group: 'Controls', title: 'Fighting', icon: 'swords',
    build(h) {
      return [
        p('Units fight on their own when an enemy comes near (one in sight, ', b(`${COMBAT.visionRange} km`), '). These orders tell them more precisely what to do.'),
        h.card({ demo: 'attack-unit', title: 'Attack' },
          p(mouse('Right-click'), ' an enemy unit or city (a red marker): your selected units go for it and follow it anywhere until it falls.'),
          p('A kill pays you ', b(pct(ECONOMY.killGoldShare)), ' of the unit\'s cost in gold at once, and its cost in ', h.link('honor', 'honor'), '.')),
        h.card({ demo: 'amove', title: 'Attack-move' },
          p('Hold ', k('A'), ' and ', mouse('right-click'), ' (an orange marker): your units go there and fight every enemy they meet on the way. ',
            more('They fight the nearest enemy: one that moves out of reach is swapped for whichever is nearest then, and one that gets out of sight is let go while they walk on. On an enemy city: they fight the defenders met on the way, then the city. Works on the minimap too.')),
          p('The order to give an army on the march. A plain move ignores the enemy, even while it is being hit.')),
        h.card({ demo: 'hold', title: 'Hold position' },
          p(k('H'), ': they hold position, marked by a gold dashed ring. They never walk, not even to chase, and fight only what comes within reach. Other units can\'t push them aside.'),
          p('Any move, attack or stop ends it. Good for archers behind a line, or a guard on a bridge of land.')),
        h.card({ demo: 'stop', title: 'Stop' },
          p(k('S'), ': the selected units stop where they are and forget their queued orders.')),
        h.card({ demo: 'disband', title: 'Disband' },
          p(k('Delete'), ' disbands the selected units: they lose ', b(`${DISBAND.hpPerSecond} HP a second`), ' until they die, still obeying orders meanwhile. It can\'t be undone; cities can\'t be disbanded.'),
          note('A disbanded unit counts as a loss for you, and as a kill for an enemy who hit it in its last ',
            `${DISBAND.killCreditSeconds} seconds.`)),
        h.card({ demo: 'capture', title: 'Taking cities' },
          p('Attack a city that isn\'t yours: when its HP reach zero it is yours, with ', b(`${CITY.captureHp} HP`), '. Its upgrades are destroyed, and its owner gets back the gold of what was waiting in its queue.'),
          p('A city has ', b(`${CITY.hp} HP`), ', deals ', b(`${CITY.damage} damage a second`), ' to an enemy within ', b(`${CITY.attackRange} km`),
            ' and wins back ', b(`${CITY.hpRegen} HP a second`), ', even under attack: bring enough troops. Walls, towers and castles make it harder.')),
        h.card({ title: 'Good to know' },
          ul(
            li(b('Units fight units first.'), ' They attack a city on their own only when no enemy unit is in sight; an order to attack a city is always obeyed.'),
            li(b('Regeneration:'), ` units win back HP once they have been out of a fight for ${COMBAT.regenDelay} seconds.`),
            li(b('Nothing shoots over mountains.'), ' Archers walk round until they have a clear shot; melee units don\'t care.'),
            li(b('Archers'), ' can shoot across a narrow strait, and at ships near the shore.'))),
      ];
    },
  },
  {
    id: 'camera', group: 'Controls', title: 'Camera & alerts', icon: 'eye',
    build(h) {
      return [
        h.card({ demo: 'camera', title: 'Moving the view' },
          ul(
            li(k('←'), ' ', k('→'), ' ', k('↑'), ' ', k('↓'), ', the mouse at the screen edge, or dragging with the middle button: scroll.'),
            li('Mouse wheel: zoom; the point under the cursor stays put. Far out, cities become dots in their owner\'s colour and region names are hidden: the strategic view.'),
            li(k('Space'), ': back to the selection. ', mouse('Left-click'), ' the minimap: look there.'))),
        h.card({ demo: 'ranges', title: 'City ranges' },
          p('Hold ', k('Alt'), ': the attack radius of every city. Keep out of them, or go in strong.')),
        h.card({ title: 'Alerts' },
          ul(
            li(b('Your units or cities under attack'), ' where you aren\'t looking: an orange ping on the minimap, a line in the feed and a trumpet. ',
              more('Once per battle, not per hit. A battle of units alerts once it has cost 15% of a unit\'s HP or a unit has died. Your city under attack, or your loaded transport under fire, alert at the first hit. Fights you sent your units into don\'t count.')),
            li(b('A city of yours captured:'), ' a red ping, the minimap\'s frame glows red, and a sword clash.'),
            li(k('Shift', 'Space'), ' goes through your last 5 alerts, newest first: press again for the next older one.'),
            li('Sounds also tell you when research is done (a quill) and a tradition is learned (a choir). A clock ticks in the last seconds of every turn.'))),
        h.card({ title: 'The minimap' },
          ul(
            li('All of Europe, every empire in its colour; your cities outlined in white, your units as white dots.'),
            li(mouse('Left-click'), ' or drag on it: the view goes there. ', mouse('Right-click'), ': the selected units go there (', k('A'), ' held: attack-move).'),
            li('Drag its top right corner to resize it; double-click the corner for the default size.'))),
      ];
    },
  },
  {
    id: 'keys', group: 'Controls', title: 'All keys', icon: 'keyboard',
    build() {
      const units = UNIT_TYPES.filter((t) => UNITS[t].hotkey).map((t) => `${UNITS[t].hotkey} ${UNITS[t].name.toLowerCase()}`).join(' · ');
      const ups = UPGRADE_TYPES.filter((u) => CITY_UPGRADES[u].hotkey).map((u) => `${CITY_UPGRADES[u].hotkey} ${CITY_UPGRADES[u].name}`).join(' · ');
      const section = (title, rows) => [el('h3', { class: 'wiki-sub' }, title), table(null, rows, 'keys')];
      return [
        ...section('Mouse', [
          keyRow(mouse('Left-click'), 'Select a unit or city · empty ground: clear the selection'),
          keyRow(el('span', {}, mouse('Left'), ' drag'), 'Select your units in the frame (none inside: your cities)'),
          keyRow(mouse('Double-click'), 'All your units of that kind on screen · on your city: all your cities on screen'),
          keyRow(mouse('Right-click'), 'Move · attack a unit or city · cities selected: rally point (land: for units, water: for ships)'),
          keyRow(el('span', {}, mouse('Right'), ' hold and drag'), 'Shape the formation: it faces the way you drag; a longer drag makes it wider'),
          keyRow(el('span', {}, k('A'), ' + ', mouse('right-click')), 'Attack-move: fight everything on the way'),
          keyRow(el('span', {}, k('Shift'), ' + ', mouse('right-click')), 'Queue the order after the ones already given'),
          keyRow(el('span', {}, k('Alt'), ' + ', mouse('right-click')), 'Cities selected: clear their rally points'),
          keyRow('Wheel · middle drag', 'Zoom · scroll'),
        ]),
        ...section('Units selected', [
          keyRow(k('S'), 'Stop'),
          keyRow(k('H'), 'Hold position'),
          keyRow(k('Delete'), 'Disband'),
          keyRow(k('C'), 'One land unit: make it a Hero (needs Cult of Heroes)'),
          keyRow(k('L'), 'Transports: take the idle units around them on board · land units: find transports and board'),
          keyRow(k('U'), 'Loaded transports: unload, then click where'),
          keyRow(el('span', {}, k('Ctrl', 'B'), ' / ', k('Shift', 'B')), 'Drop the ships / keep only the ships'),
          keyRow(el('span', {}, k('Ctrl', 'F'), ' / ', k('Shift', 'F')), 'Drop the full transports / keep only them'),
          keyRow(k('Space'), 'Centre the view on them'),
        ]),
        ...section('Cities selected', [
          keyRow(el('span', {}, ...UNIT_TYPES.filter((t) => UNITS[t].hotkey).flatMap((t, i) => (i ? [' ', el('kbd', {}, UNITS[t].hotkey)] : [el('kbd', {}, UNITS[t].hotkey)]))), `Train: ${units} (ships only in coastal cities)`),
          keyRow(el('span', {}, ...UPGRADE_TYPES.filter((u) => CITY_UPGRADES[u].hotkey).flatMap((u, i) => (i ? [' ', el('kbd', {}, CITY_UPGRADES[u].hotkey)] : [el('kbd', {}, CITY_UPGRADES[u].hotkey)]))), `Build: ${ups} (A twice: Wall II)`),
          keyRow(k('C'), 'Cancel the last entry of each queue (refunded); again for the one before'),
          keyRow(k('Shift', 'G'), 'Barracks paid with honor (needs Brotherhood of Arms)'),
          keyRow(el('span', {}, k('Shift'), ' + unit key'), 'Train it for honor (needs Eternal Glory)'),
        ]),
        ...section('Anytime', [
          keyRow(el('span', {}, k('Ctrl', '1–9'), ' · ', k('1–9')), 'Save a control group · select it (twice: centre on it)'),
          keyRow(k('F2'), 'Select all your units'),
          keyRow(k('Alt'), 'Hold: every city\'s attack radius · Alt + drag: select only cities'),
          keyRow(k('Shift', 'Space'), 'Your last alerts, newest first'),
          keyRow(el('span', {}, k('←'), ' ', k('→'), ' ', k('↑'), ' ', k('↓')), 'Scroll the map'),
          keyRow(k('T'), 'Technologies'),
          keyRow(k('O'), 'Honor and traditions'),
          keyRow(k('Tab'), 'Players (hold)'),
          keyRow(k('Enter'), 'Chat: write to everyone (Enter sends it, Esc closes the chat)'),
          keyRow(k('F1'), 'This help'),
          keyRow(k('Esc'), 'Close a window · clear the selection · after the game: fold the results away'),
        ]),
      ];
    },
  },

  // ================================================================ the game
  {
    id: 'cities', group: 'The game', title: 'Cities', icon: 'castle',
    build(h) {
      const ups = UPGRADE_TYPES.map((key) => {
        const u = CITY_UPGRADES[key];
        const effect = u.hp ? `+${u.hp} HP` : u.rangePercent ? `+${u.rangePercent}% attack range` : u.damage ? `+${u.damage} damage`
          : u.goldPerTurn ? `+${u.goldPerTurn} gold per turn` : u.trainSpeedPercent ? `units train ${1 + u.trainSpeedPercent / 100}× as fast` : '';
        return [el('span', { class: 'wiki-named' }, h.upgradeIcon(key), u.name), u.hotkey ? el('kbd', {}, u.hotkey) : el('kbd', {}, 'A A'), `${u.cost}`, `${u.buildTime} s`, effect];
      });
      return [
        p('Cities are what the game is about: they pay you gold every turn, train your army, and holding enough of them wins.'),
        h.card({ demo: 'train', title: 'Training units' },
          p('Select your city and press a unit\'s key (or click it in the build column on the right). You pay at once; the unit joins the city\'s ',
            b('queue'), ` (up to ${ECONOMY.maxQueue}) and steps out when it is ready.`),
          p('Cancel: click an entry of the queue in the panel, or press ', k('C'), ' for the last one. You get the gold back.')),
        h.card({ demo: 'multi-train', title: 'Many cities at once' },
          p('Select several cities and every order goes to each of them, as far as your gold reaches. The quickest way to raise a big army.')),
        h.card({ demo: 'rally', title: 'Rally points' },
          p('With cities selected, ', mouse('right-click'), ' land: new units march there (fighting on the way). Right-click the water: where a coastal city\'s new ships go.'),
          p(k('Alt'), ' + ', mouse('right-click'), ' clears both.')),
        h.card({ demo: 'upgrades', title: 'Upgrades' },
          p('Built like units, once per city. They show on the castle, and are destroyed if the city is captured.'),
          table(['', 'Key', 'Gold', 'Time', 'Effect'], ups, 'compact'),
          note('Wall II needs Wall I built or queued: press A twice. ', term('Barracks', 'Units only: ships and upgrades are built at the usual speed.'), ' don\'t speed up ships.')),
        h.card({ title: 'More about cities' },
          ul(
            li(b('Neutral cities'), ' (grey) belong to nobody and shoot at everyone. They are the easiest to take early on.'),
            li(b('Coastal cities'), ' have an anchor and a pier: only they build ships. ', h.link('navy', 'Navy'), '.'),
            li(b('Regions:'), ` hold every city of a region and each pays +${ECONOMY.regionBonusPerCity} gold more per turn. `, h.link('economy', 'Economy'), '.'),
            li(b('Losing a city'), ' gives you back the gold of everything still waiting in its queue.'))),
      ];
    },
  },
  {
    id: 'units', group: 'The game', title: 'Units', icon: 'shield',
    build(h) {
      const trained = UNIT_TYPES.filter((t) => !UNITS[t].promoted);
      const rows = trained.map((t) => {
        const u = UNITS[t];
        const dmg = u.damage ? (u.reload ? `${u.damage} / ${u.reload} s` : `${u.damage}/s`) : '—';
        return [el('span', { class: 'wiki-named' }, h.unitIcon(t), u.name), el('kbd', {}, u.hotkey), `${u.hp}`, dmg,
          u.attackRange ? `${u.attackRange} km` : u.damage ? 'melee' : '—', `${u.moveSpeed}`, `${u.cost}`, `${u.buildTime} s`];
      });
      const about = {
        infantry: 'The backbone: cheap, sturdy, fights in melee. Stands in the front of a formation.',
        archer: `Shoots from ${UNITS.archer.attackRange} km but is frail: keep it behind the infantry.`,
        cavalry: 'Twice as fast as foot soldiers: for raids, chasing and taking empty cities. Rides on the wings.',
        knight: 'Heavy cavalry: costly, but very strong. A few knights break a line.',
        transport: `A ship that carries ${UNITS.transport.capacity} units across the sea. No weapons. Needs Seafaring.`,
        battleship: 'A warship with ballistas: shoots ships, troops ashore and cities. Needs Warships.',
      };
      return [
        h.card({ title: 'What cities train' },
          table(['', 'Key', 'HP', 'Damage', 'Range', 'Speed', 'Gold', 'Time'], rows, 'compact units'),
          note('Speed in km per second; range from the unit to its target\'s edge. Units win back HP once out of a fight for ',
            `${COMBAT.regenDelay} s. Ships repair faster in harbour.`)),
        h.card({ title: 'What each is for' },
          table(null, trained.map((t) => [el('span', { class: 'wiki-named' }, h.unitIcon(t), b(UNITS[t].name)), about[t] || '']), 'rows')),
        h.card({ demo: 'hero', title: 'Heroes' },
          p('With the tradition ', b(TRADITIONS.heroes.name), ', any land unit can become a Hero for ', b(`${HERO.cost} honor`), ' (', k('C'), ' or Make Hero in its panel): ',
            b(`${UNITS.hero.hp} HP`), ', ', b(`${UNITS.hero.damage} damage/s`), ', and the speed and range of what it was.'),
          p('Its ', b('aura'), `: every land unit of yours within ${HERO.auraRadius} km deals ${Math.round(HERO.auraBonus * 100)}% more damage. Several Heroes don't add up.`)),
        h.card({ demo: 'healer', title: 'Healers' },
          p('With the tradition ', b(TRADITIONS.mercy.name), ', a land unit can become a Healer for ', b(`${HEALER.cost} honor`), ': a weak fighter that heals every land unit of yours within ',
            b(`${HEALER.radius} km`), ` by ${HEALER.hpPerSecond} HP a second, even in a fight.`)),
      ];
    },
  },
  {
    id: 'navy', group: 'The game', title: 'Navy', icon: 'anchor',
    build(h) {
      const t = UNITS.transport, bs = UNITS.battleship;
      return [
        p('Land units can\'t swim: to reach an island, or a far coast, they go by ship. Ships need the ', h.link('tech', 'Seafaring'),
          ' technology, and are built in coastal cities (an anchor next to the castle).'),
        h.card({ demo: 'board', title: 'Going on board' },
          p('Select land units: your transports with room glow light blue. ', mouse('Right-click'), ' one: it sails to the beach nearest the units, they gather on the shore and go on board. A transport carries ',
            b(`${t.capacity} units`), '; only those that fit go.'),
          note('Right-click more transports with the same selection to share it out between them.')),
        h.card({ demo: 'autoload', title: 'Autoload' },
          p('Select transports and press ', k('L'), ' (or Autoload in the panel): your idle land units around them go on board, each to the nearest transport with room. ',
            more(`Within ${NAVAL.autoloadRange} km. Units with orders (walking, fighting, holding) stay. Each transport takes units of one landmass and sails to the free beach nearest to them.`)),
          p('With land units selected, ', k('L'), ' (Board transports) works the other way round: they find your transports with room within ',
            `${NAVAL.autoboardRange} km and go on board.`)),
        h.card({ demo: 'unload', title: 'Landing' },
          p('Select loaded transports and ', mouse('right-click'), ' land (or press ', k('U'), ' and click): each sails to the nearest beach, lands everyone, and they march on to the place, fighting on the way. On an enemy city: they storm it.'),
          p(k('Shift'), ': clicks on the water plan the route, the first click on land is where they land, and later Shift-clicks on land are orders for the troops once ashore.')),
        h.card({ demo: 'battleship', title: 'Battleships' },
          p(`${bs.hp} HP; a ${bs.damage} damage bolt every ${bs.reload} s at ships, troops ashore and cities up to ${bs.attackRange} km away. A bolt follows its target and always hits, unless the target dies first.`),
          p('They take coastal cities; an inland city in range they bring down to 1 HP, and troops must finish it. ',
            more(`Cities outrange them (${CITY.attackRange} km against ${bs.attackRange}). A city does not regenerate between a battleship's shots. They reload while they sail: shoot, pull back, come in again. Gunnery gives them cannons: shells that also hurt everything near the target.`))),
        h.card({ demo: 'repair', title: 'Repairs' },
          p(`At sea a ship mends slowly. In harbour, within ${NAVAL.harbourRange} km of the pier of one of your coastal cities, it repairs fast: `,
            b(`${NAVAL.harbourRegen} HP a second`), ` for a transport, twice its own rate for a battleship, once it has been out of the fight for ${COMBAT.regenDelay} s.`),
          note('A battleship doesn\'t repair while it is shooting.')),
        h.card({ title: 'Beaches, cliffs and seas' },
          ul(
            li(b('Beaches'), ' (sand with teal shallows): where ships take units on board and land them. ', b('Cliffs'), ' (a rock face): no docking there.'),
            li('The Mediterranean, the Atlantic, the North Sea and the Baltic are one sea. The Black Sea joins it through the Bosporus; the Caspian is a sea of its own.'),

            li(b('Sunk transports'), ' take everyone on board down with them.'),
            li('Other players see your transports, but not how many units they carry.'))),
      ];
    },
  },
  {
    id: 'economy', group: 'The game', title: 'Economy', icon: 'coin',
    build(h) {
      const g = h.g, E = ECONOMY, farm = CITY_UPGRADES.farm;
      const regions = (g.map?.countries || []).map((co, r) => {
        const ids = g.regionCities?.[r] || [];
        return { name: co.n, size: ids.length, held: ids.filter((i) => g.cityOwner[i] === g.you).length };
      });
      const whole = regions.filter((r) => r.size && r.held === r.size);
      const close = regions.filter((r) => r.held > 0 && r.held < r.size)
        .sort((a, c) => (a.size - a.held) - (c.size - c.held) || c.held - a.held).slice(0, 3);
      const pctMine = g.goldPercent, scaled = pctMine !== undefined && pctMine !== GOLD_PERCENT.default;
      return [
        p('Gold pays for units and upgrades; you pay when you order them. You start with ', b(`${g.options?.startGold ?? E.startGold} gold`), '.'),
        h.card({ title: 'Where gold comes from' },
          table(null, [
            [el('span', { class: 'wiki-named' }, el('span', { class: 'coin' }), b('Cities')), el('span', {}, 'Each city pays ', b(`${E.goldPerCityPerTurn} gold`), ' at the end of every turn (', secs(E.turnSeconds), '), all at once.')],
            [b('Whole regions'), el('span', {}, 'Hold every city of a region and each pays ', b(`+${E.regionBonusPerCity}`), ' more. Lose one and the bonus is gone. A one-city region counts.')],
            [el('span', { class: 'wiki-named' }, h.upgradeIcon('farm'), b('Farms')), el('span', {}, `${farm.cost} gold, ${farm.buildTime} s: `, b(`+${farm.goldPerTurn}`), ' per turn from that city, until it is captured.')],
            [b('Kills'), el('span', {}, 'Destroy an enemy unit: ', b(pct(E.killGoldShare)), ` of its cost at once (${UNITS.infantry.name} ${gold(UNITS.infantry.cost * E.killGoldShare)}, ${UNITS.knight.name} ${gold(UNITS.knight.cost * E.killGoldShare)}). `,
              more('The kill goes to whoever landed the last hit. Your cities\' kills are yours; a neutral city\'s pay nobody. The units on board a transport you sink count too.'))],
            [b('Captures'), 'A city you take pays you from the next turn on.'],
            [b('Refunds'), 'Cancel a queue entry: its gold back. Lose a city: the gold of its queue back.'],
          ], 'rows')),
        h.card({ demo: 'region', title: 'Whole regions' },
          p('The map is split into regions: their names are printed on the map, and dark lines are their borders. Hold ',
            b('every'), ' city of a region and each of them pays ', b(`+${E.regionBonusPerCity} gold`), ' more per turn.'),
          p('Lose one and the whole region loses the bonus. The city panel shows how much of its region its owner holds.'),
          p('With ', h.link('tech', TECHS.roads.name), ' (Tech, Land tab), your land units also march ',
            b(`${TECHS.roads.speedPercent}% faster`), ' in every region you hold whole.')),
        scaled ? h.card({ title: 'Your gold percentage' },
          p('The host set yours to ', b(`${pctMine}%`), ': all the gold you earn is scaled by it, to even out players of different strength. Prices and refunds are not. Others\' percentages are secret.')) : null,
        g.spectator ? null : h.card({ title: 'You, now' },
          p(b(`+${g.myIncome?.() ?? 0} gold`), ` per turn from ${g.myCityCount?.() ?? 0} cities.`),
          p(whole.length ? `Whole regions: ${whole.map((r) => r.name).join(', ')}.` : 'You hold no whole region yet.',
            close.length ? ` Closest to complete: ${close.map((r) => `${r.name} ${r.held}/${r.size}`).join(', ')}.` : '')),
        h.card({ title: 'Spending it' },
          ul(
            li(h.link('units', 'Units'), ' and ', h.link('cities', 'city upgrades'), ': paid when ordered.'),
            li(h.link('tech', 'Technologies'), ': paid when you start (or queue) them.'),
            li('Honor, earned by kills, is a second currency: ', h.link('honor', 'Honor & traditions'), '.'))),
      ];
    },
  },
  {
    id: 'tech', group: 'The game', title: 'Technologies', icon: 'scroll',
    build(h) {
      const g = h.g;
      const cards = [];
      for (const tab of TECH_TABS) {
        if (tab.death && (g.options?.death || 'liberator') !== tab.death) continue;
        cards.push(el('h3', { class: 'wiki-sub' }, `${tab.name} tab`));
        for (const key of Object.keys(TECHS).filter((t) => TECHS[t].tab === tab.id)) {
          const T = TECHS[key];
          const price = [...new Set(T.levels.map((l) => l.cost))].join(' / ');
          const time = [...new Set(T.levels.map((l) => secs(l.time)))].join(' / ');
          cards.push(el('div', { class: 'wiki-tech' }, h.techIcon(key),
            el('div', {}, el('h4', {}, T.name, T.levels.length > 1 ? el('small', {}, ` ${T.levels.length} levels`) : null),
              el('div', { class: 'muted small' }, `${price} gold · ${time}`, T.requires ? ` · needs ${TECHS[T.requires].name}` : ''),
              p(g.hud?.techEffect ? g.hud.techEffect(key, 0) : ''))));
        }
      }
      return [
        p(k('T'), ' or the ', b('Tech'), ' button opens the Technologies window. Research costs gold up front and takes time; one at a time. Order more while one runs and they queue. Cancelling gives the gold back.'),
        ...cards,
        tabNote(g),
      ];
    },
  },
  {
    id: 'honor', group: 'The game', title: 'Honor & traditions', icon: 'star',
    build(h) {
      const g = h.g;
      const rows = TRADITION_TYPES.map((key) => {
        const T = TRADITIONS[key];
        return el('div', { class: `wiki-tech${T.ultimate ? ' ultimate' : ''}`, title: g.hud?.traditionText?.(key) || '' }, h.traditionIcon(key),
          el('div', {}, el('h4', {}, T.name, T.ultimate ? el('small', { class: 'ultimate' }, ' tier II') : null),
            el('div', { class: 'muted small' }, `${T.cost} honor · ${secs(T.time)}`),
            p(g.hud?.traditionSummary?.(key) || '')));
      });
      return [
        p('Honor is the silver star in the top bar. It comes from kills: each enemy unit you destroy gives you ', b('its cost in honor'),
          '. Spend it in the Honor window (', k('O'), ', or click the star).'),
        h.card({ title: 'Traditions' },
          p('Learned once, for good, one at a time (alongside research). More ordered meanwhile wait in a queue; cancelling gives the honor back. Hover one for all it does.'),
          ...rows,
          note(`The tier II tradition can be learned only once every tier I one is learned. Everyone sees which traditions each player has (Players, Tab).`)),
        h.card({ demo: 'hero', title: 'Making a Hero' },
          p('Select one land unit and press ', k('C'), ` (${HERO.cost} honor). `, h.link('units', 'Units'), ' has the rest.')),
        h.card({ demo: 'healer', title: 'Making a Healer' },
          p('Select one land unit and press Make Healer in its panel (', `${HEALER.cost} honor).`)),
      ];
    },
  },
  {
    id: 'winning', group: 'The game', title: 'Winning', icon: 'trophy',
    build(h) {
      const g = h.g, o = g.options || {};
      const now = g.citiesToWin?.();
      return [
        h.card({ title: 'The target' },
          p(describeOptions(o)),
          now !== undefined ? p('Right now: ', b(`${now} cities`), '. The top bar shows it next to your cities (▾ while it counts down).') : null,
          ul(
            li('Reaching it during a turn is not enough: you must still hold it when the turn ends.'),
            li('Several players there at once: the one with the most cities wins. Exactly as many: the game goes on.'),
            li(`Within ${GAME.closeToWinCities} cities of the target, everyone sees it at the top of the screen; a player who holds it is shown with the time left and how many cities they can still lose.`),
            li('The last player standing wins at once, in a game started by 2 or more players.'))),
        h.card({ title: 'Losing everything' },
          p(o.death === 'spectator' ? 'In this game a player who loses every city and every unit is out and can only watch.'
            : ['In this game a player who loses every city and every unit becomes a ', h.link('liberator', 'liberator'), ' and can come back.'])),
        h.card({ title: 'Surrender, leave, the end' },
          ul(
            li(b('Leave'), ' (top right) asks what you want: ', b('Surrender and watch'), ' (your cities turn neutral, you see the end) or ', b('Leave game'), '.'),
            li('When the game ends, the ', b('results'), ' show every player by name with their stats, graphs and a turn-by-turn timeline. ', k('Esc'), ' folds them away to look at the map.'),
            li('A game of two is a duel: its results have ', b('Restart'), ' for a rematch.'))),
      ];
    },
  },
  {
    id: 'liberator', group: 'The game', title: 'Liberator', icon: 'flag',
    build(h) {
      const g = h.g, L = LIBERATOR, T = TECHS;
      const on = (g.options?.death || 'liberator') === 'liberator';
      const costs = (key) => `${T[key].levels.map((l) => l.cost).join(' / ')} gold (as a liberator ${T[key].levels.map((_, i) => techCost(key, i, true)).join(' / ')})`;
      const times = (key) => [...new Set(T[key].levels.map((l) => secs(l.time)))].join(' / ');
      return [
        p('With the game option ', b('Death: Liberator'), ' (the default), a player who loses every city and every unit is not out: they become a liberator and can take cities back. With ',
          b('Death: Spectator'), ' they are out and can only watch. ', b(on ? 'This game uses Liberator.' : 'This game uses Spectator: none of this applies.')),
        h.card({ title: 'How it works' },
          table(null, [
            [b('Falling'), el('span', {}, 'You lose all your gold and become a liberator. Every turn you get ', b(`${L.goldPerTurn} gold`), '.')],
            [b('Liberating'), el('span', {}, 'Click any city and press ', b('Liberate'), ': it becomes yours, like a capture, and you are back in the game. The next one waits ', b(`${L.cooldownTurns} turns`), '.')],
            [b('Protection'), el('span', {}, 'A player with ', b(`${L.protectedCities} cities or fewer`), ' is safe from liberators. Neutral cities can always be taken.')],
            [b('Falling again'), 'All your gold is lost again, and you are a liberator again.'],
          ], 'rows')),
        h.card({ title: 'Rebellion technologies' },
          p('The Tech window\'s Rebellion tab. They work only while you are a liberator, and cost ', b(`${Math.round(L.rebellionCost * 100)}%`), ' when ordered as one.'),
          table(null, [
            [el('span', { class: 'wiki-named' }, h.techIcon('supporters'), b('Supporters')), `+${T.supporters.goldPerTurnPerLevel} gold per turn per level (now up to ${liberatorIncome({ supporters: 3 })}). ${costs('supporters')}, ${times('supporters')} each.`],
            [el('span', { class: 'wiki-named' }, h.techIcon('influencer'), b('Influencer')), `Mark ${influenceLimit({ influencer: 1 })}, ${influenceLimit({ influencer: 2 })} or ${influenceLimit({ influencer: 3 })} cities, one per turn; when the last is marked they are all yours (Liberate now takes them earlier). ${costs('influencer')}, ${times('influencer')} each.`],
            [el('span', { class: 'wiki-named' }, h.techIcon('smuggling'), b('Smuggling')), `Mark 1, 2 or 3 cities: at the end of every turn ${Math.round(T.smuggling.share * 100)}% of each one's income goes from its owner to you. ${costs('smuggling')}, ${times('smuggling')} each.`],
          ], 'rows')),
      ];
    },
  },
];

function tabNote(g) {
  return (g.options?.death || 'liberator') === 'liberator'
    ? note('Rebellion technologies work only for a liberator: see Liberator.')
    : null;
}

