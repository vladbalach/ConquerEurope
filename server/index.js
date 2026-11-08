// HTTP static file server + WebSocket lobby and game loop.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { NavGrid } from './nav.js';
import { DEBUG } from '../shared/config.js';
import { iceConfig } from './ice.js';
import { PROTOCOL_VERSION } from '../shared/protocol.js';
import { applyBalance, resetBalance, snapshot } from '../shared/balance.js';
import { loadBalance, saveBalance } from './balance-store.js';
import { MapEditor } from './map-editor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');
const PORT = Number(process.env.PORT) || 3000;

const EMPTY_GAME_MS = 15 * 60 * 1000;   // a running game with nobody connected is deleted after this
const ENDED_GAME_MS = 2 * 60 * 1000;

const MAP_FILE = process.env.MAP_FILE || path.join(PUBLIC, 'map.json');
const NAV_FILE = process.env.NAV_FILE || path.join(ROOT, 'server', 'data', 'navgrid.json');
const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
const nav = NavGrid.load(NAV_FILE);

// Admin map editing (Edit map in a game): moved cities are saved in server/data/city-positions.json
// and apply to every game; "Rebuild navigation" rebuilds territories and pathfinding from them.
// Cities made coastal or inland are saved in server/data/city-coastal.json, painted beaches in
// server/data/beach-edits.json.
const editor = new MapEditor({
  map, nav, games: () => games.values(),
  files: {
    root: ROOT, map: MAP_FILE, nav: NAV_FILE,
    positions: process.env.CITY_POSITIONS || path.join(ROOT, 'server', 'data', 'city-positions.json'),
    coastal: process.env.CITY_COASTAL || path.join(ROOT, 'server', 'data', 'city-coastal.json'),
    beaches: process.env.BEACH_EDITS || path.join(ROOT, 'server', 'data', 'beach-edits.json'),
  },
});

// ------------------------------------------------------------------ admins and game balance
// Admins may change unit, upgrade and city stats while the server runs (Edit button in a game).
// Off: nobody is an admin, so the Edit and Edit map buttons are hidden. True makes every player an
// admin; later isAdmin() can check a list of names or accounts.
const EVERYONE_IS_ADMIN = false;
function isAdmin(client) {    // eslint-disable-line no-unused-vars
  return EVERYONE_IS_ADMIN;
}

// Balance changes are saved as overrides of shared/config.js and loaded again on start.
const BALANCE_FILE = process.env.BALANCE_FILE || path.join(ROOT, 'server', 'data', 'balance.json');
try {
  if (Object.keys(loadBalance(BALANCE_FILE)).length) {
    console.log(`Loaded game balance changes from ${path.relative(ROOT, BALANCE_FILE)}`);
  }
} catch (e) {
  console.warn(`Could not read ${BALANCE_FILE}: ${e.message}`);
}

function sendBalance(client, changed = false) {
  client.send({ t: 'balance', values: snapshot(), admin: !!client.admin, changed });
}

// ------------------------------------------------------------------ static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // The land grid, for the host's browser that simulates a game (and "show navigation").
  if (urlPath === '/navgrid.json') {
    fs.readFile(NAV_FILE, (err, data) => {
      if (err) { res.writeHead(500).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  let base = PUBLIC;
  if (urlPath.startsWith('/shared/')) {
    base = SHARED;
    urlPath = urlPath.slice('/shared'.length);
  } else if (urlPath.startsWith('/sim/')) {
    // The game simulation (server/*.js) runs in the host player's browser too. Code only, no data.
    if (path.extname(urlPath) !== '.js' || urlPath.includes('/data/')) {
      res.writeHead(404).end();
      return;
    }
    base = path.join(ROOT, 'server');
    urlPath = urlPath.slice('/sim'.length);
  }
  // The map comes from memory: it includes cities admins have moved (Edit map).
  if (urlPath === '/map.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    res.end(editor.mapJson());
    return;
  }
  // Debug builds only: the navigation grid for the console's "show navigation".
  if (DEBUG && urlPath === '/debug/navgrid') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(nav.debugExport()));
    return;
  }
  // The debug tools' browser code is not served at all outside debug builds.
  if (!DEBUG && urlPath.startsWith('/js/debug/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(base, urlPath));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ------------------------------------------------------------------ lobby
const clients = new Set();
const games = new Map();
let nextGameId = 1;
let lobbyDirty = false;

const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

// Lobby view for one client: every game with its players, flagged when this client
// can rejoin it, plus the names of everyone currently browsing the lobby.
function gameList(client) {
  return [...games.values()].map((g) => ({
    ...g.publicInfo(),
    rejoin: !!g.findRejoinable(client.name, client.tokens[g.id]),
  }));
}

function lobbyNames() {
  return [...clients].filter((c) => c.name && !c.game).map((c) => c.name);
}

function sendGameList(client) {
  client.send({ t: 'games', games: gameList(client), lobby: lobbyNames() });
}

function readTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, token] of Object.entries(raw).slice(0, 50)) {
    if (typeof token === 'string' && token.length <= 64) out[String(id)] = token;
  }
  return out;
}

// Only running games can be rejoined. The game itself runs in its host's browser, which tells the
// players about returns, so the lobby only records who is online.
function rejoin(client, game, player) {
  if (client.game && client.game !== game) leaveCurrent(client);
  if (player.client && player.client !== client) {
    const old = player.client;
    old.game = null;
    old.player = null;
    old.send({ t: 'kicked', msg: 'You opened this game in another tab' });
  }
  player.client = client;
  player.connected = true;
  player.disconnectedAt = 0;
  client.game = game;
  client.player = player;
  sendJoined(client);
  lobbyDirty = true;
}

function joinGame(client, game) {
  const res = game.addPlayer(client);
  if (res.error) {
    client.send({ t: 'error', msg: res.error });
    return;
  }
  client.game = game;
  client.player = res.player;
  sendJoined(client);
  lobbyDirty = true;
}

function sendJoined(client) {
  const g = client.game, p = client.player;
  client.send({
    t: 'joined', gameId: g.id, playerId: p.id, token: p.token, title: g.title, status: g.status,
    protocol: PROTOCOL_VERSION,
  });
  if (g.status === 'lobby') g.broadcastRoom();
  else if (g.status === 'running') resumeHosted(client, g, p);
}

function leaveCurrent(client) {
  const g = client.game;
  if (!g) return;
  const p = client.player;
  if (g.status === 'lobby') {
    g.removePlayer(p.id);
  } else {
    // Giving up a running game: the player's page has told the host already. When the host
    // leaves, the game is over for everyone.
    if (g.status === 'running' && p.id === g.hostId) endHosted(g, -1, 'The host left the game.');
    g.players.delete(p.id);
  }
  client.game = null;
  client.player = null;
  if (g.players.size === 0) games.delete(g.id);
  lobbyDirty = true;
}

// ------------------------------------------------------------------ browser-to-browser games
// A started game runs in its host player's browser (server/host-engine.js in a Web Worker). Every
// other player connects to the host directly (WebRTC). This server only hands the game over,
// passes the connection messages between players and host, and reveals everyone at the end.

// Start: the host gets the roster (ids and colours, never nicknames), everyone else is told to
// connect to the host.
async function handOver(g) {
  const ice = await iceConfig();
  const roster = [...g.players.values()].map((p) => ({ id: p.id, color: p.color }));
  for (const p of g.players.values()) {
    if (!p.client) continue;
    if (p.id === g.hostId) {
      p.client.hosting = g.id;
      p.client.send({ t: 'host', gameId: g.id, you: p.id, title: g.title, options: g.options, roster, ice });
    } else {
      p.client.send({ t: 'connectHost', gameId: g.id, you: p.id, ice });
    }
  }
}

// A player came back to a running game (refresh, new tab, dropped connection).
async function resumeHosted(client, g, p) {
  if (p.id === g.hostId) {
    // After a dropped connection the host's page still runs the game. A reloaded page lost it.
    if (client.hosting !== g.id) endHosted(g, -1, 'The host left the game.');
    return;
  }
  const ice = await iceConfig();
  client.send({ t: 'connectHost', gameId: g.id, you: p.id, ice });
}

// The game is over (the host says who won, or the host left): everyone is revealed with their
// nickname and colour (GAME_DESIGN.md, "Anonymous players").
function endHosted(g, winner, reason = null) {
  if (g.status !== 'running') return;
  g.status = 'ended';
  g.winner = winner;
  g.endedAt = Date.now();
  const players = [...g.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color }));
  for (const p of g.players.values()) {
    if (p.client) p.client.send({ t: 'reveal', winner, players, reason });
  }
  lobbyDirty = true;
}

function handle(client, msg) {
  switch (msg.t) {
    case 'hello': {
      client.name = clean(msg.name, 20);
      if (!client.name) {
        client.send({ t: 'error', msg: 'Please enter a name' });
        return;
      }
      client.tokens = readTokens(msg.tokens);
      // The game this page is running as host, if any (it survives a dropped connection).
      client.hosting = typeof msg.hosting === 'string' ? msg.hosting : null;
      client.admin = isAdmin(client);
      sendBalance(client);           // current balance (and admin rights) before anything else
      if (client.admin) client.send({ t: 'mapState', ...editor.state() });
      // Same tab reconnecting (page refresh, network drop): resume silently.
      const r = msg.resume;
      if (r && typeof r === 'object' && typeof r.token === 'string') {
        const g = games.get(String(r.gameId));
        const p = g ? g.findRejoinable(null, r.token) : null;
        if (p) {
          rejoin(client, g, p);
          return;
        }
      }
      client.send({ t: 'welcome', name: client.name, protocol: PROTOCOL_VERSION });
      sendGameList(client);
      lobbyDirty = true;
      return;
    }
    case 'list':
      sendGameList(client);
      return;
    case 'create': {
      if (!client.name) return;
      leaveCurrent(client);
      const title = clean(msg.title, 32) || `${client.name}'s game`;
      const g = new Game({ id: String(nextGameId++), title, map, nav });
      games.set(g.id, g);
      joinGame(client, g);
      return;
    }
    case 'join': {
      if (!client.name) return;
      const g = games.get(String(msg.gameId));
      if (!g) {
        client.send({ t: 'error', msg: 'That game no longer exists' });
        sendGameList(client);
        return;
      }
      if (client.game === g) {
        sendJoined(client);
        return;
      }
      if (g.status === 'running') {
        // Only players who were already in this game may come back.
        const token = typeof msg.token === 'string' ? msg.token : client.tokens[g.id];
        const p = g.findRejoinable(client.name, token);
        if (p) rejoin(client, g, p);
        else client.send({ t: 'error', msg: 'This game has already started' });
        return;
      }
      leaveCurrent(client);
      joinGame(client, g);
      return;
    }
    case 'leave':
      leaveCurrent(client);
      sendGameList(client);
      return;
    case 'start': {
      const g = client.game;
      if (g && g.status === 'lobby' && client.player && g.hostId === client.player.id && g.beginStart()) {
        handOver(g);                   // the host's browser runs the game from here on
        lobbyDirty = true;
      }
      return;
    }
    case 'setOptions': {
      // Game options (cities to win, countdown): only the host, only in the waiting room.
      const g = client.game;
      if (g && client.player && g.hostId === client.player.id && g.setOptions(msg.options)) lobbyDirty = true;
      return;
    }
    case 'signal': {
      // WebRTC connection messages (offer, answer, ICE candidates) between a player and the host.
      // Players reach only the host; the host reaches any player of its game.
      const g = client.game, p = client.player;
      if (!g || !p || g.status !== 'running' || !msg.data || typeof msg.data !== 'object') return;
      const target = g.players.get(p.id === g.hostId ? msg.to : g.hostId);
      if (!target || target === p || !target.client) return;
      target.client.send({ t: 'signal', from: p.id, data: msg.data });
      return;
    }
    case 'gameEnded': {
      // Only the host knows the outcome of a game it runs.
      const g = client.game, p = client.player;
      if (g && p && g.status === 'running' && p.id === g.hostId) endHosted(g, Number.isInteger(msg.winner) ? msg.winner : -1);
      return;
    }
    case 'ping':
      return;                          // keeps the connection (and a sleeping free host) awake
    case 'relay': {
      // Fallback when a player's browser cannot open a direct link to the host (some mobile,
      // company or home networks block it): their game messages go through this server.
      // Players reach only the host; the host reaches any player of its game.
      const g = client.game, p = client.player;
      if (!g || !p || g.status !== 'running' || !msg.msg || typeof msg.msg !== 'object') return;
      if (p.id === g.hostId) {
        const target = g.players.get(msg.to);
        if (target && target !== p && target.client) target.client.send({ t: 'relay', msg: msg.msg });
      } else {
        const host = g.players.get(g.hostId);
        if (host && host.client) host.client.send({ t: 'relay', from: p.id, msg: msg.msg });
      }
      return;
    }
    case 'setBalance':
    case 'resetBalance': {
      // Admins change unit, upgrade and city stats for everyone, effective immediately.
      if (!client.admin) {
        client.send({ t: 'error', msg: 'Only admins can change the game balance' });
        return;
      }
      if (msg.t === 'resetBalance') {
        resetBalance();
      } else if (!Object.keys(applyBalance(msg.values)).length) {
        return;
      }
      saveBalance(BALANCE_FILE);
      for (const c of clients) if (c.name) sendBalance(c, true);
      return;
    }
    case 'mapMove':
    case 'mapCoast':
    case 'mapBeach':
    case 'mapRebuild':
      // Edit map: admins only. MapEditor.handle refuses it from anyone else, whatever the page shows.
      editor.handle(client, msg, clients);
      return;
    default:
      if (client.game && client.player) client.game.handleCommand(client.player, msg);
  }
}

// Relayed game snapshots can be large: allow 1 MB messages, and compress (snapshots shrink
// several times), which keeps a free host's monthly bandwidth for longer.
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
});

wss.on('connection', (ws) => {
  const client = {
    ws, name: '', game: null, player: null, tokens: {},
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
  };
  clients.add(client);
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(client, msg);
    } catch (e) {
      console.error('Error handling', msg.t, e);
    }
  });
  ws.on('close', () => {
    clients.delete(client);
    const g = client.game, p = client.player;
    if (g && p) {
      if (g.status === 'lobby') {
        g.disconnect(p);
      } else if (p.client === client) {
        // The game runs in the host's browser and goes on; the lobby only notes who is offline.
        p.client = null;
        p.connected = false;
        p.disconnectedAt = Date.now();
        // A player relayed through this server is now cut off from the host: tell the host.
        const host = g.status === 'running' && p.id !== g.hostId ? g.players.get(g.hostId) : null;
        if (host && host.client) host.client.send({ t: 'relay', from: p.id, msg: { t: 'relayClose' } });
      }
      if (g.players.size === 0) games.delete(g.id);
      lobbyDirty = true;
    }
  });
});

// ------------------------------------------------------------------ loops
// No simulation here: games run in their host player's browser (server/host-engine.js).

// Housekeeping: delete abandoned or finished games, refresh lobby lists.
// Disconnected players are never removed: they can rejoin until the game ends.
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    const connected = [...g.players.values()].some((p) => p.connected);
    if (connected) g.emptySince = 0;
    else if (!g.emptySince) g.emptySince = now;
    const expired =
      g.players.size === 0 ||
      (g.emptySince && now - g.emptySince > EMPTY_GAME_MS) ||
      (g.status === 'ended' && now - g.endedAt > ENDED_GAME_MS);
    if (expired) {
      for (const p of g.players.values()) {
        if (p.client) { p.client.game = null; p.client.player = null; }
      }
      games.delete(g.id);
      lobbyDirty = true;
    }
  }
  if (lobbyDirty) {
    lobbyDirty = false;
    for (const c of clients) if (c.name && !c.game) sendGameList(c);
  }
}, 1000).unref();      // unref: lets tests import this file and exit

// Exported so test harnesses can run the server in-process and inspect games.
export { games };

export function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const real = server.address().port;
      console.log(`Conquest of Europa running at http://localhost:${real}`);
      // Other players on the same network (Wi-Fi, LAN) open one of these addresses.
      const lan = Object.values(os.networkInterfaces()).flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal)
        .map((a) => `http://${a.address}:${real}`);
      if (lan.length) console.log(`Players on your network: ${lan.join('  or  ')}`);
      if (DEBUG) console.log('DEBUG mode is ON (shared/config.js). Set DEBUG = false before publishing.');
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
