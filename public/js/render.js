// Canvas renderer: cached map layer (sea, land, territories, borders, labels),
// then cities, units and effects on top every frame. Also draws the minimap.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, PRODUCTION_ITEMS } from '/shared/config.js';
import { unitSprite, castleSprite, CONE, CASTLE_ANCHOR, mix } from './sprites.js';

const SEA = '#1f3d58';
const LAND = '#dccfa8';
const LAND_DIM = '#a9a088';
const TERRITORY_ALPHA = 0.5;
const INK = '#1c130b';

// Below this zoom the map is the strategic view: small coloured city markers,
// no castles, upgrades, city names or country names.
const FAR_ZOOM = 0.42;
// Country names are printed on the map like terrain: their size is in world units,
// so they scale with the map and stay in the same place. Bigger countries get bigger letters.
const COUNTRY_LABEL = { perSqrtArea: 0.07, min: 20, max: 60, alpha: 0.3 };

function addRing(path, r) {
  path.moveTo(r[0], r[1]);
  for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]);
  path.closePath();
}

function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return Math.abs(a / 2);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The lines of the map: coastlines, region borders and the borders between cities of one region.
// tools/build-map.js gives neighbouring landmasses exactly the same border points, so a ring edge
// that another ring also has is a land border, not coast. Land borders are drawn from map.segs
// only, where they divide two cities ([x0, y0, x1, y1, kind], kind 1 = region border).
export function mapLines(map) {
  const edgeKey = (r, i, j) => (r[i] < r[j] || (r[i] === r[j] && r[i + 1] < r[j + 1])
    ? `${r[i]},${r[i + 1]},${r[j]},${r[j + 1]}` : `${r[j]},${r[j + 1]},${r[i]},${r[i + 1]}`);
  const uses = new Map();
  for (const p of map.polys) {
    for (const r of p.r) {
      for (let i = 0; i < r.length; i += 2) {
        const k = edgeKey(r, i, (i + 2) % r.length);
        uses.set(k, (uses.get(k) || 0) + 1);
      }
    }
  }
  const coast = new Path2D();
  for (const p of map.polys) {
    for (const r of p.r) {
      const n = r.length / 2;
      const land = (e) => uses.get(edgeKey(r, 2 * e, 2 * ((e + 1) % n))) > 1;
      // Walk the ring from just after a land border, so no stretch of coast is cut in two.
      let start = -1;
      for (let e = 0; e < n && start < 0; e++) if (land(e)) start = (e + 1) % n;
      if (start < 0) { addRing(coast, r); continue; }
      let open = false;
      for (let m = 0; m < n; m++) {
        const e = (start + m) % n, j = 2 * ((e + 1) % n);
        if (land(e)) { open = false; continue; }
        if (!open) { coast.moveTo(r[2 * e], r[2 * e + 1]); open = true; }
        coast.lineTo(r[j], r[j + 1]);
      }
    }
  }
  const regions = new Path2D(), cities = new Path2D();
  const s = map.segs;
  for (let i = 0; i < s.length; i += 5) {
    const path = s[i + 4] ? regions : cities;
    path.moveTo(s[i], s[i + 1]);
    path.lineTo(s[i + 2], s[i + 3]);
  }
  return { coast, regions, cities };
}

export class Renderer {
  constructor(game, canvas, minimap) {
    this.g = game;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.mapLayer = document.createElement('canvas');
    this.mapKey = '';
    this.miniBase = document.createElement('canvas');
    this.miniVersion = -1;
    this.miniTime = 0;
    this.buildPaths(game.map);
    this.resize();
  }

  buildPaths(map) {
    this.landActive = new Path2D();
    this.landDim = new Path2D();
    this.outlines = new Path2D();
    this.cityPaths = map.cities.map(() => null);
    this.multi = [];
    const countryArea = map.countries.map(() => 0);
    for (const p of map.polys) {
      const own = new Path2D();
      for (const r of p.r) addRing(own, r);
      const target = p.c.length ? this.landActive : this.landDim;
      for (const r of p.r) { addRing(target, r); addRing(this.outlines, r); }
      if (p.c.length === 1) {
        const cp = this.cityPaths[p.c[0]] || (this.cityPaths[p.c[0]] = new Path2D());
        for (const r of p.r) addRing(cp, r);
        countryArea[map.cities[p.c[0]].c] += p.r.reduce((s, r) => s + ringArea(r), 0);
      } else if (p.c.length > 1) {
        p.cells.forEach((cell, i) => { countryArea[map.cities[p.c[i]].c] += ringArea(cell); });
        this.multi.push({
          clip: own,
          cells: p.cells.map((cell, i) => {
            const path = new Path2D();
            addRing(path, cell);
            return { city: p.c[i], path };
          }),
        });
      }
    }
    this.lines = mapLines(map);
    const L = COUNTRY_LABEL;
    this.countryLabels = map.countries.map((co, i) => ({
      text: co.n.toUpperCase(),
      x: co.x,
      y: co.y,
      size: clamp(Math.sqrt(countryArea[i]) * L.perSqrtArea, L.min, L.max),
    }));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.W = this.canvas.clientWidth || window.innerWidth;
    this.H = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.mapLayer.width = this.canvas.width;
    this.mapLayer.height = this.canvas.height;
    this.mapKey = '';

    const b = this.g.map.bounds;
    const mw = Math.min(230, Math.max(140, this.W * 0.16));
    const mh = mw * (b.y1 - b.y0) / (b.x1 - b.x0);
    this.miniW = mw; this.miniH = mh;
    this.mini.style.width = `${mw}px`;
    this.mini.style.height = `${mh}px`;
    this.mini.width = Math.round(mw * dpr);
    this.mini.height = Math.round(mh * dpr);
    this.miniBase.width = this.mini.width;
    this.miniBase.height = this.mini.height;
    this.miniVersion = -1;
  }

  // ---------------------------------------------------------------- coordinates
  minZoom() {
    const b = this.g.map.bounds;
    return Math.min(this.W / (b.x1 - b.x0), this.H / (b.y1 - b.y0)) * 0.95;
  }
  w2s(x, y) {
    const c = this.g.cam;
    return [(x - c.x) * c.zoom + this.W / 2, (y - c.y) * c.zoom + this.H / 2];
  }
  s2w(x, y) {
    const c = this.g.cam;
    return [(x - this.W / 2) / c.zoom + c.x, (y - this.H / 2) / c.zoom + c.y];
  }
  viewRect() {
    const [x0, y0] = this.s2w(0, 0);
    const [x1, y1] = this.s2w(this.W, this.H);
    return { x0, y0, x1, y1 };
  }
  citySize() {
    return clamp(34 * this.g.cam.zoom, 18, 84);
  }
  // Zoomed out far: cities are drawn as small markers (see FAR_ZOOM).
  farView() {
    return this.g.cam.zoom < FAR_ZOOM;
  }
  markerRadius() {
    return clamp(3 + this.g.cam.zoom * 6, 3.5, 5.5);
  }
  // Where a city can be clicked, in screen px: the hit circle sits `lift` above the city point.
  cityHitArea() {
    if (this.farView()) return { lift: 0, radius: Math.max(this.markerRadius() + 4, 8) };
    const size = this.citySize();
    return { lift: size * 0.2, radius: size * 0.48 };
  }

  // ---------------------------------------------------------------- map layer
  ensureMapLayer() {
    const c = this.g.cam;
    const key = `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.zoom.toFixed(4)},${this.W},${this.H},${this.g.territoryVersion}`;
    if (key === this.mapKey) return;
    this.mapKey = key;
    const ctx = this.mapLayer.getContext('2d');
    const dpr = this.dpr, z = c.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, this.mapLayer.width, this.mapLayer.height);
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.W / 2 - c.x * z) * dpr, (this.H / 2 - c.y * z) * dpr);
    this.paintMap(ctx, z, TERRITORY_ALPHA, true);

    // Out-of-bounds shade.
    const b = this.g.map.bounds;
    ctx.fillStyle = 'rgba(8,16,26,0.55)';
    const big = 1e5;
    ctx.beginPath();
    ctx.rect(b.x0 - big, b.y0 - big, (b.x1 - b.x0) + 2 * big, (b.y1 - b.y0) + 2 * big);
    ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.fill('evenodd');

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintCountryLabels(ctx);
  }

  // Draws land, territory tint and borders in world coordinates.
  paintMap(ctx, z, alpha, detailed) {
    const g = this.g;
    if (detailed) {
      ctx.strokeStyle = 'rgba(140,190,215,0.22)';
      ctx.lineWidth = 8 / z;
      ctx.lineJoin = 'round';
      ctx.stroke(this.outlines);
    }
    ctx.fillStyle = LAND_DIM;
    ctx.fill(this.landDim, 'evenodd');
    ctx.fillStyle = LAND;
    ctx.fill(this.landActive, 'evenodd');

    ctx.globalAlpha = alpha;
    for (let i = 0; i < this.cityPaths.length; i++) {
      const p = this.cityPaths[i];
      const o = g.cityOwner[i];
      if (!p || o < 0) continue;
      ctx.fillStyle = g.colorOf(o);
      ctx.fill(p, 'evenodd');
    }
    for (const m of this.multi) {
      if (!m.cells.some((cell) => g.cityOwner[cell.city] >= 0)) continue;
      ctx.save();
      ctx.clip(m.clip, 'evenodd');
      for (const cell of m.cells) {
        const o = g.cityOwner[cell.city];
        if (o < 0) continue;
        ctx.fillStyle = g.colorOf(o);
        ctx.fill(cell.path);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Only two kinds of border: between the cities of one region (faint) and between regions.
    const lines = this.lines;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (detailed) {
      ctx.strokeStyle = 'rgba(70,50,30,0.28)';
      ctx.lineWidth = 0.9 / z;
      ctx.stroke(lines.cities);
    }
    ctx.strokeStyle = 'rgba(55,32,18,0.85)';
    ctx.lineWidth = (detailed ? 1.6 : 0.5) / z;
    ctx.stroke(lines.regions);
    ctx.strokeStyle = 'rgba(45,30,18,0.85)';
    ctx.lineWidth = (detailed ? 1.3 : 0.6) / z;
    ctx.stroke(lines.coast);
    ctx.lineCap = 'butt';
  }

  // Faint country names, fixed to the map: their size and place are in world units,
  // so they zoom with the land. Hidden in the strategic view, with a short fade in after it.
  // Zoomed far in the letters grow huge, so they also get lighter.
  paintCountryLabels(ctx) {
    const z = this.g.cam.zoom;
    const fade = clamp((z - FAR_ZOOM) / 0.1, 0, 1) * (1 - 0.45 * clamp((z - 1.2) / 1.8, 0, 1));
    if (fade <= 0) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(70,45,22,${COUNTRY_LABEL.alpha * fade})`;
    const spacing = 'letterSpacing' in ctx;
    for (const l of this.countryLabels) {
      const fs = l.size * z;
      const [sx, sy] = this.w2s(l.x, l.y - l.size * 0.8);
      const half = l.text.length * fs * 0.55;
      if (sx + half < 0 || sx - half > this.W || sy + fs < 0 || sy - fs > this.H) continue;
      ctx.font = `600 ${fs.toFixed(1)}px 'Palatino Linotype', Georgia, serif`;
      if (spacing) ctx.letterSpacing = `${(fs * 0.18).toFixed(1)}px`;
      ctx.fillText(l.text, sx, sy);
    }
    if (spacing) ctx.letterSpacing = '0px';
  }

  // ---------------------------------------------------------------- frame
  draw(now) {
    const ctx = this.ctx;
    this.ensureMapLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mapLayer, 0, 0);
    if (this.g.debug) this.g.debug.drawWorld(ctx, this);    // debug overlays such as "show navigation"
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawRally();
    if (this.g.input && this.g.input.showRanges) this.drawCityRanges();
    this.drawCities(now);
    this.drawUnits(now);
    this.drawEffects(now);
    this.drawSelectionBox();
    this.drawMinimap(now);
  }

  onScreen(sx, sy, m) {
    return sx > -m && sy > -m && sx < this.W + m && sy < this.H + m;
  }

  drawRally() {
    const g = this.g, ctx = this.ctx;
    for (const ci of g.selectedCities) {
      if (g.cityOwner[ci] !== g.you) continue;
      const q = g.myQueues.get(ci);
      if (!q || q.rally == null) continue;
      const c = g.map.cities[ci];
      const [ax, ay] = this.w2s(c.x, c.y);
      const [bx, by] = this.w2s(q.rally[0], q.rally[1]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#1c130b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - 22); ctx.stroke();
      ctx.fillStyle = g.colorOf(g.you);
      ctx.beginPath(); ctx.moveTo(bx, by - 22); ctx.lineTo(bx + 14, by - 17); ctx.lineTo(bx, by - 12); ctx.closePath();
      ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
    }
  }

  // Alt held: the attack radius of every city, in its owner's colour, under all cities and units.
  drawCityRanges() {
    const g = this.g, ctx = this.ctx;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    g.map.cities.forEach((c, i) => {
      const r = g.cityRange(i) * g.cam.zoom;      // a Tower makes it longer
      const [sx, sy] = this.w2s(c.x, c.y);
      if (!this.onScreen(sx, sy, r)) return;
      const color = g.colorOf(g.cityOwner[i]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  // Liberators' marks (game option Death: Liberator), shown to everyone. A city marked for
  // liberation gets a turning dashed ring in the liberator's colour; a city smuggled from gets a
  // gold coin rimmed in the smuggler's colour. One ring or coin per liberator.
  drawCityMarks(ci, sx, sy, far, size, mr, top, now) {
    const g = this.g, m = g.marks, ctx = this.ctx;
    if (!m) return;
    const influence = m.influence.get(ci), smuggle = m.smuggle.get(ci);
    if (influence) {
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -now / 50;
      influence.forEach((id, k) => {
        ctx.strokeStyle = g.colorOf(id);
        ctx.beginPath();
        if (far) ctx.arc(sx, sy, mr + 7 + k * 4, 0, Math.PI * 2);
        else ctx.ellipse(sx, sy + size * 0.05, size * 0.62 + k * 5, size * 0.24 + k * 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (smuggle) {
      const r = far ? 4 : Math.max(4, size * 0.09);
      smuggle.forEach((id, k) => {
        const cx = (far ? sx + mr + 3 : sx + size * 0.36) + k * r * 2.2, cy = far ? sy - mr - 3 : top + size * 0.14;
        ctx.fillStyle = '#e8c04a';
        ctx.strokeStyle = g.colorOf(id);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(110,80,10,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.stroke();
      });
    }
  }

  // Close up: castles showing their upgrades, with names. Strategic view (far): small markers in
  // the owner's colour, no upgrades; name and HP bar only for a hovered or selected city.
  drawCities(now) {
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    const far = this.farView();
    const size = this.citySize();
    const mr = this.markerRadius();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fontSize = clamp(10 + z * 2.5, 11, 15);
    ctx.font = `600 ${fontSize}px system-ui, 'Segoe UI', sans-serif`;
    const hover = g.input ? g.input.hoverCity : -1;
    // Edit map: the city being dragged is drawn under the cursor, tied to where it stood.
    const drag = g.input && g.input.cityDrag && g.input.cityDrag.active ? g.input.cityDrag : null;
    if (drag) {
      const from = g.map.cities[drag.city];
      const [ax, ay] = this.w2s(from.x, from.y);
      const [bx, by] = this.w2s(drag.x, drag.y);
      ctx.strokeStyle = 'rgba(255,230,140,0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ax, ay, 4, 0, Math.PI * 2); ctx.stroke();
    }

    g.map.cities.forEach((c, i) => {
      const [sx, sy] = drag && drag.city === i ? this.w2s(drag.x, drag.y) : this.w2s(c.x, c.y);
      if (!this.onScreen(sx, sy, size + 80)) return;
      const owner = g.cityOwner[i];
      const color = g.colorOf(owner);
      const selected = g.selectedCities.has(i) || (g.inspect && g.inspect.k === 'c' && g.inspect.id === i);

      if (selected || i === hover) {
        ctx.strokeStyle = selected ? 'rgba(255,230,140,0.95)' : 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (far) ctx.arc(sx, sy, mr + 4.5, 0, Math.PI * 2);
        else ctx.ellipse(sx, sy + size * 0.05, size * 0.55, size * 0.2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (selected && g.selectedCities.size <= 1) {
        ctx.strokeStyle = 'rgba(255,120,80,0.55)';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, g.cityRange(i) * z, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }

      let top, ny;          // screen y just above the icon (HP bar) and below it (name)
      if (far) {
        this.cityMarker(sx, sy, mr, color, owner === g.you);
        top = sy - mr - 3;
        ny = sy + mr + 4;
      } else {
        // The sprite shows built upgrades: a stone ring wall and/or an extra tower.
        const sprite = castleSprite(color, g.cityUpgrades[i]);
        const s = size / 64;
        ctx.drawImage(sprite, sx - CASTLE_ANCHOR.x * s, sy - CASTLE_ANCHOR.y * s, size, size);
        top = sy - CASTLE_ANCHOR.y * s - 2;
        ny = sy + (64 - CASTLE_ANCHOR.y) * s - 2;
      }
      this.drawCityMarks(i, sx, sy, far, size, mr, top, now);

      const hp = g.cityHp[i], maxHp = g.cityMaxHp(i);
      if (selected || (!far && hp < maxHp)) {
        const bw = far ? 18 : size * 0.7, bh = far ? 3 : Math.max(3, size * 0.07);
        this.bar(sx - bw / 2, top - bh, bw, bh, hp / maxHp);
      }

      if (!far || selected || i === hover) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(20,12,6,0.85)';
        ctx.strokeText(c.n, sx, ny);
        ctx.fillStyle = owner === g.you ? '#fff4c8' : '#f4ead2';
        ctx.fillText(c.n, sx, ny);
        const q = owner === g.you ? g.myQueues.get(i) : null;
        if (q && q.queue.length) {
          const item = PRODUCTION_ITEMS[q.queue[0]];
          const def = UNITS[item] || CITY_UPGRADES[item];
          const bw = Math.max(28, size * 0.6);
          this.bar(sx - bw / 2, ny + fontSize + 3, bw, 3, q.progress / def.buildTime, '#e0b850');
        }
      }
    });
  }

  // Strategic-view city: a dot in the owner's colour. Your own cities get a light outer ring,
  // as on the minimap.
  cityMarker(sx, sy, r, color, mine) {
    const ctx = this.ctx;
    if (mine) {
      ctx.strokeStyle = '#fff4c8';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(sx, sy, r + 1.7, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.arc(sx - r * 0.3, sy - r * 0.3, r * 0.38, 0, Math.PI * 2); ctx.fill();
  }

  bar(x, y, w, h, frac, color) {
    const ctx = this.ctx;
    frac = clamp(frac, 0, 1);
    ctx.fillStyle = 'rgba(15,10,5,0.8)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color || (frac > 0.6 ? '#5ccf54' : frac > 0.3 ? '#e8c440' : '#e0503a');
    ctx.fillRect(x, y, w * frac, h);
  }

  drawUnits(now) {
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    const list = g.renderUnits;
    const inspectId = g.inspect && g.inspect.k === 'u' ? g.inspect.id : -1;
    for (const u of list) {
      const def = UNITS[UNIT_TYPES[u.t]];
      const rpx = def.size * z;
      const [sx, sy] = this.w2s(u.dx, u.dy);
      if (!this.onScreen(sx, sy, rpx * 4 + 10)) continue;
      const color = g.colorOf(u.owner);
      const selected = g.selection.has(u.id);
      const disbanding = u.flags & 4;
      if (disbanding) this.drawDisbandGlow(sx, sy, rpx, u.id, now);   // under the selection ring

      if (selected || u.id === inspectId) {
        ctx.strokeStyle = selected ? '#9dff6a' : '#ff6a5a';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(sx, sy, rpx * 1.3 + 2, rpx * 0.65 + 1.5, 0, 0, Math.PI * 2); ctx.stroke();
      }

      if (rpx < 2.6) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.6, rpx), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (u.flags & 8 && u.owner === g.you) this.drawHoldMark(sx, sy, rpx);
      const s = rpx / CONE.rx;
      ctx.drawImage(unitSprite(color, u.t), sx - CONE.cx * s, sy - CONE.by * s, 64 * s, 64 * s);
      if (disbanding) this.drawDisbandMotes(sx, sy, rpx, u.id, now);

      if (u.hp < def.hp || selected || disbanding) {
        const bw = Math.max(12, rpx * 2), bh = Math.max(2, rpx * 0.22);
        this.bar(sx - bw / 2, sy - (CONE.by - 2) * s - bh - 2, bw, bh, u.hp / def.hp);
      }
    }
  }

  // One of your units on Hold (H key): a dashed ring at its feet, so you can tell it won't move.
  drawHoldMark(sx, sy, rpx) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,214,110,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.ellipse(sx, sy, rpx * 1.1 + 1, rpx * 0.55 + 1, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Disbanding unit (Delete key): a pulsing blood-red pool at its feet...
  drawDisbandGlow(sx, sy, rpx, id, now) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 170 + id);
    const rx = Math.max(3.5, rpx * (1.45 + 0.2 * pulse));
    ctx.fillStyle = `rgba(185,18,28,${0.3 + 0.25 * pulse})`;
    ctx.beginPath(); ctx.ellipse(sx, sy, rx, rx * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }

  // ...and red drops drifting up out of it as its HP drains away.
  drawDisbandMotes(sx, sy, rpx, id, now) {
    const ctx = this.ctx;
    for (let k = 0; k < 3; k++) {
      const t = (now / 1100 + k / 3 + (id % 7) / 7) % 1;
      const x = sx + Math.sin(id * 1.7 + k * 2.1 + t * 4) * rpx * 0.75;
      const y = sy - rpx * 0.4 - t * rpx * 3.4;
      ctx.fillStyle = `rgba(232,44,44,${(1 - t) * 0.9})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1.2, rpx * 0.17) * (1 - t * 0.5), 0, Math.PI * 2); ctx.fill();
    }
  }

  drawEffects(now) {
    const ctx = this.ctx, z = this.g.cam.zoom, fx = this.g.effects;

    for (const p of fx.shots) {
      const t = (now - p.t0) / p.dur;
      if (t < 0 || t > 1) continue;
      const x = p.x0 + (p.x1 - p.x0) * t, y = p.y0 + (p.y1 - p.y0) * t;
      const lift = Math.sin(Math.PI * t) * p.arc;
      const [sx, sy] = this.w2s(x, y - lift);
      const ang = Math.atan2((p.y1 - p.y0) - Math.cos(Math.PI * t) * p.arc * Math.PI, p.x1 - p.x0);
      const len = Math.max(5, (p.city ? 9 : 7) * z);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      if (p.city) {
        ctx.fillStyle = 'rgba(255,170,60,0.35)';
        ctx.beginPath(); ctx.arc(0, 0, Math.max(3, 2.8 * z), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#ffcf6a';
      } else {
        ctx.strokeStyle = '#2a1a0c';
      }
      ctx.lineWidth = Math.max(1.2, 0.5 * z);
      ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(0, 0); ctx.stroke();
      ctx.restore();
    }

    for (const s of fx.sparks) {
      const t = (now - s.t0) / 260;
      if (t < 0 || t > 1) continue;
      const [sx, sy] = this.w2s(s.x, s.y);
      const r = Math.max(3, 3.2 * z) * (0.6 + t * 0.6);
      ctx.strokeStyle = `rgba(255,245,200,${1 - t})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = s.rot + k * Math.PI / 4 * 2;
        ctx.moveTo(sx + Math.cos(a) * r * 0.3, sy + Math.sin(a) * r * 0.3);
        ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r);
      }
      ctx.stroke();
    }

    for (const d of fx.deaths) {
      const t = (now - d.t0) / 900;
      if (t < 0 || t > 1) continue;
      const [sx, sy] = this.w2s(d.x, d.y);
      const r = Math.max(4, 7 * z) * (0.7 + t);
      ctx.fillStyle = `rgba(60,50,40,${0.45 * (1 - t)})`;
      ctx.beginPath(); ctx.ellipse(sx, sy - r * 0.3 * t, r, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = mix(d.color, [0, 0, 0], 0.2);
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 2;
      const k = r * 0.45;
      ctx.beginPath(); ctx.moveTo(sx - k, sy - k); ctx.lineTo(sx + k, sy + k); ctx.moveTo(sx + k, sy - k); ctx.lineTo(sx - k, sy + k); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const m of fx.markers) {
      const t = (now - m.t0) / 550;
      if (t < 0 || t > 1) continue;
      const [sx, sy] = this.w2s(m.x, m.y);
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(sx, sy, 16 * (1 - t) + 4, (16 * (1 - t) + 4) * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const f of fx.flashes) {
      const t = (now - f.t0) / 1600;
      if (t < 0 || t > 1) continue;
      const c = this.g.map.cities[f.city];
      const [sx, sy] = this.w2s(c.x, c.y);
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(sx, sy, 10 + t * Math.max(60, 90 * z), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawSelectionBox() {
    const d = this.g.input && this.g.input.drag;
    if (!d || !d.active) return;
    const ctx = this.ctx;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    const citiesOnly = this.g.input.showRanges;     // Alt held: the frame picks only cities (gold frame)
    ctx.fillStyle = citiesOnly ? 'rgba(232,193,92,0.14)' : 'rgba(157,255,106,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = citiesOnly ? 'rgba(232,193,92,0.95)' : 'rgba(157,255,106,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }

  // ---------------------------------------------------------------- minimap
  miniScale() {
    const b = this.g.map.bounds;
    return this.miniW / (b.x1 - b.x0);
  }
  miniToWorld(mx, my) {
    const b = this.g.map.bounds, s = this.miniScale();
    return [b.x0 + mx / s, b.y0 + my / s];
  }

  drawMinimap(now) {
    const g = this.g, b = g.map.bounds, s = this.miniScale(), dpr = this.dpr;
    if (this.miniVersion !== g.territoryVersion && now - this.miniTime > 400) {
      this.miniVersion = g.territoryVersion;
      this.miniTime = now;
      const mc = this.miniBase.getContext('2d');
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.fillStyle = SEA;
      mc.fillRect(0, 0, this.miniBase.width, this.miniBase.height);
      mc.setTransform(s * dpr, 0, 0, s * dpr, -b.x0 * s * dpr, -b.y0 * s * dpr);
      this.paintMap(mc, s, 0.85, false);
    }
    const ctx = this.mctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.miniBase, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    g.map.cities.forEach((c, i) => {
      const x = (c.x - b.x0) * s, y = (c.y - b.y0) * s;
      ctx.fillStyle = g.colorOf(g.cityOwner[i]);
      ctx.strokeStyle = g.cityOwner[i] === g.you ? '#fff' : 'rgba(20,12,6,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(x - 2, y - 2, 4, 4); ctx.fill(); ctx.stroke();
    });

    for (const u of g.renderUnits) {
      const x = (u.x - b.x0) * s, y = (u.y - b.y0) * s;
      ctx.fillStyle = u.owner === g.you ? '#ffffff' : g.colorOf(u.owner);
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }

    const v = this.viewRect();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect((v.x0 - b.x0) * s + 0.5, (v.y0 - b.y0) * s + 0.5, (v.x1 - v.x0) * s, (v.y1 - v.y0) * s);
  }
}
