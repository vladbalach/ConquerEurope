// Connection diagnostics in the browser console: what this page and the lobby server say to each other,
// and how the link to the game's host goes. Each line has a tag ([net], [lobby], [p2p]) and the seconds
// since the page loaded. Busy traffic (pings, relayed game messages) stays out of it.
const T0 = performance.now();

function stamp() {
  return `+${((performance.now() - T0) / 1000).toFixed(1)}s`;
}

export function logger(tag) {
  const p = `[${tag}]`;
  return {
    info: (...a) => console.info(p, stamp(), ...a),
    warn: (...a) => console.warn(p, stamp(), ...a),
    error: (...a) => console.error(p, stamp(), ...a),
  };
}
