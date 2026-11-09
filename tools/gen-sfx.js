// Makes the game's sound effects with ElevenLabs (text to sound effects) and saves them to
// public/sounds/<name>.wav. Needs an ElevenLabs API key in ELEVENLABS_API_KEY.
//
//   npm run sfx              every sound below
//   npm run sfx -- tick      only these
//
// Each run asks for a new take, so run it again if you don't like the result. Every take is
// trimmed to start right on its first sound (so it plays in time with the game) and cut short
// with a fade-out. Its loudness is set here, in the file (`level`): the game plays the files as
// they are, so a file sounds in a player exactly as it does in the game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');

const SOUNDS = {
  // Last 3 seconds of every turn (public/js/client.js).
  tick: {
    text: 'A single crisp clock tick, one short dry mechanical click, close-up, no reverb, no background noise',
    seconds: 0.5,   // the shortest ElevenLabs makes
    keep: 0.22,     // seconds kept from the first sound on
    level: 0.06,    // RMS of the part that sounds (see loudness())
  },
  // Someone captures one of your cities (public/js/client.js).
  'city-lost': {
    text: 'A short burst of sword fighting, two quick steel sword clashes, no background noise',
    seconds: 1.0,
    keep: 0.9,
    level: 0.035,
  },
  // You learned a tradition in the Honor window (public/js/client.js).
  'tradition-learned': {
    text: 'A deep low male choir humming one solemn sacred chord in a stone cathedral, gentle reverb, no instruments',
    seconds: 2.0,
    keep: 1.6,
    level: 0.035,
  },
  // Your research is complete (Tech window; public/js/client.js).
  // Only the signature: naming anything else, even as "no ...", tends to put it in the take.
  'tech-learned': {
    text: 'A quill pen signing a name on paper, ending with a flourish and a firm final dot, close-up, only the ' +
      'writing, nothing else, no music, no background noise',
    seconds: 1.6,
    keep: 1.4,
    level: 0.03,
  },
};

const API = 'https://api.elevenlabs.io/v1/sound-generation?output_format=wav_32000';

export async function generate(def, key) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: def.text, duration_seconds: def.seconds, prompt_influence: 0.7 }),
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// 16-bit PCM WAV -> { rate, samples: Float32Array (mono) }.
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV format ${JSON.stringify(fmt)}`);
      const end = Math.min(buf.length, body + size);   // streamed WAVs may give no real size
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(body + (i * fmt.channels + c) * 2);
        samples[i] = s / fmt.channels / 32768;
      }
      return { rate: fmt.rate, samples };
    }
    p = body + size + (size & 1);
  }
  throw new Error('WAV file has no data');
}

export function writeWav(rate, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
  return buf;
}

const peakOf = (samples) => samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);

// How loud a sound is: the RMS from its start to its last sample above a tenth of its peak, so
// trailing silence doesn't make it count as quieter and a long horn counts louder than a click.
export function loudness(samples) {
  const peak = peakOf(samples);
  let last = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= peak * 0.1) last = i;
  let sq = 0;
  for (let i = 0; i <= last; i++) sq += samples[i] * samples[i];
  return Math.sqrt(sq / (last + 1));
}

// Start just before the first sound, keep `keep` seconds, fade in/out, scale to `level`
// (never above -1 dB peak).
export function trim({ rate, samples }, { keep, level }) {
  const peak = peakOf(samples);
  if (peak < 0.01) throw new Error('the take is silent');
  const onset = samples.findIndex((s) => Math.abs(s) >= peak * 0.1);
  const start = Math.max(0, onset - Math.round(rate * 0.002));
  const out = samples.slice(start, Math.min(samples.length, start + Math.round(rate * keep)));
  const fadeIn = Math.round(rate * 0.001);
  const fadeOut = Math.round(out.length * 0.4);
  for (let i = 0; i < out.length; i++) {
    if (i < fadeIn) out[i] *= i / fadeIn;
    const k = out.length - i;
    if (k < fadeOut) out[i] *= 0.5 - 0.5 * Math.cos(Math.PI * k / fadeOut);
  }
  const gain = Math.min(level / loudness(out), 0.89 / peakOf(out));
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return { out, onsetMs: Math.round(onset / rate * 1000) };
}

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Set ELEVENLABS_API_KEY to your ElevenLabs API key first.');
  const names = process.argv.slice(2);
  for (const n of names) if (!SOUNDS[n]) throw new Error(`Unknown sound "${n}". Known: ${Object.keys(SOUNDS).join(', ')}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of names.length ? names : Object.keys(SOUNDS)) {
    const def = SOUNDS[name];
    const wav = readWav(await generate(def, key));
    const { out, onsetMs } = trim(wav, def);
    const file = path.join(OUT_DIR, `${name}.wav`);
    fs.writeFileSync(file, writeWav(wav.rate, out));
    console.log(`${name}: first sound at ${onsetMs} ms of the take, kept ${Math.round(out.length / wav.rate * 1000)} ms -> ${path.relative(process.cwd(), file)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
