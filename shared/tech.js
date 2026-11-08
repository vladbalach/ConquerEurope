// Technologies (TECHS in shared/config.js) and what they do for a liberator. Used by the game
// (server/game.js, in the host's browser) and by every player's page (HUD, Tech window), so both
// always agree on incomes and limits.
import { TECHS, TECH_TYPES, TECH_TABS, LIBERATOR } from './config.js';

// Levels a new player has: none of anything.
export function noTech() {
  return Object.fromEntries(TECH_TYPES.map((key) => [key, 0]));
}

// The next level of `key` for a player at `level`: { level, cost, time }, or null when maxed.
export function nextLevel(key, level) {
  const def = TECHS[key];
  const next = def && def.levels[level];
  return next ? { level: level + 1, cost: next.cost, time: next.time } : null;
}

// Is this technology's tab available with these game options?
export function techAvailable(key, options) {
  const def = TECHS[key];
  const tab = def && TECH_TABS.find((t) => t.id === def.tab);
  return !!tab && (!tab.death || (options && options.death === tab.death));
}

const lvl = (tech, key) => (tech && tech[key]) || 0;

// Gold a liberator gets at the end of every turn (before smuggling).
export function liberatorIncome(tech) {
  return LIBERATOR.goldPerTurn + lvl(tech, 'supporters') * TECHS.supporters.goldPerTurnPerLevel;
}

// How many cities a liberator can influence before they are all liberated (1: taken at once).
export function influenceLimit(tech) {
  return 1 + lvl(tech, 'influencer') * TECHS.influencer.citiesPerLevel;
}

// How many cities a liberator can smuggle from.
export function smugglingLimit(tech) {
  return lvl(tech, 'smuggling') * TECHS.smuggling.citiesPerLevel;
}

// Gold moved by smuggling at the end of a turn. smugglers: [{ id, tech, cities }] for liberators
// only. ownerOf(city) and incomeOf(city): the city's owner (-1 neutral) and what it pays per turn.
// TECHS.smuggling.share of a city's income (rounded down) goes to its smuggler. Only one liberator can
// smuggle from a city (server/game.js); should there ever be several, they share. Neutral cities pay nothing.
// Returns { gain: Map(liberator -> gold), loss: Map(owner -> gold), byCity: Map(city -> gold per smuggler) }.
export function smugglingFlows(smugglers, ownerOf, incomeOf) {
  const onCity = new Map();
  for (const s of smugglers) {
    for (const ci of s.cities.slice(0, smugglingLimit(s.tech))) {
      const owner = ownerOf(ci);
      if (owner < 0 || owner === s.id) continue;
      if (!onCity.has(ci)) onCity.set(ci, []);
      onCity.get(ci).push(s.id);
    }
  }
  const gain = new Map(), loss = new Map(), byCity = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const [ci, ids] of onCity) {
    const each = Math.floor(Math.floor(incomeOf(ci) * TECHS.smuggling.share) / ids.length);
    if (each <= 0) continue;
    byCity.set(ci, each);
    for (const id of ids) add(gain, id, each);
    add(loss, ownerOf(ci), each * ids.length);
  }
  return { gain, loss, byCity };
}
