// Delta encoding of the messages the host sends every player over and over: snapshots (10 a second)
// and scores (once a second). Most of each one is the same as the one before: cities that didn't
// change, units standing still, players' stats. On the link to each player the host sends only what
// changed since the last message of that kind that player got, and the player's page rebuilds the
// full message before the game sees it. Nothing is rounded or left out: the game gets exactly the
// message the host made (as JSON would carry it).
//
// Links are reliable and ordered (WebRTC data channel, or the lobby server's relay), so a message can
// build on the one before it. Each carries its own number and the number of the message it builds
// on, so a page that missed one (the host's lobby connection dropped while relaying) notices, and
// asks for a whole one ('resync', public/js/p2p.js).
//
// A delta: { t: 'delta', m: the message type, n: its number, p: the number it builds on (0: none,
//   it carries the whole message),
//   v: { key: value } keys new or changed, sent whole,
//   x: [key] keys gone,
//   u: unit changes (snapshot `u`, see unitChanges),
//   s: { key: [index, value, ...] } flat arrays with a few values changed (snapshot `c`, the cities),
//   r: { key: [length, row change, ...] } lists of rows with a few rows changed (production queues,
//      the players in a score; see rowChanges) }

export const DELTA_TYPES = new Set(['snap', 'score']);

let nextNumber = 1;     // one count for every link of this page: a message never matches another link's

// A snapshot's `u`: 8 values per unit, id first (server/game.js, sendSnapshots).
const UNIT = 8;
const X = 3, Y = 4;     // position, in km rounded to tenths: sent as the change, in tenths
const KEEP_NEW = 128;   // a unit that is not next in the last snapshot: its 8 values follow
const SKIP = 129;       // the next n units of the last snapshot are gone

// ------------------------------------------------------------------ host side
export class DeltaEncoder {
  constructor() {
    this.last = new Map();   // message type -> { n, msg } the last one sent on this link
  }

  // The next message to send: `msg` itself for anything but snapshots and scores.
  encode(msg) {
    if (!DELTA_TYPES.has(msg.t)) return msg;
    const last = this.last.get(msg.t);
    const out = { t: 'delta', m: msg.t, n: nextNumber++, p: last ? last.n : 0 };
    if (!last) out.v = present(msg);
    else diff(last, msg, out);
    this.last.set(msg.t, { n: out.n, msg });
    return out;
  }
}

function diff(last, msg, out) {
  const prev = last.msg;
  const v = {}, x = [], s = {}, r = {};
  for (const key of Object.keys(prev)) if (key !== 't' && prev[key] !== undefined && msg[key] === undefined) x.push(key);
  for (const key of Object.keys(msg)) {
    if (key === 't') continue;
    const a = prev[key], b = msg[key];
    if (b === undefined) continue;                    // JSON leaves it out
    if (a === undefined) { v[key] = b; continue; }
    if (msg.t === 'snap' && key === 'u' && Array.isArray(a) && Array.isArray(b)) {
      const ops = unitChanges(a, b);
      if (ops) out.u = ops;
      continue;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (flat(a) && flat(b)) {
        const pairs = a.length === b.length ? valueChanges(a, b) : null;
        if (pairs && !pairs.length) continue;         // the same
        if (pairs && pairs.length < b.length) s[key] = pairs;
        else v[key] = b;
      } else {
        const rows = rowChanges(a, b);
        if (rows) r[key] = rows;
      }
      continue;
    }
    if (!same(a, b)) v[key] = b;
  }
  if (Object.keys(v).length) out.v = v;
  if (x.length) out.x = x;
  if (Object.keys(s).length) out.s = s;
  if (Object.keys(r).length) out.r = r;
}

// The keys JSON would carry (not the type, which the delta names).
function present(msg) {
  const out = {};
  for (const key of Object.keys(msg)) if (key !== 't' && msg[key] !== undefined) out[key] = msg[key];
  return out;
}

const scalar = (v) => v === null || typeof v !== 'object';
const flat = (arr) => arr.every(scalar);

// The same once sent as JSON (NaN counts as changed, which only sends it again).
function same(a, b) {
  if (a === b) return true;
  if (scalar(a) || scalar(b)) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !same(a[ka[i]], b[kb[i]])) return false;
  return true;
}

// Two flat arrays of the same length: [index, new value, ...] for the values that changed.
function valueChanges(a, b) {
  const pairs = [];
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) pairs.push(i, b[i]);
  return pairs;
}

// Two lists of rows (arrays or objects): [new length, change, ...] with one change per row that is
// new or differs: [index, key, value, key, value, ...] (keys: positions in an array row, names in an
// object row), or [index, -1, whole row]. null: nothing changed.
function rowChanges(a, b) {
  const out = [b.length];
  for (let i = 0; i < b.length; i++) {
    if (i < a.length && same(a[i], b[i])) continue;
    const kv = i < a.length ? rowChange(a[i], b[i]) : null;
    out.push(kv ? [i, ...kv] : [i, -1, b[i]]);
  }
  return out.length > 1 || a.length !== b.length ? out : null;
}

// The keys that changed between two rows of the same shape, as [key, value, ...]; null when the
// shapes differ (another length, other keys) and the row goes whole.
function rowChange(a, b) {
  if (scalar(a) || scalar(b) || Array.isArray(a) !== Array.isArray(b)) return null;
  const kv = [];
  if (Array.isArray(b)) {
    if (a.length !== b.length) return null;
    for (let k = 0; k < b.length; k++) if (!same(a[k], b[k])) kv.push(k, b[k]);
    return kv;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return null;
  for (let i = 0; i < kb.length; i++) {
    const k = kb[i];
    if (ka[i] !== k) return null;
    if (same(a[k], b[k])) continue;
    if (a[k] === undefined || b[k] === undefined) return null;   // JSON drops a key set to undefined
    kv.push(k, b[k]);
  }
  return kv;
}

// The units of a snapshot `b` as changes to the last one `a`. Walks both lists in order; a flat list
// of numbers:
//   -n                  the next n units of `a`, unchanged
//   mask, values...     the next unit of `a`, with the values whose bit is set (bit 0: value 1, the
//                       type, ... bit 6: value 7, the target); position as the change in tenths of km
//   KEEP_NEW, 8 values  a unit that isn't next in `a` (new, came into view, or moved up the list)
//   SKIP, n             the next n units of `a` are gone (died, left the view)
// Units of `a` after the last one named are gone too. null: nothing changed.
//
// Both lists are in the order the units were made (ids going up), so a unit is found by looking
// ahead in `a` while the ids there are smaller. A unit that is out of that order (back from a ship's
// hold) is just sent whole.
function unitChanges(a, b) {
  const ops = [];
  let next = 0, keep = 0;            // next: where the next unit of `a` starts
  for (let j = 0; j < b.length; j += UNIT) {
    const id = b[j];
    let i = next;
    while (i < a.length && a[i] !== id && a[i] < id) i += UNIT;
    let mask = i < a.length && a[i] === id ? 0 : -1;
    let dx = 0, dy = 0;
    for (let f = 1; f < UNIT && mask >= 0; f++) {
      const was = a[i + f], now = b[j + f];
      if (was === now) continue;
      mask |= 1 << (f - 1);
      if (f === X) dx = tenthsChange(was, now);
      else if (f === Y) dy = tenthsChange(was, now);
      if (dx === null || dy === null) mask = -1;      // not on the 0.1 km grid: send the unit whole
    }
    if (mask === 0 && i === next) {
      keep++;
      next += UNIT;
      continue;
    }
    if (keep) { ops.push(-keep); keep = 0; }
    if (mask < 0) {
      ops.push(KEEP_NEW);
      for (let f = 0; f < UNIT; f++) ops.push(b[j + f]);
      continue;
    }
    if (i > next) ops.push(SKIP, (i - next) / UNIT);
    next = i + UNIT;
    if (mask === 0) { keep = 1; continue; }
    ops.push(mask);
    for (let f = 1; f < UNIT; f++) {
      if (!(mask & (1 << (f - 1)))) continue;
      ops.push(f === X ? dx : f === Y ? dy : b[j + f]);
    }
  }
  if (keep) ops.push(-keep);
  const unchanged = a.length === b.length && (b.length === 0 || (ops.length === 1 && ops[0] === -(a.length / UNIT)));
  return unchanged ? null : ops;
}

// A position change in whole tenths of km, or null when `now` can't be rebuilt from it exactly.
function tenthsChange(was, now) {
  if (!Number.isFinite(was) || !Number.isFinite(now)) return null;
  const d = Math.round(now * 10) - Math.round(was * 10);
  return moved(was, d) === now ? d : null;
}

const moved = (was, d) => (Math.round(was * 10) + d) / 10;

// ------------------------------------------------------------------ player side
export class DeltaDecoder {
  constructor() {
    this.last = new Map();   // message type -> { n, msg } the last one rebuilt
  }

  // The whole message, or null when the delta builds on a message this page doesn't have.
  decode(d) {
    const last = this.last.get(d.m);
    if (d.p && (!last || last.n !== d.p)) return null;
    let msg;
    try {
      msg = rebuild(d.p ? last.msg : {}, d);
    } catch {
      return null;
    }
    this.last.set(d.m, { n: d.n, msg });
    return msg;
  }
}

function rebuild(prev, d) {
  const msg = { t: d.m };
  for (const key of Object.keys(prev)) if (key !== 't') msg[key] = prev[key];
  for (const key of d.x || []) delete msg[key];
  if (d.v) for (const key of Object.keys(d.v)) msg[key] = d.v[key];
  if (d.u) msg.u = applyUnits(prev.u || [], d.u);
  if (d.s) for (const key of Object.keys(d.s)) msg[key] = applyValues(prev[key], d.s[key]);
  if (d.r) for (const key of Object.keys(d.r)) msg[key] = applyRows(prev[key] || [], d.r[key]);
  return msg;
}

function applyValues(a, pairs) {
  const out = a.slice();
  for (let i = 0; i < pairs.length; i += 2) out[pairs[i]] = pairs[i + 1];
  return out;
}

function applyRows(a, [length, ...changes]) {
  const out = a.slice(0, length);
  for (const [i, k0, ...rest] of changes) {
    if (k0 === -1) { out[i] = rest[0]; continue; }
    const kv = [k0, ...rest];
    const row = Array.isArray(a[i]) ? a[i].slice() : { ...a[i] };
    for (let k = 0; k < kv.length; k += 2) row[kv[k]] = kv[k + 1];
    out[i] = row;
  }
  return out;
}

function applyUnits(a, ops) {
  const out = [];
  let next = 0;                      // the next unit of `a`
  for (let k = 0; k < ops.length;) {
    const op = ops[k++];
    if (op < 0) {
      const end = (next - op) * UNIT;
      for (let i = next * UNIT; i < end; i++) out.push(a[i]);
      next -= op;
    } else if (op === KEEP_NEW) {
      for (let f = 0; f < UNIT; f++) out.push(ops[k++]);
    } else if (op === SKIP) {
      next += ops[k++];
    } else {
      const i = next * UNIT;
      out.push(a[i]);
      for (let f = 1; f < UNIT; f++) {
        if (!(op & (1 << (f - 1)))) out.push(a[i + f]);
        else if (f === X || f === Y) out.push(moved(a[i + f], ops[k++]));
        else out.push(ops[k++]);
      }
      next++;
    }
  }
  return out;
}
