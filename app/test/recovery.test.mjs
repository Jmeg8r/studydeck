// WHAT: The Recovery list: what it puts in each section, and that it agrees with health.
// WHY:  The view and the health banner must never disagree about what is owed, so the
//       list reuses sidecar.mjs's predicates instead of its own. And attempt records carry
//       answers (responses, results, misses, fact-check truths), so every item is an
//       allowlist projection: the fixture plants each answer-bearing field and asserts
//       none of it reaches the output (rule 7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-recovery-'));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

const { config } = await import('../lib/config.mjs');
const { inspectSidecars } = await import('../lib/sidecar.mjs');
// Imported per test so a missing module fails these tests, not the import of the file.
const loadRecovery = () => import('../lib/recovery.mjs');

const TOPIC = config.topics[0].slug;
const cockpit = join(FIXTURE_ROOT, TOPIC, 'cockpit');
mkdirSync(cockpit, { recursive: true });
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

const PLANTED = 'PLANTED-ANSWER';
const answers = {
  responses: { q1: `${PLANTED}-response` },
  results: [{ id: 'q1', correct: false, answer: `${PLANTED}-result` }],
  misses: [{ question: 'q1', answer: `${PLANTED}-miss` }],
  confidence: { q1: 3 },
};
const ts = (n) => `2026-11-0${n}T10:00:00.000Z`;

writeFileSync(join(cockpit, 'attempts.jsonl'), jsonl([
  // Legacy: no status, no id. Final and settled long ago; never listed.
  { kind: 'quiz', concept_slug: 'c1', score: 4, max: 5, ts: ts(1), misses: [`${PLANTED}-legacy`] },
  { attempt_id: 'a-applied', kind: 'quiz', status: 'final', concept_slug: 'c1', score: 5, max: 5, mastery_applied: true, ts: ts(2), ...answers },
  { attempt_id: 'a-owed', kind: 'quiz', status: 'final', concept_slug: 'c1', deck_file: 'c1.json', score: 3, max: 5, mastery_applied: false, ts: ts(3), ...answers },
  { attempt_id: 'a-ambiguous', kind: 'quiz', status: 'final', concept_slug: 'c1', score: 2, max: 5, mastery_applied: false, mastery_settlement: { stage: 'ambiguous' }, ts: ts(4), ...answers },
  {
    attempt_id: 'a-factcheck', kind: 'factcheck', status: 'final', concept_slug: 'c1', mastery_applied: false, ts: ts(5),
    factcheck_proposal: { source_id: 's1', claims: [{ id: 'k1', truth: `${PLANTED}-truth`, correction: `${PLANTED}-correction` }] },
    factcheck_adjudication: { results: [{ id: 'k1', adjudication: 'accepted', correct: false }] },
  },
  {
    attempt_id: 'a-factcheck-done', kind: 'factcheck', status: 'final', concept_slug: 'c1', ts: ts(5),
    factcheck_proposal: { source_id: 's2', claims: [] }, factcheck_adjudication: { results: [] },
    factcheck_cards: { status: 'complete', card_ids: [] },
  },
  { attempt_id: 'a-pending', kind: 'quiz', status: 'pending_self_grade', concept_slug: 'c1', provisional_grade: `${PLANTED}-provisional`, ts: ts(6), ...answers },
]));

writeFileSync(join(cockpit, 'operations.jsonl'), jsonl([
  { operation_id: 'op-note', kind: 'open_notebook_note', stage: 'prepared', revision: 1, ts: ts(7), local_result: { notebook_id: 'notebook:x', note_title: 'Highlight [StudyDeck 0123456789ab]' } },
  { operation_id: 'op-debrief', kind: 'debrief', stage: 'ambiguous', revision: 2, ts: ts(8), local_result: { debrief_id: 'd1', card_ids: [] } },
  { operation_id: 'op-done', kind: 'open_notebook_note', stage: 'complete', revision: 2, ts: ts(8), local_result: { note_title: 'Done [StudyDeck aaaaaaaaaaaa]' } },
  { operation_id: 'op-started', kind: 'open_notebook_note', stage: 'started', revision: 0, ts: ts(8), local_result: { note_title: 'Never sent' } },
]));

const listFor = async () => {
  const { recoveryList } = await loadRecovery();
  return recoveryList([{ slug: TOPIC }]).topics[0];
};
const ids = (items) => items.map((item) => item.attempt_id ?? item.operation_id);

test('health counts a final fact-check whose cards were never created', () => {
  assert.equal(inspectSidecars(TOPIC).attempts.factcheck_cards_owed, 1);
});

test('needs action lists owed mastery, owed cards and unresolved operations, oldest first', async () => {
  const topic = await listFor();
  assert.deepEqual(ids(topic.needs_action), ['a-owed', 'a-factcheck', 'op-note', 'op-debrief']);
  assert.deepEqual(topic.needs_action.map((item) => item.type), [
    'mastery_owed', 'factcheck_cards_owed', 'operation_unresolved', 'operation_unresolved',
  ]);
});

test('an operation is checkable only where Recovery has a matching rule', async () => {
  const topic = await listFor();
  const byId = Object.fromEntries(topic.needs_action.map((item) => [item.operation_id, item]));
  assert.equal(byId['op-note'].checkable, true);
  assert.equal(byId['op-note'].label, 'Highlight [StudyDeck 0123456789ab]');
  assert.equal(byId['op-debrief'].checkable, false);
});

test('ambiguous mastery is blocked, and an unfinished attempt is in progress', async () => {
  const topic = await listFor();
  assert.deepEqual(ids(topic.blocked), ['a-ambiguous']);
  assert.deepEqual(ids(topic.in_progress), ['a-pending']);
});

test('the counts equal what /api/health counts for the same tree', async () => {
  const topic = await listFor();
  const health = inspectSidecars(TOPIC);
  assert.deepEqual(topic.counts, {
    mastery_owed: health.attempts.mastery_unapplied,
    factcheck_cards_owed: health.attempts.factcheck_cards_owed,
    operations_unresolved: health.operations.unresolved,
  });
  assert.equal(topic.needs_action.length, Object.values(topic.counts).reduce((a, b) => a + b, 0));
});

test('no answer-bearing field reaches the list (rule 7)', async () => {
  const { recoveryList } = await loadRecovery();
  const body = JSON.stringify(recoveryList([{ slug: TOPIC }]));
  assert.ok(!body.includes(PLANTED), `an answer leaked: ${body.match(new RegExp(`${PLANTED}[-a-z]*`, 'g'))}`);
  // Control: the projection still carries what the view needs.
  assert.match(body, /"score":3/);
  assert.match(body, /"attempt_id":"a-owed"/);
});

test('a topic that cannot be read is reported without hiding the others', async () => {
  const { recoveryList } = await loadRecovery();
  const broken = join(FIXTURE_ROOT, 'broken-topic', 'cockpit');
  mkdirSync(join(broken, 'attempts.jsonl'), { recursive: true }); // a directory where a file belongs
  const { topics } = recoveryList([{ slug: 'broken-topic' }, { slug: TOPIC }]);
  assert.equal(topics[0].topic_slug, 'broken-topic');
  assert.ok(topics[0].error, 'the unreadable topic says why');
  assert.equal(topics[1].needs_action.length, 4);
});
