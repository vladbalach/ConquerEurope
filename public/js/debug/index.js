// Debug tools, loaded only when DEBUG is true in shared/config.js.
// Add new console commands here with con.register(name, help, run, complete).
import { DevConsole } from './console.js';
import { Stats } from './stats.js';
import { NavOverlay } from './navigation.js';

const STAT_TARGETS = ['fps', 'unit', 'unitgraph', 'none'];
const SHOW_TARGETS = ['navigation', 'none'];

export function createDebug() {
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

  // A visible reminder that this is a debug build, and a line in the in-game help.
  const badge = document.createElement('div');
  badge.className = 'dev-badge';
  badge.textContent = 'DEBUG · ~ console';
  document.body.append(badge);
  const helpTable = document.querySelector('#help table');
  if (helpTable) {
    const row = helpTable.insertRow();
    row.insertCell().textContent = '~';
    row.insertCell().textContent = 'Developer console (debug builds): stat fps, stat unit, stat unitgraph, show navigation';
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
