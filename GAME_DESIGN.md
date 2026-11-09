# Game design: core rules

These rules define the game. Code and new features must follow them.

## Anonymous players

**During a game nobody knows who is who.** Players only see empires of different colours. When the game ends,
everyone is revealed.

- **Nicknames belong to the lobby.** They are used to enter, find and join games, and in the waiting room to see who
  has joined.
- **No colours before the game.** The lobby and the waiting room never show player colours.
- **Colours are random.** They are assigned at random when the game starts. They don't depend on join order, on
  being the host, or on the nickname.
- **In the game, players are known only by their colour,** e.g. "Red" or "Teal". Your own empire is "You".
- **No nickname anywhere while the game is played:** not on the map, in the panels, in the players overlay, in
  event messages or in tooltips.
- **Nothing outside the game gives it away either.** For a game in progress, the lobby lists nicknames only:
  no colours and no city counts. Someone checking the lobby cannot match a name to a colour.
- **The server enforces it.** While the game is played, the server never sends other players' nicknames to game
  clients; the browser only gets each player's id and colour. Hiding names only in the interface is not enough,
  because anyone can read the network messages.
- **Everyone is revealed when the game ends.** As soon as the game is over (someone won), identities are no longer
  secret:
  - The results screen names the winner by nickname and lists every player by nickname, written in their colour.
  - The server sends the full list only at that moment.
  - From then on the lobby may show the finished game's players with their colours.
- **Rejoining still works by nickname,** because it happens in the lobby, before entering the game.

### Status: implemented

- Colours are dealt at random when the game starts. The lobby and the waiting room show no colours.
- Each colour has a name (`PLAYER_COLOR_NAMES` in [shared/config.js](shared/config.js)). The Players overlay, the
  event feed and the city and unit panels call players "Red", "Navy", "Lime", ... and your own empire "You".
- While the game runs, the server sends no nickname to game clients: not in `start`, `room` or `score`, and not in
  events. Players are told apart by id and colour only.
- Player ids are shuffled when the game starts. In the waiting room ids follow join order and are listed with
  nicknames, so keeping them would let a client match nicknames to colours.
- For a game in progress the lobby lists nicknames only, alphabetically: no city counts, and no connection or
  elimination status that could be matched with the in-game event feed.
- When the game ends, the `gameover` message carries every player's nickname and colour. The results screen
  names the winner and lists everyone, and the Players overlay adds the nicknames. Players who gave up during the
  game are revealed too (the lobby server keeps them for that).
- **Browser-to-browser play** (the game runs in the host player's browser, see README): the lobby server gives the
  host only ids and colours, so the host's browser never has a nickname either. The nicknames come from the lobby
  server (`reveal`) once the game is over or the host has left.
- **One gap: IP addresses.** A direct WebRTC link shows the host each player's IP address, which could tell friends
  who is who. Running the server with `RELAY_ONLY=1` and a TURN relay sends all traffic through the relay, so nobody
  learns another player's address.

`npm test` checks the rule:
- [test/colors.test.js](test/colors.test.js): 100 games in a row must give players different colours each run, and
  the lobby never shows colours.
- [test/anonymous.test.js](test/anonymous.test.js): no message to a game client contains a nickname while the game
  runs (including disconnects, returns and leaving); ids do not follow join order; the lobby lists only nicknames;
  everyone is revealed at the end.
- [test/p2p-lobby.test.js](test/p2p-lobby.test.js) and [test/host-engine.test.js](test/host-engine.test.js): in
  browser-to-browser play the host's roster has ids and colours only, no nickname reaches any browser while the game
  runs, and only the lobby server reveals them at the end.
