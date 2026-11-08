// Regions: the countries of tools/cities.js (Hungary, Wallachia...), map.countries in map.json.
// A player who holds every city of a region gets ECONOMY.regionBonusPerCity more gold per turn
// from each of them. Used by the server (income) and the browser (HUD, city panel).

// City ids of every region: regionCities(map)[region] = [cityId, ...].
export function regionCities(map) {
  const out = map.countries.map(() => []);
  map.cities.forEach((c, i) => out[c.c].push(i));
  return out;
}

// The player who holds every one of these cities, or -1. ownerOf(cityId): its owner, -1 = neutral.
export function regionHolder(cityIds, ownerOf) {
  let holder = -1;
  for (const id of cityIds) {
    const o = ownerOf(id);
    if (o < 0 || (holder >= 0 && o !== holder)) return -1;
    holder = o;
  }
  return holder;
}
