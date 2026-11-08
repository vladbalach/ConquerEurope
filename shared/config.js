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
export const DEBUG = false;

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
    buildTime: 7,
    hotkey: 'E',
  },
  knight: {
    name: 'Knight',
    hp: 250,
    damage: 45,
    attackRange: 0,
    moveSpeed: 45,
    size: 8,
    hpRegen: 1,
    cost: 150,
    buildTime: 8,
    hotkey: 'R',
  },
  // Ships (naval: true) sail on the sea and are built only in coastal cities (see NAVAL).
  // Barracks don't speed them up.
  //   capacity   units a transport carries, one slot each
  transport: {
    name: 'Transport',
    naval: true,
    hp: 150,
    damage: 0,
    attackRange: 0,
    moveSpeed: 38,
    size: 10,
    hpRegen: 0.5,
    cost: 10,
    buildTime: 12,
    hotkey: 'B',
    capacity: 8,
  },
};

// Order matters: it is the unit type id used on the network and in sprites.
export const UNIT_TYPES = ['infantry', 'archer', 'cavalry', 'knight', 'transport'];

// ------------------------------------------------------------------ navy
//  The coast is where land meets the sea: transports take units on board there and land them.
export const NAVAL = {
  portRange: 30,      // a city with the sea this close is coastal: it can build ships
  editPortRange: 100, // Edit map can make a city coastal when the sea is at most this far
  boardRadius: 30,    // units this close to their transport go on board
  returnRange: 150,   // a transport that lay at anchor this close to the beach it loads at sails back afterwards
  harbourRange: 40,   // a ship this close to the pier of one of its owner's coastal cities is in harbour...
  harbourRegen: 5,    // ...where it regains this much HP per second instead of its hpRegen
                      // (like any regeneration, only after COMBAT.regenDelay seconds without being hit)
};

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
//  requires      this upgrade is the next grade of another one (Wall II of Wall I): it can be
//                ordered once that one is built or queued. It has no button or hotkey of its own:
//                ordering an upgrade the city already has (or has queued) orders its next grade,
//                so pressing A twice queues Wall I and then Wall II.
export const CITY_UPGRADES = {
  wall: { name: 'Wall I', cost: 6, buildTime: 4, hp: 100, hotkey: 'A' },
  wall2: { name: 'Wall II', cost: 14, buildTime: 6, hp: 150, requires: 'wall' },
  tower: { name: 'Tower', cost: 20, buildTime: 10, rangePercent: 55, hotkey: 'S' },
  castle: { name: 'Castle', cost: 20, buildTime: 10, damage: 20, hotkey: 'D' },
  farm: { name: 'Farm', cost: 50, buildTime: 20, goldPerTurn: 5, hotkey: 'F' },
  barracks: { name: 'Barracks', cost: 30, buildTime: 12, trainSpeedPercent: 100, hotkey: 'G' },
};
// Order matters: it is the bit of the upgrade in a city's upgrade flags (sent to the browser).
export const UPGRADE_TYPES = ['wall', 'wall2', 'tower', 'castle', 'farm', 'barracks'];

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
  regionBonusPerCity: 2,      // hold every city of a region: each of them pays this much more per turn
  maxQueue: 10,               // production queue length per city
  maxUnitsPerPlayer: 500,
};

// ------------------------------------------------------------------ liberators
//  Game option "Death: Liberator" (shared/options.js). A player who loses every city and every unit
//  loses all their gold and becomes a liberator: they get gold every turn, and may take any one city
//  on the map (neutral or another player's), at most once every few turns. With a city they are
//  back in the game; if they fall again, it starts over.
export const LIBERATOR = {
  goldPerTurn: 20,            // paid to a liberator at the end of every turn
  cooldownTurns: 2,           // turns between two cities taken this way
  protectedCities: 5,         // a player holding this many cities or fewer can't have one taken this way
};

// ------------------------------------------------------------------ technologies
//  Researched by a player in the Tech window (T): the gold is paid when research starts, and it
//  takes `time` seconds of game time. One research at a time; cancelling gives the gold back.
//  levels: cost and research time of every level, in order (so the number of levels is the maximum).
//
//  Tab 'rebellion' exists only with the game option Death: Liberator. Its technologies can be
//  researched at any time, but work only while the player is a liberator (see LIBERATOR).
//    supporters  +goldPerTurnPerLevel liberator gold per turn for every level
//    influencer  a liberator marks ("influences") cities, one per turn, and liberates them all at once:
//                when as many are marked as the limit, or earlier on request. The limit is 1 without
//                the technology (the city is taken at once) and +citiesPerLevel per level.
//    smuggling   a liberator marks citiesPerLevel more cities per level; at the end of every turn
//                `share` of each one's income goes from its owner to the liberator. These marks are
//                separate from influence marks.
//
//  Tab 'sea' exists in every game; its technologies work as soon as they are researched.
//    seafaring   coastal cities build ships, and units go on board transports and land from them
const levels = (n, cost, time) => Array.from({ length: n }, (_, i) => ({ cost: Array.isArray(cost) ? cost[i] : cost, time }));
export const TECHS = {
  supporters: {
    tab: 'rebellion', name: 'Supporters', goldPerTurnPerLevel: 20,
    levels: levels(3, [100, 180, 260], 120),
  },
  influencer: {
    tab: 'rebellion', name: 'Influencer', citiesPerLevel: 1,
    levels: levels(3, 100, 120),
  },
  smuggling: {
    tab: 'rebellion', name: 'Smuggling', citiesPerLevel: 1, share: 0.5,
    levels: levels(3, 30, 60),
  },
  seafaring: {
    tab: 'sea', name: 'Seafaring',
    levels: levels(1, 100, 30),
  },
};
// Order matters: it is the technology id used on the network.
export const TECH_TYPES = ['supporters', 'influencer', 'smuggling', 'seafaring'];
// Tabs of the Tech window, in order (the window opens on the first). `death`: the tab exists only
// with this game option.
export const TECH_TABS = [
  { id: 'sea', name: 'Sea' },
  { id: 'rebellion', name: 'Rebellion', death: 'liberator' },
];

// ------------------------------------------------------------------ game
export const GAME = {
  maxPlayers: 20,
  startCities: 10,            // random cities every player starts with
  winCities: 120,             // cities needed to win: the default; the host can change it (shared/options.js)
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
