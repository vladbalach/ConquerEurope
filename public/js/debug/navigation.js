// "show navigation" (debug console): draws the server's navigation grid over the map, so you can
// see which areas units can walk on and which they cannot.
//
//   green        walkable, on the mainland (the largest connected landmass)
//   other hues   walkable, but a separate landmass: units there cannot reach the mainland
//   orange       around a city: walkable, but paths go around it
//   red          not walkable (sea, or land too small or too thin for the 5 km grid)
//
// The grid comes from the server (/debug/navgrid, served only in debug builds), exactly as
// pathfinding uses it. Zoomed in, cell borders are drawn too, and the legend shows the cell
// under the cursor.

const MAINLAND = [70, 200, 95, 150];
const ISLANDS = [            // separate landmasses, in turn
  [70, 175, 235, 170], [235, 205, 60, 170], [185, 110, 235, 170], [235, 120, 190, 170], [90, 225, 205, 170],
];
const OBSTACLE = [255, 140, 20, 215];
const BLOCKED = [215, 45, 45, 105];
const GRID_MIN_PX = 7;       // cell size on screen from which cell borders are drawn

const css = ([r, g, b, a]) => `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;

export class NavOverlay {
  constructor(host) {
    this.on = false;
    this.grid = null;
    this.loading = null;
    this.legend = document.createElement('div');
    this.legend.className = 'dev-nav-legend';
    this.legend.hidden = true;
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'dev-nav-cursor';
    host.append(this.legend);
    this.lastCursor = 0;
  }

  // Fetches and decodes the grid once; later calls reuse it.
  load() {
    if (!this.loading) {
      this.loading = fetch('/debug/navgrid', { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) throw new Error(`server answered ${res.status}`);
          return res.json();
        })
        .then((data) => { this.grid = decode(data); return this.grid; })
        .catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  }

  // The map was rebuilt (Edit map): load the grid again, right away if the overlay is showing.
  reload() {
    this.loading = null;
    if (!this.grid) return;
    this.grid = null;
    if (this.on) this.load().then(() => this.setOn(true)).catch(() => {});
  }

  setOn(on) {
    this.on = on;
    this.legend.hidden = !on || !this.grid;
    if (on && this.grid) this.buildLegend();
  }

  // One line for the console after loading.
  summary() {
    const gr = this.grid;
    const land = gr.sizes.reduce((s, n) => s + n, 0);
    const islands = gr.sizes.filter((n, id) => id && n && id !== gr.mainland).length;
    return `${gr.w}×${gr.h} cells of ${gr.cell} km · mainland ${Math.round((gr.sizes[gr.mainland] / land) * 100)}% of the ` +
      `walkable land · ${islands} separate landmass${islands === 1 ? '' : 'es'} · ${gr.obstacles} cells around cities`;
  }

  buildLegend() {
    const row = (color, text) => {
      const r = document.createElement('div');
      const sw = document.createElement('i');
      sw.style.background = color;
      r.append(sw, text);
      return r;
    };
    this.legend.textContent = '';
    const title = document.createElement('b');
    title.textContent = 'Navigation';
    this.legend.append(title,
      row(css(MAINLAND), 'walkable (mainland)'),
      row(`linear-gradient(90deg, ${ISLANDS.slice(0, 3).map(css).join(', ')})`, 'walkable, separate landmass'),
      row(css(OBSTACLE), 'city: paths go around'),
      row(css(BLOCKED), 'not walkable'),
      this.cursorEl);
  }

  // Called by the renderer after the map and before cities and units.
  draw(ctx, r) {
    const gr = this.grid;
    if (!this.on || !gr) return;
    const cam = r.g.cam, z = cam.zoom, dpr = r.dpr;
    ctx.save();
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (r.W / 2 - cam.x * z) * dpr, (r.H / 2 - cam.y * z) * dpr);
    ctx.imageSmoothingEnabled = gr.cell * z < 2;      // crisp cells once they are a few pixels wide
    ctx.drawImage(gr.image, gr.x0, gr.y0, gr.w * gr.cell, gr.h * gr.cell);

    if (gr.cell * z >= GRID_MIN_PX) {
      const v = r.viewRect();
      const i0 = Math.max(0, Math.floor((v.x0 - gr.x0) / gr.cell));
      const i1 = Math.min(gr.w, Math.ceil((v.x1 - gr.x0) / gr.cell));
      const j0 = Math.max(0, Math.floor((v.y0 - gr.y0) / gr.cell));
      const j1 = Math.min(gr.h, Math.ceil((v.y1 - gr.y0) / gr.cell));
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = gr.x0 + i * gr.cell;
        ctx.moveTo(x, gr.y0 + j0 * gr.cell); ctx.lineTo(x, gr.y0 + j1 * gr.cell);
      }
      for (let j = j0; j <= j1; j++) {
        const y = gr.y0 + j * gr.cell;
        ctx.moveTo(gr.x0 + i0 * gr.cell, y); ctx.lineTo(gr.x0 + i1 * gr.cell, y);
      }
      ctx.strokeStyle = 'rgba(20,12,6,0.28)';
      ctx.lineWidth = 1 / z;
      ctx.stroke();
    }
    ctx.restore();
    this.updateCursor(r);
  }

  // The cell under the mouse, in the legend (a few times per second).
  updateCursor(r) {
    const now = performance.now();
    if (now - this.lastCursor < 120) return;
    this.lastCursor = now;
    const gr = this.grid, m = r.g.input && r.g.input.mouse;
    if (!m || !m.inside) { this.cursorEl.textContent = ''; return; }
    const [wx, wy] = r.s2w(m.x, m.y);
    const i = Math.floor((wx - gr.x0) / gr.cell), j = Math.floor((wy - gr.y0) / gr.cell);
    if (i < 0 || j < 0 || i >= gr.w || j >= gr.h) { this.cursorEl.textContent = 'Cursor: outside the grid'; return; }
    const k = j * gr.w + i, id = gr.comp[k];
    const what = !id ? 'not walkable'
      : gr.obstacle[k] ? 'around a city (avoided)'
        : id === gr.mainland ? 'walkable, mainland' : `walkable, landmass ${id}`;
    this.cursorEl.textContent = `Cursor: cell ${i}, ${j} · ${what}`;
  }
}

// Server data -> landmass ids per cell, sizes, and an image with one pixel per cell.
function decode(data) {
  const { w, h } = data;
  const comp = new Int32Array(w * h);
  let pos = 0;
  for (const run of data.comp.split(',')) {
    const [v, l] = run.split(':');
    const len = parseInt(l, 36);
    comp.fill(parseInt(v, 36), pos, pos + len);
    pos += len;
  }
  const obstacle = new Uint8Array(w * h);
  for (const k of data.obstacles) obstacle[k] = 1;

  const sizes = [];
  for (let k = 0; k < comp.length; k++) sizes[comp[k]] = (sizes[comp[k]] || 0) + 1;
  for (let id = 0; id < sizes.length; id++) sizes[id] = sizes[id] || 0;
  let mainland = 0;      // the largest landmass
  for (let id = 1; id < sizes.length; id++) if (!mainland || sizes[id] > sizes[mainland]) mainland = id;

  // Each separate landmass gets the next colour in turn.
  const islandColor = new Map();
  for (let id = 1; id < sizes.length; id++) {
    if (sizes[id] && id !== mainland) islandColor.set(id, ISLANDS[islandColor.size % ISLANDS.length]);
  }

  const image = document.createElement('canvas');
  image.width = w;
  image.height = h;
  const ictx = image.getContext('2d');
  const img = ictx.createImageData(w, h);
  const px = img.data;
  for (let k = 0; k < comp.length; k++) {
    const id = comp[k];
    const c = !id ? BLOCKED : obstacle[k] ? OBSTACLE : id === mainland ? MAINLAND : islandColor.get(id);
    px.set(c, k * 4);
  }
  ictx.putImageData(img, 0, 0);
  return {
    w, h, cell: data.cell, x0: data.x0, y0: data.y0, comp, obstacle, sizes, mainland, image,
    obstacles: data.obstacles.length,
  };
}
