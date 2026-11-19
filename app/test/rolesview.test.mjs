// WHAT: The Roles view's pure helpers — the text it derives from what the server returns.
// WHY:  The view itself needs a browser, and is verified by driving it. These are the
//       parts that turn data into claims a learner reads: what a timer says at expiry,
//       which question a card is prefilled with, what a diagnosis left out. A wrong
//       sentence here misleads without anything failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardDrafts, createScreenGuard, draftNote, evidenceLines, formatCost, nextBackOrigin, sessionLine, timerState } from '../web/js/views/roles.mjs';

test('an AI-drafted answer can be edited, but never becomes the learner\'s own', () => {
  assert.equal(nextBackOrigin('learner', 'edited'), 'learner', 'typing your own answer stays yours');
  assert.equal(nextBackOrigin('learner', 'drafted'), 'ai_draft');
  assert.equal(nextBackOrigin('ai_draft', 'edited'), 'ai_draft_edited');
  assert.equal(nextBackOrigin('ai_draft_edited', 'edited'), 'ai_draft_edited', 'more edits do not launder it');
  assert.equal(nextBackOrigin('ai_draft_edited', 'drafted'), 'ai_draft', 'a fresh draft starts over');
});

test('a draft made without your sources never reads as if it used them', () => {
  assert.match(draftNote({ grounded: true, ungrounded_reason: null }), /using your sources/);
  for (const [reason, why] of [['no_notebook', /no notebook/], ['unreachable', /Open Notebook didn't answer/], ['no_sources', /has none yet/]]) {
    const note = draftNote({ grounded: false, ungrounded_reason: reason });
    assert.match(note, /without your sources/, reason);
    assert.match(note, why, reason);
    assert.doesNotMatch(note, /using your sources/, reason);
  }
  assert.match(draftNote({ grounded: false, ungrounded_reason: 'something new' }), /without your sources/, 'an unknown reason still says ungrounded');
});

test('a reply for a screen the learner has left is not allowed to paint', () => {
  // Roles moves between screens without leaving the view. A turn sent in one session can
  // be answered after another session is open and being typed in.
  const screen = createScreenGuard();
  const firstSession = screen.enter();
  assert.equal(screen.isCurrent(firstSession), true);

  const secondSession = screen.enter();
  assert.equal(screen.isCurrent(firstSession), false, 'the late reply belongs to a screen that is gone');
  assert.equal(screen.isCurrent(secondSession), true);
  assert.equal(screen.token(), secondSession);
});

test('once the view is torn down, nothing is current', () => {
  const screen = createScreenGuard();
  const here = screen.enter();
  screen.dispose();
  assert.equal(screen.isCurrent(here), false);
});

test('a timer counts down, and at expiry says the answer can still be sent', () => {
  assert.deepEqual(timerState(0, 30), { label: '30s left', overTime: false });
  assert.deepEqual(timerState(29_100, 30), { label: '1s left', overTime: false });
  assert.deepEqual(timerState(30_000, 30), { label: 'Over time by 0s — you can still send', overTime: true });
  assert.deepEqual(timerState(45_000, 30), { label: 'Over time by 15s — you can still send', overTime: true });
});

test('no timer means no clock at all', () => {
  assert.deepEqual(timerState(99_000, null), { label: '', overTime: false });
});

test('a card draft is prefilled with the question that turn answered, and never with an answer', () => {
  const turns = [
    { index: 1, role: 'counterpart', text: 'Why freeze the body?' },
    { index: 2, role: 'learner', text: 'To save memory.' },
    { index: 3, role: 'counterpart', text: '', refusal: true },
    { index: 4, role: 'learner', text: 'Because the head is random.' },
  ];
  assert.deepEqual(cardDrafts(turns), [
    { turn_index: 2, front: 'Why freeze the body?', said: 'To save memory.' },
    // A refused turn asked nothing, so the last real question stands.
    { turn_index: 4, front: 'Why freeze the body?', said: 'Because the head is random.' },
  ]);
});

test('counterpart turns and summary drafts are never offered as stumbles', () => {
  const turns = [
    { index: 1, role: 'counterpart', text: 'What is your goal?' },
    { index: 3, role: 'counterpart', text: 'Goal: pass.', kind: 'summary_draft' },
  ];
  assert.deepEqual(cardDrafts(turns), []);
});

test('a diagnosis says what it used and names each reason something was left out', () => {
  assert.deepEqual(evidenceLines({
    misses_sent: 3, distinct_questions: 2,
    left_out: { pending: 1, deck_changed: 2, deck_missing: 0, no_deck_hash: 0, over_limit: 0 },
  }), [
    'Used 3 recorded misses across 2 questions.',
    'Left out 1: still waiting for a self-grade.',
    'Left out 2: the deck was edited after the attempt.',
  ]);
  assert.deepEqual(evidenceLines({ misses_sent: 1, distinct_questions: 1, left_out: {} }), ['Used 1 recorded miss across 1 question.']);
  assert.deepEqual(evidenceLines(undefined), []);
});

test('a session line states role, date, and either the outcome or that it is in progress', () => {
  assert.equal(sessionLine({ role: 'socratic', started: '2026-10-11T14:00:00.000Z', status: 'open' }),
    'Socratic questioner · 2026-10-11 · in progress');
  assert.equal(sessionLine({ role: 'interviewer', started: '2026-10-11T14:00:00.000Z', status: 'closed', turn_count: 1, cost_usd: 0.0412 }),
    'Interviewer · 2026-10-11 · 1 turn · $0.04');
});

test('cost is shown to the cent', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(1.999), '$2.00');
  assert.equal(formatCost(undefined), '$0.00');
});
