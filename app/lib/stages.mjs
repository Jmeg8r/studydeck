// WHAT: Which study stages are actually done, and which one you owe next.
// WHY: The cockpit used to read completion off the calendar — `timelineFor` marked every
//      milestone before today "done", and the queue dropped a milestone once its day
//      passed, so an unfinished day-7 quiz vanished when day 10 arrived. The spec says the
//      opposite (tasks/study-flow.md): "Slippage is fine; order + spacing matter, exact
//      days don't." A date model cannot express that; it can only express dates.
//
// So a scheduled date is a NOT-BEFORE date, never evidence. A stage is done when a
// completion event says so, and an owed stage stays owed however long it sits.
//
// Pure: everything here is a function of (schedule, events, reference date). Nothing reads
// the filesystem, so the rules are testable without a server.
import { MILESTONES, addDays, daysBetween, dateForDay, todayISO } from './schedule.mjs';

/** Stage states, in the order the UI ranks them. */
export const STAGE_STATE = {
  DONE: 'done', // a completion event says so
  NOW: 'now', // the first incomplete stage whose date has arrived — your one next action
  OWED: 'owed', // reachable and incomplete, but behind an earlier incomplete stage
  AHEAD: 'ahead', // its date has not arrived yet
};

const COMPLETE = 'complete';
const UNDO = 'undo';

/**
 * Collapse the event log into "is this stage complete right now".
 *
 * Undo is an event rather than a deletion, so the log stays auditable — you can see that a
 * stage was marked done and then walked back, which a mutated record would hide. Latest
 * event wins; file order is the tiebreak, matching how attempts fold.
 */
export function foldStageEvents(events = []) {
  const byKey = new Map();
  for (const event of events) {
    if (!event?.milestone_key) continue;
    if (event.action !== COMPLETE && event.action !== UNDO) continue;
    byKey.set(event.milestone_key, event);
  }

  const state = new Map();
  for (const [key, event] of byKey) {
    state.set(key, {
      complete: event.action === COMPLETE,
      completed_on: event.action === COMPLETE ? String(event.ts ?? '').slice(0, 10) || null : null,
      note: event.note ?? null,
    });
  }
  return state;
}

/**
 * Every milestone, decorated with whether it is done, reachable, and how long it is owed.
 *
 * A paused or unstarted topic has no dates at all, so nothing is reachable — the schedule
 * is not running, which is different from being behind on it.
 */
export function stageStatesFor(schedule, events = [], referenceISO = todayISO()) {
  const completion = foldStageEvents(events);
  const running = Boolean(schedule?.started) && !schedule?.paused;
  const overrides = schedule?.step_overrides ?? {};

  // The first incomplete milestone whose not-before date has arrived. Everything after it
  // is blocked behind it — visible, ordered, but not the thing to do next.
  let claimedNow = false;
  // The latest effective date assigned so far. See the clamp below.
  let floor = null;

  return MILESTONES.map((milestone) => {
    const done = completion.get(milestone.key) ?? { complete: false, completed_on: null, note: null };
    const scheduledDate = running ? dateForDay(schedule.started, milestone.day) : null;
    const override = running && isDateString(overrides[milestone.key]) ? overrides[milestone.key] : null;

    // A rescheduled stage cannot drag the pipeline out of order. Dates from the table are
    // monotonic by construction, and the "first reachable incomplete is NOW" rule below
    // silently depends on that: push `map` a week out while `walk` keeps its old date, and
    // `walk` becomes reachable first, so the cockpit would tell you to go walking about
    // material you have not mapped yet. Clamping each stage to no earlier than the one
    // before it restores the guarantee the table used to provide for free. The spec is
    // explicit that this is the property that matters — "order + spacing matter, exact days
    // don't" — so ORDER is the thing an override must never be able to buy.
    const requested = override ?? scheduledDate;
    const dueDate = requested && floor && requested < floor ? floor : requested;
    // Only INCOMPLETE stages raise the floor. A finished stage constrains nothing — it is
    // already behind you — and letting one contribute is actively harmful: put a far-future
    // override on a completed `prime` and it would push every remaining stage out with it,
    // making a running pipeline unreachable for a stage nobody still owes.
    if (dueDate && !done.complete) floor = dueDate;
    // Negative days-until means the date has passed; 0 means it arrived today.
    const owedDays = dueDate ? daysBetween(dueDate, referenceISO) : null;
    const reachable = owedDays !== null && owedDays >= 0;

    let state;
    if (done.complete) {
      state = STAGE_STATE.DONE;
    } else if (!reachable) {
      state = STAGE_STATE.AHEAD;
    } else if (!claimedNow) {
      state = STAGE_STATE.NOW;
      claimedNow = true;
    } else {
      state = STAGE_STATE.OWED;
    }

    return {
      day: milestone.day,
      key: milestone.key,
      label: milestone.label,
      title: milestone.title,
      detail: milestone.detail,
      steps: milestone.steps,
      view: milestone.view,
      // These remain schedule instructions only. Their presence in state tells Today
      // where a learner can resume; it never turns an observed visit into completion.
      primary_action: milestone.primary_action,
      secondary_action: milestone.secondary_action ?? null,
      due_date: dueDate,
      // What the spec's table said, so the UI can show that a date was moved rather than
      // quietly presenting the new one as if it had always been the plan.
      scheduled_date: scheduledDate,
      rescheduled: Boolean(dueDate && scheduledDate && dueDate !== scheduledDate),
      complete: done.complete,
      completed_on: done.completed_on,
      note: done.note,
      state,
      // Only meaningful once reachable: how long this has been sitting undone.
      owed_days: reachable ? owedDays : null,
    };
  });
}

/** A real YYYY-MM-DD, round-tripped — `2026-02-31` matches the pattern and is not a date. */
export function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Overrides that re-anchor every INCOMPLETE stage from a given date, keeping the spec's
 * spacing between them.
 *
 * This is the answer to the case that motivated overrides at all: come back from a
 * fortnight away and every stage is owed at once, which is honest but useless — the queue
 * says "do nine things today". Re-anchoring moves the remaining pipeline forward as a unit
 * so the spacing that does the actual work is preserved.
 *
 * Completed stages are deliberately left alone: their dates are history, and rewriting
 * history to make a schedule tidy is how a study record stops being evidence.
 */
export function reanchorOverrides(schedule, events = [], fromISO) {
  const completion = foldStageEvents(events);
  const incomplete = MILESTONES.filter((m) => !(completion.get(m.key)?.complete));
  // Preserve what is already stored rather than returning a bare {}. Inert today — with
  // nothing incomplete there is no floor left to affect — but this function's own contract
  // is that completed stages' dates are history, and silently dropping them contradicts it.
  if (incomplete.length === 0) return { ...(schedule?.step_overrides ?? {}) };

  const firstDay = incomplete[0].day;
  const overrides = { ...(schedule?.step_overrides ?? {}) };
  for (const milestone of incomplete) {
    overrides[milestone.key] = addDays(fromISO, milestone.day - firstDay);
  }
  return overrides;
}

/** Your one next action: the first incomplete stage that is due, else the next one up. */
export function firstIncomplete(states) {
  return (
    states.find((s) => s.state === STAGE_STATE.NOW)
    ?? states.find((s) => s.state === STAGE_STATE.AHEAD)
    ?? null
  );
}

/** Everything still owed, oldest first — the queue's backbone. */
export const owedStages = (states) =>
  states.filter((s) => s.state === STAGE_STATE.NOW || s.state === STAGE_STATE.OWED);

/** Whether the whole pipeline has been worked through. */
export const allComplete = (states) => states.every((s) => s.complete);

/**
 * Activity recorded at or after a stage became due.
 *
 * Deliberately NOT used to decide anything: it is shown next to the stage so you can
 * remember what you did before clicking "Mark done". Inferring completion from these
 * counts would be the same failure as inferring it from the calendar — a plausible guess
 * presented as a fact — which is exactly what this module exists to stop.
 */
export function activitySince(
  dueDateISO,
  {
    attempts = [], reviews = [], cards = [], mindmaps = [], debriefs = [],
    practice_evidence: practiceEvidence = [], teachbacks = [],
  },
) {
  if (!dueDateISO) return null;
  // Schedule dates are local calendar dates. ISO instants need the same conversion;
  // slicing their UTC prefix would count a late-evening local activity as tomorrow.
  const activityDate = (value) => {
    const raw = String(value ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : todayISO(parsed);
  };
  const since = (ts) => activityDate(ts) >= dueDateISO;

  return {
    attempts: attempts.filter((a) => since(a.ts)).length,
    reviews: reviews.filter((r) => since(r.ts)).length,
    cards: cards.filter((c) => since(c.created)).length,
    mindmap_runs: mindmaps.filter((m) => since(m.ts)).length,
    debriefs: debriefs.filter((d) => since(d.ts)).length,
    practice_evidence: practiceEvidence.filter((event) => since(event.ts)).length,
    teachbacks: teachbacks.filter((event) => since(event.ts)).length,
  };
}
