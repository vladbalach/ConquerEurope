// Debug tools, loaded only when DEBUG is true in shared/config.js.
// Add new console commands here with con.register(name, help, run, complete).
import { DevConsole } from './console.js';
import { Stats } from './stats.js';
import { NavOverlay } from './navigation.js';

const STAT_TARGETS = ['fps', 'unit', 'unitgraph', 'none'];
const SHOW_TARGETS = ['navigation', 'none'];
const RESET_TARGETS = ['hp'];

// getGame(): the game this page is in (a GameClient), or null in the lobby.
export function createDebug({ getGame = () => null } = {}) {
  const con = new DevConsole();
  // Top-right column for the stats overlays and the navigation legend; each shows and hides on its own.
  const column = document.createElement('div');
  column.className = 'dev-overlays';
  document.getElementById('screen-game').append(column);
  const stats = new Stats(column);
  const nav = new NavOverlay(column);

  con.register('help', 'list all commands', () => {
    for (const [name, cmd] of con.commands) con.log(`${name.padEnd(8)} ${cmd.help}`);
  });

  con.register('clear', 'clear the console', () => con.clear());

  con.register('stat', 'stat fps | unit | unitgraph | none: toggle performance overlays', (args) => {
    const what = (args[0] || '').toLowerCase();
    if (what === 'none') {
      stats.none();
      con.log('All stats hidden.');
      return;
    }
    if (!STAT_TARGETS.includes(what)) {
      con.log('Usage: stat fps | stat unit | stat unitgraph | stat none', 'err');
      return;
    }
    const on = stats.toggle(what);
    const inGame = !document.getElementById('screen-game').hidden;
    con.log(`stat ${what}: ${on ? 'on' : 'off'}${on && !inGame ? ' (visible once you are in a game)' : ''}`);
  }, (args) => (args.length === 0 ? STAT_TARGETS : []));

  // Map overlays. "show navigation" toggles the walkable / not walkable grid.
  con.register('show', 'show navigation | none: toggle map overlays (walkable areas)', async (args) => {
    const what = (args[0] || '').toLowerCase();
    if (what === 'none') {
      nav.setOn(false);
      con.log('All overlays hidden.');
      return;
    }
    if (what !== 'navigation' && what !== 'nav') {
      con.log('Usage: show navigation | show none', 'err');
      return;
    }
    if (nav.on) {
      nav.setOn(false);
      con.log('show navigation: off');
      return;
    }
    const first = !nav.grid;
    if (first) con.log('Loading the navigation grid…', 'dim');
    try {
      await nav.load();
    } catch (e) {
      con.log(`Could not load the navigation grid: ${e.message}`, 'err');
      return;
    }
    nav.setOn(true);
    const inGame = !document.getElementById('screen-game').hidden;
    con.log(`show navigation: on${inGame ? '' : ' (visible once you are in a game)'}`);
    if (first) con.log(nav.summary(), 'dim');
  }, (args) => (args.length === 0 ? SHOW_TARGETS : []));

  // Game cheats for testing. They change the game itself, so they are sent to the game's host
  // like any order (the host accepts them only in debug builds) and every player is told.
  con.register('reset', 'reset hp: every unit and city in the game back to full HP', (args) => {
    const what = (args[0] || '').toLowerCase();
    if (!RESET_TARGETS.includes(what)) {
      con.log('Usage: reset hp', 'err');
      return;
    }
    const game = getGame();
    if (!game || game.ended) {
      con.log('reset hp: works only in a running game', 'err');
      return;
    }
    game.link.send({ t: 'resetHp' });
    con.log('reset hp: sent to the game. Every unit and city gets full HP.');
  }, (args) => (args.length === 0 ? RESET_TARGETS : []));

  con.register('gold', "gold N: set every player's gold to N", (args) => {
    const n = Number(args[0]);
    if (!args[0] || !Number.isFinite(n) || n < 0) {
      con.log('Usage: gold N   (N = 0 or more, e.g. gold 1000)', 'err');
      return;
    }
    const game = getGame();
    if (!game || game.ended) {
      con.log('gold: works only in a running game', 'err');
      return;
    }
    const gold = Math.round(Math.min(n, 1e9));
    game.link.send({ t: 'setGold', gold });
    con.log(`gold: sent to the game. Every player gets ${gold.toLocaleString('en-US')} gold.`);
  });

  con.register('slomo', 'slomo N: game speed, N times normal (0.1 to 10; slomo 1 is normal)', (args) => {
    const n = Number(args[0]);
    if (!args[0] || !Number.isFinite(n) || n <= 0) {
      con.log('Usage: slomo N   (N from 0.1 to 10, e.g. slomo 4 for four times as fast, slomo 1 for normal)', 'err');
      return;
    }
    const game = getGame();
    if (!game || game.ended) {
      con.log('slomo: works only in a running game', 'err');
      return;
    }
    const speed = Math.round(Math.min(10, Math.max(0.1, n)) * 100) / 100;
    game.link.send({ t: 'setSpeed', speed });
    con.log(`slomo: sent to the game. Speed ${speed}×${speed !== n ? ` (limited from ${n})` : ''}.`);
  });

  con.register('honor', "honor N: set every player's honor to N (traditions, Heroes)", (args) => {
    const n = Number(args[0]);
    if (!args[0] || !Number.isFinite(n) || n < 0) {
      con.log('Usage: honor N   (N = 0 or more, e.g. honor 2000)', 'err');
      return;
    }
    const game = getGame();
    if (!game || game.ended) {
      con.log('honor: works only in a running game', 'err');
      return;
    }
    const honor = Math.round(Math.min(n, 1e9));
    game.link.send({ t: 'setHonor', honor });
    con.log(`honor: sent to the game. Every player gets ${honor.toLocaleString('en-US')} honor.`);
  });

  // A visible reminder that this is a debug build, and a line in the in-game help.
  const badge = document.createElement('div');
  badge.className = 'dev-badge';
  badge.textContent = 'DEBUG · ~ console';
  document.body.append(badge);
  const helpTable = document.querySelector('#help table');
  if (helpTable) {
    const row = helpTable.insertRow();
    row.insertCell().textContent = '~';
    row.insertCell().textContent = 'Developer console (debug builds): stat fps, stat unit, stat unitgraph, show navigation, reset hp, gold N, ' +
      'honor N, slomo N. Any city\'s panel also has an Own button: the city becomes yours';
  }

  return {
    console: con,
    stats,
    // Called by the game client every frame with its timings in ms.
    frame: (now, timings) => stats.frame(now, timings),
    // Called by the renderer between the map and the cities, for world-space overlays.
    drawWorld: (ctx, renderer) => nav.draw(ctx, renderer),
    // Called after an admin rebuilt the map (Edit map > Rebuild navigation).
    mapChanged: () => nav.reload(),
  };
}
