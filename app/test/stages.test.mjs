// WHAT: Tests for the stage-completion model in lib/stages.mjs (assessment finding F1).
// WHY: The cockpit used to read completion off the calendar — `timelineFor` painted every
//      milestone before today "done", and the queue kept only the current calendar
//      milestone, so an unfinished day-7 quiz silently vanished when day 10 arrived. The
//      product then implied progress that never happened and advanced past required
//      retrieval work without anyone deciding to.
//
//      tasks/study-flow.md is explicit that order and spacing matter and exact days do
//      not. These tests pin that reading: a date makes a stage AVAILABLE, only an event
//      makes it DONE, and an owed stage stays owed however long it sits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MILESTONES } from '../lib/schedule.mjs';
import {
  STAGE_STATE, activitySince, allComplete, firstIncomplete, foldStageEvents, owedStages,
  reanchorOverrides, stageStatesFor,
} from '../lib/stages.mjs';

const RUNNING = { started: '2026-07-18', paused: false };
const complete = (key, ts) => ({ ts, milestone_key: key, action: 'complete' });
const undo = (key, ts) => ({ ts, milestone_key: key, action: 'undo' });

const byKey = (states, key) => states.find((s) => s.key === key);

// ---------- folding ----------

test('the latest event per stage wins, so undo reopens it', () => {
  const folded = foldStageEvents([
    complete('prime', '2026-07-18T10:00:00Z'),
    complete('study', '2026-07-19T10:00:00Z'),
    undo('prime', '2026-07-20T10:00:00Z'),
  ]);

  assert.equal(folded.get('prime').complete, false);
  assert.equal(folded.get('study').complete, true);
  assert.equal(folded.get('study').completed_on, '2026-07-19');
});

test('a re-completion after an undo counts, and keeps the newer date', () => {
  const folded = foldStageEvents([
    complete('prime', '2026-07-18T10:00:00Z'),
    undo('prime', '2026-07-19T10:00:00Z'),
    complete('prime', '2026-07-25T10:00:00Z'),
  ]);
  assert.equal(folded.get('prime').complete, true);
  assert.equal(folded.get('prime').completed_on, '2026-07-25');
});

test('malformed events are ignored rather than guessed at', () => {
  const folded = foldStageEvents([
    { ts: 'x', action: 'complete' }, // no milestone_key
    { ts: 'x', milestone_key: 'prime', action: 'sneeze' }, // unknown action
    null,
  ]);
  assert.equal(folded.size, 0);
});

// ---------- the finding itself ----------

test('an unfinished stage stays owed when a later one comes due — F1', () => {
  // Day 10. Under the old model day 7 was "done" because the date passed, and the queue
  // had already moved on to day 10.
  const states = stageStatesFor(RUNNING, [], '2026-07-28');

  const quiz = byKey(states, 'quiz'); // day 7
  const present = byKey(states, 'present'); // day 10
  assert.equal(quiz.complete, false, 'a passed date must never mean done');
  assert.equal(present.state, STAGE_STATE.OWED, 'later reachable work queues behind it');
  assert.equal(byKey(states, 'prime').state, STAGE_STATE.NOW, 'the oldest unfinished stage leads');
});

test('owed stages are ordered oldest-first and none is dropped', () => {
  const states = stageStatesFor(RUNNING, [], '2026-07-28');
  const owed = owedStages(states);

  // Days 0,1,2,3,4,7,10 have all come due by day 10; 14 and 30 have not.
  assert.deepEqual(owed.map((s) => s.day), [0, 1, 2, 3, 4, 7, 10]);
  assert.equal(owed[0].state, STAGE_STATE.NOW);
  assert.ok(owed.slice(1).every((s) => s.state === STAGE_STATE.OWED));
});

test('completing the leader promotes the next owed stage', () => {
  const done = MILESTONES.slice(0, 5).map((m) => complete(m.key, '2026-07-25T10:00:00Z'));
  const states = stageStatesFor(RUNNING, done, '2026-07-28');

  assert.equal(firstIncomplete(states).key, 'quiz', 'day 7 is now the action');
  assert.equal(byKey(states, 'quiz').owed_days, 3, 'due 2026-07-25, three days ago');
});

test('owed days grow with time and never reset', () => {
  const states = stageStatesFor(RUNNING, [], '2026-09-01');
  // 45 days after the start, the day-7 quiz is 38 days owed — the pipeline does not
  // quietly move on.
  assert.equal(byKey(states, 'quiz').owed_days, 38);
  assert.equal(byKey(states, 'teach').state, STAGE_STATE.OWED, 'even the day-30 stage is reachable now');
});

// ---------- not-before dates ----------

test('a stage that has not come due is ahead, not owed', () => {
  const states = stageStatesFor(RUNNING, [], '2026-07-20'); // day 2

  // Day 0 still leads because nothing is done; day 2 has come due but queues behind it.
  assert.equal(byKey(states, 'prime').state, STAGE_STATE.NOW);
  assert.equal(byKey(states, 'map').state, STAGE_STATE.OWED, 'reachable, but behind an older one');
  assert.equal(byKey(states, 'map').owed_days, 0, 'came due today');

  // Day 3 has NOT come due — a different thing from being behind on it.
  assert.equal(byKey(states, 'walk').state, STAGE_STATE.AHEAD);
  assert.equal(byKey(states, 'walk').owed_days, null);
});

test('the leader is the oldest unfinished stage, not the newest reachable one', () => {
  // Day 2 done, day 0 and 1 skipped. Order matters, so the queue goes back for them.
  const states = stageStatesFor(RUNNING, [complete('map', '2026-07-20T10:00:00Z')], '2026-07-20');
  assert.equal(firstIncomplete(states).key, 'prime');
  assert.equal(byKey(states, 'map').state, STAGE_STATE.DONE);
});

test('finishing everything reachable leaves nothing owed and no action', () => {
  const done = MILESTONES.filter((m) => m.day <= 2).map((m) => complete(m.key, '2026-07-20T10:00:00Z'));
  const states = stageStatesFor(RUNNING, done, '2026-07-20');

  assert.deepEqual(owedStages(states), []);
  assert.equal(firstIncomplete(states).key, 'walk', 'the next stage, not yet due');
  assert.equal(firstIncomplete(states).state, STAGE_STATE.AHEAD);
  assert.equal(allComplete(states), false);
});

test('a paused or unstarted topic has no due dates at all', () => {
  for (const schedule of [{ started: '2026-07-18', paused: true }, { started: null, paused: false }]) {
    const states = stageStatesFor(schedule, [], '2026-07-28');
    assert.ok(states.every((s) => s.due_date === null));
    assert.ok(states.every((s) => s.state === STAGE_STATE.AHEAD), 'not running is not the same as behind');
    assert.deepEqual(owedStages(states), []);
  }
});

test('completions survive a pause — the work stays done', () => {
  const states = stageStatesFor(
    { started: '2026-07-18', paused: true },
    [complete('prime', '2026-07-18T10:00:00Z')],
    '2026-07-28',
  );
  assert.equal(byKey(states, 'prime').state, STAGE_STATE.DONE);
});

test('allComplete only when every stage has an event', () => {
  const all = MILESTONES.map((m) => complete(m.key, '2026-08-20T10:00:00Z'));
  assert.equal(allComplete(stageStatesFor(RUNNING, all, '2026-08-20')), true);
  assert.equal(allComplete(stageStatesFor(RUNNING, all.slice(0, -1), '2026-08-20')), false);
});

// ---------- observed activity ----------

test('activitySince counts work at or after the due date, and nothing before it', () => {
  const observed = activitySince('2026-07-25', {
    attempts: [{ ts: '2026-07-24T23:00:00Z' }, { ts: '2026-07-25T09:00:00Z' }, { ts: '2026-07-27T09:00:00Z' }],
    reviews: [{ ts: '2026-07-26T09:00:00Z' }],
    cards: [{ created: '2026-07-20' }],
    mindmaps: [{ ts: '2026-07-25T12:00:00Z' }],
    debriefs: [],
    practice_evidence: [{ ts: '2026-07-25T15:00:00Z' }, { ts: '2026-07-24T15:00:00Z' }],
    teachbacks: [{ ts: '2026-07-25T16:00:00Z' }, { ts: '2026-07-24T16:00:00Z' }],
  });

  assert.equal(observed.attempts, 2, 'the day before does not count');
  assert.equal(observed.reviews, 1);
  assert.equal(observed.cards, 0);
  assert.equal(observed.mindmap_runs, 1);
  assert.equal(observed.debriefs, 0);
  assert.equal(observed.practice_evidence, 1);
  assert.equal(observed.teachbacks, 1);
});

test('activitySince is null without a due date, so nothing is implied about a paused topic', () => {
  assert.equal(activitySince(null, { attempts: [{ ts: '2026-07-27T09:00:00Z' }] }), null);
});

test('teach-back activity uses the schedule\'s local calendar date across a UTC midnight', () => {
  // The app's schedule deliberately uses local YYYY-MM-DD dates. Run this tiny isolated
  // process in Pacific time so CI's host timezone cannot turn the boundary into a no-op:
  // 02:30Z on Aug 14 is still Aug 13 locally and must not count for an Aug 14 stage.
  const script = [
    "import { activitySince } from './app/lib/stages.mjs';",
    "const observed = activitySince('2026-08-14', { teachbacks: [{ ts: '2026-08-14T02:30:00.000Z' }] });",
    'process.stdout.write(String(observed.teachbacks));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '0');
});

test('every stage reads the same activity snapshot', () => {
  // The sources are read once and shared across all nine stages. Reading them per stage
  // meant nine file reads per topic per request, and nine snapshots that could disagree
  // with each other inside one render.
  const sources = {
    attempts: [{ ts: '2026-07-26T09:00:00Z' }],
    reviews: [], cards: [], mindmaps: [], debriefs: [],
  };
  const states = stageStatesFor(RUNNING, [], '2026-07-28');
  const counts = states
    .filter((s) => s.due_date && s.due_date <= '2026-07-26')
    .map((s) => activitySince(s.due_date, sources).attempts);

  assert.ok(counts.every((n) => n === 1), 'one attempt, counted once per stage that predates it');
});

test('observed activity never marks a stage complete', () => {
  // The whole point: plenty of recorded work, still not done. Inferring completion from
  // this would be the same failure as inferring it from the calendar.
  const states = stageStatesFor(RUNNING, [], '2026-07-28');
  assert.equal(byKey(states, 'quiz').complete, false);
});

/* ------------------------------------------------------------------ */
/*  Rescheduling (roadmap B1)                                          */
/*                                                                     */
/*  `step_overrides` sat in DEFAULT_SCHEDULE unread since the schedule */
/*  shipped. The hazard in wiring it up is not the date arithmetic —   */
/*  it is that a reschedule must never become evidence. Hard rule 11   */
/*  says a stage is complete only when an event says so, and moving a  */
/*  date is the most natural-looking way to accidentally break that.   */
/* ------------------------------------------------------------------ */

test('an override moves a stage\'s not-before date', () => {
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { study: '2026-07-09' } };
  const states = stageStatesFor(schedule, [], '2026-07-20');
  const study = states.find((s) => s.key === 'study');

  assert.equal(study.due_date, '2026-07-09');
  assert.equal(study.scheduled_date, '2026-07-02');
  assert.equal(study.rescheduled, true);
});

test('an overridden stage that was never completed is STILL OWED', () => {
  // The whole point. Moving a date changes when a stage becomes reachable and nothing
  // else — a reschedule that tidied a stage away would invert hard rule 11.
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { prime: '2026-07-05' } };
  const states = stageStatesFor(schedule, [], '2026-07-20');
  const prime = states.find((s) => s.key === 'prime');

  assert.equal(prime.complete, false);
  assert.equal(prime.state, 'now');
  assert.equal(prime.owed_days, 15, 'owed days should count from the NEW date, not the old one');
});

test('a stage pushed into the future is AHEAD, not silently skipped', () => {
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { prime: '2026-08-01' } };
  const states = stageStatesFor(schedule, [], '2026-07-20');
  const prime = states.find((s) => s.key === 'prime');

  assert.equal(prime.state, 'ahead');
  assert.equal(prime.complete, false);
  // And it is still in the list — a stage you pushed out has not left the pipeline.
  assert.equal(states.length, MILESTONES.length);
});

test('an override CANNOT reorder the pipeline', () => {
  // The hazard that makes this more than date arithmetic. The table's dates are monotonic,
  // and "the first reachable incomplete stage is NOW" silently depends on that. Push `map`
  // a week out while `walk` keeps its old date and, unclamped, `walk` becomes reachable
  // first — the cockpit would send you walking about material you have not mapped.
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { map: '2026-07-20' } };
  const states = stageStatesFor(schedule, [], '2026-07-25');

  const dates = states.map((s) => s.due_date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, `stage dates went out of order: ${dates.join(' ')}`);

  const walk = states.find((s) => s.key === 'walk');
  assert.ok(walk.due_date >= '2026-07-20', 'walk was reachable before the map it depends on');
});

test('clamping marks the dragged stages as rescheduled too, rather than lying about the plan', () => {
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { map: '2026-07-20' } };
  const walk = stageStatesFor(schedule, [], '2026-07-25').find((s) => s.key === 'walk');
  assert.equal(walk.rescheduled, true);
  assert.equal(walk.scheduled_date, '2026-07-04', 'the original date must still be visible');
});

test('a garbage override is ignored, not obeyed', () => {
  // 2026-02-31 matches the pattern and is not a date; obeying it would produce a null due
  // date, which reads as "not running" for a topic that plainly is.
  for (const bad of ['2026-02-31', 'tomorrow', '', null, 42]) {
    const schedule = { started: '2026-07-01', paused: false, step_overrides: { study: bad } };
    const study = stageStatesFor(schedule, [], '2026-07-20').find((s) => s.key === 'study');
    assert.equal(study.due_date, '2026-07-02', `override ${JSON.stringify(bad)} was obeyed`);
    assert.equal(study.rescheduled, false);
  }
});

test('reanchoring moves every INCOMPLETE stage and preserves the spec spacing', () => {
  // The case overrides exist for: back from a fortnight away, everything owed at once, and
  // a queue saying "do nine things today" is useless however honest it is.
  const schedule = { started: '2026-07-01', paused: false };
  const events = [{ ts: '2026-07-01T10:00:00Z', milestone_key: 'prime', action: 'complete' }];
  const overrides = reanchorOverrides(schedule, events, '2026-07-20');

  assert.equal(overrides.prime, undefined, 'a completed stage was rewritten');
  // study is day 1 and the first incomplete, so it anchors to the given date; the rest keep
  // their spacing relative to it (map day 2 → +1, walk day 3 → +2, teach day 30 → +29).
  assert.equal(overrides.study, '2026-07-20');
  assert.equal(overrides.map, '2026-07-21');
  assert.equal(overrides.walk, '2026-07-22');
  assert.equal(overrides.teach, '2026-08-18');
});

test('reanchoring a finished pipeline changes nothing', () => {
  const events = MILESTONES.map((m) => ({ ts: '2026-07-01T10:00:00Z', milestone_key: m.key, action: 'complete' }));
  assert.deepEqual(reanchorOverrides({ started: '2026-07-01', paused: false }, events, '2026-08-01'), {});
});

test('reanchoring still does not complete anything', () => {
  const schedule = { started: '2026-07-01', paused: false };
  const rescheduled = { ...schedule, step_overrides: reanchorOverrides(schedule, [], '2026-07-20') };
  const states = stageStatesFor(rescheduled, [], '2026-07-20');

  assert.equal(states.filter((s) => s.complete).length, 0);
  // Exactly one thing to do today, which is the entire improvement over nine owed at once.
  assert.equal(states.filter((s) => s.state === 'now').length, 1);
  assert.equal(states.filter((s) => s.state === 'owed').length, 0);
});

test('overrides are inert while the topic is paused or unstarted', () => {
  const overrides = { study: '2026-07-09' };
  for (const schedule of [
    { started: '2026-07-01', paused: true, step_overrides: overrides },
    { started: null, paused: false, step_overrides: overrides },
  ]) {
    const study = stageStatesFor(schedule, [], '2026-07-20').find((s) => s.key === 'study');
    assert.equal(study.due_date, null);
    assert.equal(study.rescheduled, false);
  }
});

test('a COMPLETED stage never raises the floor for the ones still owed', () => {
  // Review finding on #47. The clamp preserves order among work you still owe; a finished
  // stage constrains nothing, because it is already behind you. Letting one contribute is
  // actively harmful: a far-future override on a completed `prime` would drag every
  // remaining stage out with it and make a running pipeline unreachable for the sake of a
  // stage nobody owes.
  const schedule = { started: '2026-07-01', paused: false, step_overrides: { prime: '2027-01-01' } };
  const events = [{ ts: '2026-07-01T10:00:00Z', milestone_key: 'prime', action: 'complete' }];
  const states = stageStatesFor(schedule, events, '2026-07-20');

  assert.equal(byKey(states, 'prime').state, STAGE_STATE.DONE);
  assert.equal(byKey(states, 'study').due_date, '2026-07-02', 'a finished stage pushed a live one out');
  assert.equal(byKey(states, 'study').state, STAGE_STATE.NOW, 'the pipeline became unreachable');
});

test('reanchoring an already-finished pipeline preserves stored overrides', () => {
  // It returned a bare {} before, silently dropping history this function's own doc comment
  // promises to leave alone. Inert today — nothing incomplete remains to be clamped — but
  // a function that contradicts its contract only when unobserved is a latent bug.
  const stored = { prime: '2026-07-05' };
  const events = MILESTONES.map((m) => ({ ts: '2026-07-01T10:00:00Z', milestone_key: m.key, action: 'complete' }));
  const result = reanchorOverrides({ started: '2026-07-01', paused: false, step_overrides: stored }, events, '2026-08-01');
  assert.deepEqual(result, stored);
});
