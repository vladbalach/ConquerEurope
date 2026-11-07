// =====================================================================
//  Conquest of Europa: game configuration
//
//  Everything you may want to tweak lives here. The file is shared by
//  the server (simulation) and the browser (UI), so after editing it
//  restart the server and refresh the page.
//
//  Distances are in kilometres (the map is ~5000 km wide), times in seconds.
// =====================================================================

// ------------------------------------------------------------------ debug
//  Developer tools: the in-game console (press ~) with `stat fps`, `stat unit` and
//  `stat unitgraph`, plus server timings sent to the browser.
//  SET TO false BEFORE PUBLISHING: the debug code is then not even loaded.
export const DEBUG = true;

// ------------------------------------------------------------------ units
//  hp           maximum hit points
//  damage       damage dealt per second while attacking
//  attackRange  reach from the unit's centre to the target's edge; 0 = melee
//  moveSpeed    kilometres per second
//  size         radius of the unit's collision circle (units never overlap)
//  hpRegen      HP regained per second once out of combat (see COMBAT.regenDelay)
//  cost         gold
//  buildTime    seconds to produce in a city
//  hotkey       key that builds the unit while one of your cities is selected
export const UNITS = {
  infantry: {
    name: 'Infantry',
    hp: 100,
    damage: 15,
    attackRange: 0,
    moveSpeed: 26,
    size: 6,
    hpRegen: 0.7,
    cost: 12,
    buildTime: 6,
    hotkey: 'Q',
    archerDamageReduction: 0.10,   // share of incoming archer damage that is blocked
  },
  archer: {
    name: 'Archers',
    hp: 30,
    damage: 10,
    attackRange: 55,
    moveSpeed: 26,
    size: 6,
    hpRegen: 0.4,
    cost: 10,
    buildTime: 6,
    hotkey: 'W',
  },
  cavalry: {
    name: 'Cavalry',
    hp: 70,
    damage: 15,
    attackRange: 0,
    moveSpeed: 52,
    size: 7,
    hpRegen: 0.5,
    cost: 20,
    buildTime: 10,
    hotkey: 'E',
  },
  knight: {
    name: 'Knight',
    hp: 200,
    damage: 45,
    attackRange: 0,
    moveSpeed: 45,
    size: 8,
    hpRegen: 1,
    cost: 150,
    buildTime: 8,
    hotkey: 'R',
  },
};

// Order matters: it is the unit type id used on the network and in sprites.
export const UNIT_TYPES = ['infantry', 'archer', 'cavalry', 'knight'];

// ------------------------------------------------------------------ cities
export const CITY = {
  hp: 100,
  damage: 20,         // per second, against the nearest enemy unit in range
  attackRange: 70,    // from the city's centre to the target's edge
  hpRegen: 5,         // per second, always (even while under attack)
  size: 11,           // radius of the city's collision circle
  captureHp: 40,      // HP a city has right after being captured
};

// ------------------------------------------------------------------ city upgrades
//  Built in a city like units: they cost gold, take build time and a place in its production
//  queue. Each can be built once per city. When the city is captured its upgrades are destroyed.
//  hp            extra city HP (and max HP)
//  rangePercent  extra city attack range, in percent of CITY.attackRange
//  damage        extra city damage per second
//  goldPerTurn   extra gold the city pays its owner every turn
//  trainSpeedPercent  units are trained this much faster in the city (40 = 1.4x speed, so a 6 s
//                unit takes about 4.3 s). Upgrades are built at normal speed.
//  hotkey        key that orders it while one or more of your cities are selected
//                (A and S mean attack-move and stop only while units are selected)
export const CITY_UPGRADES = {
  wall: { name: 'Wall', cost: 20, buildTime: 20, hp: 200, hotkey: 'A' },
  tower: { name: 'Tower', cost: 20, buildTime: 20, rangePercent: 20, hotkey: 'S' },
  castle: { name: 'Castle', cost: 30, buildTime: 30, damage: 15, hotkey: 'D' },
  farm: { name: 'Farm', cost: 50, buildTime: 30, goldPerTurn: 5, hotkey: 'F' },
  barracks: { name: 'Barracks', cost: 50, buildTime: 20, trainSpeedPercent: 40, hotkey: 'G' },
};
export const UPGRADE_TYPES = ['wall', 'tower', 'castle', 'farm', 'barracks'];

// Everything a city can produce. The index is the item id used on the network.
export const PRODUCTION_ITEMS = [...UNIT_TYPES, ...UPGRADE_TYPES];

// ------------------------------------------------------------------ combat
export const COMBAT = {
  regenDelay: 3,      // seconds without dealing or taking damage before units regenerate
  visionRange: 80,    // how far units see enemies. Enemy units in sight are always fought first; a city is
                      // attacked on a unit's own initiative only when no enemy unit is in sight
                      // (an explicit attack order on a city is always obeyed).
  leashRange: 180,    // idle units give up a chase this far from where they were standing
  meleeReach: 4,      // extra gap allowed between two circles for a melee hit
};

// Delete key: the selected units are disbanded. They lose HP until they die (no regeneration)
// and keep obeying orders meanwhile. Cities can't be disbanded.
export const DISBAND = {
  hpPerSecond: 10,
  // A disbanded unit always counts as a loss for its owner. It counts as a kill for the last
  // player who hit it only if that hit was at most this many seconds before it died.
  killCreditSeconds: 20,
};

// ------------------------------------------------------------------ economy
export const ECONOMY = {
  startGold: 50,
  turnSeconds: 60,            // length of one turn; gold is paid once at the end of every turn
  goldPerCityPerTurn: 10,     // gold each city you hold pays per turn
  maxQueue: 10,               // production queue length per city
  maxUnitsPerPlayer: 1000,
};

// ------------------------------------------------------------------ game
export const GAME = {
  maxPlayers: 20,
  startCities: 10,            // random cities every player starts with
  winCities: 120,             // cities needed to win
  formationSpacing: 17,       // distance between units in a group move
  tickRate: 20,               // simulation ticks per second
  snapshotEvery: 2,           // send a network snapshot every N ticks
};

// ------------------------------------------------------------------ colours
export const PLAYER_COLORS = [
  '#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#ffe119', '#800000', '#000075',
  '#469990', '#9a6324', '#bfef45', '#808000', '#fabed4',
  '#dcbeff', '#aaffc3', '#2b2b2b', '#ffffff', '#ff8c69',
];
// In a game players are known only by colour (GAME_DESIGN.md, "Anonymous players"): "Red", "Teal", ...
export const PLAYER_COLOR_NAMES = {
  '#e6194b': 'Red', '#4363d8': 'Blue', '#3cb44b': 'Green', '#f58231': 'Orange', '#911eb4': 'Purple',
  '#42d4f4': 'Cyan', '#f032e6': 'Magenta', '#ffe119': 'Yellow', '#800000': 'Maroon', '#000075': 'Navy',
  '#469990': 'Teal', '#9a6324': 'Brown', '#bfef45': 'Lime', '#808000': 'Olive', '#fabed4': 'Pink',
  '#dcbeff': 'Lavender', '#aaffc3': 'Mint', '#2b2b2b': 'Black', '#ffffff': 'White', '#ff8c69': 'Salmon',
};
export const NEUTRAL_COLOR = '#8c8c8c';
