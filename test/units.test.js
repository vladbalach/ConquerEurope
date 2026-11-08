// Unit types: production and the configured stats. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBAT, UNITS, UNIT_TYPES } from '../shared/config.js';
import { UNIT_CLASSES } from '../server/units/index.js';
import { setup } from './helpers.js';

test('a knight is built in a city and has the configured stats', () => {
  const { game, a, city, run } = setup();
  const paris = city('Paris');
  a.gold = 1000;
  game.handleCommand(a, { t: 'build', cities: [paris.id], item: 'knight' });
  assert.equal(a.gold, 1000 - UNITS.knight.cost, 'a knight costs 150');
  run(UNITS.knight.buildTime - 0.5);
  assert.equal([...game.units.values()].filter((u) => u.type === 'knight').length, 0, 'not ready before 8 s');
  run(0.6);
  const knights = [...game.units.values()].filter((u) => u.type === 'knight');
  assert.equal(knights.length, 1);
  const k = knights[0];
  assert.equal(k.owner, a.id);
  assert.equal(k.hp, 250);
  assert.equal(k.stats.damage, 45);
  assert.equal(k.stats.moveSpeed, 45);
  assert.equal(k.isRanged, false, 'knights fight in melee');
});

test('every unit type has its own class', () => {
  for (const type of UNIT_TYPES) assert.equal(UNIT_CLASSES[type].type, type);
});

test('units regenerate at their configured rate once out of combat', () => {
  const { game, a, city, spawn } = setup();
  const lyon = city('Lyon');
  const expected = { cavalry: 0.5, infantry: 0.7, archer: 0.4, knight: 1 };
  for (const [type, rate] of Object.entries(expected)) {
    assert.equal(UNITS[type].hpRegen, rate, `${type} regen in the config`);
    const u = spawn(a.id, type, lyon.x - 30, lyon.y);
    u.hp = 10;
    u.lastCombat = game.time - COMBAT.regenDelay - 1;   // out of combat
    u.regenerate(10);
    assert.ok(Math.abs(u.hp - (10 + rate * 10)) < 1e-9, `${type} regenerates ${rate} HP per second`);
    u.hp = 10;
    u.lastCombat = game.time;                            // just fought: no regen yet
    u.regenerate(10);
    assert.equal(u.hp, 10, `${type} does not regenerate while in combat`);
  }
});
