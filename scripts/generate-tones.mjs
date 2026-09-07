/**
 * Generates every audio cue the app uses, as 16-bit mono PCM WAV files.
 *
 * Nothing here is sampled from a recording: each cue is synthesised from the
 * frequency/duration table below, so the app ships zero third-party audio.
 * Run with `npm run tones` after changing anything in CUES.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'audio');

const SAMPLE_RATE = 44100;
const PEAK = 0.92; // leave headroom so the phone speaker does not clip and buzz

/**
 * Phone speakers are far more efficient above ~1 kHz than at the fundamental,
 * so each tone is fundamental + two harmonics. The pitch you hear is still the
 * fundamental listed in CUES; the harmonics only make it carry across 20 m of
 * open air. Set PARTIALS to [{ mult: 1, amp: 1 }] for a pure sine instead.
 */
const PARTIALS = [
  { mult: 1, amp: 1 },
  { mult: 2, amp: 0.55 },
  { mult: 3, amp: 0.35 },
];

const ATTACK_MS = 6;
const RELEASE_MS = 18;

const CUES = {
  // Start/end of a shuttle.
  beep: [{ kind: 'tone', freq: 880, ms: 150 }],
  // Moving up a level: two short high beeps.
  level: [
    { kind: 'tone', freq: 1320, ms: 150 },
    { kind: 'silence', ms: 90 },
    { kind: 'tone', freq: 1320, ms: 150 },
  ],
  // 3-2-1 ticks during the 10 s recovery.
  tick: [{ kind: 'tone', freq: 660, ms: 110 }],
  // Test over: falling tone, unmistakable from any other cue.
  end: [{ kind: 'sweep', from: 1200, to: 400, ms: 1000 }],
  // Inaudible loop that holds the iOS audio session open between cues so the
  // app keeps running with the screen locked. Must stay non-zero.
  silence: [{ kind: 'dither', ms: 1000 }],
};

const msToSamples = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);

function envelope(index, total) {
  const attack = msToSamples(ATTACK_MS);
  const release = msToSamples(RELEASE_MS);
  if (index < attack) return 0.5 - 0.5 * Math.cos((Math.PI * index) / attack);
  const fromEnd = total - index;
  if (fromEnd < release) return 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / release);
  return 1;
}

function partialSum(phase) {
  let value = 0;
  for (const { mult, amp } of PARTIALS) value += amp * Math.sin(phase * mult);
  return value;
}

function renderSegment(segment) {
  const total = msToSamples(segment.ms);
  const out = new Float64Array(total);

  if (segment.kind === 'silence') return out;

  if (segment.kind === 'dither') {
    // One LSB of a 16-bit sample: below the noise floor of any speaker, but not
    // digital silence, which some audio stacks treat as "nothing is playing".
    for (let i = 0; i < total; i += 1) out[i] = (i % 2 === 0 ? 1 : -1) / 32767;
    return out;
  }

  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    const freq =
      segment.kind === 'sweep'
        ? segment.from + (segment.to - segment.from) * (i / total)
        : segment.freq;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    out[i] = partialSum(phase) * envelope(i, total);
  }
  return out;
}

function renderCue(segments) {
  const parts = segments.map(renderSegment);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Float64Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function normalise(samples, isDither) {
  if (isDither) return samples;
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return samples;
  const gain = PEAK / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  return samples;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, segments] of Object.entries(CUES)) {
  const isDither = segments.some((segment) => segment.kind === 'dither');
  const samples = normalise(renderCue(segments), isDither);
  const wav = toWav(samples);
  const file = join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, wav);
  const ms = Math.round((samples.length / SAMPLE_RATE) * 1000);
  console.log(`${name}.wav  ${ms} ms  ${wav.length} bytes`);
}
