# Conquest of Europa

A multiplayer, top-down real-time strategy game played in the browser on a map of Europe.
Up to 20 players each start with 10 random cities and race to hold **120 of the 223 cities** (the host can
change the number, and by default it counts down every turn).

Core design rules, such as anonymous players, are in [GAME_DESIGN.md](GAME_DESIGN.md).

## Running

On Windows, double-click **`start-server.bat`**:
- It installs dependencies on first run.
- It runs the server in its console window (visible in the taskbar) and opens the game in your web browser.
- Closing that window stops the server. Games are kept only in memory, so every start is a clean reset.
- If an older game server is still running on the port, it is stopped first, so the latest code always runs.

Or from a terminal:

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change)
npm test             # automated tests (test/*.test.js)
```

Open the URL, type a name, then create a game or join one from the lobby. All games are public, and the lobby
lists every game with its players (offline players are greyed out). The host starts the game; it can be started
solo to practise against neutral cities. Once a game has started, nobody new can join it.

**Players are anonymous during a game:** everyone is known only by colour ("Red", "Teal", ...; you are "You"), and
for a game in progress the lobby lists nicknames only. Everyone is revealed on the results screen. The rule is in
[GAME_DESIGN.md](GAME_DESIGN.md).

**Coming back after a disconnect:** a player who drops out keeps their empire (it can still be conquered) until
the game ends.
- Refreshing the tab resumes the game automatically.
- From a new tab, or after closing the browser, the lobby shows a **Rejoin** button on that game. It is matched by a
  token saved in the browser, or by your name if a player with that name is currently offline.
- This works for the host too: when the host's tab is closed or refreshed, another player's browser takes the game
  over (see "The host leaving" below), and the host comes back as any other player.

To try multiplayer on one machine, open a second browser window and use a different name in each tab.

### Browser to browser: the host's browser runs the game

The server only runs the lobby. When the host presses Start, the game runs in the **host player's browser**, and
every other player's browser connects straight to it (WebRTC data channels), like a "listen server" in other games.
So the server needs almost no CPU or bandwidth, and it can run on a free plan.

- **The server:** names, lobby, waiting room, rejoin tokens, admin balance and map edits. When a game starts, it deals
  the colours, gives the host's browser the list of players (ids and colours, no nicknames), and passes the WebRTC
  connection messages between each player and the host. When the game ends, it reveals every nickname.
- **The host's browser:** simulates the game in a Web Worker ([server/host-engine.js](server/host-engine.js), the same
  code the tests run in Node, served to browsers as `/sim/`). A worker keeps full speed while the host's tab is in
  the background. The host sends each player the changes since the last snapshot, compressed
  ([public/js/delta.js](public/js/delta.js)): with the whole map in view, about 2–20 KB/s per player in a game of 2–8
  players, 45 KB/s with 20 players of 100 units each. So the host needs about 1 Mbit/s of upload for 8 players and
  7 Mbit/s for 20.
- **Other browsers:** send their orders to the host and get snapshots back, as they did from the server before.
- **The start:** the host's game stands still until every player's link is open (at most 30 seconds, for a player who
  never connects), then counts down 10 seconds, so the host gets no head start (`GAME.startWait`,
  `GAME.startCountdown` in [shared/config.js](shared/config.js)). Debug builds skip the countdown: the game starts as
  soon as every player has loaded it.
- **The host leaving:** the game moves to another player's browser and goes on.
  - Every 5 seconds the host's browser sends the server a checkpoint of the whole game (`GAME.checkpointEvery`,
    [server/save.js](server/save.js)), packed: about 10–250 KB depending on the armies. That is 2–50 KB/s of the
    host's upload, and as much incoming traffic for the server, which most hosts don't count. The server only keeps
    the last one and never reads it.
  - When the host presses Leave → Leave game, closes or refreshes its tab, or its connection to the server is gone
    for more than 5 seconds, the server hands the last checkpoint to another player's browser (a player still in
    the game first), which runs the game from there. Everyone else connects to it on their own. Players see "The
    host is gone: the game moves to another player's browser" and lose at most the last few seconds of play.
  - A host who pressed Leave gives up their empire, as any player does. A host whose tab closed or whose connection
    dropped keeps it and comes back as an ordinary player (refresh, or Rejoin in the lobby). If the old host's tab
    was still running the game (only its connection to the server dropped), it stops it and joins the new host.
  - With nobody else online, the game waits without a host; the first player to come back runs it.
  - The server pings every connection every 5 seconds, so it notices a crashed browser or a lost network within
    about 15 seconds. Before the first checkpoint (the first second or so of a game), a host leaving still ends it.
- **Cheating:** the host's browser decides everything, so a host could cheat. Fine among friends.
- **The lobby connection:** each tab pings the server every 4 minutes. This keeps a free host that sleeps when idle
  (for example Render) awake during a game. If the server restarts anyway, games in progress carry on; only
  rejoining them, and handing them to another player when the host goes, is no longer possible.

**Connecting players (STUN and TURN).** By default browsers find a direct path to each other with free public STUN
servers (Cloudflare, Google). That works on most home networks. Some company or mobile networks block direct links;
for those, set up a TURN relay with environment variables on the server ([server/ice.js](server/ice.js)):

| Variable | Effect |
|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN` | Cloudflare Realtime TURN (first 1,000 GB a month free). The key stays on the server; browsers get short-lived credentials. |
| `ICE_SERVERS` | A JSON array of `RTCIceServer` objects used instead of the defaults, for any other STUN/TURN provider. |
| `RELAY_ONLY=1` | All traffic goes through the TURN relay. Without it, a direct link shows the host each player's IP address, which could tell friends who is who. With it, nobody learns another player's address. Needs a TURN server. |

**Automatic fallback through the server.** If a player's direct link to the host has not opened after 7 seconds,
their game goes through the lobby server instead (`relay` messages), and they see "No direct connection to the
host: your game goes through the server." The same happens when a direct link dies during a game (a network
change, a laptop going to sleep, a browser pausing a background tab): the player carries on through the server, and
the others see them leave and come back. The game plays the same. It just costs the server bandwidth, about
0.02–0.15 GB per relayed player per hour (changes only, and compressed). On a free plan with a small monthly allowance
(Render: 5 GB), set up the Cloudflare TURN relay above if many of your players need the fallback. The browser
console (F12) says which way each player connected.

## Rules

| | HP | Damage | Range | Speed | Regen* | Cost | Build time |
|---|---|---|---|---|---|---|---|
| Infantry | 100 | 15/s | melee | 26 | 0.7/s | 12 | 6 s |
| Archers | 30 | 10/s | 55 | 26 | 0.4/s | 10 | 6 s |
| Cavalry | 70 | 15/s | melee | 52 | 0.5/s | 20 | 7 s |
| Knight | 250 | 45/s | melee | 45 | 1/s | 150 | 8 s |
| Transport (ship) | 150 | — | — | 38 | 0.5/s, 5/s in harbour | 10 | 12 s |
| Battleship (ship) | 500 | 30 per shot, every 1.5 s | 60 | 32 (0.75 s to get there from a stop) | 1/s, 2× that in harbour | 200 | 20 s |
| City | 100 | 20/s | 70 | — | 5/s (always, but not between a battleship's shots) | — | — |

\* Units regenerate only after 3 seconds without fighting.

- **Land units walk on land:** they find their own way around seas but cannot cross water, so islands
  (Britain, Ireland, Sicily, Sardinia, Zealand, Crete, Cyprus, Iceland, Greenland, ...) are reached only by transport (see
  Navy). A move order onto another landmass takes units to the nearest shore they can reach. Archers can still shoot
  across a narrow strait.
- **Group moves:** a group sent somewhere (move or attack-move) spreads into one formation round the place (one per
  landmass the units stand on), and each unit goes its own way to its spot: straight when nothing is in its way,
  otherwise round it, sharing the way of a unit within 50 km. Nobody walks to a common gathering point first. No
  spot is inside a city's walls. Each unit keeps its spot once there: held up on the way by the crowd, or pushed
  off it, it walks back to it, and it steps aside for your units walking through. A unit whose spot stays taken
  gives it up after a while and stands where it is.
  In the formation the infantry stands in front, the archers behind it and Healers at the back; cavalry and knights
  split into two wings, left and right (a Hero by its kind). At sea, battleships sail in front of the transports.
  The formation faces the way the group goes, or the way you drag the right button: hold it and grey ghosts show
  where each unit will stand; drag, and the formation turns to face the way you drag. Letting go gives the order.
- **Mountains:** no unit crosses them. The great ranges are on the map (the Alps, Pyrenees, Carpathians, Caucasus,
  Scandinavian Mountains, Apennines, Dinaric Alps, Atlas, Taurus, Urals and more, [tools/mountains.js](tools/mountains.js)),
  drawn as solid rocky ground with hill signs on it (neither the colour of the region they lie in nor its borders show
  through them). Admins can paint more and erase them in Edit map. Units walk round them or through their **passes**, gaps at least 20 km
  wide where the real ones are: Mont Cenis, Gotthard and Brenner across the Alps, Somport in the Pyrenees, Dukla,
  Oituz and Turnu Roșu in the Carpathians, Shipka in the Balkans, Darial in the Caucasus, the Cilician Gates... A move
  order into the mountains takes units to the open land nearest to the spot. The ranges never come within 12 km of the
  sea, so a road runs along the coast past them (mountains admins paint may close it), nor within 35 km of a city, so
  every city has room around it. No land is walled in: every city reaches every other city of its landmass, as
  without mountains. What the map draws is exactly what blocks units: both come from the same cells of the land grid.
  **Nothing shoots over mountains:** archers, battleships and cities hit only targets with no mountain cell on the
  straight line to them (`NavGrid.lineOfFire`). An archer told to attack a target behind them walks round until it
  has a clear shot; a city doesn't fire at units behind them. Melee units are not affected.
- **Navy:** ships sail only on the sea. Building transports, and taking units on board or landing them, needs the
  **Seafaring** technology (Tech, Sea tab: 100 gold, 30 s); battleships need **Gunnery** as well (150 gold, 60 s).
  **Navigation** (120 gold, 45 s) makes all your ships 20% faster.
  - **Coastal cities:** a city with the sea within 30 km is coastal (admins can change it in Edit map). It is marked with an anchor (next to the castle, or
    next to the dot when zoomed out), has a timber pier where its ships are launched, and its panel says Port. Only
    coastal cities build ships (Barracks don't speed them up). Every city has two rally points: right-click land (cities selected) for new units, right-click the water for new ships of coastal cities on that sea. Without one, new ships stay in the port.
  - **Beaches and cliffs:** transports take units on board and land them only on **beaches**, drawn as shallow
    water off the shore (a soft teal fringe) with a thin line of sand. All of the coast is beach, every island's
    too (`markBeaches` in [server/nav.js](server/nav.js)); only where admins paint cliffs in Edit map is it cliff
    (the plain dark line against deep water), where ships can't dock. What the map shows is exactly where ships
    dock: every piece of drawn coastline takes the state of the land-grid cell nearest to it, and only those cells
    can be beaches ([shared/coastline.js](shared/coastline.js)). Islets too small for the 5 km land grid have no
    land to land on: their coast is drawn plain.
  - **Seas:** the Mediterranean, the Atlantic, the North Sea and the Baltic are one sea. The Black Sea joins it through
    the Bosporus and the Dardanelles, which only ships can pass. The Caspian is a sea of its own. Lakes can't be sailed.
  - **Repairs:** a ship within 40 km of the pier of one of your coastal cities regains 5 HP per second instead of 0.5,
    once it has not been hit for 3 seconds (`NAVAL.harbourRange`, `NAVAL.harbourRegen`). A battleship instead repairs
    there at **twice its own regeneration** (`harbourFactor` in `UNITS.battleship`), so the harbour rate follows any
    change to its regeneration; it doesn't repair while it is shooting either.
  - **Transport:** carries 8 units, one place each. It has no weapons. Cities shoot ships like any unit (neutral cities
    shoot everyone), and archers on the shore can hit them. Ships steer clear of the range of coastal cities where the
    sea allows, but not around the city they sail from or to. A sunk transport takes everyone on board with it: they count
    as losses, and as kills for whoever sank it.
  - **Battleship** (**N**, needs Gunnery): a warship that fights like archers do on land. It shells anything within
    60 km of it: other ships, units on the shore and cities. It fires single shots, **30 damage every 1.5 seconds**,
    and its guns reload whatever it does, sailing included. So you can **shoot, move, shoot**: let it fire, sail it
    out of trouble, and order the attack again once it has reloaded; it fires on the first moment the target is in
    reach. A battleship is heavy: from a standstill (it stops to shoot, too) it takes **0.75 s to reach full speed**,
    so a ship that keeps running gains on one that stops to fire. A plain move order never shoots; attack-move (A + right click) fights whatever it meets, and an idle
    battleship fires at enemies in reach and goes after enemy ships in sight. Attack a unit or city on land and it
    sails to the water nearest to the target that is within its range and has a clear line of fire to it, no
    mountains in between (none there: the order is dropped). Its guns never fire over mountains.
    A battleship **takes a coastal city** (one marked with an anchor) like any other attack, when its shot brings
    the city's HP to zero. An **inland city** within its range goes down to **1 HP and no further**: troops have to
    take it. A city regenerates even under attack, but **not between a battleship's shots**: each shot stops its regeneration until
    the ship could fire again (1.5 s), so it doesn't win back between shots what it loses to them. Cities outrange
    battleships (70 km against 60) and fire at them all the while; walls and a castle make a coastal city a hard
    target for a lone ship.
  - **Going on board:** select land units and right-click one of your transports. While land units are selected, your
    transports with room left glow light blue (full ones don't). The transport can be anywhere on the sea: the units
    pick the free beach nearest to them and gather on the shore there, and the transport sails to it, however far
    (only a transport on a sea without a beach of their land, such as the Caspian for Britain, says no). More units
    sent to a transport already on its way join the same place. Within 30 km
    of the transport they disappear from the map into its places. Only the units that fit are sent, the closest first;
    the others keep their orders. Once boarding is over (everyone sent is on board, however few; it is full; or the
    rest were given other orders) a transport that lay at anchor sails back there, and one that was still sailing
    somewhere goes on there, unless Shift queued something else for it. Only from within 150 km of the beach: from
    farther away it stays at the beach.
  - **Several transports, one selection:** right-click transports one after another and they share the selection out:
    units already on their way to a transport stay with it, and each next transport takes the closest units that have
    none. Select the units again (a new selection) and the next transport may take any of them, away from the transport
    they were going to. Any other order (move, attack, stop, hold, disband) ends their boarding.
  - **Autoload:** select transports (one or a whole fleet) and press **Autoload** in the panel (or **L**). Your idle
    land units within 200 km of them go on board: each unit to the nearest selected transport that still has room,
    so the fleet shares out the army around it. Each transport takes units of one landmass only (the one it already
    loads at, otherwise that of the nearest unit it gets) and sails to the free beach nearest to its share, as with a
    right-click. Units with orders (walking, fighting, holding, already on their way to a transport) stay where they
    are, and so do units on land without a beach on the transports' sea. The feed says how many go.
    **The other way round:** select land units and press **Board transports** in the panel (or **L**): they find your
    transports with room within 500 km of them (lying idle, or already waiting at a beach; transports sailing
    somewhere or landing units are left alone) and go on board the same way, whatever orders they had. With land
    units and transports selected together, the units ask the same way: the selected transports (full ones, often)
    are no matter, and a free transport nearby takes them.
  - **Hidden cargo:** only a transport's owner sees how many units it carries (the number on the boat, and in its
    panel); other players see the boat, but not its cargo (its panel says ? on board).
  - **Landing:** select transports with units on board and press **Unload** in the panel (or **U**), then click any land
    or city (also on the minimap). Each transport sails to the beach nearest to that place, puts everyone ashore and
    sends them there: they attack it when it is an enemy city. Right-click or Esc cancels. Quicker: right-click land or
    an enemy city with them selected does the same, and units landed on a right-click attack-move to the place,
    fighting anything on the way (on the water, or without units on board, the transports just sail there).
    A unit steps ashore only where there is room for it (within 30 km of the landing place, clear of other units and
    city walls). The others wait on board, and the transport waits with them until there is room; the feed says so.
    **Storming a city** is the exception: nobody stays on board under its guns. Units that find no room by the beach
    squeeze in among the others (the crowd pushes itself apart on land), or step ashore farther along the coast;
    this holds for the transports still arriving after the city has fallen too.
    Everyone on board the transports sent together gets a place of their own in one formation round the place, as
    seen from where their transport lands them, and finds its own way there from the beach: a fleet landing along a
    long coast spreads round the place instead of every transport's units heading for the same spot. Shift-queued
    orders on land for them (below) get one such formation too.
  - **Shift with loaded transports:** clicks on the water are the transports' path. The **first click on land**, with
    or without Shift, is where they park and land the units (with Shift: after the path; on an enemy city: to storm
    it). **Every later Shift + right-click on land** (a place, or an enemy unit or city to attack; with A, an
    attack-move) is an order for the units on board: once ashore they set off from the beach for them, one after
    another, instead of marching to the place where they were landed (storming a city, they take it first). With no
    such orders they march there, as without Shift. **Shift + right-click on the water** after the landing is the
    transports' own again: they sail there once everyone is ashore. Select the transports to see their path, where
    they park, and the units' way drawn from the beach.
  - **Docks:** each transport taking units on board or landing them gets its own dock: the free spot on a beach
    nearest to where it is sent, clear of the docks of other ships and of ships lying idle. Several transports sent
    together spread along the shore, the nearest ones closest to the target. While one is on its way, your map shows
    its berth (a dashed outline with an anchor and a line from the ship) and the shore point next to it (light blue:
    units gather there to come on board; green: they land there).
  - Units on board count as yours (top bar, Players list). The numbers are in `NAVAL`, `UNITS.transport` and
    `UNITS.battleship` in [shared/config.js](shared/config.js).
- **City upgrades:** built in a city like units (they cost gold, take time, use a queue slot), once per city.
  The wall has two grades with one button (**A**): each order queues the next grade, so pressing A twice queues
  Wall I and then Wall II. Stop at Wall I when that is enough. Cancelling Wall I also cancels the Wall II queued
  after it (both are refunded).

  | Upgrade | Cost | Time | Effect |
  |---|---|---|---|
  | Wall I | 6 | 4 s | +100 HP |
  | Wall II | 14 | 6 s | +150 HP more (+250 with Wall I). Needs Wall I built or queued |
  | Tower | 20 | 10 s | +55% attack range |
  | Castle | 20 | 10 s | +20 damage |
  | Farm | 50 | 20 s | +5 gold per turn from this city |
  | Barracks | 30 | 12 s | Units train twice as fast in this city (6 s → 3 s, 7 s → 3.5 s). Upgrades and ships build at normal speed |

  They show on the map: a stone ring wall (thicker and with turrets at Wall II), a tall side tower, a taller keep flying a banner, a golden wheat
  field, and a timber hall roofed in the owner's colour. When the city is captured its upgrades are destroyed.
- **Target priority:** units always fight enemy units first. They attack a city on their own only when no enemy unit
  is in sight. An explicit attack order on a city is always obeyed.
- **Capturing:** bring a city's HP to 0 to capture it. It switches to the attacker with 40 HP. Its production queue is
  cleared, and the previous owner gets back the gold for every unit in it that was not finished.
- **Turns and gold:** the game runs in turns of 60 seconds. At the end of every turn each city pays its owner
  10 gold, all at once. The top bar shows how many turns have passed and the countdown to the next payout.
  A clock ticks in the last 3 seconds of every turn.
  Players start with 50 gold. The **Economy** page of the help (F1) explains every way to get gold.
- **Kills pay:** destroying an enemy unit pays you **25% of its cost** in gold at once (Infantry 3, Archers 2.5,
  Cavalry 5, Knight 37.5, Transport 2.5, Battleship 50) and **its full cost in honor** (Infantry 12, Archers 10, Cavalry 20,
  Knight 150, Transport 10, Battleship 200): honor grows exactly like your Kills in the Players list. Honor is shown with a silver star
  in the top bar next to your gold, and is spent in the Honor window (below). A kill is the same as in the Players list: whoever landed the last
  hit gets it (your cities' kills are yours, a neutral city's kills pay nobody), the units on board a sunk transport
  count for whoever sank it, and a disbanded unit pays the last player who hit it in the 20 seconds before it died.
  The top bar shows gold rounded down; halves still add up. The numbers are `killGoldShare` in `ECONOMY` and `HONOR`
  in [shared/config.js](shared/config.js).
- **Honor and traditions:** click the honor star in the top bar (or press **O**) for the Honor window. There you learn
  **traditions** with honor: once, for good, one at a time (alongside any research), and cancelling gives the honor
  back. Learn more while one is being learned and they are **queued** (the button says **Queue**): each is paid when
  ordered and starts once the one before it is done. Its row shows its place in the queue and **Remove**, which gives
  the honor back. A tier II tradition can be queued once every tier I one is learned or queued ahead of it; removing a
  tier I one removes the queued tier II ones too. Your honor is private. The traditions each player has are public: the Players
  list (Tab) shows them in a Traditions column, an icon each (the name on hover).

  | Tradition | Cost | Time | Effect |
  |---|---|---|---|
  | Cult of Heroes | 1500 honor | 30 s | Any of your land units can be made a Hero |
  | Order of Mercy | 1500 honor | 30 s | Any of your land units can be made a Healer |
  | Brotherhood of Arms | 1500 honor | 30 s | Barracks can be paid with 30 honor instead of 30 gold, and build twice as fast either way |
  | Honored Dead | 1500 honor | 30 s | Every unit of yours that falls gives you 25% of its cost in honor |
  | **Eternal Glory** (tier II) | 4000 honor | 2 min | Every unit can be trained for honor, at 3 times its gold cost. Only once every tier I tradition is learned |

  - **Heroes:** select one of your land units (not a ship, not one being disbanded) and press **C** (or **Make Hero**
    in its panel): for **100 honor** it becomes a Hero where it stands, keeping its orders and its share of HP. A Hero has
    300 HP and 15 damage per second, and **the speed and attack range of what it was**: infantry make an Infantry
    Hero (melee), archers an Archer Hero (it shoots from afar), cavalry and knights a Cavalry Hero (it rides). The unit
    panel names its kind. Cities never train Heroes. In the Kills and Losses stats a Hero is worth the gold of the unit
    it was made from. On the map it has a crown and a gold ring.
  - **A Hero's aura:** all the time, every land unit of yours within **80 km** of a Hero, the Hero too, deals **10%
    more damage**. Nothing to press, no cooldown. Several Heroes don't add up: +10% at most. Your selected Hero shows
    how far it reaches, a faint gold dashed circle.
  - **Barracks for honor (Brotherhood of Arms):** with cities selected, the build column shows a second Barracks
    button under the usual one, in the Honor window's colours: **Barracks ★ 30** (or **Shift + G**). It queues the same
    Barracks (same effect) paid with 30 honor instead of 30 gold, in each selected city that has none
    yet, as far as your honor reaches. Gold works as before. Either way, with this tradition Barracks build twice as
    fast (6 s instead of 12 s). In the queue it carries a small silver star; cancelling it
    gives the honor back, and so does losing the city while it waits. A built one is lost with the city like any upgrade.
  - **Healers (Order of Mercy):** select one of your plain land units and press **Make Healer** in its panel: for
    **80 honor** it becomes a Healer where it stands, keeping its orders and its share of HP. A Healer is a weak
    fighter (120 HP, 5 damage per second, melee, as fast as infantry) with a white cross for an emblem. Every land unit
    of yours within **60 km** of it, the Healer too, regains **3 HP per second**, even in the middle of a fight and on top
    of its own regeneration. Several Healers don't add up. Ships and units being disbanded are not healed. Wounded units
    being healed glow green with a small cross rising from them, and your selected Healer shows its range as a dashed
    green circle. Heroes and Healers can't be made into each other: only plain units can.
  - **Honor for the fallen (Honored Dead):** every unit of yours that falls gives you **25% of its cost in honor**
    (Infantry 3, Archers 2.5, Cavalry 5, Knight 37.5), whoever killed it: an enemy, a neutral city, or the sea when its
    transport sank. A Hero or Healer counts as the unit it was made from. Units you disband don't count, unless an enemy
    hit them in their last 20 seconds (the same rule that makes them an enemy's kill), so deleting cheap units can't turn
    gold into honor.
  - **Tier II tradition (Eternal Glory):** its name is always written in red. Its card stays locked, naming what is
    missing, until every tier I tradition is learned. Nobody is told when someone starts or cancels learning it, but the Players list shows its name and countdown in red while it is
    learned, and every player is told (a red banner and a feed line) once someone has learned it.
  - **Eternal Glory:** every unit a city trains can be paid with honor, at **3 times its gold cost** (Infantry 36, Archers 30,
    Cavalry 60, Knight 450, Transport 30, Battleship 600): the Units box gets a **Pay with Gold / ★ Honor** switch, and **Shift + the
    unit's key** pays with honor either way. Units paid with honor carry the silver star in the queue; cancelling one,
    or losing the city or its port while it waits, gives the honor back. Ships still need their technology, and the unit
    limit still counts.
  - The numbers are `TRADITIONS`, `HERO`, `HEALER`, `UNITS.hero` and `UNITS.healer` in [shared/config.js](shared/config.js)
    (the Barracks price in honor is `TRADITIONS.brotherhood.barracksHonor`).
- **Regions:** the map is split into regions (Hungary, Wallachia, ...: the countries of `tools/cities.js`). Their
  names are printed on the map and dark solid lines are their borders; faint lines divide the cities of one region.
  Hold every city of a region and each of them pays **+2 gold** more per turn (`regionBonusPerCity` in
  [shared/config.js](shared/config.js)). Lose one and the whole region loses the bonus. A one-city region counts.
  The city panel shows how many cities of its region the owner holds, and the feed says when you complete or lose one.
  Taking a region's last city also lights the region up for a few seconds: a gold wave spreads from that city, the
  region's outline glows, each of its cities shows a gold ring and "+2/turn", and its name shines (`REGION_GLOW` in
  [public/js/render.js](public/js/render.js)).
- **Production:** each city has a queue of up to 10 units. Select several cities, by frame or with Shift, and one
  key press queues a unit in each of them.
- **Disbanding:** to get rid of units you no longer need, select them and press **Delete**.
- **Alerts:** a sword clash sounds when someone captures one of your cities. A choir hums when you learn a
  tradition, and a quill signs its name when your research is complete.
  - They lose 10 HP per second until they die. They don't regenerate, and it can't be undone. Until then they still
    move and fight as ordered. They show a pulsing red pool and red drops rising from them.
  - Cities can't be disbanded.
  - In the Players stats a disbanded unit always counts as a **loss** (its gold cost) for you. It counts as a **kill**
    for another player only if that player hit it in the last 20 seconds before it died; then the last such player
    gets the kill. So disbanding a dying unit in battle doesn't deny the enemy the kill.
  - The numbers are in `DISBAND` in [shared/config.js](shared/config.js).
- **Neutral cities:** these are the cities nobody was given. They shoot at everyone.
- **Winning:** a player who holds the target number of cities when a turn ends wins. Reaching it during the turn is not
  enough: if they lose cities again and are below the target when the turn ends, the game goes on. The last player
  standing wins at once if the game started with 2 or more players: everyone else is eliminated, has surrendered or
  has left. A game started alone (to practise) has no such win: it goes on until you surrender or leave. The host sets
  the target in the waiting room (**Game options**):
  - **Cities to win:** the starting target, 120 by default (11 up to every city on the map).
  - **Countdown:** *From start* (the default) lowers the target by one city at the end of every turn: 120 in the first
    turn, 119 in the second, and so on. *From turn N* (10 by default) keeps it until turn N is over, then counts down
    the same way. *No* keeps it fixed. It never drops below one city.
  - The top bar shows your cities next to the current target (▾ while it is counting down).
  - **Close to winning:** when a player is 25 cities or fewer from the target, everyone sees it at the top centre of
    the screen, by colour: "Maroon needs 10 more cities to win". A player who holds the target gets a red line with
    the time left in the turn and how many cities they can still lose ("Maroon wins when the turn ends (0:23) unless
    they lose 6 cities"). Up to 4 players are listed, closest first. The distance is `closeToWinCities` in `GAME` in
    [shared/config.js](shared/config.js).
  - The target checked is the one shown during that turn; a countdown lowers it only after the check.
  - When several players hold the target at the end of a turn, the one with the most cities wins. If they hold exactly
    as many, the game goes on to the next turn.
- **Death** (also a game option): what happens to a player who has lost every city and every unit.
  - **Spectator:** they are out of the game and can only watch.
  - **Liberator** (the default): they lose all their gold and become a liberator. A liberator gets 20 gold at the end of every turn and
    can take any one city on the map, neutral or another player's: click it and press **Liberate**. A player who holds
    5 cities or fewer is protected: none of their cities can be taken this way. The city changes
    hands like a capture (its upgrades are lost, its previous owner gets the gold of its queue back), and the liberator
    is back in the game. Cities can be taken this way at most once every 2 turns: a player who falls again soon after
    waits until 2 turns have passed since their last one. Falling again always costs all gold.
  - Liberators are never eliminated, so with this option the game is won only by holding the target number of cities
    (or by being the only player left once everyone else has surrendered or left).
  - The numbers are in `LIBERATOR` in [shared/config.js](shared/config.js). F1 → **Liberator** explains it in the game.
- **Start gold** (also a game option): the gold every player has at the start, the same for everyone. 50 by default
  (`startGold` in `ECONOMY` in [shared/config.js](shared/config.js)), 0–100000. The lobby's game list shows it when it
  isn't the default.
- **Gold percentage** (waiting room): to even out players of different strength, the host sets a percentage for each
  player next to their name (100% by default, 10–500%): less for a strong player, more for a weaker one. Everything that
  player earns in the game is scaled by it: what their cities pay each turn (whole regions and Farms included), their
  pay as a liberator (smuggled gold too) and kill gold. Turn pay is rounded to whole gold. The start gold is the same
  for everyone, refunds give back exactly what was paid, and costs are the same for everyone. Everyone in the waiting room sees
  the percentages (the others only those that are not 100%); in the game you see only your own (the feed says it at the
  start, and it is in the gold tooltip and F1 → Economy), and your income in the top bar and the Players list includes
  it. Other players' incomes there are shown at 100%: their percentages stay secret, as they would tell who is who.
- **Technologies:** the **Tech** button (or **T**) opens the Technologies window. Research costs gold up front and takes
  game time; one at a time, and cancelling gives the gold back. Order more while one runs and they are **queued**
  (the button says **Queue level N**): each is paid when ordered and starts once the one before it is done. A line
  under the tabs lists the queue in order, each with ✕ to take it out (gold back); taking out a level also takes out
  the higher levels of that technology queued after it. It opens on the **Sea** tab:
  - **Seafaring** (100 gold, 30 s): coastal cities build transports, and units can go on board and land (see Navy).
    Without it there are no ships.
  - **Gunnery** (150 gold, 60 s): coastal cities build battleships (see Navy). It needs Seafaring: its card stays
    locked until Seafaring is researched or ordered, and taking Seafaring out of the queue takes Gunnery out too
    (gold back for both).
  - **Navigation** (120 gold, 45 s): all your ships sail 20% faster, transports and battleships, the ones already at
    sea too (a battleship still takes its 1.5 s to gather speed after a stop). It needs Seafaring, like Gunnery.
    The panel of a selected ship shows its speed with Navigation.

  The **Rebellion** tab exists only with Death: Liberator. Rebellion technologies can be researched at any time (also before you fall) but work only while you
  are a liberator. **Ordered as a liberator they cost half** (`LIBERATOR.rebellionCost`, rounded up; the card shows the
  full price struck out); levels ordered before you fell keep the full price, and cancelling gives back what was paid.
  The prices below are the full ones:
  - **Supporters** (3 levels: 120 gold, 2 min each): +20 / +40 / +60 liberator gold per turn.
  - **Influencer** (3 levels: 100 gold, 2 min each): instead of taking one city, a liberator marks (influences) 2, 3 or 4
    cities, one per turn. Marking the last one liberates them all at once; **Liberate now** takes the marked ones
    earlier. Everyone sees the marks (a turning dashed ring in the liberator's colour), and only one liberator can mark a
    city for liberation. The protection of small empires
    is checked city by city when they are liberated. Without Influencer the limit is 1: the city is taken at once.
  - **Smuggling** (3 levels: 30 gold, 1 min each): mark 1, 2 or 3 cities to smuggle from. At the end of every turn
    each one's whole income goes from its owner to the liberator (neutral cities pay nothing). Only one liberator can
    smuggle from a city. These marks are separate from influence marks (a gold coin on the map): one liberator may
    influence a city while another smuggles from it. Click a smuggled city again to stop.
  - A liberator who is back in the game loses all their marks, so other liberators can mark those cities.
  - Costs and times are in `TECHS` in [shared/config.js](shared/config.js); new tabs are added in `TECH_TABS`.
- **Surrendering and leaving:** pressing Leave during a game asks what you want:
  - **Surrender and watch:** you give up for good: your cities become neutral and your units are gone. You stay in
    the game as a spectator (never a liberator) and see how it ends; the Players list says "Surrendered". Press
    Leave again to go back to the lobby. Surrendering works during the start countdown too.
  - **Leave game:** you give up the same way and go back to the lobby. When the host leaves, the game goes on in
    another player's browser (see "Browser to browser").
  - Once everyone else has surrendered or left, the last player wins (in a game started by 2 or more players).
- **Duels: Restart.** A game started by two players is a duel. Its results screen has **Restart** next to Back to
  lobby; it says when the other player has pressed it ("Bob wants a rematch"). When both have pressed it, the same
  game starts again at once, without the waiting room: same host and options, new colours, the usual countdown. It
  works while both are still on the results screen; once one goes back to the lobby or closes the page, it says they
  have left. The lobby server keeps a finished duel for as long as both players are on its results screen.

### Tweaking the game

Every number lives in **[shared/config.js](shared/config.js)**, which both the server and the browser use:

- `UNITS`: for each unit, `hp`, `damage`, `attackRange` (0 = melee), `moveSpeed`, `size` (collision radius), `hpRegen`, `cost` and `buildTime`.
  Ships have `naval: true`; a transport's `capacity` is how many units it carries. A unit with `reload` (the battleship)
  fires single shots of `damage` every `reload` seconds instead of dealing `damage` every second; one with `accelTime`
  needs that many seconds to get from a standstill to `moveSpeed`. `tech` names the
  technology a unit needs before cities build it (Seafaring, Gunnery). In `TECHS`, `requires` names a technology that
  must come first; Navigation's `speedPercent` is how much faster it makes ships.
- `NAVAL`: how close the sea must be for a coastal city, and the distances for going on board.
- `CITY_UPGRADES`: cost, build time and bonus of each city upgrade.
- `HONOR`, `TRADITIONS`, `HERO`: the honor a kill gives (`killShare` of the unit's cost), the traditions it buys,
  and Heroes: their price, their aura (`auraRadius`, `auraBonus`) and which kind each unit makes (`kinds`,
  `HERO_KINDS`). `UNITS.hero` has the Hero's HP and damage; its speed and range are those of its kind.
- `CITY`, `COMBAT`, `ECONOMY` (including the gold a kill pays) and `GAME`: everything else.

Restart the server and refresh the page after editing.

#### Changing the balance while the server runs (Edit button)

Admins see an **Edit** button in the top bar of a game, next to Players. It opens a table of every unit, city upgrade
and city stat. Change any number and press **Save**:
- The new values apply at once, in every game, for every player. Units already on the map pick up the new HP, size,
  speed and damage. Everyone gets the message "An admin changed the game balance".
- The server writes only the values that differ from `shared/config.js` to `server/data/balance.json` and loads
  them again on the next start. So `shared/config.js` stays the default, and the file holds your changes.
- **Reset to defaults** goes back to `shared/config.js` and deletes the file.
- Values outside a sensible range are clamped, for example HP is at least 1.

Players who are not admins don't see the button, and the server refuses balance changes from them. **On master nobody
is an admin:** `EVERYONE_IS_ADMIN` in [server/index.js](server/index.js) is `false`. The `dev` branch sets it to `true`,
which makes every player an admin. `isAdmin()` is where a real check goes later. To set which stats can be edited and their limits, see [shared/balance.js](shared/balance.js).

#### Moving cities (Edit map button)

Admins also see **Edit map** in the top bar. While it is on (the button reads **Stop editing** and the map gets a
gold frame), any city can be dragged to a new place with the left mouse button. A click without dragging still
selects as usual.
- The city moves at once for every player and in every game, running ones included. A drop in the sea snaps onto
  the nearest shore within 40 km; farther out, or on top of another city, the move is refused and the city goes back.
- Moves are saved in `server/data/city-positions.json` and hold for all games, after restarts, and in later
  `npm run build-map` runs. To undo all moves, delete that file and rebuild.
- **Coastal or inland:** click a city while editing and its panel offers **Make coastal** or **Make inland**,
  whatever its distance to the sea (by default a city is coastal with the sea within 30 km). A city can be made
  coastal only with the sea within 100 km (`NAVAL.editPortRange`); its pier is then at the nearest water. A city
  made inland stops building ships, and the ships in its queue are cancelled and refunded. It takes effect at once
  for every player and game, and is saved in `server/data/city-coastal.json` (city name → true / false), which
  holds after restarts and rebuilds. Setting a city back to what its distance to the sea gives removes it from the
  file; to undo everything, delete the file and restart the server.
- **Beaches:** **Paint beach** and **Erase beach** appear while editing. With one of them on (it is highlighted;
  press it again or Esc to turn it off), drag along the coast: the coastline under the round brush becomes beach
  (ships take units on board and land there) or cliff, exactly as drawn. The brush is about the same size on screen
  at any zoom (never under 8 km), so zoom in for fine work. It takes effect at once for every player and game, and is saved in `server/data/beach-edits.json`
  (grid cells), on top of the beach that all of the coast is; it holds after restarts and rebuilds. To undo
  everything, delete the file and restart the server.
- **Mountains:** **Paint mountains** and **Erase mountains** work the same way, with a bigger brush: drag over the
  land to raise mountains or clear them, built ones included. Units can't cross painted mountains from that moment,
  in every game. No mountain goes within 35 km of a city (those cells are left out, so a stroke bends round a city),
  and no land is walled in. Unlike the built ranges, painted mountains may reach the water: paint them onto the coast
  to close the road along it. The coast under them is cliffs (no ship docks there, and every player sees it drawn so).
  A stroke that closes
  round a small valley without a city fills it; one that would cut off a city or any bigger land is refused
  ("That would wall land in"). Erasing may leave a hole of open land inside a range, as when you start erasing a
  pass from the middle. Saved in `server/data/mountain-edits.json` (grid cells painted and cleared), on top of the
  built mountains; it holds after restarts and rebuilds, where the same rules apply again (painted mountains a moved
  city would be walled in by get a pass). To undo everything, delete the file and restart the server.
- **Region names:** with no brush on, the name of a region under the cursor gets a dashed frame. Drag it to a new
  place; turn the mouse wheel over it to make it bigger or smaller (0.3 to 4 times its own size, `LABEL_EDIT` in
  [shared/config.js](shared/config.js)); double-click it to give it back to automatic placing. A name placed this
  way stays exactly there, and the other names keep off it. Names show only zoomed in past the strategic view, so
  zoom in to edit them. It takes effect at once for every player, and is saved in `server/data/label-edits.json`
  (region name → its centre and scale), which holds after restarts and rebuilds. To undo everything, delete the file
  and restart the server.
- **Rebuild navigation** appears only while editing. The number on it counts moves since the last rebuild. It
  rebuilds everything that depends on where cities stand: territories, borders, country name positions, and the
  areas around cities that paths avoid. Then it reloads them in every game and browser; it takes well under a
  second. Until then a moved city keeps its old territory, and paths still avoid its old place. In debug builds,
  `show navigation` refreshes too.

As with the balance, players who are not admins see neither button, and the server refuses map edits from them even
if they send the messages themselves.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select units (box select) or click a city. A frame with no units in it selects your cities. |
| Shift + click / drag | Add units, or add cities, to the selection |
| Double click | On one of your units: select all your units of that type on screen. On one of your cities: select all your cities on screen. Shift adds them |
| Right click | Move, attack a unit or city, or set a rally point of the selected cities: on land for new units, which attack-move there, fighting anything they meet on the way; on the water for new ships (coastal cities on that sea) |
| Hold right button | Units selected: grey ghosts show where each unit will stand. Drag to turn the formation to face the way you drag; let go to give the move (Esc cancels it) |
| Alt + right click | Cities selected: clear both their rally points (so does a right click on one of them) |
| Hold A + right click | Units selected: attack-move, fighting anything met on the way (also on the minimap). They fight the nearest enemy: one that moves out of reach is swapped for whichever is nearest then, and one that gets out of sight is let go while they walk on (an attack order, by contrast, follows its target anywhere). On an enemy city: attack-move to it, fighting the defenders met on the way, then the city |
| Shift + right click | Units selected: queue the move, attack-move or attack after the orders they already have; they carry them out one after another. Units with nothing to do start at once. A right click without Shift (or S, H) replaces the whole queue. Selected units show their queued route as dashed lines |
| S | Units selected: stop |
| H | Units selected: hold position. They never walk, not even to chase, and only fight what comes within reach. Other units can't push them aside. A move, attack or stop order ends it. A dashed gold ring marks your units on hold |
| Delete | Units selected: disband them. They lose 10 HP per second until they die (see Rules). Cities can't be disbanded |
| C | Cities selected: cancel the last unit or building in each selected city's queue and get its gold (or honor) back; press again for the one before it. One land unit selected: make it a Hero for 100 honor, like the Make Hero button (needs the tradition Cult of Heroes) |
| O, or click the honor star | The Honor window: traditions |
| Q / W / E / R / B / N | Build infantry / archers / cavalry / knight / transport / battleship: one in each selected city, as far as your gold reaches (ships only in coastal cities) |
| Right click your transport | Land units selected: they go on board (see Navy) |
| U | Transports selected: unload, then click land or a city |
| Ctrl + B / Shift + B | Units selected: remove the ships from the selection / keep only the ships (a selection that would end up empty stays as it is) |
| Ctrl + F / Shift + F | Units selected: remove the full transports from the selection / keep only the full transports |
| A / S / D / F / G | Cities selected: build Wall / Tower / Castle / Farm / Barracks in each selected city that doesn't have it yet. A again: Wall II where Wall I is built or queued |
| Shift + G | Cities selected, with the tradition Brotherhood of Arms: build Barracks paid with honor instead of gold |
| Shift + Q / W / E / R / B | Cities selected, with the tradition Eternal Glory: build that unit paid with honor (3 times its gold cost) |
| Ctrl+1–9, 1–9 | Save / recall a control group |
| Hold Alt | Show the attack radius of every city. Alt + drag a frame selects only your cities, even with your units inside it |
| Space / Shift + Space | Center on the selection / jump to your city captured last. When a city of yours falls, it pings red on the minimap for a few seconds and the minimap's frame glows red |
| Drag the minimap's top-right corner | Resize the minimap. It keeps the map's shape and grows up and to the right; the browser keeps the size for your next games. Double click the corner for the default size |
| Arrows, screen edge, middle drag, wheel | Move and zoom the camera. Zooming keeps the point under the cursor in place. Zoomed far out, cities are small dots in their owner's colour and country names are hidden. The view can go a little past every edge of the map, so the land along it (North Africa at the bottom) can be seen clear of the minimap and panels |
| Tab / F1 | Players / help (pages: Controls, Economy) |
| Esc (game over) | Fold the results screen into a bar at the top, to look at the map. Show results opens it again |

### The results screen

When the game ends, the results cover the screen (with **Restart** in a duel, see Rules). **Players**: every player
by nickname, in their colour, with
what the Players list shows plus technologies and the peak of their empire, and a graph of the game (cities,
units, army value, gold per turn, kills, losses). Click a player for their own page: totals, graphs against the
other players, army by unit type, buildings, and milestones by turn. **Timeline**: the map turn by turn with Play
and a slider, the standings and what happened in each turn. The host's game records it all
([server/history.js](server/history.js)) and sends it with the `gameover` message; a message that long goes to
other browsers in pieces (`splitMessage` in [public/js/p2p.js](public/js/p2p.js)).

## Debug mode

`DEBUG` at the top of [shared/config.js](shared/config.js) switches the developer tools on. It is `false` on master and
`true` on the `dev` branch. **Keep it `false` in anything you publish.** The debug code is then not even loaded by the browser, and the server
stops sending timing data. While it is on, the corner of the screen shows "DEBUG · ~ console".

Press **~** (the key left of 1) to open the console. ↑/↓ browse history, Tab completes, and Esc or ~ closes it.

| Command | Shows |
|---|---|
| `stat fps` | Frames per second and frame time |
| `stat unit` | Frame, Game, Draw and Server times in ms |
| `stat unitgraph` | The same times as a scrolling graph, like Unreal Engine's `stat unitgraph` |
| `stat none` | Hides all stats |
| `show navigation` | Toggles the navigation grid over the map, exactly as the server's pathfinding uses it: green = walkable (mainland), other colours = walkable but a separate landmass (unreachable from the mainland), orange = around a city (paths go around it), red = not walkable. Zoomed in, cell borders are drawn and the legend names the cell under the cursor. `show none` hides it |
| `reset hp` | Gives every unit and city in the game full HP again (all players'). The order goes to the game's host, which accepts it only in debug builds, and every player sees who used it in the message feed |
| `gold N` | Sets every player's gold to N (0 or more, e.g. `gold 1000`). Like `reset hp`, it goes to the game's host, works only in debug builds, and every player sees who used it |
| `honor N` | Sets every player's honor to N, like `gold N` (e.g. `honor 2000`: Cult of Heroes and ten Heroes) |
| `slomo N` | Game speed: N times normal, from 0.1 to 10 (`slomo 4`: four times as fast; `slomo 1`: normal). Everything that runs on game time speeds up alike: moving, fighting, training, research, traditions, turns and their gold, cooldowns. The host's browser simulates N times as many steps per second (so very high speeds need a fast host); snapshots keep their normal pace. Everyone sees who changed it, and the top bar shows the speed next to the game's title. Debug builds only |
| `help`, `clear` | List commands, clear the console |

Not in the console: click any city that is not yours and its panel has an **Own** button. The city becomes yours at
once, like a capture (its upgrades are lost, its previous owner gets its queue refunded), and is selected so you can
build there. Like the console's game commands, it goes to the game's host, which accepts it only in debug builds;
every player sees who used it in the message feed, and the game's statistics don't count it as a capture.

What the times mean:
- **Frame:** time between rendered frames; this is what sets the FPS.
- **Game:** browser time spent on input, interpolation, effects and the HUD.
- **Draw:** browser time spent issuing the canvas drawing.
- **Server:** time the game host spends on one simulation tick (the host player's browser, see "Browser to browser"); the budget is 50 ms.

New commands are added in [public/js/debug/index.js](public/js/debug/index.js).

## Project layout

```
shared/config.js        All game numbers (units, cities, combat, economy), used by server and client
shared/balance.js       Which stats the Edit button may change, their limits, apply / reset
shared/options.js       Game options the host sets in the waiting room: cities to win, countdown, death, start gold, gold percentages
shared/regions.js       Regions: their cities, and who holds a whole region (gold bonus)
shared/formation.js     Group-move formations (infantry front, archers back, cavalry wings), for the game and the move preview
shared/mountains.js     The mountain cells' code, shared by the land grid (navgrid.json) and the map (map.json)
shared/tech.js          Technologies: levels, liberator income, influence and smuggling limits, smuggled gold
server/index.js         HTTP static server, WebSocket lobby, rejoin, admins, hand-over to the host and WebRTC signalling
server/host-engine.js   Runs one game with a fixed-step loop: in the host's Web Worker, and in tests
server/ice.js           STUN/TURN servers for the browser-to-browser links (Cloudflare TURN, ICE_SERVERS, RELAY_ONLY)
server/balance-store.js Saves and loads balance changes (server/data/balance.json)
server/map-editor.js    Edit map (admins): move cities, save them, rebuild territories and navigation
server/data/city-positions.json  Cities moved by admins (created on the first move)
server/data/city-coastal.json    Cities admins made coastal or inland (created on the first change)
server/data/beach-edits.json     Coast painted as beach or cliff by admins (created on the first stroke)
server/data/mountain-edits.json  Mountains painted or erased by admins (created on the first stroke)
server/data/label-edits.json     Region names moved or resized by admins (created on the first change)
server/game.js          One match: players, commands, formations, tick, collisions, snapshots
server/history.js       What happened in a game, for the results screen: the map and every player's numbers turn by turn, totals
server/City.js          City: shooting, regeneration, capture, spawn points, port (coastal cities)
server/nav.js           Land grid, line of sight, A* pathfinding around seas and mountains (landmark estimates); seas, coasts and ships' paths
server/units/Unit.js    Base unit: orders, targeting, path following, combat, going on board
server/units/Infantry.js, Archer.js, Cavalry.js   One class per unit type
server/units/Ship.js    Base ship: sails instead of walking, docks to take units on board, lands them
server/units/Transport.js  The transport ship
server/data/navgrid.json  Generated land grid (committed)
public/                 Browser client (vanilla JS modules, Canvas 2D, no build step)
  js/main.js            Screens: name, lobby, waiting room; starts hosting or joining a game
  js/p2p.js             Browser-to-browser links: HostSession (worker + one WebRTC channel per player), PeerSession
  js/delta.js           Snapshots and scores as changes to the last one sent (lossless), rebuilt on the player's page
  js/host-worker.js     Web Worker that runs the game in the host's browser
  js/client.js          Snapshot interpolation, selection, commands, effects
  js/render.js          Map, territories, cities, cone units, minimap
  js/mountains.js       Draws the mountains from their cells: rocky land, and close up rows of hill signs
  js/map-labels.js      Places the region names: inside their region, off the cities and each other; region outlines
  js/input.js           Mouse/keyboard, camera
  js/hud.js             Resource bar, city production panel, overlays
  js/results.js         The results screen once the game is over: players, a player's stats, the timeline
  js/balance-editor.js  Edit button table: change unit, upgrade and city stats (admins)
  js/tooltip.js         Custom tooltips for every element with a title
  js/sprites.js         Procedural cone / ship / castle sprites, anchor badge of coastal cities
  js/sound.js           Sound effects (Web Audio), starts on the first click or key press
  js/units/*.js         One class per unit type: icon and tooltip
  map.json              Generated map data (committed)
  sounds/               Sound effects made by tools/gen-sfx.js (committed)
tools/cities.js         The 64 regions and 223 cities (lat/lon)
tools/mountains.js      The mountain ranges: chains along their crests (lat/lon, width), passes between the chains
tools/build-map.js      Builds public/map.json and server/data/navgrid.json from Natural Earth data
tools/gen-sfx.js        Makes the sound effects in public/sounds/ with ElevenLabs
```

To add a unit type:
1. Add its stats to `UNITS` and its name to `UNIT_TYPES` in `shared/config.js`.
2. Create a server class in `server/units/` (behaviour) and a client class in `public/js/units/` (icon).
   A ship has `naval: true` in its stats and its server class extends `Ship`; it is drawn as a boat with its icon on the sail.
3. Register both classes in the `index.js` next to them.

The game (in the host's browser) simulates at 20 Hz. Each player receives a 10 Hz snapshot with its own units plus everything near its
viewport, and renders about 130 ms in the past so movement interpolates smoothly. Snapshots and scores travel as changes
to the last one sent on that link, and the player's page rebuilds them exactly ([public/js/delta.js](public/js/delta.js));
direct links compress them too (deflate). A link that falls behind skips snapshots instead of queuing them.

### Sound effects

The sounds in `public/sounds/` are made with ElevenLabs text to sound effects. Each sound's prompt is in
`tools/gen-sfx.js`. To make a new take, set `ELEVENLABS_API_KEY` and run `npm run sfx` (all sounds) or
`npm run sfx -- tick` (one). The script trims every take to start on its first sound, so it plays in time with the
game. To add a sound, add it to `SOUNDS` in the script and to `FILES` in `public/js/sound.js`, then call
`playSound(name)`.

### Rebuilding the map

Edit `tools/cities.js` and run `npm run build-map`. The script projects the Natural Earth 1:50m country shapes
(from the `world-atlas` package) to an equal-area projection centred on Europe. It then splits every landmass into
city territories with a Voronoi diagram. Islands without a city go to the nearest city of the same country.
Small countries without a city (up to North Macedonia's size) go to the cities within 150 km: an island to the nearest,
land with neighbours split between them by distance. Bigger land without a city is neutral scenery.
Border arcs are simplified once, so neighbouring landmasses share exactly the same border points. Only two kinds of
border are emitted (`segs`): between regions, and between cities of one region. Today's national borders are drawn
only where they divide two cities, as one of those two kinds; the renderer draws the rest of the land outline as coast,
except where the map's edge cuts the land off.
It also rasterises the land into a 5 km grid for movement. Each cell remembers which landmass polygon it belongs
to, so units cannot hop across straits narrower than a cell.

**Mountains** ([tools/mountains.js](tools/mountains.js)) are marked on that grid: every range is a list of chains,
lines of latitude/longitude points along the crest with a width in km, and where one chain ends and the next begins
the build clears a pass 20 km wide straight through the range (`MOUNTAIN` in `tools/build-map.js`). The edges wander
in and out a little (fixed noise, the same in every build), and chains narrow towards their ends. No mountain cell
comes within 12 km of water or 35 km of a city. Then the build checks with the game's own pathfinding grid that no
land is walled in (`NavGrid.openWalls`): a cut-off valley without a city becomes mountain too, any other cut-off land
gets a pass of its own (the shortest way out); the build log says how many. The cells go to `navgrid.json`
(`mountains`, blocked) and `map.json` (`mountains`, drawn), coded alike ([shared/mountains.js](shared/mountains.js),
which also holds those rules, `MOUNTAIN_RULES`, for the mountains admins paint). The build leaves the painted ones out:
the server puts them on top of the built ones when it loads the map (`server/map-editor.js`), and serves `/map.json`
with them; a game's host takes its mountains from that map, not from `navgrid.json`. To add a range or a pass, edit
`tools/mountains.js` and rebuild; `test/mountains.test.js` checks the result.

**Simpler coasts:** Norway's west and north coast is drawn with less detail than Natural Earth gives (`SMOOTH_COASTS`):
every inlet that a disc of 8 km (12 km in Finnmark) rolling along the coast on the sea can't get into becomes land, so
the fjords fill and the coast runs across their mouths. The islands off it are smoothed the same way among themselves
and stay islands, at least 2 km of sea from the mainland; skerries under 60 km² go. It takes no port away: a city that
had the sea within `NAVAL.portRange` before keeps its way to the open sea (Tromsø's sound, Bergen's and Bodø's
harbours). The land borders with Sweden, Finland and Russia keep every point.

Cities moved in the game (Edit map) are read from `server/data/city-positions.json` and replace their positions from
`tools/cities.js`. The map's rectangle is fixed (`RECT` in `tools/build-map.js`), so adding, removing or moving
cities never changes the map's size or the land grid, and the beaches painted on the grid stay where they are.
Greenland and Iceland are moved closer to the rest of the map (`MOVED`): Greenland down into the north-west corner,
Iceland down out of its way. Their cities in `tools/cities.js` keep their real latitude and longitude and move with
them. Some islands are reshaped for the game: Crete and Jan Mayen are grown (`GROWN`, with the islets around them
and the cities on them; Jan Mayen also moves east, out of Greenland's way), and the Faroes become one island, a smooth
outline round them all (`MERGED`). Changing `MOVED` or `GROWN` moves an island's cells in the land grid, and the
beaches painted on it (grid cells in `server/data/beach-edits.json`) do not follow by themselves.
