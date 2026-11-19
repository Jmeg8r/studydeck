// WHAT: What the chapter audio wrappers SEND to ffmpeg and ffprobe, and what they write.
// WHY:  A recorder, like the egress tests: it pins this app's argument lists, its concat
//       list and its temp-then-rename, never ffmpeg's behaviour. The canned stdout and
//       stderr are INPUTS that get the code past the tool; if ffmpeg changes its output,
//       these keep passing and podcastaudioffmpeg.test.mjs (local only) is what notices.
//       Loaded with import() so missing exports fail only this file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcastaudio-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const load = () => import('../lib/podcastaudio.mjs');

const LOUDNORM = '\n{\n\t"input_i" : "-16.20",\n\t"input_tp" : "-2.10",\n\t"input_lra" : "4.00",\n\t"input_thresh" : "-26.30",\n\t"target_offset" : "0.20"\n}\n';
const PROBE = JSON.stringify({ format: { duration: '4.000', size: '64000' }, streams: [{ codec_type: 'audio' }] });

/** A run() that records each call and answers like the tool would, by argument shape. */
function recorder({ failSecondPass = false } = {}) {
  const calls = [];
  const run = async (bin, args, options) => {
    calls.push({ tool: basename(bin), args, encoding: options?.encoding });
    if (args.includes('-version')) return { stdout: `${basename(bin)} version fixture`, stderr: '' };
    if (basename(bin) === 'ffprobe') return { stdout: PROBE, stderr: '' };
    if (args.includes('s16le')) return { stdout: Buffer.alloc(4 * 8000, 0x10), stderr: '' };
    if (args.includes('null')) return { stdout: '', stderr: LOUDNORM };
    const output = args.at(-1);
    writeFileSync(output, 'partial mp3 bytes');
    if (failSecondPass) throw Object.assign(new Error('encoder failed'), { stderr: 'boom' });
    return { stdout: '', stderr: LOUDNORM };
  };
  return { run, calls };
}

const KEYS = ['a'.repeat(64), 'b'.repeat(64)];
let n = 0;
const renditionDir = () => {
  const dir = mkdtempSync(join(ROOT, `render-${n += 1}-`));
  mkdirSync(join(dir, 'clips'));
  return dir;
};

test('audioTools runs each tool once, with -version', async () => {
  const { audioTools } = await load();
  const { run, calls } = recorder();
  await audioTools({ run });
  assert.deepEqual(calls.map((c) => [c.tool, c.args]), [['ffmpeg', ['-version']], ['ffprobe', ['-version']]]);
});

test('probeAudio sends one ffprobe call and hashes the file itself', async () => {
  const { probeAudio } = await load();
  const { run, calls } = recorder();
  const file = join(renditionDir(), 'clip.mp3');
  writeFileSync(file, 'clip bytes');
  const asset = await probeAudio(file, { run });
  assert.deepEqual(calls, [{ tool: 'ffprobe', encoding: undefined, args: ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,sample_rate,channels', '-of', 'json', file] }]);
  assert.deepEqual(asset, { duration: 4, bytes: 64000, sha256: createHash('sha256').update('clip bytes').digest('hex') });
});

test('assembleAudio refuses an empty list or a name it did not make, before any tool runs', async () => {
  const { assembleAudio } = await load();
  for (const clips of [[], [{ key: '../../etc/passwd' }], [{ key: 'A'.repeat(64) }], [{ key: `${'a'.repeat(63)}'` }]]) {
    const { run, calls } = recorder();
    await assert.rejects(assembleAudio(renditionDir(), clips, { run }), /Invalid audio assembly manifest/, JSON.stringify(clips));
    assert.equal(calls.length, 0);
  }
});

test('assembleAudio measures, then normalises in a second pass, and renames into place', async () => {
  const { assembleAudio } = await load();
  const { run, calls } = recorder();
  const dir = renditionDir();
  const result = await assembleAudio(dir, KEYS.map((key) => ({ key })), { run });

  const list = join(dir, 'concat.txt');
  assert.equal(readFileSync(list, 'utf8'), KEYS.map((k) => `file 'clips/${k}.mp3'`).join('\n'));
  const input = ['-f', 'concat', '-safe', '1', '-i', list];
  assert.deepEqual(calls[0].args, ['-hide_banner', '-nostdin', ...input, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  assert.deepEqual(calls[1].args, ['-hide_banner', '-nostdin', '-y', ...input, '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-16.20:measured_TP=-2.10:measured_LRA=4.00:measured_thresh=-26.30:offset=0.20:linear=true:print_format=json',
    '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '128k', join(dir, 'candidate.part.mp3')]);
  assert.equal(calls.length, 2);
  assert.equal(existsSync(join(dir, 'candidate.mp3')), true);
  assert.equal(existsSync(join(dir, 'candidate.part.mp3')), false);
  assert.deepEqual({ ...result, measured: undefined }, { version: 1, target_lufs: -16, target_true_peak_db: -1.5, measured: undefined });
  assert.equal(result.measured.input_i, '-16.20');
});

test('a second pass that fails leaves neither a partial nor a candidate file', async () => {
  const { assembleAudio } = await load();
  const { run } = recorder({ failSecondPass: true });
  const dir = renditionDir();
  await assert.rejects(assembleAudio(dir, KEYS.map((key) => ({ key })), { run }), /encoder failed/);
  assert.equal(existsSync(join(dir, 'candidate.part.mp3')), false);
  assert.equal(existsSync(join(dir, 'candidate.mp3')), false);
});

test('checkAudio probes, decodes to 4 kHz mono PCM, measures, and judges', async () => {
  const { checkAudio } = await load();
  const { run, calls } = recorder();
  const file = join(renditionDir(), 'candidate.mp3');
  writeFileSync(file, 'assembled bytes');
  const report = await checkAudio(file, { expectedDuration: 4, wordCount: 10, run });
  assert.deepEqual(calls.map((c) => c.tool), ['ffprobe', 'ffmpeg', 'ffmpeg']);
  assert.deepEqual(calls[1], { tool: 'ffmpeg', encoding: 'buffer', args: ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'] });
  assert.deepEqual(calls[2].args, ['-hide_banner', '-nostdin', '-i', file, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  assert.equal(report.version, 1);
  assert.equal(report.passed, true, report.issues.join('; '));
  assert.equal(report.words_per_minute, 150);
  assert.equal(report.integrated_lufs, -16.2);
  assert.equal(report.true_peak_db, -2.1);
  assert.equal(report.asset.duration, 4);
});

test('checkAudio refuses a file over the 30 minute chapter limit before decoding it', async () => {
  const { checkAudio } = await load();
  const calls = [];
  const run = async (bin, args) => {
    calls.push(basename(bin));
    return { stdout: JSON.stringify({ format: { duration: '1800.5', size: '1' }, streams: [{ codec_type: 'audio' }] }), stderr: '' };
  };
  const file = join(renditionDir(), 'long.mp3');
  writeFileSync(file, 'x');
  await assert.rejects(checkAudio(file, { run }), /30 minute chapter limit/);
  assert.deepEqual(calls, ['ffprobe']);
});
