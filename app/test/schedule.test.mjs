// WHAT: Contract tests for the action handoffs embedded in the study schedule.
// WHY: A generic Start target used to hide an ordered composite milestone. These tests
//      make the primary action, required continuation, duration, reason, and return path
//      explicit without letting any of them become stage-completion evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MILESTONES } from '../lib/schedule.mjs';
import { stageStatesFor } from '../lib/stages.mjs';

const milestone = (key) => MILESTONES.find((item) => item.key === key);

test('every scheduled stage names a concrete primary action and an explicit return path', () => {
  for (const item of MILESTONES) {
    assert.ok(item.primary_action, `${item.key} has no primary action`);
    assert.match(item.primary_action.view, /^[a-z][a-z0-9-]*$/, `${item.key} action has no view id`);
    assert.ok(item.primary_action.label.length > 3, `${item.key} action has no learner label`);
    assert.ok(item.primary_action.duration.length > 1, `${item.key} action has no duration`);
    assert.ok(item.primary_action.why.length > 8, `${item.key} action has no why`);
    assert.ok(item.primary_action.return_path.length > 8, `${item.key} action has no return path`);
    assert.notEqual(item.primary_action.view, 'stats', `${item.key} must lead to work, not a passive Stats destination`);
  }
});

test('composite milestones preserve their ordered primary and secondary handoffs', () => {
  const guide = milestone('guide');
  assert.equal(guide.primary_action.view, 'testcenter');
  assert.equal(guide.secondary_action.view, 'lab');

  const quiz = milestone('quiz');
  assert.equal(quiz.primary_action.view, 'flashcards');
  assert.equal(quiz.secondary_action.view, 'testcenter');

  for (const key of ['again', 'teach']) {
    const item = milestone(key);
    assert.equal(item.primary_action.view, 'flashcards');
    assert.equal(item.secondary_action.view, 'teachback');
  }
  assert.equal(milestone('present').primary_action.view, 'teachback', 'presentation no longer strands the learner in Stats');
});

test('stage state carries handoffs as instructions, not completion signals', () => {
  const study = stageStatesFor({ started: '2026-08-01', paused: false }, [], '2026-08-02')
    .find((stage) => stage.key === 'study');
  assert.equal(study.primary_action.view, milestone('study').primary_action.view);
  assert.equal(study.secondary_action, null);
  assert.equal(study.complete, false);
});
