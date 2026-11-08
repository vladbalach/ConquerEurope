// Browser-to-browser play (WebRTC). The lobby server hands a started game to its host player:
// the host's page runs the simulation in a Web Worker (host-worker.js) and keeps one data channel
// per other player; every other page opens one data channel to the host. The lobby server only
// passes the connection messages along ('signal': offer, answer, ICE candidates).
//
// Both sessions offer `link.send(msg)` for this page's orders, and call onMessage(msg) with the
// game's messages (start, snap, event, score, room, gameover), exactly like the old server did.

// No direct link after this long: go through the lobby server instead (relay). Direct links
// normally open within a second or two; some networks (mobile data, some company or home
// routers) never allow them.
const DIRECT_TIMEOUT_MS = 7000;
const RELAY_TIMEOUT_MS = 15000;      // the host does not answer through the relay either: give up
const MAX_BUFFERED = 1 << 20;        // a player whose link falls this far behind skips snapshots

function rtcConfig(ice) {
  return { iceServers: ice.iceServers, iceTransportPolicy: ice.relayOnly ? 'relay' : 'all' };
}

function parse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

// ICE candidates may arrive before the offer or answer is applied: keep them until then.
class Candidates {
  constructor(pc) { this.pc = pc; this.ready = false; this.queue = []; }
  add(c) {
    if (this.ready) this.pc.addIceCandidate(c).catch(() => {});
    else this.queue.push(c);
  }
  flush() {
    this.ready = true;
    for (const c of this.queue.splice(0)) this.pc.addIceCandidate(c).catch(() => {});
  }
}

// ------------------------------------------------------------------ host
export class HostSession {
  // net: the lobby connection. roster: [{ id, color }]. balance: current balance values.
  // options: the game options the host picked in the waiting room.
  constructor({ net, gameId, you, title, options, roster, ice, balance, onMessage, onError }) {
    this.isHost = true;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.ice = ice;
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.peers = new Map();          // player id -> { pc, channel, candidates }
    this.relayed = new Set();        // players without a direct link: their messages go through the server
    this.worker = new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => this.onError(`The game could not run: ${e.message || 'worker error'}`);
    this.worker.postMessage({ type: 'init', gameId, title, options, roster, hostId: you, balance });
    // This page's own orders go straight to the worker.
    this.link = { send: (msg) => this.worker.postMessage({ type: 'msg', from: you, msg }) };
  }

  fromWorker(m) {
    if (m.type === 'send') {
      if (m.to === this.you) {
        this.onMessage(m.msg);
        return;
      }
      if (this.relayed.has(m.to)) {
        const ws = this.net.ws;
        if (m.msg.t === 'snap' && ws && ws.bufferedAmount > MAX_BUFFERED) return;
        this.net.send({ t: 'relay', to: m.to, msg: m.msg });
        return;
      }
      const ch = this.peers.get(m.to)?.channel;
      if (!ch || ch.readyState !== 'open') return;
      if (m.msg.t === 'snap' && ch.bufferedAmount > MAX_BUFFERED) return;   // slow link: skip a frame
      ch.send(JSON.stringify(m.msg));
    } else if (m.type === 'ended') {
      this.net.send({ t: 'gameEnded', winner: m.winner });
    } else if (m.type === 'error') {
      this.onError(m.msg);
    }
  }

  // A connection message from player `from`, passed on by the lobby server.
  async onSignal(from, data) {
    if (data.sdp && data.sdp.type === 'offer') {
      this.dropPeer(from, false);    // a new offer replaces an old link (the player reconnects)
      this.relayed.delete(from);
      const pc = new RTCPeerConnection(rtcConfig(this.ice));
      const peer = { pc, channel: null, candidates: new Candidates(pc), online: false };
      this.peers.set(from, peer);
      pc.onicecandidate = (e) => {
        if (e.candidate) this.net.send({ t: 'signal', to: from, data: { candidate: e.candidate.toJSON() } });
      };
      pc.ondatachannel = (e) => {
        const ch = (peer.channel = e.channel);
        ch.onopen = () => {
          peer.online = true;
          this.worker.postMessage({ type: 'connect', id: from });
        };
        ch.onmessage = (ev) => {
          const msg = parse(ev.data);
          if (msg) this.worker.postMessage({ type: 'msg', from, msg });
        };
        ch.onclose = () => { if (this.peers.get(from) === peer) this.dropPeer(from, true); };
      };
      pc.onconnectionstatechange = () => {
        if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.peers.get(from) === peer) {
          this.dropPeer(from, true);
        }
      };
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      peer.candidates.flush();
      this.net.send({ t: 'signal', to: from, data: { sdp: pc.localDescription.toJSON() } });
    } else if (data.candidate) {
      this.peers.get(from)?.candidates.add(data.candidate);
    }
  }

  // A message from a player who plays through the server relay (no direct link).
  onRelay(from, msg) {
    if (msg.t === 'relayOpen') {
      this.dropPeer(from, false);    // their direct link never opened
      this.relayed.add(from);
      this.worker.postMessage({ type: 'connect', id: from });
    } else if (msg.t === 'relayClose') {
      if (this.relayed.delete(from)) this.worker.postMessage({ type: 'disconnect', id: from });
    } else if (this.relayed.has(from)) {
      this.worker.postMessage({ type: 'msg', from, msg });
    }
  }

  // The link to a player is gone. `tell`: let the game know they are offline.
  dropPeer(id, tell) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    try { peer.channel && peer.channel.close(); } catch { /* already closed */ }
    try { peer.pc.close(); } catch { /* already closed */ }
    if (tell && peer.online) this.worker.postMessage({ type: 'disconnect', id });
  }

  // Live changes from the lobby server, for the game running here.
  balance(values) { this.worker.postMessage({ type: 'balance', values }); }
  cityMoved(msg) { this.worker.postMessage({ type: 'cityMoved', city: msg.city, x: msg.x, y: msg.y }); }
  cityCoast(msg) { this.worker.postMessage({ type: 'cityCoast', city: msg.city, coastal: msg.coastal }); }
  beachEdit(msg) { this.worker.postMessage({ type: 'beachEdit', cells: msg.cells, on: msg.on }); }
  mapRebuilt() { this.worker.postMessage({ type: 'mapRebuilt' }); }

  destroy() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id, false);
    this.worker.terminate();
  }
}

// ------------------------------------------------------------------ other players
export class PeerSession {
  // onLost(text): the link to the host is gone, or could not be made.
  // onStatus(text): how the connection is going, for the screen.
  constructor({ net, gameId, you, ice, onMessage, onLost, onStatus }) {
    this.isHost = false;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.onMessage = onMessage;
    this.onLost = onLost;
    this.onStatus = onStatus || (() => {});
    this.done = false;
    this.open = false;               // the direct link is open
    this.relay = false;              // playing through the lobby server instead
    this.started = false;            // the host's game has reached us
    this.link = {
      send: (msg) => {
        if (this.relay) this.net.send({ t: 'relay', msg });
        else if (this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
      },
    };

    const pc = (this.pc = new RTCPeerConnection(rtcConfig(ice)));
    this.candidates = new Candidates(pc);
    const ch = (this.channel = pc.createDataChannel('game', { ordered: true }));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.net.send({ t: 'signal', data: { candidate: e.candidate.toJSON() } });
    };
    ch.onopen = () => {
      if (this.relay || this.done) return;
      this.open = true;
      clearTimeout(this.timer);
      console.info('Connected to the host directly (WebRTC).');
    };
    ch.onmessage = (e) => {
      const msg = parse(e.data);
      if (msg) this.receive(msg);
    };
    // The direct link failed, or died during the game (network change, a sleeping laptop, a
    // browser pausing a background tab): carry on through the server. If the host really left,
    // the lobby server says so and the game ends then.
    ch.onclose = () => { if (this.open) this.linkLost(); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' || this.relay) return;
      if (this.open) this.linkLost();
      else this.useRelay();
    };
    this.timer = setTimeout(() => { if (!this.open) this.useRelay(); }, DIRECT_TIMEOUT_MS);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => this.net.send({ t: 'signal', data: { sdp: pc.localDescription.toJSON() } }))
      .catch(() => this.useRelay());
  }

  receive(msg) {
    this.started = true;
    this.heard = true;
    this.onMessage(msg);
  }

  // The direct link died during the game.
  linkLost() {
    if (this.relay || this.done) return;
    console.info('The direct link to the host was lost: switching to the server relay.');
    this.open = false;
    this.useRelay('Lost the direct connection to the host: reconnecting through the server…');
  }

  // No direct link to the host: send and receive the game through the lobby server.
  useRelay(status = 'No direct connection to the host: connecting through the server…') {
    if (this.relay || this.done || this.open) return;
    this.relay = true;
    clearTimeout(this.timer);
    console.info('No direct connection to the host: playing through the server relay.');
    this.closeDirect();
    this.onStatus(status);
    this.openRelay();
  }

  // Ask the host (through the server) for the game. Also after our lobby connection came back,
  // since the relay runs over it.
  openRelay() {
    this.heard = false;
    this.net.send({ t: 'relay', msg: { t: 'relayOpen' } });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.heard) this.lost('Could not reach the host, neither directly nor through the server.');
    }, RELAY_TIMEOUT_MS);
  }

  // A game message from the host through the server relay.
  onRelay(msg) {
    if (this.relay && !this.done) this.receive(msg);
  }

  closeDirect() {
    const { pc, channel } = this;
    if (channel) channel.onclose = null;
    if (pc) pc.onconnectionstatechange = null;
    try { channel && channel.close(); } catch { /* already closed */ }
    try { pc && pc.close(); } catch { /* already closed */ }
  }

  // The host's answer and ICE candidates, passed on by the lobby server.
  onSignal(from, data) {
    if (this.done || this.relay) return;
    if (data.sdp && data.sdp.type === 'answer') {
      this.pc.setRemoteDescription(data.sdp).then(() => this.candidates.flush()).catch(() => {});
    } else if (data.candidate) {
      this.candidates.add(data.candidate);
    }
  }

  lost(text) {
    if (this.done) return;
    this.destroy();
    this.onLost(text);
  }

  destroy() {
    this.done = true;
    clearTimeout(this.timer);
    try { this.channel.close(); } catch { /* already closed */ }
    try { this.pc.close(); } catch { /* already closed */ }
  }
}
