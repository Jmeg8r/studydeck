// WHAT: The chapter audio wrappers against the real ffmpeg and ffprobe.
// WHY:  The recorder pins what this app sends; only the real tools show that the loudnorm
//       report parses, the concat list resolves and the checks pass on real output. CI's
//       Linux runners have no ffmpeg and must not install one (CLAUDE.md), so this test
//       skips there, saying why, and runs on the Mac that renders. Its run is recorded in
//       the plan's Proof. Generates its own tones; it reads no study material.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveTool } from '../lib/executables.mjs';
import { assembleAudio, audioTools, checkAudio, probeAudio } from '../lib/podcastaudio.mjs';

const run = promisify(execFile);
const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcastaudio-ffmpeg-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let unavailable = null;
try {
  await audioTools();
} catch (err) {
  unavailable = `ffmpeg/ffprobe not runnable here (${err.code ?? err.message}); this test runs on the rendering Mac`;
}

test('two generated clips assemble into one normalised file that passes its checks', { skip: unavailable ?? false, timeout: 60_000 }, async () => {
  const dir = join(ROOT, 'render');
  mkdirSync(join(dir, 'clips'), { recursive: true });
  const clips = [['a'.repeat(64), 440], ['b'.repeat(64), 660]].map(([key, frequency]) => ({ key, frequency }));
  for (const { key, frequency } of clips) {
    await run(resolveTool('STUDYDECK_FFMPEG', 'ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=2`, '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '128k',
      join(dir, 'clips', `${key}.mp3`)]);
  }
  const durations = [];
  for (const { key } of clips) durations.push((await probeAudio(join(dir, 'clips', `${key}.mp3`))).duration);

  const normalization = await assembleAudio(dir, clips);
  assert.equal(normalization.target_lufs, -16);
  assert.equal(existsSync(join(dir, 'candidate.mp3')), true);
  assert.equal(existsSync(join(dir, 'candidate.part.mp3')), false);

  const report = await checkAudio(join(dir, 'candidate.mp3'), { expectedDuration: durations[0] + durations[1], wordCount: 10 });
  assert.equal(report.passed, true, report.issues.join('; '));
  assert.ok(Math.abs(report.asset.duration - 4) < 0.5, `about 4 s, got ${report.asset.duration}`);
  assert.ok(Math.abs(report.integrated_lufs + 16) <= 1.5, `near -16 LUFS, got ${report.integrated_lufs}`);
  assert.match(report.asset.sha256, /^[a-f0-9]{64}$/);
});
