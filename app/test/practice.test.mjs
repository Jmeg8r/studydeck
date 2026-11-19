// WHAT: Evidence-policy tests for the Practice Lab.
// WHY: Practice records are useful learning history, but calling them independent transfer
//      without a rubric, observable result, and provenance would turn a self-report into a
//      mastery claim. The policy is pure so those boundaries stay auditable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualificationForPracticeEvidence } from '../lib/practice.mjs';

const qualifyingTransfer = {
  outcome: 'confirmed',
  evidence_kind: 'transfer',
  rubric: 'Explain the boundary and show a normal plus failing case.',
  observable: 'The exercise printed the normal result and rejected the invalid input.',
  ownership: 'independent',
  ai_contribution: 'none',
  hint_use: 'none',
};

test('only provenance-complete, unrevealed transfer evidence can claim independent near transfer', () => {
  const qualification = qualificationForPracticeEvidence(qualifyingTransfer);
  assert.deepEqual(qualification, {
    evidence_quality: 'qualifying',
    independent_near_transfer: true,
    reasons: [],
  });
});

test('an answer reveal, full solution, or agent contribution remains recorded history but blocks independence', () => {
  const revealed = qualificationForPracticeEvidence(qualifyingTransfer, { answerRevealed: true });
  assert.equal(revealed.evidence_quality, 'qualifying');
  assert.equal(revealed.independent_near_transfer, false);
  assert.ok(revealed.reasons.includes('answer-bearing artifact was revealed'));

  const generated = qualificationForPracticeEvidence({ ...qualifyingTransfer, ai_contribution: 'generated' });
  assert.equal(generated.independent_near_transfer, false);
  assert.ok(generated.reasons.includes('AI contributed to the work'));

  const solution = qualificationForPracticeEvidence({ ...qualifyingTransfer, hint_use: 'full_solution' });
  assert.equal(solution.independent_near_transfer, false);
  assert.ok(solution.reasons.includes('a full solution was used'));
});

test('a rejected activity cannot be promoted by a detailed reflection alone', () => {
  const qualification = qualificationForPracticeEvidence({
    ...qualifyingTransfer,
    outcome: 'rejected',
  });
  assert.equal(qualification.evidence_quality, 'recorded_not_qualifying');
  assert.equal(qualification.independent_near_transfer, false);
  assert.ok(qualification.reasons.includes('activity was not confirmed'));
});
