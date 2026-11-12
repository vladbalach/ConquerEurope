// Canvas renderer: cached map layer (sea, land, territories, mountains, borders, labels),
// then ports, cities, units, ships and effects on top every frame. Also draws the minimap.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, PRODUCTION_ITEMS, ECONOMY, HERO, HEALER } from '/shared/config.js';
import { unitSprite, castleSprite, anchorBadge, CONE, CASTLE_ANCHOR, mix } from './sprites.js';
import { regionIndex, regionLabelSizes, placeLabels, regionOutlines } from './map-labels.js';
import { forEachCoastPiece } from '/shared/coastline.js';
import { buildMountains, paintMountains } from './mountains.js';
import { CARGO_SHIFT } from '/shared/protocol.js';

export const SEA = '#1f3d58';
const LAND = '#dccfa8';
const LAND_DIM = '#a9a088';
const TERRITORY_ALPHA = 0.5;
const INK = '#1c130b';
const GHOST = '#8e8e8e';                 // the grey of the units in a move's preview (drawFormation)
// Beaches (ships take units on board and land them there): shallow water off the shore, and sand.
const SHALLOWS = 'rgba(112,178,190,0.55)';
const BEACH = 'rgb(226,200,130)';
const BEACH_EDGE = 'rgba(90,64,28,0.7)';
// Cliffs (no ship takes units on board or lands them there), seen from above: the land ends in the dark
// line of the cliff top, and below it the rock face drops to the sea, lit where it faces the top left
// (ICON_STYLE.md, as the mountains are) and in shade where it faces away, ragged at its foot, with surf
// along the foot and a shadow on the water. About as wide as the beaches' shallows.
const CLIFF = {
  tones: ['#5d4d3b', '#786450', '#958067', '#b5a07f', '#d2c29e'],   // the rock face, from in shade to lit
  low: 'rgba(28,18,8,0.3)',              // the lower half of the face, darker toward the sea
  foam: 'rgba(228,238,240,0.75)',
  shadow: 'rgba(4,12,22,0.45)',
};
const PLAN_COLORS = ['#9dff6a', '#ff9a3c', '#ff4a3a'];   // queued orders: move, attack-move, attack (as the click markers)

// Below this zoom the map is the strategic view: small coloured city markers,
// no castles, upgrades, city names or country names.
const FAR_ZOOM = 0.42;
// Country names are printed on the map like terrain: their size is in world units,
// so they scale with the map and stay in the same place. Bigger countries get bigger letters.
// They are kept off the cities as the cities look at labelZoom, just after the names fade in:
// zoomed in further, castles and city names take less of the map (see map-labels.js).
// outline: the white border round the letters, in parts of the font size (between 1 and 3.5 px), as opaque
// as outlineAlpha times the letters.
const COUNTRY_LABEL = { alpha: 0.55, outline: 0.06, outlineAlpha: 0.5, spacing: 0.18, labelZoom: 0.5 };
// You take the last city of a region (client.regionChanged): for `ms` the region lights up in
// gold. A wave of light spreads over it from the city just taken in the first `spread` of that
// time, its outline lights up behind the wave, and each city it reaches bursts with a gold ring
// and shows the gold it now pays more ("+2/turn"). Its name shines in gold for the first half.
export const REGION_GLOW = { ms: 4200, spread: 0.35 };
// Hovering the Region stat in the city panel lights its region up (g.hoverRegion), in ms: it fades
// in for `in` and out for `out`. As it appears, a wave of light carries it from the city in the panel
// to the region's edge in `spread`, the borders flash as it passes, and a ring of light spreads on
// the ground round each city of the region for `ring` once the wave reaches it.
const REGION_HOVER = { in: 180, out: 300, spread: 480, ring: 700 };
// Pings on the minimap (client.js): for `ms` a ring goes out from the place every `every` ms, `waves`
// times, and a frame blinks around it. `lost`: one of your cities captured, in red. `battle`: your units
// or a city of yours under attack where you aren't looking (alerts.js), in orange.
export const PINGS = {
  lost: { ms: 7000, every: 1100, waves: 4, color: '#ff4a3a' },
  battle: { ms: 4500, every: 1100, waves: 3, color: '#ffa53a' },
};
// The minimap: players resize it by dragging its top-right corner (input.js), and the browser keeps
// that width for their next games (`key`). Never narrower than `min` CSS px; never wider than
// `maxShare` of the screen, nor so tall that less than `topRoom` px is left above it (the top bar
// and the first lines of the feed).
const MINI = { min: 80, maxShare: 0.45, topRoom: 190, key: 'coe.minimapWidth' };
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

// The minimap width the player chose, or null for the default (private mode: no storage, the default).
function loadMiniWidth() {
  try {
    const w = Number(localStorage.getItem(MINI.key));
    return w > 0 ? w : null;
  } catch { return null; }
}

function saveMiniWidth(w) {
  try {
    if (w == null) localStorage.removeItem(MINI.key);
    else localStorage.setItem(MINI.key, String(Math.round(w)));
  } catch { /* private mode: kept for this page only */ }
}

// The lines of the map: coastlines, region borders and the borders between cities of one region.
// A ring edge that another landmass shares is a land border, not coast. Land borders
// are drawn from map.segs only, where they divide two cities ([x0, y0, x1, y1, kind], kind 1 =
// region border). `isBeach(x, y)`: the coast there is a beach (ships take units on board and land
// them there). The coast is walked in short pieces as the game's host walks it (shared/coastline.js);
// beach pieces go to `beach`, the rest of the sea's coast to `cliff`, also kept as `cliffRuns` to set
// the rocks along (cliffRocks). Without `isBeach`, and round lakes, the coast is `coast`: a plain line.
export function mapLines(map, isBeach = null) {
  const coast = new Path2D(), beach = new Path2D(), cliff = new Path2D();
  const cliffRuns = [];             // { pts: [x, y, ...], cum: distance along it at each point, land, bbox }
  let open = null, run = null;      // the path the current stretch of coast is drawn on; its cliff run
  forEachCoastPiece(map, (ax, ay, bx, by, first, land, hole) => {
    const path = !isBeach ? coast : isBeach((ax + bx) / 2, (ay + by) / 2) ? beach : hole ? coast : cliff;
    if (first || open !== path) { path.moveTo(ax, ay); open = path; run = null; }
    path.lineTo(bx, by);
    if (path !== cliff) return;
    if (!run) cliffRuns.push(run = { pts: [ax, ay], cum: [0], land, x0: ax, y0: ay, x1: ax, y1: ay });
    run.pts.push(bx, by);
    run.cum.push(run.cum[run.cum.length - 1] + Math.hypot(bx - ax, by - ay));
    run.x0 = Math.min(run.x0, bx); run.x1 = Math.max(run.x1, bx);
    run.y0 = Math.min(run.y0, by); run.y1 = Math.max(run.y1, by);
  });
  const regions = new Path2D(), cities = new Path2D();
  const s = map.segs;
  for (let i = 0; i < s.length; i += 5) {
    const path = s[i + 4] ? regions : cities;
    path.moveTo(s[i], s[i + 1]);
    path.lineTo(s[i + 2], s[i + 3]);
  }
  return { coast, beach, cliff, cliffRuns, regions, cities };
}

// A number in [0, 1) for two integers: the same every time, so the cliffs never change shape.
function hash2(a, b) {
  let v = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

// The rock faces of the cliffs (mapLines' cliffRuns) in `view` at zoom z, in world units: the whole face
// (`base`), its pieces by how lit they are (`tones`, as CLIFF.tones), its lower half (`low`) and its foot
// out at sea (`foot`). The face reaches from just inland (the land is painted over it) out to sea, 6.5 to
// 12 px on screen at any zoom; how far varies along the cliff (smooth noise with bumps about 9 px apart on
// screen, from points fixed along the cliff, two sizes blended by zoom, so zooming neither slides nor jumps
// them) and it narrows where a cliff meets a beach. Each piece's light: the way it faces against the top left, and some
// noise so the face reads as rock.
function cliffFaces(runs, z, view) {
  const W = clamp(4.5 + 1.5 * z, 6.5, 12) / z, step = 2 / z, inland = 1 / z;
  const lam = Math.log2(9 / z), gap = 2 ** Math.ceil(lam), fine = Math.ceil(lam) - lam;
  const pad = W * 2;
  const base = new Path2D(), low = new Path2D(), foot = new Path2D(), tones = CLIFF.tones.map(() => new Path2D());
  runs.forEach((run, ri) => {
    if (run.x1 < view.x0 - pad || run.x0 > view.x1 + pad || run.y1 < view.y0 - pad || run.y0 > view.y1 + pad) return;
    const { pts, cum, land } = run, total = cum[cum.length - 1], last = cum.length - 1;
    // Value noise along the cliff: a value every `g` km from its start, eased between.
    const noise = (d, g, salt) => {
      const k = Math.floor(d / g), u = d / g - k, e = u * u * (3 - 2 * u);
      const a = hash2(Math.round(k * g * 8), ri * 4 + salt), b = hash2(Math.round((k + 1) * g * 8), ri * 4 + salt);
      return a + (b - a) * e;
    };
    const blend = (d, salt) => noise(d, gap, salt) * (1 - fine) + noise(d, gap / 2, salt) * fine;
    const closed = Math.hypot(pts[0] - pts[2 * last], pts[1] - pts[2 * last + 1]) < 1e-6;   // all round an islet
    const taper = Math.min(total / 2, W * 2);
    // Out to sea from the piece k of the cliff.
    const normal = (k) => {
      const l = cum[k + 1] - cum[k] || 1;
      return [land * (pts[2 * k + 3] - pts[2 * k + 1]) / l, -land * (pts[2 * k + 2] - pts[2 * k]) / l];
    };
    // Points along the coast, every corner and at most `step` apart: where they are, the way out to sea
    // (at a corner between its two pieces), how far along the cliff, and the inner and outer edge of the face.
    const S = [];
    const add = (x, y, nx, ny, d) => {
      const n = blend(d, 0);
      let t = closed ? 1 : Math.min(1, d / taper, (total - d) / taper);
      t = t * t * (3 - 2 * t);
      const w = W * (0.55 + 0.6 * n) * (0.3 + 0.7 * t);
      S.push({
        nx, ny, d, ix: x - nx * inland, iy: y - ny * inland, ox: x + nx * w, oy: y + ny * w,
        mx: x + nx * w * 0.5, my: y + ny * w * 0.5,
      });
    };
    for (let k = 0; k < last; k++) {
      const [nx, ny] = normal(k);
      const parts = Math.max(1, Math.ceil((cum[k + 1] - cum[k]) / step));
      for (let p = 0; p < parts; p++) {
        let mx = nx, my = ny;
        if (p === 0 && k > 0) {
          const [px, py] = normal(k - 1), m = Math.hypot(mx + px, my + py) || 1;
          mx = (mx + px) / m; my = (my + py) / m;
        }
        const t = p / parts;
        add(pts[2 * k] + (pts[2 * k + 2] - pts[2 * k]) * t, pts[2 * k + 1] + (pts[2 * k + 3] - pts[2 * k + 1]) * t,
          mx, my, cum[k] + (cum[k + 1] - cum[k]) * t);
      }
      if (k === last - 1) add(pts[2 * last], pts[2 * last + 1], nx, ny, total);
    }
    base.moveTo(S[0].ix, S[0].iy);
    for (const s of S) base.lineTo(s.ix, s.iy);
    for (let i = S.length - 1; i >= 0; i--) base.lineTo(S[i].ox, S[i].oy);
    base.closePath();
    low.moveTo(S[0].mx, S[0].my);
    for (const s of S) low.lineTo(s.mx, s.my);
    for (let i = S.length - 1; i >= 0; i--) low.lineTo(S[i].ox, S[i].oy);
    low.closePath();
    foot.moveTo(S[0].ox, S[0].oy);
    for (const s of S) foot.lineTo(s.ox, s.oy);
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], b = S[i + 1];
      const nx = a.nx + b.nx, ny = a.ny + b.ny, m = Math.hypot(nx, ny) || 1;
      const lit = -(nx + ny) / (m * Math.SQRT2) + (blend((a.d + b.d) / 2, 1) - 0.5) * 0.9;
      const tone = clamp(Math.round((lit + 1) * 2), 0, 4);
      if (tone === 2) continue;                                // the base's own colour
      const q = tones[tone];
      q.moveTo(a.ix, a.iy); q.lineTo(b.ix, b.iy); q.lineTo(b.ox, b.oy); q.lineTo(a.ox, a.oy); q.closePath();
    }
  });
  return { base, tones, low, foot };
}

export class Renderer {
  constructor(game, canvas, minimap) {
    this.g = game;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.miniWrap = minimap.parentElement;
    this.miniWrap.onanimationend = () => this.miniWrap.classList.remove('alert');
    this.miniPref = loadMiniWidth();  // the width the player gave the minimap, or null: the default
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
    this.mountains = buildMountains(map);
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

  // The map's mountains changed (an admin painted some on or off): draw them anew, here and on the minimap.
  mountainsChanged() {
    this.mountains = buildMountains(this.g.map);
    this.mapKey = '';
    this.miniVersion = -1;
  }

  // Country names: just above the middle of their cities, or the nearest spot in the country
  // where they cover no city and no other name. Again after a city moves. A name an admin placed in
  // Edit map (map.labelEdits: its centre and its scale) stays where they put it, and the others keep off it.
  placeCountryLabels(map) {
    const L = COUNTRY_LABEL, Z = L.labelZoom;
    const m = this.measureCtx || (this.measureCtx = document.createElement('canvas').getContext('2d'));
    const spacing = 'letterSpacing' in this.ctx ? L.spacing : 0;
    m.font = LABEL_FONT(100);
    const edits = map.labelEdits || {};
    const labels = map.countries.map((co, i) => {
      const e = edits[co.n];
      const fixed = !!e && Number.isFinite(e.x) && Number.isFinite(e.y);
      const size = this.labelSizes[i] * (fixed && e.scale > 0 ? e.scale : 1);
      const text = co.n.toUpperCase();
      return {
        region: i, text, size, fixed,
        x: fixed ? e.x : co.x,
        y: fixed ? e.y : co.y - size * 0.8,
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

  // Edit map: the region whose name is under (sx, sy) on screen, or -1. Names are printed (and can be
  // picked) only zoomed in past the strategic view.
  pickCountryLabel(sx, sy) {
    if (this.farView() || !this.countryLabels) return -1;
    const z = this.g.cam.zoom;
    for (const l of this.countryLabels) {
      const [x, y] = this.w2s(l.x, l.y);
      if (Math.abs(sx - x) <= (l.w / 2) * z && Math.abs(sy - y) <= (l.h / 2) * z) return l.region;
    }
    return -1;
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
    this.sizeMinimap();
  }

  // ---------------------------------------------------------------- minimap size
  // The minimap's width on this screen when the player hasn't chosen one: a sixth of the screen,
  // within 140–230 px, and 60% of that on a narrow screen (≤ 900 px, as in style.css).
  miniDefaultWidth() {
    const w = clamp(this.W * 0.16, 140, 230);
    return this.W <= 900 ? Math.round(w * 0.6) : w;
  }

  // The minimap's size: the width the player gave it, or the default, within what this screen leaves
  // room for (MINI). Its height follows the map. Also after the window is resized.
  sizeMinimap() {
    const b = this.g.map.bounds, ratio = (b.y1 - b.y0) / (b.x1 - b.x0), dpr = this.dpr;
    const max = Math.max(MINI.min, Math.min(this.W * MINI.maxShare, (this.H - MINI.topRoom) / ratio));
    const mw = Math.round(clamp(this.miniPref ?? this.miniDefaultWidth(), MINI.min, max));
    const mh = mw * ratio;
    const pw = Math.round(mw * dpr), ph = Math.round(mh * dpr);
    if (mw === this.miniW && pw === this.mini.width && ph === this.mini.height) return;
    this.miniW = mw; this.miniH = mh;
    this.mini.style.width = `${mw}px`;
    this.mini.style.height = `${mh}px`;
    this.mini.width = pw;
    this.mini.height = ph;
    this.miniBase.width = pw;
    this.miniBase.height = ph;
    this.miniVersion = -1;
    this.miniTime = -Infinity;          // the canvas is blank now: paint the map under it this frame
    // The panel at the bottom keeps clear of it (style.css, .panel). Its frame: padding and border.
    const root = document.documentElement.style;
    root.setProperty('--minimap-w', `${this.miniWrap.offsetWidth || mw + 10}px`);
    root.setProperty('--minimap-h', `${this.miniWrap.offsetHeight || Math.round(mh) + 10}px`);
  }

  // Dragging the minimap's corner (input.js): `w` CSS px wide, as far as the screen allows.
  setMiniWidth(w) {
    this.miniPref = w;
    this.sizeMinimap();
  }

  // The drag is over: the browser keeps the width it ended at for the next games.
  keepMiniWidth() {
    this.miniPref = this.miniW;
    saveMiniWidth(this.miniW);
  }

  // Double click on the corner: back to the default width for this screen.
  resetMiniWidth() {
    this.miniPref = null;
    saveMiniWidth(null);
    this.sizeMinimap();
  }

  // The minimap's frame glows a few times (style.css) to catch the eye while a ping goes out on it
  // (drawPing): red for one of your cities captured, orange (`battle`) for an attack.
  alertMinimap(kind = 'lost') {
    const wrap = this.miniWrap, cls = kind === 'battle' ? 'alert-battle' : 'alert';
    wrap.classList.remove('alert', 'alert-battle');
    void wrap.offsetWidth;              // restarts the animation when it is already running
    wrap.classList.add(cls);
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
  // Would the player see a fight at (x, y)? On screen, with the page in front and the map closer than the
  // strategic view (where units are dots and a battle goes unnoticed). Attack alerts skip those (alerts.js).
  seesFight(x, y) {
    if (document.hidden || this.farView()) return false;
    const v = this.viewRect();
    return x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1;
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

  // Draws land, territory tint and borders in world coordinates. `owners` and `colorOf`: city owners
  // and player colours to paint instead of the current ones (the results screen's Timeline).
  paintMap(ctx, z, alpha, detailed, owners = this.g.cityOwner, colorOf = (o) => this.g.colorOf(o)) {
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
      // Cliffs: the rock face down to the sea, under the land (as the shallows): its shadow on the
      // water (cast to the bottom right), the face, darker low down, and the surf along its foot.
      if (this.lines.cliffRuns.length) {
        const face = cliffFaces(this.lines.cliffRuns, z, this.viewRect());
        ctx.save();
        ctx.translate(1 / z, 1.4 / z);
        ctx.strokeStyle = CLIFF.shadow;
        ctx.lineWidth = 2.6 / z;
        ctx.stroke(face.foot);
        ctx.restore();
        ctx.fillStyle = CLIFF.tones[2];
        ctx.fill(face.base);
        face.tones.forEach((path, k) => {
          if (k === 2) return;
          ctx.fillStyle = CLIFF.tones[k];
          ctx.fill(path);
        });
        ctx.fillStyle = CLIFF.low;
        ctx.fill(face.low);
        ctx.strokeStyle = CLIFF.foam;
        ctx.lineWidth = 0.9 / z;
        ctx.stroke(face.foot);
      }
    }
    ctx.fillStyle = LAND_DIM;
    ctx.fill(this.landDim, 'evenodd');
    ctx.fillStyle = LAND;
    ctx.fill(this.landActive, 'evenodd');

    ctx.globalAlpha = alpha;
    for (let i = 0; i < this.cityPaths.length; i++) {
      const p = this.cityPaths[i];
      const o = owners[i];
      if (!p || o < 0) continue;
      ctx.fillStyle = colorOf(o);
      ctx.fill(p, 'evenodd');
    }
    for (const m of this.multi) {
      if (!m.cells.some((cell) => owners[cell.city] >= 0)) continue;
      ctx.save();
      ctx.clip(m.clip, 'evenodd');
      for (const cell of m.cells) {
        const o = owners[cell.city];
        if (o < 0) continue;
        ctx.fillStyle = colorOf(o);
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

    // Mountains, which no unit crosses: solid, over the territories and their borders (neither shows
    // through), under the coastline. Close up (the main map) with their hill signs, elsewhere only their land.
    if (this.mountains) {
      paintMountains(ctx, this.mountains, z, detailed ? this.viewRect() : null);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
    }
    // Beaches, where ships take units on board and land them: the shallows above, then a thin strip of
    // sand on the shoreline. The rest of the coast is cliffs: their rock face above, and the dark line of
    // the cliff top (on the minimap and the timeline only the line).
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
    ctx.stroke(lines.cliff);
    ctx.lineCap = 'butt';
  }

  // Country names, dark brown with a white border round the letters, fixed to the map: their size and place are in world units,
  // so they zoom with the land. Hidden in the strategic view, with a short fade in after it.
  // Zoomed far in the letters grow huge, so they also get lighter.
  paintCountryLabels(ctx) {
    const z = this.g.cam.zoom;
    const fade = clamp((z - FAR_ZOOM) / 0.1, 0, 1) * (1 - 0.45 * clamp((z - 1.2) / 1.8, 0, 1));
    if (fade <= 0) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(70,45,22,${COUNTRY_LABEL.alpha * fade})`;
    ctx.strokeStyle = `rgba(255,255,255,${COUNTRY_LABEL.alpha * COUNTRY_LABEL.outlineAlpha * fade})`;
    ctx.lineJoin = 'round';
    const spacing = 'letterSpacing' in ctx;
    for (const l of this.countryLabels) {
      const fs = l.size * z;
      const [sx, sy] = this.w2s(l.x, l.y);
      const half = (l.w / 2) * z;
      if (sx + half < 0 || sx - half > this.W || sy + fs < 0 || sy - fs > this.H) continue;
      ctx.font = LABEL_FONT(fs.toFixed(1));
      if (spacing) ctx.letterSpacing = `${(fs * COUNTRY_LABEL.spacing).toFixed(1)}px`;
      ctx.lineWidth = clamp(fs * COUNTRY_LABEL.outline, 1, 3.5);
      ctx.strokeText(l.text, sx, sy);
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

  // ---------------------------------------------------------------- region hovered in the city panel
  // Brings the lit regions up and down, once a frame: the one whose Region stat the mouse is on
  // (g.hoverRegion) fades in, any other fades out and is dropped. One that comes back while still
  // fading out just fades in again, without a second wave.
  updateRegionHovers(now) {
    const g = this.g, want = g.hoverRegion;
    const dt = clamp(now - (this.hoverAt ?? now), 0, 100);
    this.hoverAt = now;
    const list = this.hovers ?? [];
    if (want >= 0 && this.regionLand[want] && !list.some((h) => h.region === want)) {
      // The wave starts from the city in the panel; it reaches a band beyond the region's farthest point.
      const o = g.map.cities[g.hoverCity] ?? g.map.cities[g.regionCities[want][0]];
      const s = this.regionEdges[want];
      let far = 0;
      for (let i = 0; i < s.length; i += 2) far = Math.max(far, Math.hypot(s[i] - o.x, s[i + 1] - o.y));
      const band = clamp(far * 0.25, 25, 110);
      list.push({ region: want, x: o.x, y: o.y, t0: now, a: 0, band, reach: far + band });
    }
    for (const h of list) {
      h.a = h.region === want ? Math.min(1, h.a + dt / REGION_HOVER.in) : Math.max(0, h.a - dt / REGION_HOVER.out);
    }
    this.hovers = list.filter((h) => h.a > 0 || h.region === want);
  }

  // Where a lit region is at `now`. e: its brightness (the fade, smoothed); p: 0..1 through the wave,
  // f: the same eased out (fast, then settling); front: how far the wave has come from the city, in
  // world units; pulse: a slow breath once the wave is over (1 when it starts, so nothing jumps).
  regionHoverState(h, now) {
    const p = clamp((now - h.t0) / REGION_HOVER.spread, 0, 1);
    const f = 1 - (1 - p) ** 3;
    const since = Math.max(0, now - h.t0 - REGION_HOVER.spread);
    return {
      e: h.a * h.a * (3 - 2 * h.a), p, f, front: h.reach * f,
      pulse: 1 - 0.14 * (0.5 - 0.5 * Math.cos(since / 380)),
    };
  }

  // The lit regions, under the cities and units: the land washed in light and the outline traced in
  // gold. While the wave spreads, the wash follows a bright crest out of the city, the outline lights
  // up as far as it has come and flashes where the crest crosses it.
  drawRegionHover(now) {
    this.updateRegionHovers(now);
    if (!this.hovers.length) return;
    const g = this.g, ctx = this.ctx, c = g.cam, z = c.zoom, dpr = this.dpr;
    const rgba = (rgb, a) => `rgba(${rgb},${a.toFixed(3)})`;
    ctx.save();
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.W / 2 - c.x * z) * dpr, (this.H / 2 - c.y * z) * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const h of this.hovers) {
      const s = this.regionHoverState(h, now);
      if (s.e <= 0) continue;
      const spreading = s.p < 1;
      const wash = rgba('255,244,205', 0.32 * s.e * s.pulse);
      if (spreading) {
        const R = s.front + h.band * 0.5;
        const grad = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, R);
        grad.addColorStop(0, wash);
        grad.addColorStop(Math.max(0, (s.front - h.band) / R), wash);
        grad.addColorStop(s.front / R, rgba('255,250,228', 0.6 * s.e));
        grad.addColorStop(1, 'rgba(255,250,228,0)');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = wash;
      }
      this.fillRegion(ctx, h.region);

      const outline = this.regionOutline[h.region];
      ctx.save();
      if (spreading) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, s.front, 0, Math.PI * 2);
        ctx.clip();
      }
      // The soft glow starts wide and draws in as the wave settles.
      ctx.strokeStyle = rgba('150,105,25', 0.45 * s.e * s.pulse);
      ctx.lineWidth = (7 + 9 * (1 - s.f)) / z;
      ctx.stroke(outline);
      ctx.strokeStyle = rgba('255,226,130', 0.95 * s.e);
      ctx.lineWidth = 2.2 / z;
      ctx.stroke(outline);
      ctx.restore();
      // The flash on the borders: a ring just behind the crest.
      if (spreading) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(h.x, h.y, s.front, 0, Math.PI * 2);
        ctx.arc(h.x, h.y, Math.max(0, s.front - h.band * 0.7), 0, Math.PI * 2, true);
        ctx.clip();
        ctx.strokeStyle = rgba('255,250,225', 0.9 * s.e * (1 - s.p * 0.6));
        ctx.lineWidth = 4.5 / z;
        ctx.stroke(outline);
        ctx.restore();
      }
    }
    ctx.restore();
    this.drawRegionHoverRings(now);
  }

  // Round each city of a lit region, as the wave reaches it, a ring of light spreads on the ground
  // and fades (under the castles: drawn before them). The city in the panel rings at once.
  drawRegionHoverRings(now) {
    const g = this.g, ctx = this.ctx;
    const far = this.farView(), size = this.citySize(), mr = this.markerRadius();
    for (const h of this.hovers) {
      const s = this.regionHoverState(h, now);
      if (s.e <= 0 || now - h.t0 > REGION_HOVER.spread + REGION_HOVER.ring) continue;
      for (const ci of g.regionCities[h.region]) {
        const c = g.map.cities[ci];
        // When the crest reaches the city: f = d / reach, so p = 1 - cbrt(1 - d / reach).
        const d = Math.min(1, Math.hypot(c.x - h.x, c.y - h.y) / h.reach);
        const k = now - h.t0 - (1 - Math.cbrt(1 - d)) * REGION_HOVER.spread;
        if (k < 0 || k >= REGION_HOVER.ring) continue;
        const [sx, sy] = this.w2s(c.x, c.y);
        if (!this.onScreen(sx, sy, 80)) continue;
        const u = k / REGION_HOVER.ring, grow = 1 - (1 - u) ** 3, a = (1 - u) ** 1.5 * s.e;
        const ring = () => {
          ctx.beginPath();
          if (far) ctx.arc(sx, sy, mr + 3 + grow * 16, 0, Math.PI * 2);
          else {
            const rx = size * (0.45 + 0.75 * grow);
            ctx.ellipse(sx, sy + size * 0.05, rx, rx * 0.37, 0, 0, Math.PI * 2);
          }
          ctx.stroke();
        };
        ctx.strokeStyle = `rgba(214,160,40,${(0.85 * a).toFixed(3)})`;
        ctx.lineWidth = 3 * (1 - u) + 1;
        ring();
        ctx.strokeStyle = `rgba(255,248,215,${(0.95 * a).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ring();
      }
    }
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

  // Where a region's name is on screen, to light it up over its faint name on the map (or where that
  // would be, in the strategic view): font size fs (at least 16 px, to be read zoomed out), centre
  // (sx, sy), half its width. Null when it is off screen.
  regionLabelAt(region) {
    const l = this.countryLabels[region];
    if (!l) return null;
    const fs = Math.max(16, l.size * this.g.cam.zoom);
    const [sx, sy] = this.w2s(l.x, l.y);
    const half = (l.w / 2) * fs / l.size;
    if (sx + half < 0 || sx - half > this.W || sy + fs < 0 || sy - fs > this.H) return null;
    return { text: l.text, fs, sx, sy, half };
  }

  // The font of a lit region name, as the map prints it: centred, letters spaced out.
  setRegionLabelFont(ctx, fs) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = LABEL_FONT(fs.toFixed(1));
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(fs * COUNTRY_LABEL.spacing).toFixed(1)}px`;
    ctx.lineJoin = 'round';
  }

  // The gold name lasts half as long as the glow (REGION_GLOW.ms / 2).
  drawRegionName(region, s) {
    const t = s.t * 2;
    if (t >= 1) return;
    const at = this.regionLabelAt(region);
    if (!at) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.35);
    this.setRegionLabelFont(ctx, at.fs);
    ctx.lineWidth = Math.max(3, at.fs * 0.12);
    ctx.strokeStyle = 'rgba(40,24,8,0.8)';
    ctx.strokeText(at.text, at.sx, at.sy);
    ctx.fillStyle = '#ffd75e';
    ctx.fillText(at.text, at.sx, at.sy);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();
  }

  // The names of the regions lit from the city panel, over everything else: gold on a dark edge, in a
  // warm glow, fading with the region. As it appears the name grows to its size with a slight
  // overshoot, and a gleam runs once across its letters.
  drawRegionHoverNames(now) {
    if (!this.hovers?.length) return;
    const ctx = this.ctx;
    for (const h of this.hovers) {
      const e = this.regionHoverState(h, now).e;
      if (e <= 0) continue;
      const at = this.regionLabelAt(h.region);
      if (!at) continue;
      const k = now - h.t0;
      const x = clamp(k / 320, 0, 1) - 1;                   // ease out with overshoot ("back")
      const scale = 0.88 + 0.12 * (1 + 2.70158 * x ** 3 + 1.70158 * x ** 2);
      ctx.save();
      ctx.globalAlpha = e;
      ctx.translate(at.sx, at.sy);
      ctx.scale(scale, scale);
      this.setRegionLabelFont(ctx, at.fs);
      ctx.shadowColor = 'rgba(255,190,60,0.8)';
      ctx.shadowBlur = Math.max(6, at.fs * 0.45);
      ctx.lineWidth = Math.max(3, at.fs * 0.12);
      ctx.strokeStyle = 'rgba(40,24,8,0.85)';
      ctx.strokeText(at.text, 0, 0);
      ctx.shadowColor = 'transparent';
      const q = (k - 140) / 700;                           // the gleam: 0..1 across, once
      if (q > 0 && q < 1) {
        const c = -0.25 + 1.5 * q, w = 0.16;
        const grad = ctx.createLinearGradient(-at.half, 0, at.half, 0);
        grad.addColorStop(0, '#ffd75e');
        grad.addColorStop(clamp(c - w, 0, 1), '#ffd75e');
        grad.addColorStop(clamp(c, 0, 1), '#fffbea');
        grad.addColorStop(clamp(c + w, 0, 1), '#ffd75e');
        grad.addColorStop(1, '#ffd75e');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = '#ffd75e';
      }
      ctx.fillText(at.text, 0, 0);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.restore();
    }
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
    this.drawRegionHover(now);     // sets its own transform for the land; the city rings are in screen px
    this.drawRally();
    if (this.g.input && this.g.input.showRanges) this.drawCityRanges();
    this.drawPorts();
    this.drawCities(now);
    this.drawPlans();
    this.drawDocks();
    this.drawGuideUnits(now);
    this.drawUnits(now);
    this.drawFormation();
    this.drawUnloadAim();
    this.drawBrush();
    this.drawLabelFrame();
    this.drawEffects(now);
    this.drawGuideMark(now);
    this.drawSelectionBox();
    this.drawRegionHoverNames(now);   // over everything
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

  // The guide at the start of a game (client.js guideMarkCity), first game of the session: where to
  // click. Rings spread from the city and an arrow bobs over it: gold over your city to click (step 1),
  // red over the grey city to storm (step 2).
  drawGuideMark(now) {
    const g = this.g, ci = g.guideMarkCity();
    if (ci < 0) return;
    const c = g.map.cities[ci];
    const [sx, sy] = this.w2s(c.x, c.y);
    if (!this.onScreen(sx, sy, 80)) return;
    const ctx = this.ctx, far = this.farView(), size = this.citySize(), mr = this.markerRadius();
    const rgb = g.guideStep === 2 ? '255,96,64' : '255,214,110';
    ctx.save();
    const r0 = far ? mr + 5 : size * 0.42;
    for (let k = 0; k < 2; k++) {                  // two rings, one after the other
      const t = (now / 1400 + k / 2) % 1;
      ctx.strokeStyle = `rgba(${rgb},${(0.9 * (1 - t)).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, sy, r0 + t * 24, 0, Math.PI * 2); ctx.stroke();
    }
    // The arrow, its tip just over the city (and its HP bar).
    const top = far ? sy - mr - 9 : sy - CASTLE_ANCHOR.y * (size / 64) - 8;
    const y = top - 7 * (0.5 + 0.5 * Math.sin(now / 170));
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(sx - 11, y - 13); ctx.lineTo(sx - 4.5, y - 13); ctx.lineTo(sx - 4.5, y - 27);
    ctx.lineTo(sx + 4.5, y - 27); ctx.lineTo(sx + 4.5, y - 13); ctx.lineTo(sx + 11, y - 13);
    ctx.closePath();
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // The guide's step 2 (client.js guideUnitsToSelect), first game of the session: your units to select,
  // each in a pulsing gold ring at its feet, under the unit, until you select some.
  drawGuideUnits(now) {
    const list = this.g.guideUnitsToSelect();
    if (!list.length) return;
    const ctx = this.ctx, z = this.g.cam.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.save();
    for (const u of list) {
      const rpx = UNITS[UNIT_TYPES[u.t]].size * z;
      const [sx, sy] = this.w2s(u.dx, u.dy);
      if (!this.onScreen(sx, sy, 40)) continue;
      // Big enough to see at the zoom a game opens at, where a new unit stands on its city's castle.
      const rx = Math.max(14, rpx * 1.7) + 4 * pulse, ry = rx * 0.55;
      ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(28,19,11,0.7)';      // a dark edge: it shows on pale land and gold territory alike
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,214,110,${(0.65 + 0.35 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.restore();
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
    const healed = this.healedUnits(list);
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
      if (boarding && def.capacity && u.owner === g.you && u.flags >> CARGO_SHIFT < def.capacity) {
        this.drawBoardGlow(sx, sy, rpx, u.id === hoverShip, now);
      }
      if (disbanding) this.drawDisbandGlow(sx, sy, rpx, u.id, now);   // under the selection ring
      if (healed.has(u)) this.drawHealGlow(sx, sy, rpx, u.id, now);    // a Healer is mending it
      if (def.healer && selected) this.drawHealRange(sx, sy);
      if (def.hero && selected) this.drawAuraRange(sx, sy);
      if (def.hero && rpx >= 2.6) this.drawHeroRing(sx, sy, rpx);

      if (selected || u.id === inspectId) {
        ctx.strokeStyle = selected ? '#9dff6a' : '#ff6a5a';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(sx, sy, rpx * 1.3 + 2, rpx * 0.65 + 1.5, 0, 0, Math.PI * 2); ctx.stroke();
      }

      if (rpx < 2.6) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.6, rpx), 0, Math.PI * 2); ctx.fill();
        if (def.hero) {                  // a Hero stays recognisable as a dot: a gold ring
          ctx.strokeStyle = '#f2cc5c';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.6, rpx) + 1.8, 0, Math.PI * 2); ctx.stroke();
        }
        continue;
      }
      if (u.flags & 8 && u.owner === g.you) this.drawHoldMark(sx, sy, rpx);
      const s = rpx / CONE.rx;
      // A Hero's kind (its mark behind the crown), a battleship's cannons (its owner has Gunnery).
      const variant = g.spriteVariant(u);
      const sprite = unitSprite(color, u.t, variant);
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
      if (def.naval && u.flags & 16 && rpx >= 4) this.drawRepair(sx, sy, s, u.id, now);
      if (u.flags >> CARGO_SHIFT) this.drawCargoCount(sx + rpx * 1.15, sy - rpx * 1.45, rpx, u.flags >> CARGO_SHIFT);

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

  // A ship under repair in harbour (unit flag 16: out of combat, below full HP and near the pier of one of its
  // owner's coastal cities, where it repairs faster: Ship.regenerate): a hammer knocking at
  // its stern, chips flying at each blow, and a saw going back and forth at its bow, shedding sawdust.
  // `s`: screen px per px of the ship's 64 px sprite, whose point CONE.cx, CONE.by is (sx, sy).
  drawRepair(sx, sy, s, id, now) {
    const ctx = this.ctx, k = Math.max(0.75, s * 1.2), ink = '#1a120a';    // the tools a little larger than life
    const at = (x, y) => [sx + (x - CONE.cx) * s, sy + (y - CONE.by) * s];
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // The hammer, held at (hx, hy): raised slowly, brought down fast.
    const ph = (now / 650 + id * 0.37) % 1, up = -0.95, down = 0.75, strike = 0.18;
    const ang = ph < strike ? up + (down - up) * (ph / strike) ** 2 : down + (up - down) * Math.min(1, (ph - strike) / 0.55);
    const [hx, hy] = at(2, 15);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    ctx.strokeStyle = ink; ctx.lineWidth = 3.2 * k;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(11 * k, 0); ctx.stroke();
    ctx.strokeStyle = '#b07a42'; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(11 * k, 0); ctx.stroke();
    ctx.fillStyle = '#c3cad2'; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, 1.1 * k);
    ctx.beginPath(); ctx.rect(10 * k, -3.8 * k, 4.4 * k, 7.6 * k); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (ph >= strike && ph < strike + 0.3) {          // chips from where it struck
      const t = (ph - strike) / 0.3, r = 12.5 * k;
      const bx = hx + Math.cos(down) * r, by = hy + Math.sin(down) * r;
      ctx.fillStyle = `rgba(222,180,118,${1 - t})`;
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.8;
        ctx.fillRect(bx + Math.cos(a) * 5 * k * t - 0.8 * k, by + Math.sin(a) * 5 * k * t + 5 * k * t * t - 0.8 * k, 1.6 * k, 1.6 * k);
      }
    }

    // The saw, slanting down into the deck at the bow, its handle up: back and forth along its blade.
    const q = Math.sin(now / 95 + id * 1.3);
    const [wx, wy] = at(55, 23);
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(-0.55);
    const cut = [-2.5 * k, 2.6 * k];                  // where its teeth bite, before it slides
    ctx.save();
    ctx.translate(q * 2.6 * k, 0);
    const blade = new Path2D();
    blade.moveTo(-9 * k, -1.2 * k); blade.lineTo(4 * k, -3 * k); blade.lineTo(4 * k, 3 * k);
    for (let i = 0, x = 4 * k; x > -9 * k; i++, x -= 1.3 * k) {
      const y = 1.2 * k + ((x + 9 * k) / (13 * k)) * 1.8 * k;
      blade.lineTo(x, y + (i % 2 ? 1 * k : 0));
    }
    blade.lineTo(-9 * k, 1.2 * k);
    blade.closePath();
    ctx.fillStyle = '#d4dae0'; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(0.8, 0.9 * k);
    ctx.fill(blade); ctx.stroke(blade);
    ctx.fillStyle = '#8a5a2b';
    ctx.beginPath(); ctx.rect(4 * k, -3.8 * k, 5.5 * k, 7.6 * k); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.ellipse(6.8 * k, 0, 1.2 * k, 2.2 * k, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Sawdust falling from the cut.
    ctx.fillStyle = 'rgba(232,206,160,0.9)';
    for (let i = 0; i < 3; i++) {
      const t = (now / 600 + i / 3 + id * 0.11) % 1;
      ctx.globalAlpha = 1 - t;
      ctx.fillRect(cut[0] + (i - 1) * 1.4 * k, cut[1] + t * 7 * k, 1.2 * k, 1.2 * k);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
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
  // attack-move, red attack. For your selected transports landing units, also the way of those units
  // once ashore: from the shore where they land, through what Shift gave them to do.
  drawPlans() {
    const g = this.g, ctx = this.ctx;
    if ((!g.plans.size && !g.landPlans.size) || !g.selection.size) return;
    const lines = PLAN_COLORS.map(() => new Path2D()), dots = PLAN_COLORS.map(() => new Path2D());
    const routes = [];                    // [start x, start y (world), points]
    for (const id of g.selection) {
      const u = g.unitById.get(id);
      if (!u) continue;
      if (g.plans.has(id)) routes.push([u.dx, u.dy, g.plans.get(id)]);
      // Your transports with a landing ahead: the way of the units on board, from the beach where they land.
      const land = g.landPlans.get(id);
      if (land) routes.push([land.from[0], land.from[1], land.points]);
    }
    for (const [x0, y0, pts] of routes) {
      let [ax, ay] = this.w2s(x0, y0);
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

  // Edit map, a brush on: the brush under the cursor (teal: paints beaches; brown: paints mountains; red:
  // erases either).
  drawBrush() {
    const g = this.g, inp = g.input;
    if (!g.mapEdit || !g.brush || !inp || !inp.mouse.inside) return;
    const ctx = this.ctx, r = inp.brushRadius() * g.cam.zoom;
    const tint = { 'beach-add': '112,200,210', 'mountain-add': '176,128,72' }[g.brush] || '230,90,70';
    ctx.save();
    ctx.fillStyle = `rgba(${tint},${inp.brush ? 0.3 : 0.15})`;
    ctx.strokeStyle = `rgba(${tint},0.95)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(inp.mouse.x, inp.mouse.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Edit map, no brush on: a dashed frame round the region name under the cursor (or being dragged), which
  // can be dragged to a new place and resized with the wheel.
  drawLabelFrame() {
    const g = this.g, inp = g.input;
    if (!g.mapEdit || g.brush || !inp || this.farView()) return;
    const region = inp.labelDrag ? inp.labelDrag.region : inp.hoverLabel;
    const l = region >= 0 && this.countryLabels ? this.countryLabels[region] : null;
    if (!l) return;
    const z = g.cam.zoom, [x, y] = this.w2s(l.x, l.y), hw = (l.w / 2) * z + 4, hh = (l.h / 2) * z + 3;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x - hw, y - hh, hw * 2, hh * 2);
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

  // The right button held with units selected (Input.formationView): a grey, see-through ghost of each unit
  // where the move will put it, and once the button is dragged, an arrow from the place clicked the way the
  // formation will face (green for a move, orange for an attack-move, as the click markers).
  drawFormation() {
    const view = this.g.input?.formationView();
    if (!view) return;
    const g = this.g, ctx = this.ctx, z = g.cam.zoom;
    ctx.save();
    ctx.globalAlpha = 0.5;
    for (const p of view.places) {
      const def = UNITS[UNIT_TYPES[p.u.t]];
      const rpx = def.size * z;
      const [sx, sy] = this.w2s(p.x, p.y);
      if (!this.onScreen(sx, sy, rpx * 4 + 10)) continue;
      if (rpx < 2.6) {
        ctx.fillStyle = GHOST;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.6, rpx), 0, Math.PI * 2); ctx.fill();
        continue;
      }
      const s = rpx / CONE.rx;
      const sprite = unitSprite(GHOST, p.u.t, def.hero ? g.heroKind(p.u) : null);
      if (def.naval && p.x < p.u.x) {               // a ship sailing left: mirrored, as drawUnits does
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(-1, 1);
        ctx.drawImage(sprite, -CONE.cx * s, -CONE.by * s, 64 * s, 64 * s);
        ctx.restore();
      } else {
        ctx.drawImage(sprite, sx - CONE.cx * s, sy - CONE.by * s, 64 * s, 64 * s);
      }
    }
    ctx.restore();
    if (view.facing === null) return;
    const [ax, ay] = this.w2s(view.x, view.y);
    const { x: bx, y: by } = view.cursor;
    const a = Math.atan2(by - ay, bx - ax), head = 11;
    const arrow = new Path2D();
    arrow.moveTo(ax, ay);
    arrow.lineTo(bx - Math.cos(a) * head * 0.6, by - Math.sin(a) * head * 0.6);
    const tip = new Path2D();
    tip.moveTo(bx, by);
    tip.lineTo(bx - Math.cos(a - 0.45) * head, by - Math.sin(a - 0.45) * head);
    tip.lineTo(bx - Math.cos(a + 0.45) * head, by - Math.sin(a + 0.45) * head);
    tip.closePath();
    const color = view.amove ? '#ff9a3c' : '#9dff6a';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4.5;
    ctx.stroke(arrow);
    ctx.lineWidth = 2;
    ctx.stroke(tip);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke(arrow);
    ctx.fillStyle = color;
    ctx.fill(tip);
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(ax, ay, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Is (x, y) on land (map km)? As the coastline is drawn: the page doesn't have the host's land grid.
  isLand(x, y) {
    const m = this.measureCtx || (this.measureCtx = document.createElement('canvas').getContext('2d'));
    return m.isPointInPath(this.outlines, x, y, 'evenodd');
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

  // A Hero: a gold double ring at its feet, so it stands out in a crowd.
  drawHeroRing(sx, sy, rpx) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#f2cc5c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, sy, rpx * 1.25 + 2, rpx * 0.62 + 1, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(122,82,18,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(sx, sy, rpx * 1.25 + 4, rpx * 0.62 + 2.5, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Units a Healer is mending right now, worked out here with the host's rule (Game.heal): wounded land
  // units of a Healer's owner within HEALER.radius of it, not disbanding. The snapshot carries every unit
  // that close to anything in view, so nothing is missed.
  healedUnits(list) {
    const out = new Set();
    const healers = list.filter((u) => UNITS[UNIT_TYPES[u.t]].healer);
    if (!healers.length) return out;
    for (const u of list) {
      const def = UNITS[UNIT_TYPES[u.t]];
      if (def.naval || u.flags & 4 || u.hp >= def.hp) continue;
      if (healers.some((h) => h.owner === u.owner && Math.hypot(h.dx - u.dx, h.dy - u.dy) <= HEALER.radius)) out.add(u);
    }
    return out;
  }

  // A unit being healed: a green glow ringed in darker green at its feet (it has to show on the pale
  // land and on green territories alike), and now and then a green cross rising from it.
  drawHealGlow(sx, sy, rpx, id, now) {
    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260 + id * 0.9);
    const rx = Math.max(4, rpx * 1.45);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, 0.5);
    const grad = ctx.createRadialGradient(0, 0, rx * 0.25, 0, 0, rx);
    grad.addColorStop(0, `rgba(60,210,90,${0.6 + 0.2 * pulse})`);
    grad.addColorStop(0.75, `rgba(40,170,70,${0.35 + 0.15 * pulse})`);
    grad.addColorStop(1, 'rgba(30,140,60,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = `rgba(20,120,45,${0.75 + 0.25 * pulse})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(sx, sy, rx * 0.85, rx * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
    if (rpx < 4) return;
    const t = ((now / 1400 + id * 0.37) % 1);          // a cross rising and fading, once every 1.4 s
    const s = Math.max(4, rpx * 0.5), y = sy - rpx * (0.9 + 1.6 * t), x = sx + rpx * 0.75;
    const cross = new Path2D();
    cross.rect(x - s / 6, y - s / 2, s / 3, s);
    cross.rect(x - s / 2, y - s / 6, s, s / 3);
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#0f3d1a';
    ctx.lineWidth = 2;
    ctx.stroke(cross);
    ctx.fillStyle = '#5dea6f';
    ctx.fill(cross);
    ctx.globalAlpha = 1;
  }

  // Your selected Healer: how far it heals (HEALER.radius), a faint green dashed circle.
  drawHealRange(sx, sy) {
    const ctx = this.ctx, r = HEALER.radius * this.g.cam.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(30,140,60,0.75)';          // shows on the pale land and on territories alike
    ctx.fillStyle = 'rgba(60,200,90,0.07)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Your selected Hero: how far its aura reaches (HERO.auraRadius), a faint gold dashed circle.
  drawAuraRange(sx, sy) {
    const ctx = this.ctx, r = HERO.auraRadius * this.g.cam.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,105,20,0.8)';          // shows on the pale land and on territories alike
    ctx.fillStyle = 'rgba(230,180,60,0.06)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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

    // Battleships' shots in flight (client.js flyProjectiles): a cannonball, or a ballista bolt.
    for (const p of fx.projectiles) {
      if (!p.fired) continue;
      const path = this.g.projectilePath(p);
      if (path.k >= 1) continue;
      if (p.shell) this.drawCannonball(path, path.k, z);
      else this.drawBolt(path, path.k, z);
    }

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

    for (const b of fx.blasts) this.drawBlast(b, now, z);

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
      const c = f.city >= 0 ? this.g.map.cities[f.city] : f;      // a city, or a place ({ x, y })
      const [sx, sy] = this.w2s(c.x, c.y);
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(sx, sy, 10 + t * Math.max(60, 90 * z), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    this.drawRegionBursts(now);
  }

  // A ballista bolt at `t` (0 to 1) of its flight, on a nearly flat arc (client.js projectilePath): a dark
  // wooden shaft with an iron head and pale fletching, pointing the way it flies, a faint streak behind it.
  drawBolt(p, t, z) {
    const ctx = this.ctx;
    const x = p.x0 + (p.x1 - p.x0) * t, y = p.y0 + (p.y1 - p.y0) * t - Math.sin(Math.PI * t) * p.arc;
    const [sx, sy] = this.w2s(x, y);
    const ang = Math.atan2((p.y1 - p.y0) - Math.cos(Math.PI * t) * p.arc * Math.PI, p.x1 - p.x0);
    const len = Math.max(9, 7.5 * z), w = Math.max(1.4, 0.5 * z), f = w * 1.8;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(240,232,214,0.35)';
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(-len * 2.4, 0); ctx.lineTo(-len, 0); ctx.stroke();
    ctx.strokeStyle = '#1a120a'; ctx.lineWidth = w + 1.4;
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-len * 0.2, 0); ctx.stroke();
    ctx.strokeStyle = '#7a5230'; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-len * 0.2, 0); ctx.stroke();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = '#1a120a';
    ctx.fillStyle = '#efe6d2';                      // fletching
    ctx.beginPath(); ctx.moveTo(-len * 0.72, 0); ctx.lineTo(-len - f * 0.6, -f); ctx.lineTo(-len, 0); ctx.lineTo(-len - f * 0.6, f); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c9d0d8';                      // iron head
    ctx.beginPath(); ctx.moveTo(len * 0.1, 0); ctx.lineTo(-len * 0.26, -f * 0.85); ctx.lineTo(-len * 0.26, f * 0.85); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // A battleship's cannonball at `t` (0 to 1) of its flight: a dark iron ball in an arc, a little smoke
  // behind it.
  drawCannonball(p, t, z) {
    const ctx = this.ctx;
    const at = (k) => {
      const x = p.x0 + (p.x1 - p.x0) * k, y = p.y0 + (p.y1 - p.y0) * k;
      return this.w2s(x, y - Math.sin(Math.PI * k) * p.arc);
    };
    const r = Math.max(2, 1.05 * z);
    for (let k = 3; k >= 1; k--) {
      const [tx, ty] = at(Math.max(0, t - k * 0.035));
      ctx.fillStyle = `rgba(215,210,200,${0.32 - k * 0.08})`;
      ctx.beginPath(); ctx.arc(tx, ty, r * (1 + k * 0.25), 0, Math.PI * 2); ctx.fill();
    }
    const [sx, sy] = at(t);
    ctx.fillStyle = '#1d1a17';
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(sx - r * 0.35, sy - r * 0.35, r * 0.35, 0, Math.PI * 2); ctx.fill();
  }

  // Gun smoke at a battleship firing a cannon ('muzzle'), and where its shot lands (client.js projectileLands):
  // a shell's burst of fire and dust ('hit', a short flash first) and on land the ring of its reach ('ring');
  // a bolt's splinters in a ship ('splinters'), dust and splinters on land ('thud'), or where its target died
  // before it landed, a bolt stuck in the ground ('stuck') or a splash in the sea ('splash').
  drawBlast(b, now, z) {
    const t = (now - b.t0) / b.dur;
    if (t < 0 || t > 1) return;
    const ctx = this.ctx;
    const [sx, sy] = this.w2s(b.x, b.y);
    const u = Math.max(1, z);
    if (b.kind === 'ring') {
      // A shell's burst on land: a ring of dust spreading out to how far it reaches (b.r km: splashRadius).
      const r = b.r * z * (0.3 + 0.7 * Math.sqrt(t));
      ctx.beginPath(); ctx.ellipse(sx, sy, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(120,98,70,${0.16 * (1 - t)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(92,74,52,${0.75 * (1 - t)})`;
      ctx.lineWidth = Math.max(1.2, 1.8 * u * (1 - t * 0.6));
      ctx.stroke();
      return;
    }
    if (b.kind === 'splinters' || b.kind === 'thud') {
      // A bolt strikes: splinters thrown up and falling back (a ship), with a puff of dust on land ('thud').
      if (b.kind === 'thud') {
        ctx.fillStyle = `rgba(110,94,74,${0.55 * (1 - t)})`;
        ctx.beginPath(); ctx.arc(sx, sy - 2 * u * t, (1.5 + 3 * t) * u, 0, Math.PI * 2); ctx.fill();
      }
      const w = Math.max(1.7, z);                       // light wood: it shows on the sea and on land
      ctx.fillStyle = `rgba(222,166,98,${1 - t})`;
      ctx.strokeStyle = `rgba(40,26,12,${0.8 * (1 - t)})`;
      ctx.lineWidth = 0.7;
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + (k - 2.5) * 0.48, v = (3.2 + (k % 3) * 0.9) * w;
        ctx.save();
        ctx.translate(sx + Math.cos(a) * v * t * 1.5, sy + Math.sin(a) * v * t * 1.5 + 8 * w * t * t);
        ctx.rotate(a + t * 7);
        ctx.fillRect(-1.3 * w, -0.45 * w, 2.6 * w, 0.9 * w);
        ctx.strokeRect(-1.3 * w, -0.45 * w, 2.6 * w, 0.9 * w);
        ctx.restore();
      }
      return;
    }
    if (b.kind === 'stuck') {
      // A bolt whose target fell first, stuck slanting in the ground, its tail towards where it came from; it fades.
      const len = Math.max(8, 7 * z), w = Math.max(1.3, 0.5 * z);
      const bx = -Math.cos(b.ang), by = -Math.sin(b.ang) * 0.5;
      const tx = sx + bx * len * 0.65, ty = sy + by * len * 0.65 - len * 0.55;
      ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3;
      ctx.fillStyle = 'rgba(70,56,40,0.5)';
      ctx.beginPath(); ctx.ellipse(sx, sy, 2.2 * u, 1 * u, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#1a120a'; ctx.lineWidth = w + 1.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.strokeStyle = '#7a5230'; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
      const a = Math.atan2(ty - sy, tx - sx), f = w * 1.8;
      ctx.save();
      ctx.translate(tx, ty); ctx.rotate(a);
      ctx.fillStyle = '#efe6d2'; ctx.strokeStyle = '#1a120a'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-len * 0.22, 0); ctx.lineTo(f * 0.6, -f); ctx.lineTo(0, 0); ctx.lineTo(f * 0.6, f); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
    if (t < 0.2 && b.kind !== 'splash') {
      const f = 1 - t / 0.2;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 6.5 * u);
      g.addColorStop(0, `rgba(255,236,170,${0.95 * f})`);
      g.addColorStop(0.5, `rgba(246,162,58,${0.7 * f})`);
      g.addColorStop(1, 'rgba(195,48,42,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, 6.5 * u, 0, Math.PI * 2); ctx.fill();
    }
    if (b.kind === 'splash') {
      // A ring of foam spreading on the water, and a few drops thrown up.
      ctx.strokeStyle = `rgba(235,246,255,${0.85 * (1 - t)})`;
      ctx.lineWidth = Math.max(1, 0.5 * z);
      ctx.beginPath(); ctx.ellipse(sx, sy + 2 * u, (2 + 7 * t) * u, (0.9 + 3 * t) * u, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = `rgba(235,246,255,${0.9 * (1 - t)})`;
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k - 2) * 0.45;
        const h = Math.sin(Math.PI * Math.min(1, t * 1.6)) * 7 * u;
        ctx.beginPath(); ctx.arc(sx + Math.cos(a) * 4.5 * t * u, sy - h * (1 - Math.abs(k - 2) * 0.25), Math.max(1, 0.5 * u), 0, Math.PI * 2); ctx.fill();
      }
      return;
    }
    // Smoke: grey-white puffs drifting up and spreading as they fade (dust is browner on land).
    const hit = b.kind === 'hit', tone = hit ? '92,80,68' : '225,222,214';
    for (let k = 0; k < 3; k++) {
      const r = (1.7 + 4.5 * t) * u * (1 - k * 0.18);
      const px = sx + (k - 1) * 2.2 * u * (0.5 + t), py = sy - (3.5 * t + k * 1.1) * u;
      ctx.fillStyle = `rgba(${tone},${(hit ? 0.62 : 0.55) * (1 - t) * (1 - k * 0.2)})`;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
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
    // The regions lit from the city panel, in case they are off screen: fading in and out with the map.
    if (this.hovers?.length) {
      ctx.setTransform(s * dpr, 0, 0, s * dpr, -b.x0 * s * dpr, -b.y0 * s * dpr);
      ctx.lineJoin = 'round';
      for (const h of this.hovers) {
        const e = this.regionHoverState(h, now).e;
        if (e <= 0) continue;
        ctx.fillStyle = `rgba(255,244,205,${(0.45 * e).toFixed(3)})`;
        this.fillRegion(ctx, h.region);
        ctx.strokeStyle = `rgba(255,226,130,${(0.95 * e).toFixed(3)})`;
        ctx.lineWidth = 1.6 / s;
        ctx.stroke(this.regionOutline[h.region]);
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

    // Your cities captured and the attacks of the last few seconds, on top of everything.
    for (const e of g.effects.pings) this.drawPing(ctx, e, now);

    // The city the guide points at (drawGuideMark), in case it is off screen: a ring closing in on it.
    const gi = g.guideMarkCity();
    if (gi >= 0) {
      const c = g.map.cities[gi], t = (now / 1100) % 1;
      ctx.strokeStyle = g.guideStep === 2 ? `rgba(255,96,64,${(0.4 + 0.6 * t).toFixed(3)})` : `rgba(255,214,110,${(0.4 + 0.6 * t).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc((c.x - b.x0) * s, (c.y - b.y0) * s, 3 + 9 * (1 - t), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // A ping on the minimap (PINGS, `e`: { x, y, kind, t0 }): rings go out from the place, a dark edge under
  // each so they show on sea and land alike, and a frame blinks around it. In minimap CSS px.
  drawPing(ctx, e, now) {
    const P = PINGS[e.kind], age = now - e.t0;
    if (age < 0 || age > P.ms) return;
    const b = this.g.map.bounds, s = this.miniScale();
    const x = (e.x - b.x0) * s, y = (e.y - b.y0) * s;
    const reach = clamp(this.miniW * 0.09, 14, 44);         // how far a ring goes, with the minimap's size
    const ring = (r, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3.5; ctx.stroke();
      ctx.strokeStyle = P.color; ctx.lineWidth = 2; ctx.stroke();
    };
    for (let k = 0; k < P.waves; k++) {
      const t = (age - k * P.every) / (P.every * 1.4);
      if (t >= 0 && t <= 1) ring(4 + t * reach, 1 - t * t);
    }
    // The frame: on, off, about three times a second; fades out in the last second.
    if (Math.floor(age / 160) % 2 === 0) {
      ctx.globalAlpha = Math.min(1, (P.ms - age) / 1000);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3.5;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
      ctx.strokeStyle = P.color; ctx.lineWidth = 2;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
    ctx.globalAlpha = 1;
  }
}
