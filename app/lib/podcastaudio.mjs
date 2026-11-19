// WHAT: Join a chapter's voiced clips into one file at a set loudness, and check the result:
//       duration, speaking rate, silence, clipping, a looping section, and loudness.
// WHY:  A podcast that loops or clips is otherwise found only by listening to all of it.
//       The decisions are pure functions of what ffmpeg measures, so they are tested on
//       synthetic input with no ffmpeg installed; the wrappers below only run the tools.
//       Passing is technical QC, not a review: publication still needs a listen.
//       Ported from 264547c, split into decisions and wrappers (chapter-audio-assembly).
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomicSync } from './atomic.mjs';
import { resolveTool } from './executables.mjs';
import { digest, repeatedEnvelope } from './podcastquality.mjs';

/** September's limits, unchanged. Re-tuning waits for real renders (D5d). */
export const THRESHOLDS = Object.freeze({
  maxSeconds: 1800,
  durationTolerance: 0.015,
  durationFloorSeconds: 2,
  wordsPerMinute: Object.freeze([70, 260]),
  silenceSeconds: 5,
  clippedFraction: 0.001,
  targetLufs: -16,
  lufsTolerance: 1.5,
  maxTruePeakDb: -1,
});

export const LOUDNORM_TARGET = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const LOUDNESS_KEYS = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];

/** The last loudnorm JSON report in ffmpeg's stderr. Refuses a missing or non-numeric one. */
export function parseLoudness(stderr) {
  const match = String(stderr).match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if (!match) throw new Error('Audio loudness measurement was not returned');
  const data = JSON.parse(match);
  for (const key of LOUDNESS_KEYS) {
    if (!Number.isFinite(Number(data[key]))) throw new Error('Audio contains no measurable speech');
  }
  return data;
}

const WINDOW_BYTES = 800; // 100 ms of 4 kHz mono 16-bit PCM
const SILENT_RMS = 0.003;
const FULL_SCALE = 0.999;

/**
 * Measure decoded 4 kHz mono signed 16-bit PCM: a 100 ms log-RMS envelope (the input
 * repeatedEnvelope expects), the clipped-sample count, the longest silence, and any loop.
 */
export function analysePcm(pcm) {
  const envelope = [];
  let clipped = 0;
  let silent = 0;
  let longestSilence = 0;
  for (let start = 0; start + WINDOW_BYTES <= pcm.length; start += WINDOW_BYTES) {
    let sum = 0;
    for (let i = start; i < start + WINDOW_BYTES; i += 2) {
      const sample = pcm.readInt16LE(i) / 32768;
      sum += sample * sample;
      if (Math.abs(sample) > FULL_SCALE) clipped++;
    }
    const rms = Math.sqrt(sum / (WINDOW_BYTES / 2));
    envelope.push(Math.log1p(rms * 1000));
    silent = rms < SILENT_RMS ? silent + 1 : 0;
    longestSilence = Math.max(longestSilence, silent / 10);
  }
  return { envelope, clipped, samples: Math.floor(pcm.length / 2), longest_silence_seconds: longestSilence, repetitions: repeatedEnvelope(envelope) };
}

/** The verdict on an assembled chapter, from what was measured. */
export function judgeAudio({ asset, signals, levels, expectedDuration, wordCount }) {
  const t = THRESHOLDS;
  const issues = [];
  const wpm = wordCount ? wordCount * 60 / asset.duration : null;
  if (expectedDuration && Math.abs(asset.duration - expectedDuration) > Math.max(t.durationFloorSeconds, expectedDuration * t.durationTolerance)) {
    issues.push('Assembled duration differs from ordered clips');
  }
  if (wpm && (wpm < t.wordsPerMinute[0] || wpm > t.wordsPerMinute[1])) issues.push('Speech duration is implausible for transcript length');
  if (signals.longest_silence_seconds > t.silenceSeconds) issues.push('Silence longer than five seconds');
  if (signals.samples && signals.clipped / signals.samples > t.clippedFraction) issues.push('Clipping detected');
  if (signals.repetitions.length) issues.push('Repeated audio pattern detected; listen at the flagged timestamps');
  if (Math.abs(Number(levels.input_i) - t.targetLufs) > t.lufsTolerance || Number(levels.input_tp) > t.maxTruePeakDb) {
    issues.push('Final loudness or true peak is outside target');
  }
  return { passed: issues.length === 0, issues, words_per_minute: wpm };
}

// --- Wrappers: run the operator tools (ffmpeg, ffprobe), never a shell. ---
// Each takes `run`, execFile by default, so a test can record exactly what is sent.

const execFileAsync = promisify(execFile);
const OPTIONS = { timeout: 180_000, maxBuffer: 24 * 1024 * 1024 }; // a 30 min chapter decodes to ~14.4 MB
const ffmpeg = () => resolveTool('STUDYDECK_FFMPEG', 'ffmpeg');
const ffprobe = () => resolveTool('STUDYDECK_FFPROBE', 'ffprobe');
const CLIP_KEY = /^[a-f0-9]{64}$/;

/** Both tools present and runnable. */
export async function audioTools({ run = execFileAsync } = {}) {
  for (const tool of [ffmpeg(), ffprobe()]) await run(tool, ['-version'], { ...OPTIONS, timeout: 5000 });
}

/** Duration, size and sha256 of one audio file; refuses one with no audio or under 0.1 s. */
export async function probeAudio(file, { run = execFileAsync } = {}) {
  const { stdout } = await run(ffprobe(), ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,sample_rate,channels', '-of', 'json', file], OPTIONS);
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration < 0.1 || !data.streams?.some((s) => s.codec_type === 'audio')) throw new Error('Invalid or empty audio clip');
  return { duration, bytes: Number(data.format.size), sha256: digest(readFileSync(file)) };
}

/**
 * Join `clips` (in order, from `<dir>/clips/<key>.mp3`) into `<dir>/candidate.mp3` with
 * two-pass loudnorm. Only 64-hex keys this app made reach the concat list. The output is
 * written to candidate.part.mp3 and renamed, so a failure never leaves a half file in place.
 */
export async function assembleAudio(dir, clips, { run = execFileAsync } = {}) {
  if (!clips.length || clips.some((c) => !CLIP_KEY.test(c?.key ?? ''))) throw new Error('Invalid audio assembly manifest');
  const list = join(dir, 'concat.txt');
  writeFileAtomicSync(list, clips.map((c) => `file 'clips/${c.key}.mp3'`).join('\n'));
  const input = ['-f', 'concat', '-safe', '1', '-i', list];
  const first = await run(ffmpeg(), ['-hide_banner', '-nostdin', ...input, '-af', `${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'], OPTIONS);
  const measured = parseLoudness(first.stderr);
  const filter = `${LOUDNORM_TARGET}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}`
    + `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`;
  const partial = join(dir, 'candidate.part.mp3');
  try {
    await run(ffmpeg(), ['-hide_banner', '-nostdin', '-y', ...input, '-af', filter, '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '128k', partial], OPTIONS);
    renameSync(partial, join(dir, 'candidate.mp3'));
  } finally {
    try { unlinkSync(partial); } catch { /* renamed into place, or never written */ }
  }
  return { version: 1, target_lufs: THRESHOLDS.targetLufs, target_true_peak_db: -1.5, measured };
}

/** Probe, decode, measure and judge an assembled chapter. */
export async function checkAudio(file, { expectedDuration, wordCount, run = execFileAsync } = {}) {
  const asset = await probeAudio(file, { run });
  if (asset.duration > THRESHOLDS.maxSeconds) throw new Error('Audio exceeds the 30 minute chapter limit');
  const decoded = await run(ffmpeg(), ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], { ...OPTIONS, encoding: 'buffer' });
  const signals = analysePcm(decoded.stdout);
  const measure = await run(ffmpeg(), ['-hide_banner', '-nostdin', '-i', file, '-af', `${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'], OPTIONS);
  const levels = parseLoudness(measure.stderr);
  const verdict = judgeAudio({ asset, signals, levels, expectedDuration, wordCount });
  return {
    version: 1, passed: verdict.passed, issues: verdict.issues, asset, words_per_minute: verdict.words_per_minute,
    integrated_lufs: Number(levels.input_i), true_peak_db: Number(levels.input_tp),
    longest_silence_seconds: signals.longest_silence_seconds, repetitions: signals.repetitions,
  };
}

