// Game options the host sets in the waiting room: how many cities win the game, whether that
// number counts down as the game goes on, what happens to a player who loses everything, the
// gold everyone starts with, and whether bots play too. Also each player's gold percentage (GOLD_PERCENT below).
//
// The lobby server keeps them with the game and hands them to the host's browser at the start
// (server/game.js runs there and decides who wins); every player's page gets them in `start` and
// shows the current target. Both sides use citiesToWin() below, so they always agree.
import { GAME, LIBERATOR, ECONOMY, BOTS } from './config.js';

// Countdown: 'none'  the target never changes
//            'start' it drops by one city at the end of every turn
//            'turn'  it stays put until turn `countdownTurn` is over, then drops by one every turn
export const COUNTDOWN_MODES = ['none', 'start', 'turn'];

// Death: what happens to a player who has lost every city and every unit.
//   'spectator'  they are out of the game and can only watch
//   'liberator'  they lose all their gold and become a liberator (LIBERATOR in shared/config.js)
export const DEATH_MODES = ['spectator', 'liberator'];

// With bots (`bots`): BOTS.count computer players join the game when it starts (server/bots.js). A new waiting
// room has it on; the room keeps it on while its host is alone and turns it off once someone joins (and on again
// when they are alone again), until the host sets it by hand (Game.setOptions): then it stays as they set it.
export const DEFAULT_OPTIONS = Object.freeze({
  countdown: 'turn',
  countdownTurn: 10,
  winCities: GAME.winCities,
  death: 'liberator',
  startGold: ECONOMY.startGold,     // every player's gold at the start (not scaled by gold percentages)
  bots: true,
});

export const OPTION_LIMITS = {
  winCities: { min: GAME.startCities + 1 },   // max: the number of cities on the map
  countdownTurn: { min: 1, max: 999 },
  startGold: { min: 0, max: 100000 },
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
  const { countdownTurn: ct, startGold: sg } = OPTION_LIMITS;
  return {
    countdown: COUNTDOWN_MODES.includes(o.countdown) ? o.countdown : DEFAULT_OPTIONS.countdown,
    countdownTurn: int(o.countdownTurn, DEFAULT_OPTIONS.countdownTurn, ct.min, ct.max),
    winCities: int(o.winCities, Math.min(DEFAULT_OPTIONS.winCities, maxCities), OPTION_LIMITS.winCities.min, maxCities),
    death: DEATH_MODES.includes(o.death) ? o.death : DEFAULT_OPTIONS.death,
    startGold: int(o.startGold, DEFAULT_OPTIONS.startGold, sg.min, sg.max),
    bots: typeof o.bots === 'boolean' ? o.bots : DEFAULT_OPTIONS.bots,
  };
}

// How many bots a game with `players` players gets when it starts: BOTS.count with the option on, as many as
// there is room for (GAME.maxPlayers in all).
export function botCount(options, players) {
  return options && options.bots ? Math.max(0, Math.min(BOTS.count, GAME.maxPlayers - players)) : 0;
}

// Gold percentage: the host sets one for each player in the waiting room, to even out players of
// different strength (less for a strong player, more for a weak one). The gold the player earns in the
// game is multiplied by it: what their cities pay each turn (or their pay as a liberator, smuggled gold
// included) and kill gold. The start gold is the same for everyone (the startGold option). Refunds only
// give back what was paid, and the developer console's "gold N" sets gold outright: neither is changed.
//
// It goes to the browser that runs the game with the player's id, but to no other player: in the game
// you learn your own percentage only, since everyone saw them by nickname in the waiting room.
export const GOLD_PERCENT = Object.freeze({ min: 10, max: 500, default: 100 });

export function sanitizeGoldPercent(v) {
  return int(v, GOLD_PERCENT.default, GOLD_PERCENT.min, GOLD_PERCENT.max);
}

// `gold` as a player with `percent` receives it: exact, for kill gold (halves count).
export function scaleGold(gold, percent) {
  return percent === undefined || percent === GOLD_PERCENT.default ? gold : (gold * percent) / 100;
}

// Turn pay, scaled: whole gold. The host pays it and the player's page shows it from this.
export function scaleGoldWhole(gold, percent) {
  return Math.round(scaleGold(gold, percent));
}

// Cities a player must hold to win once `turn` turns are over (the turn counter in the game).
// "From start" lowers it at the end of every turn: 140 in the first turn, 139 in the second, …
// "From turn N" keeps it until the counter passes N. Never below one city.
export function citiesToWin(options, turn = 0) {
  const o = options || DEFAULT_OPTIONS;
  if (o.countdown === 'none') return o.winCities;
  const from = o.countdown === 'turn' ? o.countdownTurn : 0;
  return Math.max(1, o.winCities - Math.max(0, (turn || 0) - from));
}

// One line for the lobby list: "140 cities · countdown after turn 10".
export function summarizeOptions(options) {
  const o = options || DEFAULT_OPTIONS;
  const countdown = o.countdown === 'none' ? 'no countdown'
    : o.countdown === 'start' ? 'countdown from the start' : `countdown after turn ${o.countdownTurn}`;
  const gold = o.startGold !== undefined && o.startGold !== DEFAULT_OPTIONS.startGold ? ` · ${o.startGold} start gold` : '';
  const bots = o.bots ? ' · with bots' : '';
  return `${o.winCities} cities to win · ${countdown} · death: ${o.death === 'liberator' ? 'liberator' : 'spectator'}${gold}${bots}`;
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
