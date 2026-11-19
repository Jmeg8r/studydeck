// WHAT: Tests for the commit-before-reveal attempt lifecycle (assessment finding F3).
// WHY: Grading used to be a write-free dry run that revealed every answer, after which
//      the results screen offered "Record attempt" or "Discard". A learner could reveal a
//      failed pretest, discard it, and retake it knowing the answers — leaving the
//      append-only history incomplete and the pretest baseline worthless.
//
//      The attempt is now written before anything is revealed, and self-checked (ai_only)
//      items are finalised as a REVISION of that same attempt. The property this file
//      exists to pin is that a revision never double-counts: history keeps both records,
//      every reader sees one, and mastery moves exactly once.
//
// These test the storage-and-grading seam the routes are built from. The routes that sit
// on top of it are covered separately, over real HTTP, in routes.test.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { gradeDeck } from '../lib/grading.mjs';
import { appendAttempt, findAttempt, inspectSidecars, readAttempts, readAttemptsRaw } from '../lib/sidecar.mjs';

const SLUG = 'attempts-fixture';
let fixtureRoot;
let originalLearnRoot;

const DECK = {
  concept_slug: 'your-first-model',
  questions: [
    { id: 'q1', type: 'short_answer', gradeable: 'exact', prompt: 'What is overfitting?', answer: 'overfitting' },
    { id: 'q2', type: 'true_false', gradeable: 'exact', prompt: 'Validation data trains the model.', answer: false },
    { id: 'q3', type: 'error_correction', gradeable: 'ai_only', prompt: 'Spot the error.', answer: 'The body is frozen, not the head.' },
  ],
};

/**
 * What the route does: grade, stamp, append, and derive the reveal.
 *
 * Mirrors handleAttempts including its duplicate branch, so `results` here is what the
 * client would actually receive. Asserting on a locally recomputed value instead would
 * pass even if the route revealed a grading of the retried payload.
 */
function submit(responses, { mutation = 'm-submit', attemptId = 'att-1' } = {}) {
  const graded = gradeDeck(DECK, responses);
  const pending = graded.pending.length > 0;
  const attempt = appendAttempt(SLUG, {
    ts: '2026-07-28T10:00:00Z',
    kind: 'quiz',
    attempt_id: attemptId,
    mutation_id: mutation,
    revision: 0,
    concept_slug: DECK.concept_slug,
    deck_file: 'deck-001.json',
    score: graded.score,
    max: graded.max,
    misses: graded.misses,
    responses,
    status: pending ? 'pending_self_grade' : 'final',
    mastery_applied: false,
    ...(pending ? { pending: graded.pending } : {}),
  });

  // The reveal follows the recorded attempt, never the request that was just rejected
  // as a duplicate.
  const results = attempt.duplicate ? gradeDeck(DECK, attempt.responses ?? {}).results : graded.results;
  return { graded, attempt, results };
}

function finalize(attempt, selfGrades, { mutation = 'm-final' } = {}) {
  const graded = gradeDeck(DECK, attempt.responses ?? {}, selfGrades);
  const stillPending = graded.pending.length > 0;
  const next = {
    ...attempt,
    ts: '2026-07-28T10:05:00Z',
    mutation_id: mutation,
    revision: (Number(attempt.revision) || 0) + 1,
    score: graded.score,
    max: graded.max,
    misses: graded.misses,
    status: stillPending ? 'pending_self_grade' : 'final',
    mastery_applied: false,
    ...(graded.self_graded.length ? { self_graded: graded.self_graded } : {}),
  };
  if (stillPending) next.pending = graded.pending;
  else delete next.pending;
  return { graded, attempt: appendAttempt(SLUG, next) };
}

beforeEach(() => {
  originalLearnRoot = config.learnRoot;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'attempts-test-'));
  config.learnRoot = fixtureRoot;
  mkdirSync(join(fixtureRoot, SLUG, 'cockpit'), { recursive: true });
});

afterEach(() => {
  config.learnRoot = originalLearnRoot;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('submitting records the attempt before any answer is revealed', () => {
  const { attempt, graded } = submit({ q1: 'overfitting', q2: 'false' });

  assert.equal(readAttemptsRaw(SLUG).length, 1, 'the attempt is on disk, not pending a second click');
  assert.equal(attempt.score, 2);
  assert.equal(attempt.max, 2, 'the self-check item is not counted until it is marked');
  // The reveal rides on the same response — there is no way to get one without the other.
  assert.equal(graded.results.length, 3);
  assert.equal(graded.results[0].answer, 'overfitting');
});

test('an attempt with a self-check item waits for finalization before mastery moves', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false' });

  assert.equal(attempt.status, 'pending_self_grade');
  assert.equal(attempt.mastery_applied, false);
  assert.deepEqual(attempt.pending, ['q3']);
});

test('a deck with nothing self-checked is final on submit', () => {
  const graded = gradeDeck({ ...DECK, questions: DECK.questions.slice(0, 2) }, { q1: 'overfitting', q2: 'false' });
  assert.equal(graded.pending.length, 0);
  // Which is what makes status/mastery_applied true at submit time in the route.
  assert.equal(graded.score, 2);
});

test('finalizing appends a revision — history keeps both, readers see one', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false' });
  const { attempt: revised } = finalize(attempt, { q3: true });

  assert.equal(readAttemptsRaw(SLUG).length, 2, 'append-only: the original record is not rewritten');
  assert.equal(readAttempts(SLUG).length, 1, 'stats and cards see exactly one attempt');

  const current = findAttempt(SLUG, 'att-1');
  assert.equal(current.revision, 1);
  assert.equal(current.status, 'final');
  // Still false: the route stamps it true only after applyAttemptToState returns, in a
  // follow-up append. See the partial-commit test below.
  assert.equal(current.mastery_applied, false);
  assert.equal(current.score, 3, 'the self-graded item now counts');
  assert.equal(current.max, 3);
  assert.deepEqual(current.self_graded, ['q3']);
  assert.equal('pending' in current, false, 'the stale pending list does not survive the revision');
  assert.equal(revised.duplicate, undefined);
});

test('a self-graded miss lands in the miss list, so it can be carded', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false' });
  finalize(attempt, { q3: false });

  const current = findAttempt(SLUG, 'att-1');
  assert.deepEqual(current.misses, ['q3']);
  assert.equal(current.score, 2);
  assert.equal(current.max, 3);
});

test('finalization re-grades the STORED responses, not a resubmitted payload', () => {
  const { attempt } = submit({ q1: 'wrong', q2: 'true' });
  finalize(attempt, { q3: true });

  const current = findAttempt(SLUG, 'att-1');
  // Both auto-graded answers were wrong on submit and must stay wrong: the finalize call
  // carries only self-grades, so there is no second chance to change what was answered.
  assert.deepEqual(current.misses, ['q1', 'q2']);
  assert.equal(current.score, 1);
});

test('a replayed finalize records nothing extra', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false' });
  finalize(attempt, { q3: true }, { mutation: 'm-final' });
  const replay = finalize(findAttempt(SLUG, 'att-1'), { q3: true }, { mutation: 'm-final' });

  assert.equal(replay.attempt.duplicate, true);
  assert.equal(readAttemptsRaw(SLUG).length, 2, 'no third record');
  assert.equal(findAttempt(SLUG, 'att-1').revision, 1);
});

test('an abandoned attempt survives as pending, and health says so', () => {
  submit({ q1: 'overfitting', q2: 'false' });

  // The learner closed the tab without marking the self-check item. The auto-graded
  // result is still history — the old flow would have lost it to Discard.
  const report = inspectSidecars(SLUG);
  assert.equal(report.attempts.records, 1);
  assert.equal(report.attempts.pending_self_grade, 1);

  const still = findAttempt(SLUG, 'att-1');
  assert.equal(still.score, 2);
  assert.equal(still.status, 'pending_self_grade');
});

test('a replayed submit reveals the stored attempt, not the retried payload', () => {
  const first = submit({ q1: 'overfitting', q2: 'false' }, { mutation: 'm-submit' });

  // A retry that somehow carried different answers under the same mutation id. The
  // response has to describe the attempt that is actually on disk, or the revealed
  // results contradict the score shown beside them.
  const replay = submit({ q1: 'wrong', q2: 'true' }, { mutation: 'm-submit', attemptId: 'att-2' });
  assert.equal(replay.attempt.duplicate, true);
  assert.equal(replay.attempt.attempt_id, 'att-1');

  assert.deepEqual(replay.results, first.results, 'the replay reveals what was recorded');
  // And is NOT what the retried payload would have graded to — the assertion that fails
  // if the route ever goes back to reusing the current request's grading.
  assert.notDeepEqual(replay.results, replay.graded.results);
  assert.equal(replay.results.find((r) => r.id === 'q1').correct, true);
  assert.equal(replay.graded.results.find((r) => r.id === 'q1').correct, false);
  assert.equal(readAttemptsRaw(SLUG).length, 1);
});

test('mastery_applied is never claimed before the update lands', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false', q3: 'x' }, { mutation: 'm-nopending' });
  // Even with nothing pending, the appended record says false: the route stamps it true
  // only in a follow-up append, after applyAttemptToState actually returns.
  assert.equal(attempt.mastery_applied, false);
});

test('a completed attempt whose mastery failed is visible as a partial commit', () => {
  const { attempt } = submit({ q1: 'overfitting', q2: 'false' });
  finalize(attempt, { q3: true });

  // The finalize landed, its mastery did not (a rejected render, or the topic lock held
  // by another process). Nothing else in the UI would ever say so.
  let report = inspectSidecars(SLUG);
  assert.equal(report.attempts.mastery_unapplied, 1);
  assert.equal(report.attempts.pending_self_grade, 0);

  // What the heal path appends once the retry succeeds: same revision, newer view.
  const current = findAttempt(SLUG, 'att-1');
  appendAttempt(SLUG, { ...current, mutation_id: `${current.mutation_id}:mastery`, mastery_applied: true });

  report = inspectSidecars(SLUG);
  assert.equal(report.attempts.mastery_unapplied, 0);
  assert.equal(report.attempts.distinct, 1, 'the follow-up is the same attempt, not a new one');
  assert.equal(findAttempt(SLUG, 'att-1').score, 3, 'and it keeps the finalised score');
});

test('two separate attempts on one deck both count', () => {
  const first = submit({ q1: 'overfitting', q2: 'false' }, { mutation: 'm1', attemptId: 'att-1' });
  finalize(first.attempt, { q3: true }, { mutation: 'm1-final' });
  submit({ q1: 'wrong', q2: 'false' }, { mutation: 'm2', attemptId: 'att-2' });

  const folded = readAttempts(SLUG);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((a) => a.attempt_id), ['att-1', 'att-2'], 'chronological order is kept');
});
