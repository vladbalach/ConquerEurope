# Patch notes

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
