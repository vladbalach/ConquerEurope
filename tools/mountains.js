// Mountain ranges: land no unit can cross (tools/build-map.js marks them on the land grid).
//
// A range is a list of chains, one after another along it: lines of [latitude, longitude] points along
// the crest (the order of tools/cities.js), `width` km across; a point may give its own width as a third
// number. Chains narrow towards their ends. Where one chain ends and the next begins there is a pass:
// the build clears a straight way through the range there, MOUNTAIN.pass km wide, across the line
// between the two ends. The passes are where the real ones are (Brenner, Gotthard, Dukla, Shipka...).
//
// The build also keeps every range off the sea and away from the cities (MOUNTAIN in build-map.js), so a
// range reaching the sea leaves a road along the coast and every city has room around it, and it checks
// that no city ends up walled in: such land gets a pass of its own.

export const MOUNTAINS = [
  // ---------------------------------------------------------------- Iberia
  { name: 'Pyrenees', width: 62, chains: [
    [[43.08, -1.15], [42.92, -0.85], [42.8, -0.62]],                                        // | Somport
    [[42.78, -0.4], [42.72, 0.2], [42.66, 0.8], [42.6, 1.4], [42.48, 2.0], [42.42, 2.5]],
  ] },
  { name: 'Cantabrian Mountains', width: 45, chains: [
    [[42.78, -7.05], [42.95, -6.5], [43.0, -6.05]],                                         // | Pajares
    [[43.0, -5.5], [43.05, -4.9], [43.07, -4.35], [43.02, -3.85]],
  ] },
  { name: 'Sistema Central', width: 40, chains: [
    [[40.2, -6.55], [40.28, -5.9], [40.32, -5.25], [40.4, -4.75]],                         // Gredos | Ávila
    [[40.58, -4.35], [40.78, -4.0], [41.0, -3.65], [41.15, -3.35]],                        // Guadarrama
  ] },
  { name: 'Sierra Nevada', width: 36, chains: [
    [[37.08, -3.3], [37.13, -2.8], [37.2, -2.35]],
  ] },

  // ---------------------------------------------------------------- France
  { name: 'Massif Central', width: 50, chains: [
    [[45.75, 2.85], [45.4, 2.8], [45.05, 2.75]],                                            // Auvergne, Cantal
  ] },
  { name: 'Cévennes', width: 36, chains: [
    [[44.5, 3.6], [44.2, 3.95]],
  ] },

  // ---------------------------------------------------------------- Alps and Apennines
  { name: 'Alps', width: 95, chains: [
    [[44.12, 7.05, 60], [44.35, 6.85, 65], [44.7, 6.8, 70], [45.0, 6.8, 70]],             // Maritime, Cottian | Mont Cenis
    [[45.45, 6.95], [45.8, 6.95], [46.0, 7.45], [46.25, 8.0], [46.45, 8.35]],             // Graian, Pennine, Bernese | Gotthard
    [[46.62, 9.05], [46.55, 9.6], [46.6, 10.2], [46.85, 10.8], [46.95, 11.15]],           // Rhaetian, Ötztal | Brenner
    [[47.05, 11.85, 85], [47.1, 12.4, 80], [47.15, 13.1, 72], [47.3, 13.85, 66], [47.45, 14.6, 60], [47.58, 15.3, 52]],   // Tauern
  ] },
  { name: 'Southern Alps', width: 44, chains: [
    [[46.25, 11.6], [46.35, 12.1], [46.42, 12.8]],                                         // Dolomites, Carnic | Tarvisio
    [[46.38, 13.45], [46.3, 14.2]],                                                          // Julian Alps, Karawanks
  ] },
  { name: 'Apennines', width: 46, chains: [
    [[44.62, 9.45], [44.4, 10.0], [44.18, 10.65]],                                          // | Futa
    [[43.88, 11.85], [43.55, 12.3], [43.15, 12.85], [42.85, 13.15]],                       // | Via Salaria
    [[42.45, 13.55], [42.1, 13.95], [41.75, 14.3], [41.45, 14.6]],                         // Gran Sasso, Maiella | Benevento
    [[41.05, 15.15], [40.65, 15.6], [40.25, 15.95], [39.85, 16.15]],
  ] },

  // ---------------------------------------------------------------- Balkans
  { name: 'Dinaric Alps', width: 52, chains: [
    [[45.45, 14.75], [45.05, 15.35], [44.5, 16.05], [44.05, 16.75], [43.7, 17.35]],       // | Neretva
    [[43.3, 18.15], [43.1, 18.8], [42.8, 19.4], [42.55, 19.95], [42.35, 20.35]],           // Durmitor, Prokletije
  ] },
  { name: 'Balkan Mountains', width: 38, chains: [
    [[43.7, 22.4], [43.4, 22.7], [43.12, 23.15]],                                           // | Iskar gorge
    [[42.88, 23.75], [42.78, 24.4], [42.73, 25.05]],                                        // | Shipka
    [[42.75, 25.6], [42.8, 26.2], [42.85, 26.85], [42.85, 27.35]],
  ] },
  { name: 'Rila and Pirin', width: 46, chains: [
    [[42.2, 23.4], [41.75, 23.45]],
  ] },
  { name: 'Rhodopes', width: 46, chains: [
    [[41.95, 24.05], [41.7, 24.65], [41.55, 25.3], [41.45, 25.85]],
  ] },
  { name: 'Pindus', width: 46, chains: [
    [[40.65, 20.75], [40.15, 21.05]],                                                        // | Katara pass
    [[39.55, 21.3], [39.15, 21.65], [38.85, 22.0], [38.7, 22.25]],
  ] },
  { name: 'Carpathians', width: 52, chains: [
    [[48.95, 18.2], [49.15, 18.95], [49.2, 19.7], [49.25, 20.4], [49.3, 20.95]],          // Beskids, Tatras | Dukla
    [[49.15, 22.2], [48.85, 22.95], [48.55, 23.45]],                                        // | Verecke
    [[48.25, 24.0], [47.95, 24.6], [47.6, 25.05]],                                          // Chornohora | Borgo pass
    [[47.2, 25.6], [46.8, 25.85], [46.4, 26.05]],                                           // | Oituz
    [[46.0, 26.3], [45.7, 26.25], [45.55, 26.05]],                                          // the bend round Brașov | Predeal
    [[45.42, 25.35], [45.6, 24.8], [45.58, 24.45]],                                         // Bucegi, Făgăraș | Turnu Roșu
    [[45.45, 23.95], [45.38, 23.4], [45.35, 22.85], [45.15, 22.45], [44.9, 22.2]],        // Parâng, Retezat, to the Iron Gates
  ] },
  { name: 'Apuseni', width: 42, chains: [
    [[46.95, 22.45], [46.6, 22.75], [46.35, 22.95]],
  ] },

  // ---------------------------------------------------------------- the north
  { name: 'Scandinavian Mountains', width: 62, chains: [
    [[59.3, 7.15], [59.85, 7.4], [60.3, 7.6]],                                              // Hardangervidda edge | the Bergen line
    [[60.85, 7.85], [61.35, 8.2], [61.75, 8.55], [62.0, 8.85]],                            // Jotunheimen | Dovre
    [[62.45, 9.85], [62.65, 10.8], [62.9, 11.7], [63.1, 12.15]],                           // | Storlien
    [[63.75, 12.6], [64.35, 13.5], [65.0, 14.1], [65.6, 14.6]],                            // | Mo i Rana to Umeå
    [[66.15, 15.1], [66.75, 15.9], [67.35, 16.7], [67.95, 17.6]],                          // | Narvik to Kiruna
    [[68.6, 18.85], [68.95, 19.9], [69.15, 20.8]],
  ] },
  { name: 'Grampians', width: 40, chains: [
    [[56.5, -4.75], [56.75, -4.15], [56.95, -3.55], [57.05, -3.0]],                        // and the Cairngorms
  ] },
  { name: 'North West Highlands', width: 40, chains: [
    [[57.35, -5.15], [57.75, -4.9], [58.15, -4.75]],
  ] },

  // ---------------------------------------------------------------- Central Europe: round Bohemia
  { name: 'Ore Mountains', width: 34, chains: [
    [[50.25, 12.35], [50.45, 12.95], [50.65, 13.55]],
  ] },
  { name: 'Sudetes', width: 34, chains: [
    [[50.85, 14.95], [50.75, 15.6], [50.55, 16.15]],                                        // Giant Mountains | Kłodzko
    [[50.3, 16.85], [50.1, 17.25]],                                                          // Jeseníky
  ] },
  { name: 'Bohemian Forest', width: 34, chains: [
    [[49.9, 12.45], [49.55, 12.62]],                                                         // | Furth im Wald
    [[49.15, 13.15], [48.8, 13.75]],
  ] },

  // ---------------------------------------------------------------- the east
  { name: 'Caucasus', width: 85, chains: [
    [[44.15, 39.95], [43.85, 40.7], [43.55, 41.6], [43.35, 42.45], [43.05, 43.4], [42.85, 44.15]],   // Elbrus | Darial
    [[42.65, 45.05], [42.35, 45.85], [42.0, 46.65], [41.65, 47.4], [41.35, 48.0]],
  ] },
  { name: 'Urals', width: 55, chains: [
    [[52.3, 58.5], [53.3, 58.6], [54.3, 59.0], [55.2, 59.4]],                              // | the Middle Urals
    [[56.9, 59.3], [57.8, 59.15], [58.6, 59.1]],                                            // |
    [[59.4, 59.25], [60.4, 59.35]],                                                          // | west of Ivdel
    [[61.4, 59.4], [62.4, 59.45], [63.2, 59.6], [63.9, 59.8], [64.9, 60.3]],
  ] },
  { name: 'Taurus', width: 52, chains: [
    [[37.15, 31.7], [36.95, 32.6], [37.05, 33.5], [37.25, 34.35]],                         // | Cilician Gates
    [[37.55, 35.1], [37.95, 35.7], [38.35, 36.5]],
  ] },
  { name: 'Southeastern Taurus', width: 52, chains: [
    [[38.25, 38.0], [38.4, 39.0], [38.45, 40.0], [38.35, 41.0], [38.25, 41.9]],
  ] },
  { name: 'Pontic Mountains', width: 50, chains: [
    [[41.2, 32.7], [41.1, 33.8], [41.0, 35.0]],                                             // | Amasya
    [[40.65, 36.8], [40.55, 37.8], [40.6, 38.8]],                                           // | Zigana pass
    [[40.6, 40.0], [40.8, 40.8], [41.1, 41.7]],                                             // Kaçkar
  ] },

  // ---------------------------------------------------------------- North Africa
  { name: 'High Atlas', width: 58, chains: [
    [[31.25, -7.6, 60], [31.5, -6.6], [31.85, -5.6], [32.15, -4.75, 54]],
  ] },
  { name: 'Middle Atlas', width: 46, chains: [
    [[32.75, -5.45], [33.2, -4.75], [33.6, -4.1]],
  ] },
  { name: 'Rif', width: 36, chains: [
    [[35.15, -5.25], [35.05, -4.55], [34.95, -3.95]],
  ] },
  { name: 'Tell Atlas', width: 40, chains: [
    [[35.85, 1.2], [36.0, 2.0], [36.15, 2.8]],                                              // | Algiers
    [[36.45, 3.95], [36.45, 4.6], [36.5, 5.3]],                                             // Kabylia
  ] },
  { name: 'Saharan Atlas', width: 40, chains: [
    [[33.05, 0.55], [33.4, 1.5], [33.7, 2.2]],                                              // Djebel Amour | Laghouat
    [[34.35, 3.35], [34.65, 4.15]],                                                          // Ouled Naïl
  ] },
  { name: 'Aurès', width: 40, chains: [
    [[35.1, 5.85], [35.25, 6.5], [35.35, 7.15]],
  ] },
];
