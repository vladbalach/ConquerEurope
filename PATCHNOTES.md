# Patch notes

## 9 November 2026: Kill rewards, honor, winning at the end of the turn

- **Winning at the end of the turn:** holding the target number of cities no longer ends the game at once. The game
  checks it when the turn ends: whoever still holds the target then wins. Reach it in the middle of a turn and you have
  to keep it until the turn is over; if your enemies take cities back and you are below the target when the turn ends,
  the game goes on. The target checked is the one shown during that turn (the countdown lowers it right after).
  Several players holding it: the most cities win; an exact tie plays on to the next turn. The last player standing
  still wins at once.
- **Who is close to winning:** when a player is 25 cities or fewer from the target, everyone sees it at the top
  centre of the screen: "Maroon needs 10 more cities to win". Once a player holds the target, the line turns red and
  shows the time left in the turn and how many cities they can still lose: "Maroon wins when the turn ends (0:23)
  unless they lose 6 cities". Time to strike back.

- **Kills pay gold:** destroying an enemy unit pays you **25% of its cost** at once: Infantry 3, Archers 2.5,
  Cavalry 5, Knight 37.5, Transport 2.5. The top bar shows whole gold; halves still add up.
- **New resource, honor:** every kill gives you **the unit's full cost in honor** (Infantry 12, Archers 10,
  Cavalry 20, Knight 150, Transport 10), so your honor grows exactly like your Kills in the Players list. It is shown
  with a silver star in the top bar, right after your gold.
- Both follow the kills in the Players list: the last hit gets the kill, and your cities' kills are yours. Units on
  board a sunk transport count for whoever sank it. A disbanded unit pays the last player who hit it in the 20 seconds
  before it died. Kills by neutral cities pay nobody.
- **F1 → Economy** lists kills as a source of gold.

### Queues for research and traditions

- **Research queue:** order research while one is running and it is **queued** (the button says **Queue level N**).
  It is paid at once and starts by itself once the one before it is done, so you can line up several technologies,
  or several levels of one. A line under the Tech window's tabs lists the queue in order; **✕** takes one out and
  gives its gold back (and takes out the higher levels of that technology queued after it, as they need it).
- **Tradition queue:** the same in the Honor window: **Queue** a tradition while another is learned. Its row shows
  its place (**Queued #1**) and **Remove**, which gives the honor back. A tier II tradition can be queued once every
  tier I one is learned or queued ahead of it; removing a tier I one also removes the tier II ones queued.

### New: the Honor window, traditions and Heroes

- Click the honor star in the top bar (or press **O**) to open the **Honor** window. There you spend honor on
  **traditions**: learned once and kept for the whole game, one at a time (alongside your research). Cancelling gives
  the honor back.
- One row per tradition: its coat of arms in your colour, its name and what it is for, and the price and **Learn** on
  the right. Hover a row for the full details. The Players list and the results show each tradition as a small
  silver emblem with one part in that player's colour.
- **Cult of Heroes** (1500 honor, 30 s): any of your land units can now be made a **Hero**. Select one and press
  **C**, or **Make Hero** in its panel (**100 honor**). It becomes a Hero where it stands, keeping its orders and its share of
  HP: 300 HP and 15 damage per second, with **the speed and range of what it was**. Infantry make an Infantry Hero,
  archers an Archer Hero that shoots from afar, cavalry and knights a Cavalry Hero that rides. It wears a crown and a
  gold ring on the map.
- **A Hero's aura:** all the time, every land unit of yours within **80 km** of a Hero, the Hero too, deals **10% more
  damage**. Several Heroes don't add up. Your selected Hero shows how far it reaches.
- A Hero counts in the Kills and Losses stats as the gold of the unit it was made from. Cities never train Heroes.
- **Order of Mercy** (1500 honor, 30 s): any of your land units can now be made a **Healer** (**80 honor**, Make
  Healer in its panel). A weak fighter (120 HP, 5 damage per second) with a white cross, it heals every land unit of
  yours within 60 km, itself too, by **3 HP per second**, even in combat. Several Healers don't add up. Healed units
  glow green; your selected Healer shows its range. Only plain units can become a Hero or a Healer.
- **Brotherhood of Arms** (1500 honor, 30 s): Barracks can be paid with **30 honor** instead of 30 gold. The build
  column gets a second Barracks button in the Honor window's colours (or press **Shift + G**). It is the same building:
  units train twice as fast. Paid with honor or gold, Barracks now **build twice as fast** (6 s instead of 12 s). In the queue it shows a small silver star; cancelling it, or losing the
  city while it waits, gives the honor back.
- **Honored Dead** (1500 honor, 30 s): every unit of yours that falls gives you **25% of its cost in honor**
  (Infantry 3, Knight 37.5), whether an enemy, a neutral city or a sinking ship took it. Disbanded units don't count,
  unless an enemy hit them in their last 20 seconds.
- **Two tier II traditions** (4000 honor, 2 minutes each), written in red and tagged **Tier II**: each opens once you
  have learned all four tier I traditions, and they don't need each other. Starting one is not announced, but the
  Players list shows which one and its countdown; every player is told with a red banner once it is learned.
  - **Eternal Glory:** every unit can be trained for honor, at **2 times its gold cost** (Infantry 24, Knight 300): a
    **Pay with Gold / ★ Honor** switch in the Units box, or **Shift + the unit's key**.
  - **Last Stand:** all your units deal **30% more damage** (+40% near a Hero). A unit of yours with at least
    **twice as many enemy units as yours** within 80 km of it takes **30% less damage**, and glows red while it does,
    for everyone to see. Its emblem: a gold cuirass over two crossed swords.
- **Players list (Tab):** a new **Traditions** column shows every player's traditions (they are public now), with
  the tier II ones in red, and which one someone is learning with its countdown.
- Developer builds: the console's `honor N` sets every player's honor, to try this out, and `slomo N` runs the whole
  game N times as fast (0.1 to 10): units, training, research, traditions, turns and cooldowns alike. Any city's
  panel has an **Own** button that makes the city yours at once, like a capture; everyone sees who used it.
- **New sounds:** a choir humming in a cathedral when you learn a tradition, and a quill signing its name when your
  research is complete.

### New: the results screen

- **When the game ends, the results cover the whole screen.** Every player is named by their nickname, written in
  their colour after a dot of it (colours too dark for the page, such as Black or Navy, are lightened). **Look at the map** (or Esc) folds the results into a bar at the top of the screen, where the top
  bar was; **Show results** in that bar opens them again. **Back to lobby** is in both.
- **Players tab:** what the Players list (Tab) shows (cities, gold per turn, units, kills, losses, traditions), plus
  every player's **technologies** and the **peak** of their empire (the most cities they held, and on which turn).
  Below it, a graph of the whole game, one line per player: cities, units, army value, gold per turn, kills or
  losses. Hover the graph for every player's number on that turn; hover a name under it to pick out their line.
- **Click a player for their own page:** cities taken, lost and at the end, units trained, enemy units destroyed,
  units lost, gold earned (from turns and from kills) and spent (units, buildings, research), honor earned and
  spent. Graphs of their cities, army, gold per turn, and kills against losses, with the other players in grey
  behind. Their army by unit type (trained, destroyed, lost), the city upgrades they built, and their milestones:
  each technology and tradition with the turn it was learned, falling and coming back as a liberator, leaving,
  winning.
- **Timeline tab:** the map turn by turn, with every territory in its owner's colour. **Play** steps through the game
  (1 to 8 turns per second), or drag the slider. Beside
  the map: who held how many cities on that turn (and the change since the turn before), what happened in it
  ("Charlemagne took Lyon, Geneva from Navy"; research, traditions, players falling or leaving), and a graph of the
  cities over the game. Click the graph to jump to that turn; hover a city on the map for its name and owner.
- Players who gave up during the game are in the results too, with their nickname, their numbers until they left
  and their cities on the timeline.
- The host's browser records all of it during the game and sends it with the end of the game. A game that ended
  because the host left has no history: the results then show the players' last numbers only.

### New: lost-city alerts and a resizable minimap

- **A city of yours that falls shows on the minimap**, wherever it is: red rings go out from it for a few seconds,
  a red frame blinks around it, and the minimap's frame glows red, next to the sound and the line in the feed.
- **Shift + Space** takes you to the city of yours captured last, and a red ring flashes on it. (Space alone still
  centres on your selection.)
- **The minimap can be resized:** drag its top-right corner. It keeps the map's shape and grows up and to the
  right, up to almost half the screen. Your browser keeps the size for your next games; double-click the corner for
  the default size. The panel at the bottom moves over to stay clear of a bigger minimap.

### Map: 8 new cities, 4 new regions

- **Russia:** the Golden Horde is split. Kazan and Samara, with the new cities **Kungur** and **Ufa**, form the
  **Kazan Khanate**; the Golden Horde keeps Saratov, Volgograd, Astrakhan and Rostov. A new region at the top of
  the map, **Yugra**, has two new cities: **Ukhta** and **Ivdel**.
- **Karasjok**, an inland city, holds the north of Norway (Finnmark).
- **Egilsstaðir** holds the east of Iceland.
- Two new island regions with one city each: **Corsica** (Ajaccio) and the **Balearics** (Palma, with Menorca and
  Ibiza).
- The map now has 58 regions and 218 cities. The default target to win stays at 120 cities.

### Balance

- **Unit limit doubled:** each player may now have **1000 units** (it was 500). Units on board transports count too.
  At the limit, cities pause training units until some fall; upgrades still build.
- **Infantry no longer blocks archer damage.** Archers now hit infantry for their full damage (it used to be 10%
  less).

### Fixes

- **The host no longer gets a head start.** The host's game used to start the moment it loaded, while the other
  players were still connecting, often 10–15 seconds later. Now everyone sees "Waiting for every player to load the
  game" with how many have, then a **10-second countdown**, and the game starts for everyone at once. Until then
  nothing moves and orders are not accepted, but you can look around the map and find your cities. A player who
  never connects holds up the start for 30 seconds at most; they can still join the game later.
- **No more freezes when you send a big army far away.** Sending a few hundred units across the map could stop
  the whole game for up to a second, for every player, and sometimes several times in a row: working out the way
  around a sea (Iberia to Scandinavia goes round the Baltic) searched most of the continent. Paths now know about
  those detours, so a long search takes a few milliseconds, and units waiting for a path no longer queue up behind
  each other. In a test with five players and 2,000 units, the longest pause fell from 1.8 seconds to about a tenth
  of a second (five big orders given at the same moment), and a typical one is now a few milliseconds.
- **Every unit of a big army sets off at once.** Units that could not see the route of their group (a city or the
  coast in between) used to stand still for up to a second before following it. Now they all start walking with the
  order.
- **Big battles cost the host less.** Keeping thousands of units from overlapping took more than half of the host's
  game time in a big battle; it now takes about a fifth of what it did.

### Network: 13–15 times less traffic

- **The host sends each player only what changed.** Every snapshot (10 a second) used to carry the whole game:
  all 210 cities and every unit on the map, even those standing still. Now it carries only the changes since the
  last one: units that moved, cities that were hit or upgraded, the production that progressed. The player's
  browser rebuilds the whole snapshot from them, exactly as the host made it: same rate, same precision, every unit
  on the map as before. Scores are sent the same way.
- **Compressed on direct links**, about three times smaller again (links through the server were compressed already).
- With the whole map in view, a player now gets about 0.15 Mbit/s in an 8-player game with 100 units each (it was
  2.2 Mbit/s), and about 0.35 Mbit/s with 20 players (it was 5.2). The **host's upload**, the real limit, falls from
  15 to about 1 Mbit/s for 8 players, and from 100 to about 7 Mbit/s for 20 players: a usual home connection can now
  host a full game.
- **A slow link no longer lags behind.** A player whose connection can't keep up used to get snapshots seconds late,
  piled up in a queue. Now the host skips a snapshot for them instead (the next one has everything), and the deaths
  and War Cries of a skipped snapshot come with the next one, so none is missed.
- **Faster page loads.** The game's files are sent compressed (about a third of the size), and a reload no longer
  downloads files that haven't changed.

## 8 November 2026: Tech tree

### New: game options

The host now sets the rules in the waiting room (**Game options**). Everyone else sees them, and the lobby list
shows them for every game.

- **Cities to win:** 120 by default. Anything from 11 up to every city on the map.
- **Countdown:** the target can shrink as the game goes on.
  - *From start* (the default): one city fewer at the end of every turn (120, then 119, then 118...).
  - *From turn N*: the target stays the same until turn N (10 by default) is over, then counts down.
  - *No*: the target never changes.
  - It never drops below 1 city. If it drops to several players at once, the one with the most cities wins. If they
    hold exactly as many, the game goes on until one of them pulls ahead.
  - The top bar shows your cities next to the current target, with ▾ while it counts down.
- **Death:** what happens to a player who loses every city and every unit.
  - *Liberator* (the default): see below.
  - *Spectator*: they are out and can only watch, as before.

### New: liberators

With **Death: Liberator**, a player who loses everything stays in the game as a liberator.

- They lose all their gold, then get **20 gold** at the end of every turn.
- They can take any one city on the map, neutral or another player's: click it and press **Liberate**. The city
  changes hands like a capture: its upgrades are lost, and its previous owner gets back the gold for its queue.
  This puts the liberator back in the game.
- A player who holds **5 cities or fewer** is protected. Liberators can't take any of their cities.
- A liberator can take a city at most once every **2 turns**. Falling again always costs all your gold.
- Liberators are never eliminated. With this option, you win only by holding the target number of cities, or by being
  the last player left after everyone else has pressed Leave.
- **F1 → Liberator** explains all of this in the game.

### New: technologies

Press **Tech** (or **T**) to open the Technologies window. Research costs gold up front and takes game time. You can
research one technology at a time. Cancelling gives the gold back.

The first tab, **Rebellion**, appears only in games with Death: Liberator. You can research these at any time, even
before you fall, but they only work while you are a liberator.

| Technology | Levels | Cost | Time | Effect |
| --- | --- | --- | --- | --- |
| Supporters | 3 | 100 / 180 / 260 gold | 2 min each | +20 / +40 / +60 liberator gold per turn |
| Influencer | 3 | 100 gold each | 2 min each | Mark 2 / 3 / 4 cities instead of taking just one |
| Smuggling | 3 | 30 gold each | 1 min each | Steal from 1 / 2 / 3 cities |

- **Influencer:** you mark (influence) one city per turn. When you mark the last one, they are all liberated at once.
  **Liberate now** takes the marked cities earlier. Everyone sees the marks as a turning dashed ring in the
  liberator's colour, and the feed says which city is being stirred up. Only one liberator can mark a city. The
  protection for small empires is checked city by city at the moment of liberation.
- **Smuggling:** at the end of every turn, half of each marked city's income goes from its owner to you. Neutral
  cities pay nothing. A smuggled city shows a gold coin. Only one liberator can smuggle from a city, but one liberator
  may influence a city while another smuggles from it. Click a smuggled city again to stop.
- A liberator who is back in the game loses all their marks, so other liberators can mark those cities.

### New: regions

- The map is split into regions (Hungary, Wallachia, ...). Their names are printed on the map. Dark lines are the
  borders between regions, and faint lines divide the cities of one region.
- Hold **every city of a region** and each of them pays **+2 gold** per turn. Lose one and the whole region loses the
  bonus. A one-city region counts too.
- The city panel shows how much of its region the owner holds. The feed tells you when you complete or lose a region,
  and the end-of-turn message shows how much your regions paid.
- When you take the last city of a region, the region lights up for a few seconds. A wave of gold light spreads from
  that city, the region's outline glows, and every city in it bursts with a gold ring and **+2/turn**. The region's
  name shines in gold, and it also lights up on the minimap.

### New: hold position

- **H** with units selected: they hold position. They never walk, not even to chase, and only fight what comes within
  reach. Other units can't push them aside. A move, attack or stop order ends it.
- A dashed gold ring marks your units on hold.
- **H** no longer jumps to your next city.

### New: order queue

- **Shift + right click** with units selected queues a move, attack-move (hold A) or attack after the orders they
  already have. They carry them out one after another. This also works on the minimap.
- Units with nothing to do start the order at once.
- A group keeps its formation through every queued move.
- A queued attack starts when the unit gets there. If the target is already gone, the unit skips it and goes on to the
  next order.
- A right click without Shift, **S** or **H** replaces the whole queue.
- A unit can have up to 20 orders waiting.
- Selected units show their queued route as dashed lines: green for a move, orange for an attack-move, red for an
  attack.

### New: sounds

- A clock ticks in the last 3 seconds of every turn.
- A sword clash sounds when someone captures one of your cities, wherever it is on the map.
- Sound starts after your first click or key press (a browser rule).

### New: wall grades

The wall now comes in two grades. One button (or **A**) orders both:

| Grade | Cost | Time | City HP |
| --- | --- | --- | --- |
| Wall I | 6 gold | 4 s | +100 |
| Wall II | 14 gold | 6 s | +150 more |

- Each order queues the next grade the city doesn't have yet: press **A** twice to queue Wall I and then Wall II.
  Together they cost 20 gold, take 10 s and give +250 HP. When a little extra HP is enough, stop at the cheap Wall I.
- With several cities selected, each one gets its next grade: Wall I where it has none, Wall II where Wall I is built
  or queued.
- Wall II needs Wall I built or on its way. Cancelling Wall I also cancels a Wall II queued after it, and both are
  refunded.
- A city with Wall II shows a thicker ring wall with turrets.

### Changes

- **Rally points:** new units now attack-move to the rally point, fighting anything they meet on the way.
  **Alt + right click** clears the rally points of the selected cities.
- **Help (F1)** now has pages: **Controls**, **Economy** (every way to get gold, from the current numbers, plus the
  regions you hold or are close to completing) and **Liberator**.
- **Unit panel:** click a unit icon to select only that unit (or only that type). **Ctrl + click** removes it from the
  selection. **Shift + click** marks icons, and the marked units become the selection when you release Shift.
  The panel is more compact and its icons show just the unit's emblem (crossed swords, bow, shield...), as over its
  cone on the map, so a big army is easy to read. It never covers more than the bottom of the screen: past its
  height limit the icons scroll. With many units selected, the line of control tips under the icons is hidden.
- **Feed:** the end-of-turn message shows liberator and smuggling gold, and player names in dark colours (Navy, Black,
  Maroon, Purple, ...) get a light backing so they stay readable.
- When you capture the city you were looking at, it is selected so you can build there at once.
- **Map:** a new city, **Simferopol** (Zaporozhia), brings the map to 208 cities. Borders are redrawn. Only region
  borders and the lines between cities of one region are shown, and modern national borders appear only where they
  divide two cities.

### Balance

| | Before | Now |
| --- | --- | --- |
| Cavalry build time | 8 s | 7 s |
| Knight HP | 200 | 250 |
| Wall | 20 gold, 20 s, +200 HP | Two grades: Wall I 6 gold, 4 s, +100 HP; Wall II 14 gold, 6 s, +150 HP |
| Tower build time | 20 s | 10 s |
| Tower range | +20% | +55% |
| Castle cost | 30 gold | 20 gold |
| Castle build time | 30 s | 10 s |
| Castle damage | +15 | +20 |
| Farm build time | 30 s | 20 s |
| Barracks cost | 50 gold | 30 gold |
| Barracks build time | 20 s | 12 s |
| Barracks training speed | +40% | +100% (twice as fast) |

### Fixes

- Units no longer stop for a moment when you give them a new order soon after the last one. Clicking the same spot
  over and over used to keep them standing still.

### Developer console (debug builds)

- `reset hp`: gives every unit and city in the game full HP.
- `gold N`: sets every player's gold to N.
- The host accepts both only in debug builds, and every player sees who used them in the feed.
