// Web Worker that runs the game when this player is the host (browser-to-browser play).
// A worker keeps its full speed while the host's tab is in the background, so the game never
// slows down for the other players. The page (p2p.js, HostSession) only passes messages:
//   page -> worker  init, connect, disconnect, msg (a player's order), balance, cityMoved, cityCoast, beachEdit,
//                   mountainEdit, mapRebuilt, checkpoint (one now: the host is leaving)
//   worker -> page  send (a game message for one player), ended (who won), checkpoint (the game, packed), error
// `init` with a `save` takes over a game whose host left (server/save.js).
import { HostEngine } from '/sim/host-engine.js';
import { packSave, unpackSave } from '/sim/save.js';
import { GAME } from '/shared/config.js';

let engine = null;
const waiting = [];                  // messages that arrive while the map is still loading

const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
});

async function init(m) {
  const [map, navData, save] = await Promise.all([
    getJson('/map.json'), getJson('/navgrid.json'), m.save ? unpackSave(m.save) : null,
  ]);
  engine = new HostEngine({
    ...m, map, navData, save,
    send: (to, msg) => postMessage({ type: 'send', to, msg }),
    onEnded: (winner) => postMessage({ type: 'ended', winner }),
  });
  engine.start();
  engine.connect(m.hostId);          // the host's own screen
  for (const q of waiting.splice(0)) handle(q);
  // The first checkpoint at once: the lobby server can hand the game on from the start.
  checkpoint();
  setInterval(() => checkpoint(), GAME.checkpointEvery * 1000);
}

// The game as it is now, packed for the lobby server. `final`: asked for by the page (the host is
// leaving); answered even when there is nothing to send (the game is over).
let packing = false;
async function checkpoint(final = false) {
  if (packing && !final) return;     // the one before is still being packed
  packing = true;
  try {
    const save = engine.checkpoint();
    const data = save ? await packSave(save) : null;
    if (data || final) postMessage({ type: 'checkpoint', data, active: engine.activePlayers(), final });
  } finally {
    packing = false;
  }
}

async function handle(m) {
  switch (m.type) {
    case 'connect': engine.connect(m.id); break;
    case 'disconnect': engine.disconnect(m.id); break;
    case 'msg': engine.message(m.from, m.msg); break;
    case 'balance': engine.balance(m.values); break;
    case 'cityMoved': engine.moveCity(m.city, m.x, m.y); break;
    case 'cityCoast': engine.setCoastal(m.city, m.coastal); break;
    case 'beachEdit': engine.editBeaches(m.cells, m.on); break;
    case 'mountainEdit': engine.editMountains(m.cells, m.on); break;
    case 'mapRebuilt': {
      const [map, navData] = await Promise.all([getJson('/map.json'), getJson('/navgrid.json')]);
      engine.mapRebuilt(map, navData);
      break;
    }
    case 'checkpoint': await checkpoint(true); break;
    case 'stop': engine.stop(); break;
    default:
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m).catch((err) => postMessage({ type: 'error', msg: `The game could not start: ${err.message}` }));
  } else if (!engine) {
    waiting.push(m);
  } else {
    handle(m).catch((err) => postMessage({ type: 'error', msg: err.message }));
  }
};
