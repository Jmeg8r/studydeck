// WHAT: Tests for the mastery-settlement sequence in lib/settlement.mjs.
// WHY: `mastery_applied` was once stamped at append time, before the update it described
//      had run — so a failed render left an attempt permanently marked done with no
//      mastery behind it, and every retry returned a successful-looking replay.
//
//      The first attempt at healing that ALSO didn't work: an early return in the finalize
//      route sat above it, and the whole suite stayed green because nothing exercised the
//      sequence itself — only its parts. These tests drive the sequence with a fake mastery
//      function, so the wiring cannot regress silently again: applied only after success,
//      healed on replay, and healed exactly once.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, REPO_ROOT } from '../lib/config.mjs';
import { applyAttemptToState, readMasterySnapshot, sameMasterySnapshot } from '../lib/mastery.mjs';
// History is asserted through inspectSidecars().attempts.records rather than
// readAttemptsRaw: the raw reader exists for diagnostics, and a test is a bad place to
// set the precedent that anything else reaches for it.
import { appendAttempt, findAttempt, inspectSidecars } from '../lib/sidecar.mjs';
import { healUnappliedMastery, selfGradesOf, settleMastery } from '../lib/settlement.mjs';

const SLUG = 'settlement-fixture';
let fixtureRoot;
let originalLearnRoot;

const DECK = {
  concept_slug: 'your-first-model',
  questions: [
    { id: 'q1', type: 'short_answer', gradeable: 'exact', prompt: 'What is overfitting?', answer: 'overfitting' },
    { id: 'q2', type: 'error_correction', gradeable: 'ai_only', prompt: 'Spot the error.', answer: 'the body' },
  ],
};

/** A finalised attempt on disk, exactly as the finalize route leaves one. */
function recordFinalAttempt({ misses = [], score = 2 - misses.length, max = 2 } = {}) {
  return appendAttempt(SLUG, {
    ts: '2026-07-28T10:05:00Z',
    kind: 'quiz',
    attempt_id: 'att-1',
    mutation_id: 'm-final',
    revision: 1,
    concept_slug: 'your-first-model',
    deck_file: 'deck-001.json',
    score,
    max,
    misses,
    responses: { q1: 'overfitting' },
    self_graded: ['q2'],
    status: 'final',
    mastery_applied: false,
  });
}

/** Records every call, and fails on demand. */
function fakeMastery({ failWith = null } = {}) {
  const calls = [];
  const fn = async (topicSlug, conceptSlug, graded) => {
    calls.push({ topicSlug, conceptSlug, score: graded.score, max: graded.max });
    return failWith ? { error: failWith, attempt_recorded: true } : { band: 'strong', render: 'ok' };
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  originalLearnRoot = config.learnRoot;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'settlement-test-'));
  config.learnRoot = fixtureRoot;
  mkdirSync(join(fixtureRoot, SLUG, 'cockpit'), { recursive: true });
});

afterEach(() => {
  config.learnRoot = originalLearnRoot;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('settleMastery marks the attempt applied only after the update succeeds', async () => {
  const attempt = recordFinalAttempt();
  const apply = fakeMastery();

  const result = await settleMastery(SLUG, attempt, { score: 2, max: 2 }, apply);

  assert.equal(result.band, 'strong');
  assert.equal(apply.calls.length, 1);
  assert.equal(findAttempt(SLUG, 'att-1').mastery_applied, true);
  assert.equal(inspectSidecars(SLUG).attempts.records, 2, 'the follow-up is a second record...');
  assert.equal(inspectSidecars(SLUG).attempts.distinct, 1, '...but the same attempt');
});

test('settlement re-reads the stored attempt and ignores changed caller grading', async () => {
  const attempt = recordFinalAttempt({ score: 1, max: 2 });
  const apply = fakeMastery();

  await settleMastery(SLUG, { ...attempt, score: 2, max: 2 }, { score: 2, max: 2 }, apply);

  assert.deepEqual(
    { score: apply.calls[0].score, max: apply.calls[0].max },
    { score: 1, max: 2 },
    'a retry must settle the immutable stored score, never fields supplied after record',
  );
});

test('a statusless legacy final record remains eligible for settlement', async () => {
  const legacy = appendAttempt(SLUG, {
    ts: '2026-07-28T10:05:00Z', kind: 'quiz', attempt_id: 'att-legacy', mutation_id: 'm-legacy',
    revision: 0, concept_slug: 'your-first-model', score: 2, max: 2, misses: [],
    responses: { q1: 'overfitting' }, mastery_applied: false,
  });
  const apply = fakeMastery();

  await settleMastery(SLUG, legacy, { score: 2, max: 2 }, apply);

  assert.equal(apply.calls.length, 1);
  assert.equal(findAttempt(SLUG, 'att-legacy').mastery_applied, true);
});

test('a prepared settlement survives a crash before state publish and applies once on recovery', async () => {
  // This uses the canonical renderer against a copied topic: the decisive boundary is the
  // durable prepared row between a successful staged render and the first live write.
  rmSync(join(fixtureRoot, SLUG), { recursive: true, force: true });
  cpSync(join(REPO_ROOT, '.learn', 'topics', 'ai-agent-design-patterns'), join(fixtureRoot, SLUG), { recursive: true });
  const conceptSlug = 'the-agent-loop';
  const before = readMasterySnapshot(SLUG, conceptSlug);
  const attempt = appendAttempt(SLUG, {
    ts: '2026-08-12T12:00:00Z', kind: 'quiz', attempt_id: 'att-crash', mutation_id: 'm-crash', revision: 0,
    concept_slug: conceptSlug, score: 1, max: 1, status: 'final', mastery_applied: false,
  });

  const crashBeforePublish = (topic, concept, graded, options) =>
    applyAttemptToState(topic, concept, graded, {
      ...options,
      onPrepared: async (staged) => {
        await options.onPrepared(staged);
        throw new Error('injected crash after prepared settlement');
      },
    });

  await assert.rejects(() => settleMastery(SLUG, attempt, { score: 1, max: 1 }, crashBeforePublish), /injected crash/);
  const prepared = findAttempt(SLUG, 'att-crash');
  assert.equal(prepared.mastery_settlement.stage, 'prepared');
  assert.ok(sameMasterySnapshot(readMasterySnapshot(SLUG, conceptSlug), before), 'state changed before publish');

  await healUnappliedMastery(SLUG, 'att-crash', null, applyAttemptToState);
  const applied = findAttempt(SLUG, 'att-crash');
  assert.equal(applied.mastery_applied, true);
  assert.equal(applied.mastery_settlement.stage, 'applied');
  assert.ok(sameMasterySnapshot(readMasterySnapshot(SLUG, conceptSlug), prepared.mastery_settlement.after));
  assert.equal(inspectSidecars(SLUG).attempts.records, 3, 'one record per state: original, prepared, applied');
});

test('a crash after state publish repairs the map and marks applied without a second confidence bump', async () => {
  rmSync(join(fixtureRoot, SLUG), { recursive: true, force: true });
  cpSync(join(REPO_ROOT, '.learn', 'topics', 'ai-agent-design-patterns'), join(fixtureRoot, SLUG), { recursive: true });
  const conceptSlug = 'the-agent-loop';
  const attempt = appendAttempt(SLUG, {
    ts: '2026-08-12T12:00:00Z', kind: 'quiz', attempt_id: 'att-after-state', mutation_id: 'm-after-state', revision: 0,
    concept_slug: conceptSlug, score: 1, max: 1, status: 'final', mastery_applied: false,
  });

  const crashAfterState = (topic, concept, graded, options) =>
    applyAttemptToState(topic, concept, graded, {
      ...options,
      onStatePublished: async () => { throw new Error('injected crash after state publish'); },
    });

  await assert.rejects(() => settleMastery(SLUG, attempt, { score: 1, max: 1 }, crashAfterState), /after state publish/);
  const prepared = findAttempt(SLUG, 'att-after-state');
  assert.equal(prepared.mastery_settlement.stage, 'prepared');
  assert.ok(sameMasterySnapshot(readMasterySnapshot(SLUG, conceptSlug), prepared.mastery_settlement.after));

  await healUnappliedMastery(SLUG, 'att-after-state', null, applyAttemptToState);
  assert.equal(findAttempt(SLUG, 'att-after-state').mastery_applied, true);
  assert.ok(sameMasterySnapshot(readMasterySnapshot(SLUG, conceptSlug), prepared.mastery_settlement.after));
  assert.equal(inspectSidecars(SLUG).attempts.records, 3);
});

test('an unmatched prepared fingerprint is marked ambiguous and blocks another confidence update', async () => {
  rmSync(join(fixtureRoot, SLUG), { recursive: true, force: true });
  cpSync(join(REPO_ROOT, '.learn', 'topics', 'ai-agent-design-patterns'), join(fixtureRoot, SLUG), { recursive: true });
  const attempt = appendAttempt(SLUG, {
    ts: '2026-08-12T12:00:00Z', kind: 'quiz', attempt_id: 'att-ambiguous', mutation_id: 'm-ambiguous', revision: 0,
    concept_slug: 'the-agent-loop', score: 1, max: 1, status: 'final', mastery_applied: false,
    mastery_settlement: {
      stage: 'prepared', origin_mutation_id: 'm-ambiguous', band: 'strong', practice_date: '2026-08-12',
      before: { status: 'unknown', confidence: 0.11, practice_count: 8, last_practiced: '2026-01-01' },
      after: { status: 'mastered', confidence: 0.99, practice_count: 9, last_practiced: '2026-08-12' },
    },
  });
  const apply = fakeMastery();

  const result = await settleMastery(SLUG, attempt, { score: 1, max: 1 }, apply);
  assert.match(result.error, /ambiguous/);
  assert.equal(apply.calls.length, 0, 'an unknown state must never receive another update');
  assert.equal(findAttempt(SLUG, 'att-ambiguous').mastery_settlement.stage, 'ambiguous');
  assert.equal(inspectSidecars(SLUG).attempts.mastery_ambiguous, 1);
});

test('a failed update writes no follow-up, leaving the partial commit visible', async () => {
  const attempt = recordFinalAttempt();
  const apply = fakeMastery({ failWith: 'render.mjs rejected the state update' });

  const result = await settleMastery(SLUG, attempt, { score: 2, max: 2 }, apply);

  assert.match(result.error, /rejected/);
  assert.equal(findAttempt(SLUG, 'att-1').mastery_applied, false);
  assert.equal(inspectSidecars(SLUG).attempts.records, 1, 'nothing claims the update landed');
  assert.equal(inspectSidecars(SLUG).attempts.mastery_unapplied, 1);
});

test('a replay heals the owed update, and the health counter clears', async () => {
  const attempt = recordFinalAttempt();
  const failing = fakeMastery({ failWith: 'another process is mutating this topic' });
  await settleMastery(SLUG, attempt, { score: 2, max: 2 }, failing);
  assert.equal(inspectSidecars(SLUG).attempts.mastery_unapplied, 1);

  // The retry, once whatever blocked it has gone away.
  const succeeding = fakeMastery();
  const healed = await healUnappliedMastery(SLUG, 'att-1', DECK, succeeding);

  assert.equal(healed.band, 'strong');
  assert.equal(succeeding.calls.length, 1);
  assert.equal(findAttempt(SLUG, 'att-1').mastery_applied, true);
  assert.equal(inspectSidecars(SLUG).attempts.mastery_unapplied, 0);
});

test('healing is idempotent — a second replay applies nothing', async () => {
  const attempt = recordFinalAttempt();
  await settleMastery(SLUG, attempt, { score: 2, max: 2 }, fakeMastery({ failWith: 'blocked' }));

  const apply = fakeMastery();
  await healUnappliedMastery(SLUG, 'att-1', DECK, apply);
  await healUnappliedMastery(SLUG, 'att-1', DECK, apply);
  await healUnappliedMastery(SLUG, 'att-1', DECK, apply);

  assert.equal(apply.calls.length, 1, 'the confidence bump must not be applied three times');
  assert.equal(inspectSidecars(SLUG).attempts.records, 2);
});

test('concurrent replays heal once — the check-then-act race', async () => {
  const attempt = recordFinalAttempt();
  await settleMastery(SLUG, attempt, { score: 2, max: 2 }, fakeMastery({ failWith: 'blocked' }));

  // A slow apply, so both replays are genuinely in flight across the same window. Reading
  // mastery_applied and acting on it is a check-then-act: without collapsing them, both
  // observe the update as owed and both apply it. The topic lock inside the real
  // applyAttemptToState does not help — it serialises the two writes rather than
  // preventing the second, and a doubly-applied confidence bump is silent corruption.
  const calls = [];
  const slowApply = async (topicSlug, conceptSlug, graded) => {
    calls.push({ conceptSlug, score: graded.score });
    await new Promise((r) => setTimeout(r, 25));
    return { band: 'strong', render: 'ok' };
  };

  const [a, b] = await Promise.all([
    healUnappliedMastery(SLUG, 'att-1', DECK, slowApply),
    healUnappliedMastery(SLUG, 'att-1', DECK, slowApply),
  ]);

  assert.equal(calls.length, 1, 'mastery must be applied exactly once');
  assert.deepEqual(a, b, 'both callers get the same outcome');
  assert.equal(inspectSidecars(SLUG).attempts.records, 2, 'one follow-up, not two');
  assert.equal(findAttempt(SLUG, 'att-1').mastery_applied, true);
});

test('concurrent replays of DIFFERENT attempts do not block each other', async () => {
  for (const id of ['att-1', 'att-9']) {
    await settleMastery(
      SLUG,
      appendAttempt(SLUG, { ...recordFinalAttempt(), attempt_id: id, mutation_id: `m-${id}` }),
      { score: 2, max: 2 },
      fakeMastery({ failWith: 'blocked' }),
    );
  }

  const apply = fakeMastery();
  await Promise.all([
    healUnappliedMastery(SLUG, 'att-1', DECK, apply),
    healUnappliedMastery(SLUG, 'att-9', DECK, apply),
  ]);

  assert.equal(apply.calls.length, 2, 'two attempts owe two updates');
  assert.equal(findAttempt(SLUG, 'att-1').mastery_applied, true);
  assert.equal(findAttempt(SLUG, 'att-9').mastery_applied, true);
});

test('nothing owed means nothing done', async () => {
  const attempt = recordFinalAttempt();
  await settleMastery(SLUG, attempt, { score: 2, max: 2 }, fakeMastery());

  const apply = fakeMastery();
  assert.equal(await healUnappliedMastery(SLUG, 'att-1', DECK, apply), null);
  assert.equal(apply.calls.length, 0);
});

test('a pending attempt is never healed — its score is not final yet', async () => {
  appendAttempt(SLUG, {
    ts: '2026-07-28T10:00:00Z',
    kind: 'quiz',
    attempt_id: 'att-2',
    mutation_id: 'm-submit',
    revision: 0,
    concept_slug: 'your-first-model',
    deck_file: 'deck-001.json',
    score: 1,
    max: 1,
    misses: [],
    responses: { q1: 'overfitting' },
    pending: ['q2'],
    status: 'pending_self_grade',
    mastery_applied: false,
  });

  const apply = fakeMastery();
  assert.equal(await healUnappliedMastery(SLUG, 'att-2', DECK, apply), null);
  assert.equal(apply.calls.length, 0);
  // And it is counted as pending, not as an owed update.
  const report = inspectSidecars(SLUG);
  assert.equal(report.attempts.pending_self_grade, 1);
  assert.equal(report.attempts.mastery_unapplied, 0);
});

test('an unknown attempt id is a no-op rather than a throw', async () => {
  const apply = fakeMastery();
  assert.equal(await healUnappliedMastery(SLUG, 'no-such-attempt', DECK, apply), null);
  assert.equal(apply.calls.length, 0);
});

test('the healed re-grade reuses the recorded self-grades, not a fresh guess', async () => {
  // q2 was self-marked as MISSED, so healing must re-grade it as a miss rather than
  // silently upgrading the score on the retry.
  const attempt = recordFinalAttempt({ misses: ['q2'] });
  assert.deepEqual(selfGradesOf(attempt), { q2: false });

  await settleMastery(SLUG, attempt, { score: 1, max: 2 }, fakeMastery({ failWith: 'blocked' }));
  const apply = fakeMastery();
  await healUnappliedMastery(SLUG, 'att-1', DECK, apply);

  assert.deepEqual(apply.calls[0], { topicSlug: SLUG, conceptSlug: 'your-first-model', score: 1, max: 2 });
});
