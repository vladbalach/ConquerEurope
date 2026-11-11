// Browser-to-browser play (WebRTC). The lobby server hands a started game to its host player:
// the host's page runs the simulation in a Web Worker (host-worker.js) and keeps one data channel
// per other player; every other page opens one data channel to the host. The lobby server only
// passes the connection messages along ('signal': offer, answer, ICE candidates).
//
// Both sessions offer `link.send(msg)` for this page's orders, and call onMessage(msg) with the
// game's messages (start, snap, event, score, room, gameover), exactly like the old server did.
// Snapshots and scores travel as changes to the last one sent on that link (delta.js).
import { DeltaEncoder, DeltaDecoder } from './delta.js';

// No direct link after this long: go through the lobby server instead (relay). Direct links
// normally open within a second or two; some networks (mobile data, some company or home
// routers) never allow them.
const DIRECT_TIMEOUT_MS = 7000;
const RELAY_TIMEOUT_MS = 15000;      // the host does not answer through the relay either: give up
// A link that falls behind skips snapshots rather than queue them: each one has the whole state, so
// the next one makes up for it, while a queue only delays everything after it. Behind: more than
// this many snapshots' worth of data still waiting to go out (and at least MIN_BUFFERED).
const BEHIND_SNAPSHOTS = 4;
const MIN_BUFFERED = 64 * 1024;
// Deaths and War Cries happen once: those of skipped snapshots go with the next one sent (at most
// this many values each, the latest).
const MAX_CARRIED = 4000;
// A message longer than this (characters of JSON) goes in pieces: browsers take at most 256 KB in one
// data channel message, and the game-over message carries the whole game's history. A piece is sent as
// JSON too, so its escaped quotes can make it up to twice as long: still well under the limit.
export const PART_SIZE = 60000;

// A direct link carries the host's messages compressed (deflate, about 3 times smaller) when both
// browsers can: the player's page names it as the data channel's protocol. Through the relay the
// lobby server's WebSocket compresses instead (server/index.js).
const DEFLATE = 'deflate';
export const canDeflate = (() => {
  try {
    new CompressionStream(DEFLATE);
    new DecompressionStream(DEFLATE);
    return true;
  } catch {
    return false;
  }
})();
const COMPRESS_MIN = 200;            // characters: shorter messages go as they are

export function deflate(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream(DEFLATE))).arrayBuffer();
}

export function inflate(data) {
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream(DEFLATE))).text();
}

function rtcConfig(ice) {
  return { iceServers: ice.iceServers, iceTransportPolicy: ice.relayOnly ? 'relay' : 'all' };
}

function parse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

// A long message as pieces { t: 'part', id, i, n, s } (the JSON text cut in order), or null when it fits in one.
let nextPartId = 1;
export function splitMessage(text) {
  if (text.length <= PART_SIZE) return null;
  const id = nextPartId++, n = Math.ceil(text.length / PART_SIZE);
  return Array.from({ length: n }, (_, i) => ({ t: 'part', id, i, n, s: text.slice(i * PART_SIZE, (i + 1) * PART_SIZE) }));
}

// Puts the pieces of long messages back together. add(piece) returns the whole message once its last
// piece is in (pieces come in order over one link, but a new message drops an unfinished one).
export class Parts {
  constructor() { this.id = null; this.list = []; }
  add(p) {
    if (!Number.isInteger(p.n) || !Number.isInteger(p.i) || typeof p.s !== 'string') return null;
    if (p.id !== this.id) { this.id = p.id; this.list = []; }
    this.list[p.i] = p.s;
    if (this.list.filter((x) => x !== undefined).length < p.n) return null;
    const text = this.list.join('');
    this.id = null;
    this.list = [];
    return parse(text);
  }
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
// The host's side of the link to one player: snapshots and scores as changes to the last ones
// sent (delta.js), the usual size of a snapshot on it, and the deaths of snapshots it skipped (they
// happen once, so the next snapshot carries them).
export class Outgoing {
  constructor() {
    this.encoder = new DeltaEncoder();
    this.snapBytes = 0;
    this.deaths = [];
  }

  // A snapshot went out, `bytes` long on the link: the usual size (a running average).
  sentSnap(bytes) {
    this.snapBytes = this.snapBytes ? this.snapBytes + (bytes - this.snapBytes) * 0.25 : bytes;
  }

  hold(snap) {
    this.deaths = latest(this.deaths.concat(snap.d || []), 4);
  }

  release(snap) {
    if (!this.deaths.length) return snap;
    const out = { ...snap, d: this.deaths.concat(snap.d || []) };
    this.deaths = [];
    return out;
  }
}

// The last MAX_CARRIED values of a flat list of `stride` values per entry.
function latest(list, stride) {
  const keep = Math.floor(MAX_CARRIED / stride) * stride;
  return list.length > keep ? list.slice(list.length - keep) : list;
}

// The lobby server takes messages up to 4 MB (server/index.js); a checkpoint is far smaller (about 250 KB
// for 2000 units on the march), but one that is not is never sent.
const MAX_CHECKPOINT = 3.5 * 1024 * 1024;
const HANDOVER_TIMEOUT_MS = 2000;    // the host leaves: its last checkpoint gets this long to go out

export class HostSession {
  // net: the lobby connection. roster: [{ id, color, goldPercent }]. balance: current balance values.
  // options: the game options the host picked in the waiting room. epoch: which hosting of this game
  // this is (the lobby server counts them up each time another browser takes the game over).
  // Taking over a game from a host who left: `save` (packed, from the lobby server) instead of the
  // roster, and `departed`, the ids of the players who left it.
  constructor({ net, gameId, you, epoch, title, options, roster, save = null, departed = [], ice, balance, onMessage, onError }) {
    this.isHost = true;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.epoch = epoch;
    this.ice = ice;
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.peers = new Map();          // player id -> { pc, channel, candidates }
    this.relayed = new Set();        // players without a direct link: their messages go through the server
    this.outgoing = new Map();       // player id -> Outgoing: what was last sent on their link
    this.handedOver = null;          // the host is leaving: resolves once its last checkpoint went out
    this.worker = new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
    this.worker.onerror = (e) => this.onError(`The game could not run: ${e.message || 'worker error'}`);
    this.worker.postMessage({ type: 'init', gameId, title, options, roster, save, departed, hostId: you, balance });
    // This page's own orders go straight to the worker.
    this.link = { send: (msg) => this.worker.postMessage({ type: 'msg', from: you, msg }) };
  }

  fromWorker(m) {
    if (m.type === 'send') {
      if (m.to === this.you) this.onMessage(m.msg);
      else this.sendTo(m.to, m.msg);
    } else if (m.type === 'checkpoint') {
      // For the lobby server, which hands the game to another player's browser if this one goes.
      if (m.data && m.data.length <= MAX_CHECKPOINT) {
        this.net.send({ t: 'checkpoint', gameId: this.gameId, epoch: this.epoch, data: m.data, active: m.active });
      }
      if (m.final && this.handedOver) this.handedOver();
    } else if (m.type === 'ended') {
      this.net.send({ t: 'gameEnded', winner: m.winner });
    } else if (m.type === 'error') {
      this.onError(m.msg);
    }
  }

  // The host leaves the game (Leave → Leave game): its empire falls apart here first, then the game as
  // it is now goes to the lobby server, which hands it to another player's browser. Resolves once that
  // checkpoint went out (or after HANDOVER_TIMEOUT_MS: the server then uses the one before).
  handOver() {
    this.link.send({ t: 'leave' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.handedOver(), HANDOVER_TIMEOUT_MS);
      this.handedOver = () => {
        clearTimeout(timer);
        this.handedOver = null;
        resolve();
      };
      this.worker.postMessage({ type: 'checkpoint' });
    });
  }

  // A game message for another player: over their direct link, or through the lobby server.
  sendTo(id, msg) {
    const relayed = this.relayed.has(id);
    const peer = relayed ? null : this.peers.get(id);
    const ch = peer?.channel;
    if (!relayed && (!ch || ch.readyState !== 'open')) return;
    let out = this.outgoing.get(id);
    if (!out) this.outgoing.set(id, (out = new Outgoing()));
    const snap = msg.t === 'snap';
    if (snap) {
      // Relayed players share this page's lobby connection.
      const buffered = relayed ? (this.net.ws ? this.net.ws.bufferedAmount : 0) : ch.bufferedAmount;
      const share = relayed ? this.relayed.size : 1;
      if (buffered > Math.max(MIN_BUFFERED, BEHIND_SNAPSHOTS * out.snapBytes * share)) {
        out.hold(msg);               // slow link: skip a frame
        return;
      }
      msg = out.release(msg);
    }
    const delta = out.encoder.encode(msg);
    const text = JSON.stringify(delta);
    if (relayed) {
      if (snap) out.sentSnap(text.length);
      // The relay takes a snapshot in one message (up to 1 MB); anything else long goes in pieces.
      const parts = snap ? null : splitMessage(text);
      for (const part of parts || [delta]) this.net.send({ t: 'relay', to: id, msg: part });
      return;
    }
    const parts = splitMessage(text);
    const texts = parts ? parts.map((p) => JSON.stringify(p)) : [text];
    if (!peer.deflate) {
      if (snap) out.sentSnap(text.length);
      for (const t of texts) ch.send(t);
      return;
    }
    // Compressed: each message starts compressing now, and they go out in order.
    for (const t of texts) {
      const data = t.length < COMPRESS_MIN ? t : deflate(t);
      peer.sending = peer.sending.then(() => data).then((d) => {
        if (snap) out.sentSnap(typeof d === 'string' ? d.length : d.byteLength);
        if (ch.readyState === 'open') ch.send(d);
      }).catch((e) => console.error('Could not send to a player:', e));
    }
  }

  // A player's page missed part of a snapshot or score (delta.js): their next ones go whole.
  resync(id) {
    this.outgoing.delete(id);
  }

  // A connection message from player `from`, passed on by the lobby server.
  async onSignal(from, data) {
    if (data.sdp && data.sdp.type === 'offer') {
      this.dropPeer(from, false);    // a new offer replaces an old link (the player reconnects)
      this.relayed.delete(from);
      const pc = new RTCPeerConnection(rtcConfig(this.ice));
      const peer = { pc, channel: null, candidates: new Candidates(pc), online: false, deflate: false, sending: Promise.resolve() };
      this.peers.set(from, peer);
      pc.onicecandidate = (e) => {
        if (e.candidate) this.net.send({ t: 'signal', to: from, data: { candidate: e.candidate.toJSON() } });
      };
      pc.ondatachannel = (e) => {
        const ch = (peer.channel = e.channel);
        peer.deflate = canDeflate && ch.protocol === DEFLATE;    // their page can decompress
        ch.onopen = () => {
          peer.online = true;
          this.worker.postMessage({ type: 'connect', id: from });
        };
        ch.onmessage = (ev) => {
          const msg = parse(ev.data);
          if (msg && msg.t === 'resync') this.resync(from);
          else if (msg) this.worker.postMessage({ type: 'msg', from, msg });
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
      this.outgoing.delete(from);
      if (this.relayed.delete(from)) this.worker.postMessage({ type: 'disconnect', id: from });
    } else if (this.relayed.has(from)) {
      if (msg.t === 'resync') this.resync(from);
      else this.worker.postMessage({ type: 'msg', from, msg });
    }
  }

  // The link to a player is gone. `tell`: let the game know they are offline.
  dropPeer(id, tell) {
    this.outgoing.delete(id);        // a new link starts with whole messages
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
  mountainEdit(msg) { this.worker.postMessage({ type: 'mountainEdit', cells: msg.cells, on: msg.on }); }
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
  // epoch: which hosting of the game this host is (see HostSession).
  constructor({ net, gameId, you, epoch, ice, onMessage, onLost, onStatus }) {
    this.isHost = false;
    this.net = net;
    this.gameId = gameId;
    this.you = you;
    this.epoch = epoch;
    this.onMessage = onMessage;
    this.onLost = onLost;
    this.onStatus = onStatus || (() => {});
    this.done = false;
    this.open = false;               // the direct link is open
    this.relay = false;              // playing through the lobby server instead
    this.started = false;            // the host's game has reached us
    this.parts = new Parts();        // long messages come in pieces (splitMessage)
    this.decoder = new DeltaDecoder();   // snapshots and scores come as changes (delta.js)
    this.resyncAt = 0;
    this.link = {
      send: (msg) => {
        if (this.relay) this.net.send({ t: 'relay', msg });
        else if (this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
      },
    };

    const pc = (this.pc = new RTCPeerConnection(rtcConfig(ice)));
    this.candidates = new Candidates(pc);
    // The protocol tells the host this page can take compressed messages.
    const ch = (this.channel = pc.createDataChannel('game', { ordered: true, protocol: canDeflate ? DEFLATE : '' }));
    ch.binaryType = 'arraybuffer';
    this.inbound = Promise.resolve();  // compressed messages are read in the order they came
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
      const text = typeof e.data === 'string' ? e.data : inflate(e.data);
      this.inbound = this.inbound.then(() => text).then((t) => {
        const msg = this.done ? null : parse(t);
        if (msg) this.receive(msg);
      }).catch((err) => console.error('Error with a message from the host:', err));
    };
    // The direct link failed, or died during the game (network change, a sleeping laptop, a
    // browser pausing a background tab): carry on through the server. If the host really left,
    // the lobby server hands the game to another player's browser and tells us to connect to it.
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
    if (msg.t === 'part') {
      const whole = this.parts.add(msg);
      if (whole) this.deliver(whole);
      return;
    }
    this.deliver(msg);
  }

  // Snapshots and scores come as changes to the last one (delta.js): rebuilt whole for the game.
  deliver(msg) {
    if (msg.t === 'delta') {
      const whole = this.decoder.decode(msg);
      if (!whole) {
        this.resync();
        return;
      }
      msg = whole;
    }
    this.onMessage(msg);
  }

  // A change to a message we never got (one was lost while the link switched): ask the host for
  // whole ones again. Once a second at most, while the answer is on its way.
  resync() {
    const now = Date.now();
    if (now - this.resyncAt < 1000) return;
    this.resyncAt = now;
    this.link.send({ t: 'resync' });
  }

  // The game is over: the host sends nothing more. If the link drops from now on (the host went back to
  // the lobby, or a duel restarts with a new game), there is nothing to reconnect to.
  gameOver() {
    this.over = true;
  }

  // The direct link died during the game.
  linkLost() {
    if (this.over) {
      this.destroy();
      return;
    }
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
