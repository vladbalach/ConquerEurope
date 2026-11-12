// Your units and cities under attack where you aren't looking: one alert per battle, not one per hit.
//
// The page works it out from its snapshots, which carry every unit of yours wherever it is (server/game.js
// sendSnapshots): a unit whose HP went down since the last one was hit, and one that is gone right after a
// hit has died (one gone without a hit went on board a ship). Hits close together make a battle, which
// follows the fighting as it moves. A battle alerts once it has cost enough (ALERT.minShare, or a unit),
// and is over after ALERT.quiet seconds without a hit, so a fight that dies down and flares up again
// alerts again.
//
// Not news, so no alert: a battle on screen (the player is watching it), and hits on units the player sent
// to fight (attack, attack-move) until they are done with it.
//
// How it shows (client.js): every battle pings on the minimap as soon as it counts. The feed line and the
// sound are rate-limited (ALERT.lineEvery, ALERT.soundEvery): battles that start in between wait, then
// share one line. Your city under attack, or a transport of yours under fire with units on board, matters
// more: it alerts at its first hit, without waiting. Shift + Space goes through your last few alerts
// (AlertLog), the newest first.
//
// No DOM and no game data imported: the page passes in what it needs, so the tests can run it
// (test/alerts.test.js).
export const ALERT = {
  radius: 250,          // km: a hit this close to where a battle was last hit belongs to that battle
  quiet: 25,            // game seconds without a hit before a battle is over
  minShare: 0.15,       // a battle of units alerts once its damage adds up to this much of one unit's HP
  deathWindow: 2,       // game seconds: a unit gone from the snapshot this soon after a hit has died
  idleClear: 1.5,       // game seconds idle (not moving, not attacking) that end a fight the player sent it to
  orderWait: 5000,      // ms: a unit sent to fight that never gets moving within this is not on that fight
  lineEvery: 10000,     // ms between two lines in the feed
  soundEvery: 30000,    // ms between two sounds
  urgentSoundGap: 2000, // ms: a city or a loaded transport sounds without waiting, but not twice at once
  log: 5,               // Shift + Space goes through this many of your latest alerts (AlertLog)
  tourMs: 8000,         // ms: Shift + Space pressed again within this goes on to the next older alert
};

// Snapshot unit flags (shared/protocol.js): 1 attacking, 2 moving, 4 disbanding.
const BUSY = 1 | 2;
const DISBANDING = 4;

export class AttackWatch {
  constructor() {
    // Your units in the last snapshot: id -> { t, hp, x, y, max, cargo, hitAt (game time), fighting }.
    this.units = new Map();
    this.owner = null;            // city owners and HP in the last snapshot
    this.hp = null;
    // Your units the player sent to fight: id -> { at (ms), busy (seen moving or attacking since), idleSince }.
    this.fights = new Map();
    // { id, city (-1: units), x, y, at (game time of the last hit), hitAt (ms), share, died, cargo, state }.
    // state: 'quiet' (doesn't count yet), 'waiting' (counts, waits for its line), 'told', 'seen' (on screen).
    this.battles = [];
    this.nextId = 1;
    this.lastLine = -Infinity;
    this.lastSound = -Infinity;
  }

  // The player gave the units `ids` an order: a fight (attack, attack-move) or something else. A queued order
  // (Shift) that is not a fight comes after the current one, which goes on.
  ordered(ids, fight, queue, now) {
    for (const id of ids) {
      if (fight) this.fights.set(id, { at: now, busy: false, idleSince: null });
      else if (!queue) this.fights.delete(id);
    }
  }

  // Is `u` on a fight the player sent it to? Until it has been busy (moving or attacking) and then idle for
  // ALERT.idleClear seconds. An order it never got moving for (its target gone already) came to nothing.
  fighting(u, time, now) {
    const f = this.fights.get(u.id);
    if (!f) return false;
    if (u.flags & BUSY) {
      f.busy = true;
      f.idleSince = null;
      return true;
    }
    if (!f.busy) {
      if (now - f.at < ALERT.orderWait) return true;
    } else {
      if (f.idleSince === null) f.idleSince = time;
      if (time - f.idleSince < ALERT.idleClear) return true;
    }
    this.fights.delete(u.id);
    return false;
  }

  // A new snapshot `s`:
  //   time         game seconds;  now  performance.now()
  //   units        Map id -> { id, t, owner, x, y, hp, flags }, everyone's
  //   you          your player id
  //   cityOwner    owner per city;  cityHp  HP per city;  cities  [{ x, y }] per city
  //   maxHp(u)     a unit's full HP;  cargo(u)  units on board (0 for anything but your loaded transports)
  //   sees(x, y)   is that place on screen, close enough to see a fight there?
  // Returns { pings: battles that count from now on, for the minimap; lines: what the feed says now, each
  // an array of battles (several: one line for all of them); sound: play the alert }.
  update(s) {
    const { time, now, you } = s;
    this.battles = this.battles.filter((b) => time - b.at <= ALERT.quiet);

    const next = new Map();
    for (const u of s.units.values()) {
      if (u.owner !== you) continue;
      const p = this.units.get(u.id);
      const fighting = this.fighting(u, time, now);
      const max = s.maxHp(u), cargo = s.cargo(u);
      let hitAt = p ? p.hitAt : -Infinity;
      // A Hero or a Healer made from a unit keeps its id, with the HP of its new kind: not a hit.
      if (p && p.t === u.t && u.hp < p.hp && !(u.flags & DISBANDING)) {
        hitAt = time;
        if (!fighting) this.hit(u.x, u.y, (p.hp - u.hp) / max, false, cargo, time, now);
      }
      next.set(u.id, { t: u.t, hp: u.hp, x: u.x, y: u.y, max, cargo, hitAt, fighting });
    }
    for (const [id, p] of this.units) {
      if (next.has(id)) continue;
      this.fights.delete(id);
      if (time - p.hitAt <= ALERT.deathWindow && !p.fighting) this.hit(p.x, p.y, p.hp / p.max, true, p.cargo, time, now);
    }
    this.units = next;

    const { cityOwner, cityHp } = s;
    for (let ci = 0; ci < cityOwner.length; ci++) {
      if (cityOwner[ci] !== you) continue;
      if (this.owner && this.owner[ci] === you && cityHp[ci] < this.hp[ci]) this.hitCity(ci, s.cities[ci], time, now);
    }
    // A city of yours captured: its own alert says so (client.js cityLost).
    this.battles = this.battles.filter((b) => b.city < 0 || cityOwner[b.city] === you);
    this.owner = Int16Array.from(cityOwner);
    this.hp = Float32Array.from(cityHp);

    return this.announce(s.sees, now);
  }

  hit(x, y, share, died, cargo, time, now) {
    let b = null, best = ALERT.radius;
    for (const o of this.battles) {
      if (o.city >= 0) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d <= best) { best = d; b = o; }
    }
    if (!b) b = this.open(-1);
    b.x = x;
    b.y = y;
    b.share += share;
    b.died ||= died;
    b.cargo = Math.max(b.cargo, cargo);
    b.at = time;
    b.hitAt = now;
  }

  hitCity(ci, c, time, now) {
    const b = this.battles.find((o) => o.city === ci) || this.open(ci);
    b.x = c.x;
    b.y = c.y;
    b.at = time;
    b.hitAt = now;
  }

  open(city) {
    const b = { id: this.nextId++, city, x: 0, y: 0, at: 0, hitAt: 0, share: 0, died: false, cargo: 0, state: 'quiet' };
    this.battles.push(b);
    return b;
  }

  announce(sees, now) {
    const pings = [], urgent = [], ready = [];
    for (const b of this.battles) {
      if (b.state === 'told' || b.state === 'seen') continue;
      const pressing = b.city >= 0 || b.cargo > 0;
      if (b.state === 'quiet' && !pressing && !b.died && b.share < ALERT.minShare) continue;
      if (sees(b.x, b.y)) { b.state = 'seen'; continue; }
      if (b.state === 'quiet') pings.push(b);
      b.state = 'waiting';
      (pressing ? urgent : ready).push(b);
    }
    const lines = urgent.map((b) => [b]);
    for (const b of urgent) b.state = 'told';
    // Units fighting at a city of yours that is under attack: its line says it already.
    const cities = this.battles.filter((b) => b.city >= 0 && b.state === 'told');
    const near = (b) => cities.some((c) => Math.hypot(c.x - b.x, c.y - b.y) <= ALERT.radius);
    for (const b of ready.filter(near)) b.state = 'told';
    const left = ready.filter((b) => b.state === 'waiting');
    if (left.length && now - this.lastLine >= ALERT.lineEvery) {
      lines.push(left);
      for (const b of left) b.state = 'told';
    }
    let sound = false;
    if (lines.length) {
      this.lastLine = now;
      if (now - this.lastSound >= (urgent.length ? ALERT.urgentSoundGap : ALERT.soundEvery)) {
        sound = true;
        this.lastSound = now;
      }
    }
    return { pings, lines, sound };
  }

}

// Your latest alerts, newest first, ALERT.log of them at most: where Shift + Space goes (client.js showAlert).
// An alert is { key, ... }: the page's own fields (where, what it says). The same key again (a city lost
// twice) moves it to the front. Each press goes to the next older alert; after the oldest, back to the
// newest. A pause of ALERT.tourMs starts over from the newest, and a new alert is next whatever came before.
export class AlertLog {
  constructor() {
    this.list = [];
    this.seen = new Set();       // keys gone to since the last pause
    this.at = -Infinity;         // ms of the last press
  }

  add(e) {
    this.list = [e, ...this.list.filter((o) => o.key !== e.key)].slice(0, ALERT.log);
  }

  drop(test) {
    this.list = this.list.filter((o) => !test(o));
  }

  // The alert to go to now: { e, i (0: newest), n (how many) }, or null with none yet.
  next(now) {
    if (!this.list.length) return null;
    if (now - this.at > ALERT.tourMs) this.seen.clear();
    let i = this.list.findIndex((o) => !this.seen.has(o.key));
    if (i < 0) {
      this.seen.clear();
      i = 0;
    }
    this.seen.add(this.list[i].key);
    this.at = now;
    return { e: this.list[i], i, n: this.list.length };
  }
}
