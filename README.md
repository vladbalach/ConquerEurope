# Conquest of Europa

A multiplayer, top-down real-time strategy game played in the browser on a map of Europe.
Up to 20 players each start with 10 random cities and race to hold **120 of the 207 cities**.

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
for a game in progress the lobby lists nicknames only. Everyone is revealed on the game-over screen. The rule is in
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
  the background. The host sends each player about 30–100 KB/s, so 20 players need roughly 8 Mbit/s of upload.
- **Other browsers:** send their orders to the host and get snapshots back, as they did from the server before.
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
0.1–0.35 GB per relayed player per hour (messages are compressed). On a free plan with a small monthly allowance
(Render: 5 GB), set up the Cloudflare TURN relay above if many of your players need the fallback. The browser
console (F12) says which way each player connected.

## Rules

| | HP | Damage | Range | Speed | Regen* | Cost | Build time |
|---|---|---|---|---|---|---|---|
| Infantry | 100 | 15/s | melee | 26 | 0.7/s | 12 | 6 s |
| Archers | 30 | 10/s | 55 | 26 | 0.4/s | 10 | 6 s |
| Cavalry | 70 | 15/s | melee | 52 | 0.5/s | 20 | 10 s |
| Knight | 200 | 45/s | melee | 45 | 1/s | 150 | 8 s |
| City | 100 | 20/s | 70 | — | 5/s (always) | — | — |

\* Units regenerate only after 3 seconds without fighting. Infantry blocks 10% of damage from archers.

- **Land only:** units walk on land and find their own way around seas. They cannot cross water, so islands
  (Britain, Ireland, Sicily, Sardinia, Zealand, Crete, Cyprus, Iceland, ...) are out of reach of land units.
  A move order onto another landmass takes units to the nearest shore they can reach. Archers can still shoot
  across a narrow strait.
- **City upgrades:** built in a city like units (they cost gold, take time, use a queue slot), once per city.

  | Upgrade | Cost | Time | Effect |
  |---|---|---|---|
  | Wall | 20 | 20 s | +200 HP |
  | Tower | 20 | 20 s | +20% attack range |
  | Castle | 30 | 30 s | +15 damage |
  | Farm | 50 | 30 s | +5 gold per turn from this city |
  | Barracks | 50 | 20 s | Units train 40% faster in this city (6 s → 4.3 s, 10 s → 7.1 s). Upgrades build at normal speed |

  They show on the map: a stone ring wall, a tall side tower, a taller keep flying a banner, a golden wheat
  field, and a timber hall roofed in the owner's colour. When the city is captured its upgrades are destroyed.
- **Target priority:** units always fight enemy units first. They attack a city on their own only when no enemy unit
  is in sight. An explicit attack order on a city is always obeyed.
- **Capturing:** bring a city's HP to 0 to capture it. It switches to the attacker with 40 HP. Its production queue is
  cleared, and the previous owner gets back the gold for every unit in it that was not finished.
- **Turns and gold:** the game runs in turns of 60 seconds. At the end of every turn each city pays its owner
  10 gold, all at once. The top bar shows how many turns have passed and the countdown to the next payout.
  Players start with 50 gold.
- **Production:** each city has a queue of up to 10 units. Select several cities, by frame or with Shift, and one
  key press queues a unit in each of them.
- **Disbanding:** to get rid of units you no longer need, select them and press **Delete**.
  - They lose 10 HP per second until they die. They don't regenerate, and it can't be undone. Until then they still
    move and fight as ordered. They show a pulsing red pool and red drops rising from them.
  - Cities can't be disbanded.
  - In the Players stats a disbanded unit always counts as a **loss** (its gold cost) for you. It counts as a **kill**
    for another player only if that player hit it in the last 20 seconds before it died; then the last such player
    gets the kill. So disbanding a dying unit in battle doesn't deny the enemy the kill.
  - The numbers are in `DISBAND` in [shared/config.js](shared/config.js).
- **Neutral cities:** these are the cities nobody was given. They shoot at everyone.
- **Winning:** the first player to hold 120 cities wins. The last player standing also wins if the game started with 2 or more players.
- **Leaving:** pressing Leave gives up for good, and all your cities become neutral.

### Tweaking the game

Every number lives in **[shared/config.js](shared/config.js)**, which both the server and the browser use:

- `UNITS`: for each unit, `hp`, `damage`, `attackRange` (0 = melee), `moveSpeed`, `size` (collision radius), `hpRegen`, `cost` and `buildTime`.
- `CITY_UPGRADES`: cost, build time and bonus of each city upgrade.
- `CITY`, `COMBAT`, `ECONOMY` and `GAME`: everything else.

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

Players who are not admins don't see the button, and the server refuses balance changes from them. **For now every
player is an admin** (`EVERYONE_IS_ADMIN` in [server/index.js](server/index.js); `isAdmin()` is where a real check
goes later). To set which stats can be edited and their limits, see [shared/balance.js](shared/balance.js).

#### Moving cities (Edit map button)

Admins also see **Edit map** in the top bar. While it is on (the button reads **Stop editing** and the map gets a
gold frame), any city can be dragged to a new place with the left mouse button. A click without dragging still
selects as usual.
- The city moves at once for every player and in every game, running ones included. A drop in the sea snaps onto
  the nearest shore within 40 km; farther out, or on top of another city, the move is refused and the city goes back.
- Moves are saved in `server/data/city-positions.json` and hold for all games, after restarts, and in later
  `npm run build-map` runs. To undo all moves, delete that file and rebuild.
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
| Right click | Move, attack a unit or city, or set the rally point of the selected cities |
| Hold A + right click | Units selected: attack-move, fighting anything met on the way (also on the minimap) |
| S | Units selected: stop |
| Delete | Units selected: disband them. They lose 10 HP per second until they die (see Rules). Cities can't be disbanded |
| Q / W / E / R | Build infantry / archers / cavalry / knight: one in each selected city, as far as your gold reaches |
| A / S / D / F / G | Cities selected: build Wall / Tower / Castle / Farm / Barracks in each selected city that doesn't have it yet |
| Ctrl+1–9, 1–9 | Save / recall a control group |
| H | Jump to your next city |
| Hold Alt | Show the attack radius of every city. Alt + drag a frame selects only your cities, even with your units inside it |
| Arrows, screen edge, middle drag, wheel | Move and zoom the camera. Zooming keeps the point under the cursor in place. Zoomed far out, cities are small dots in their owner's colour and country names are hidden |
| Tab / F1 | Players / help |

## Debug mode

`DEBUG` at the top of [shared/config.js](shared/config.js) switches the developer tools on.
**Set it to `false` before publishing.** The debug code is then not even loaded by the browser, and the server
stops sending timing data. While it is on, the corner of the screen shows "DEBUG · ~ console".

Press **~** (the key left of 1) to open the console. ↑/↓ browse history, Tab completes, and Esc or ~ closes it.

| Command | Shows |
|---|---|
| `stat fps` | Frames per second and frame time |
| `stat unit` | Frame, Game, Draw and Server times in ms |
| `stat unitgraph` | The same times as a scrolling graph, like Unreal Engine's `stat unitgraph` |
| `stat none` | Hides all stats |
| `show navigation` | Toggles the navigation grid over the map, exactly as the server's pathfinding uses it: green = walkable (mainland), other colours = walkable but a separate landmass (unreachable from the mainland), orange = around a city (paths go around it), red = not walkable. Zoomed in, cell borders are drawn and the legend names the cell under the cursor. `show none` hides it |
| `help`, `clear` | List commands, clear the console |

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
server/index.js         HTTP static server, WebSocket lobby, rejoin, admins, hand-over to the host and WebRTC signalling
server/host-engine.js   Runs one game with a fixed-step loop: in the host's Web Worker, and in tests
server/ice.js           STUN/TURN servers for the browser-to-browser links (Cloudflare TURN, ICE_SERVERS, RELAY_ONLY)
server/balance-store.js Saves and loads balance changes (server/data/balance.json)
server/map-editor.js    Edit map (admins): move cities, save them, rebuild territories and navigation
server/data/city-positions.json  Cities moved by admins (created on the first move)
server/game.js          One match: players, commands, formations, tick, collisions, snapshots
server/City.js          City: shooting, regeneration, capture, spawn points
server/nav.js           Land grid, line of sight, A* pathfinding around seas
server/units/Unit.js    Base unit: orders, targeting, path following, combat
server/units/Infantry.js, Archer.js, Cavalry.js   One class per unit type
server/data/navgrid.json  Generated land grid (committed)
public/                 Browser client (vanilla JS modules, Canvas 2D, no build step)
  js/main.js            Screens: name, lobby, waiting room; starts hosting or joining a game
  js/p2p.js             Browser-to-browser links: HostSession (worker + one WebRTC channel per player), PeerSession
  js/host-worker.js     Web Worker that runs the game in the host's browser
  js/client.js          Snapshot interpolation, selection, commands, effects
  js/render.js          Map, territories, cities, cone units, minimap
  js/input.js           Mouse/keyboard, camera
  js/hud.js             Resource bar, city production panel, overlays
  js/balance-editor.js  Edit button table: change unit, upgrade and city stats (admins)
  js/tooltip.js         Custom tooltips for every element with a title
  js/sprites.js         Procedural cone / castle sprites
  js/units/*.js         One class per unit type: icon and tooltip
  map.json              Generated map data (committed)
tools/cities.js         The 50 countries and 207 cities (lat/lon)
tools/build-map.js      Builds public/map.json and server/data/navgrid.json from Natural Earth data
```

To add a unit type:
1. Add its stats to `UNITS` and its name to `UNIT_TYPES` in `shared/config.js`.
2. Create a server class in `server/units/` (behaviour) and a client class in `public/js/units/` (icon).
3. Register both classes in the `index.js` next to them.

The game (in the host's browser) simulates at 20 Hz. Each player receives a 10 Hz snapshot with its own units plus everything near its
viewport, and renders about 130 ms in the past so movement interpolates smoothly.

### Rebuilding the map

Edit `tools/cities.js` and run `npm run build-map`. The script projects the Natural Earth 1:50m country shapes
(from the `world-atlas` package) to an equal-area projection centred on Europe. It then splits every landmass into
city territories with a Voronoi diagram. Islands without a city go to the nearest city of the same country.
It also rasterises the land into a 5 km grid for movement. Each cell remembers which landmass polygon it belongs
to, so units cannot hop across straits narrower than a cell.

Cities moved in the game (Edit map) are read from `server/data/city-positions.json` and replace their positions from
`tools/cities.js`. The map's size always comes from `tools/cities.js`, so moving a city never changes the land grid.
