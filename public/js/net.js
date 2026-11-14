// Minimal WebSocket wrapper with typed message handlers, for the lobby server.
// Game traffic goes browser to browser (p2p.js), so this connection is often quiet: a small ping
// keeps it open, and keeps a free host that sleeps when idle (e.g. Render) awake.
import { logger } from './log.js';

const PING_MS = 25 * 1000;      // short enough for proxies, routers and browsers that drop quiet connections
const log = logger('net');
// Left out of the console: keep-alives, game traffic through the server, WebRTC set-up (p2p.js says
// how that goes) and the lobby's game list, which comes again on every change.
const QUIET = new Set(['ping', 'pong', 'relay', 'signal', 'games']);

// A message for the console: its plain fields only (no lists, maps or tokens).
function summary(msg) {
  const out = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === 't' || k === 'token') continue;
    if (v === null || typeof v !== 'object') out[k] = v;
  }
  if (msg.t === 'hello') {
    out.resume = msg.resume ? `game ${msg.resume.gameId}` : null;
    out.hosting = msg.hosting ? `game ${msg.hosting.gameId} epoch ${msg.hosting.epoch}` : null;
    out.tokens = Object.keys(msg.tokens || {}).length;
  }
  return out;
}

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.onopen = null;
    this.onclose = null;
    this.pinger = 0;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    log.info('connecting to', url);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      log.info('connected');
      clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send({ t: 'ping' }), PING_MS);
      if (this.onopen) this.onopen();
    };
    // The browser never says why a WebSocket failed (see the Network tab, filter WS); the close code
    // after it tells a little: 1006 = no connection or cut off, 1001 = page leaving, 1011 = server error.
    ws.onerror = () => log.error('WebSocket error (the next line has the close code)');
    ws.onclose = (e) => {
      log.warn(`closed: code ${e.code}${e.reason ? `, reason "${e.reason}"` : ''}${e.wasClean ? '' : ', not clean'}`);
      clearInterval(this.pinger);
      if (this.ws === ws) this.ws = null;
      if (this.onclose) this.onclose();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        log.warn('unreadable message from the server:', String(e.data).slice(0, 200));
        return;
      }
      if (!QUIET.has(msg.t)) log.info('<-', msg.t, summary(msg));
      const h = this.handlers.get(msg.t);
      if (h) h(msg);
      else if (!QUIET.has(msg.t)) log.warn('no handler for', msg.t);
    };
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  send(msg) {
    if (!this.connected) {
      if (msg.t !== 'ping') log.warn('not connected: dropped', msg.t);
      return;
    }
    if (!QUIET.has(msg.t)) log.info('->', msg.t, summary(msg));
    this.ws.send(JSON.stringify(msg));
  }
}
