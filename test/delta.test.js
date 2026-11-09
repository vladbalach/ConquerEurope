// Snapshots and scores travel as changes to the last one sent (public/js/delta.js): the player's page
// must rebuild exactly the message the host made, whatever happens in the game. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostEngine } from '../server/host-engine.js';
import { GAME } from '../shared/config.js';
import { DeltaEncoder, DeltaDecoder } from '../public/js/delta.js';
import { Outgoing, canDeflate, deflate, inflate } from '../public/js/p2p.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

// Over the wire: JSON there and back, as the data channel or the relay carries it.
const wire = (msg) => JSON.parse(JSON.stringify(msg));

// One link: host side (skips and encodes like HostSession.sendTo) to the player's page (decodes).
function link() {
  const decoder = new DeltaDecoder();
  const got = [];
  let raw = 0, sent = 0;
  return {
    out: new Outgoing(), decoder, got,
    bytes: () => ({ raw, sent }),
    // A new link to the same page (the player reconnected): the host starts over with whole messages.
    reset() { this.out = new Outgoing(); },
    // `skip`: the link is behind, this snapshot waits (its deaths and War Cries go with the next).
    send(msg, skip = false) {
      const out = this.out;
      if (msg.t === 'snap' && skip) { out.hold(msg); return; }
      if (msg.t === 'snap') msg = out.release(msg);
      const text = JSON.stringify(out.encoder.encode(msg));
      raw += JSON.stringify(msg).length;
      sent += text.length;
      const back = JSON.parse(text);
      const whole = back.t === 'delta' ? decoder.decode(back) : back;
      assert.ok(whole, `rebuilt ${msg.t}`);
      assert.deepStrictEqual(whole, wire(msg), `${msg.t} at ${msg.time ?? ''} arrives exactly as made`);
      got.push(whole);
    },
  };
}

test('a whole game arrives exactly as the host made it, and much smaller', () => {
  const players = 4;
  const links = new Map(Array.from({ length: players }, (_, i) => [i, link()]));
  const pending = new Map(Array.from({ length: players }, (_, i) => [i, []]));
  const engine = new HostEngine({
    gameId: '1', title: 'delta', map: readJson('public', 'map.json'), navData: readJson('server', 'data', 'navgrid.json'),
    roster: Array.from({ length: players }, (_, i) => ({ id: i, color: `#00000${i}` })), hostId: 0,
    send: (to, msg) => pending.get(to).push(msg), onEnded: () => {},
  });
  const g = engine.game;
  for (let i = 0; i < players; i++) engine.connect(i);
  for (let i = 0; i < (GAME.startCountdown + 2) * GAME.tickRate && g.prestart; i++) engine.step();

  // Armies everywhere, half of them marching on the nearest enemy city: fights, deaths, captures.
  const far = { x0: -2000, y0: -2100, x1: 2700, y1: 1850 };
  const types = ['infantry', 'archer', 'cavalry', 'knight'];
  for (const p of g.players.values()) {
    const mine = g.cities.filter((c) => c.owner === p.id);
    for (let k = 0; k < 40; k++) g.spawnUnit(mine[k % mine.length], types[k % types.length]);
    p.gold = 5000;
    g.handleCommand(p, { t: 'view', ...far });
    g.handleCommand(p, { t: 'build', cities: mine.map((c) => c.id), item: 'infantry' });
    const home = mine[0];
    const target = g.cities.filter((c) => c.owner !== p.id)
      .sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))[0];
    const army = [...g.units.values()].filter((u) => u.owner === p.id && u.id % 2);
    g.handleCommand(p, { t: 'attack', ids: army.map((u) => u.id), k: 'c', id: target.id });
  }

  const seconds = 30;
  for (let i = 0; i < seconds * GAME.tickRate; i++) {
    // Player 1 zooms in and out every few seconds: units come into view and leave it.
    if (i % 60 === 0) {
      const p = g.players.get(1), c = g.cities.find((x) => x.owner === 1) || g.cities[0];
      g.handleCommand(p, { t: 'view', ...((i / 60) % 2 ? { x0: c.x - 400, y0: c.y - 250, x1: c.x + 400, y1: c.y + 250 } : far) });
    }
    // Player 3's link is replaced every 10 seconds (a reconnect): whole messages again.
    if (i % 200 === 199) links.get(3).reset();
    engine.step();
    for (const [id, list] of pending) {
      const l = links.get(id);
      // Player 2's link is slow: it skips every third snapshot.
      for (const msg of list.splice(0)) l.send(msg, id === 2 && msg.t === 'snap' && l.got.length % 3 === 2);
    }
  }

  const snaps = links.get(0).got.filter((m) => m.t === 'snap');
  assert.ok(snaps.length >= seconds * 9, 'about 10 snapshots a second');
  assert.ok(snaps.some((s) => s.d.length), 'units died');
  assert.ok(links.get(0).got.some((m) => m.t === 'score'), 'scores went out');
  // The skipped snapshots' deaths reached player 2 all the same.
  const deaths = (id) => links.get(id).got.filter((m) => m.t === 'snap').reduce((n, s) => n + s.d.length, 0);
  assert.ok(deaths(2) > 0, 'player 2 saw deaths');
  for (const [id, l] of links) {
    const { raw, sent } = l.bytes();
    assert.ok(sent < raw * 0.4, `player ${id}: ${sent} bytes instead of ${raw}`);
  }
});

test('units: new, gone, moved up the list, off the 0.1 km grid, and nothing changed', () => {
  const e = new DeltaEncoder(), d = new DeltaDecoder();
  const send = (msg) => {
    const out = wire(e.encode(msg));
    const whole = d.decode(out);
    assert.deepStrictEqual(whole, wire(msg));
    return out;
  };
  const unit = (id, x, y, hp = 100) => [id, 0, 1, x, y, hp, 0, 0];
  const snap = (...units) => ({ t: 'snap', time: 1, u: units.flat(), c: [1, 500, 0, -1, 400, 0] });
  const first = send(snap(unit(1, 10.5, -3.2), unit(2, 0, 0), unit(3, 99.9, 1)));
  assert.equal(first.p, 0, 'the first message goes whole');
  const same = send(snap(unit(1, 10.5, -3.2), unit(2, 0, 0), unit(3, 99.9, 1)));
  assert.equal(same.u, undefined, 'nothing changed: no units sent');
  assert.deepEqual(Object.keys(same).sort(), ['m', 'n', 'p', 't']);
  send(snap(unit(1, 13.1, -3.2), unit(3, 99.9, 1, 40), unit(7, 5, 5)));    // moved, 2 died, hurt, new
  send(snap(unit(7, 5, 5), unit(1, 13.1, -3.2), unit(3, 99.9, 1, 40)));    // 7 moved up the list
  send(snap(unit(7, 5.123456, 5), unit(1, 1e6 + 0.1, -3.2)));              // not on the grid, far away
  send(snap(unit(7, Number.NaN, 5), unit(1, -0, -3.2)));                   // as JSON carries them
  send(snap());                                                              // everyone gone
  send(snap(unit(9, 1, 1)));
});

test('cities, queues and players: only what changed, keys that come and go', () => {
  const e = new DeltaEncoder(), d = new DeltaDecoder();
  const send = (msg) => {
    const out = wire(e.encode(msg));
    assert.deepStrictEqual(d.decode(out), wire(msg));
    return out;
  };
  const c = Array.from({ length: 30 }, (_, i) => i % 3 === 1 ? 500 : -1);
  const q = [[4, 1.5, [0, 0], 10, 20, null, null, 0], [9, 0, [1], null, null, 3.5, 4, [0, 5]]];
  send({ t: 'snap', time: 1, u: [], c, q, r: null, tr: [], hc: [] });
  const c2 = c.slice();
  c2[4] = 420;
  const q2 = [[4, 1.6, [0, 0], 10, 20, null, null, 0], q[1]];
  const out = send({ t: 'snap', time: 1.1, u: [], c: c2, q: q2, r: [2, 0.5], tr: [], hc: [], ts: 2 });
  assert.deepEqual(out.s.c, [4, 420], 'one city value changed: just that one');
  assert.deepEqual(out.r.q, [2, [0, 1, 1.6]], 'one queue progressed: just its progress');
  send({ t: 'snap', time: 1.2, u: [], c: c2, q: [q2[1]], r: null, tr: [3], hc: [] });             // speed back to normal, a queue done
  send({ t: 'snap', time: 1.3, u: [], c: c2.slice(0, 27), q: [], r: null, tr: [3, 1], hc: [] });   // fewer cities: sent whole

  const player = (id, units, extra = {}) => ({ id, color: '#fff', connected: true, units, tech: { a: 1 }, liberateAt: undefined, ...extra });
  send({ t: 'score', players: [player(0, 5), player(1, 7)] });
  const s = send({ t: 'score', players: [player(0, 6), player(1, 7)] });
  assert.deepEqual(s.r.players, [2, [0, 'units', 6]]);
  send({ t: 'score', players: [player(0, 6, { liberateAt: 30 }), player(1, 7, { name: 'Bob' })] });
  send({ t: 'score', players: [player(0, 6), player(1, 7, { tech: { a: 2 } }), player(2, 0)] });
});

test('a change to a message the page never got is refused, and a whole one fixes it', () => {
  const e = new DeltaEncoder(), d = new DeltaDecoder();
  const snap = (time) => ({ t: 'snap', time, u: [1, 0, 0, time, 0, 100, 0, 0], c: [] });
  assert.ok(d.decode(wire(e.encode(snap(1)))));
  e.encode(snap(2));                                       // lost on the way
  assert.equal(d.decode(wire(e.encode(snap(3)))), null, 'builds on the lost one');
  const fresh = new DeltaEncoder();                        // the host's answer to 'resync'
  assert.deepStrictEqual(d.decode(wire(fresh.encode(snap(4)))), wire(snap(4)));
  assert.deepStrictEqual(d.decode(wire(fresh.encode(snap(5)))), wire(snap(5)));
  assert.equal(e.encode({ t: 'event', kind: 'turn' }).t, 'event', 'other messages go as they are');
});

test('a skipped snapshot\'s deaths go with the next one', () => {
  const out = new Outgoing();
  const snap = (d) => ({ t: 'snap', d, u: [] });
  out.hold(snap([1, 2, 0, 0]));
  out.hold(snap([3, 4, 1, 0]));
  assert.deepEqual(out.release(snap([9, 9, 2, 1])), snap([1, 2, 0, 0, 3, 4, 1, 0, 9, 9, 2, 1]));
  assert.deepEqual(out.release(snap([])), snap([]), 'only once');
  for (let i = 0; i < 2000; i++) out.hold(snap([i, i, 0, 0]));
  const many = out.release(snap([])).d;
  assert.equal(many.length, 4000, 'a link stuck for long keeps the latest');
  assert.deepEqual(many.slice(-4), [1999, 1999, 0, 0]);
});

test('compressed messages come back the same', { skip: !canDeflate && 'no CompressionStream here' }, async () => {
  const text = JSON.stringify({ t: 'delta', m: 'snap', u: Array.from({ length: 3000 }, (_, i) => i % 7), s: 'é ✓' });
  const data = await deflate(text);
  assert.ok(data.byteLength < text.length / 3);
  assert.equal(await inflate(data), text);
});
