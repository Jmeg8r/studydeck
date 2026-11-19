// WHAT: Evidence-policy tests for teach-back records.
// WHY: Saying a presentation happened is activity history, not evidence that it was a
//      strong explanation. A qualifying teach-back needs a rubric declared before it,
//      an observable explanation or artifact, and a learner-owned account of questions
//      or gaps. This pure boundary keeps that distinction out of the route/UI details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualificationForTeachback } from '../lib/teachback.mjs';

const qualifying = {
  outcome: 'confirmed',
  rubric_predeclared: true,
  rubric: 'Explain the tensor dimensions and defend the batch-axis choice.',
  rubric_reference: 'Lesson 1 tensor-shape notes, section 2.',
  observable: 'Explained the shape transition aloud and corrected it after a question.',
  questions: 'Why does the batch dimension remain first?',
  artifact_reference: 'lesson-1-teachback-notes.md',
  gaps: null,
  no_gap_found: true,
  ownership: 'independent',
  ai_contribution: 'none',
};

test('a rubric-backed observable teach-back qualifies without changing mastery', () => {
  const result = qualificationForTeachback(qualifying);
  assert.equal(result.evidence_quality, 'qualifying');
  assert.equal(result.qualifying_teachback, true);
  assert.deepEqual(result.reasons, []);
});

test('a confirmed presentation without a predeclared rubric remains activity evidence', () => {
  const result = qualificationForTeachback({ ...qualifying, rubric_predeclared: false });
  assert.equal(result.evidence_quality, 'activity_only');
  assert.equal(result.qualifying_teachback, false);
  assert.ok(result.reasons.includes('rubric was not predeclared'));
});

test('agent-generated material cannot be represented as independent teach-back evidence', () => {
  const result = qualificationForTeachback({ ...qualifying, ownership: 'agent_generated', ai_contribution: 'generated' });
  assert.equal(result.evidence_quality, 'activity_only');
  assert.ok(result.reasons.includes('teach-back material was agent generated'));
});
