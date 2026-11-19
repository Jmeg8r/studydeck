// WHAT: The text the cockpit shows when /api/state could not build every topic.
// WHY:  The banner itself needs a browser and is verified by driving it. This is the part
//       that turns the response into a claim the learner reads: which topic is missing, and
//       that the numbers on screen leave it out. A wrong sentence here misleads without
//       anything failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, unavailableTopicLines } from '../web/js/integrity.mjs';

const healthyTopic = {
  topic_slug: 'ai-engineering', degraded: [], unparseable_lines: 0, stale_temp_files: [], unreadable_decks: [],
  attempts: { mastery_unapplied: 0, mastery_ambiguous: 0, factcheck_cards_owed: 0 },
  operations: { unresolved: 0, unresolved_list: [] },
};

test('a stuck Open Notebook write is named, and the learner is told to check before repeating it', () => {
  const lines = describe({
    ...healthyTopic,
    operations: {
      unresolved: 1,
      unresolved_list: [{
        operation_id: 'open-notebook-note-x', kind: 'open_notebook_note', stage: 'ambiguous',
        ts: '2026-11-10T12:00:00.000Z', label: 'Fixture highlight [StudyDeck abc123]',
      }],
    },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ai-engineering/);
  assert.match(lines[0], /Fixture highlight \[StudyDeck abc123\]/);
  assert.match(lines[0], /check Open Notebook/i);
  assert.match(lines[0], /Recovery/, 'the line points at the view that can check it');
});

test('mastery that never applied, and mastery left ambiguous, each get their own line', () => {
  const lines = describe({ ...healthyTopic, attempts: { mastery_unapplied: 2, mastery_ambiguous: 1 } });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2 graded attempts/);
  assert.match(lines[1], /1 graded attempt\b/);
  // No retry advice: a mastery failure still answers 2xx, the browser then forgets the
  // mutation id, and a repeat records a NEW attempt. Recovery finishes the stored one.
  for (const line of lines) assert.doesNotMatch(line, /retry|resubmit/i);
  assert.match(lines[0], /Finish (it|them) in Recovery/);
  assert.doesNotMatch(lines[0], /Nothing in the cockpit finishes it/);
  assert.match(lines[0], /repeating the quiz would record a new attempt/i);
});

test('fact-check cards that were never created get a line pointing at Recovery', () => {
  const lines = describe({ ...healthyTopic, attempts: { ...healthyTopic.attempts, factcheck_cards_owed: 1 } });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 fact-check\b/);
  assert.match(lines[0], /cards were never created/);
  assert.match(lines[0], /Recovery/);
});

test('a healthy topic gives no lines', () => {
  assert.deepEqual(describe(healthyTopic), []);
});

test('each unavailable topic gets a line naming it and saying the totals leave it out', () => {
  const lines = unavailableTopicLines({
    incomplete: true,
    unavailable_topics: [
      { slug: 'ai-engineering', error: 'Unexpected token t in JSON at position 30' },
      { slug: 'practical-deep-learning-fastai', error: 'ENOENT: no such file or directory' },
    ],
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ai-engineering/);
  assert.match(lines[0], /Unexpected token/, 'the cause is shown, so the fix is findable');
  assert.match(lines[1], /practical-deep-learning-fastai/);
  for (const line of lines) assert.match(line, /left out/);
});

test('a healthy state, or one from a server that predates the field, gives no lines', () => {
  assert.deepEqual(unavailableTopicLines({ incomplete: false, unavailable_topics: [] }), []);
  assert.deepEqual(unavailableTopicLines({ topics: [] }), []);
});
