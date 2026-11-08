// Web Worker that runs the game when this player is the host (browser-to-browser play).
// A worker keeps its full speed while the host's tab is in the background, so the game never
// slows down for the other players. The page (p2p.js, HostSession) only passes messages:
//   page -> worker  init, connect, disconnect, msg (a player's order), balance, cityMoved, cityCoast, beachEdit, mapRebuilt
//   worker -> page  send (a game message for one player), ended (who won), error
import { HostEngine } from '/sim/host-engine.js';

let engine = null;
const waiting = [];                  // messages that arrive while the map is still loading

const getJson = (url) => fetch(url, { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
});

async function init(m) {
  const [map, navData] = await Promise.all([getJson('/map.json'), getJson('/navgrid.json')]);
  engine = new HostEngine({
    ...m, map, navData,
    send: (to, msg) => postMessage({ type: 'send', to, msg }),
    onEnded: (winner) => postMessage({ type: 'ended', winner }),
  });
  engine.start();
  engine.connect(m.hostId);          // the host's own screen
  for (const q of waiting.splice(0)) handle(q);
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
    case 'mapRebuilt': {
      const [map, navData] = await Promise.all([getJson('/map.json'), getJson('/navgrid.json')]);
      engine.mapRebuilt(map, navData);
      break;
    }
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
