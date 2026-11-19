// WHAT: The exit codes and wording of `npm run recover`.
// WHY:  The exit code is the interface a habit or a script acts on, so it follows verify's
//       contract: 0 nothing to do, 1 damage found or a restore refused, 2 the command could
//       not complete (backup-restore spec, concern 4). The wording is what James reads while
//       something is already wrong, so each line says what happened, why, and what to run.
//       Spawned as a real process: the CLI sets process.exitCode, and an exit code cannot
//       be observed any other way.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';

const RECOVER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'recover.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'recover-cli-'));
const TOPIC = config.topics[0].slug;
const DIR = join(ROOT, TOPIC);

after(() => rmSync(ROOT, { recursive: true, force: true }));

const STATE = {
  version: 1, slug: TOPIC, topic: 'Recover CLI Fixture', created: '2026-11-11', last_updated: null,
  domains: [{
    slug: 'fixture-domain', name: 'Fixture Domain',
    concepts: [{
      name: 'Fixture Concept', slug: 'cli-fixture-concept', status: 'unexplored', confidence: 0.1,
      practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null, details: ['a detail'],
    }],
  }],
};
const CARDS = [{ id: 'c1', front: 'Q', back: 'A', created: '2026-11-11' }];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function seed(files) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'cockpit'), { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    if (contents === null) mkdirSync(join(DIR, path), { recursive: true });
    else writeFileSync(join(DIR, path), contents);
  }
}

/** Resolves with the exit code rather than rejecting: a non-zero code is the subject here. */
function recover(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RECOVER, ...args], { env: { ...process.env, STUDYDECK_LEARN_ROOT: ROOT } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
  });
}

test('report: 0 when nothing is damaged', async () => {
  seed({ 'state.json': json(STATE), 'cockpit/cards.json': json(CARDS) });
  const { code, out } = await recover('--topic', TOPIC);
  assert.equal(code, 0, out);
  assert.match(out, /state\.json: intact\./);
  assert.match(out, /Nothing is damaged\./);
});

test('report: 1 with the exact restore command when a file is damaged', async () => {
  seed({ 'state.json': '{', 'state.json.bak': json(STATE) });
  const { code, out } = await recover('--topic', TOPIC);
  assert.equal(code, 1, out);
  assert.match(out, /state\.json: damaged \(doesn't parse\)\. Its backup is valid\. Restore it with: npm run recover -- --topic \S+ --file state\.json --restore-backup/);
});

test('report: a damaged file with no usable backup points at git', async () => {
  seed({ 'state.json': '{' });
  const { code, out } = await recover('--topic', TOPIC);
  assert.equal(code, 1, out);
  assert.match(out, /state\.json: damaged \(doesn't parse\)\. It has no backup, so it can't be restored from here\. Restore it from git instead\./);
});

test('report: 2 when the check itself cannot complete', async () => {
  seed({ 'state.json': null });
  const { code, out } = await recover('--topic', TOPIC);
  assert.equal(code, 2, out);
  assert.match(out, /Couldn't check/);
});

test('an unknown or missing topic is a usage error, exit 2', async () => {
  for (const args of [[], ['--topic', 'no-such-topic']]) {
    const { code, out } = await recover(...args);
    assert.equal(code, 2, out);
    assert.match(out, /--topic must name a configured topic/);
  }
});

test('restore: 0, the archive and the map, in words', async () => {
  seed({ 'state.json': '{', 'state.json.bak': json(STATE) });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup');
  assert.equal(code, 0, out);
  assert.match(out, /Restored state\.json from its backup\. The damaged copy is kept at \S+state\.json\.damaged-\S+\. The knowledge map was regenerated\./);
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), json(STATE));
});

test('restore: 1 and nothing changed when refused, with the way forward', async () => {
  seed({ 'state.json': json({ ...STATE, last_updated: '2026-11-11' }), 'state.json.bak': json(STATE) });
  let { code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup');
  assert.equal(code, 1, out);
  assert.match(out, /state\.json is intact and newer than its backup\. Restoring would replace it with an older copy\. Nothing was changed\. Add --force to restore anyway\./);

  seed({ 'state.json': '{', 'state.json.bak': '{}\n' });
  ({ code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup'));
  assert.equal(code, 1, out);
  assert.match(out, /state\.json\.bak: .*Nothing was changed\. Restore it from git instead\./);
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), '{');
  assert.deepEqual(readdirSync(DIR).filter((n) => n.includes('.damaged-')), []);
});

test('restore: a sidecar restore asks for an idle cockpit before it writes', async () => {
  seed({ 'cockpit/cards.json': '[{', 'cockpit/cards.json.bak': json(CARDS) });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'cards.json', '--restore-backup');
  assert.equal(code, 0, out);
  const idle = out.indexOf('Leave the cockpit idle');
  assert.ok(idle >= 0 && idle < out.indexOf('Restored cards.json'), out);
});

test('restore: --file without --restore-backup changes nothing and says how to restore', async () => {
  seed({ 'state.json': '{', 'state.json.bak': json(STATE) });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'state.json');
  assert.equal(code, 1, out);
  assert.match(out, /Add --restore-backup/);
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), '{');
});

test('every refusal reads as sentences, and only a restorable sidecar gets the idle line', async () => {
  // A validator's reason must end as a sentence before "Nothing was changed", and the idle
  // line belongs only before a restore that will write.
  seed({ 'state.json': '{', 'state.json.bak': '{}\n' });
  let { out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup');
  assert.doesNotMatch(out, /[^.] Nothing was changed/, out);

  seed({ 'state.json': json(STATE) });
  ({ out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup'));
  assert.match(out, /state\.json is intact\. There is nothing to restore\. Nothing was changed\./);
  assert.doesNotMatch(out, /git|--force/, 'an intact file with no backup needs no way forward');

  for (const file of ['attempts.jsonl', '../x']) {
    ({ out } = await recover('--topic', TOPIC, '--file', file, '--restore-backup'));
    assert.doesNotMatch(out, /Leave the cockpit idle/, file);
  }
});

test('report: a missing state.json is damage, with the way back', async () => {
  seed({});
  let { code, out } = await recover('--topic', TOPIC);
  assert.equal(code, 1, out);
  assert.match(out, /state\.json: missing\. The topic can't load without it\. It has no backup, so it can't be restored from here\. Restore it from git instead\./);
  seed({ 'state.json.bak': json(STATE) });
  ({ code, out } = await recover('--topic', TOPIC));
  assert.equal(code, 1, out);
  assert.match(out, /state\.json: missing\. The topic can't load without it\. Its backup is valid\. Restore it with:/);
  assert.doesNotMatch(out, /reading its backup/, 'the cockpit never reads state.json.bak');
});

test('restore: --force over an intact file with no usable backup never points at git', async () => {
  seed({ 'state.json': json(STATE) });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup', '--force');
  assert.equal(code, 1, out);
  assert.doesNotMatch(out, /git/, out);
});

test('restore: no idle line before a sidecar that cannot be restored', async () => {
  seed({ 'state.json': json(STATE) });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'cards.json', '--restore-backup');
  assert.equal(code, 1, out);
  assert.doesNotMatch(out, /Leave the cockpit idle/, out);
});

test('restore: a backup that cannot be placed in the attempt log says so', async () => {
  const applied = JSON.stringify({
    attempt_id: 'old', mutation_id: 'm-old', revision: 1, kind: 'quiz', status: 'final', ts: '2026-11-01T09:00:00.000Z',
    concept_slug: 'cli-fixture-concept', score: 2, max: 2, mastery_applied: true,
  });
  seed({ 'state.json': '{', 'state.json.bak': json(STATE), 'cockpit/attempts.jsonl': `${applied}\n` });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup');
  assert.equal(code, 0, out);
  assert.match(out, /This backup doesn't match any recorded mastery update, so it can't tell which attempts it leaves out\./);
});

test('a failure while the modules load is exit 2, not 1', async () => {
  // Config refuses one tailnet variable without the other, at import time. Exit 1 would
  // read as "damage found or refused" for a command that never looked.
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [RECOVER, '--topic', TOPIC],
      { env: { ...process.env, STUDYDECK_LEARN_ROOT: ROOT, STUDYDECK_TAILSCALE_ORIGIN: 'https://example.ts.net', STUDYDECK_TAILSCALE_USER: '' } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, text: `${stdout}${stderr}` }));
  });
  assert.equal(out.code, 2, out.text);
});

test('restore: the already-matches rerun still prints drift', async () => {
  const applied = JSON.stringify({
    attempt_id: 'old', mutation_id: 'm-old', revision: 1, kind: 'quiz', status: 'final', ts: '2026-11-01T09:00:00.000Z',
    concept_slug: 'cli-fixture-concept', score: 2, max: 2, mastery_applied: true,
  });
  seed({ 'state.json': json(STATE), 'state.json.bak': json(STATE), 'cockpit/attempts.jsonl': `${applied}\n` });
  const { code, out } = await recover('--topic', TOPIC, '--file', 'state.json', '--restore-backup');
  assert.equal(code, 0, out);
  assert.match(out, /already matches its backup/);
  assert.match(out, /This backup doesn't match any recorded mastery update/, 'the unplaced warning is not skipped either');
});
