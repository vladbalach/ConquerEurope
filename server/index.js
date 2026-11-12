// HTTP static file server + WebSocket lobby and game loop.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { NavGrid } from './nav.js';
import { DEBUG, GAME } from '../shared/config.js';
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
// A spectator whose connection closed during a game can come back to it (a refresh) for this long.
const SPECTATOR_AWAY_MS = 2 * 60 * 1000;
// Every connection is pinged this often (browsers answer by themselves); one silent for SILENT_MS is
// dropped. A host whose browser crashed or lost its network is noticed this way, not minutes later.
const HEARTBEAT_MS = 5000;
const SILENT_MS = 15000;
// Changeable by tests. hostGrace: ms a host's dropped lobby connection gets to come back before another
// player's browser takes the game over (a closed or reloaded page says so, and is replaced at once).
export const timing = { hostGrace: 5000 };

const MAP_FILE = process.env.MAP_FILE || path.join(PUBLIC, 'map.json');
const NAV_FILE = process.env.NAV_FILE || path.join(ROOT, 'server', 'data', 'navgrid.json');
const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
const nav = NavGrid.load(NAV_FILE);

// Admin map editing (Edit map in a game): moved cities are saved in server/data/city-positions.json
// and apply to every game; "Rebuild navigation" rebuilds territories and pathfinding from them.
// Cities made coastal or inland are saved in server/data/city-coastal.json, painted beaches in
// server/data/beach-edits.json, painted mountains in server/data/mountain-edits.json, region names moved
// or resized in server/data/label-edits.json.
const editor = new MapEditor({
  map, nav, games: () => games.values(),
  files: {
    root: ROOT, map: MAP_FILE, nav: NAV_FILE,
    positions: process.env.CITY_POSITIONS || path.join(ROOT, 'server', 'data', 'city-positions.json'),
    coastal: process.env.CITY_COASTAL || path.join(ROOT, 'server', 'data', 'city-coastal.json'),
    beaches: process.env.BEACH_EDITS || path.join(ROOT, 'server', 'data', 'beach-edits.json'),
    mountains: process.env.MOUNTAIN_EDITS || path.join(ROOT, 'server', 'data', 'mountain-edits.json'),
    labels: process.env.LABEL_EDITS || path.join(ROOT, 'server', 'data', 'label-edits.json'),
  },
});

// ------------------------------------------------------------------ admins and game balance
// Admins may change unit, upgrade and city stats while the server runs (Edit button in a game).
// For now every player is an admin; later this can check a list of names or accounts.
const EVERYONE_IS_ADMIN = true;
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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

// Text files go gzipped to browsers that take it (about 3 times smaller). Every file has an ETag:
// browsers ask again on each load ('no-cache', so changes show at once) and get "304 Not Modified",
// without the file, when it didn't change.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const gzipped = new Map();               // ETag -> gzipped file
const fileTag = (st) => `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
const textTag = (text) => `W/"${crypto.createHash('sha1').update(text).digest('base64url')}"`;

function unchanged(req, tag) {
  const have = req.headers['if-none-match'];
  return !!have && have.split(',').some((t) => t.trim() === tag);
}

function sendFile(req, res, ext, tag, body) {
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: tag };
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
  if (unchanged(req, tag)) {
    res.writeHead(304, headers).end();
    return;
  }
  if (COMPRESSIBLE.has(ext) && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let gz = gzipped.get(tag);
    if (!gz) {
      if (gzipped.size >= 500) gzipped.clear();      // files changed many times: start over
      gz = zlib.gzipSync(body);
      gzipped.set(tag, gz);
    }
    headers['Content-Encoding'] = 'gzip';
    body = gz;
  }
  res.writeHead(200, headers).end(body);
}

// A file from disk; not read at all when the browser has it already.
function sendFromDisk(req, res, file, notFound) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { notFound(); return; }
    const tag = fileTag(st);
    if (unchanged(req, tag)) { sendFile(req, res, path.extname(file), tag, null); return; }
    fs.readFile(file, (err2, data) => {
      if (err2) notFound();
      else sendFile(req, res, path.extname(file), tag, data);
    });
  });
}

let mapTag = { json: null, tag: null };  // the map changes when admins move cities (Edit map)

// ------------------------------------------------------------------ search engines
// The page names its own address (canonical link, link previews, structured data: index.html has
// %SITE_URL% there), and robots.txt points search engines to sitemap.xml. SITE_URL is the public address
// players open, such as https://conquest.example.com. Without it, the address the request came to
// (behind a proxy that says so, https). Only plain URL characters, so it goes into HTML and JSON as it is.
const SITE_URL = (() => {
  const raw = (process.env.SITE_URL || '').trim();
  if (!raw) return '';
  let url = null;
  try { url = new URL(raw); } catch { /* reported below */ }
  const site = url && /^https?:$/.test(url.protocol) ? (url.origin + url.pathname).replace(/\/+$/, '') : '';
  if (!site || !/^[\w.~:/%[\]-]+$/.test(site)) {
    console.warn(`SITE_URL is not a web address, so it is not used: ${raw}`);
    return '';
  }
  return site;
})();

function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = /^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

// The page itself, with the site's address put in. Read again when index.html changes.
const INDEX_FILE = path.join(PUBLIC, 'index.html');
let indexTemplate = { mtimeMs: -1, text: '' };
const indexPages = new Map();             // site address -> { body, tag }

function sendIndex(req, res) {
  fs.stat(INDEX_FILE, (err, st) => {
    if (err) { res.writeHead(500).end(); return; }
    const send = () => {
      const site = siteUrl(req);
      let page = indexPages.get(site);
      if (!page) {
        if (indexPages.size >= 20) indexPages.clear();       // many host names: start over
        const body = Buffer.from(indexTemplate.text.replaceAll('%SITE_URL%', site));
        page = { body, tag: textTag(body) };
        indexPages.set(site, page);
      }
      sendFile(req, res, '.html', page.tag, page.body);
    };
    if (indexTemplate.mtimeMs === st.mtimeMs) { send(); return; }
    fs.readFile(INDEX_FILE, 'utf8', (err2, text) => {
      if (err2) { res.writeHead(500).end(); return; }
      indexTemplate = { mtimeMs: st.mtimeMs, text };
      indexPages.clear();
      send();
    });
  });
}

function sendText(req, res, ext, text) {
  sendFile(req, res, ext, textTag(text), Buffer.from(text));
}

const robotsTxt = (site) => `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`;
// The game is one page: the lobby, waiting rooms and games all run in it.
const sitemapXml = (site) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + `  <url><loc>${site}/</loc></url>\n`
  + '</urlset>\n';

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
    sendFromDisk(req, res, NAV_FILE, () => res.writeHead(500).end());
    return;
  }
  if (urlPath === '/' || urlPath === '/index.html') { sendIndex(req, res); return; }
  if (urlPath === '/robots.txt') { sendText(req, res, '.txt', robotsTxt(siteUrl(req))); return; }
  if (urlPath === '/sitemap.xml') { sendText(req, res, '.xml', sitemapXml(siteUrl(req))); return; }
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
    const json = editor.mapJson();
    if (mapTag.json !== json) mapTag = { json, tag: textTag(json) };
    sendFile(req, res, '.json', mapTag.tag, json);
    return;
  }
  // Debug builds only: the navigation grid for the console's "show navigation".
  if (DEBUG && urlPath === '/debug/navgrid') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(nav.debugExport()));
    return;
  }
  const file = path.normalize(path.join(base, urlPath));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  sendFromDisk(req, res, file, () => res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'));
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

// ------------------------------------------------------------------ spectators
// Anyone in the lobby may watch a game (Watch): in the waiting room beside its players, or a game in
// progress. A spectator has no place in the game (the 20 players stay 20), no colour, and is never its
// host. client.player is their spectator record (Game.addSpectator), with `spectator: true`.
function watchGame(client, game) {
  const res = game.addSpectator(client);
  if (res.error) {
    client.send({ t: 'error', msg: res.error });
    return;
  }
  client.game = game;
  client.player = res.spectator;
  sendJoined(client);
  lobbyDirty = true;
}

// A spectator's page was refreshed, or their connection came back: they watch on.
function rewatch(client, game, s) {
  if (client.game && client.game !== game) leaveCurrent(client);
  if (s.client && s.client !== client) {
    const old = s.client;
    old.game = null;
    old.player = null;
    old.send({ t: 'kicked', msg: 'You opened this game in another tab' });
  }
  s.client = client;
  s.connected = true;
  s.disconnectedAt = 0;
  client.game = game;
  client.player = s;
  sendJoined(client);
  lobbyDirty = true;
}

// In the waiting room a player may become a spectator and back. The game keeps at least one player (its
// host's browser runs it); a host who watches instead hands the room to the next player.
function setRole(client, role) {
  const g = client.game, p = client.player;
  if (!g || !p || g.status !== 'lobby') return;
  let res;
  if (role === 'spectator' && !p.spectator) {
    if (g.players.size <= 1) {
      client.send({ t: 'error', msg: 'Someone has to play: the game needs at least one player' });
      return;
    }
    res = g.addSpectator(client);
    if (!res.error) {
      g.removePlayer(p.id);
      client.player = res.spectator;
    }
  } else if (role === 'player' && p.spectator) {
    res = g.addPlayer(client);
    if (!res.error) {
      g.removeSpectator(p.id);
      client.player = res.player;
    }
  } else {
    return;
  }
  if (res.error) {
    client.send({ t: 'error', msg: res.error });
    return;
  }
  sendJoined(client);                  // a new id and token; everyone in the room sees the change
  lobbyDirty = true;
}

// Every spectator of game g still watching it.
function spectatorsOf(g) {
  return [...g.spectators.values()].filter((s) => s.client && s.client.game === g);
}

function sendJoined(client) {
  const g = client.game, p = client.player;
  client.send({
    t: 'joined', gameId: g.id, playerId: p.id, token: p.token, title: g.title, status: g.status,
    ...(p.spectator ? { spectator: true } : {}), protocol: PROTOCOL_VERSION,
  });
  if (g.status === 'lobby') g.broadcastRoom();
  else if (g.status === 'running') resumeHosted(client, g, p);
}

function leaveCurrent(client) {
  const g = client.game;
  if (!g) return;
  const p = client.player;
  if (p.spectator) {
    // Nothing changes in the game. Their page has told the host already (or its link just closes).
    g.removeSpectator(p.id);
    client.game = null;
    client.player = null;
    lobbyDirty = true;
    return;
  }
  if (g.status === 'lobby') {
    g.removePlayer(p.id);
  } else {
    // Giving up a running game: the player's page has told the host already. When the host
    // leaves, another player's browser takes the game over.
    const wasHost = g.status === 'running' && p.id === g.hostId;
    // Kept for the end of the game, when everyone is revealed, those who gave up too.
    if (g.status === 'running') (g.departed || (g.departed = [])).push({ id: p.id, name: p.name, color: p.color });
    g.players.delete(p.id);
    if (wasHost) moveHost(g);
    sendRestartState(g);               // a finished duel: the other player can no longer restart it
  }
  client.game = null;
  client.player = null;
  if (g.players.size === 0) deleteGame(g, 'Every player has left the game');
  lobbyDirty = true;
}

// A game is deleted. Its spectators go back to the lobby, told why; those of a finished game stay on
// its results screen (like its players), only no longer in it.
function deleteGame(g, reason = 'The game was closed') {
  clearTimeout(g.hostTimer);
  games.delete(g.id);
  for (const s of spectatorsOf(g)) {
    const c = s.client;
    c.game = null;
    c.player = null;
    if (g.status !== 'ended') c.send({ t: 'kicked', msg: reason });
  }
}

// ------------------------------------------------------------------ duels: Restart
// A game started by two players is a duel. Once it is over, both players see Restart on the results
// screen; when both have pressed it, the same game starts again at once, without the waiting room:
// new ids and colours, handed to the same host. Only while both are still on the results screen.
function restartState(g) {
  if (g.status !== 'ended' || g.startedWith !== 2) return null;
  const open = g.players.size === 2 && [...g.players.values()].every((p) => p.client);
  const votes = [...(g.restartVotes || [])].filter((id) => g.players.has(id));
  return { votes, open };
}

function sendRestartState(g) {
  const state = restartState(g);
  if (!state) return;
  for (const p of g.players.values()) if (p.client) p.client.send({ t: 'restartVotes', ...state });
}

function restartGame(g) {
  g.restartVotes = null;
  g.departed = null;
  if (!g.players.has(g.hostId)) g.hostId = g.players.keys().next().value ?? null;   // its host left the game
  if (!g.restart()) return;
  // Pages drop the finished game first; the host's start follows, as for a game started in the room.
  // Its spectators watch the new one.
  for (const p of g.players.values()) p.client.send({ t: 'restarted', gameId: g.id });
  for (const s of spectatorsOf(g)) s.client.send({ t: 'restarted', gameId: g.id });
  handOver(g);
  lobbyDirty = true;
}

// ------------------------------------------------------------------ browser-to-browser games
// A started game runs in its host player's browser (server/host-engine.js in a Web Worker). Every
// other player connects to the host directly (WebRTC). This server only hands the game over,
// passes the connection messages between players and host, and reveals everyone at the end.
//
// The host's browser sends a checkpoint of the game every GAME.checkpointEvery seconds (packed, never
// read here). When the host leaves, or its page is closed or reloaded, or its connection is gone for
// longer than timing.hostGrace, another player's browser takes the game over from the last checkpoint
// (moveHost), and the old host can come back as any other player. Each hosting of a game has its own
// number (g.hostEpoch): pages tell an old host from the current one by it.

// Does this page run the current hosting of game g?
function runsGame(client, g) {
  const h = client.hosting;
  return !!h && h.gameId === g.id && h.epoch === g.hostEpoch;
}

// Spectators connect to the host like players, with their own ids (never in the roster).
function connectSpectators(g, ice, moved = false) {
  for (const s of spectatorsOf(g)) {
    s.client.send({ t: 'connectHost', gameId: g.id, you: s.id, epoch: g.hostEpoch, ice, ...(moved ? { moved: true } : {}) });
  }
}

// Start: the host gets the roster (ids and colours, never nicknames), everyone else is told to
// connect to the host.
async function handOver(g) {
  clearTimeout(g.hostTimer);
  g.checkpoint = null;
  const epoch = (g.hostEpoch = (g.hostEpoch || 0) + 1);
  const ice = await iceConfig();
  if (g.hostEpoch !== epoch || g.status !== 'running') return;
  // With each player's gold percentage (set in the waiting room): the host's browser pays them by it.
  const roster = [...g.players.values()].map((p) => ({ id: p.id, color: p.color, goldPercent: p.goldPercent }));
  for (const p of g.players.values()) {
    if (!p.client) continue;
    if (p.id === g.hostId) {
      p.client.hosting = { gameId: g.id, epoch };
      p.client.send({ t: 'host', gameId: g.id, you: p.id, epoch, title: g.title, options: g.options, roster, ice });
    } else {
      p.client.send({ t: 'connectHost', gameId: g.id, you: p.id, epoch, ice });
    }
  }
  connectSpectators(g, ice);
}

// Another player's browser takes the game over from the host's last checkpoint, and everyone else
// connects to it. Players still in the game come first. With nobody online the game has no host until
// the first player comes back (resumeHosted). Without a checkpoint (the host went within a second of
// the start) the game is over.
async function moveHost(g) {
  clearTimeout(g.hostTimer);
  g.hostTimer = 0;
  if (g.status !== 'running') return;
  if (!g.checkpoint) {
    endHosted(g, -1, 'The host left the game.');
    return;
  }
  const online = [...g.players.values()].filter((p) => p.client);
  const next = online.find((p) => g.checkpoint.active.includes(p.id)) || online[0] || null;
  g.hostId = next ? next.id : null;
  lobbyDirty = true;
  if (!next) return;
  const epoch = ++g.hostEpoch;
  next.client.hosting = { gameId: g.id, epoch };
  const ice = await iceConfig();
  if (g.hostEpoch !== epoch || g.status !== 'running') return;    // moved on meanwhile
  // Players who left through the lobby: their empire falls apart in the new host's game too.
  const departed = (g.departed || []).map((d) => d.id);
  for (const p of g.players.values()) {
    if (!p.client) continue;
    if (p === next) {
      p.client.send({
        t: 'host', gameId: g.id, you: p.id, epoch, title: g.title, options: g.options, save: g.checkpoint.data, departed, ice,
      });
    } else {
      p.client.send({ t: 'connectHost', gameId: g.id, you: p.id, epoch, ice, moved: true });
    }
  }
  connectSpectators(g, ice, true);
}

// The host's lobby connection closed. A page that runs the game may only have lost its network for a
// moment: it gets timing.hostGrace to come back. A page that said it is going (closed, reloaded) is
// replaced at once.
function hostAway(g, client) {
  clearTimeout(g.hostTimer);
  if (!runsGame(client, g)) {
    moveHost(g);
    return;
  }
  g.hostTimer = setTimeout(() => moveHost(g), timing.hostGrace);
  g.hostTimer.unref?.();
}

// A player came back to a running game (refresh, new tab, dropped connection). A spectator came to watch
// it, or back: they connect to its host, if it has one (with nobody online it waits for the first player
// to come back, and tells its spectators to connect then, as moveHost does).
async function resumeHosted(client, g, p) {
  if (p.spectator) {
    if (g.hostId === null) return;
    const ice = await iceConfig();
    if (client.player === p && g.status === 'running') {
      client.send({ t: 'connectHost', gameId: g.id, you: p.id, epoch: g.hostEpoch, ice });
    }
    return;
  }
  if (runsGame(client, g) && (g.hostId === p.id || g.hostId === null)) {
    // The host's connection dropped and came back: its page still runs the game, and stays the host.
    // Players relayed through this server lost it meanwhile: told again, they pick their relay up again.
    clearTimeout(g.hostTimer);
    g.hostTimer = 0;
    g.hostId = p.id;
    lobbyDirty = true;
    const ice = await iceConfig();
    for (const q of g.players.values()) {
      if (q !== p && q.client) q.client.send({ t: 'connectHost', gameId: g.id, you: q.id, epoch: g.hostEpoch, ice });
    }
    connectSpectators(g, ice);
    return;
  }
  if (g.hostId === p.id || g.hostId === null) {
    // The host's page was reloaded (it lost the game it ran), or nobody runs the game: it moves, maybe
    // to this very page.
    moveHost(g);
    return;
  }
  const ice = await iceConfig();
  client.send({ t: 'connectHost', gameId: g.id, you: p.id, epoch: g.hostEpoch, ice });
}

// The game is over (the host says who won, or the host left): everyone is revealed with their
// nickname and colour (GAME_DESIGN.md, "Anonymous players").
function endHosted(g, winner, reason = null) {
  if (g.status !== 'running') return;
  clearTimeout(g.hostTimer);
  g.checkpoint = null;
  g.status = 'ended';
  g.winner = winner;
  g.endedAt = Date.now();
  const players = [...g.players.values(), ...(g.departed || [])].map((p) => ({ id: p.id, name: p.name, color: p.color }));
  for (const p of g.players.values()) {
    if (p.client) p.client.send({ t: 'reveal', winner, players, reason });
  }
  for (const s of spectatorsOf(g)) s.client.send({ t: 'reveal', winner, players, reason });
  sendRestartState(g);                 // a duel: Restart on the results screen
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
      // The game this page is running as host, if any (it survives a dropped connection): { gameId, epoch }.
      const h = msg.hosting;
      client.hosting = h && typeof h === 'object' && typeof h.gameId === 'string' && Number.isInteger(h.epoch)
        ? { gameId: h.gameId, epoch: h.epoch } : null;
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
        const s = g ? g.findSpectator(r.token) : null;
        if (s) {
          rewatch(client, g, s);
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
    case 'watch': {
      // Watch a game as a spectator: a waiting one (from its room) or one in progress.
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
      const err = g.canWatch();
      if (err) {
        client.send({ t: 'error', msg: err });
        return;
      }
      leaveCurrent(client);
      watchGame(client, g);
      return;
    }
    case 'setRole':
      // The waiting room: play (`role: 'player'`) or watch (`role: 'spectator'`) instead.
      setRole(client, msg.role);
      return;
    case 'leave':
      // `gameId`: only that game. A host's page sends its leave once its last checkpoint is out, by
      // when the player may be in another game already.
      if (msg.gameId !== undefined && client.game && client.game.id !== String(msg.gameId)) return;
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
    case 'setGoldPercent': {
      // A player's gold percentage (`player`: their id in the waiting room): only the host, only there.
      const g = client.game;
      if (g && client.player && g.hostId === client.player.id) g.setGoldPercent(msg.player, msg.percent);
      return;
    }
    case 'signal': {
      // WebRTC connection messages (offer, answer, ICE candidates) between a player and the host.
      // Players and spectators reach only the host; the host reaches any player or spectator of its game.
      const g = client.game, p = client.player;
      if (!g || !p || g.status !== 'running' || !msg.data || typeof msg.data !== 'object') return;
      const target = p.id === g.hostId ? g.member(msg.to) : g.players.get(g.hostId);
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
    case 'checkpoint': {
      // The game as the current host runs it now (packed by its browser, never read here), for the next
      // host if this one goes. `active`: players still in the game, preferred as the next host.
      const g = client.game, p = client.player;
      if (!g || !p || g.status !== 'running' || p.id !== g.hostId || msg.epoch !== g.hostEpoch) return;
      if (typeof msg.data !== 'string' || !msg.data) return;
      const active = Array.isArray(msg.active) ? msg.active.filter(Number.isInteger).slice(0, GAME.maxPlayers) : [];
      g.checkpoint = { data: msg.data, active };
      return;
    }
    case 'hostGone': {
      // The host's page is being closed or reloaded: once its connection closes, the game moves at once.
      const g = client.game, p = client.player;
      if (g && p && p.id === g.hostId) client.hosting = null;
      return;
    }
    case 'restart': {
      // A player of a finished duel wants to play it again. Once both do, it starts again.
      const g = client.game, p = client.player;
      const state = g && p && !p.spectator ? restartState(g) : null;
      if (!state || !state.open) return;
      (g.restartVotes || (g.restartVotes = new Set())).add(p.id);
      if ([...g.players.keys()].every((id) => g.restartVotes.has(id))) restartGame(g);
      else sendRestartState(g);
      return;
    }
    case 'ping':
      return;                          // keeps the connection (and a sleeping free host) awake
    case 'relay': {
      // Fallback when a player's browser cannot open a direct link to the host (some mobile,
      // company or home networks block it): their game messages go through this server.
      // Players and spectators reach only the host; the host reaches any player or spectator of its game.
      const g = client.game, p = client.player;
      if (!g || !p || g.status !== 'running' || !msg.msg || typeof msg.msg !== 'object') return;
      if (p.id === g.hostId) {
        const target = g.member(msg.to);
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
    case 'mapMountain':
    case 'mapLabel':
    case 'mapRebuild':
      // Edit map: admins only. MapEditor.handle refuses it from anyone else, whatever the page shows.
      editor.handle(client, msg, clients);
      return;
    default:
      if (client.game && client.player && !client.player.spectator) client.game.handleCommand(client.player, msg);
  }
}

// Relayed game snapshots and the host's checkpoints can be large: allow 4 MB messages, and compress
// (snapshots shrink several times), which keeps a free host's monthly bandwidth for longer.
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 4 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024 },
});

wss.on('connection', (ws) => {
  const client = {
    ws, name: '', game: null, player: null, tokens: {}, seenAt: Date.now(),
    send(msg) {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
  };
  clients.add(client);
  ws.on('pong', () => { client.seenAt = Date.now(); });
  ws.on('message', (data) => {
    client.seenAt = Date.now();
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
        if (p.spectator) g.removeSpectator(p.id);
        else g.disconnect(p);
      } else if (p.client === client) {
        // A spectator too: they may come back (a refresh) for SPECTATOR_AWAY_MS.
        // The game runs in the host's browser and goes on; the lobby only notes who is offline.
        p.client = null;
        p.connected = false;
        p.disconnectedAt = Date.now();
        if (g.status === 'running' && p.id === g.hostId) {
          hostAway(g, client);         // the game moves to another browser unless this one comes back
        } else {
          // A player relayed through this server is now cut off from the host: tell the host.
          const host = g.status === 'running' ? g.players.get(g.hostId) : null;
          if (host && host.client) host.client.send({ t: 'relay', from: p.id, msg: { t: 'relayClose' } });
        }
        sendRestartState(g);           // a finished duel: gone from its results screen, no restart
      }
      if (g.players.size === 0) deleteGame(g, 'Every player has left the game');
      lobbyDirty = true;
    }
  });
});

// Heartbeat: dead connections are dropped (and their close handled) within SILENT_MS.
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - c.seenAt > SILENT_MS) c.ws.terminate();
    else if (c.ws.readyState === 1) c.ws.ping();
  }
}, HEARTBEAT_MS).unref();

// ------------------------------------------------------------------ loops
// No simulation here: games run in their host player's browser (server/host-engine.js).

// Housekeeping: delete abandoned or finished games, refresh lobby lists.
// Disconnected players are never removed: they can rejoin until the game ends. A finished duel stays
// while both its players are still on its results screen, so they can restart it.
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    // Spectators only count while online: one gone for good (not back after a refresh) is forgotten.
    for (const [id, s] of g.spectators) {
      if (!s.client && now - s.disconnectedAt > SPECTATOR_AWAY_MS) g.spectators.delete(id);
    }
    const connected = [...g.players.values()].some((p) => p.connected);
    if (connected) g.emptySince = 0;
    else if (!g.emptySince) g.emptySince = now;
    const expired =
      g.players.size === 0 ||
      (g.emptySince && now - g.emptySince > EMPTY_GAME_MS) ||
      (g.status === 'ended' && now - g.endedAt > ENDED_GAME_MS && !restartState(g)?.open);
    if (expired) {
      for (const p of g.players.values()) {
        if (p.client) { p.client.game = null; p.client.player = null; }
      }
      deleteGame(g, g.players.size ? 'The game was closed: no player has been online for a long time' : 'Every player has left the game');
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
