// Shared setup for simulation tests: a running two-player game on the real map.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../server/game.js';
import { NavGrid } from '../server/nav.js';
import { CITY } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'map.json'), 'utf8'));
export const nav = NavGrid.load(path.join(ROOT, 'server', 'data', 'navgrid.json'));
export const DT = 0.05;

// Players A (id 0) and B (id 1): A owns the western half of the cities, B the eastern
// half, so no neutral city shoots at test units unless a test changes an owner. Neither
// player holds enough cities to win, and neither is eliminated: the game keeps running
// (a finished game ignores all orders). `grid`: a land grid of the test's own (one it changes, e.g. with
// mountains painted on it) instead of the shared one.
export function setup(grid = nav) {
  const game = new Game({ id: '1', title: 'test', map, nav: grid });
  const a = game.addPlayer({ name: 'A', send() {} }).player;
  const b = game.addPlayer({ name: 'B', send() {} }).player;
  game.start();
  const byX = [...game.cities].sort((p, q) => p.x - q.x);
  byX.forEach((c, i) => { c.owner = i < byX.length / 2 ? a.id : b.id; c.hp = CITY.hp; c.queue = []; });
  game.recount();
  const city = (name) => game.cities.find((c) => c.name === name);
  const spawn = (owner, type, x, y) => game.spawnUnit({ owner, rally: null, spawnPoint: () => [x, y], launchPoint: () => [x, y] }, type);
  const run = (seconds) => { for (let t = 0; t < seconds - 1e-9; t += DT) game.tick(DT); };
  return { game, a, b, city, spawn, run };
}
