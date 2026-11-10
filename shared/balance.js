// Game balance that admins can change while the server runs (the Edit button in a game).
//
// The numbers in shared/config.js are the defaults. Admin changes are applied to the live
// config objects (UNITS, CITY_UPGRADES, CITY) on the server and in every browser, and the
// server saves them as overrides in server/data/balance.json so they survive restarts.
import { UNITS, UNIT_TYPES, CITY, CITY_UPGRADES, UPGRADE_TYPES } from './config.js';

// Editable fields. `only`: the field exists only where config.js defines it (e.g. capacity
// for transports). `optional`: may be added to any row, missing counts as 0 (upgrade effects).
const UNIT_FIELDS = [
  { key: 'hp', label: 'HP', min: 1, max: 100000 },
  { key: 'damage', label: 'Damage/s', min: 0, max: 10000, hint: 'per shot for units with Reload' },
  { key: 'reload', label: 'Reload s', min: 0.1, max: 60, only: true, hint: 'seconds between two shots (battleships)' },
  { key: 'attackRange', label: 'Range', min: 0, max: 1000, hint: '0 = melee' },
  { key: 'moveSpeed', label: 'Speed', min: 0, max: 1000 },
  { key: 'accelTime', label: 'Accel s', min: 0.05, max: 60, only: true, hint: 'seconds from standing still to full speed (battleships)' },
  { key: 'size', label: 'Size', min: 1, max: 50 },
  { key: 'hpRegen', label: 'Regen/s', min: 0, max: 10000 },
  { key: 'harbourFactor', label: 'Harbour ×', min: 0, max: 100, only: true, hint: 'in harbour: this many times Regen/s (battleships)' },
  { key: 'cost', label: 'Cost', min: 0, max: 100000 },
  { key: 'buildTime', label: 'Build s', min: 0.1, max: 3600 },
  { key: 'capacity', label: 'Capacity', min: 0, max: 100, only: true, hint: 'units a transport carries' },
];

const UPGRADE_FIELDS = [
  { key: 'cost', label: 'Cost', min: 0, max: 100000 },
  { key: 'buildTime', label: 'Build s', min: 0.1, max: 3600 },
  { key: 'hp', label: '+HP', min: 0, max: 100000, optional: true },
  { key: 'rangePercent', label: '+Range %', min: 0, max: 1000, optional: true },
  { key: 'damage', label: '+Damage/s', min: 0, max: 10000, optional: true },
  { key: 'goldPerTurn', label: '+Gold/turn', min: 0, max: 100000, optional: true },
  { key: 'trainSpeedPercent', label: '+Train speed %', min: 0, max: 1000, optional: true },
];

const CITY_FIELDS = [
  { key: 'hp', label: 'HP', min: 1, max: 100000 },
  { key: 'damage', label: 'Damage/s', min: 0, max: 10000 },
  { key: 'attackRange', label: 'Range', min: 0, max: 1000 },
  { key: 'hpRegen', label: 'Regen/s', min: 0, max: 10000 },
  { key: 'size', label: 'Size', min: 1, max: 100 },
  { key: 'captureHp', label: 'HP after capture', min: 1, max: 100000 },
];

export const BALANCE_SECTIONS = [
  {
    id: 'units', title: 'Units', fields: UNIT_FIELDS,
    rows: UNIT_TYPES.map((key) => ({ key, name: UNITS[key].name, obj: UNITS[key] })),
  },
  {
    id: 'upgrades', title: 'City upgrades', fields: UPGRADE_FIELDS,
    rows: UPGRADE_TYPES.map((key) => ({ key, name: CITY_UPGRADES[key].name, obj: CITY_UPGRADES[key] })),
  },
  {
    id: 'city', title: 'Cities', fields: CITY_FIELDS,
    rows: [{ key: 'all', name: 'Every city', obj: CITY }],
  },
];

// Current values of every editable field: { section: { row: { field: number } } }.
export function snapshot() {
  const out = {};
  for (const s of BALANCE_SECTIONS) {
    out[s.id] = {};
    for (const r of s.rows) {
      const row = (out[s.id][r.key] = {});
      for (const f of s.fields) {
        const v = r.obj[f.key];
        if (typeof v === 'number') row[f.key] = v;
        else if (f.optional) row[f.key] = 0;
      }
    }
  }
  return out;
}

// The defaults from shared/config.js, captured before any change is applied.
const DEFAULTS = snapshot();

export function defaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// Is this field editable for this row?
export function editable(sectionId, rowKey, fieldKey) {
  const row = DEFAULTS[sectionId] && DEFAULTS[sectionId][rowKey];
  return !!row && fieldKey in row;
}

// Keep only known sections/rows/fields with finite numbers, clamped to each field's range.
export function sanitize(values) {
  const clean = {};
  if (!values || typeof values !== 'object') return clean;
  for (const s of BALANCE_SECTIONS) {
    const sv = values[s.id];
    if (!sv || typeof sv !== 'object') continue;
    for (const r of s.rows) {
      const rv = sv[r.key];
      if (!rv || typeof rv !== 'object') continue;
      for (const f of s.fields) {
        const v = rv[f.key];
        if (typeof v !== 'number' || !Number.isFinite(v) || !editable(s.id, r.key, f.key)) continue;
        ((clean[s.id] ||= {})[r.key] ||= {})[f.key] = Math.min(f.max, Math.max(f.min, v));
      }
    }
  }
  return clean;
}

// Write (sanitized) values into the live config objects. Returns what was applied.
export function applyBalance(values) {
  const clean = sanitize(values);
  for (const s of BALANCE_SECTIONS) {
    for (const r of s.rows) {
      const rv = clean[s.id] && clean[s.id][r.key];
      if (rv) Object.assign(r.obj, rv);
    }
  }
  return clean;
}

export function resetBalance() {
  applyBalance(DEFAULTS);
}

// Only the values that differ from shared/config.js: what the server saves.
export function overrides() {
  const now = snapshot();
  const out = {};
  for (const [sid, rows] of Object.entries(now)) {
    for (const [rk, fields] of Object.entries(rows)) {
      for (const [fk, v] of Object.entries(fields)) {
        if (v !== DEFAULTS[sid][rk][fk]) ((out[sid] ||= {})[rk] ||= {})[fk] = v;
      }
    }
  }
  return out;
}
