// Game options the host sets in the waiting room: how many cities win the game, whether that
// number counts down as the game goes on, and what happens to a player who loses everything.
//
// The lobby server keeps them with the game and hands them to the host's browser at the start
// (server/game.js runs there and decides who wins); every player's page gets them in `start` and
// shows the current target. Both sides use citiesToWin() below, so they always agree.
import { GAME, LIBERATOR } from './config.js';

// Countdown: 'none'  the target never changes
//            'start' it drops by one city at the end of every turn
//            'turn'  it stays put until turn `countdownTurn` is over, then drops by one every turn
export const COUNTDOWN_MODES = ['none', 'start', 'turn'];

// Death: what happens to a player who has lost every city and every unit.
//   'spectator'  they are out of the game and can only watch
//   'liberator'  they lose all their gold and become a liberator (LIBERATOR in shared/config.js)
export const DEATH_MODES = ['spectator', 'liberator'];

export const DEFAULT_OPTIONS = Object.freeze({
  countdown: 'start',
  countdownTurn: 10,
  winCities: GAME.winCities,
  death: 'liberator',
});

export const OPTION_LIMITS = {
  winCities: { min: GAME.startCities + 1 },   // max: the number of cities on the map
  countdownTurn: { min: 1, max: 999 },
};

const int = (v, fallback, min, max) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

// Known fields only, each valid and within its limits; anything missing or broken is the default.
// `cityCount`: cities on the map (more than all of them can never be held).
export function sanitizeOptions(raw, cityCount = Infinity) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const maxCities = Math.max(OPTION_LIMITS.winCities.min, Number.isFinite(cityCount) ? cityCount : 9999);
  const { countdownTurn: ct } = OPTION_LIMITS;
  return {
    countdown: COUNTDOWN_MODES.includes(o.countdown) ? o.countdown : DEFAULT_OPTIONS.countdown,
    countdownTurn: int(o.countdownTurn, DEFAULT_OPTIONS.countdownTurn, ct.min, ct.max),
    winCities: int(o.winCities, Math.min(DEFAULT_OPTIONS.winCities, maxCities), OPTION_LIMITS.winCities.min, maxCities),
    death: DEATH_MODES.includes(o.death) ? o.death : DEFAULT_OPTIONS.death,
  };
}

// Cities a player must hold to win once `turn` turns are over (the turn counter in the game).
// "From start" lowers it at the end of every turn: 120 in the first turn, 119 in the second, …
// "From turn N" keeps it until the counter passes N. Never below one city.
export function citiesToWin(options, turn = 0) {
  const o = options || DEFAULT_OPTIONS;
  if (o.countdown === 'none') return o.winCities;
  const from = o.countdown === 'turn' ? o.countdownTurn : 0;
  return Math.max(1, o.winCities - Math.max(0, (turn || 0) - from));
}

// One line for the lobby list: "120 cities · countdown after turn 10".
export function summarizeOptions(options) {
  const o = options || DEFAULT_OPTIONS;
  const countdown = o.countdown === 'none' ? 'no countdown'
    : o.countdown === 'start' ? 'countdown from the start' : `countdown after turn ${o.countdownTurn}`;
  return `${o.winCities} cities to win · ${countdown} · death: ${o.death === 'liberator' ? 'liberator' : 'spectator'}`;
}

// What happens to a player who loses everything, in a sentence.
export function describeDeath(options) {
  const o = options || DEFAULT_OPTIONS;
  if (o.death !== 'liberator') return 'A player who loses every city and unit is out and can only watch.';
  return 'A player who loses every city and unit loses all their gold and becomes a liberator: ' +
    `${LIBERATOR.goldPerTurn} gold per turn, and once every ${LIBERATOR.cooldownTurns} turns they can take any one ` +
    `city on the map, except from a player who holds ${LIBERATOR.protectedCities} cities or fewer.`;
}

// The victory rule in a sentence, for the waiting room and the game.
export function describeOptions(options) {
  const o = options || DEFAULT_OPTIONS;
  const hold = `Hold ${o.winCities} cities at the end of a turn to win.`;
  const countdown = o.countdown === 'none' ? ''
    : o.countdown === 'start' ? ' The target drops by one city at the end of every turn.'
      : ` Once turn ${o.countdownTurn} is over, the target drops by one city at the end of every turn.`;
  return `${hold}${countdown} ${describeDeath(o)}`;
}
