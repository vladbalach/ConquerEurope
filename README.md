# Conquest of Europa

A multiplayer, top-down real-time strategy game played in the browser on a map of Europe.
Up to 20 players each start with 10 random cities and race to hold **120 of the 218 cities** (the host can
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
- This works for everyone except the host: the game runs in the host's tab (see below), so if the host closes or
  refreshes it, the game is over for everyone.

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
- **The host leaving:** closing or refreshing the host's tab, or pressing Leave, ends the game for everyone, and the
  game-over screen says so.
- **Cheating:** the host's browser decides everything, so a host could cheat. Fine among friends.
- **The lobby connection:** each tab pings the server every 4 minutes. This keeps a free host that sleeps when idle
  (for example Render) awake during a game. If the server restarts anyway, games in progress carry on; only
  rejoining them is no longer possible.

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
| City | 100 | 20/s | 70 | — | 5/s (always) | — | — |

\* Units regenerate only after 3 seconds without fighting.

- **Land units walk on land:** they find their own way around seas but cannot cross water, so islands
  (Britain, Ireland, Sicily, Sardinia, Zealand, Crete, Cyprus, Iceland, ...) are reached only by transport (see
  Navy). A move order onto another landmass takes units to the nearest shore they can reach. Archers can still shoot
  across a narrow strait.
- **Navy:** ships sail only on the sea. Building them, and taking units on board or landing them, needs the
  **Seafaring** technology (Tech, Sea tab: 100 gold, 30 s).
  - **Coastal cities:** a city with the sea within 30 km is coastal (admins can change it in Edit map). It is marked with an anchor (next to the castle, or
    next to the dot when zoomed out), has a timber pier where its ships are launched, and its panel says Port. Only
    coastal cities build ships (Barracks don't speed them up). Every city has two rally points: right-click land (cities selected) for new units, right-click the water for new ships of coastal cities on that sea. Without one, new ships stay in the port.
  - **Beaches and cliffs:** transports take units on board and land them only on **beaches**, drawn as shallow
    water off the shore (a soft teal fringe) with a thin line of sand. The rest of the coast is cliffs (the plain
    dark line against deep water). About 22% of the drawn coastline is beach, worked out from the landscape: sheltered bays and
    coves become beaches, open headlands cliffs, varied by a fixed pattern so that long shores alternate. The coast
    within 30 km of every city is always a beach (its harbour). Every island with a city, or bigger than 1,000 km²,
    has at least one; tiny islets without a city have none. It is the same in every game (`markBeaches` in
    [server/nav.js](server/nav.js)), and admins can paint more or erase some in Edit map. What the map shows is exactly
    where ships dock: every piece of drawn coastline takes the state of the land-grid cell nearest to it, and only
    those cells can be beaches ([shared/coastline.js](shared/coastline.js)).
  - **Seas:** the Mediterranean, the Atlantic, the North Sea and the Baltic are one sea. The Black Sea joins it through
    the Bosporus and the Dardanelles, which only ships can pass. The Caspian is a sea of its own. Lakes can't be sailed.
  - **Repairs:** a ship within 40 km of the pier of one of your coastal cities regains 5 HP per second instead of 0.5,
    once it has not been hit for 3 seconds (`NAVAL.harbourRange`, `NAVAL.harbourRegen`).
  - **Transport:** carries 8 units, one place each. It has no weapons. Cities shoot ships like any unit (neutral cities
    shoot everyone), and archers on the shore can hit them. Ships steer clear of the range of coastal cities where the
    sea allows, but not around the city they sail from or to. A sunk transport takes everyone on board with it: they count
    as losses, and as kills for whoever sank it.
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
  - **Landing:** select transports with units on board and press **Unload** in the panel (or **U**), then click any land
    or city (also on the minimap). Each transport sails to the beach nearest to that place, puts everyone ashore and
    sends them there: they attack it when it is an enemy city. Right-click or Esc cancels. Quicker: right-click land or
    an enemy city with them selected does the same, and units landed on a right-click attack-move to the place,
    fighting anything on the way (on the water, or without units on board, the transports just sail there).
    A unit steps ashore only where there is room for it (within 30 km of the landing place, clear of other units and
    city walls). The others wait on board, and the transport waits with them until there is room; the feed says so.
  - **Docks:** each transport taking units on board or landing them gets its own dock: the free spot on a beach
    nearest to where it is sent, clear of the docks of other ships and of ships lying idle. Several transports sent
    together spread along the shore, the nearest ones closest to the target. While one is on its way, your map shows
    its berth (a dashed outline with an anchor and a line from the ship) and the shore point next to it (light blue:
    units gather there to come on board; green: they land there).
  - Units on board count as yours (top bar, Players list). The numbers are in `NAVAL` and `UNITS.transport` in
    [shared/config.js](shared/config.js).
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
  Cavalry 5, Knight 37.5, Transport 2.5) and **its full cost in honor** (Infantry 12, Archers 10, Cavalry 20,
  Knight 150, Transport 10): honor grows exactly like your Kills in the Players list. Honor is shown with a silver star
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
  | **Eternal Glory** (tier II) | 4000 honor | 2 min | Every unit can be trained for honor, at 2 times its gold cost. Only once every tier I tradition is learned |
  | **Last Stand** (tier II) | 4000 honor | 2 min | Your units deal 30% more damage; a unit outnumbered 2 to 1 within 80 km takes 30% less damage. Only once every tier I tradition is learned |

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
  - **Tier II traditions (Eternal Glory, Last Stand):** their names are always written in red. Their cards stay locked,
    naming what is missing, until every tier I tradition is learned; they don't need each other. Nobody is told when
    someone starts or cancels learning one, but the Players list shows its name and countdown in red while it is
    learned, and every player is told (a red banner and a feed line) once someone has learned it.
  - **Eternal Glory:** every unit a city trains can be paid with honor, at **2 times its gold cost** (Infantry 24, Archers 20,
    Cavalry 40, Knight 300, Transport 20): the Units box gets a **Pay with Gold / ★ Honor** switch, and **Shift + the
    unit's key** pays with honor either way. Units paid with honor carry the silver star in the queue; cancelling one,
    or losing the city or its port while it waits, gives the honor back. Ships still need Seafaring, and the unit limit
    still counts.
  - **Last Stand:** all your units deal **30% more damage**, always (near a Hero it adds up to +40%). And a unit of
    yours, a ship too, that has at least **twice as many enemy units as units of yours** (itself included) within
    **80 km** takes **30% less damage**, from units and cities alike. Each unit checks this twice a second. Units standing
    firm like that glow red on the map (a thin red ring when zoomed out to dots), and every player sees it. Units on
    board a transport neither count nor are counted.
  - The numbers are `TRADITIONS`, `HERO`, `HEALER`, `UNITS.hero` and `UNITS.healer` in [shared/config.js](shared/config.js)
    (the Barracks price in honor is `TRADITIONS.brotherhood.barracksHonor`; Last Stand's numbers are
    `TRADITIONS.lastStand`).
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
  standing wins at once if the game started with 2 or more players. The host sets the target in the waiting room
  (**Game options**):
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
    (or by being the only player left once everyone else has pressed Leave).
  - The numbers are in `LIBERATOR` in [shared/config.js](shared/config.js). F1 → **Liberator** explains it in the game.
- **Technologies:** the **Tech** button (or **T**) opens the Technologies window. Research costs gold up front and takes
  game time; one at a time, and cancelling gives the gold back. Order more while one runs and they are **queued**
  (the button says **Queue level N**): each is paid when ordered and starts once the one before it is done. A line
  under the tabs lists the queue in order, each with ✕ to take it out (gold back); taking out a level also takes out
  the higher levels of that technology queued after it. It opens on the **Sea** tab:
  - **Seafaring** (100 gold, 30 s): coastal cities build transports, and units can go on board and land (see Navy).
    Without it there are no ships.

  The **Rebellion** tab exists only with Death: Liberator. Rebellion technologies can be researched at any time (also before you fall) but work only while you
  are a liberator:
  - **Supporters** (3 levels: 100 / 180 / 260 gold, 2 min each): +20 / +40 / +60 liberator gold per turn.
  - **Influencer** (3 levels: 100 gold, 2 min each): instead of taking one city, a liberator marks (influences) 2, 3 or 4
    cities, one per turn. Marking the last one liberates them all at once; **Liberate now** takes the marked ones
    earlier. Everyone sees the marks (a turning dashed ring in the liberator's colour), and only one liberator can mark a
    city for liberation. The protection of small empires
    is checked city by city when they are liberated. Without Influencer the limit is 1: the city is taken at once.
  - **Smuggling** (3 levels: 30 gold, 1 min each): mark 1, 2 or 3 cities to smuggle from. At the end of every turn
    half of each one's income goes from its owner to the liberator (neutral cities pay nothing). Only one liberator can
    smuggle from a city. These marks are separate from influence marks (a gold coin on the map): one liberator may
    influence a city while another smuggles from it. Click a smuggled city again to stop.
  - A liberator who is back in the game loses all their marks, so other liberators can mark those cities.
  - Costs and times are in `TECHS` in [shared/config.js](shared/config.js); new tabs are added in `TECH_TABS`.
- **Leaving:** pressing Leave gives up for good, and all your cities become neutral.

### Tweaking the game

Every number lives in **[shared/config.js](shared/config.js)**, which both the server and the browser use:

- `UNITS`: for each unit, `hp`, `damage`, `attackRange` (0 = melee), `moveSpeed`, `size` (collision radius), `hpRegen`, `cost` and `buildTime`.
  Ships have `naval: true`; a transport's `capacity` is how many units it carries.
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
  (grid cells), on top of the beaches worked out from the landscape; it holds after restarts and rebuilds. To undo
  everything, delete the file and restart the server.
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
| Alt + right click | Cities selected: clear both their rally points (so does a right click on one of them) |
| Hold A + right click | Units selected: attack-move, fighting anything met on the way (also on the minimap) |
| Shift + right click | Units selected: queue the move, attack-move or attack after the orders they already have; they carry them out one after another. Units with nothing to do start at once. A right click without Shift (or S, H) replaces the whole queue. Selected units show their queued route as dashed lines |
| S | Units selected: stop |
| H | Units selected: hold position. They never walk, not even to chase, and only fight what comes within reach. Other units can't push them aside. A move, attack or stop order ends it. A dashed gold ring marks your units on hold |
| Delete | Units selected: disband them. They lose 10 HP per second until they die (see Rules). Cities can't be disbanded |
| C | One land unit selected: make it a Hero for 100 honor, like the Make Hero button (needs the tradition Cult of Heroes) |
| O, or click the honor star | The Honor window: traditions |
| Q / W / E / R / B | Build infantry / archers / cavalry / knight / transport: one in each selected city, as far as your gold reaches (a transport only in coastal cities) |
| Right click your transport | Land units selected: they go on board (see Navy) |
| U | Transports selected: unload, then click land or a city |
| Ctrl + B / Shift + B | Units selected: remove the ships from the selection / keep only the ships (a selection that would end up empty stays as it is) |
| Ctrl + F / Shift + F | Units selected: remove the full transports from the selection / keep only the full transports |
| A / S / D / F / G | Cities selected: build Wall / Tower / Castle / Farm / Barracks in each selected city that doesn't have it yet. A again: Wall II where Wall I is built or queued |
| Shift + G | Cities selected, with the tradition Brotherhood of Arms: build Barracks paid with honor instead of gold |
| Shift + Q / W / E / R / B | Cities selected, with the tradition Eternal Glory: build that unit paid with honor (2 times its gold cost) |
| Ctrl+1–9, 1–9 | Save / recall a control group |
| Hold Alt | Show the attack radius of every city. Alt + drag a frame selects only your cities, even with your units inside it |
| Space / Shift + Space | Center on the selection / jump to your city captured last. When a city of yours falls, it pings red on the minimap for a few seconds and the minimap's frame glows red |
| Drag the minimap's top-right corner | Resize the minimap. It keeps the map's shape and grows up and to the right; the browser keeps the size for your next games. Double click the corner for the default size |
| Arrows, screen edge, middle drag, wheel | Move and zoom the camera. Zooming keeps the point under the cursor in place. Zoomed far out, cities are small dots in their owner's colour and country names are hidden |
| Tab / F1 | Players / help (pages: Controls, Economy) |
| Esc (game over) | Fold the results screen into a bar at the top, to look at the map. Show results opens it again |

### The results screen

When the game ends, the results cover the screen. **Players**: every player by nickname, in their colour, with
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
shared/options.js       Game options the host sets in the waiting room: cities to win, countdown, death
shared/regions.js       Regions: their cities, and who holds a whole region (gold bonus)
shared/tech.js          Technologies: levels, liberator income, influence and smuggling limits, smuggled gold
server/index.js         HTTP static server, WebSocket lobby, rejoin, admins, hand-over to the host and WebRTC signalling
server/host-engine.js   Runs one game with a fixed-step loop: in the host's Web Worker, and in tests
server/ice.js           STUN/TURN servers for the browser-to-browser links (Cloudflare TURN, ICE_SERVERS, RELAY_ONLY)
server/balance-store.js Saves and loads balance changes (server/data/balance.json)
server/map-editor.js    Edit map (admins): move cities, save them, rebuild territories and navigation
server/data/city-positions.json  Cities moved by admins (created on the first move)
server/data/city-coastal.json    Cities admins made coastal or inland (created on the first change)
server/data/beach-edits.json     Coast painted as beach or cliff by admins (created on the first stroke)
server/game.js          One match: players, commands, formations, tick, collisions, snapshots
server/history.js       What happened in a game, for the results screen: the map and every player's numbers turn by turn, totals
server/City.js          City: shooting, regeneration, capture, spawn points, port (coastal cities)
server/nav.js           Land grid, line of sight, A* pathfinding around seas (landmark estimates); seas, coasts and ships' paths
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
tools/cities.js         The 58 regions and 218 cities (lat/lon)
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
Border arcs are simplified once, so neighbouring landmasses share exactly the same border points. Only two kinds of
border are emitted (`segs`): between regions, and between cities of one region. Today's national borders are drawn
only where they divide two cities, as one of those two kinds; the renderer draws the rest of the land outline as coast.
It also rasterises the land into a 5 km grid for movement. Each cell remembers which landmass polygon it belongs
to, so units cannot hop across straits narrower than a cell.

Cities moved in the game (Edit map) are read from `server/data/city-positions.json` and replace their positions from
`tools/cities.js`. The map's size always comes from `tools/cities.js`, so moving a city never changes the land grid.
