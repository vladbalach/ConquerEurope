// App shell: name entry, lobby, waiting room, and launching the game client.
import { Net } from './net.js';
import { GameClient } from './client.js';
import { GAME, DEBUG } from '/shared/config.js';
import { PROTOCOL_VERSION } from '/shared/protocol.js';
import { applyBalance } from '/shared/balance.js';
import {
  OPTION_LIMITS, GOLD_PERCENT, sanitizeOptions, sanitizeGoldPercent, summarizeOptions, describeOptions,
} from '/shared/options.js';
import { initTooltips } from './tooltip.js';
import { HostSession, PeerSession } from './p2p.js';
import { initSound } from './sound.js';
import { mapLines } from './render.js';
import { decodeMask, encodeMask } from '/shared/mountains.js';

initTooltips();
initSound();

const $ = (id) => document.getElementById(id);
const SCREENS = ['screen-name', 'screen-lobby', 'screen-room', 'screen-game'];
const NAME_KEY = 'coe.name';
const RESUME_KEY = 'coe.resume';   // this tab's current game (sessionStorage): silent resume after refresh
const TOKENS_KEY = 'coe.tokens';   // gameId -> token for every game you play (localStorage): "Rejoin" in lobby

const net = new Net();
let map = null;
let myName = '';
let introduced = false;      // name accepted by the server at least once this page load
let joined = null;           // { gameId, playerId }
let room = null;
let game = null;
let reconnectTimer = 0;
let debug = null;            // developer tools, only when DEBUG is on
let isAdmin = false;         // set by the server: may edit the game balance
let mapState = { pending: 0, busy: false };   // admins: cities moved since the last map rebuild
// Browser-to-browser play: the game runs in its host's browser. `session` is this page's link to
// it: a HostSession when this page hosts, a PeerSession otherwise (p2p.js).
let session = null;
let balanceValues = null;    // the server's current game balance, for a game this page hosts
// Lost the host during a game: the lobby server hands the game to another player's browser and tells
// us to connect to it. Only if nothing comes for this long is the game over for us.
const HOST_WAIT_MS = 60000;
let hostWait = 0;

function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  $('backdrop').hidden = id === 'screen-game';
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function store(kind, key, value) {
  try {
    if (value === null) kind.removeItem(key);
    else kind.setItem(key, value);
  } catch { /* storage unavailable */ }
}
// Stored as gameId -> { token, name }; only tokens saved under the current name are used,
// so several players testing in one browser don't pick up each other's games.
function readTokenStore() {
  try { return JSON.parse(load(localStorage, TOKENS_KEY) || '{}') || {}; } catch { return {}; }
}
function loadTokens() {
  const out = {};
  for (const [id, e] of Object.entries(readTokenStore())) {
    if (e && e.name && e.name.toLowerCase() === myName.toLowerCase()) out[id] = e.token;
  }
  return out;
}
function saveToken(gameId, token) {
  const all = readTokenStore();
  if (token) all[gameId] = { token, name: myName };
  else delete all[gameId];
  store(localStorage, TOKENS_KEY, JSON.stringify(all));
}
function load(kind, key) {
  try { return kind.getItem(key); } catch { return null; }
}

// ------------------------------------------------------------------ backdrop
const BACKDROP_COLORS = ['#c96f5b', '#6f8fc0', '#7fae6a', '#d39a4f', '#9a76b5', '#5fb0b5', '#c9b34f', '#b07a8f', '#8a9a5b', '#c08a5b'];

function drawBackdrop() {
  const cv = $('backdrop');
  if (!map || cv.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  const b = map.bounds;
  const s = Math.max(W / (b.x1 - b.x0), H / (b.y1 - b.y0)) * 1.05;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1f3d58';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s * dpr, 0, 0, s * dpr, (W / 2 - ((b.x0 + b.x1) / 2) * s) * dpr, (H / 2 - ((b.y0 + b.y1) / 2) * s) * dpr);
  const ring = (p, r) => { p.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) p.lineTo(r[i], r[i + 1]); p.closePath(); };
  for (const poly of map.polys) {
    const path = new Path2D();
    for (const r of poly.r) ring(path, r);
    ctx.fillStyle = poly.c.length ? '#dccfa8' : '#a9a088';
    ctx.fill(path, 'evenodd');
    ctx.globalAlpha = 0.55;
    if (poly.c.length === 1) {
      ctx.fillStyle = BACKDROP_COLORS[map.cities[poly.c[0]].c % BACKDROP_COLORS.length];
      ctx.fill(path, 'evenodd');
    } else if (poly.c.length > 1) {
      ctx.save();
      ctx.clip(path, 'evenodd');
      poly.cells.forEach((cell, i) => {
        const cp = new Path2D();
        ring(cp, cell);
        ctx.fillStyle = BACKDROP_COLORS[map.cities[poly.c[i]].c % BACKDROP_COLORS.length];
        ctx.fill(cp);
      });
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  // Coasts and region borders only, like the game map.
  const lines = mapLines(map);
  ctx.strokeStyle = 'rgba(40,25,15,0.8)';
  ctx.lineWidth = 1 / s;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(lines.regions);
  ctx.stroke(lines.coast);
}
window.addEventListener('resize', drawBackdrop);

// ------------------------------------------------------------------ lobby UI
function elem(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderGames(games, lobbyNames = []) {
  // Forget tokens of games that no longer exist.
  for (const id of Object.keys(readTokenStore())) if (!games.some((g) => g.id === id)) saveToken(id, null);

  const others = (lobbyNames || []).filter((n) => n !== myName);
  if (lobbyNames) {
    $('lobby-online').textContent = others.length ? `In the lobby: ${others.join(', ')}` : 'Nobody else is in the lobby right now.';
  }

  const list = $('game-list');
  list.textContent = '';
  if (!games.length) {
    list.append(elem('div', 'empty', 'No games yet. Create one and invite your friends!'));
    return;
  }
  const order = { lobby: 0, running: 1, ended: 2 };
  games.sort((a, b) => (b.rejoin - a.rejoin) || order[a.status] - order[b.status] || Number(b.id) - Number(a.id));
  for (const g of games) {
    const item = elem('div', `game-item${g.rejoin ? ' mine' : ''}`);
    const info = elem('div');
    info.append(elem('div', 'name', g.title));
    const count = Array.isArray(g.players) ? g.players.length : g.players;
    info.append(elem('div', 'meta', `Host: ${g.host} · ${count}/${g.max} players` +
      (g.options ? ` · ${summarizeOptions(g.options)}` : '')));

    const chips = elem('div', 'players');
    for (const p of Array.isArray(g.players) ? g.players : []) {
      // Names only: player colours are secret in the lobby (GAME_DESIGN.md, "Anonymous players").
      // For a game in progress the server sends nothing else, so nothing here can be matched with the game.
      if (g.status === 'running') {
        chips.append(elem('span', 'chip', p.name));
        continue;
      }
      const chip = elem('span', `chip${p.connected ? '' : ' offline'}${p.eliminated ? ' out' : ''}`, p.name);
      if (g.status !== 'lobby') chip.append(elem('small', '', ` ${p.cities}`));
      chip.title = `${p.name}${p.connected ? '' : ' (offline)'}${p.eliminated ? ' (eliminated)' : ''}` +
        (g.status !== 'lobby' ? ` · ${p.cities} cities` : '');
      chips.append(chip);
    }
    info.append(chips);

    const badge = elem('span', `badge ${g.status}`,
      g.status === 'lobby' ? 'Waiting' : g.status === 'running' ? 'In progress' : 'Finished');
    const btn = elem('button');
    btn.type = 'button';
    if (g.rejoin) {
      btn.textContent = 'Rejoin';
      btn.className = 'primary';
      btn.addEventListener('click', () => net.send({ t: 'join', gameId: g.id, token: loadTokens()[g.id] }));
    } else if (g.status === 'lobby') {
      btn.textContent = 'Join';
      btn.disabled = !g.canJoin;
      btn.addEventListener('click', () => net.send({ t: 'join', gameId: g.id }));
    } else {
      btn.textContent = g.status === 'running' ? 'Started' : 'Finished';
      btn.disabled = true;
      btn.title = g.status === 'running' ? 'New players cannot join a game in progress' : '';
    }
    item.append(info, badge, btn);
    list.append(item);
  }
}

function renderRoom() {
  if (!room || !joined) return;
  $('room-title').textContent = room.title;
  const isHost = room.hostId === joined.playerId;
  $('room-info').textContent = isHost
    ? `${room.players.length}/${GAME.maxPlayers} players. Start whenever you are ready — you can also start alone to practise against neutral cities.`
    : `${room.players.length}/${GAME.maxPlayers} players. Waiting for the host to start the game…`;
  renderRoomPlayers(isHost);
  renderOptions(room.options, isHost);
  $('room-start').hidden = !isHost;
}

// One row per player, kept by player id: rows are updated in place, so a gold percentage the host is
// typing in keeps its focus when someone joins or leaves meanwhile.
const roomRows = new Map();          // player id -> { li, name, tag, gold, input, text }
const GOLD_TIP = 'Gold this player earns in the game, in % of normal: city pay, liberator pay and kill gold ' +
  `(${GOLD_PERCENT.min}–${GOLD_PERCENT.max}%; the start gold is the same for everyone). Less for a strong player, more for a weaker one. ` +
  'In the game each player sees only their own.';

function roomRow(id) {
  let row = roomRows.get(id);
  if (row) return row;
  const li = elem('li');
  const name = elem('span');            // no colour: it is dealt at random when the game starts
  const tag = elem('span', 'tag');
  const gold = elem('label', 'room-gold');
  gold.title = GOLD_TIP;
  const input = elem('input');
  Object.assign(input, { type: 'number', step: 5, min: GOLD_PERCENT.min, max: GOLD_PERCENT.max, inputMode: 'numeric' });
  input.setAttribute('aria-label', 'Gold percentage');
  input.addEventListener('change', () => sendGoldPercent(id, input));
  const text = elem('span', 'room-gold-text');
  gold.append(elem('span', 'coin'), input, text);
  li.append(name, tag, gold);
  row = { li, name, tag, gold, input, text };
  roomRows.set(id, row);
  return row;
}

// `force`: also overwrite the percentage the host is typing in (they just committed it).
function renderRoomPlayers(isHost, force = false) {
  const ul = $('room-players');
  const ids = new Set(room.players.map((p) => p.id));
  for (const [id, row] of roomRows) if (!ids.has(id)) { row.li.remove(); roomRows.delete(id); }
  room.players.forEach((p, i) => {
    const row = roomRow(p.id);
    row.name.textContent = p.name;
    const tags = [];
    if (p.id === room.hostId) tags.push('host');
    if (p.id === joined.playerId) tags.push('you');
    row.tag.textContent = tags.join(' · ');
    row.tag.hidden = !tags.length;
    // The host sets every player's percentage; the others see it only when it isn't the usual 100%.
    const pct = sanitizeGoldPercent(p.goldPercent);
    row.input.hidden = !isHost;
    if (force || document.activeElement !== row.input) row.input.value = String(pct);
    row.text.textContent = isHost ? '%' : `${pct}% gold`;
    row.gold.hidden = !isHost && pct === GOLD_PERCENT.default;
    row.gold.classList.toggle('changed', pct !== GOLD_PERCENT.default);
    if (ul.children[i] !== row.li) ul.insertBefore(row.li, ul.children[i] || null);   // moved only if out of place
  });
}

function sendGoldPercent(id, input) {
  if (!room || !joined || room.hostId !== joined.playerId || room.status !== 'lobby') return;
  const p = room.players.find((q) => q.id === id);
  if (!p) return;
  p.goldPercent = sanitizeGoldPercent(input.value);   // show it at once; the server's copy follows in `room`
  renderRoomPlayers(true, true);
  net.send({ t: 'setGoldPercent', player: id, percent: p.goldPercent });
}

// ------------------------------------------------------------------ game options (waiting room)
// The host picks them; everyone else sees them read-only. The server keeps the real values and
// sends them with every `room` message.
const OPTION_INPUTS = ['opt-countdown', 'opt-countdown-turn', 'opt-win-cities', 'opt-death', 'opt-start-gold'];
const cityCount = () => (map ? map.cities.length : Infinity);

// `force`: also overwrite the field the player is typing in (they just committed a value).
function renderOptions(options, isHost, force = false) {
  const o = sanitizeOptions(options, cityCount());
  const set = (el, v) => { if (force || document.activeElement !== el) el.value = String(v); };
  const turn = $('opt-countdown-turn'), win = $('opt-win-cities'), gold = $('opt-start-gold');
  turn.min = OPTION_LIMITS.countdownTurn.min;
  turn.max = OPTION_LIMITS.countdownTurn.max;
  win.min = OPTION_LIMITS.winCities.min;
  if (map) win.max = map.cities.length;
  win.title = `Cities a player must hold to win (${win.min}–${map ? map.cities.length : '…'})`;
  gold.min = OPTION_LIMITS.startGold.min;
  gold.max = OPTION_LIMITS.startGold.max;
  gold.title = `Gold every player has at the start (${gold.min}–${gold.max}), the same for everyone`;
  set($('opt-countdown'), o.countdown);
  set(turn, o.countdownTurn);
  set(win, o.winCities);
  set($('opt-death'), o.death);
  set(gold, o.startGold);
  turn.hidden = o.countdown !== 'turn';
  for (const id of OPTION_INPUTS) $(id).disabled = !isHost;
  $('opt-summary').textContent = describeOptions(o);
}

function sendOptions() {
  if (!room || !joined || room.hostId !== joined.playerId || room.status !== 'lobby') return;
  const o = sanitizeOptions({
    countdown: $('opt-countdown').value,
    countdownTurn: $('opt-countdown-turn').value,
    winCities: $('opt-win-cities').value,
    death: $('opt-death').value,
    startGold: $('opt-start-gold').value,
  }, cityCount());
  room.options = o;                    // show it at once; the server's copy follows in `room`
  renderOptions(o, true, true);
  net.send({ t: 'setOptions', options: o });
}
for (const id of OPTION_INPUTS) $(id).addEventListener('change', sendOptions);

// Leaving on purpose gives up your empire, so the rejoin token is forgotten too.
function leaveGame() {
  // Tell the host first that we give up (our cities become neutral), then close the link. While a duel
  // restarts, the link is already to the new game.
  const s = session, givingUp = !!game && (!game.ended || game.restarting);
  clearTimeout(hostWait);
  if (s && s.isHost && givingUp) {
    // We run the game: it goes on in another player's browser. Our empire falls apart in it first,
    // and the game as it is then goes to the lobby server, which hands it on once we have left.
    session = null;
    const gameId = s.gameId;
    s.handOver().then(() => {
      net.send({ t: 'leave', gameId });
      s.destroy();
    });
  } else {
    if (s && !s.isHost && givingUp) s.link.send({ t: 'leave' });
    endSession(true);
    net.send({ t: 'leave' });
  }
  if (joined) saveToken(joined.gameId, null);
  store(sessionStorage, RESUME_KEY, null);
  joined = null;
  room = null;
  if (game) { game.destroy(); game = null; }
  show('screen-lobby');
  drawBackdrop();
}

// Closes this page's link to the game. A player's last message gets a moment to go out first.
function endSession(gently = false) {
  const s = session;
  session = null;
  if (!s) return;
  if (gently && !s.isHost) setTimeout(() => s.destroy(), 500);
  else s.destroy();
}

// Game messages, from the game's host (another browser, or this page's own worker).
function onGameMessage(msg) {
  const h = GAME_MESSAGES[msg.t];
  if (h) h(msg);
}

// ------------------------------------------------------------------ network
function hello() {
  let resume = null;
  try { resume = JSON.parse(load(sessionStorage, RESUME_KEY) || 'null'); } catch { resume = null; }
  // `hosting`: after a dropped connection the server learns that this page still runs its game (unless
  // another player's browser has taken it over meanwhile: a later epoch).
  const hosting = session && session.isHost ? { gameId: session.gameId, epoch: session.epoch } : null;
  net.send({ t: 'hello', name: myName, resume, tokens: loadTokens(), hosting });
}

// Closing or reloading the page that runs the game: the lobby server hands the game to another player's
// browser at once, instead of waiting to see whether this page's connection comes back.
window.addEventListener('pagehide', () => {
  if (session && session.isHost) net.send({ t: 'hostGone' });
});

net.onopen = () => {
  $('conn-status').textContent = '';
  if (introduced || myName) hello();
};

net.onclose = () => {
  $('conn-status').textContent = 'Connection lost — reconnecting…';
  // The game itself runs between the browsers and goes on without the lobby server.
  if (game && !session) game.hud.banner('Connection lost — reconnecting…', 4000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => net.connect(), 1500);
};

// The page files are always read fresh from disk, but a server process keeps the code it
// started with. If they differ, say so instead of showing a half-working lobby.
function checkProtocol(msg) {
  const outdated = msg.protocol !== PROTOCOL_VERSION;
  const text = 'The running game server is older than this page, so the lobby and game may not work. ' +
    'Close all game and server windows, run start-server.bat again, then refresh this page.';
  $('lobby-warning').textContent = text;
  $('lobby-warning').hidden = !outdated;
  if (outdated) toast(text);
}

net.on('welcome', (msg) => {
  checkProtocol(msg);
  introduced = true;
  myName = msg.name;
  $('lobby-name').textContent = msg.name;
  // The lobby server restarted and forgot our game, but it runs between the browsers: play on.
  if (game && session && !game.ended) return;
  endSession();
  if (game) { game.destroy(); game = null; }
  joined = null;
  store(sessionStorage, RESUME_KEY, null);
  show('screen-lobby');
  drawBackdrop();
});

net.on('games', (msg) => {
  try {
    renderGames(msg.games, msg.lobby);
  } catch (e) {
    console.error('Could not show the game list', e);
  }
});

net.on('joined', (msg) => {
  checkProtocol(msg);
  introduced = true;
  joined = { gameId: msg.gameId, playerId: msg.playerId };
  store(sessionStorage, RESUME_KEY, JSON.stringify({ gameId: msg.gameId, token: msg.token }));
  saveToken(msg.gameId, msg.token);
  if (msg.status === 'lobby') {
    show('screen-room');
    drawBackdrop();
  }
});

// The waiting room (lobby server). In a game, players come from the host instead.
net.on('room', (msg) => {
  room = msg;
  if (!game && msg.status === 'lobby') renderRoom();
});

// ------------------------------------------------------------------ browser-to-browser games
// The game runs in the host player's browser. This page either hosts it (a Web Worker plus one
// WebRTC link per player) or connects to the host; the lobby server passes connection messages.
const GAME_MESSAGES = {
  start(msg) {
    if (!joined) return;
    const link = session ? session.link : net;
    // The same game again: we reconnected to the host, or to the browser that took the game over from
    // it. (Not after a duel's Restart: a new game, same id.)
    if (game && !game.restarting && game.gameId === joined.gameId && game.you === msg.you) {
      game.reconnected(link);
      game.setPlayers(msg.players);
      game.onPorts(msg);
      game.onPrestart(msg.prestart);   // the game may have started meanwhile
      return;
    }
    if (game) game.destroy();
    show('screen-game');
    game = new GameClient({
      map, net, link, gameId: joined.gameId, you: msg.you, title: msg.title, options: msg.options, players: msg.players,
      ports: msg.ports, beaches: msg.beaches, onLeave: leaveGame, debug, admin: isAdmin, mapState, prestart: msg.prestart,
      goldPercent: msg.goldPercent,
    });
    if (game.goldPercent !== GOLD_PERCENT.default) {
      game.hud.feed(`The host set your gold to ${game.goldPercent}%: everything you earn is scaled by it.`);
    }
    if (session && session.relay) game.hud.feed('No direct connection to the host: your game goes through the server.');
  },
  room(msg) { if (game) game.setPlayers(msg.players); },
  prestart(msg) { if (game) game.onPrestart(msg); },      // players loading, the countdown, the start
  snap(msg) { if (game) game.onSnap(msg); },
  event(msg) { if (game) game.onEvent(msg); },
  score(msg) { if (game) game.setPlayers(msg.players); },
  ports(msg) { if (game) game.onPorts(msg); },
  gameover(msg) {
    if (session && !session.isHost) session.gameOver();   // its link may close now: no reconnecting
    if (game) game.onGameOver(msg);
  },
};

// This page hosts the game: it just started, or (with `save`) this page takes it over from a host who
// left, from the host's last checkpoint.
net.on('host', (msg) => {
  endSession();
  clearTimeout(hostWait);
  if (msg.save && game) game.hud.feed('The host is gone: the game now runs in your browser');
  session = new HostSession({
    net, gameId: msg.gameId, you: msg.you, epoch: msg.epoch, title: msg.title, options: msg.options, roster: msg.roster,
    save: msg.save || null, departed: msg.departed || [], ice: msg.ice,
    balance: balanceValues, onMessage: onGameMessage, onError: (text) => toast(text),
  });
});

// Connect to the host's browser (at the start, to come back after a refresh or a drop, or to the player
// who took the game over: `moved`).
net.on('connectHost', (msg) => {
  clearTimeout(hostWait);
  if (session && !session.isHost && session.gameId === msg.gameId && session.epoch === msg.epoch && !session.done) {
    if (session.open) return;          // our lobby connection came back; the direct link is fine
    if (session.relay) {               // the relay runs over the lobby connection: pick it up again
      session.openRelay();
      return;
    }
  }
  const wasHost = !!(session && session.isHost);
  endSession();                        // also a game this page ran: another browser has taken it over
  // Until the host's game arrives, the waiting room says what is happening.
  const status = (text) => {
    if (game) game.hud.feed(text);
    else {
      $('room-info').textContent = text;
      $('room-start').hidden = true;
      for (const id of OPTION_INPUTS) $(id).disabled = true;
    }
  };
  if (wasHost) status('Your connection dropped: the game now runs in another player\'s browser. Reconnecting…');
  else if (msg.moved) status('The host is gone: the game moves to another player\'s browser. Reconnecting…');
  else status(game ? 'Connecting to the host…' : 'The game has started: connecting to the host…');
  session = new PeerSession({
    net, gameId: msg.gameId, you: msg.you, epoch: msg.epoch, ice: msg.ice, onMessage: onGameMessage, onStatus: status,
    onLost: (text) => {
      session = null;
      if (game && game.restarting) {
        // A duel's Restart could not reach the host: back to the lobby, where Rejoin tries again.
        game.destroy();
        game = null;
        toast(text);
        show('screen-lobby');
        drawBackdrop();
        net.send({ t: 'list' });
      } else if (game) {
        // If the host is gone for good, the lobby server hands the game to another player's browser
        // (connectHost or host). Only if nothing comes is the game over for us.
        game.hud.feed('Lost the connection to the host: waiting for the game to carry on…', 'bad');
        clearTimeout(hostWait);
        hostWait = setTimeout(() => { if (game && !session) game.onHostLost(text); }, HOST_WAIT_MS);
      } else { status(text); toast(text); }
    },
  });
});

net.on('signal', (msg) => {
  if (session) Promise.resolve(session.onSignal(msg.from, msg.data)).catch((e) => console.warn('signal', e));
});

// Game messages through the lobby server, for players without a direct link to the host.
net.on('relay', (msg) => {
  if (!session || !msg.msg) return;
  if (session.isHost) session.onRelay(msg.from, msg.msg);
  else session.onRelay(msg.msg);
});

// The game is over: the lobby server reveals every nickname (the host never had them).
net.on('reveal', (msg) => {
  if (game) game.onReveal(msg);
  else if (msg.reason) toast(msg.reason);
});

// A finished duel: who has pressed Restart, and whether both players are still there to play again.
net.on('restartVotes', (msg) => { if (game) game.onRestartVotes(msg); });

// Both players of a duel pressed Restart: the same game starts again, handed to its host as at a
// start. The finished game's link goes now; its results stay on screen until the new game arrives.
net.on('restarted', () => {
  endSession();
  if (game) game.onRestarting();
});

net.on('start', GAME_MESSAGES.start);

// The server's current game balance (admins can change it at any time) and our admin rights.
net.on('balance', (msg) => {
  applyBalance(msg.values);
  balanceValues = msg.values;
  isAdmin = !!msg.admin;
  if (session && session.isHost) session.balance(msg.values);   // the game this page runs
  if (game) game.onBalance(msg);
});
// Map editing by admins (Edit map). A move applies to the shared map at once; after a rebuild
// the whole map (territories, borders) is loaded again. The same object is kept, so games see it.
net.on('cityMoved', (msg) => {
  const c = map && map.cities[msg.city];
  if (!c) return;
  c.x = msg.x;
  c.y = msg.y;
  if (session && session.isHost) session.cityMoved(msg);
  if (game) game.onCityMoved(msg);
});
// A city made coastal (true) or inland (false) by an admin, or back to automatic (null). The game's
// host recomputes the ports and sends them to everyone.
net.on('cityCoast', (msg) => {
  const c = map && map.cities[msg.city];
  if (!c) return;
  if (typeof msg.coastal === 'boolean') c.coastal = msg.coastal;
  else delete c.coastal;
  if (session && session.isHost) session.cityCoast(msg);
  if (game) game.onCityCoast(msg);
});
// Coast cells an admin painted as beaches or cliffs. The game's host applies them and sends every
// player the new beaches.
net.on('beachEdit', (msg) => {
  if (session && session.isHost) session.beachEdit(msg);
});
// Mountains an admin painted on or off (checked by the server). Every page draws them at once; the game's
// host also makes its units walk round them.
net.on('mountainEdit', (msg) => {
  const m = map && map.mountains;
  if (!m || !Array.isArray(msg.cells)) return;
  const mask = decodeMask(m.code, m.w * m.h);
  for (const c of msg.cells) if (Number.isInteger(c) && c >= 0 && c < mask.length) mask[c] = msg.on ? 1 : 0;
  m.code = encodeMask(mask);
  if (session && session.isHost) session.mountainEdit(msg);
  if (game) game.onMountainEdit();
});
// A region's name an admin moved or resized ({ x, y, scale }), or gave back to automatic placing (null).
net.on('labelEdit', (msg) => {
  const co = map && map.countries[msg.region];
  if (!co) return;
  map.labelEdits = map.labelEdits || {};
  if (msg.edit) map.labelEdits[co.n] = msg.edit;
  else delete map.labelEdits[co.n];
  if (game) game.onLabelEdit();
});
net.on('mapRebuilt', async () => {
  if (!map) return;
  const fresh = await fetch('map.json', { cache: 'no-store' }).then((r) => r.json());
  for (const key of Object.keys(map)) delete map[key];
  Object.assign(map, fresh);
  if (session && session.isHost) session.mapRebuilt();
  if (game) game.onMapRebuilt();
});
net.on('mapState', (msg) => { mapState = msg; if (game) game.onMapState(msg); });
net.on('error', (msg) => toast(msg.msg));
net.on('kicked', (msg) => {
  toast(msg.msg);
  clearTimeout(hostWait);
  endSession();
  if (game) { game.destroy(); game = null; }
  joined = null;
  show('screen-lobby');
  drawBackdrop();
});

// ------------------------------------------------------------------ forms
$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim();
  if (!name) return;
  myName = name;
  store(localStorage, NAME_KEY, name);
  if (net.connected) hello();
  else $('conn-status').textContent = 'Connecting…';
});

$('change-name').addEventListener('click', () => {
  $('name-input').value = myName;
  show('screen-name');
  $('name-input').focus();
});

$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  net.send({ t: 'create', title: $('game-title').value.trim() });
  $('game-title').value = '';
});

$('room-leave').addEventListener('click', leaveGame);
$('room-start').addEventListener('click', () => net.send({ t: 'start' }));

// Handy for debugging from the browser console: coe.game.cam, coe.game.renderUnits, ...
window.coe = { get game() { return game; }, get session() { return session; }, net };

// ------------------------------------------------------------------ boot
async function boot() {
  // Debug tools are only downloaded and started in debug builds.
  if (DEBUG) {
    try {
      debug = (await import('./debug/index.js')).createDebug({ getGame: () => game });
    } catch (e) {
      console.error('Debug tools failed to load', e);
    }
  }
  show('screen-name');
  $('name-input').value = load(localStorage, NAME_KEY) || '';
  $('name-input').focus();
  $('name-submit').disabled = true;
  $('conn-status').textContent = 'Loading map…';
  try {
    map = await fetch('map.json').then((r) => r.json());
  } catch {
    $('conn-status').textContent = 'Could not load the map. Is the server running?';
    return;
  }
  drawBackdrop();
  $('name-submit').disabled = false;
  $('conn-status').textContent = '';
  // Resume an in-progress game in this tab (e.g. after a refresh) without asking again.
  if (load(sessionStorage, RESUME_KEY) && $('name-input').value) myName = $('name-input').value;
  net.connect();
}

boot();
