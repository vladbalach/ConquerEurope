// Game countries (mix of modern states and historic realms) and their cities.
// City entries: [name, latitude, longitude].
// Territory is derived automatically: each city owns the part of its landmass
// that is closer to it than to any other city on the same landmass.

export const COUNTRIES = [
  { name: 'Portugal', cities: [['Lisbon', 38.72, -9.14], ['Porto', 41.15, -8.61], ['Coimbra', 40.21, -8.43], ['Faro', 37.02, -7.93]] },
  { name: 'Castile', cities: [['Madrid', 40.42, -3.70], ['Valladolid', 41.65, -4.72], ['Santiago', 42.88, -8.54], ['Oviedo', 43.36, -5.85], ['Bilbao', 43.26, -2.93], ['Mérida', 38.92, -6.34]] },
  { name: 'Aragon', cities: [['Barcelona', 41.39, 2.17], ['Zaragoza', 41.65, -0.89], ['Valencia', 39.47, -0.38]] },
  { name: 'Andalusia', cities: [['Seville', 37.39, -5.98], ['Granada', 37.18, -3.60], ['Córdoba', 37.88, -4.78]] },

  { name: 'France', cities: [['Paris', 48.86, 2.35], ['Orléans', 47.90, 1.90], ['Rouen', 49.44, 1.10], ['Reims', 49.26, 4.03], ['Lille', 50.63, 3.06]] },
  { name: 'Brittany', cities: [['Rennes', 48.11, -1.68], ['Brest', 48.39, -4.49], ['Nantes', 47.22, -1.55]] },
  { name: 'Burgundy', cities: [['Dijon', 47.32, 5.04], ['Lyon', 45.76, 4.84], ['Metz', 49.12, 6.18], ['Strasbourg', 48.58, 7.75]] },
  { name: 'Occitania', cities: [['Bordeaux', 44.84, -0.58], ['Toulouse', 43.60, 1.44], ['Limoges', 45.83, 1.26], ['Montpellier', 43.61, 3.88], ['Marseille', 43.30, 5.37], ['Nice', 43.70, 7.27]] },

  { name: 'England', cities: [['London', 51.51, -0.13], ['Bristol', 51.45, -2.59], ['Birmingham', 52.49, -1.89], ['York', 53.96, -1.08], ['Manchester', 53.48, -2.24], ['Norwich', 52.63, 1.30], ['Newcastle', 54.98, -1.61], ['Plymouth', 50.38, -4.14]] },
  { name: 'Scotland', cities: [['Edinburgh', 55.95, -3.19], ['Glasgow', 55.86, -4.25], ['Aberdeen', 57.15, -2.09], ['Inverness', 57.48, -4.22]] },
  { name: 'Ireland', cities: [['Dublin', 53.35, -6.26], ['Cork', 51.90, -8.47], ['Galway', 53.27, -9.05], ['Belfast', 54.60, -5.93]] },
  { name: 'Iceland', cities: [['Reykjavík', 64.15, -21.94], ['Akureyri', 65.68, -18.09]] },

  { name: 'Netherlands', cities: [['Amsterdam', 52.37, 4.90], ['Groningen', 53.22, 6.57], ['Eindhoven', 51.44, 5.47], ['Brussels', 50.85, 4.35], ['Luxembourg', 49.61, 6.13]] },
  { name: 'Prussia', cities: [['Berlin', 52.52, 13.40], ['Magdeburg', 52.13, 11.63], ['Rostock', 54.09, 12.10], ['Königsberg', 54.71, 20.51]] },
  { name: 'Saxony', cities: [['Dresden', 51.05, 13.74], ['Leipzig', 51.34, 12.37], ['Erfurt', 50.98, 11.03]] },
  { name: 'Bavaria', cities: [['Munich', 48.14, 11.58], ['Nuremberg', 49.45, 11.08], ['Stuttgart', 48.78, 9.18], ['Freiburg', 47.99, 7.85]] },
  { name: 'Westphalia', cities: [['Cologne', 50.94, 6.96], ['Frankfurt', 50.11, 8.68], ['Kassel', 51.31, 9.48], ['Hanover', 52.37, 9.73], ['Bremen', 53.08, 8.80], ['Hamburg', 53.55, 9.99]] },

  { name: 'Switzerland', cities: [['Zürich', 47.37, 8.54], ['Bern', 46.95, 7.45], ['Geneva', 46.20, 6.14]] },
  { name: 'Austria', cities: [['Vienna', 48.21, 16.37], ['Salzburg', 47.81, 13.04], ['Innsbruck', 47.27, 11.39], ['Graz', 47.07, 15.44], ['Ljubljana', 46.06, 14.51]] },

  { name: 'Savoy', cities: [['Turin', 45.07, 7.69], ['Milan', 45.46, 9.19], ['Genoa', 44.41, 8.93], ['Cagliari', 39.22, 9.12]] },
  { name: 'Venice', cities: [['Venice', 45.44, 12.32], ['Verona', 45.44, 10.99]] },
  { name: 'Papal States', cities: [['Rome', 41.90, 12.50], ['Bologna', 44.49, 11.34], ['Florence', 43.77, 11.26], ['Ancona', 43.62, 13.52]] },
  { name: 'Naples', cities: [['Naples', 40.85, 14.27], ['Bari', 41.12, 16.87], ['Reggio', 38.11, 15.65], ['Palermo', 38.12, 13.36], ['Catania', 37.50, 15.09], ['Valletta', 35.90, 14.51]] },

  { name: 'Denmark', cities: [['Copenhagen', 55.68, 12.57], ['Aarhus', 56.16, 10.20], ['Aalborg', 57.05, 9.92]] },
  { name: 'Norway', cities: [['Oslo', 59.91, 10.75], ['Bergen', 60.39, 5.32], ['Trondheim', 63.43, 10.40], ['Bodø', 67.28, 14.40], ['Tromsø', 69.65, 18.96]] },
  { name: 'Sweden', cities: [['Stockholm', 59.33, 18.07], ['Gothenburg', 57.71, 11.97], ['Kalmar', 56.66, 16.36], ['Sundsvall', 62.39, 17.31], ['Luleå', 65.58, 22.15]] },
  { name: 'Finland', cities: [['Helsinki', 60.17, 24.94], ['Turku', 60.45, 22.27], ['Kuopio', 62.89, 27.68], ['Oulu', 65.01, 25.47]] },

  { name: 'Livonia', cities: [['Tallinn', 59.44, 24.75], ['Tartu', 58.38, 26.72], ['Riga', 56.95, 24.11], ['Daugavpils', 55.87, 26.54]] },
  { name: 'Lithuania', cities: [['Vilnius', 54.69, 25.28], ['Kaunas', 54.90, 23.90], ['Klaipėda', 55.70, 21.14], ['Minsk', 53.90, 27.56], ['Brest-Litovsk', 52.10, 23.69], ['Gomel', 52.44, 30.98], ['Vitebsk', 55.19, 30.20]] },
  { name: 'Poland', cities: [['Warsaw', 52.23, 21.01], ['Kraków', 50.06, 19.94], ['Lublin', 51.25, 22.57], ['Gdańsk', 54.35, 18.65], ['Szczecin', 53.43, 14.55], ['Poznań', 52.41, 16.93], ['Wrocław', 51.11, 17.03]] },
  { name: 'Bohemia', cities: [['Prague', 50.08, 14.44], ['Brno', 49.20, 16.61], ['Plzeň', 49.75, 13.38]] },
  { name: 'Hungary', cities: [['Budapest', 47.50, 19.04], ['Debrecen', 47.53, 21.64], ['Szeged', 46.25, 20.15], ['Pécs', 46.07, 18.23], ['Košice', 48.72, 21.26], ['Nitra', 48.31, 18.09], ['Cluj', 46.77, 23.59]] },

  { name: 'Croatia', cities: [['Zagreb', 45.81, 15.98], ['Split', 43.51, 16.44], ['Dubrovnik', 42.65, 18.09], ['Osijek', 45.55, 18.69]] },
  { name: 'Bosnia', cities: [['Sarajevo', 43.86, 18.41], ['Banja Luka', 44.77, 17.19]] },
  { name: 'Serbia', cities: [['Belgrade', 44.79, 20.45], ['Niš', 43.32, 21.90]] },
  { name: 'Montenegro', cities: [['Podgorica', 42.44, 19.26]] },
  { name: 'Albania', cities: [['Tirana', 41.33, 19.82], ['Vlorë', 40.47, 19.49]] },
  { name: 'Macedonia', cities: [['Skopje', 42.00, 21.43]] },
  { name: 'Greece', cities: [['Athens', 37.98, 23.73], ['Thessaloniki', 40.64, 22.94], ['Patras', 38.25, 21.73], ['Ioannina', 39.66, 20.85], ['Larissa', 39.64, 22.42], ['Heraklion', 35.34, 25.13]] },
  { name: 'Bulgaria', cities: [['Sofia', 42.70, 23.32], ['Plovdiv', 42.14, 24.75], ['Varna', 43.21, 27.91], ['Tarnovo', 43.08, 25.63]] },
  { name: 'Wallachia', cities: [['Bucharest', 44.43, 26.10], ['Craiova', 44.32, 23.80], ['Constanța', 44.18, 28.63], ['Brașov', 45.66, 25.61]] },
  { name: 'Moldavia', cities: [['Iași', 47.16, 27.59], ['Suceava', 47.65, 26.26], ['Chișinău', 47.01, 28.86]] },

  { name: 'Ruthenia', cities: [['Lviv', 49.84, 24.03], ['Vinnytsia', 49.23, 28.47], ['Kyiv', 50.45, 30.52], ['Chernihiv', 51.49, 31.29]] },
  { name: 'Zaporozhia', cities: [['Poltava', 49.59, 34.55], ['Kharkiv', 49.99, 36.23], ['Dnipro', 48.46, 35.05], ['Odesa', 46.48, 30.72], ['Simferopol', 44.95, 34.10]] },
  { name: 'Muscovy', cities: [['Moscow', 55.76, 37.62], ['Smolensk', 54.78, 32.05], ['Tula', 54.19, 37.62], ['Yaroslavl', 57.63, 39.87], ['Nizhny Novgorod', 56.33, 44.00], ['Voronezh', 51.66, 39.20]] },
  { name: 'Novgorod', cities: [['Saint Petersburg', 59.94, 30.31], ['Novgorod', 58.52, 31.27], ['Petrozavodsk', 61.79, 34.35], ['Arkhangelsk', 64.54, 40.54], ['Murmansk', 68.97, 33.07]] },
  { name: 'Golden Horde', cities: [['Kazan', 55.79, 49.11], ['Samara', 53.20, 50.15], ['Saratov', 51.53, 46.03], ['Volgograd', 48.71, 44.51], ['Astrakhan', 46.35, 48.04], ['Rostov', 47.24, 39.72]] },

  { name: 'Ottomans', cities: [['Istanbul', 41.01, 28.98], ['Edirne', 41.68, 26.56], ['Izmir', 38.42, 27.14], ['Ankara', 39.93, 32.86]] },
  { name: 'Anatolia', cities: [['Konya', 37.87, 32.48], ['Antalya', 36.90, 30.70], ['Trabzon', 41.00, 39.72], ['Erzurum', 39.90, 41.27], ['Adana', 37.00, 35.32]] },
  { name: 'Cyprus', cities: [['Nicosia', 35.17, 33.36]] },
];
