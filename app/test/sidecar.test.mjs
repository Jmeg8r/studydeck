// WHAT: Tests for append idempotency and attempt folding in lib/sidecar.mjs.
// WHY: Two failures this pins down. (1) A response lost after a successful append let a
//      retry record the same attempt twice, skewing every derived total. (2) An attempt
//      whose self-checked items are finalised later must be REVISED without rewriting
//      history — the log keeps both records, and every reader has to see exactly one.
//      Records written before either field existed must survive both rules untouched.
//
// The suite points config.learnRoot at a throwaway tmp fixture — config is a live,
// mutable export read at call time — so the real .learn/ tree is never touched.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import {
  appendAttempt, appendDebrief, appendOperation, appendPracticeEvent, appendReview, appendTeachbackEvent, findAttempt, findDebriefByMutation,
  findOperationByMutation, foldAttempts, hasPracticeAnswerRevealForConcept, hasPracticeReveal, inspectSidecars,
  readAttempts, readAttemptsRaw, readCards, readPracticeEvents, readTeachbackEvents, writeCards,
} from '../lib/sidecar.mjs';

const SLUG = 'sidecar-fixture';
const OTHER_SLUG = 'other-sidecar-fixture';
let fixtureRoot;
let originalLearnRoot;

const cockpit = () => join(fixtureRoot, SLUG, 'cockpit');

beforeEach(() => {
  originalLearnRoot = config.learnRoot;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'sidecar-test-'));
  config.learnRoot = fixtureRoot;
  mkdirSync(cockpit(), { recursive: true });
});

afterEach(() => {
  config.learnRoot = originalLearnRoot;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// ---------- append idempotency ----------

test('a repeated mutation_id appends once and reports the replay', () => {
  const record = { ts: '2026-07-28T10:00:00Z', kind: 'quiz', mutation_id: 'm1', score: 4, max: 7 };

  const first = appendAttempt(SLUG, record);
  const second = appendAttempt(SLUG, { ...record, ts: '2026-07-28T10:00:09Z' });

  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(second.ts, '2026-07-28T10:00:00Z', 'the replay returns the record that landed');
  assert.equal(readAttemptsRaw(SLUG).length, 1);
});

test('reviews dedupe the same way — a double-logged review would corrupt the interval', () => {
  const review = { ts: '2026-07-28T10:00:00Z', mutation_id: 'r1', card_id: 'card-1', result: 'hit' };
  appendReview(SLUG, review);
  const replay = appendReview(SLUG, review);

  assert.equal(replay.duplicate, true);
  assert.equal(readFileSync(join(cockpit(), 'reviews.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('a record with no mutation_id is always appended — dedupe is opt-in, not guessed', () => {
  appendAttempt(SLUG, { ts: '2026-07-28T10:00:00Z', kind: 'quiz', score: 1, max: 2 });
  appendAttempt(SLUG, { ts: '2026-07-28T10:00:00Z', kind: 'quiz', score: 1, max: 2 });
  assert.equal(readAttemptsRaw(SLUG).length, 2);
});

// ---------- folding ----------

test('the highest revision wins, in the position of the original attempt', () => {
  const folded = foldAttempts([
    { attempt_id: 'a', revision: 0, mutation_id: 'm1', score: 4, max: 6, status: 'pending_self_grade' },
    { attempt_id: 'b', revision: 0, mutation_id: 'm2', score: 2, max: 3 },
    { attempt_id: 'a', revision: 1, mutation_id: 'm3', score: 5, max: 7, status: 'final' },
  ]);

  assert.equal(folded.length, 2);
  assert.equal(folded[0].attempt_id, 'a', 'the revision keeps the original chronological slot');
  assert.equal(folded[0].score, 5);
  assert.equal(folded[0].status, 'final');
  assert.equal(folded[1].attempt_id, 'b');
});

test('a duplicate mutation_id already on file is folded away, first write winning', () => {
  const folded = foldAttempts([
    { attempt_id: 'a', revision: 0, mutation_id: 'm1', score: 4 },
    { attempt_id: 'a', revision: 0, mutation_id: 'm1', score: 4 },
  ]);
  assert.equal(folded.length, 1);
});

test('legacy records carrying neither field pass through one-for-one', () => {
  // The shape of the one attempt already checked into this repo.
  const legacy = [
    { ts: '2026-07-18T21:36:15', kind: 'quiz', concept_slug: 'your-first-model', score: 4, max: 7 },
    { ts: '2026-07-19T09:00:00', kind: 'quiz', concept_slug: 'your-first-model', score: 6, max: 7 },
  ];
  assert.deepEqual(foldAttempts(legacy), legacy);
});

test('readAttempts folds while readAttemptsRaw keeps every revision on file', () => {
  appendAttempt(SLUG, { ts: '2026-07-28T10:00:00Z', attempt_id: 'a', revision: 0, mutation_id: 'm1', score: 4, max: 6 });
  appendAttempt(SLUG, { ts: '2026-07-28T10:05:00Z', attempt_id: 'a', revision: 1, mutation_id: 'm2', score: 5, max: 7 });

  assert.equal(readAttemptsRaw(SLUG).length, 2, 'history is append-only — nothing is rewritten');
  assert.equal(readAttempts(SLUG).length, 1, 'readers see one attempt');
  assert.equal(findAttempt(SLUG, 'a').score, 5);
});

// ---------- debrief ledger ----------

test('the debrief ledger is keyed by mutation_id for replay', () => {
  appendDebrief(SLUG, { mutation_id: 'd1', debrief_id: 'uuid-1', card_ids: ['card-debrief-2026-07-28-aaaa1111-1'] });

  assert.equal(findDebriefByMutation(SLUG, 'd1').debrief_id, 'uuid-1');
  assert.equal(findDebriefByMutation(SLUG, 'nope'), null);
  assert.equal(findDebriefByMutation(SLUG, undefined), null);
});

test('practice evidence and answer reveals are topic-scoped, append-only, and replay-safe', () => {
  const reveal = {
    ts: '2026-08-14T10:00:00Z', event_type: 'answer_revealed', concept_slug: 'bounded-concept',
    artifact_file: 'solution.py', mutation_id: 'practice-reveal-1',
  };
  appendPracticeEvent(SLUG, reveal);
  const replay = appendPracticeEvent(SLUG, { ...reveal, ts: '2026-08-14T10:01:00Z' });

  assert.equal(replay.duplicate, true);
  assert.equal(readPracticeEvents(SLUG).length, 1);
  assert.equal(hasPracticeReveal(SLUG, 'bounded-concept', 'solution.py'), true);
  assert.equal(hasPracticeReveal(SLUG, 'bounded-concept', 'README.md'), false);
  assert.equal(hasPracticeAnswerRevealForConcept(SLUG, 'bounded-concept'), true);
  assert.equal(hasPracticeAnswerRevealForConcept(SLUG, 'other-concept'), false);

  const report = inspectSidecars(SLUG);
  assert.ok(report.files.some((file) => file.file === 'practice.jsonl' && file.records === 1));
});

test('teach-back records are topic-scoped, append-only, and replay-safe', () => {
  const record = {
    ts: '2026-08-14T10:00:00Z', event_type: 'teachback_recorded', audience: 'study partner',
    artifact_type: 'notes', artifact_reference: 'lesson-1-notes.md', mutation_id: 'teachback-1',
  };
  appendTeachbackEvent(SLUG, record);
  const replay = appendTeachbackEvent(SLUG, { ...record, ts: '2026-08-14T10:01:00Z' });

  assert.equal(replay.duplicate, true);
  assert.equal(readTeachbackEvents(SLUG).length, 1);
  assert.deepEqual(readTeachbackEvents(OTHER_SLUG), [], 'another topic cannot see this ledger row');
  const report = inspectSidecars(SLUG);
  assert.ok(report.files.some((file) => file.file === 'teachbacks.jsonl' && file.records === 1));
});

test('the operation ledger folds revisions and keeps ambiguous external outcomes visible', () => {
  const prepared = {
    operation_id: 'operation-1', origin_mutation_id: 'm-note', mutation_id: 'm-note:prepared',
    revision: 0, kind: 'mindmap_note', stage: 'prepared', input_hash: 'abc', ts: '2026-08-13T10:00:00Z',
  };
  appendOperation(SLUG, prepared);
  appendOperation(SLUG, {
    ...prepared, mutation_id: 'm-note:ambiguous', revision: 1, stage: 'ambiguous',
    error: { classification: 'open_notebook_note_outcome_unknown' },
  });

  assert.equal(findOperationByMutation(SLUG, 'm-note', 'mindmap_note').stage, 'ambiguous');
  const report = inspectSidecars(SLUG);
  assert.equal(report.operations.records, 2);
  assert.equal(report.operations.distinct, 1);
  assert.equal(report.operations.unresolved, 1, 'health must not hide an external write that cannot safely replay');
});

// ---------- integrity reporting ----------

test('inspectSidecars reports a recovered file, a torn line, and a stale temp file', () => {
  writeCards(SLUG, [{ id: 'card-1' }]);
  writeCards(SLUG, [{ id: 'card-1' }, { id: 'card-2' }]); // now there is a .bak
  writeFileSync(join(cockpit(), 'cards.json'), '[{"id": "card-1"'); // crash mid-write

  writeFileSync(join(cockpit(), 'attempts.jsonl'), '{"ts":"x","kind":"quiz"}\n{"ts":"y"\n');
  writeFileSync(join(cockpit(), '.cards.json.999.dead.tmp'), 'partial');

  const report = inspectSidecars(SLUG);

  assert.deepEqual(report.degraded, ['cards.json']);
  assert.equal(report.unparseable_lines, 1);
  assert.deepEqual(report.stale_temp_files, ['.cards.json.999.dead.tmp']);
  assert.equal(report.attempts.records, 1, 'the torn line is not counted as a record');
  // And the cockpit still works off the backup rather than reporting an empty deck.
  // Note what recovery actually buys: the last known-good copy is ONE WRITE BEHIND, so
  // the card added by the write that crashed is gone. That is the honest guarantee —
  // no silent data blanking, not zero data loss.
  assert.equal(readCards(SLUG).length, 1);
});

test('inspectSidecars reports a missing sidecar beside an unusable backup as degraded', () => {
  writeFileSync(join(cockpit(), 'cards.json.bak'), '{');

  const report = inspectSidecars(SLUG);

  assert.deepEqual(report.degraded, ['cards.json']);
  const cards = report.files.find((f) => f.file === 'cards.json');
  assert.equal(cards.source, 'fallback');
  assert.match(cards.error, /^primary missing; backup unusable:/);
});

test('inspectSidecars reports sidecars it cannot reach as degraded, not absent',
  { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, () => {
    writeCards(SLUG, [{ id: 'card-1' }]);
    chmodSync(cockpit(), 0o000);
    let report;
    try {
      report = inspectSidecars(SLUG);
    } finally {
      chmodSync(cockpit(), 0o700);
    }
    // EACCES can't tell a present file from an absent one, so every JSON sidecar is
    // unverifiable; "can't verify" is damage (spec concern 2).
    assert.ok(report.degraded.includes('cards.json'), `degraded was ${JSON.stringify(report.degraded)}`);
    assert.match(report.files.find((f) => f.file === 'cards.json').error, /EACCES/);
  });

test('inspectSidecars on an untouched topic reports nothing degraded', () => {
  const report = inspectSidecars(SLUG);
  assert.deepEqual(report.degraded, []);
  assert.equal(report.unparseable_lines, 0);
  assert.deepEqual(report.stale_temp_files, []);
  assert.equal(report.attempts.records, 0);
});

// ---------- JSONL damage (docs/changes/2026-11-12-jsonl-damage) ----------
// Only ENOENT means a JSONL sidecar was never written. Any other read error is damage: the
// readers throw a 500 naming the file and its code (never an absolute path, spec concern 3),
// /api/health lists it as degraded, and an append never runs without reading history first.

const SHORT_EISDIR = 'attempts.jsonl is unreadable (EISDIR)';
const plantDirectoryAt = (name) => mkdirSync(join(cockpit(), name));

test('a directory at attempts.jsonl throws a 500 naming the file, not the raw I/O error', () => {
  plantDirectoryAt('attempts.jsonl');
  assert.throws(() => readAttempts(SLUG), (err) => {
    assert.equal(err.message, SHORT_EISDIR);
    assert.equal(err.status, 500);
    assert.equal(err.code, 'EISDIR');
    assert.equal(err.file, 'attempts.jsonl');
    return true;
  });
});

test('inspectSidecars lists an unreadable JSONL sidecar as degraded instead of throwing', () => {
  plantDirectoryAt('attempts.jsonl');
  const report = inspectSidecars(SLUG);
  assert.deepEqual(report.degraded, ['attempts.jsonl']);
  const entry = report.files.find((f) => f.file === 'attempts.jsonl');
  assert.equal(entry.source, 'fallback');
  assert.equal(entry.code, 'EISDIR');
  assert.equal(entry.error, SHORT_EISDIR);
  assert.equal(report.attempts.records, 0);
});

test('an append whose replay read hits damage writes nothing (rule 9)', () => {
  plantDirectoryAt('attempts.jsonl');
  assert.throws(() => appendAttempt(SLUG, { ts: '2026-11-12T10:00:00Z', mutation_id: 'm-damaged', score: 1, max: 1 }),
    (err) => err.code === 'EISDIR');
  assert.deepEqual(readdirSync(join(cockpit(), 'attempts.jsonl')), [], 'nothing landed at the damaged path');
});

test('an unsearchable cockpit directory is damage, not an empty history',
  { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, () => {
    appendAttempt(SLUG, { ts: '2026-11-12T10:00:00Z', mutation_id: 'm-before', score: 1, max: 1 });
    chmodSync(cockpit(), 0o000);
    let thrown;
    let report;
    try {
      try { readAttempts(SLUG); } catch (err) { thrown = err; }
      report = inspectSidecars(SLUG);
    } finally {
      chmodSync(cockpit(), 0o700);
    }
    assert.equal(thrown?.message, 'attempts.jsonl is unreadable (EACCES)');
    assert.ok(report.degraded.includes('attempts.jsonl'), `degraded was ${JSON.stringify(report.degraded)}`);
  });

test('a JSONL sidecar that was never written still reads as empty and is not listed', () => {
  assert.deepEqual(readAttempts(SLUG), []);
  assert.equal(inspectSidecars(SLUG).files.some((f) => f.file === 'attempts.jsonl'), false);
});
