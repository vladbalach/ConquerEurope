// Regions: the countries of tools/cities.js (Hungary, Wallachia...), map.countries in map.json.
// A player who holds every city of a region holds the region "whole": its cities pay
// ECONOMY.regionBonusPerCity more gold per turn, and the player's land units march faster in it with
// Roads (TECHS.roads). Used by the server (income, Roads) and the browser (HUD, city panel, unit panel).
//
// Where a region's land is: every landmass of the map (map.polys) is shared between the cities listed
// on it (`c`), each city getting the part of it nearer to it than to the others (the territories the map
// draws, tools/build-map.js). A landmass with no city belongs to no region.

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

// The region of the territory at (x, y) on a landmass whose cities are `owners` (map.polys[].c): the
// region of the nearest of them, or -1 when the landmass has none.
function regionOnLandmass(cities, owners, x, y) {
  if (owners.length < 2) return owners.length ? cities[owners[0]].c : -1;
  let best = owners[0], bd = Infinity;
  for (const ci of owners) {
    const c = cities[ci], d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bd) { bd = d; best = ci; }
  }
  return cities[best].c;
}

// ---------------------------------------------------------------- every cell of the land grid
// For checks made every tick for many units (Roads): the region of each cell of the land grid, looked
// up by cell index. The grid stores each cell's landmass (nav.poly: 1 + its index in map.polys, 0 = water),
// so only the cities sharing a landmass need comparing. About 20 ms for the whole map, once: games on the
// same map and land grid share it, and a rebuilt map (a new nav.poly) gets a new one.
export const NO_REGION = 255;             // a cell of no region (sea, land of no city): region ids stay below it
const grids = new WeakMap();              // nav.poly -> Uint8Array: the region of every cell

// nav: the land grid (server/nav.js NavGrid). Returns the regions by cell index (nav.cellOf), NO_REGION
// where there is none. A cell takes the territory its centre lies in.
export function regionGrid(map, nav) {
  let out = grids.get(nav.poly);
  if (out) return out;
  if (map.countries.length >= NO_REGION) throw new Error(`regionGrid: ${map.countries.length} regions, at most ${NO_REGION - 1}`);
  const { w, h, x0, y0, cell, poly } = nav, cities = map.cities;
  out = new Uint8Array(w * h).fill(NO_REGION);
  for (let j = 0, c = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = 0; i < w; i++, c++) {
      const p = poly[c];
      if (!p) continue;
      const r = regionOnLandmass(cities, map.polys[p - 1].c, x0 + (i + 0.5) * cell, y);
      if (r >= 0) out[c] = r;
    }
  }
  grids.set(nav.poly, out);
  return out;
}

// ---------------------------------------------------------------- one point
// A browser has no land grid: it finds the landmass round the point among the map's polygons. Fine for
// a point now and then (the selected unit's panel); for many points every tick, regionGrid.
const boxes = new WeakMap();              // map.polys -> [x0, y0, x1, y1] of every landmass

function landmassBoxes(polys) {
  let out = boxes.get(polys);
  if (out) return out;
  out = new Float64Array(polys.length * 4);
  polys.forEach((p, k) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const ring of p.r) {
      for (let i = 0; i < ring.length; i += 2) {
        a = Math.min(a, ring[i]); b = Math.min(b, ring[i + 1]); c = Math.max(c, ring[i]); d = Math.max(d, ring[i + 1]);
      }
    }
    out.set([a, b, c, d], k * 4);
  });
  boxes.set(polys, out);
  return out;
}

// Is (x, y) inside these rings (flat [x, y, ...] each), holes counted out (even-odd, as the map fills them)?
function insideRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

// The region at (x, y), or -1 at sea and on land of no city.
export function regionAtPoint(map, x, y) {
  const polys = map.polys, box = landmassBoxes(polys);
  for (let k = 0; k < polys.length; k++) {
    const b = k * 4;
    if (x < box[b] || y < box[b + 1] || x > box[b + 2] || y > box[b + 3]) continue;
    if (insideRings(polys[k].r, x, y)) return regionOnLandmass(map.cities, polys[k].c, x, y);
  }
  return -1;
}
