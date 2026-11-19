// WHAT: The chapter audio checks: reading ffmpeg's loudness report, measuring decoded PCM,
//       and judging the result, then (step 3) the exact arguments sent to ffmpeg.
// WHY:  September's podcastaudio.mjs had no tests; the renderer stubbed it out, so what
//       counts as silence, clipping, a loop or a loudness miss was never checked. The pure
//       decisions run on synthetic input, so CI tests them with no ffmpeg installed. Text
//       shaped like ffmpeg's loudnorm report is an INPUT to the parser, the way a string is
//       an input to a parser, not a claim about ffmpeg's contract (.claude/rules/testing.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../lib/podcastaudio.mjs');

// --- loudness report ---

const report = (values) => `[Parsed_loudnorm_0 @ 0x1] \n{\n${Object.entries(values)
  .map(([k, v]) => `\t"${k}" : "${v}"`).join(',\n')}\n}\n`;
const LEVELS = { input_i: '-23.10', input_tp: '-4.50', input_lra: '5.20', input_thresh: '-33.40', target_offset: '0.10' };

test('the last loudness report in stderr is the one read', async () => {
  const { parseLoudness } = await load();
  const stderr = `noise\n${report({ ...LEVELS, input_i: '-30.00' })}more\n${report(LEVELS)}`;
  assert.equal(parseLoudness(stderr).input_i, '-23.10');
});

test('a missing or non-numeric loudness report is refused, never guessed', async () => {
  const { parseLoudness } = await load();
  assert.throws(() => parseLoudness('ffmpeg said nothing useful'), /loudness measurement was not returned/);
  assert.throws(() => parseLoudness(report({ ...LEVELS, input_i: '-inf' })), /no measurable speech/);
});

// --- PCM measurement: 4 kHz mono signed 16-bit, 100 ms = 400 samples ---

const RATE = 4000;
let seed = 7;
const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
/** `seconds` of noise at amplitude `level` (0 = silence), as 16-bit samples. */
const noise = (seconds, level) => Array.from({ length: seconds * RATE }, () => Math.round((random() * 2 - 1) * level * 32767));
const pcm = (...parts) => {
  const samples = parts.flat();
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
};

test('a clean signal reports no long silence, no clipping and no loop', async () => {
  const { analysePcm } = await load();
  const signals = analysePcm(pcm(noise(10, 0.3)));
  assert.equal(signals.envelope.length, 100, 'one value per 100 ms');
  assert.equal(signals.clipped, 0);
  assert.equal(signals.longest_silence_seconds, 0);
  assert.deepEqual(signals.repetitions, []);
});

test('silence is measured in 100 ms steps', async () => {
  const { analysePcm } = await load();
  const signals = analysePcm(pcm(noise(2, 0.3), noise(6, 0), noise(2, 0.3)));
  assert.equal(signals.longest_silence_seconds, 6);
});

test('full-scale samples are counted as clipped', async () => {
  const { analysePcm } = await load();
  const clippedRun = Array.from({ length: 50 }, (_, i) => (i % 2 ? 32767 : -32768));
  // Inside whole 100 ms windows: a trailing partial window (under 100 ms) is not measured.
  assert.equal(analysePcm(pcm(noise(1, 0.3), clippedRun, noise(1, 0.3))).clipped, 50);
});

test('a section that plays again a minute later is reported as a repetition', async () => {
  const { analysePcm } = await load();
  // A 20 s stretch whose loudness changes every 100 ms, heard again after 60 s of other speech.
  const shape = Array.from({ length: 200 }, () => 0.05 + random() * 0.5);
  const section = shape.flatMap((level) => noise(0.1, level));
  const signals = analysePcm(pcm(section, noise(60, 0.3), section));
  assert.ok(signals.repetitions.length > 0);
  assert.ok(signals.repetitions[0].repeated_at_seconds - signals.repetitions[0].from_seconds >= 60);
});

// --- the verdict, at each threshold ---

const clean = {
  asset: { duration: 100 },
  signals: { clipped: 0, samples: 400_000, longest_silence_seconds: 1, repetitions: [] },
  levels: { input_i: '-16.0', input_tp: '-2.0' },
  expectedDuration: 100,
  wordCount: 250, // 150 words per minute
};
const verdict = async (change) => (await load()).judgeAudio({ ...clean, ...change, signals: { ...clean.signals, ...change.signals }, levels: { ...clean.levels, ...change.levels } });

test('a clean result passes and reports words per minute', async () => {
  const v = await verdict({});
  assert.deepEqual(v.issues, []);
  assert.equal(v.passed, true);
  assert.equal(v.words_per_minute, 150);
});

test('each check stays quiet at its limit and fires just past it', async () => {
  const cases = [
    ['duration', { asset: { duration: 102 } }, { asset: { duration: 102.1 } }, /duration differs/],
    ['slow speech', { wordCount: 70 * 100 / 60 }, { wordCount: 69 * 100 / 60 }, /implausible/],
    ['fast speech', { wordCount: 260 * 100 / 60 }, { wordCount: 261 * 100 / 60 }, /implausible/],
    ['silence', { signals: { longest_silence_seconds: 5 } }, { signals: { longest_silence_seconds: 5.1 } }, /Silence longer than five seconds/],
    ['clipping', { signals: { clipped: 400 } }, { signals: { clipped: 401 } }, /Clipping/],
    ['quiet', { levels: { input_i: '-17.5' } }, { levels: { input_i: '-17.6' } }, /loudness or true peak/],
    ['loud', { levels: { input_i: '-14.5' } }, { levels: { input_i: '-14.4' } }, /loudness or true peak/],
    ['true peak', { levels: { input_tp: '-1.0' } }, { levels: { input_tp: '-0.9' } }, /loudness or true peak/],
  ];
  for (const [label, inside, past, reason] of cases) {
    assert.deepEqual((await verdict(inside)).issues, [], `${label}: at the limit`);
    const fired = await verdict(past);
    assert.equal(fired.passed, false, `${label}: past the limit`);
    assert.ok(fired.issues.some((i) => reason.test(i)), `${label}: ${fired.issues}`);
  }
  const looped = await verdict({ signals: { repetitions: [{ from_seconds: 10, repeated_at_seconds: 90, similarity: 0.99 }] } });
  assert.ok(looped.issues.some((i) => /Repeated audio pattern/.test(i)));
});

test('without a transcript length there is no words-per-minute check', async () => {
  const v = await verdict({ wordCount: undefined });
  assert.equal(v.words_per_minute, null);
  assert.equal(v.passed, true);
});
