// ICE servers for the browser-to-browser links (WebRTC) between players and the host.
// STUN servers let two browsers find a direct path; a TURN relay carries the traffic when no
// direct path works (some company and mobile networks), and can hide players' IP addresses.
//
// Configure with environment variables (all optional):
//   CF_TURN_KEY_ID, CF_TURN_KEY_API_TOKEN  Cloudflare Realtime TURN (first 1,000 GB a month free).
//       The key stays on the server; browsers get short-lived credentials made from it.
//   ICE_SERVERS   JSON array of RTCIceServer objects used instead of the default STUN servers,
//       e.g. another TURN provider: [{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
//   RELAY_ONLY=1  always go through the TURN relay: players never learn each other's IP address
//       (keeps them anonymous, see GAME_DESIGN.md). Needs a TURN server.
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const CF_TTL = 24 * 3600;              // seconds a Cloudflare credential is valid (max 48 h)

let cloudflare = null;                 // { iceServers, refreshAt }

async function cloudflareIce(id, token) {
  if (cloudflare && Date.now() < cloudflare.refreshAt) return cloudflare.iceServers;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL }),
  });
  if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
  const data = await res.json();
  let list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
  // Browsers cannot use TURN on port 53 and wait for it to time out: leave those addresses out.
  list = list.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);
  cloudflare = { iceServers: list, refreshAt: Date.now() + (CF_TTL / 2) * 1000 };
  return list;
}

const hasTurn = (list) => list.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

// { iceServers, relayOnly } for the browsers of one game.
export async function iceConfig(env = process.env) {
  let iceServers = DEFAULT_ICE;
  if (env.ICE_SERVERS) {
    try {
      const list = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(list) && list.length) iceServers = list;
    } catch (e) {
      console.warn(`ICE_SERVERS is not valid JSON: ${e.message}`);
    }
  }
  if (env.CF_TURN_KEY_ID && env.CF_TURN_KEY_API_TOKEN) {
    try {
      iceServers = await cloudflareIce(env.CF_TURN_KEY_ID, env.CF_TURN_KEY_API_TOKEN);
    } catch (e) {
      console.warn(`No Cloudflare TURN credentials (${e.message}); players connect directly where they can.`);
    }
  }
  return { iceServers, relayOnly: env.RELAY_ONLY === '1' && hasTurn(iceServers) };
}
