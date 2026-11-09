# TODO

## Later: support 10,000–15,000 units on the map

Not now. The server will change dramatically for this, possibly a rewrite in C++.

Where we are today:
- Units are capped at `ECONOMY.maxUnitsPerPlayer` = 1000 per player (up to 20,000 in a full 20-player game, so the cap no longer protects the server).
- Everything runs on one thread.
- A* across Europe takes 6–35 ms per search (up to ~85 ms).
- Background re-plans are limited to 8 searches per tick.

- [ ] **Stress test first:** a scenario with 15k units, constant orders and large battles, to measure where tick time goes.
- [ ] **Pathfinding**
  - [ ] Hierarchical pathfinding (HPA\*) over the static land grid, or a navigation mesh (Recast/Detour), to make a long search ~0.2–1 ms.
  - [ ] Flow fields for shared destinations (cities, rally points, an army's target): one computation for all units going there.
  - [ ] Squads: one route per army, members follow the leader in formation.
  - [ ] Merge identical requests (same area → same goal) into one search.
  - [ ] Worker-thread pool:
    - map data in shared memory, read by all workers;
    - prioritized queue (player orders > rally/attack > chase > stuck);
    - asynchronous results; stale results discarded;
    - per-player limits on queued requests.
- [ ] **Perception / targeting:**
  - scan for enemies less often (2–4 Hz, spread across ticks);
  - cheaper nearby-enemy search;
  - in crowds, local steering instead of re-planning.
- [ ] **Simulation:**
  - units stored in typed arrays instead of objects;
  - spatial grid without per-tick allocations;
  - different update rates for movement, combat and idle AI;
  - parallel map regions if one thread is not enough;
  - one worker per game.
- [ ] **Network:**
  - binary snapshots (they already go as changes, compressed: public/js/delta.js);
  - near the camera 10 Hz, elsewhere less often;
  - armies shown as single markers when zoomed out;
  - encoding in workers.
- [ ] **Client:** WebGL instanced rendering (e.g. PixiJS) instead of Canvas 2D.

## Gameplay

- [x] **Anonymous players (core feature):**
  - nicknames are never shown while a game is played;
  - colours are random and hidden in the lobby;
  - players are called by colour;
  - everyone is revealed when the game ends.

  See [GAME_DESIGN.md](GAME_DESIGN.md) for the rule and the places the current build has to change.
- [ ] Moving units should not push standing units aside. The moving unit should find a way around them.
- [x] Naval units: transports carry land units across the sea to islands and other coasts (README, Navy).
- [ ] Warships, and ships that fight each other.
