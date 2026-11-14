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
//  damage       damage dealt per second while attacking; per shot for units with `reload`
//  reload       (optional) the unit fires single shots, one every `reload` seconds, instead of
//               dealing its damage every second. The guns reload whatever the unit does, so it
//               may move between shots and fire at once when it attacks again
//  attackRange  reach from the unit's centre to the target's edge; 0 = melee
//  moveSpeed    kilometres per second
//  accelTime    (optional) seconds from standing still to moveSpeed. Without it a unit is at full
//               speed at once; with it, every stop (to shoot, too) costs it ground
//  size         radius of the unit's collision circle (units never overlap)
//  hpRegen      HP regained per second once out of combat (see COMBAT.regenDelay)
//  harbourFactor  (optional, ships) in harbour (NAVAL.harbourRange) the ship regains this many times its
//               hpRegen, so the rate follows hpRegen; ships without it regain NAVAL.harbourRegen there
//  boltSpeed    (optional, battleships) km per second its ballista bolts fly: a shot does its damage
//               when it lands, not when it is fired (server/projectiles.js)
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
  //   tech       the technology (TECHS) a player needs before cities build it
  //   capacity   units a transport carries, one slot each
  transport: {
    name: 'Transport',
    naval: true,
    tech: 'seafaring',
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
  // A warship with ballistas: shoots ships, units ashore and cities within its range, one shot every
  // `reload` seconds. Its bolts fly to their target and do their damage when they land; one at a unit
  // follows it and can't be dodged. With the Gunnery technology it fires cannon shells at land targets
  // instead (TECHS.gunnery). Its shots take a coastal city like any attack; an inland city in reach goes
  // down to 1 HP and no further, for troops to take. Between its shots a city doesn't regenerate
  // (City.receiveDamage).
  battleship: {
    name: 'Battleship',
    naval: true,
    tech: 'warships',
    hp: 500,
    damage: 30,        // per shot
    reload: 1.5,
    boltSpeed: 110,
    attackRange: 60,
    moveSpeed: 32,
    accelTime: 0.75,
    size: 12,
    hpRegen: 1,
    harbourFactor: 2,
    cost: 200,
    buildTime: 20,
    hotkey: 'N',
  },
  // Hero and Healer (`promoted`): never trained in a city. Any plain land unit of yours becomes one for
  // honor, once you have the tradition (Cult of Heroes: see HERO; Order of Mercy: see HEALER). No cost,
  // build time or hotkey; they keep the gold value of the unit they were made from in the Kills and Losses stats.
  // A Hero has no speed or range of its own: it keeps those of the kind it was made from (HERO.kinds).
  hero: {
    name: 'Hero',
    promoted: true,
    hero: true,
    hp: 300,
    damage: 15,
    size: 8,
    hpRegen: 1,
  },
  healer: {
    name: 'Healer',
    promoted: true,
    healer: true,
    hp: 120,
    damage: 5,
    attackRange: 0,
    moveSpeed: 26,     // as infantry
    size: 7,
    hpRegen: 0.7,
  },
};

// Order matters: it is the unit type id used on the network and in sprites.
export const UNIT_TYPES = ['infantry', 'archer', 'cavalry', 'knight', 'transport', 'hero', 'healer', 'battleship'];
// The unit types cities train (all but the ones made from other units: Hero, Healer).
export const TRAINED_UNITS = UNIT_TYPES.filter((type) => !UNITS[type].promoted);

// ------------------------------------------------------------------ navy
//  The coast is where land meets the sea: transports take units on board there and land them.
export const NAVAL = {
  portRange: 30,      // a city with the sea this close is coastal: it can build ships
  editPortRange: 100, // Edit map can make a city coastal when the sea is at most this far
  boardRadius: 30,    // units this close to their transport go on board
  returnRange: 150,   // a transport that lay at anchor this close to the beach it loads at sails back afterwards
  autoloadRange: 200, // Autoload: a transport takes your idle land units this close to it on board
  autoboardRange: 500, // Autoload with land units selected: they look for your transports this close to them
  harbourRange: 60,   // a ship this close to the pier of one of its owner's coastal cities is in harbour...
  harbourRegen: 5,    // ...where it regains this much HP per second instead of its hpRegen (a ship with a
                      // harbourFactor, the battleship: that many times its hpRegen instead)
                      // (like any regeneration, only after COMBAT.regenDelay seconds without being hit)
};

// ------------------------------------------------------------------ cities
export const CITY = {
  hp: 100,
  damage: 20,         // per second, against the nearest enemy unit in range
  attackRange: 70,    // from the city's centre to the target's edge
  hpRegen: 5,         // per second, always (even while under attack), but not between a battleship's shots
  size: 11,           // radius of the city's collision circle
  captureHp: 40,      // HP a city has right after being captured
};

// ------------------------------------------------------------------ city upgrades
//  Built in a city like units: they cost gold, take build time and a place in its production
//  queue. Each can be built once per city. When the city is captured its upgrades are destroyed.
//  hp            extra city HP (and max HP). When it is built the city keeps the share of its HP it had
//                (10% of the old maximum is 10% of the new one)...
//  healPercent   ...and then heals this percent of its new maximum HP (never above it)
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
  wall: { name: 'Wall I', cost: 6, buildTime: 4, hp: 100, healPercent: 10, hotkey: 'A' },
  wall2: { name: 'Wall II', cost: 14, buildTime: 6, hp: 150, healPercent: 10, requires: 'wall' },
  tower: { name: 'Tower', cost: 20, buildTime: 10, rangePercent: 55, hotkey: 'S' },
  castle: { name: 'Castle', cost: 20, buildTime: 10, damage: 20, hotkey: 'D' },
  farm: { name: 'Farm', cost: 50, buildTime: 20, goldPerTurn: 5, hotkey: 'F' },
  barracks: { name: 'Barracks', cost: 30, buildTime: 12, trainSpeedPercent: 100, hotkey: 'G' },
};
// Order matters: it is the bit of the upgrade in a city's upgrade flags (sent to the browser).
export const UPGRADE_TYPES = ['wall', 'wall2', 'tower', 'castle', 'farm', 'barracks'];

// Everything a city can produce. The index is the item id used on the network.
export const PRODUCTION_ITEMS = [...TRAINED_UNITS, ...UPGRADE_TYPES];

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
  startGold: 60,
  turnSeconds: 60,            // length of one turn; gold is paid once at the end of every turn
  goldPerCityPerTurn: 10,     // gold each city you hold pays per turn
  regionBonusPerCity: 2,      // hold every city of a region: each of them pays this much more per turn
  killGoldShare: 0.25,        // a kill pays the killer this share of the destroyed unit's cost (12 gold unit: 3 gold)
  maxQueue: 10,               // production queue length per city
  maxUnitsPerPlayer: 1000,
};

// ------------------------------------------------------------------ honor
//  A resource earned only by fighting: every kill (the same kills as in the Players list) gives the
//  killer honor, as much as the destroyed unit is worth in gold (so honor grows with the Kills column).
//  Shown in the top bar; click it (or press O) for the Honor window, where traditions are learned with it.
export const HONOR = {
  killShare: 1,               // honor per gold of the destroyed unit's cost (1: a 150 gold knight gives 150 honor)
};

//  Traditions: learned once, for good, in the Honor window. Paid in honor when learning starts; it takes
//  `time` seconds of game time. One at a time (separate from technologies); cancelling gives the honor back.
//    heroes        any of your land units can be made a Hero (see HERO)
//    mercy         any of your land units can be made a Healer (see HEALER)
//    brotherhood   Barracks (CITY_UPGRADES.barracks) can be paid with barracksHonor honor instead of their
//                  gold cost: the same building and effect. Either way, they build barracksBuildSpeed times faster
//    honoredDead   every unit of yours that falls gives you lossShare of its cost in honor (the value in the
//                  Losses column). Disbanded units only when an enemy hit them in their last
//                  DISBAND.killCreditSeconds, as for kills; so do the units on board a ship that sank that way.
//  Tier II traditions (`ultimate`; the Honor window tags them Tier II) open only once every tier I tradition
//  is learned. While someone learns one, the Players list shows its countdown; every player is told once it
//  is learned.
//    eternalGlory  every unit a city trains can be paid with unitHonorFactor times its gold cost in honor.
//  Which traditions a player has, and the countdown of an ultimate one being learned, are public (Players list).
export const TRADITIONS = {
  heroes: { name: 'Cult of Heroes', cost: 1500, time: 30 },
  mercy: { name: 'Order of Mercy', cost: 1500, time: 30 },
  brotherhood: { name: 'Brotherhood of Arms', cost: 1500, time: 30, barracksHonor: 30, barracksBuildSpeed: 2 },
  honoredDead: { name: 'Honored Dead', cost: 1500, time: 30, lossShare: 0.25 },
  eternalGlory: { name: 'Eternal Glory', cost: 4000, time: 120, ultimate: true, unitHonorFactor: 3 },
};
// Order matters: it is the tradition id used on the network.
export const TRADITION_TYPES = ['heroes', 'mercy', 'brotherhood', 'honoredDead', 'eternalGlory'];

//  Heroes (tradition Cult of Heroes). Select one of your land units and press Make Hero: for `cost` honor
//  it becomes a Hero (UNITS.hero) where it stands, with its orders and its share of HP. It has the HP and
//  damage of a Hero, but the speed and attack range of its kind: `kinds` maps the unit it was made from to
//  one of HERO_KINDS (a knight makes a cavalry Hero). All the time, every land unit of its owner within
//  auraRadius km of a Hero, the Hero too, deals auraBonus more damage (Game.inspire). Several Heroes don't
//  add up.
export const HERO = {
  cost: 100,
  auraRadius: 80,
  auraBonus: 0.1,
  kinds: { infantry: 'infantry', archer: 'archer', cavalry: 'cavalry', knight: 'cavalry' },
};
// Order matters: a Hero's kind is sent as its index here, in the unit flags (shared/protocol.js).
export const HERO_KINDS = ['infantry', 'archer', 'cavalry'];

//  Healers (tradition Order of Mercy). Select one of your plain land units and press Make Healer: for
//  `cost` honor it becomes a Healer (UNITS.healer) where it stands, like a Hero. Every land unit of its
//  owner within `radius` km of a Healer, the Healer too, regains hpPerSecond HP every second, in combat
//  too, on top of its own regeneration. Several Healers don't add up. Not ships, nor units being disbanded.
export const HEALER = {
  cost: 80,
  radius: 60,
  hpPerSecond: 3,
};

// ------------------------------------------------------------------ liberators
//  Game option "Death: Liberator" (shared/options.js). A player who loses every city and every unit
//  loses all their gold and becomes a liberator: they get gold every turn, and may take any one city
//  on the map (neutral or another player's), at most once every few turns. With a city they are
//  back in the game; if they fall again, it starts over. A player down to renounceCities cities or
//  fewer may renounce: their cities turn neutral, their units are gone, and they fall at once.
export const LIBERATOR = {
  goldPerTurn: 20,            // paid to a liberator at the end of every turn
  cooldownTurns: 2,           // turns between two cities taken this way
  protectedCities: 5,         // a player holding this many cities or fewer can't have one taken this way
  renounceCities: 5,          // a player holding this many cities or fewer may renounce: become a liberator at once
  safeSeconds: 120,           // game seconds a liberated city can't be attacked (cities its liberator captures later can);
                              // longer with TECHS.sanctuary
};

// ------------------------------------------------------------------ technologies
//  Researched by a player in the Tech window (T): the gold is paid when research starts, and it
//  takes `time` seconds of game time. One research at a time; cancelling gives the gold back.
//  levels: cost and research time of every level, in order (so the number of levels is the maximum).
//
//  Tab 'rebellion' exists only with the game option Death: Liberator. Its technologies can be researched
//  only while the player is a liberator (see LIBERATOR), and work only while they are one. A level ordered
//  as a liberator still finishes (and counts the next time they fall) if they come back meanwhile.
//    supporters  +goldPerTurnPerLevel liberator gold per turn for every level
//    influencer  a liberator marks ("influences") cities, one per turn, and liberates them all at once:
//                when as many are marked as the limit, or earlier on request. The limit is 1 without
//                the technology (the city is taken at once) and +citiesPerLevel per level.
//    smuggling   a liberator marks citiesPerLevel more cities per level; at the end of every turn
//                `share` of each one's income goes from its owner to the liberator. These marks are
//                separate from influence marks.
//    sanctuary   a city the liberator takes can't be attacked for safeSecondsPerLevel more seconds per level
//                (LIBERATOR.safeSeconds without it); the level when the city is liberated counts.
//
//  Tab 'sea' exists in every game; its technologies work as soon as they are researched.
//    seafaring   coastal cities build transports, and units go on board them and land from them
//    warships    coastal cities build battleships (UNITS.battleship), armed with ballistas
//    navigation  every ship of the player sails speedPercent percent faster (transports and battleships,
//                those already at sea too; a battleship still needs its accelTime to reach full speed)
//    gunnery     battleships get cannons: at units on land and at cities they fire shells instead of
//                ballista bolts (at ships, still bolts). A shell flies shellSpeed km per second and, like a
//                bolt, follows the unit it was fired at. It does the battleship's whole damage to that unit,
//                and splashShare of that damage to every other enemy unit whose edge is within splashRadius
//                km of it (where it last stood, if it died before the shell landed). A shell at a city
//                bursts on its walls: no splash damage. Ships already at sea get them too.
//
//  Tab 'land' exists in every game; its technologies work as soon as they are researched.
//    roads       every land unit of the player goes speedPercent percent faster while it stands in a region
//                the player holds whole (every city of it: shared/regions.js), units already on the march too
//
//  requires: a technology that must be researched, or ordered before it, first. Cancelling that one
//  cancels this one too (its gold comes back).
const levels = (n, cost, time) => Array.from({ length: n }, (_, i) => ({ cost: Array.isArray(cost) ? cost[i] : cost, time }));
export const TECHS = {
  supporters: {
    tab: 'rebellion', name: 'Supporters', goldPerTurnPerLevel: 20,
    levels: levels(2, 60, 120),
  },
  influencer: {
    tab: 'rebellion', name: 'Influencer', citiesPerLevel: 1,
    levels: levels(3, 50, 120),
  },
  smuggling: {
    tab: 'rebellion', name: 'Smuggling', citiesPerLevel: 1, share: 1,
    levels: levels(3, 15, 20),
  },
  sanctuary: {
    tab: 'rebellion', name: 'Sanctuary', safeSecondsPerLevel: 60,
    levels: levels(2, 40, 90),
  },
  seafaring: {
    tab: 'sea', name: 'Seafaring',
    levels: levels(1, 100, 30),
  },
  warships: {
    tab: 'sea', name: 'Warships', requires: 'seafaring',
    levels: levels(1, 150, 60),
  },
  navigation: {
    tab: 'sea', name: 'Navigation', requires: 'seafaring', speedPercent: 25,
    levels: levels(1, 150, 45),
  },
  gunnery: {
    tab: 'sea', name: 'Gunnery', requires: 'warships', shellSpeed: 90, splashShare: 0.3, splashRadius: 14,
    levels: levels(1, 250, 60),
  },
  roads: {
    tab: 'land', name: 'Roads', speedPercent: 20,
    levels: levels(1, 150, 60),
  },
};
// Order matters: it is the technology id used on the network (new ones go at the end).
export const TECH_TYPES = ['supporters', 'influencer', 'smuggling', 'seafaring', 'warships', 'navigation', 'gunnery', 'roads', 'sanctuary'];
// Tabs of the Tech window, in order (the window opens on the first; lists of technologies follow it too).
// `death`: the tab exists only with this game option. `liberators`: only a liberator may research its technologies.
export const TECH_TABS = [
  { id: 'sea', name: 'Sea' },
  { id: 'land', name: 'Land' },
  { id: 'rebellion', name: 'Rebellion', death: 'liberator', liberators: true },
];

// ------------------------------------------------------------------ game
export const GAME = {
  maxPlayers: 20,
  // Spectators watch a game without playing (Watch in the lobby). They never take one of the maxPlayers
  // places; this many at most, since the host's browser sends each of them the game like a player.
  maxSpectators: 10,
  startCities: 10,            // random cities every player starts with
  winCities: 140,             // cities needed to win: the default; the host can change it (shared/options.js)
  closeToWinCities: 25,       // everyone is told at the top of the screen when a player is this close to the target (or closer)
  formationSpacing: 17,       // distance between units in a group move
  tickRate: 20,               // simulation ticks per second
  snapshotEvery: 2,           // send a network snapshot every N ticks
  // The start of a game run in the host's browser: it waits until every player has loaded it (at most
  // startWait seconds, for a player who never connects), then counts down; only then does anything move.
  startWait: 30,              // a player's page gives up reaching the host after about 22 s (public/js/p2p.js)
  startCountdown: DEBUG ? 0 : 10,   // seconds; none in debug builds: the game starts once everyone has loaded it
  // Seconds between two checkpoints of the game, sent by the host's browser to the lobby server: when the
  // host leaves, another player's browser takes the game over from the last one, so at most this much is lost.
  checkpointEvery: 5,
};

// Chat in the waiting room and in the game (server/index.js, "chat"; public/js/chat.js): the longest message in
// characters, and how many of the last messages are kept, for those who come in (or back) and on screen.
export const CHAT = { maxLength: 200, keep: 50 };

// ------------------------------------------------------------------ community
//  The game's Discord server: a "Join our Discord" button on the start screen and at the foot of the lobby
//  (public/js/main.js). Use an invite link that never expires (Discord: Invite People → Edit invite link →
//  Expire after: Never). Empty: no button.
export const COMMUNITY = { discord: 'https://discord.gg/CvwtuGHP' };

// ------------------------------------------------------------------ map editing
//  Edit map (admins): a region's name can be dragged to a new place and resized with the mouse wheel.
//  Its size stays between these multiples of the size it gets by itself (from the region's area).
export const LABEL_EDIT = { minScale: 0.3, maxScale: 4 };

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
