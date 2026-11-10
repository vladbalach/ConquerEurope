// A running game as plain data, and back: the host's browser sends one to the lobby server every
// GAME.checkpointEvery seconds (a checkpoint). When the host leaves or its browser is gone, another
// player's browser takes the game over from the last one (server/index.js, moveHost).
//
// Units and players are saved field by field as they are (everything but their links to the game and
// the page), so new fields are saved without anything to add here, as long as they hold plain data:
// numbers, strings, arrays and plain objects, other units by id, never the unit object itself
// (test/save.test.js round-trips a busy game). Everything the map decides (where cities stand, ports,
// the land grid) comes from the map the new host loads, not from the save.
//
// Runs in the host's browser too (served as /sim/): no Node-only modules here.
import { Game } from './game.js';
import { History } from './history.js';
import { createUnit } from './units/index.js';

export const SAVE_VERSION = 1;

const GAME_FIELDS = [
  'status', 'prestart', 'startedWith', 'nextUnitId', 'time', 'tickCount', 'turn', 'nextTurnAt', 'winner', 'timeScale',
];
const CITY_FIELDS = ['owner', 'hp', 'queue', 'queueHonor', 'progress', 'rally', 'seaRally', 'target', 'regenAt'];
const UNIT_SKIP = new Set(['game', 'cargo', 'ownStats']);
// Units made while the old host ran past its last checkpoint are gone, but players' pages may still
// have their ids (a selection): new units after a takeover get ids none of those can have.
const ID_GAP = 1000;

function saveUnit(u) {
  const out = {};
  for (const [k, v] of Object.entries(u)) if (!UNIT_SKIP.has(k) && v !== undefined) out[k] = v;
  if (u.naval) out.cargo = u.cargo.map(saveUnit);
  return out;
}

function loadUnit(game, s) {
  const { cargo, ...fields } = s;
  const u = createUnit(s.type, game, s.id, s.owner, s.x, s.y);
  Object.assign(u, fields);
  if (u.naval) u.cargo = (cargo || []).map((c) => loadUnit(game, c));
  return u;
}

// The whole game as JSON-safe data.
export function saveGame(game) {
  const g = {};
  for (const k of GAME_FIELDS) g[k] = game[k];
  const h = game.history;
  return {
    v: SAVE_VERSION, id: game.id, title: game.title, options: game.options, game: g,
    // A hosted game has no nicknames or rejoin tokens (the lobby server keeps them): never in a save either.
    players: [...game.players.values()].map(({ client, name, token, ...p }) => ({ ...p, token: null })),   // eslint-disable-line no-unused-vars
    cities: game.cities.map((c) => {
      const out = { upgrades: [...c.upgrades] };
      for (const k of CITY_FIELDS) out[k] = c[k];
      return out;
    }),
    units: [...game.units.values()].map(saveUnit),
    history: { frames: h.frames, owners: h.owners, roster: [...h.roster], stats: [...h.stats] },
  };
}

// The game again from a save, on this map and land grid, run by player `hostId`. Every player is
// offline until their page connects (HostEngine.connect).
export function restoreGame(save, { map, nav, hostId }) {
  if (!save || save.v !== SAVE_VERSION) throw new Error('This game was saved by another version');
  const game = new Game({ id: save.id, title: save.title, map, nav, options: save.options });
  for (const k of GAME_FIELDS) if (k in save.game) game[k] = save.game[k];
  game.nextUnitId += ID_GAP;
  game.hostId = hostId;
  for (const p of save.players) game.players.set(p.id, { ...p, client: null });
  save.cities.forEach((s, i) => {
    const c = game.cities[i];
    if (!c) return;
    for (const k of CITY_FIELDS) if (k in s) c[k] = s[k];
    c.upgrades = new Set(s.upgrades);
  });
  for (const s of save.units) {
    const u = loadUnit(game, s);
    game.units.set(u.id, u);
  }
  const h = (game.history = new History());
  h.frames = save.history.frames;
  h.owners = save.history.owners;
  h.roster = new Map(save.history.roster);
  h.stats = new Map(save.history.stats);
  return game;
}

// ---------------------------------------------------------------- packing
// A save travels as text: compressed (deflate, then base64) where the browser can, about 5 times
// smaller, which keeps the host's upload and the lobby server's memory small; plain JSON otherwise.
const canDeflate = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function packSave(save) {
  const text = JSON.stringify(save);
  if (!canDeflate) return `j${text}`;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `z${btoa(bin)}`;
}

export async function unpackSave(packed) {
  if (typeof packed !== 'string') throw new Error('No saved game');
  if (packed[0] === 'j') return JSON.parse(packed.slice(1));
  const bin = atob(packed.slice(1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return JSON.parse(await new Response(stream).text());
}
