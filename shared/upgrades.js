// Grades of city upgrades (CITY_UPGRADES in shared/config.js): Wall II is the next grade of Wall I
// (`requires: 'wall'`). Used by the game (server/game.js, in the host's browser) and by every
// player's page (build buttons, hotkeys), so both always agree on what an order queues.
import { CITY_UPGRADES } from './config.js';

// Every grade of the upgrade that `key` is a grade of, lowest first: ['wall', 'wall2'] for 'wall'
// or 'wall2', just ['tower'] for 'tower'.
export function upgradeGrades(key) {
  let base = key;
  while (CITY_UPGRADES[base]?.requires) base = CITY_UPGRADES[base].requires;
  const grades = [base];
  for (let next; (next = Object.keys(CITY_UPGRADES).find((k) => CITY_UPGRADES[k].requires === grades.at(-1)));) {
    grades.push(next);
  }
  return grades;
}

// The grade to order next in a city where `has(grade)` is true for the grades it has built or
// queued: the lowest one it hasn't, or null when it has them all.
export function nextGrade(key, has) {
  return CITY_UPGRADES[key] ? upgradeGrades(key).find((k) => !has(k)) ?? null : null;
}

// The grades above this one: they need it, so they go when it is cancelled.
export function higherGrades(key) {
  const grades = upgradeGrades(key);
  return grades.slice(grades.indexOf(key) + 1);
}

// The upgrades a city has, without the grades a higher grade replaces: Wall II, not Wall I and Wall II.
export function topGrades(keys) {
  return keys.filter((key) => !higherGrades(key).some((k) => keys.includes(k)));
}
