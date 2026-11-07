// Browser-to-browser play (WebRTC). The lobby server hands a started game to its host player:
// the host's page runs the simulation in a Web Worker (host-worker.js) and keeps one data channel
// per other player; every other page opens one data channel to the host. The lobby server only
// passes the connection messages along ('signal': offer, answer, ICE candidates).
//
// Both sessions offer `link.send(msg)` for this page's orders, and call onMessage(msg) with the
// game's messages (start, snap, event, score, room, gameover), exactly like the old server did.

const CONNECT_TIMEOUT_MS = 20000;
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
  constructor({ net, gameId, you, title, roster, ice, balance, onMessage, onError }) {
    this.isHost = true;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.ice = ice;
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.peers = new Map();          // player id -> { pc, channel, candidates }
    this.worker = new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => this.onError(`The game could not run: ${e.message || 'worker error'}`);
    this.worker.postMessage({ type: 'init', gameId, title, roster, hostId: you, balance });
    // This page's own orders go straight to the worker.
    this.link = { send: (msg) => this.worker.postMessage({ type: 'msg', from: you, msg }) };
  }

  fromWorker(m) {
    if (m.type === 'send') {
      if (m.to === this.you) {
        this.onMessage(m.msg);
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
  mapRebuilt() { this.worker.postMessage({ type: 'mapRebuilt' }); }

  destroy() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id, false);
    this.worker.terminate();
  }
}

// ------------------------------------------------------------------ other players
export class PeerSession {
  // onLost(text): the link to the host is gone, or could not be made.
  constructor({ net, gameId, you, ice, onMessage, onLost }) {
    this.isHost = false;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.onMessage = onMessage;
    this.onLost = onLost;
    this.done = false;
    this.open = false;
    this.link = {
      send: (msg) => {
        if (this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
      },
    };

    const pc = (this.pc = new RTCPeerConnection(rtcConfig(ice)));
    this.candidates = new Candidates(pc);
    const ch = (this.channel = pc.createDataChannel('game', { ordered: true }));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.net.send({ t: 'signal', data: { candidate: e.candidate.toJSON() } });
    };
    ch.onopen = () => {
      this.open = true;
      clearTimeout(this.timer);
    };
    ch.onmessage = (e) => {
      const msg = parse(e.data);
      if (msg) this.onMessage(msg);
    };
    ch.onclose = () => this.lost('Lost the connection to the host. The game may be over, or their network dropped.');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.lost('Lost the connection to the host.');
    };
    this.timer = setTimeout(() => {
      if (!this.open) {
        this.lost('Could not connect to the host. A firewall on their network or yours may block ' +
          'direct connections between players; an admin can set up a TURN relay (see README).');
      }
    }, CONNECT_TIMEOUT_MS);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => this.net.send({ t: 'signal', data: { sdp: pc.localDescription.toJSON() } }))
      .catch((e) => this.lost(`Could not connect to the host: ${e.message}`));
  }

  // The host's answer and ICE candidates, passed on by the lobby server.
  onSignal(from, data) {
    if (this.done) return;
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
