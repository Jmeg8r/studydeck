// WHAT: The words and actions the Recovery view shows for each item.
// WHY:  The view itself needs a browser and is verified by driving it. This is the part
//       that decides what a learner is told and which button they get: a wrong button here
//       settles or checks the wrong thing, and a wrong sentence misleads without failing.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../web/js/recoverycopy.mjs');

const owed = {
  type: 'mastery_owed', attempt_id: 'a1', kind: 'quiz', status: 'final', ts: '2026-11-09T10:00:00Z',
  concept_slug: 'tool-use', concept_title: 'Tool Use', score: 3, max: 5,
};
const cards = { ...owed, type: 'factcheck_cards_owed', attempt_id: 'a2', kind: 'factcheck', score: null, max: null };
const note = {
  type: 'operation_unresolved', operation_id: 'op1', kind: 'open_notebook_note', stage: 'ambiguous',
  ts: '2026-11-08T10:00:00Z', label: 'Highlight [StudyDeck abc]', checkable: true,
};
const debrief = { ...note, operation_id: 'op2', kind: 'debrief', label: 'debrief-operation-x', checkable: false };
const ambiguous = { ...owed, type: 'mastery_ambiguous', attempt_id: 'a3' };
const unfinished = { ...owed, type: 'unfinished', attempt_id: 'a4', status: 'pending_self_grade', score: null, max: null };

test('owed mastery names the concept and score, and offers to apply it', async () => {
  const { describeItem, actionFor } = await load();
  assert.match(describeItem(owed), /Tool Use/);
  assert.match(describeItem(owed), /3\/5/);
  assert.match(describeItem(owed), /never updated/);
  assert.deepEqual(actionFor(owed), { label: 'Apply to mastery', path: '/api/recovery/settle', body: { attempt_id: 'a1' } });
});

test('owed fact-check cards offer to create them through settle', async () => {
  const { describeItem, actionFor } = await load();
  assert.match(describeItem(cards), /corrective cards were never created/);
  assert.deepEqual(actionFor(cards), { label: 'Create the missing cards', path: '/api/recovery/settle', body: { attempt_id: 'a2' } });
});

test('a checkable write offers a read-only look; an uncheckable one says to look by hand', async () => {
  const { describeItem, actionFor } = await load();
  assert.match(describeItem(note), /Highlight \[StudyDeck abc\]/);
  assert.match(describeItem(note), /never confirmed/);
  assert.deepEqual(actionFor(note), { label: 'Look for it in Open Notebook', path: '/api/recovery/reconcile', body: { operation_id: 'op1' } });
  assert.equal(actionFor(debrief), null);
  assert.match(describeItem(debrief), /can't check this kind of write/);
});

test('blocked and unfinished items get no action; only what can be resumed links back', async () => {
  const { actionFor, describeItem, resumeFor } = await load();
  assert.equal(actionFor(ambiguous), null);
  assert.match(describeItem(ambiguous), /won't be applied automatically/);
  assert.equal(actionFor(unfinished), null);
  // Fact-Check lists pending adjudications, and Test Center's essay panel lists pending
  // essays, each with a way to finish them (Codex, run 3). A quiz has none: Finalize shows
  // only on the results screen right after a submit, so a link there led to a fresh retake
  // instead of the saved attempt (Codex, run 1).
  const factcheck = { ...unfinished, kind: 'factcheck', status: 'pending_confirmation' };
  const essay = { ...unfinished, kind: 'essay', status: 'grading_pending' };
  assert.deepEqual(resumeFor(factcheck), { label: 'Resume in Fact-Check', href: '#factcheck' });
  assert.deepEqual(resumeFor(essay), { label: 'Resume in Test Center', href: '#testcenter' });
  assert.deepEqual(resumeFor({ ...essay, status: 'pending_confirmation' }), { label: 'Resume in Test Center', href: '#testcenter' });
  assert.equal(resumeFor(unfinished), null);
  assert.match(describeItem(unfinished), /Test Center can't reopen a saved quiz yet/);
  for (const resumable of [factcheck, essay]) {
    assert.doesNotMatch(describeItem(resumable), /can't reopen/, resumable.kind);
    assert.match(describeItem(resumable), /not finished/, resumable.kind);
  }
});

test('each outcome reads as what happened, and says when nothing changed', async () => {
  const { outcomeMessage } = await load();
  assert.equal(outcomeMessage(owed, 'applied'), 'Mastery updated.');
  assert.equal(outcomeMessage(cards, 'applied'), 'Cards created.');
  assert.equal(outcomeMessage(note, 'confirmed'), 'Found it in Open Notebook and marked it done.');
  assert.match(outcomeMessage(note, 'still_unknown'), /Nothing was changed/);
  assert.match(outcomeMessage(note, 'still_unknown'), /before doing this again/);
  assert.equal(outcomeMessage(owed, 'already_done'), 'This was already finished. Nothing was changed.');
});

test('an unreachable Open Notebook gets its own message; other errors pass their reason through', async () => {
  const { errorMessage } = await load();
  assert.equal(
    errorMessage({ status: 503, message: 'Open Notebook unreachable at http://localhost:5055 (fetch failed)' }),
    "Open Notebook isn't reachable, so nothing was checked. Start it and try again.",
  );
  assert.equal(errorMessage({ status: 409, message: 'This attempt is not finished yet.' }), 'This attempt is not finished yet.');
});

test('the empty state says what Recovery is and why it is empty', async () => {
  const { EMPTY } = await load();
  assert.match(EMPTY, /Nothing to recover/);
  assert.match(EMPTY, /Open Notebook write is confirmed/);
});
