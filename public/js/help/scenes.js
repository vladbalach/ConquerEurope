// The help's animated demos (demo.js): one scene per control or rule, played round a real city of the map.
// Places are km from that city (`at`): east is +x, south is +y. `cam`: where the view is centred, from the
// city; `zoom`: as the game's (1 = 1 px per km). `speed`: faster than the game (the demo says so).
// A scene's play(s) is its script; s is the demo's API (demo.js Demo.api): set-up, then the pointer and the
// keys doing what a player does, with a caption saying what is shown.
import { UNITS, CITY_UPGRADES, HERO, HEALER } from '/shared/config.js';

// Boarding as the game does it: the transport sails to a dock off the beach nearest the troops (`landRef` on
// their land, `seaRef` out at sea, the shore found between them), they gather on the shore, and each one
// within reach of the docked ship goes on board (the number on the boat).
async function boardShip(s, ship, troops, landRef, seaRef) {
  const shore = s.shore(landRef, seaRef);
  const out = Math.atan2(seaRef[1] - landRef[1], seaRef[0] - landRef[0]);
  const dock = [shore[0] + Math.cos(out) * 12, shore[1] + Math.sin(out) * 12];
  s.world.docks.set(ship.id, { x: dock[0], y: dock[1], lx: shore[0], ly: shore[1], load: true });
  s.sim.give(ship, { k: 'move', x: dock[0], y: dock[1] }, false);
  s.order(troops, 'move', [shore[0] - Math.cos(out) * 8, shore[1] - Math.sin(out) * 8]);
  await s.until(() => {
    for (const u of troops) {
      if (s.alive(u) && !ship.order && Math.hypot(u.x - ship.x, u.y - ship.y) < 30) {
        s.sim.remove(u, false);
        s.sim.setCargo(ship, (ship.cargoCount || 0) + 1);
      }
    }
    return troops.every((u) => !s.alive(u));
  });
  s.world.docks.delete(ship.id);
}

export const SCENES = {
  // ---------------------------------------------------------------- the first conquest (Welcome)
  conquest: {
    at: 'Paris', cam: [70, 10], zoom: 1.25, speed: 3,
    async play(s) {
      const paris = s.own(s.city('Paris'), 'you');
      const reims = s.city('Reims');
      s.active(reims);
      s.say('Click one of your cities, then press Q to train infantry.');
      await s.click(paris);
      for (let i = 0; i < 4; i++) await s.build('infantry');
      s.say('Training: the bar under the city. New units step out next to it.');
      await s.until(() => s.sim.units.length >= 4);
      await s.wait(0.6);
      s.say('Drag a frame round them to select them all.');
      await s.box(s.at(-45, 0), s.at(45, 45));
      s.say('Right-click a grey city: they storm it. Bring its HP to zero and it is yours.');
      await s.right(reims);
      await s.until(() => s.world.cityOwner[reims] === s.YOU);
      s.say('Taken! Every city you hold pays you gold each turn.');
      await s.wait(2);
    },
  },

  // ---------------------------------------------------------------- selecting
  'select-click': {
    at: 'Paris', cam: [0, 40], zoom: 1.9,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const u = s.units('infantry', 'you', [[-55, 55], [-28, 62], [0, 55], [28, 62], [55, 55]]);
      s.say('Left-click a unit to select it: the green ring shows it takes your orders.');
      await s.click(u[1]);
      await s.wait(0.8);
      s.say('Hold Shift and click more units to add them (Shift + click one again takes it out).');
      s.keyDown('Shift');
      await s.click(u[2]);
      await s.click(u[3]);
      s.keyUp('Shift');
      await s.wait(0.9);
      s.say('Click empty ground to clear the selection.');
      await s.click(s.at(75, 92));
      await s.wait(0.8);
    },
  },

  'select-box': {
    at: 'Paris', cam: [0, 40], zoom: 1.9,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.block('infantry', 'you', 6, -55, 45, 3, 16);
      s.block('archer', 'you', 4, 55, 45, 2, 16);
      s.say('Drag a frame with the left button: every unit of yours inside it is selected.');
      await s.box(s.at(-90, 30), s.at(-20, 82));
      await s.wait(0.8);
      s.say('Hold Shift and drag another frame to add those units too.');
      s.keyDown('Shift');
      await s.box(s.at(30, 30), s.at(85, 82));
      s.keyUp('Shift');
      await s.wait(1);
    },
  },

  'select-double': {
    at: 'Paris', cam: [0, 40], zoom: 1.9,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const spots = [[-70, 40], [-45, 60], [-20, 40], [5, 60], [30, 40], [55, 60], [80, 45], [-60, 82], [-10, 82], [40, 82]];
      const kinds = ['infantry', 'archer', 'infantry', 'cavalry', 'archer', 'infantry', 'archer', 'cavalry', 'infantry', 'archer'];
      const units = spots.map(([x, y], i) => s.unit(kinds[i], 'you', x, y));
      s.say('Double-click a unit: every unit of that kind on screen is selected.');
      await s.dblclick(units[4]);
      await s.wait(1);
      s.say('F2 selects all your units.');
      await s.key('F2');
      s.select(units);
      await s.wait(1.2);
    },
  },

  'select-cities': {
    at: 'Paris', cam: [62, 12], zoom: 1.3,
    async play(s) {
      const paris = s.own(s.city('Paris'), 'you');
      s.own(s.city('Reims'), 'you');
      s.block('infantry', 'you', 3, 20, 70, 3, 16);
      s.say('Click one of your cities to select it: its panel opens and it takes your orders.');
      await s.click(paris);
      await s.wait(0.8);
      s.say('A frame with none of your units in it selects your cities in it: one key then orders in all of them.');
      await s.box(s.at(-35, -70), s.at(165, 35));
      await s.wait(1);
      s.say('Hold Alt and drag: only cities, even with your units inside the frame (a gold frame).');
      s.keyDown('Alt');
      await s.box(s.at(-40, -70), s.at(170, 95));
      s.keyUp('Alt');
      await s.wait(1);
      s.selectCities([]);
    },
  },

  groups: {
    at: 'Paris', cam: [0, 40], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const riders = s.block('cavalry', 'you', 3, -80, 60, 3, 17);
      s.block('infantry', 'you', 4, 70, 60, 2, 16);
      s.say('Select some units, then press Ctrl + 1: they are saved as group 1.');
      await s.box(s.at(-110, 45), s.at(-50, 80));
      s.keyDown('Ctrl');
      await s.key('1');
      s.keyUp('Ctrl');
      await s.wait(0.5);
      s.say('Select others...');
      await s.box(s.at(45, 45), s.at(100, 95));
      await s.wait(0.6);
      s.say('Press 1: group 1 is selected again, wherever it is. Press 1 twice quickly to centre the view on it.');
      await s.key('1');
      s.select(riders);
      await s.wait(0.5);
      await s.key('1');
      await s.camTo(-80, 50, 1.6, 0.8);
      await s.wait(1.2);
    },
  },

  // ---------------------------------------------------------------- moving
  move: {
    at: 'Paris', cam: [0, 45], zoom: 1.5,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const army = [
        ...s.block('infantry', 'you', 4, -100, 40, 2, 15),
        ...s.block('archer', 'you', 2, -125, 40, 1, 15),
        ...s.block('cavalry', 'you', 2, -100, 85, 2, 16),
      ];
      s.say('Select your units, then right-click the ground: they go there.');
      await s.box(s.at(-140, 20), s.at(-80, 100));
      await s.right(s.at(70, 50));
      s.say('They spread into a formation round that place: infantry in front, archers behind, riders on the wings.');
      await s.until(() => army.every((u) => !u.order));
      await s.wait(1.2);
    },
  },

  formation: {
    at: 'Paris', cam: [0, 45], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.block('infantry', 'you', 6, -90, 50, 3, 15);
      s.block('archer', 'you', 3, -90, 80, 3, 15);
      await s.box(s.at(-125, 30), s.at(-55, 95));
      s.say('Hold the right button and drag: grey ghosts show where each unit will stand. A long drag: a wide line.');
      await s.rightDrag(s.at(40, 50), s.at(40, 5));
      await s.until(() => s.selected().every((u) => !u.order));
      await s.wait(0.5);
      s.say('A short drag: a narrow, deep column. It faces the way you drag; let go to give the order.');
      await s.rightDrag(s.at(-40, 60), s.at(-25, 60), { s: 0.6 });
      await s.until(() => s.selected().every((u) => !u.order));
      await s.wait(1);
    },
  },

  queue: {
    at: 'Paris', cam: [0, 45], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const units = s.block('cavalry', 'you', 3, -95, 75, 3, 17);
      await s.box(s.at(-125, 60), s.at(-65, 92));
      s.say('Hold Shift and right-click several places: the orders queue up, shown as a dashed route.');
      s.keyDown('Shift');
      await s.right(s.at(-40, 20), { s: 0.5 });
      await s.right(s.at(40, 25), { s: 0.5 });
      await s.right(s.at(90, 80), { s: 0.5 });
      s.keyUp('Shift');
      s.say('They carry them out one after another. A right-click without Shift replaces the whole queue.');
      await s.until(() => units.every((u) => !u.order));
      await s.wait(1);
    },
  },

  // ---------------------------------------------------------------- fighting
  'attack-unit': {
    at: 'Paris', cam: [0, 45], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.block('infantry', 'you', 4, -95, 45, 2, 15);
      const foes = s.block('infantry', 'enemy', 3, 75, 50, 1, 18, { hp: 0.55 });
      await s.box(s.at(-120, 25), s.at(-70, 70));
      s.say('Right-click an enemy unit: your selected units attack it (the red marker).');
      await s.right(foes[1]);
      s.say('Once it falls they fight the enemies next to it. Each kill pays you gold and honor.');
      await s.until(() => foes.every((u) => !s.alive(u)));
      await s.wait(1.2);
    },
  },

  amove: {
    at: 'Paris', cam: [0, 45], zoom: 1.4,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const army = s.block('infantry', 'you', 6, -120, 45, 2, 15);
      const foes = [...s.units('infantry', 'enemy', [[-10, 30], [5, 62]], { hp: 0.5 }), s.unit('archer', 'enemy', 10, 45, { hp: 0.6 })];
      await s.box(s.at(-145, 25), s.at(-95, 85));
      s.say('Hold A and right-click: an attack-move. They fight every enemy they meet on the way (orange marker)...');
      s.keyDown('A');
      await s.right(s.at(110, 45));
      s.keyUp('A');
      await s.until(() => foes.every((u) => !s.alive(u)));
      s.say('...and walk on once the way is clear. A plain right-click would walk past them, taking hits.');
      await s.until(() => army.filter((u) => s.alive(u)).every((u) => !u.order));
      await s.wait(1);
    },
  },

  hold: {
    at: 'Paris', cam: [10, 45], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const mine = [...s.block('infantry', 'you', 3, -40, 40, 3, 16), ...s.block('archer', 'you', 3, -40, 62, 3, 16)];
      const riders = s.block('cavalry', 'enemy', 3, 120, 50, 1, 18, { hp: 0.7 });
      await s.box(s.at(-70, 25), s.at(-10, 75));
      s.say('Press H: they hold position (gold dashed rings). They never walk, not even to chase.');
      await s.hold();
      await s.wait(0.6);
      s.attack(riders, mine[1]);
      s.say('They fight only what comes within reach. Archers shoot as the enemy comes close; nobody runs after it.');
      await s.until(() => riders.every((u) => !s.alive(u)));
      await s.wait(1.2);
    },
  },

  stop: {
    at: 'Paris', cam: [0, 45], zoom: 1.6,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.block('infantry', 'you', 4, -100, 45, 2, 15);
      await s.box(s.at(-125, 25), s.at(-75, 70));
      await s.right(s.at(100, 45));
      s.say('Walking somewhere...');
      await s.wait(2.2);
      s.say('Press S: they stop where they are (and forget their queued orders).');
      await s.stop();
      await s.wait(1.5);
    },
  },

  disband: {
    at: 'Paris', cam: [0, 45], zoom: 1.8, speed: 2,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const units = s.units('infantry', 'you', [[-40, 45], [-15, 50], [15, 45], [40, 50]], { hp: 0.4 });
      await s.box(s.at(-55, 30), s.at(0, 65));
      s.say('Delete disbands the selected units: they lose 10 HP a second until they die. It can\'t be undone.');
      await s.disband();
      await s.until(() => !s.alive(units[0]) && !s.alive(units[1]));
      s.say('Useful for units you no longer need. A disbanded unit counts as a loss for you.');
      await s.wait(1.4);
    },
  },

  capture: {
    at: 'Reims', cam: [-40, 15], zoom: 1.7, speed: 1.5,
    async play(s) {
      const reims = s.city('Reims');
      s.active(reims);
      s.upgrades(reims, 'wall');
      s.block('infantry', 'you', 6, -85, 25, 2, 15);       // between Paris (127 km west) and Reims
      await s.box(s.at(-110, 5), s.at(-60, 65));
      s.say('Right-click a city that isn\'t yours to attack it. Grey (neutral) cities shoot at everyone in range.');
      await s.right(reims);
      await s.until(() => s.world.cityOwner[reims] === s.YOU);
      s.say('HP down to zero: the city is yours, with 40 HP. Its upgrades are gone, and it pays you from the next turn.');
      await s.wait(2.5);
    },
  },

  // ---------------------------------------------------------------- cities
  train: {
    at: 'Paris', cam: [0, 25], zoom: 1.9, speed: 2,
    async play(s) {
      const paris = s.own(s.city('Paris'), 'you');
      s.say('Click your city, then press a unit\'s key: Q infantry, W archers, E cavalry, R knight.');
      await s.click(paris);
      await s.build('infantry');
      await s.build('infantry');
      await s.build('archer');
      await s.build('knight');
      s.say('Each order joins the city\'s queue (up to 10), paid at once. The gold bar under its name: the one in training.');
      await s.wait(1.2);
      s.say('Changed your mind? C cancels the last entry of the queue, and you get its gold back.');
      await s.cancel();
      await s.until(() => s.sim.units.length >= 3);
      await s.wait(1.2);
    },
  },

  'multi-train': {
    at: 'Paris', cam: [62, 12], zoom: 1.3, speed: 2,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.own(s.city('Reims'), 'you');
      s.say('Select several cities (a frame round them, or Shift + click)...');
      await s.box(s.at(-35, -70), s.at(165, 35));
      s.say('...and one key press trains one unit in each of them, as far as your gold goes.');
      await s.build('infantry');
      await s.build('cavalry');
      await s.until(() => s.sim.units.length >= 4);
      await s.wait(1.2);
    },
  },

  rally: {
    at: 'Paris', cam: [30, 35], zoom: 1.6, speed: 2,
    async play(s) {
      const paris = s.own(s.city('Paris'), 'you');
      await s.click(paris);
      s.say('With a city selected, right-click land: its rally point (the flag).');
      await s.right(s.at(95, 60));
      s.say('Every unit it trains from now on marches there, fighting whatever it meets on the way.');
      await s.build('infantry');
      await s.build('infantry');
      await s.build('archer');
      await s.until(() => s.sim.units.length >= 3 && s.sim.units.every((u) => !u.order));
      s.say('Alt + right-click clears it: new units stay by the city again.');
      s.keyDown('Alt');
      await s.right(s.at(40, 60));
      s.keyUp('Alt');
      await s.wait(1.5);
    },
  },

  upgrades: {
    at: 'Paris', cam: [0, 8], zoom: 2.6, speed: 3,
    async play(s) {
      const paris = s.own(s.city('Paris'), 'you');
      await s.click(paris);
      const steps = [
        ['wall', `A: ${CITY_UPGRADES.wall.name}, +${CITY_UPGRADES.wall.hp} HP (press A again for Wall II).`],
        ['tower', `S: Tower, ${CITY_UPGRADES.tower.rangePercent}% more range.`],
        ['castle', `D: Castle, +${CITY_UPGRADES.castle.damage} damage.`],
        ['farm', `F: Farm, +${CITY_UPGRADES.farm.goldPerTurn} gold every turn.`],
        ['barracks', 'G: Barracks, units train twice as fast here.'],
      ];
      for (const [key, text] of steps) {
        s.say(text);
        await s.build(key);
        await s.until(() => !s.world.myQueues.get(paris)?.queue.length);
        await s.wait(0.5);
      }
      s.say('Each is built once per city and shows on its castle. They are lost if the city is captured.');
      await s.wait(2);
    },
  },

  ranges: {
    at: 'Paris', cam: [62, 12], zoom: 1.15,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.own(s.city('Reims'), 'enemy');
      s.say('Hold Alt: the attack radius of every city. A city shoots enemies in range on its own.');
      await s.hover(s.at(60, 60), 0.6);
      s.keyDown('Alt');
      await s.wait(2.5);
      s.keyUp('Alt');
      await s.wait(0.6);
    },
  },

  camera: {
    at: 'Paris', cam: [0, 0], zoom: 1.5,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.own(s.city('Reims'), 'enemy');
      s.say('Arrow keys, the screen edge, or dragging with the middle button scroll the map.');
      s.keyDown('→');
      await s.camTo(110, 0, 1.5, 1.6);
      s.keyUp('→');
      s.keyDown('←');
      await s.camTo(0, 0, 1.5, 1.6);
      s.keyUp('←');
      s.say('The mouse wheel zooms. Far out, cities become dots in their owner\'s colour: the strategic view.');
      s.wheel(-1);
      await s.camTo(0, 60, 0.3, 2.2);
      await s.wait(1.2);
      s.wheel(1);
      await s.camTo(0, 0, 1.5, 2.2);
      await s.wait(0.8);
    },
  },

  // ---------------------------------------------------------------- honor
  hero: {
    at: 'Paris', cam: [0, 45], zoom: 1.7,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      const units = s.block('infantry', 'you', 5, 0, 50, 5, 18);
      s.say(`With Cult of Heroes learned: select one land unit and press C (${HERO.cost} honor).`);
      await s.click(units[2]);
      await s.key('C');
      s.sim.makeHero(units[2], 'infantry');
      s.say(`A Hero: a crown and a gold ring. Every unit of yours within ${HERO.auraRadius} km deals ${Math.round(HERO.auraBonus * 100)}% more damage (the dashed circle).`);
      await s.wait(3.5);
    },
  },

  healer: {
    at: 'Paris', cam: [0, 45], zoom: 1.7,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.units('infantry', 'you', [[-35, 35], [0, 30], [35, 38], [-20, 65], [25, 66]], { hp: 0.3 });
      const medic = s.unit('infantry', 'you', 0, 52);
      s.say(`With Order of Mercy learned, a land unit can be made a Healer (${HEALER.cost} honor, Make Healer in its panel).`);
      await s.click(medic);
      s.sim.makeHealer(medic);
      s.say(`Every unit of yours within ${HEALER.radius} km regains ${HEALER.hpPerSecond} HP a second, even in a fight (green glow).`);
      await s.wait(4);
    },
  },

  // ---------------------------------------------------------------- navy (round London: the Channel to the south)
  board: {
    at: 'London', cam: [0, 75], zoom: 1.5,
    async play(s) {
      s.own(s.city('London'), 'you');
      const troops = s.block('infantry', 'you', 4, 0, 30, 2, 15);
      const ship = s.unit('transport', 'you', -40, 135);
      await s.box(s.at(-25, 12), s.at(25, 55));
      s.say('Select land units: your transports with room glow light blue. Right-click one to go on board.');
      await s.right(ship);
      s.say('It sails to the beach nearest them; they gather on the shore and go on board (the number on the boat).');
      await boardShip(s, ship, troops, s.at(0, 40), s.at(0, 140));
      await s.wait(1.5);
    },
  },

  unload: {
    at: 'London', cam: [70, 120], zoom: 1.3,
    async play(s) {
      s.own(s.city('London'), 'you');
      const ship = s.unit('transport', 'you', 10, 115, { cargo: 4 });
      await s.click(ship);
      s.say('Select a loaded transport and right-click land across the sea (or press U, then click).');
      const goal = s.at(170, 200);
      await s.right(goal);
      s.sim.stop([ship]);
      const shore = s.shore(goal, s.at(60, 130));
      const dock = [shore[0] - 10, shore[1] - 6];
      s.world.docks.set(ship.id, { x: dock[0], y: dock[1], lx: shore[0], ly: shore[1], load: false });
      s.sim.give(ship, { k: 'move', x: dock[0], y: dock[1] }, false);
      s.say('It sails to the nearest beach, lands everyone, and they march on to the place.');
      await s.until(() => !ship.order);
      for (let i = 0; i < 4; i++) {
        const u = s.sim.add('infantry', s.YOU, shore[0] + (i % 2) * 8, shore[1] + Math.floor(i / 2) * 8);
        s.sim.setCargo(ship, 3 - i);
        s.sim.give(u, { k: 'amove', x: goal[0] + (i % 2) * 15, y: goal[1] + Math.floor(i / 2) * 15 }, false);
        await s.wait(0.35);
      }
      s.world.docks.delete(ship.id);
      await s.wait(3);
    },
  },

  battleship: {
    at: 'London', cam: [10, 130], zoom: 1.5,
    async play(s) {
      s.own(s.city('London'), 'you');
      const ship = s.unit('battleship', 'you', -90, 140);
      const prey = s.unit('transport', 'enemy', 80, 135);
      await s.click(ship);
      s.say(`Battleships shoot ballista bolts: ${UNITS.battleship.damage} damage every ${UNITS.battleship.reload || 1.5} s, at ships, troops ashore and cities.`);
      await s.right(prey);
      s.say('A bolt flies and follows its target: it always hits, unless the target dies first.');
      await s.until(() => !s.alive(prey));
      await s.wait(1.5);
    },
  },

  // ---------------------------------------------------------------- more navy
  filters: {
    at: 'London', cam: [0, 70], zoom: 1.45,
    async play(s) {
      s.own(s.city('London'), 'you');
      s.block('infantry', 'you', 4, -30, 40, 2, 15);
      s.unit('transport', 'you', 20, 125);
      s.unit('battleship', 'you', 60, 120);
      const all = () => s.sim.units;
      s.say('A frame round land and sea selects your units and ships together.');
      await s.box(s.at(-55, 20), s.at(85, 145));
      await s.wait(0.6);
      s.say('Shift + B keeps only the ships...');
      s.keyDown('Shift');
      await s.key('B');
      s.keyUp('Shift');
      s.select(all().filter((u) => u.def.naval));
      await s.wait(1.2);
      await s.box(s.at(-55, 20), s.at(85, 145));
      s.say('...and Ctrl + B removes them. Ctrl + F and Shift + F do the same with full transports.');
      s.keyDown('Ctrl');
      await s.key('B');
      s.keyUp('Ctrl');
      s.select(all().filter((u) => !u.def.naval));
      await s.wait(1.6);
    },
  },

  autoload: {
    at: 'London', cam: [0, 80], zoom: 1.35,
    async play(s) {
      s.own(s.city('London'), 'you');
      const west = s.block('infantry', 'you', 3, -60, 35, 3, 15);
      const east = s.block('infantry', 'you', 3, 45, 35, 3, 15);
      const a = s.unit('transport', 'you', -40, 140);
      const b = s.unit('transport', 'you', 50, 135);
      s.say('Select transports (a whole fleet if you like) and press L: Autoload.');
      await s.box(s.at(-60, 120), s.at(70, 155));
      await s.key('L');
      s.say('Your idle land units around them go on board, each to the nearest transport with room.');
      await Promise.all([
        boardShip(s, a, west, s.at(-50, 45), s.at(-50, 140)),
        boardShip(s, b, east, s.at(45, 45), s.at(45, 140)),
      ]);
      s.say('Land units selected, L works the other way round: they find your transports with room and board.');
      await s.wait(2);
    },
  },

  repair: {
    at: 'Plymouth', cam: [25, 50], zoom: 1.6, speed: 3,
    async play(s) {
      s.own(s.city('Plymouth'), 'you');
      // Open sea to the south of Plymouth: the ship comes in from far out to just off the city.
      const ship = s.unit('transport', 'you', 90, 105, { hp: 0.3 });
      s.say('A damaged ship mends slowly at sea. Bring it near the pier of one of your coastal cities...');
      await s.click(ship);
      await s.right(s.at(8, 34));
      s.say('...and once out of the fight for a few seconds, its crew repairs it fast: a hammer and a saw at work.');
      await s.until(() => ship.hp >= ship.def.hp * 0.95);
      await s.wait(1);
    },
  },

  // ---------------------------------------------------------------- economy
  region: {
    at: 'Paris', cam: [-8, 58], zoom: 1.0, speed: 1.5,
    async play(s) {
      s.own(s.city('Paris'), 'you');
      s.own(s.city('Reims'), 'you');
      const tours = s.city('Tours');
      s.active(tours);
      s.block('infantry', 'you', 6, -60, 100, 3, 15);
      s.say('France has three cities: Paris, Reims and Tours. You hold two of them.');
      await s.box(s.at(-90, 85), s.at(-30, 125));
      await s.right(tours);
      s.say('Take the last one and the whole region is yours: it lights up, and each of its cities pays more gold every turn.');
      await s.until(() => s.world.cityOwner[tours] === s.YOU);
      await s.wait(4.5);
    },
  },
};

for (const [id, scene] of Object.entries(SCENES)) scene.id = id;
