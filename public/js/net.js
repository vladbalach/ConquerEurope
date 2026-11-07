// Minimal WebSocket wrapper with typed message handlers, for the lobby server.
// Game traffic goes browser to browser (p2p.js), so this connection is often quiet: a ping every
// few minutes keeps it open, and keeps a free host that sleeps when idle (e.g. Render) awake.
const PING_MS = 4 * 60 * 1000;

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
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send({ t: 'ping' }), PING_MS);
      if (this.onopen) this.onopen();
    };
    ws.onclose = () => {
      clearInterval(this.pinger);
      if (this.ws === ws) this.ws = null;
      if (this.onclose) this.onclose();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const h = this.handlers.get(msg.t);
      if (h) h(msg);
    };
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }
}
