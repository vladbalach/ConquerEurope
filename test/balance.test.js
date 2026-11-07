// Live game balance (admin Edit button): validation, live effect, saving and loading.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNITS, CITY, CITY_UPGRADES } from '../shared/config.js';
import { applyBalance, sanitize, overrides, resetBalance, snapshot, defaults } from '../shared/balance.js';
import { loadBalance, saveBalance } from '../server/balance-store.js';
import { setup } from './helpers.js';

afterEach(() => resetBalance());

test('changes take effect immediately on units, upgrades and cities in a running game', () => {
  const { a, city, spawn } = setup();
  const paris = city('Paris');
  const knight = spawn(a.id, 'knight', paris.x + 40, paris.y + 40);

  applyBalance({
    units: { knight: { hp: 260, size: 9, damage: 60 } },
    upgrades: { wall: { hp: 300 } },
    city: { all: { hp: 150, attackRange: 90 } },
  });
  assert.equal(knight.maxHp, 260, 'existing units use the new max HP');
  assert.equal(knight.r, 9, 'and the new size');
  assert.equal(knight.stats.damage, 60);
  paris.addUpgrade('wall');
  assert.equal(paris.maxHp, 150 + 300, 'cities use the new base HP and upgrade bonus');
  assert.equal(paris.range, 90);
  assert.equal(UNITS.knight.hp, 260, 'the shared config object itself is updated');
});

test('invalid values are dropped and out-of-range values are clamped', () => {
  const clean = sanitize({
    units: {
      infantry: { hp: -5, damage: 'lots', moveSpeed: Infinity, cost: 12.5, speedHack: 9 },
      knight: { archerDamageReduction: 0.5 },          // only infantry has an archer block
      dragon: { hp: 999 },                             // no such unit
    },
    upgrades: { farm: { damage: 7 } },                 // effects may be added to any upgrade
    city: { all: { size: 0 } },
    secrets: { x: { y: 1 } },
  });
  assert.deepEqual(clean, {
    units: { infantry: { hp: 1, cost: 12.5 } },
    upgrades: { farm: { damage: 7 } },
    city: { all: { size: 1 } },
  });
});

test('only changed values are saved, and they come back after a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coe-')), 'balance.json');
  applyBalance({ units: { archer: { attackRange: 70 } }, upgrades: { farm: { goldPerTurn: 8 } } });
  saveBalance(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    units: { archer: { attackRange: 70 } },
    upgrades: { farm: { goldPerTurn: 8 } },
  });

  resetBalance();                                       // a fresh server starts from the defaults...
  assert.equal(UNITS.archer.attackRange, defaults().units.archer.attackRange);
  loadBalance(file);                                    // ...and loads the saved changes
  assert.equal(UNITS.archer.attackRange, 70);
  assert.equal(CITY_UPGRADES.farm.goldPerTurn, 8);

  resetBalance();
  saveBalance(file);
  assert.ok(!fs.existsSync(file), 'back to the defaults: the file is removed');
  assert.deepEqual(loadBalance(file), {}, 'no file: nothing to load');
});

test('reset restores every default from shared/config.js', () => {
  const before = snapshot();
  applyBalance({ units: { cavalry: { moveSpeed: 80 } }, city: { all: { damage: 50 } } });
  assert.deepEqual(overrides(), { units: { cavalry: { moveSpeed: 80 } }, city: { all: { damage: 50 } } });
  resetBalance();
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(overrides(), {});
  assert.equal(CITY.damage, before.city.all.damage);
});
