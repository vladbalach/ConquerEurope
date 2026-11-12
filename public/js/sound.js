// Sound effects, played with the Web Audio API. Browsers only allow a page to play sound after
// the player has clicked or pressed a key on it, so audio starts on the first of those; until
// then playSound() does nothing. The files are made with tools/gen-sfx.js, which also sets how
// loud each one is: they play at volume 1 unless a caller asks for less.
const FILES = {
  tick: '/sounds/tick.wav',
  'city-lost': '/sounds/city-lost.wav',
  'under-attack': '/sounds/under-attack.wav',             // your units or a city under attack off screen (alerts.js)
  'tradition-learned': '/sounds/tradition-learned.wav',   // Honor window: a tradition learned
  'tech-learned': '/sounds/tech-learned.wav',             // Tech window: research complete
};

let ctx = null;
const buffers = new Map();

function unlock() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctx = new Ctx();
    for (const [name, url] of Object.entries(FILES)) {
      fetch(url)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => buffers.set(name, buf))
        .catch((e) => console.warn(`Sound ${url} could not be loaded (${e.message || e})`));
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function initSound() {
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, { capture: true });
}

export function playSound(name, volume = 1) {
  const buf = buffers.get(name);
  if (!buf || ctx.state !== 'running') return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start();
}
