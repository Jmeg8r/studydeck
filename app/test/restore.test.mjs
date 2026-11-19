// WHAT: What `npm run recover` reports, and what a restore does and refuses to do.
// WHY:  A restore overwrites learning data with an older copy (backup-restore spec). Every
//       refusal has to leave the tree byte-identical, every replaced primary has to survive
//       as an archive, and the report has to write nothing at all. Each test builds its own
//       topic under a fixture learn root and compares checksums of the whole tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-restore-'));
// Before config.mjs loads: it resolves the learn root once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { config } = await import('../lib/config.mjs');
const TOPIC = config.topics[0].slug;
const DIR = join(FIXTURE_ROOT, TOPIC);
const COCKPIT = join(DIR, 'cockpit');

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

const STATE = {
  version: 1, slug: TOPIC, topic: 'Restore Fixture', created: '2026-11-11', last_updated: null,
  domains: [{
    slug: 'fixture-domain', name: 'Fixture Domain',
    concepts: [{
      name: 'Fixture Concept', slug: 'restore-fixture-concept', status: 'unexplored', confidence: 0.1,
      practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null, details: ['a detail'],
    }],
  }],
};
const CARDS = [{ id: 'c1', front: 'Q', back: 'A', created: '2026-11-11' }];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A fresh topic directory holding exactly `files` (path relative to the topic → contents). */
function seed(files) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(COCKPIT, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(DIR, path)), { recursive: true });
    writeFileSync(join(DIR, path), contents);
  }
}

/** path → sha256 for every file under the topic, so "nothing changed" is one assertion. */
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(DIR, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(DIR);
  return out;
}

const row = (rows, file) => rows.find((r) => r.file === file);

test('the report names each file\'s primary and backup, and writes nothing', async () => {
  const { inspectRestorable } = await import('../lib/restore.mjs');
  seed({
    'state.json': '{',
    'state.json.bak': json(STATE),
    'cockpit/cards.json': json(CARDS),
    'cockpit/cards.json.bak': json(CARDS),
    'cockpit/schedule.json': json({ started: '2026-11-01' }),
    'cockpit/schedule.json.bak': '{',
    'cockpit/reading.json.bak': json({}),
    'cockpit/attempts.jsonl': '{"attempt_id":"a1"}\n',
  });
  const before = snapshot();

  const rows = inspectRestorable(TOPIC);

  const { JSON_SIDECARS } = await import('../lib/sidecar.mjs');
  assert.deepEqual(rows.map((r) => r.file), ['state.json', ...JSON_SIDECARS]);
  assert.deepEqual(
    { primary: row(rows, 'state.json').primary, backup: row(rows, 'state.json').backup, damaged: row(rows, 'state.json').damaged, restorable: row(rows, 'state.json').restorable },
    { primary: 'damaged', backup: 'valid', damaged: true, restorable: true });
  assert.deepEqual(
    { primary: row(rows, 'cards.json').primary, backup: row(rows, 'cards.json').backup, damaged: row(rows, 'cards.json').damaged },
    { primary: 'intact', backup: 'valid', damaged: false });
  assert.deepEqual(
    { primary: row(rows, 'schedule.json').primary, backup: row(rows, 'schedule.json').backup, damaged: row(rows, 'schedule.json').damaged, restorable: row(rows, 'schedule.json').restorable },
    { primary: 'invalid', backup: 'unparseable', damaged: true, restorable: false });
  assert.deepEqual(
    { primary: row(rows, 'reading.json').primary, backup: row(rows, 'reading.json').backup, damaged: row(rows, 'reading.json').damaged },
    { primary: 'missing', backup: 'valid', damaged: true },
    'a missing primary with a backup beside it is what the cockpit is reading from');
  assert.deepEqual(
    { primary: row(rows, 'factchecks.json').primary, backup: row(rows, 'factchecks.json').backup, damaged: row(rows, 'factchecks.json').damaged },
    { primary: 'missing', backup: 'missing', damaged: false },
    'a file that was never written is not damage');
  assert.match(row(rows, 'schedule.json').reason, /schedule version/, 'an invalid primary says why');
  assert.deepEqual(snapshot(), before, 'the report wrote nothing');
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archivesOf = (file) => readdirSync(file === 'state.json' ? DIR : COCKPIT).filter((n) => n.startsWith(`${file}.damaged-`));

test('a damaged state.json is restored from its backup, archived first, and its map regenerated', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  seed({
    'state.json': '{',
    'state.json.bak': json(STATE),
    'knowledge-map.md': 'stale map\n',
    'cockpit/attempts.jsonl': '{"attempt_id":"a1"}\n',
    'cockpit/reviews.jsonl': '{"card_id":"c1","result":"hit"}\n',
  });
  const before = snapshot();

  const result = await restoreBackup(TOPIC, 'state.json');

  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), json(STATE), 'the primary is the backup, byte for byte');
  assert.equal(readFileSync(join(DIR, 'state.json.bak'), 'utf8'), json(STATE), 'the backup is left in place');
  const [archive] = archivesOf('state.json');
  assert.match(archive, /^state\.json\.damaged-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(readFileSync(join(DIR, archive), 'utf8'), '{', 'the damaged bytes survive');
  assert.equal(result.archived_primary, join(DIR, archive));
  assert.match(readFileSync(join(DIR, 'knowledge-map.md'), 'utf8'), /Restore Fixture/);
  assert.equal(result.map_regenerated, true);
  for (const log of ['cockpit/attempts.jsonl', 'cockpit/reviews.jsonl']) assert.equal(snapshot()[log], before[log], log);
});

test('a backup that is invalid, unparseable, missing or unrenderable changes nothing', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const failingRender = join(FIXTURE_ROOT, 'fail-render.mjs');
  writeFileSync(failingRender, 'process.stderr.write("render refused"); process.exit(1);\n');
  const cases = [
    ['invalid', { 'state.json.bak': '{}\n' }, {}, /state\.json\.bak: /],
    ['unparseable', { 'state.json.bak': '{' }, {}, /state\.json\.bak doesn't parse/],
    ['missing', {}, {}, /state\.json\.bak doesn't exist/],
    ['unrenderable', { 'state.json.bak': json(STATE) }, { renderOptions: { script: failingRender } }, /render refused/],
  ];
  for (const [label, files, options, reason] of cases) {
    seed({ 'state.json': '{', 'knowledge-map.md': 'old map\n', ...files });
    const before = snapshot();
    await assert.rejects(restoreBackup(TOPIC, 'state.json', options), (err) => {
      assert.equal(err.refused, true, `${label} is a refusal, not a failure`);
      assert.match(err.message, reason, label);
      return true;
    });
    assert.deepEqual(snapshot(), before, `${label}: every live file is unchanged`);
  }
});

test('an intact state.json is not replaced by its older backup unless forced', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const newer = json({ ...STATE, last_updated: '2026-11-11' });
  seed({ 'state.json': newer, 'state.json.bak': json(STATE) });
  const before = snapshot();

  await assert.rejects(restoreBackup(TOPIC, 'state.json'), (err) => {
    assert.equal(err.refused, true);
    assert.match(err.message, /intact and newer than its backup/);
    return true;
  });
  assert.deepEqual(snapshot(), before);

  await restoreBackup(TOPIC, 'state.json', { force: true });
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), json(STATE));
  assert.equal(readFileSync(join(DIR, 'state.json.bak'), 'utf8'), json(STATE), 'forcing never copies the primary over the backup');
  assert.equal(readFileSync(join(DIR, archivesOf('state.json')[0]), 'utf8'), newer, 'the intact primary is archived, not lost');
});

test('drift names the attempt a restore undoes, even when no settlement wrote the backup', async () => {
  // The panel's critical case: state.json last written outside the cockpit (/learn:quiz, topic
  // setup), then one real cockpit settlement. The .bak is the outside write; the restore
  // undoes that settlement. A ts rule never fires here, because the .bak is stamped at the
  // publish, after the attempt's own ts. Driven through the real settleMastery path.
  const { restoreBackup } = await import('../lib/restore.mjs');
  const { appendAttempt, readAttemptsRaw } = await import('../lib/sidecar.mjs');
  const { settleMastery } = await import('../lib/settlement.mjs');
  const { applyAttemptToState } = await import('../lib/mastery.mjs');
  seed({ 'state.json': json(STATE) });
  const attempt = {
    attempt_id: 'cockpit-1', mutation_id: 'm-cockpit-1', revision: 0, kind: 'quiz', status: 'final',
    ts: new Date().toISOString(), concept_slug: 'restore-fixture-concept', score: 2, max: 2, mastery_applied: false,
  };
  appendAttempt(TOPIC, attempt);
  await settleMastery(TOPIC, attempt, null, applyAttemptToState);
  assert.equal(readFileSync(join(DIR, 'state.json.bak'), 'utf8'), json(STATE), 'the control: the backup is the outside write');
  writeFileSync(join(DIR, 'state.json'), '{');
  const history = readFileSync(join(COCKPIT, 'attempts.jsonl'), 'utf8');

  const result = await restoreBackup(TOPIC, 'state.json');

  assert.deepEqual(result.drift.map((d) => d.attempt_id), ['cockpit-1']);
  assert.equal(result.drift_unplaced, false);
  assert.equal(readFileSync(join(COCKPIT, 'attempts.jsonl'), 'utf8'), history, 'drift is reported, never acted on');
  assert.ok(readAttemptsRaw(TOPIC).some((r) => r.mastery_settlement?.replaced_digest), 'the settlement recorded what it replaced');
});

test('drift counts every attempt applied after the one that replaced the backup, and none before', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const backup = json(STATE);
  const row = (id, stage, applied, replaced) => JSON.stringify({
    attempt_id: id, mutation_id: `m-${id}-${stage}`, revision: 1, kind: 'quiz', status: 'final',
    ts: '2026-11-01T09:00:00.000Z', concept_slug: 'restore-fixture-concept', score: 2, max: 2,
    mastery_applied: applied, mastery_settlement: { stage, replaced_digest: replaced },
  });
  const attempts = [
    row('earlier', 'applied', true, 'older-bytes'), // replaced something before the backup existed
    row('replaced-it', 'prepared', false, sha256(backup)),
    row('replaced-it', 'applied', true, sha256(backup)), // published over the backup's bytes
    row('later', 'applied', true, 'newer-bytes'),
  ].join('\n') + '\n';
  seed({ 'state.json': '{', 'state.json.bak': backup, 'cockpit/attempts.jsonl': attempts });

  const result = await restoreBackup(TOPIC, 'state.json');

  assert.deepEqual(result.drift.map((d) => d.attempt_id), ['replaced-it', 'later']);
});

test('a backup no settlement replaced is said to be unplaced, not reported as clean', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const applied = JSON.stringify({
    attempt_id: 'old', mutation_id: 'm-old', revision: 1, kind: 'quiz', status: 'final', ts: '2026-11-01T09:00:00.000Z',
    concept_slug: 'restore-fixture-concept', score: 2, max: 2, mastery_applied: true,
    mastery_settlement: { stage: 'applied', state_digest: 'x' },
  });
  seed({ 'state.json': '{', 'state.json.bak': json(STATE), 'cockpit/attempts.jsonl': `${applied}\n` });

  const result = await restoreBackup(TOPIC, 'state.json');

  assert.deepEqual(result.drift, []);
  assert.equal(result.drift_unplaced, true, 'an empty list would read as "nothing was lost"');
});

test('a restore waits for the topic lock', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const { withTopicLock } = await import('../lib/lock.mjs');
  seed({ 'state.json': '{', 'state.json.bak': json(STATE) });
  let release;
  const held = withTopicLock(TOPIC, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));

  let done = false;
  const restoring = restoreBackup(TOPIC, 'state.json').then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, 'still waiting while another mutation holds the topic');
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), '{', 'and nothing was written yet');

  release();
  await held;
  await restoring;
  assert.equal(done, true);
});

test('a damaged sidecar is restored from its backup, and health stops reporting it', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const { inspectSidecars } = await import('../lib/sidecar.mjs');
  seed({ 'cockpit/cards.json': '[{', 'cockpit/cards.json.bak': json(CARDS) });
  assert.deepEqual(inspectSidecars(TOPIC).degraded, ['cards.json'], 'the control: health sees the damage first');

  const result = await restoreBackup(TOPIC, 'cards.json');

  assert.equal(readFileSync(join(COCKPIT, 'cards.json'), 'utf8'), json(CARDS));
  assert.equal(readFileSync(join(COCKPIT, archivesOf('cards.json')[0]), 'utf8'), '[{');
  assert.equal(result.map_regenerated, false, 'a sidecar has no map to render');
  assert.deepEqual(result.drift, [], 'and no mastery to drift');
  assert.deepEqual(inspectSidecars(TOPIC).degraded, []);
});

test('history files and path-shaped names are refused before anything is read', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  seed({ 'state.json': '{', 'state.json.bak': json(STATE), 'cockpit/attempts.jsonl': '{"attempt_id":"a1"}\n' });
  const before = snapshot();
  for (const file of ['attempts.jsonl', '../state.json', 'cockpit/cards.json', '']) {
    await assert.rejects(restoreBackup(TOPIC, file), (err) => {
      assert.equal(err.refused, true, file);
      assert.match(err.message, /can't be restored\. Only state\.json, /, file);
      return true;
    });
  }
  assert.deepEqual(snapshot(), before);
});

test('an intact state.json with no backup says there is nothing to restore, not to use git', async () => {
  // Checking the backup first would send an intact file to git, which means replacing a
  // good file.
  const { restoreBackup } = await import('../lib/restore.mjs');
  seed({ 'state.json': json(STATE) });
  const before = snapshot();
  await assert.rejects(restoreBackup(TOPIC, 'state.json'), (err) => {
    assert.equal(err.refused, true);
    assert.match(err.message, /^state\.json is intact\. There is nothing to restore\.$/);
    return true;
  });
  assert.deepEqual(snapshot(), before);
});

test('a missing state.json is damage whether or not it has a backup', async () => {
  // A configured topic cannot load without state.json, so "not written yet" was the report
  // calling the worst outage healthy (panel: correctness and evidence seats).
  const { inspectRestorable } = await import('../lib/restore.mjs');
  seed({});
  let state = inspectRestorable(TOPIC).find((r) => r.file === 'state.json');
  assert.deepEqual({ primary: state.primary, backup: state.backup, damaged: state.damaged, restorable: state.restorable },
    { primary: 'missing', backup: 'missing', damaged: true, restorable: false });
  seed({ 'state.json.bak': json(STATE) });
  state = inspectRestorable(TOPIC).find((r) => r.file === 'state.json');
  assert.equal(state.damaged, true);
  assert.equal(state.restorable, true);
  const cards = inspectRestorable(TOPIC).find((r) => r.file === 'cards.json');
  assert.equal(cards.damaged, false, 'a sidecar never written is still not damage');
});

test('every refusal carries a code, and whether the primary was intact', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  const cases = [
    ['not_restorable', false, { 'state.json': json(STATE) }, 'attempts.jsonl', {}],
    ['intact', true, { 'state.json': json(STATE) }, 'state.json', {}],
    ['intact_newer', true, { 'state.json': json({ ...STATE, last_updated: '2026-11-11' }), 'state.json.bak': json(STATE) }, 'state.json', {}],
    ['backup_unusable', false, { 'state.json': '{', 'state.json.bak': '{}\n' }, 'state.json', {}],
    ['backup_unusable', true, { 'state.json': json(STATE) }, 'state.json', { force: true }],
    ['already_matches', true, { 'cockpit/cards.json': json(CARDS), 'cockpit/cards.json.bak': json(CARDS) }, 'cards.json', { force: true }],
  ];
  for (const [code, primaryIntact, files, file, options] of cases) {
    seed(files);
    const before = snapshot();
    await assert.rejects(restoreBackup(TOPIC, file, options), (err) => {
      assert.equal(err.refused, true, code);
      assert.equal(err.code, code, `${code}: ${err.message}`);
      assert.equal(err.primary_intact, primaryIntact, code);
      return true;
    });
    assert.deepEqual(snapshot(), before, code);
  }
});

test('when the map write fails after state.json is restored, the error says so, and a rerun finishes the map', async () => {
  const { restoreBackup } = await import('../lib/restore.mjs');
  seed({ 'state.json': '{', 'state.json.bak': json(STATE), 'knowledge-map.md/keep': 'a directory, so the rename fails\n' });

  await assert.rejects(restoreBackup(TOPIC, 'state.json'), (err) => {
    assert.notEqual(err.refused, true, 'this is a failure to complete, not a refusal');
    assert.match(err.message, /state\.json was restored, but knowledge-map\.md was not written/);
    assert.match(err.message, /Run the same restore again/);
    return true;
  });
  assert.equal(readFileSync(join(DIR, 'state.json'), 'utf8'), json(STATE));

  rmSync(join(DIR, 'knowledge-map.md'), { recursive: true, force: true });
  const archives = archivesOf('state.json').length;
  const result = await restoreBackup(TOPIC, 'state.json');
  assert.equal(result.already_matched, true);
  assert.equal(result.map_regenerated, true);
  assert.equal(result.archived_primary, null, 'an identical primary is not archived again');
  assert.equal(archivesOf('state.json').length, archives);
  assert.match(readFileSync(join(DIR, 'knowledge-map.md'), 'utf8'), /Restore Fixture/);
});

test('a rerun after a failed map write still reports the drift the first run never got to print', async () => {
  // Codex run 1: the rerun takes the already-matches path, which returned no drift, so the
  // lost mastery was never reported to anyone.
  const { restoreBackup } = await import('../lib/restore.mjs');
  const { appendAttempt } = await import('../lib/sidecar.mjs');
  const { settleMastery } = await import('../lib/settlement.mjs');
  const { applyAttemptToState } = await import('../lib/mastery.mjs');
  seed({ 'state.json': json(STATE) });
  const attempt = {
    attempt_id: 'rerun-1', mutation_id: 'm-rerun-1', revision: 0, kind: 'quiz', status: 'final',
    ts: new Date().toISOString(), concept_slug: 'restore-fixture-concept', score: 2, max: 2, mastery_applied: false,
  };
  appendAttempt(TOPIC, attempt);
  await settleMastery(TOPIC, attempt, null, applyAttemptToState);
  writeFileSync(join(DIR, 'state.json'), '{');
  rmSync(join(DIR, 'knowledge-map.md'), { force: true });
  mkdirSync(join(DIR, 'knowledge-map.md', 'keep'), { recursive: true });
  await assert.rejects(restoreBackup(TOPIC, 'state.json'), /knowledge-map\.md was not written/);
  rmSync(join(DIR, 'knowledge-map.md'), { recursive: true, force: true });

  const result = await restoreBackup(TOPIC, 'state.json');

  assert.equal(result.already_matched, true);
  assert.deepEqual(result.drift.map((d) => d.attempt_id), ['rerun-1']);
});
