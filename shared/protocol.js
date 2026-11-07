// Version of the messages exchanged between the browser and the server. Bump it whenever
// a message changes shape, so a page talking to an outdated server process can say so
// instead of silently misbehaving.
export const PROTOCOL_VERSION = 9;   // 3: city upgrades, item ids; 4: farm; 5: knight; 6: live balance + admin; 7: barracks; 8: disband; 9: map editing
