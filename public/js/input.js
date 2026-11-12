// Mouse / keyboard: camera control, selection, orders.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES, DEBUG, LABEL_EDIT } from '/shared/config.js';

const DRAG_THRESHOLD = 5;
const FORMATION_DRAG = 12;       // px the right button must be dragged before it turns the formation
const FORMATION_HOLD_MS = 120;   // the right button held this long shows where the units will go
const BOUNCE_MS = 50;            // let go and pressed again quicker than this: the button bounced, it is still the same press
const BRUSH_PX = { beach: 16, mountain: 26 };   // Edit map: radius of the brushes on screen...
const BRUSH_MIN_KM = 8;          // ...but never less: the grid's shore cells lie up to ~7 km off the drawn coast
const BRUSH_SEND_MS = 250;       // how often a brush stroke is sent while painting
const LABEL_WHEEL_MS = 400;      // Edit map: a region name being resized with the wheel is saved this long after the last turn
const EDGE = 8;
const PAN_SPEED = 900;           // screen px per second
const MAX_ZOOM = 7;
// How far the view may always be panned past each edge of the map, as a share of the screen's width (left,
// right) or height (top, bottom): far enough to bring the land along an edge out from under the HUD, such as
// North Africa from under the minimap and the panels along the bottom of the screen.
const OVERSCROLL = { side: 0.15, top: 0.12, bottom: 0.3 };

// Keys a text field still needs with Ctrl held: select all, copy, cut, paste, undo, redo, move and delete by word.
const TEXT_EDIT_KEYS = new Set(['KeyA', 'KeyC', 'KeyX', 'KeyV', 'KeyZ', 'KeyY', 'ArrowLeft', 'ArrowRight',
  'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete']);

// No browser shortcut works in a game: a key pressed with Ctrl, Alt or Meta, and every function key, does only
// what the game gives it (Find, Find next, Save, Print, History, Downloads, Bookmarks, Back, Reload, Zoom, the
// menu, the address bar... are all cancelled). Kept: F11 (full screen), the developer tools in debug builds
// (F12, Ctrl + Shift + I / J / C), and editing keys and AltGr letters in text fields.
// Chrome never lets a page cancel Ctrl + W / T / N / Tab, nor Ctrl + Shift + T / N / W.
function isBrowserShortcut(e) {
  const fnKey = /^F\d+$/.test(e.key);
  if (!fnKey && !e.ctrlKey && !e.altKey && !e.metaKey) return false;
  if (e.key === 'F11') return false;
  if (DEBUG && (e.key === 'F12' || (e.ctrlKey && e.shiftKey && /^Key[IJC]$/.test(e.code)))) return false;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) {
    if (e.getModifierState?.('AltGraph')) return false;       // AltGr types letters such as @ on many layouts
    if (!e.altKey && TEXT_EDIT_KEYS.has(e.code)) return false;
  }
  return true;
}

export class Input {
  constructor(game) {
    this.g = game;
    this.canvas = game.canvas;
    this.mouse = { x: -1, y: -1, inside: false };
    this.drag = null;
    this.lastRelease = null;     // the left press let go last, and when: { d, t }
    this.pressDragged = false;   // that press became a frame (or moved a city), so it was no click
    this.pan = null;
    this.formDrag = null;        // right button held for a move: where, and which way the formation faces (formationView)
    this.keys = new Set();
    this.attackKey = false;      // A held: right-click becomes attack-move
    this.showRanges = false;     // Alt held: draw every city's attack radius
    this.targetMode = null;      // 'unload': the next left click picks where transports land their units
    this.hoverCity = -1;
    this.hoverShip = -1;         // your transport under the cursor while land units are selected
    this.cityDrag = null;        // Edit map: the city being dragged to a new place
    this.labelDrag = null;       // Edit map: the region name being dragged to a new place
    this.hoverLabel = -1;        // Edit map: the region whose name is under the cursor
    this.labelWheel = null;      // Edit map: a region name being resized with the wheel: { region, timer }
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
    // No browser menu on a right click anywhere in the game (map, panels, top bar, overlays), only in
    // text fields (balance editor, debug console), where copy and paste are useful.
    on(document, 'contextmenu', (e) => {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
    });
    on(this.canvas, 'dblclick', (e) => this.onDblClick(e));
    // Capture phase, so it also covers text fields that keep their keys to themselves (the debug console).
    on(window, 'keydown', (e) => { if (isBrowserShortcut(e)) e.preventDefault(); }, true);
    // Ctrl + wheel (and a touchpad pinch) is the browser's page zoom; over the map the wheel already zooms the map.
    on(window, 'wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    on(window, 'keydown', (e) => this.onKeyDown(e));
    on(window, 'keyup', (e) => this.onKeyUp(e));
    on(window, 'blur', () => {
      this.keys.clear();
      this.formDrag = null;
      this.setAttackKey(false);
      this.showRanges = false;
      this.g.hud.showScores(false);
    });
    on(window, 'resize', () => { this.g.renderer.resize(); this.clampCamera(); });

    const mini = document.getElementById('minimap');
    on(mini, 'mousedown', (e) => this.onMiniDown(e));
    const grip = document.getElementById('minimap-grip');
    on(grip, 'mousedown', (e) => this.onGripDown(e));
    on(grip, 'dblclick', () => this.g.renderer.resetMiniWidth());
  }

  destroy() {
    for (const [t, ev, fn, opts] of this.listeners) t.removeEventListener(ev, fn, opts);
    this.listeners = [];
    if (this.labelWheel) clearTimeout(this.labelWheel.timer);
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
    if (this.mouse.inside && this.mouse.x >= 0 && !this.drag && !this.pan && !this.formDrag && document.hasFocus()) {
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

  // Keeps the view on the map. The view may reach past each map edge by OVERSCROLL, no further; when the map
  // and that margin are smaller than the screen, the map can be anywhere in view. Zooming in towards the cursor
  // from far out can leave a wider margin past a map edge (the point under the cursor must not slide). That
  // margin is kept but can never grow: it is remembered per side in screen px, and panning back towards the
  // map shrinks it, down to OVERSCROLL.
  clampCamera() {
    const cam = this.g.cam, b = this.g.map.bounds, r = this.g.renderer;
    cam.zoom = Math.max(r.minZoom(), Math.min(MAX_ZOOM, cam.zoom));
    const z = cam.zoom, m = this.edgeMargin;
    // lo/hi: camera range in which the view reaches past the edges by at most m0 / m1 px.
    const fit = (c, e0, e1, half, m0, m1) => {
      let lo = e0 + (half - m0) / z, hi = e1 - (half - m1) / z;
      if (lo > hi) [lo, hi] = [hi, lo];   // map and margins smaller than the screen: anywhere it is fully in view
      return Math.max(lo, Math.min(hi, c));
    };
    const hw = r.W / 2, hh = r.H / 2;
    const side = r.W * OVERSCROLL.side, top = r.H * OVERSCROLL.top, bottom = r.H * OVERSCROLL.bottom;
    cam.x = fit(cam.x, b.x0, b.x1, hw, Math.max(m.l, side), Math.max(m.r, side));
    cam.y = fit(cam.y, b.y0, b.y1, hh, Math.max(m.t, top), Math.max(m.b, bottom));
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
    // Edit map: the wheel over a region's name resizes it (about its centre) instead of zooming.
    const label = this.g.mapEdit && !this.g.brush && !this.labelDrag ? r.pickCountryLabel(e.offsetX, e.offsetY) : -1;
    if (label >= 0) {
      this.resizeLabel(label, factor);
      return;
    }
    cam.zoom = Math.max(r.minZoom(), Math.min(MAX_ZOOM, cam.zoom * factor));
    cam.x = wx - (e.offsetX - r.W / 2) / cam.zoom;
    cam.y = wy - (e.offsetY - r.H / 2) / cam.zoom;
    this.clampCamera();
  }

  // Edit map: region `region`'s name `factor` times bigger, within LABEL_EDIT. Shown at once, and pinned where
  // it stands; saved once the wheel has stopped for LABEL_WHEEL_MS.
  resizeLabel(region, factor) {
    const g = this.g, l = g.renderer.countryLabels[region];
    const name = g.map.countries[region].n;
    const old = g.map.labelEdits?.[name]?.scale || 1;
    const scale = Math.max(LABEL_EDIT.minScale, Math.min(LABEL_EDIT.maxScale, old * factor));
    const edit = { x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10, scale: Math.round(scale * 100) / 100 };
    if (this.labelWheel && this.labelWheel.region !== region) this.flushLabelWheel();
    if (this.labelWheel) clearTimeout(this.labelWheel.timer);
    g.editLabel(region, edit, false);
    this.labelWheel = { region, edit, timer: setTimeout(() => this.flushLabelWheel(), LABEL_WHEEL_MS) };
    if (this.mouse.inside) this.updateHover();
  }

  // The resize going on (resizeLabel) goes to the server now.
  flushLabelWheel() {
    const w = this.labelWheel;
    if (!w) return;
    clearTimeout(w.timer);
    this.labelWheel = null;
    this.g.editLabel(w.region, w.edit);
  }

  // ---------------------------------------------------------------- picking
  pickUnit(sx, sy, ownOnly) {
    const g = this.g, z = g.cam.zoom, r = g.renderer;
    let best = null, bd = Infinity;
    for (const u of g.renderUnits) {
      if (ownOnly && u.owner !== g.you) continue;
      const [ux, uy] = r.w2s(u.dx, u.dy);
      const rad = UNITS[UNIT_TYPES[u.t]].size * z;
      // Cone body sits above the base centre, and a boat's sail higher still; accept clicks on the
      // whole silhouette.
      const naval = g.isNaval(u.t);
      const d = Math.hypot(sx - ux, (sy - (uy - rad * (naval ? 0.8 : 0.5))) * 0.8);
      if (d <= Math.max(rad * (naval ? 1.4 : 1.2), naval ? 9 : 6) && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // Your transport under the cursor, with a generous margin: while land units are selected,
  // transports are highlighted and easy to hit with a right click.
  pickTransport(sx, sy) {
    const g = this.g, z = g.cam.zoom, r = g.renderer;
    let best = null, bd = Infinity;
    for (const u of g.renderUnits) {
      if (u.owner !== g.you || !UNITS[UNIT_TYPES[u.t]].capacity) continue;
      const [ux, uy] = r.w2s(u.dx, u.dy);
      const rad = UNITS[UNIT_TYPES[u.t]].size * z;
      const d = Math.hypot(sx - ux, (sy - (uy - rad * 0.8)) * 0.8);
      if (d <= Math.max(rad * 1.9, 18) && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // Unload targeting (U / the Unload button): the next left click on the map or the minimap picks
  // the place; a right click or Esc cancels.
  setTargetMode(mode) {
    this.targetMode = mode;
    if (this.mouse.inside) this.updateHover();
  }

  confirmTarget(wx, wy, city) {
    const g = this.g;
    if (city >= 0) {
      const c = g.map.cities[city];
      g.commandUnload(c.x, c.y, city);
    } else {
      g.commandUnload(wx, wy, -1);
    }
    this.setTargetMode(null);
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
    if (this.targetMode) {
      if (e.button === 0) {
        const [wx, wy] = this.g.renderer.s2w(sx, sy);
        this.confirmTarget(wx, wy, this.pickCity(sx, sy));
      } else if (e.button === 2) {
        this.setTargetMode(null);
      }
      return;
    }
    if (e.button === 2) {
      this.rightClick(sx, sy, e.altKey, e.shiftKey);
      return;
    }
    if (e.button !== 0) return;
    // Edit map, a brush on: paint (or erase) beaches along the coast, or mountains, while the button is held.
    if (this.g.mapEdit && this.g.brush) {
      this.brush = { pts: [], last: null, sentAt: performance.now() };
      this.brushAt(sx, sy);
      return;
    }
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
      // ...or on a region's name, and drag it to a new place.
      const region = this.g.renderer.pickCountryLabel(sx, sy);
      if (region >= 0) {
        const l = this.g.renderer.countryLabels[region];
        const [wx, wy] = this.g.renderer.s2w(sx, sy);
        this.labelDrag = { region, sx, sy, dx: l.x - wx, dy: l.y - wy, x: l.x, y: l.y, active: false, shift: e.shiftKey };
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    // A worn mouse button can lose contact for a few ms while the hand is already moving: let go, then
    // pressed again further on. Without this the frame would start over from there, past where you pressed.
    const prev = this.lastRelease;
    this.lastRelease = null;
    if (prev && e.timeStamp - prev.t < BOUNCE_MS) {
      const d = prev.d;
      d.x1 = sx;
      d.y1 = sy;
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > DRAG_THRESHOLD) d.active = true;
      this.drag = d;
      this.g.debug?.console.log(`Mouse button bounced (pressed again ${Math.round(e.timeStamp - prev.t)} ms after ` +
        'letting go): the frame goes on from the first press', 'dim');
      return;
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
    if (this.brush) {
      this.brushAt(this.mouse.x, this.mouse.y);
      return;
    }
    if (this.formDrag) {
      // Dragged far enough: the formation faces the way from the place pressed to the cursor, and is twice as
      // wide as the drag is long (the arrow reaches half way across it). Back near the place: the way the
      // units go, at the width that suits their number, as for a plain click.
      const d = this.formDrag;
      if (Math.hypot(this.mouse.x - d.sx, this.mouse.y - d.sy) > FORMATION_DRAG) {
        const [wx, wy] = this.g.renderer.s2w(this.mouse.x, this.mouse.y);
        d.facing = Math.atan2(wy - d.wy, wx - d.wx);
        d.width = 2 * Math.hypot(wx - d.wx, wy - d.wy);
      } else {
        d.facing = null;
        d.width = null;
      }
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
    if (this.labelDrag) {
      // The name follows the cursor at once (the map layer it is printed on is redrawn).
      const d = this.labelDrag, r = this.g.renderer;
      const [wx, wy] = r.s2w(this.mouse.x, this.mouse.y);
      d.x = wx + d.dx;
      d.y = wy + d.dy;
      if (Math.hypot(this.mouse.x - d.sx, this.mouse.y - d.sy) > DRAG_THRESHOLD) d.active = true;
      const l = r.countryLabels[d.region];
      if (d.active && l) { l.x = d.x; l.y = d.y; r.mapKey = ''; }
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
    const ship = g.selection.size && g.selectedLandUnits().length ? this.pickTransport(x, y) : null;
    this.hoverShip = ship ? ship.id : -1;
    let cursor = 'default';
    if (this.targetMode) cursor = 'crosshair';
    else if (ship) cursor = 'pointer';                  // right click: go on board
    else if (this.attackKey && g.selection.size) cursor = 'crosshair';
    else if (g.selection.size) {
      const u = this.pickUnit(x, y, false);
      const enemyUnit = u && u.owner !== g.you;
      const enemyCity = !u && this.hoverCity >= 0 && g.cityOwner[this.hoverCity] !== g.you;
      if (enemyUnit || enemyCity) cursor = 'crosshair';
    } else if (this.hoverCity >= 0 || this.pickUnit(x, y, false)) {
      cursor = 'pointer';
    }
    // Edit map: cities can be dragged, and region names (dragged, resized with the wheel).
    this.hoverLabel = g.mapEdit && !g.brush && this.hoverCity < 0 ? g.renderer.pickCountryLabel(x, y) : -1;
    if (g.mapEdit && this.hoverCity >= 0) cursor = 'grab';
    else if (this.hoverLabel >= 0) cursor = 'move';
    if (g.mapEdit && g.brush) cursor = 'crosshair';            // ...unless a brush is on
    this.canvas.style.cursor = cursor;
  }

  // ---------------------------------------------------------------- brushes (Edit map)
  // Its radius in map km: about the same size on screen at any zoom (the mountain brush is bigger).
  brushRadius() {
    const px = this.g.brush?.startsWith('mountain') ? BRUSH_PX.mountain : BRUSH_PX.beach;
    return Math.max(BRUSH_MIN_KM, Math.min(80, px / this.g.cam.zoom));
  }

  // A point of the stroke under (sx, sy): kept when it is half a radius from the last one, and the
  // points so far go to the server a few times a second.
  brushAt(sx, sy) {
    const b = this.brush, r = this.brushRadius();
    const [x, y] = this.g.renderer.s2w(sx, sy);
    if (!b.last || Math.hypot(x - b.last[0], y - b.last[1]) >= r / 2) {
      b.pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      b.last = [x, y];
    }
    if (performance.now() - b.sentAt > BRUSH_SEND_MS) this.brushSend();
  }

  brushSend() {
    const b = this.brush;
    if (!b) return;
    if (b.pts.length) this.g.paintStroke(b.pts, this.brushRadius());
    b.pts = [];
    b.sentAt = performance.now();
  }

  onMouseUp(e) {
    if (e.button === 1) { this.pan = null; return; }
    if (e.button === 2) { this.endFormation(); return; }
    if (e.button === 0 && this.brush) {
      this.brushSend();
      this.brush = null;
      return;
    }
    if (e.button === 0 && this.cityDrag) {
      const d = this.cityDrag;
      this.cityDrag = null;
      this.pressDragged = d.active;
      // A drag moves the city (Edit map); a press without moving is an ordinary click.
      if (d.active && this.g.mapEdit) this.g.moveCity(d.city, d.x, d.y);
      else this.click(d.sx, d.sy, d.shift);
      if (this.mouse.inside) this.updateHover();
      return;
    }
    if (e.button === 0 && this.labelDrag) {
      const d = this.labelDrag, g = this.g;
      this.labelDrag = null;
      this.pressDragged = d.active;
      // A drag moves the name (Edit map), pinned there at its size; a press without moving is an ordinary click.
      if (d.active && g.mapEdit) {
        const scale = g.map.labelEdits?.[g.map.countries[d.region].n]?.scale || 1;
        g.editLabel(d.region, { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10, scale });
      } else {
        this.click(d.sx, d.sy, d.shift);
      }
      if (this.mouse.inside) this.updateHover();
      return;
    }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.lastRelease = { d, t: e.timeStamp };
    this.pressDragged = d.active;
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
    // The browser counts a click then a quick press-and-drag as a double click; the frame already picked.
    if (this.pressDragged) return;
    const g = this.g;
    const r = g.renderer;
    // Edit map: a double click on a region's name gives it back to automatic placing.
    if (g.mapEdit && !g.brush && this.pickCity(e.offsetX, e.offsetY) < 0) {
      const region = r.pickCountryLabel(e.offsetX, e.offsetY);
      if (region >= 0) {
        if (this.labelWheel?.region === region) { clearTimeout(this.labelWheel.timer); this.labelWheel = null; }
        g.editLabel(region, null);
        if (this.mouse.inside) this.updateHover();       // the name may no longer be under the cursor
        return;
      }
    }
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

  // Right-click with units: on your transport, the land units go on board; on an enemy, attack it;
  // otherwise move there. Holding A turns the move into an attack-move (fight anything met on the way),
  // also on an enemy city: the units attack-move to it instead of walking past the defenders to hit it.
  // Holding Shift queues the move or attack after the orders the units already have. A move is given when
  // the button is let go: held, grey ghosts show where each unit goes; dragged, the formation faces that way.
  rightClick(sx, sy, alt, shift = false) {
    const g = this.g;
    const [wx, wy] = g.renderer.s2w(sx, sy);
    if (g.selection.size) {
      if (g.selectedLandUnits().length) {
        const ship = this.pickTransport(sx, sy);
        if (ship) { g.commandBoard(ship); return; }
      }
      const u = this.pickUnit(sx, sy, false);
      if (u && u.owner !== g.you) { g.commandAttack('u', u.id, u.x, u.y, shift); return; }
      const city = this.pickCity(sx, sy);
      if (city >= 0 && g.cityOwner[city] !== g.you) {
        const c = g.map.cities[city];
        if (this.attackKey) g.commandMove(c.x, c.y, true, shift);
        else g.commandAttack('c', city, c.x, c.y, shift);
        return;
      }
      // A move: given when the button is let go (endFormation). Held, it shows where each unit will
      // go; dragged, it turns their formation to face the way it is dragged.
      this.formDrag = { sx, sy, wx, wy, t0: performance.now(), facing: null, width: null, amove: this.attackKey, shift };
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

  // The way it was dragged: the formation's facing and width (formationSlots), or null (not dragged).
  formationShape(d) {
    return d.facing === null ? null : { facing: d.facing, width: d.width };
  }

  // The right button let go after a press for a move (rightClick): the units go there, in a formation
  // facing the way it was dragged and as wide as the drag made it (or facing the way they go).
  endFormation() {
    const d = this.formDrag;
    if (!d) return;
    this.formDrag = null;
    this.g.commandMove(d.wx, d.wy, d.amove, d.shift, this.formationShape(d));
  }

  // What the renderer shows while the right button is held for a move (drawFormation), or null: where each
  // selected unit will go ({ u, x, y }), the place pressed, the facing (null: the way they go), the cursor.
  formationView() {
    const d = this.formDrag;
    if (!d || (d.facing === null && performance.now() - d.t0 < FORMATION_HOLD_MS)) return null;
    return {
      places: this.g.formationPreview(d.wx, d.wy, this.formationShape(d), d.shift),
      x: d.wx, y: d.wy, facing: d.facing, amove: d.amove, cursor: { x: this.mouse.x, y: this.mouse.y },
    };
  }

  onMiniDown(e) {
    e.preventDefault();
    const r = this.g.renderer;
    const [wx, wy] = r.miniToWorld(e.offsetX, e.offsetY);
    if (this.targetMode) {                // Unload: a place picked on the minimap
      if (e.button === 0) this.confirmTarget(wx, wy, -1);
      else if (e.button === 2) this.setTargetMode(null);
      return;
    }
    if (e.button === 2) {
      if (this.g.selection.size) this.g.commandMove(wx, wy, this.attackKey, e.shiftKey);
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

  // Drag the minimap's top-right corner to resize it. It grows from its bottom-left corner and keeps
  // the map's shape: the corner follows the cursor along its diagonal. The browser keeps the width
  // for the next games (render.js keepMiniWidth).
  onGripDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.g.renderer, grip = e.currentTarget;
    const w0 = r.miniW, ratio = r.miniH / r.miniW, x0 = e.clientX, y0 = e.clientY;
    let moved = false;                   // a click alone (or the double click) keeps no width
    grip.classList.add('dragging');
    document.body.classList.add('resizing-minimap');      // the resize cursor wherever the mouse goes
    const move = (ev) => {
      // The cursor's move projected on the corner's path: right and up grow it, left and down shrink it.
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      moved = true;
      r.setMiniWidth(w0 + (dx - dy * ratio) / (1 + ratio * ratio));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing-minimap');
      if (moved) r.keepMiniWidth();
    };
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
    // Enter: write in the chat. Also with a button focused (the last one clicked), which Enter would press again.
    // Not when something on the page took the key already (a row of the results that opens on Enter).
    if (k === 'Enter') {
      if (!e.repeat && !e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        g.chat.open();
      }
      return;
    }
    if (k === 'Tab') { e.preventDefault(); g.hud.showScores(true); return; }
    if (k === 'F1' || k === '?') { e.preventDefault(); g.hud.toggleHelp(); return; }
    if (k === 'F2') { e.preventDefault(); g.select(g.renderUnits.filter((u) => u.owner === g.you).map((u) => u.id), false); return; }
    if (k === 'Escape') {
      if (this.formDrag) this.formDrag = null;           // the move being held is not given
      else if (this.targetMode) this.setTargetMode(null);
      else if (g.brush) g.setBrush(null);
      else if (!g.hud.closeOverlays()) g.clearSelection();
      return;
    }
    // Units selected: Ctrl + B removes the ships from the selection, Shift + B keeps only the ships.
    // (Without units selected, Shift + B builds a transport like B.)
    if (e.code === 'KeyB' && e.ctrlKey !== e.shiftKey && !e.altKey && !e.metaKey && g.selection.size) {
      g.filterSelection(e.shiftKey);
      return;
    }
    // Units selected: Ctrl + F removes the full transports from the selection, Shift + F keeps only them.
    if (e.code === 'KeyF' && e.ctrlKey !== e.shiftKey && !e.altKey && !e.metaKey && g.selection.size) {
      g.filterFull(e.shiftKey);
      return;
    }
    if (e.ctrlKey && /^[1-9]$/.test(k)) {
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
    // Eternal Glory: Shift + the key (or the Honor side of the switch in the Units box) pays with honor.
    if (unit) { g.build(unit, (e.shiftKey || g.hud.payHonor) && g.hasTradition('eternalGlory')); return; }
    // With cities selected, A/S/D/F order upgrades; with units selected, A and S keep their unit meaning.
    if (g.selectedCities.size) {
      const upgrade = UPGRADE_TYPES.find((key) => CITY_UPGRADES[key].hotkey && e.code === `Key${CITY_UPGRADES[key].hotkey}`);
      // Shift + G: Barracks paid with honor, once Brotherhood of Arms is learned (otherwise as G).
      const withHonor = upgrade === 'barracks' && e.shiftKey && g.hasTradition('brotherhood');
      if (upgrade) { g.build(upgrade, withHonor); return; }
    }
    switch (e.code) {
      case 'KeyA': this.setAttackKey(true); break;
      case 'KeyS': g.commandStop(); break;
      case 'Delete': g.commandDisband(); break;
      case 'KeyH': g.commandHold(); break;
      case 'KeyU': if (g.selectedTransports().length) g.startUnload(); break;
      case 'KeyL': if (g.selectedTransports().length || g.selectedLandUnits().length) g.commandAutoload(); break;
      case 'KeyT': g.hud.toggleTech(); break;
      case 'KeyO': g.hud.toggleHonor(); break;
      case 'KeyC':
        if (g.selectedCities.size) g.cancelLast();          // cities: cancel the last entry of each queue
        else if (g.selection.size) g.promote('hero');       // units: Make Hero, as the button in the unit panel
        break;
      case 'Space':                      // Shift: your latest alert (a battle, a city captured)
        e.preventDefault();
        if (e.shiftKey) g.showAlert();
        else g.centerOnSelection();
        break;
      default:
    }
  }

  onKeyUp(e) {
    if (e.key === 'F10') e.preventDefault();     // F10, like Alt, focuses the browser menu when let go
    if (e.key === 'Alt') {
      e.preventDefault();                // releasing Alt alone would otherwise open the browser menu
      this.showRanges = false;
    }
    this.keys.delete(e.key);
    if (e.code === 'KeyA') this.setAttackKey(false);
    if (e.key === 'Tab') this.g.hud.showScores(false);
  }
}
