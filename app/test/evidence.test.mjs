import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conceptEvidence, confidenceAlignment, EVIDENCE_POLICY, isConfidenceBand, itemRetentionEvidence,
  misconceptionCandidates, quizConfidenceEvidence, retrievalEvidenceForQuiz, RETRIEVAL_POLICY,
} from '../lib/evidence.mjs';

test('confidence bands are a fixed ordinal vocabulary, not numeric probabilities', () => {
  assert.deepEqual(EVIDENCE_POLICY.confidenceBands, ['unsure', 'likely', 'certain']);
  assert.equal(isConfidenceBand('likely'), true);
  assert.equal(isConfidenceBand('0.8'), false);
});

test('confidence alignment remains insufficient until the approved sample threshold', () => {
  const below = confidenceAlignment([{ confidence: 'certain', correct: false }]);
  assert.deepEqual(below.find((row) => row.band === 'certain'), {
    band: 'certain', sample: 1, correct: 0, insufficient: true,
  });

  const enough = confidenceAlignment(Array.from({ length: 5 }, (_, i) => ({ confidence: 'likely', correct: i < 4 })));
  assert.deepEqual(enough.find((row) => row.band === 'likely'), {
    band: 'likely', sample: 5, correct: 4, insufficient: false, accuracy: 0.8,
  });
});

test('quiz confidence evidence uses the durable recorded miss list, never a mutable deck', () => {
  const summary = quizConfidenceEvidence([
    { kind: 'quiz', status: 'final', evidence_policy: 'evidence-v1', misses: ['q2'], confidence: { q1: 'certain', q2: 'certain' } },
    { kind: 'quiz', status: 'pending_self_grade', evidence_policy: 'evidence-v1', misses: [], confidence: { q3: 'likely' } },
    { kind: 'essay', status: 'final', evidence_policy: 'evidence-v1', misses: [], confidence: { q4: 'likely' } },
  ]);
  assert.equal(summary.samples, 2);
  assert.deepEqual(summary.bands.find((row) => row.band === 'certain'), {
    band: 'certain', sample: 2, correct: 1, insufficient: true,
  });
  assert.equal(summary.bands.find((row) => row.band === 'likely').sample, 0);
});

test('only a final high-confidence quiz miss becomes a misconception candidate', () => {
  const candidates = misconceptionCandidates([
    { kind: 'quiz', status: 'final', evidence_policy: 'evidence-v1', attempt_id: 'a1', concept_slug: 'bias', ts: '2026-08-01T00:00:00Z', misses: ['q1', 'q2'], confidence: { q1: 'certain', q2: 'likely' } },
    { kind: 'quiz', status: 'pending_self_grade', evidence_policy: 'evidence-v1', attempt_id: 'a2', misses: ['q3'], confidence: { q3: 'certain' } },
  ]);
  assert.deepEqual(candidates, [{
    id: 'quiz:a1:q1', attempt_id: 'a1', question_id: 'q1', concept_slug: 'bias',
    detected_at: '2026-08-01T00:00:00Z', response_format: 'quiz', state: 'candidate', characterization: null,
  }]);
});

test('a characterization event changes the candidate label without altering its source error', () => {
  const [candidate] = misconceptionCandidates([
    { kind: 'quiz', status: 'final', evidence_policy: 'evidence-v1', attempt_id: 'a1', ts: '2026-08-01T00:00:00Z', misses: ['q1'], confidence: { q1: 'certain' } },
  ], [{ candidate_id: 'quiz:a1:q1', action: 'classified_slip', rationale: 'I clicked the adjacent option.' }]);
  assert.equal(candidate.state, 'classified_slip');
  assert.equal(candidate.characterization, 'I clicked the adjacent option.');
  assert.equal(candidate.attempt_id, 'a1');
});

test('one deterministic answer-free event fills only one spaced item-retention checkpoint', () => {
  const attempts = [
    {
      kind: 'quiz', status: 'final', attempt_id: 'a1', ts: '2026-01-01T12:00:00.000Z', concept_slug: 'bias',
      retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'hash-a', items: [
        { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
      ] },
    },
    {
      kind: 'quiz', status: 'final', attempt_id: 'a2', ts: '2026-01-08T12:00:00.000Z', concept_slug: 'bias',
      retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'hash-a', items: [
        { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
      ] },
    },
    // The day-8 event establishes the 7-day horizon; it cannot skip ahead to 30 days.
    {
      kind: 'quiz', status: 'final', attempt_id: 'a3', ts: '2026-01-09T12:00:00.000Z', concept_slug: 'bias',
      retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'hash-a', items: [
        { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
      ] },
    },
    {
      kind: 'quiz', status: 'final', attempt_id: 'a4', ts: '2026-01-31T12:00:00.000Z', concept_slug: 'bias',
      retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'hash-a', items: [
        { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
      ] },
    },
  ];

  const [item] = itemRetentionEvidence(attempts, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(item, {
    item_id: 'deck.json:q1', assessment_version: 'hash-a', concept_slug: 'bias', retrieval_format: 'free_recall',
    initial_demonstration: { at: '2026-01-01T12:00:00.000Z', attempt_id: 'a1' },
    retention_horizon_days: 30,
    last_verification: { at: '2026-01-31T12:00:00.000Z', attempt_id: 'a4' },
    current_attention: { state: 'none' },
  });
});

test('a missed checkpoint is due, while a delayed failed check needs repair without erasing prior evidence', () => {
  const initial = {
    kind: 'quiz', status: 'final', attempt_id: 'a1', ts: '2026-01-01T12:00:00.000Z', concept_slug: 'bias',
    retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'hash-a', items: [
      { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
    ] },
  };
  const failed = {
    ...initial,
    attempt_id: 'a2', ts: '2026-01-09T12:00:00.000Z',
    retrieval_evidence: { ...initial.retrieval_evidence, items: [{
      ...initial.retrieval_evidence.items[0], correct: false,
    }] },
  };
  const early = {
    ...failed,
    attempt_id: 'early', ts: '2026-01-02T12:00:00.000Z',
  };

  const [due] = itemRetentionEvidence([initial], '2026-01-08T12:00:00.000Z');
  assert.deepEqual(due.current_attention, { state: 'verification_due', due_at: '2026-01-08T12:00:00.000Z' });
  const [earlyRepeat] = itemRetentionEvidence([initial, early], '2026-01-08T12:00:00.000Z');
  assert.deepEqual(earlyRepeat.current_attention, { state: 'verification_due', due_at: '2026-01-08T12:00:00.000Z' },
    'an early repeat cannot turn into a failed retention checkpoint');

  const [repair] = itemRetentionEvidence([initial, failed], '2026-01-10T12:00:00.000Z');
  assert.equal(repair.retention_horizon_days, 0, 'the initial demonstration remains historical evidence');
  assert.deepEqual(repair.current_attention, {
    state: 'needs_repair', failed_at: '2026-01-09T12:00:00.000Z', attempt_id: 'a2',
  });
});

test('self-graded, pending, and legacy quiz rows cannot manufacture retention evidence', () => {
  const items = itemRetentionEvidence([
    { kind: 'quiz', status: 'pending_self_grade', attempt_id: 'pending', ts: '2026-01-01T00:00:00.000Z', retrieval_evidence: { policy: RETRIEVAL_POLICY.version, items: [] } },
    { kind: 'quiz', status: 'final', attempt_id: 'self', ts: '2026-01-01T00:00:00.000Z', retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck', items: [
      { question_id: 'q1', retrieval_format: 'explanation', verification_method: 'self_grade', answer_free: true, correct: true },
    ] } },
    { kind: 'quiz', status: 'final', attempt_id: 'legacy', ts: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(items, []);
});

test('a changed assessment version starts a separate item history', () => {
  const base = {
    kind: 'quiz', status: 'final', attempt_id: 'a1', ts: '2026-01-01T00:00:00.000Z', concept_slug: 'bias',
    retrieval_evidence: { policy: RETRIEVAL_POLICY.version, assessment_id: 'deck.json', assessment_version: 'old', items: [
      { question_id: 'q1', retrieval_format: 'recognition', verification_method: 'deterministic_deck', answer_free: true, correct: true },
    ] },
  };
  const changed = {
    ...base, attempt_id: 'a2', ts: '2026-02-15T00:00:00.000Z',
    retrieval_evidence: { ...base.retrieval_evidence, assessment_version: 'new' },
  };
  const items = itemRetentionEvidence([base, changed], '2026-02-16T00:00:00.000Z');
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.retention_horizon_days === 0));
});

test('mapped concept evidence keeps item proof, concept retention, transfer, and attention separate', () => {
  const concepts = [
    { slug: 'bias', name: 'Bias', status: 'mastered' },
    { slug: 'variance', name: 'Variance', status: 'needs_practice' },
  ];
  const items = [
    { concept_slug: 'bias', retention_horizon_days: 7, current_attention: { state: 'verification_due' } },
    { concept_slug: 'bias', retention_horizon_days: 0, current_attention: { state: 'needs_repair' } },
    { concept_slug: 'removed-concept', retention_horizon_days: 90, current_attention: { state: 'none' } },
  ];
  const misconceptions = [
    { concept_slug: 'bias', state: 'candidate' },
    { concept_slug: 'bias', state: 'confirmed_misconception' },
    { concept_slug: 'variance', state: 'candidate' },
    { concept_slug: 'removed-concept', state: 'confirmed_misconception' },
  ];

  assert.deepEqual(conceptEvidence(concepts, items, misconceptions), [
    {
      concept_slug: 'bias', concept_name: 'Bias', upstream_status: 'mastered',
      initial_demonstration_count: 2, item_retention_horizon_days: 7,
      concept_retention: 'unverified', near_transfer: 'unverified',
      open_misconception_candidates: 1, confirmed_misconceptions_needing_repair: 1,
      current_attention: { state: 'needs_repair', item_count: 1, confirmed_misconception_count: 1 },
    },
    {
      concept_slug: 'variance', concept_name: 'Variance', upstream_status: 'needs_practice',
      initial_demonstration_count: 0, item_retention_horizon_days: null,
      concept_retention: 'unverified', near_transfer: 'unverified',
      open_misconception_candidates: 1, confirmed_misconceptions_needing_repair: 0,
      current_attention: { state: 'needs_characterization', candidate_count: 1 },
    },
  ]);
});

test('a quiz evidence snapshot contains no answer material but preserves its deterministic outcome', () => {
  const evidence = retrievalEvidenceForQuiz('deck.json', {
    questions: [
      { id: 'q1', type: 'fill_in_blank', gradeable: 'accepted', answer: 'overfitting', explanation: 'A hidden answer.' },
    ],
  }, { results: [{ id: 'q1', correct: true }] });
  assert.equal(evidence.policy, 'retrieval-v1');
  assert.match(evidence.assessment_version, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.items, [{
    question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true,
  }]);
  assert.ok(!JSON.stringify(evidence).includes('overfitting'));
  assert.ok(!JSON.stringify(evidence).includes('A hidden answer.'));
});
