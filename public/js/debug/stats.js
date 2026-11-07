// Performance overlays modelled on Unreal Engine's stat commands:
//   stat fps        frames per second and frame time
//   stat unit       Frame / Game / Draw / Server times in milliseconds
//   stat unitgraph  the same four times as a scrolling graph
//
// Frame  = time between two rendered frames (what sets the FPS)
// Game   = browser time spent on input, interpolation, effects and HUD
// Draw   = browser time spent issuing the canvas drawing for the frame
// Server = time the server spends on one simulation tick (sent in debug builds)

const SAMPLES = 240;
const SERIES = [
  { key: 'frame', label: 'Frame', color: '#5cff6e' },
  { key: 'game', label: 'Game', color: '#ff5c5c' },
  { key: 'draw', label: 'Draw', color: '#ffd84a' },
  { key: 'server', label: 'Server', color: '#4ac8ff' },
];
const GRAPH_W = 380, GRAPH_H = 170;

// Green within a 60 FPS budget, yellow within 30 FPS, red beyond.
const budgetColor = (ms) => (ms <= 16.7 ? '#5cff6e' : ms <= 33.4 ? '#ffd84a' : '#ff5c5c');

export class Stats {
  constructor(host) {
    this.show = { fps: false, unit: false, unitgraph: false };
    this.buf = Object.fromEntries(SERIES.map((s) => [s.key, new Float32Array(SAMPLES)]));
    this.head = 0;             // next write position in the ring buffers
    this.count = 0;
    this.lastNow = 0;
    this.lastText = 0;

    this.root = document.createElement('div');
    this.root.className = 'dev-stats';
    this.fpsEl = document.createElement('div');
    this.fpsEl.className = 'dev-stat-fps';
    this.unitEl = document.createElement('div');
    this.unitEl.className = 'dev-stat-unit';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dev-stat-graph';
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = GRAPH_W * dpr;
    this.canvas.height = GRAPH_H * dpr;
    this.canvas.style.width = `${GRAPH_W}px`;
    this.canvas.style.height = `${GRAPH_H}px`;
    this.root.append(this.fpsEl, this.unitEl, this.canvas);
    host.append(this.root);
    this.apply();
  }

  toggle(name) {
    this.show[name] = !this.show[name];
    this.apply();
    return this.show[name];
  }

  none() {
    for (const k of Object.keys(this.show)) this.show[k] = false;
    this.apply();
  }

  apply() {
    this.fpsEl.hidden = !this.show.fps;
    this.unitEl.hidden = !this.show.unit;
    this.canvas.hidden = !this.show.unitgraph;
    this.root.hidden = !Object.values(this.show).some(Boolean);
  }

  // Called once per rendered frame with the browser-side timings (ms).
  frame(now, t) {
    const frameMs = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    if (!frameMs) return;
    const i = this.head;
    this.buf.frame[i] = frameMs;
    this.buf.game[i] = t.game;
    this.buf.draw[i] = t.draw;
    this.buf.server[i] = t.server || 0;
    this.head = (i + 1) % SAMPLES;
    this.count = Math.min(SAMPLES, this.count + 1);

    if (this.root.hidden) return;
    if (now - this.lastText > 250) {
      this.lastText = now;
      this.updateText();
    }
    if (this.show.unitgraph) this.drawGraph();
  }

  // Average of the newest n samples of a series.
  avg(key, n = 30) {
    n = Math.min(n, this.count);
    if (!n) return 0;
    const b = this.buf[key];
    let sum = 0;
    for (let k = 1; k <= n; k++) sum += b[(this.head - k + SAMPLES) % SAMPLES];
    return sum / n;
  }

  updateText() {
    const frame = this.avg('frame');
    if (this.show.fps) {
      this.fpsEl.textContent = `${(1000 / frame).toFixed(1)} FPS  ${frame.toFixed(2)} ms`;
      this.fpsEl.style.color = budgetColor(frame);
    }
    if (this.show.unit) {
      this.unitEl.textContent = '';
      for (const s of SERIES) {
        const ms = this.avg(s.key);
        const row = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = s.label;
        const value = document.createElement('b');
        value.textContent = `${ms.toFixed(2)} ms`;
        value.style.color = s.key === 'server' ? budgetColor(ms * 2.5) : budgetColor(ms);   // server budget: 50 ms tick
        row.append(label, value);
        this.unitEl.append(row);
      }
    }
  }

  drawGraph() {
    const ctx = this.canvas.getContext('2d');
    const dpr = this.canvas.width / GRAPH_W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, GRAPH_W, GRAPH_H);

    // Scale: 50 ms, or 100/200 ms when something spikes above it.
    let max = 0;
    for (const s of SERIES) for (let k = 0; k < this.count; k++) max = Math.max(max, this.buf[s.key][k]);
    const scale = max > 95 ? 200 : max > 45 ? 100 : 50;
    const x0 = 34, y0 = 24, w = GRAPH_W - x0 - 8, h = GRAPH_H - y0 - 12;
    const yOf = (ms) => y0 + h - (Math.min(ms, scale) / scale) * h;

    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    // Guide lines: the 60 and 30 FPS frame budgets, and the top of the scale. Axis is in ms.
    for (const [ms, name] of [[16.7, '60 FPS'], [33.3, '30 FPS'], [scale, '']]) {
      if (ms > scale) continue;
      const y = Math.round(yOf(ms)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash(name ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(String(ms), x0 - 4, y);
      if (name) ctx.fillText(name, x0 + w - 2, y - 7);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.moveTo(x0 + 0.5, y0); ctx.lineTo(x0 + 0.5, y0 + h); ctx.lineTo(x0 + w, y0 + h + 0.5); ctx.stroke();

    // Oldest sample on the left, newest on the right.
    for (const s of SERIES) {
      const b = this.buf[s.key];
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < this.count; k++) {
        const idx = (this.head - this.count + k + SAMPLES) % SAMPLES;
        const x = x0 + ((SAMPLES - this.count + k) / (SAMPLES - 1)) * w;
        const y = yOf(b[idx]);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Legend with current averages.
    ctx.textAlign = 'left';
    ctx.font = '11px Consolas, monospace';
    let lx = x0;
    for (const s of SERIES) {
      const text = `${s.label} ${this.avg(s.key).toFixed(1)}`;
      ctx.fillStyle = s.color;
      ctx.fillText(text, lx, 12);
      lx += ctx.measureText(text).width + 14;
    }
  }
}
