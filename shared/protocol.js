// Version of the messages exchanged between the browser and the server. Bump it whenever
// a message changes shape, so a page talking to an outdated server process can say so
// instead of silently misbehaving.
export const PROTOCOL_VERSION = 16;  // 3: city upgrades, item ids; 4: farm; 5: knight; 6: live balance + admin; 7: barracks; 8: disband; 9: map editing; 10: game options; 11: hold; 12: death option, liberators; 13: technologies, influence, smuggling; 14: ships, ports, boarding, coastal edits; 15: Shift-queued orders; 16: wall grades
