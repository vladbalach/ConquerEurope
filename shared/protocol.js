// Version of the messages exchanged between the browser and the server. Bump it whenever
// a message changes shape, so a page talking to an outdated server process can say so
// instead of silently misbehaving.
export const PROTOCOL_VERSION = 34;  // 3: city upgrades, item ids; 4: farm; 5: knight; 6: live balance + admin; 7: barracks; 8: disband; 9: map editing; 10: game options; 11: hold; 12: death option, liberators; 13: technologies, influence, smuggling; 14: ships, ports, boarding, coastal edits; 15: Shift-queued orders; 16: wall grades; 17: kill gold, honor; 18: traditions, heroes, war cry; 19: start countdown; 20: Barracks for honor (Brotherhood of Arms); 21: Healers (Order of Mercy), promote `to`; 22: Eternal Glory (units for honor, honor per queue entry, public traditions, ultimate events); 23: game speed (slomo: setSpeed, snapshot `ts`); 24: game history in gameover, long messages in parts; 25: snapshots and scores as deltas between browsers (delta), compressed data channels, resync; 26: "Own" a city (takeCity, capture `debug`); 27: Order of Mercy before Brotherhood of Arms (tradition ids); 28: Last Stand (tradition id 5, unit flag 32 standing firm, ship cargo from bit 6, players' `ultimate`); 29: Hero aura instead of War Cry (no warCry, hc, cr), a Hero's kind in its flags; 30: surrender (players' `surrendered`), a duel's Restart (restart, restartVotes, restarted); 31: cancel the last queue entry (cancel `last` with `cities`); 32: host handover (checkpoint, hostGone, host `save`/`departed`, `epoch` in host/connectHost/hello hosting, connectHost `moved`, leave `gameId`); 33: Last Stand removed (tradition id 5, unit flag 32); 34: battleships (unit type 7, production items after transport shift by one, tech Gunnery id 4, unit flag 16 a shot fired)

// Unit flags in snapshots: 1 attacking, 2 moving, 4 disbanding, 8 on hold, 16 fired a shot since the last
// snapshot (units with `reload`: battleships); 32 is free (it was Last Stand). Bits 6-7: a Hero's kind, its
// index in HERO_KINDS (what it was made from: heroKindOf). From bit CARGO_SHIFT up (flags >> CARGO_SHIFT): a ship's cargo count, 0 for any other unit.
export const HERO_KIND_SHIFT = 6;
export const CARGO_SHIFT = 8;

// A Hero's kind index from its snapshot flags.
export function heroKindOf(flags) { return (flags >> HERO_KIND_SHIFT) & 3; }
