// Mouse / keyboard: camera control, selection, orders.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES } from '/shared/config.js';

const DRAG_THRESHOLD = 5;
const EDGE = 8;
const PAN_SPEED = 900;           // screen px per second
const MAX_ZOOM = 7;

export class Input {
  constructor(game) {
    this.g = game;
    this.canvas = game.canvas;
    this.mouse = { x: -1, y: -1, inside: false };
    this.drag = null;
    this.pan = null;
    this.keys = new Set();
    this.attackKey = false;      // A held: right-click becomes attack-move
    this.showRanges = false;     // Alt held: draw every city's attack radius
    this.hoverCity = -1;
    this.cityDrag = null;        // Edit map: the city being dragged to a new place
    this.edgeMargin = { l: 0, r: 0, t: 0, b: 0 };   // how far (px) the view may reach past each map edge
    this.lastGroup = { n: -1, t: 0 };
    this.listeners = [];

    const on = (target, ev, fn, opts) => {
      target.addEventListener(ev, fn, opts);
      this.listeners.push([target, ev, fn, opts]);
    };
    on(this.canvas, 'mousedown', (e) => this.onMouseDown(e));
    on(window, 'mousemove', (e) => this.onMouseMove(e));
    on(window, 'mouseup', (e) => this.onMouseUp(e));
    on(this.canvas, 'mouseleave', () => { this.mouse.inside = false; });
    on(this.canvas, 'mouseenter', (e) => {
      this.mouse.x = e.offsetX;
      this.mouse.y = e.offsetY;
      this.mouse.inside = true;
    });
    on(this.canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.canvas, 'dblclick', (e) => this.onDblClick(e));
    on(window, 'keydown', (e) => this.onKeyDown(e));
    on(window, 'keyup', (e) => this.onKeyUp(e));
    on(window, 'blur', () => {
      this.keys.clear();
      this.setAttackKey(false);
      this.showRanges = false;
      this.g.hud.showScores(false);
    });
    on(window, 'resize', () => { this.g.renderer.resize(); this.clampCamera(); });

    const mini = document.getElementById('minimap');
    on(mini, 'mousedown', (e) => this.onMiniDown(e));
    on(mini, 'contextmenu', (e) => e.preventDefault());
  }

  destroy() {
    for (const [t, ev, fn, opts] of this.listeners) t.removeEventListener(ev, fn, opts);
    this.listeners = [];
  }

  // ---------------------------------------------------------------- camera
  update(dt) {
    const cam = this.g.cam;
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;
    const r = this.g.renderer;
    if (this.mouse.inside && this.mouse.x >= 0 && !this.drag && !this.pan && document.hasFocus()) {
      if (this.mouse.x < EDGE) dx -= 1;
      if (this.mouse.x > r.W - EDGE) dx += 1;
      if (this.mouse.y < EDGE) dy -= 1;
      if (this.mouse.y > r.H - EDGE) dy += 1;
    }
    if (dx || dy) {
      cam.x += (dx * PAN_SPEED * dt) / cam.zoom;
      cam.y += (dy * PAN_SPEED * dt) / cam.zoom;
      this.clampCamera();
    }
  }

  // Keeps the view on the map. Normally the view stays inside the map bounds; when the map is smaller than the
  // screen, all of it stays in view. Zooming in towards the cursor from far out can leave a margin past a map
  // edge (the point under the cursor must not slide). That margin is kept but can never grow: it is remembered
  // per side in screen px, and panning back towards the map shrinks it.
  clampCamera() {
    const cam = this.g.cam, b = this.g.map.bounds, r = this.g.renderer;
    cam.zoom = Math.max(r.minZoom(), Math.min(MAX_ZOOM, cam.zoom));
    const z = cam.zoom, m = this.edgeMargin;
    // lo/hi: camera range in which the view reaches past the edges by at most m0 / m1 px.
    const fit = (c, e0, e1, half, m0, m1) => {
      let lo = e0 + (half - m0) / z, hi = e1 - (half - m1) / z;
      if (lo > hi) [lo, hi] = [hi, lo];   // map smaller than the screen: anywhere it is fully in view
      return Math.max(lo, Math.min(hi, c));
    };
    const hw = r.W / 2, hh = r.H / 2;
    cam.x = fit(cam.x, b.x0, b.x1, hw, m.l, m.r);
    cam.y = fit(cam.y, b.y0, b.y1, hh, m.t, m.b);
    m.l = Math.max(0, hw - (cam.x - b.x0) * z);
    m.r = Math.max(0, hw - (b.x1 - cam.x) * z);
    m.t = Math.max(0, hh - (cam.y - b.y0) * z);
    m.b = Math.max(0, hh - (b.y1 - cam.y) * z);
    this.g.viewChanged();
  }

  centerOn(x, y) {
    this.g.cam.x = x;
    this.g.cam.y = y;
    this.clampCamera();
  }

  onWheel(e) {
    e.preventDefault();
    const cam = this.g.cam, r = this.g.renderer;
    const [wx, wy] = r.s2w(e.offsetX, e.offsetY);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    cam.zoom = Math.max(r.minZoom(), Math.min(MAX_ZOOM, cam.zoom * factor));
    cam.x = wx - (e.offsetX - r.W / 2) / cam.zoom;
    cam.y = wy - (e.offsetY - r.H / 2) / cam.zoom;
    this.clampCamera();
  }

  // ---------------------------------------------------------------- picking
  pickUnit(sx, sy, ownOnly) {
    const g = this.g, z = g.cam.zoom, r = g.renderer;
    let best = null, bd = Infinity;
    for (const u of g.renderUnits) {
      if (ownOnly && u.owner !== g.you) continue;
      const [ux, uy] = r.w2s(u.dx, u.dy);
      const rad = UNITS[UNIT_TYPES[u.t]].size * z;
      // Cone body sits above the base centre; accept clicks on the whole silhouette.
      const d = Math.hypot(sx - ux, (sy - (uy - rad * 0.5)) * 0.8);
      if (d <= Math.max(rad * 1.2, 6) && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  pickCity(sx, sy) {
    const g = this.g, r = g.renderer;
    const { lift, radius } = r.cityHitArea();     // castle close up, small marker when zoomed out
    let best = -1, bd = Infinity;
    g.map.cities.forEach((c, i) => {
      const [cx, cy] = r.w2s(c.x, c.y);
      const d = Math.hypot(sx - cx, sy - (cy - lift));
      if (d <= radius && d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // ---------------------------------------------------------------- mouse
  onMouseDown(e) {
    this.canvas.focus?.();
    const sx = e.offsetX, sy = e.offsetY;
    if (e.button === 1) {
      e.preventDefault();
      this.pan = { x: e.clientX, y: e.clientY, cx: this.g.cam.x, cy: this.g.cam.y };
      return;
    }
    if (e.button === 2) {
      this.rightClick(sx, sy, e.altKey);
      return;
    }
    if (e.button !== 0) return;
    // Edit map mode (admins): press on any city and drag it to a new place.
    if (this.g.mapEdit) {
      const city = this.pickCity(sx, sy);
      if (city >= 0) {
        const c = this.g.map.cities[city];
        const [wx, wy] = this.g.renderer.s2w(sx, sy);
        // Keep the grab offset so the city does not jump to the cursor.
        this.cityDrag = { city, sx, sy, dx: c.x - wx, dy: c.y - wy, x: c.x, y: c.y, active: false, shift: e.shiftKey };
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    this.drag = { x0: sx, y0: sy, x1: sx, y1: sy, active: false, shift: e.shiftKey };
  }

  onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left;
    this.mouse.y = e.clientY - rect.top;
    this.mouse.inside = e.target === this.canvas;
    this.showRanges = e.altKey;          // stays right even if an Alt key event was missed
    if (this.pan) {
      const z = this.g.cam.zoom;
      this.g.cam.x = this.pan.cx - (e.clientX - this.pan.x) / z;
      this.g.cam.y = this.pan.cy - (e.clientY - this.pan.y) / z;
      this.clampCamera();
      return;
    }
    if (this.cityDrag) {
      const d = this.cityDrag;
      const [wx, wy] = this.g.renderer.s2w(this.mouse.x, this.mouse.y);
      d.x = wx + d.dx;
      d.y = wy + d.dy;
      if (Math.hypot(this.mouse.x - d.sx, this.mouse.y - d.sy) > DRAG_THRESHOLD) d.active = true;
      return;
    }
    if (this.drag) {
      this.drag.x1 = this.mouse.x;
      this.drag.y1 = this.mouse.y;
      if (Math.hypot(this.drag.x1 - this.drag.x0, this.drag.y1 - this.drag.y0) > DRAG_THRESHOLD) this.drag.active = true;
    }
    if (this.mouse.inside) this.updateHover();
  }

  updateHover() {
    const { x, y } = this.mouse;
    const g = this.g;
    this.hoverCity = this.pickCity(x, y);
    let cursor = 'default';
    if (this.attackKey && g.selection.size) cursor = 'crosshair';
    else if (g.selection.size) {
      const u = this.pickUnit(x, y, false);
      const enemyUnit = u && u.owner !== g.you;
      const enemyCity = !u && this.hoverCity >= 0 && g.cityOwner[this.hoverCity] !== g.you;
      if (enemyUnit || enemyCity) cursor = 'crosshair';
    } else if (this.hoverCity >= 0 || this.pickUnit(x, y, false)) {
      cursor = 'pointer';
    }
    if (g.mapEdit && this.hoverCity >= 0) cursor = 'grab';    // Edit map: cities can be dragged
    this.canvas.style.cursor = cursor;
  }

  onMouseUp(e) {
    if (e.button === 1) { this.pan = null; return; }
    if (e.button === 0 && this.cityDrag) {
      const d = this.cityDrag;
      this.cityDrag = null;
      // A drag moves the city (Edit map); a press without moving is an ordinary click.
      if (d.active && this.g.mapEdit) this.g.moveCity(d.city, d.x, d.y);
      else this.click(d.sx, d.sy, d.shift);
      if (this.mouse.inside) this.updateHover();
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    const g = this.g;
    if (d.active) {
      const r = g.renderer;
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      const inside = (sx, sy) => sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
      // Alt held on release: the frame picks only cities, even with your units inside it.
      if (!e.altKey) {
        const ids = [];
        for (const u of g.renderUnits) {
          if (u.owner !== g.you) continue;
          const [sx, sy] = r.w2s(u.dx, u.dy);
          if (inside(sx, sy)) ids.push(u.id);
        }
        if (ids.length) {
          g.select(ids, d.shift);
          return;
        }
      }
      // No units in the frame (or Alt held): select your cities in it (Shift adds to the city selection).
      const { lift } = r.cityHitArea();
      const cities = [];
      g.map.cities.forEach((c, i) => {
        if (g.cityOwner[i] !== g.you) return;
        const [sx, sy] = r.w2s(c.x, c.y);
        if (inside(sx, sy - lift)) cities.push(i);
      });
      if (cities.length) g.selectCities(cities, d.shift && !g.selection.size);
      else if (!d.shift) g.clearSelection();
      return;
    }
    this.click(d.x0, d.y0, d.shift);
  }

  click(sx, sy, shift) {
    const g = this.g;
    const own = this.pickUnit(sx, sy, true);
    if (own) {
      if (shift && g.selection.has(own.id)) g.deselect(own.id);
      else g.select([own.id], shift);
      return;
    }
    const city = this.pickCity(sx, sy);
    if (city >= 0) {
      if (g.cityOwner[city] === g.you) g.selectCity(city, shift && !g.selection.size);
      else if (!shift) g.inspectThing({ k: 'c', id: city });
      return;
    }
    const other = this.pickUnit(sx, sy, false);
    if (other) {
      g.inspectThing({ k: 'u', id: other.id });
      return;
    }
    if (!shift) g.clearSelection();
  }

  // Double-click one of your units: every unit of that type on screen. One of your cities:
  // every one of your cities on screen. Shift adds them to the selection.
  onDblClick(e) {
    const g = this.g;
    const r = g.renderer;
    const u = this.pickUnit(e.offsetX, e.offsetY, true);
    if (!u) {
      const city = this.pickCity(e.offsetX, e.offsetY);
      if (city < 0 || g.cityOwner[city] !== g.you) return;
      const ids = [];
      g.map.cities.forEach((c, i) => {
        if (g.cityOwner[i] !== g.you) return;
        const [sx, sy] = r.w2s(c.x, c.y);
        if (r.onScreen(sx, sy, 0)) ids.push(i);
      });
      g.selectCities(ids, e.shiftKey && !g.selection.size);
      return;
    }
    const ids = g.renderUnits
      .filter((o) => o.owner === g.you && o.t === u.t)
      .filter((o) => { const [sx, sy] = r.w2s(o.dx, o.dy); return r.onScreen(sx, sy, 0); })
      .map((o) => o.id);
    g.select(ids, e.shiftKey);
  }

  // Right-click with units: attack the enemy under the cursor, otherwise move there.
  // Holding A turns the move into an attack-move (fight anything met on the way).
  rightClick(sx, sy, alt) {
    const g = this.g;
    const [wx, wy] = g.renderer.s2w(sx, sy);
    if (g.selection.size) {
      const u = this.pickUnit(sx, sy, false);
      if (u && u.owner !== g.you) { g.commandAttack('u', u.id, u.x, u.y); return; }
      const city = this.pickCity(sx, sy);
      if (city >= 0 && g.cityOwner[city] !== g.you) {
        const c = g.map.cities[city];
        g.commandAttack('c', city, c.x, c.y);
        return;
      }
      g.commandMove(wx, wy, this.attackKey);
      return;
    }
    // Cities selected: right-click sets their rally point; Alt + right-click anywhere, or a
    // right-click on one of them, clears it.
    const cities = [...g.selectedCities].filter((ci) => g.cityOwner[ci] === g.you);
    if (!cities.length) return;
    const onCity = cities.some((ci) => {
      const c = g.map.cities[ci];
      return Math.hypot(wx - c.x, wy - c.y) < CITY.size * 1.5;
    });
    if (alt || onCity) g.setRally(cities, null, null);
    else g.setRally(cities, wx, wy);
  }

  onMiniDown(e) {
    e.preventDefault();
    const r = this.g.renderer;
    const [wx, wy] = r.miniToWorld(e.offsetX, e.offsetY);
    if (e.button === 2) {
      if (this.g.selection.size) this.g.commandMove(wx, wy, this.attackKey);
      return;
    }
    if (e.button !== 0) return;
    this.centerOn(wx, wy);
    const mini = e.currentTarget;
    const move = (ev) => {
      const rect = mini.getBoundingClientRect();
      const [x, y] = r.miniToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      this.centerOn(x, y);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  setAttackKey(on) {
    if (this.attackKey === on) return;
    this.attackKey = on;
    if (this.mouse.inside) this.updateHover();
  }

  // ---------------------------------------------------------------- keyboard
  onKeyDown(e) {
    if (e.target instanceof HTMLInputElement) return;
    const g = this.g;
    const k = e.key;
    if (k === 'Alt') {
      e.preventDefault();                // don't let the browser focus its menu
      this.showRanges = true;
      return;
    }
    if (k.startsWith('Arrow')) { this.keys.add(k); e.preventDefault(); return; }
    if (k === 'Tab') { e.preventDefault(); g.hud.showScores(true); return; }
    if (k === 'F1' || k === '?') { e.preventDefault(); g.hud.toggleHelp(); return; }
    if (k === 'F2') { e.preventDefault(); g.select(g.renderUnits.filter((u) => u.owner === g.you).map((u) => u.id), false); return; }
    if (k === 'Escape') {
      if (!g.hud.closeOverlays()) g.clearSelection();
      return;
    }
    if (e.ctrlKey && /^[1-9]$/.test(k)) {
      e.preventDefault();
      g.groups.set(k, [...g.selection]);
      g.hud.feed(`Group ${k} saved (${g.selection.size} units)`);
      return;
    }
    if (/^[1-9]$/.test(k) && !e.altKey && !e.metaKey) {
      const ids = (g.groups.get(k) || []).filter((id) => g.unitById.has(id));
      if (!ids.length) return;
      g.select(ids, e.shiftKey);
      const now = performance.now();
      if (this.lastGroup.n === k && now - this.lastGroup.t < 350) g.centerOnSelection();
      this.lastGroup = { n: k, t: now };
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Physical keys (e.code), so hotkeys work the same with any keyboard layout.
    // Build keys come from each unit's `hotkey` in shared/config.js.
    const unit = UNIT_TYPES.find((type) => UNITS[type].hotkey && e.code === `Key${UNITS[type].hotkey}`);
    if (unit) { g.build(unit); return; }
    // With cities selected, A/S/D/F order upgrades; with units selected, A and S keep their unit meaning.
    if (g.selectedCities.size) {
      const upgrade = UPGRADE_TYPES.find((key) => CITY_UPGRADES[key].hotkey && e.code === `Key${CITY_UPGRADES[key].hotkey}`);
      if (upgrade) { g.build(upgrade); return; }
    }
    switch (e.code) {
      case 'KeyA': this.setAttackKey(true); break;
      case 'KeyS': g.commandStop(); break;
      case 'Delete': g.commandDisband(); break;
      case 'KeyH': g.commandHold(); break;
      case 'KeyT': g.hud.toggleTech(); break;
      case 'Space': e.preventDefault(); g.centerOnSelection(); break;
      default:
    }
  }

  onKeyUp(e) {
    if (e.key === 'Alt') {
      e.preventDefault();                // releasing Alt alone would otherwise open the browser menu
      this.showRanges = false;
    }
    this.keys.delete(e.key);
    if (e.code === 'KeyA') this.setAttackKey(false);
    if (e.key === 'Tab') this.g.hud.showScores(false);
  }
}
