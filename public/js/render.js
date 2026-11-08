// Canvas renderer: cached map layer (sea, land, territories, borders, labels),
// then ports, cities, units, ships and effects on top every frame. Also draws the minimap.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, PRODUCTION_ITEMS, ECONOMY } from '/shared/config.js';
import { unitSprite, castleSprite, anchorBadge, CONE, CASTLE_ANCHOR, mix } from './sprites.js';
import { regionIndex, regionLabelSizes, placeLabels, regionOutlines } from './map-labels.js';
import { forEachCoastPiece } from '/shared/coastline.js';

const SEA = '#1f3d58';
const LAND = '#dccfa8';
const LAND_DIM = '#a9a088';
const TERRITORY_ALPHA = 0.5;
const INK = '#1c130b';
// Beaches (ships take units on board and land them there): shallow water off the shore, and sand.
const SHALLOWS = 'rgba(112,178,190,0.55)';
const BEACH = 'rgb(226,200,130)';
const BEACH_EDGE = 'rgba(90,64,28,0.7)';
const PLAN_COLORS = ['#9dff6a', '#ff9a3c', '#ff4a3a'];   // queued orders: move, attack-move, attack (as the click markers)

// Below this zoom the map is the strategic view: small coloured city markers,
// no castles, upgrades, city names or country names.
const FAR_ZOOM = 0.42;
// Country names are printed on the map like terrain: their size is in world units,
// so they scale with the map and stay in the same place. Bigger countries get bigger letters.
// They are kept off the cities as the cities look at labelZoom, just after the names fade in:
// zoomed in further, castles and city names take less of the map (see map-labels.js).
const COUNTRY_LABEL = { alpha: 0.3, spacing: 0.18, labelZoom: 0.5 };
// You take the last city of a region (client.regionChanged): for `ms` the region lights up in
// gold. A wave of light spreads over it from the city just taken in the first `spread` of that
// time, its outline lights up behind the wave, and each city it reaches bursts with a gold ring
// and shows the gold it now pays more ("+2/turn"). Its name shines in gold for the first half.
export const REGION_GLOW = { ms: 4200, spread: 0.35 };
const LABEL_FONT = (px) => `600 ${px}px 'Palatino Linotype', Georgia, serif`;
const CITY_FONT = (px) => `600 ${px}px system-ui, 'Segoe UI', sans-serif`;
// Close up: castle sprite size and city name font size in screen px at zoom z.
const castleSize = (z) => clamp(34 * z, 18, 84);
const cityFontSize = (z) => clamp(10 + z * 2.5, 11, 15);

function addRing(path, r) {
  path.moveTo(r[0], r[1]);
  for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]);
  path.closePath();
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The lines of the map: coastlines, region borders and the borders between cities of one region.
// A ring edge that another landmass shares is a land border, not coast. Land borders
// are drawn from map.segs only, where they divide two cities ([x0, y0, x1, y1, kind], kind 1 =
// region border). `isBeach(x, y)`: the coast there is a beach (ships take units on board and land
// them there). The coast is walked in short pieces as the game's host walks it (shared/coastline.js);
// beach pieces go to `beach`, the rest of the coast (cliffs) to `coast`.
export function mapLines(map, isBeach = null) {
  const coast = new Path2D(), beach = new Path2D();
  let open = null;                  // the path the current stretch of coast is drawn on
  forEachCoastPiece(map, (ax, ay, bx, by, first) => {
    const path = isBeach && isBeach((ax + bx) / 2, (ay + by) / 2) ? beach : coast;
    if (first || open !== path) { path.moveTo(ax, ay); open = path; }
    path.lineTo(bx, by);
  });
  const regions = new Path2D(), cities = new Path2D();
  const s = map.segs;
  for (let i = 0; i < s.length; i += 5) {
    const path = s[i + 4] ? regions : cities;
    path.moveTo(s[i], s[i + 1]);
    path.lineTo(s[i + 2], s[i + 3]);
  }
  return { coast, beach, regions, cities };
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
    this.facing = new Map();          // ship id -> -1 when it last sailed left (the sprite is mirrored)
    this.buildPaths(game.map);
    this.resize();
  }

  buildPaths(map) {
    this.landActive = new Path2D();
    this.landDim = new Path2D();
    this.outlines = new Path2D();
    this.cityPaths = map.cities.map(() => null);
    this.multi = [];
    for (const p of map.polys) {
      const own = new Path2D();
      for (const r of p.r) addRing(own, r);
      const target = p.c.length ? this.landActive : this.landDim;
      for (const r of p.r) { addRing(target, r); addRing(this.outlines, r); }
      if (p.c.length === 1) {
        const cp = this.cityPaths[p.c[0]] || (this.cityPaths[p.c[0]] = new Path2D());
        for (const r of p.r) addRing(cp, r);
      } else if (p.c.length > 1) {
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
    // Beaches as the game's host marks them (client.js isBeachAt): drawn as sandy stretches of coast.
    this.lines = mapLines(map, this.g.beaches ? (x, y) => this.g.isBeachAt(x, y) : null);
    this.regions = regionIndex(map);
    this.labelSizes = regionLabelSizes(this.regions);
    this.placeCountryLabels(map);

    // Each region's land and outline, which light up when a player takes all of it (REGION_GLOW).
    // Its land: the territories of its cities that have a landmass to themselves, and its cities'
    // cells of shared landmasses, with the landmass to clip them to.
    this.regionLand = map.countries.map(() => ({ paths: [], clipped: [] }));
    map.cities.forEach((c, ci) => { if (this.cityPaths[ci]) this.regionLand[c.c].paths.push(this.cityPaths[ci]); });
    for (const m of this.multi) {
      const byRegion = new Map();
      for (const cell of m.cells) {
        const r = map.cities[cell.city].c;
        if (!byRegion.has(r)) byRegion.set(r, []);
        byRegion.get(r).push(cell.path);
      }
      for (const [r, paths] of byRegion) this.regionLand[r].clipped.push({ clip: m.clip, paths });
    }
    this.regionEdges = regionOutlines(map, this.regions);       // [x0, y0, x1, y1, ...] per region
    this.regionOutline = this.regionEdges.map((s) => {
      const path = new Path2D();
      for (let i = 0; i < s.length; i += 4) { path.moveTo(s[i], s[i + 1]); path.lineTo(s[i + 2], s[i + 3]); }
      return path;
    });
  }

  // Country names: just above the middle of their cities, or the nearest spot in the country
  // where they cover no city and no other name. Again after a city moves.
  placeCountryLabels(map) {
    const L = COUNTRY_LABEL, Z = L.labelZoom;
    const m = this.measureCtx || (this.measureCtx = document.createElement('canvas').getContext('2d'));
    const spacing = 'letterSpacing' in this.ctx ? L.spacing : 0;
    m.font = LABEL_FONT(100);
    const labels = map.countries.map((co, i) => {
      const size = this.labelSizes[i];
      const text = co.n.toUpperCase();
      return {
        region: i, text, size,
        x: co.x,
        y: co.y - size * 0.8,
        w: (m.measureText(text).width / 100 + text.length * spacing + 0.3) * size,
        h: size,
      };
    });
    // Each city as drawn close up at labelZoom: the castle, and its name below it.
    const s = castleSize(Z) / Z, fs = cityFontSize(Z), pad = 3 / Z;
    const top = (CASTLE_ANCHOR.y / 64) * s, bottom = ((64 - CASTLE_ANCHOR.y) / 64) * s;
    m.font = CITY_FONT(fs);
    const cities = [];
    for (const c of map.cities) {
      cities.push({ x0: c.x - s / 2 - pad, y0: c.y - top - pad, x1: c.x + s / 2 + pad, y1: c.y + bottom });
      const w = (m.measureText(c.n).width + 3) / Z, ny = c.y + bottom - 2 / Z;
      cities.push({ x0: c.x - w / 2 - pad, y0: ny - pad, x1: c.x + w / 2 + pad, y1: ny + (fs * 1.2) / Z + pad });
    }
    this.countryLabels = placeLabels(labels, cities, this.regions);
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
    return castleSize(this.g.cam.zoom);
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
      // Beaches: shallow water off the shore, a soft teal fringe. Drawn under the land, so it shows
      // on the sea side only.
      ctx.strokeStyle = SHALLOWS;
      ctx.lineWidth = 11 / z;
      ctx.stroke(this.lines.beach);
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
    // Beaches, where ships take units on board and land them: the shallows above, then a thin strip of
    // sand on the shoreline. The rest of the coast is cliffs: the plain dark line, against deep water.
    ctx.strokeStyle = BEACH;
    ctx.lineWidth = (detailed ? 3 : 1.4) / z;
    ctx.stroke(lines.beach);
    if (detailed) {
      ctx.strokeStyle = BEACH_EDGE;
      ctx.lineWidth = 0.8 / z;
      ctx.stroke(lines.beach);
    }
    ctx.strokeStyle = 'rgba(40,27,16,0.9)';
    ctx.lineWidth = (detailed ? 1.6 : 0.6) / z;
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
      const [sx, sy] = this.w2s(l.x, l.y);
      const half = (l.w / 2) * z;
      if (sx + half < 0 || sx - half > this.W || sy + fs < 0 || sy - fs > this.H) continue;
      ctx.font = LABEL_FONT(fs.toFixed(1));
      if (spacing) ctx.letterSpacing = `${(fs * COUNTRY_LABEL.spacing).toFixed(1)}px`;
      ctx.fillText(l.text, sx, sy);
    }
    if (spacing) ctx.letterSpacing = '0px';
  }

  // ---------------------------------------------------------------- whole region taken
  // Where a region glow is at `now`, or null once it is over. t: 0..1 through it; fade: its
  // brightness (in fast, out slowly); front: how far the wave has spread from the city just taken,
  // in world units; reach: how far it goes, a band beyond the farthest point of the region.
  regionGlow(e, now) {
    const t = (now - e.t0) / REGION_GLOW.ms;
    if (t < 0 || t >= 1) return null;
    if (e.reach === undefined) {
      const o = this.g.map.cities[e.city], s = this.regionEdges[e.region];
      let far = 0;
      for (let i = 0; i < s.length; i += 2) far = Math.max(far, Math.hypot(s[i] - o.x, s[i + 1] - o.y));
      e.band = clamp(far * 0.3, 30, 140);
      e.reach = far + e.band;
    }
    const fade = Math.min(1, t / 0.06) * Math.min(1, (1 - t) / 0.35);
    return { t, fade, front: e.reach * Math.min(1, t / REGION_GLOW.spread), reach: e.reach, band: e.band };
  }

  // Fills a region's land (the territories of all its cities) with the current fill style.
  fillRegion(ctx, region) {
    const land = this.regionLand[region];
    for (const p of land.paths) ctx.fill(p, 'evenodd');
    for (const m of land.clipped) {
      ctx.save();
      ctx.clip(m.clip, 'evenodd');
      for (const p of m.paths) ctx.fill(p);
      ctx.restore();
    }
  }

  // The land and outline of a region you just took whole, under the cities and units. The wave is
  // a bright band leaving a gold wash behind it, and the outline lights up as far as it has come.
  drawRegionGlow(now) {
    const g = this.g, list = g.effects.regions;
    if (!list.length) return;
    const ctx = this.ctx, c = g.cam, z = c.zoom, dpr = this.dpr;
    ctx.save();
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.W / 2 - c.x * z) * dpr, (this.H / 2 - c.y * z) * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const e of list) {
      const s = this.regionGlow(e, now);
      if (!s) continue;
      const o = g.map.cities[e.city];
      const pulse = 0.8 + 0.2 * Math.cos(s.t * Math.PI * 6);
      const wash = `rgba(255,222,120,${(0.3 * s.fade * pulse).toFixed(3)})`;
      const spreading = s.front < s.reach;
      if (spreading) {
        const R = s.front + s.band * 0.4;
        const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, R);
        grad.addColorStop(0, wash);
        grad.addColorStop(Math.max(0, (s.front - s.band) / R), wash);
        grad.addColorStop(s.front / R, `rgba(255,246,200,${(0.65 * s.fade).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255,246,200,0)');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = wash;
      }
      this.fillRegion(ctx, e.region);

      ctx.save();
      if (spreading) {
        ctx.beginPath();
        ctx.arc(o.x, o.y, s.front, 0, Math.PI * 2);
        ctx.clip();
      }
      const outline = this.regionOutline[e.region];
      ctx.strokeStyle = `rgba(255,200,70,${(0.4 * s.fade * pulse).toFixed(3)})`;
      ctx.lineWidth = 10 / z;
      ctx.stroke(outline);
      ctx.strokeStyle = `rgba(255,242,175,${(0.95 * s.fade).toFixed(3)})`;
      ctx.lineWidth = 2.4 / z;
      ctx.stroke(outline);
      ctx.restore();
    }
    ctx.restore();
  }

  // Over the cities and units: as the wave reaches each city of the region, a gold ring bursts out
  // of it and "+2/turn", the gold it now pays more, rises from it. The region's name shines in
  // gold, over its faint name on the map (or where that would be, in the strategic view).
  drawRegionBursts(now) {
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    const far = this.farView();
    const lift = far ? this.markerRadius() + 6 : this.citySize() * 0.7;   // the top of the city
    for (const e of g.effects.regions) {
      const s = this.regionGlow(e, now);
      if (!s) continue;
      const o = g.map.cities[e.city];
      const ids = g.regionCities[e.region];
      for (const ci of ids) {
        const c = g.map.cities[ci];
        // ms since the wave reached the city
        const k = (s.t - Math.hypot(c.x - o.x, c.y - o.y) / s.reach * REGION_GLOW.spread) * REGION_GLOW.ms;
        if (k < 0) continue;
        const [sx, sy] = this.w2s(c.x, c.y);
        if (!this.onScreen(sx, sy, 140)) continue;
        if (k < 1000) {
          const u = k / 1000, r = 8 + (1 - (1 - u) ** 2) * Math.max(45, 70 * z);
          ctx.strokeStyle = `rgba(255,214,92,${(1 - u).toFixed(3)})`;
          ctx.lineWidth = 4 * (1 - u) + 1;
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = `rgba(255,248,215,${(0.8 * (1 - u)).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sx, sy, r * 0.62, 0, Math.PI * 2); ctx.stroke();
        }
        const u = k / 2600;
        if (u < 1) {
          const a = Math.min(1, k / 180) * Math.min(1, (1 - u) / 0.35) * s.fade;
          this.drawBonusText(sx, sy - lift - 30 * (1 - (1 - u) ** 3), a);
        }
      }
      this.drawRegionName(e.region, s);
    }
  }

  // "+2/turn" in gold (ECONOMY.regionBonusPerCity), centred on (x, y).
  drawBonusText(x, y, alpha) {
    if (alpha <= 0) return;
    const ctx = this.ctx, text = `+${ECONOMY.regionBonusPerCity}/turn`;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = CITY_FONT(14);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,12,6,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffe08a';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // The gold name lasts half as long as the glow (REGION_GLOW.ms / 2).
  drawRegionName(region, s) {
    const t = s.t * 2;
    if (t >= 1) return;
    const l = this.countryLabels[region], z = this.g.cam.zoom, ctx = this.ctx;
    const fs = Math.max(16, l.size * z);
    const [sx, sy] = this.w2s(l.x, l.y);
    const half = (l.w / 2) * fs / l.size;
    if (sx + half < 0 || sx - half > this.W || sy + fs < 0 || sy - fs > this.H) return;
    const a = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.35);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = LABEL_FONT(fs.toFixed(1));
    const spacing = 'letterSpacing' in ctx;
    if (spacing) ctx.letterSpacing = `${(fs * COUNTRY_LABEL.spacing).toFixed(1)}px`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, fs * 0.12);
    ctx.strokeStyle = 'rgba(40,24,8,0.8)';
    ctx.strokeText(l.text, sx, sy);
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(l.text, sx, sy);
    if (spacing) ctx.letterSpacing = '0px';
    ctx.restore();
  }

  // ---------------------------------------------------------------- frame
  draw(now) {
    const ctx = this.ctx;
    this.ensureMapLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mapLayer, 0, 0);
    if (this.g.debug) this.g.debug.drawWorld(ctx, this);    // debug overlays such as "show navigation"
    this.drawRegionGlow(now);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawRally();
    if (this.g.input && this.g.input.showRanges) this.drawCityRanges();
    this.drawPorts();
    this.drawCities(now);
    this.drawPlans();
    this.drawDocks();
    this.drawUnits(now);
    this.drawUnloadAim();
    this.drawBeachBrush();
    this.drawEffects(now);
    this.drawSelectionBox();
    this.drawMinimap(now);
  }

  onScreen(sx, sy, m) {
    return sx > -m && sy > -m && sx < this.W + m && sy < this.H + m;
  }

  // The rally points of your selected cities: for units on land (white line from the city), and for
  // ships on the water (light blue line from the pier, the flag on a buoy).
  drawRally() {
    const g = this.g;
    for (const ci of g.selectedCities) {
      if (g.cityOwner[ci] !== g.you) continue;
      const q = g.myQueues.get(ci);
      if (!q) continue;
      const c = g.map.cities[ci];
      if (q.rally) this.rallyFlag(c.x, c.y, q.rally, 'rgba(255,255,255,0.75)', false);
      if (q.seaRally) {
        const p = g.ports.get(ci) || c;
        this.rallyFlag(p.x, p.y, q.seaRally, 'rgba(150,228,255,0.85)', true);
      }
    }
  }

  rallyFlag(fx, fy, [x, y], line, sea) {
    const g = this.g, ctx = this.ctx;
    const [ax, ay] = this.w2s(fx, fy);
    const [bx, by] = this.w2s(x, y);
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    if (sea) {
      ctx.fillStyle = '#9fdcff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(bx, by, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - 22); ctx.stroke();
    ctx.fillStyle = g.colorOf(g.you);
    ctx.beginPath(); ctx.moveTo(bx, by - 22); ctx.lineTo(bx + 14, by - 17); ctx.lineTo(bx, by - 12); ctx.closePath();
    ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
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

  // The port of every coastal city, close up: a timber pier reaching into the sea where its ships
  // are launched, and a track to it from a city that stands back from the shore.
  drawPorts() {
    if (this.farView()) return;
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    ctx.lineCap = 'butt';
    for (const [ci, p] of g.ports) {
      const [px, py] = this.w2s(p.x, p.y);
      if (!this.onScreen(px, py, 60 + 30 * z)) continue;
      const c = g.map.cities[ci];
      const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;                   // from the city towards the sea
      const [cx, cy] = this.w2s(c.x, c.y);
      const ax = px - ux * 6 * z, ay = py - uy * 6 * z;        // the pier, from the shore...
      const bx = px + ux * 4 * z, by = py + uy * 4 * z;        // ...out into the water
      if (d > CITY.size * 1.6) {
        ctx.strokeStyle = 'rgba(110,80,45,0.55)';
        ctx.lineWidth = Math.max(1.2, 0.9 * z);
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(cx + ux * CITY.size * z, cy + uy * CITY.size * z); ctx.lineTo(ax, ay); ctx.stroke();
        ctx.setLineDash([]);
      }
      const wid = Math.max(2.2, 2.6 * z);
      ctx.strokeStyle = INK;
      ctx.lineWidth = wid + 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = '#a8763f';
      ctx.lineWidth = wid;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      if (z > 0.9) {                                    // planks
        ctx.strokeStyle = 'rgba(60,38,18,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 1; k < 5; k++) {
          const t = k / 5, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          ctx.moveTo(x - uy * wid * 0.5, y + ux * wid * 0.5); ctx.lineTo(x + uy * wid * 0.5, y - ux * wid * 0.5);
        }
        ctx.stroke();
      }
      ctx.fillStyle = INK;                              // mooring posts at the end
      const post = Math.max(1.2, 0.7 * z);
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.arc(bx - uy * wid * 0.6 * side, by + ux * wid * 0.6 * side, post, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // A coastal city's mark (it can build ships): an anchor badge at the castle's upper left corner,
  // or next to the marker in the strategic view.
  drawAnchor(sx, sy, far, size, mr) {
    const r = far ? 4.2 : Math.max(5, size * 0.12);
    const x = far ? sx - mr - 2.5 : sx - size * 0.37, y = far ? sy - mr - 2.5 : sy - size * 0.53;
    this.ctx.drawImage(anchorBadge(), x - r, y - r, r * 2, r * 2);
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
    const fontSize = cityFontSize(z);
    ctx.font = CITY_FONT(fontSize);
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
      if (g.isCoastal(i)) this.drawAnchor(sx, sy, far, size, mr);
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
    // With land units selected, your transports that can take them light up: right-click one to go on board.
    const boarding = g.selection.size > 0 && g.hasSeafaring() && g.selectedLandUnits().length > 0;
    const hoverShip = g.input ? g.input.hoverShip : -1;
    for (const u of list) {
      const def = UNITS[UNIT_TYPES[u.t]];
      const rpx = def.size * z;
      const [sx, sy] = this.w2s(u.dx, u.dy);
      if (def.naval && Math.abs(u.vx) > 0.05) this.facing.set(u.id, u.vx < 0 ? -1 : 1);
      if (!this.onScreen(sx, sy, rpx * 4 + 10)) continue;
      const color = g.colorOf(u.owner);
      const selected = g.selection.has(u.id);
      const disbanding = u.flags & 4;
      // Only transports with room left: a full one can't take anyone on board. (Distance doesn't matter:
      // a transport sails to the nearest beach of the units' land, however far.)
      if (boarding && def.capacity && u.owner === g.you && u.flags >> 5 < def.capacity) {
        this.drawBoardGlow(sx, sy, rpx, u.id === hoverShip, now);
      }
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
      const sprite = unitSprite(color, u.t);
      if (def.naval && this.facing.get(u.id) === -1) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(-1, 1);
        ctx.drawImage(sprite, -CONE.cx * s, -CONE.by * s, 64 * s, 64 * s);
        ctx.restore();
      } else {
        ctx.drawImage(sprite, sx - CONE.cx * s, sy - CONE.by * s, 64 * s, 64 * s);
      }
      if (disbanding) this.drawDisbandMotes(sx, sy, rpx, u.id, now);
      if (u.flags >> 5) this.drawCargoCount(sx + rpx * 1.15, sy - rpx * 1.45, rpx, u.flags >> 5);

      if (u.hp < def.hp || selected || disbanding) {
        const bw = Math.max(12, rpx * 2), bh = Math.max(2, rpx * 0.22);
        this.bar(sx - bw / 2, sy - (CONE.by - 2) * s - bh - 2, bw, bh, u.hp / def.hp);
      }
    }
    if (this.facing.size > 2000) {
      for (const id of this.facing.keys()) if (!g.unitById.has(id)) this.facing.delete(id);
    }
  }

  // A transport the selected land units can go on board: a pulsing light-blue glow, brighter under the cursor.
  drawBoardGlow(sx, sy, rpx, hover, now) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(sx, sy - rpx * 0.35, rpx * 1.75 + 6, rpx * 0.85 + 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(110,215,255,${0.12 + 0.1 * pulse + (hover ? 0.15 : 0)})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(150,228,255,${0.55 + 0.4 * pulse})`;
    ctx.lineWidth = hover ? 2.6 : 1.8;
    ctx.stroke();
    ctx.restore();
  }

  // How many units a ship carries: a small dark disc with the number, at its upper right.
  drawCargoCount(x, y, rpx, n) {
    if (rpx < 2.6) return;
    const ctx = this.ctx, r = Math.max(6, rpx * 0.42);
    ctx.fillStyle = 'rgba(28,19,11,0.9)';
    ctx.strokeStyle = '#e8c04a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff4c8';
    ctx.font = `700 ${Math.round(r * 1.3)}px system-ui, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), x, y + 0.5);
  }

  // Your selected units with Shift-queued orders: a dashed line from each unit through every place it
  // still has to go, a dot at each. Coloured by order, like the click markers: green move, orange
  // attack-move, red attack.
  drawPlans() {
    const g = this.g, ctx = this.ctx;
    if (!g.plans.size || !g.selection.size) return;
    const lines = PLAN_COLORS.map(() => new Path2D()), dots = PLAN_COLORS.map(() => new Path2D());
    for (const id of g.selection) {
      const pts = g.plans.get(id), u = pts && g.unitById.get(id);
      if (!u) continue;
      let [ax, ay] = this.w2s(u.dx, u.dy);
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const k = pts[i] in PLAN_COLORS ? pts[i] : 0;
        const [bx, by] = this.w2s(pts[i + 1], pts[i + 2]);
        lines[k].moveTo(ax, ay);
        lines[k].lineTo(bx, by);
        dots[k].moveTo(bx + 3, by);
        dots[k].arc(bx, by, 3, 0, Math.PI * 2);
        ax = bx; ay = by;
      }
    }
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([6, 5]);
    PLAN_COLORS.forEach((c, k) => { ctx.strokeStyle = c; ctx.stroke(lines[k]); });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    PLAN_COLORS.forEach((c, k) => { ctx.fillStyle = c; ctx.fill(dots[k]); ctx.stroke(dots[k]); });
    ctx.restore();
  }

  // Where your transports will dock to take units on board or land them: a dashed berth the size of
  // the ship with an anchor, a dashed line to it while the ship is on its way, and a gangway to the
  // shore point (light blue: units gather there to come on board; green: they land there).
  drawDocks() {
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    if (!g.docks || !g.docks.size) return;
    ctx.save();
    for (const [id, d] of g.docks) {
      const u = g.unitById.get(id);
      if (!u) continue;
      const [bx, by] = this.w2s(d.x, d.y);
      const [lx, ly] = this.w2s(d.lx, d.ly);
      const [sx, sy] = this.w2s(u.dx, u.dy);
      if (!this.onScreen(bx, by, 80) && !this.onScreen(sx, sy, 80)) continue;
      const rpx = Math.max(4, UNITS[UNIT_TYPES[u.t]].size * z);
      const tint = d.load ? '150,228,255' : '140,232,130';
      const away = Math.hypot(u.x - d.x, u.y - d.y) > 8;
      // Gangway and shore point.
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(${tint},0.8)`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(lx, ly); ctx.stroke();
      ctx.fillStyle = `rgba(${tint},0.9)`;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (!away) continue;
      // On its way: the line to the berth, and the berth itself.
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = `rgba(${tint},0.6)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = `rgba(${tint},0.14)`;
      ctx.strokeStyle = `rgba(${tint},0.95)`;
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.ellipse(bx, by, rpx * 1.5 + 3, rpx * 0.7 + 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const r = Math.max(5, rpx * 0.45);
      ctx.drawImage(anchorBadge(), bx - r, by - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  // Edit map, beach brush on: the brush under the cursor (teal: paints beaches; red: erases them).
  drawBeachBrush() {
    const g = this.g, inp = g.input;
    if (!g.mapEdit || !g.beachBrush || !inp || !inp.mouse.inside) return;
    const ctx = this.ctx, r = inp.brushRadius() * g.cam.zoom;
    const tint = g.beachBrush === 'add' ? '112,200,210' : '230,90,70';
    ctx.save();
    ctx.fillStyle = `rgba(${tint},${inp.brush ? 0.3 : 0.15})`;
    ctx.strokeStyle = `rgba(${tint},0.95)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(inp.mouse.x, inp.mouse.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Unload targeting (U): dashed lines from the selected transports with units on board to the cursor.
  drawUnloadAim() {
    const g = this.g, inp = g.input;
    if (!inp || inp.targetMode !== 'unload' || !inp.mouse.inside) return;
    const ctx = this.ctx, { x, y } = inp.mouse;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,228,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    for (const id of g.selectedTransports(true)) {
      const u = g.unitById.get(id);
      const [sx, sy] = this.w2s(u.dx, u.dy);
      ctx.moveTo(sx, sy); ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y, 11, 6, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
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

    this.drawRegionBursts(now);
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
    // A region you just took whole lights up here too, in case it is off screen.
    if (g.effects.regions.length) {
      ctx.setTransform(s * dpr, 0, 0, s * dpr, -b.x0 * s * dpr, -b.y0 * s * dpr);
      ctx.lineJoin = 'round';
      for (const e of g.effects.regions) {
        const st = this.regionGlow(e, now);
        if (!st) continue;
        const pulse = 0.75 + 0.25 * Math.cos(st.t * Math.PI * 6);
        ctx.fillStyle = `rgba(255,222,120,${(0.55 * st.fade * pulse).toFixed(3)})`;
        this.fillRegion(ctx, e.region);
        ctx.strokeStyle = `rgba(255,236,160,${st.fade.toFixed(3)})`;
        ctx.lineWidth = 1.6 / s;
        ctx.stroke(this.regionOutline[e.region]);
      }
    }
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
