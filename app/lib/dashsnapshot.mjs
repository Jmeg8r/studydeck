// WHAT: The six row sets the StudyDeck progress dashboard reads, built from the learn tree.
// WHY: The dashboard can't reach .learn/, so it reads a snapshot. Every fact here comes
//      through the cockpit's own readers — stageStatesFor for stages (rule 11), the folded
//      readAttempts for attempts (rule 9) — so the dashboard can't disagree with the
//      cockpit. Read-only, and no deck question, answer, card face or miss id is copied
//      (rule 7): attempts carry a miss COUNT, cards a count of creations.
import { isObservedPractice, isObservedTeachback } from './derive.mjs';
import { flattenConcepts, readTopicState } from './learn.mjs';
import { daysBetween, todayISO } from './schedule.mjs';
import {
  isFinalAttempt, readAttempts, readCards, readOperations, readPracticeEvents, readReading, readReviews,
  readSchedule, readStageEvents, readTeachbackEvents,
} from './sidecar.mjs';
import { STAGE_STATE, stageStatesFor } from './stages.mjs';

/** Snapshot key → file name. The dashboard's datasets are attached under these names. */
export const SNAPSHOT_FILES = {
  topics: 'studydeck-topics.json',
  stages: 'studydeck-stages.json',
  concepts: 'studydeck-concepts.json',
  attempts: 'studydeck-attempts.json',
  activity: 'studydeck-activity.json',
  reading: 'studydeck-reading.json',
};

// Completed Open Notebook operations that count as study activity. Housekeeping such as
// deleting an episode or drafting a summary request is left out rather than mislabelled.
// A podcast operation completes when ON ACCEPTS the job, not when it renders, so it is
// a request here; the job can still fail afterwards.
const OPERATION_ACTIVITY = {
  open_notebook_source: 'Source imported',
  open_notebook_note: 'Note saved',
  mindmap_note: 'Note saved',
  debrief: 'Debrief',
  podcast_episode: 'Podcast requested',
  podcast_standalone: 'Podcast requested',
};

const titleCase = (label) => label.charAt(0) + label.slice(1).toLowerCase();

// A bare date is already a local calendar date; an instant is converted the way
// stages.mjs converts them, so a late-evening event lands on the day it happened.
function localDay(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : todayISO(parsed);
}

function scheduleLabel(schedule) {
  if (!schedule.started) return 'Not started';
  return schedule.paused ? 'Paused' : 'Running';
}

function stageRows(topic, schedule, events, referenceISO) {
  const running = Boolean(schedule.started) && !schedule.paused;
  const idle = schedule.started ? 'paused' : 'not started';
  return stageStatesFor(schedule, events, referenceISO).map((s) => ({
    topic,
    key: s.key,
    stage: titleCase(s.label),
    day: s.day,
    not_before: s.due_date,
    // stageStatesFor calls every stage of a stopped schedule AHEAD; the dashboard says why.
    state: s.complete || running ? s.state : idle,
    owed_days: s.owed_days,
    completed_on: s.completed_on,
  }));
}

function activityRows(topic, sources) {
  const rows = [];
  const add = (value, kind) => {
    const day = localDay(value);
    if (day) rows.push({ day, topic, kind });
  };
  for (const a of sources.attempts) add(a.ts, isFinalAttempt(a) ? 'Graded attempt' : 'Attempt awaiting grade');
  for (const c of sources.cards) add(c.created, 'Flashcard created');
  for (const r of sources.reviews) add(r.ts, 'Flashcard review');
  for (const p of sources.practice.filter(isObservedPractice)) add(p.ts, 'Practice');
  for (const t of sources.teachbacks.filter(isObservedTeachback)) add(t.ts, 'Teach-back');
  for (const e of sources.stageEvents) add(e.ts, 'Stage event');
  for (const o of sources.operations) {
    const kind = OPERATION_ACTIVITY[o.kind];
    if (kind && o.stage === 'complete') add(o.ts, kind);
  }
  for (const r of Object.values(sources.reading)) add(r.updated, 'Reading');
  for (const c of sources.concepts) add(c.last_activity, 'Concept practiced');
  return rows;
}

/** Build every row set for the given topic slugs, as of `referenceISO`. */
export function buildDashboardSnapshot(slugs, referenceISO = todayISO(), rings = {}) {
  const snapshot = Object.fromEntries(Object.keys(SNAPSHOT_FILES).map((k) => [k, []]));

  for (const slug of slugs) {
    const state = readTopicState(slug);
    const topic = state.topic;
    const schedule = readSchedule(slug);
    const stageEvents = readStageEvents(slug);

    const stages = stageRows(topic, schedule, stageEvents, referenceISO);
    const concepts = flattenConcepts(state).map((c) => ({
      topic,
      domain: c.domain_name,
      concept: c.name,
      status: c.status,
      confidence: c.confidence,
      practice_count: c.practice_count,
      explain_count: c.explain_count,
      last_activity: [c.last_practiced, c.last_explained].filter(Boolean).sort().at(-1) ?? null,
    }));
    const attempts = readAttempts(slug).map((a) => ({
      topic,
      ts: a.ts,
      kind: a.kind ?? null,
      status: a.status ?? 'final',
      concept: a.concept_slug ?? null,
      score: a.score ?? null,
      max: a.max ?? null,
      pct: a.max ? Math.round((a.score / a.max) * 10_000) / 10_000 : null,
      misses: Array.isArray(a.misses) ? a.misses.length : 0,
    }));
    const cards = readCards(slug);
    const reading = readReading(slug);
    const activity = activityRows(topic, {
      attempts, cards, concepts, reading, stageEvents,
      reviews: readReviews(slug),
      practice: readPracticeEvents(slug),
      teachbacks: readTeachbackEvents(slug),
      operations: readOperations(slug),
    });

    const next = stages.find((s) => s.state === STAGE_STATE.NOW) ?? stages.find((s) => s.state !== STAGE_STATE.DONE);
    const lastActivity = activity.map((a) => a.day).sort().at(-1) ?? null;
    snapshot.topics.push({
      topic,
      slug,
      ring: rings[slug] ?? null,
      created: state.created,
      schedule: scheduleLabel(schedule),
      day_n: schedule.started && !schedule.paused ? daysBetween(schedule.started, referenceISO) : null,
      concepts: concepts.length,
      touched: concepts.filter((c) => c.status !== 'unexplored').length,
      mastered: concepts.filter((c) => c.status === 'mastered').length,
      avg_confidence: concepts.length
        ? Math.round((concepts.reduce((sum, c) => sum + c.confidence, 0) / concepts.length) * 10_000) / 10_000
        : null,
      attempts: attempts.length,
      cards: cards.length,
      stages_done: stages.filter((s) => s.state === STAGE_STATE.DONE).length,
      stages_owed: stages.filter((s) => s.state === STAGE_STATE.NOW || s.state === STAGE_STATE.OWED).length,
      next_stage: next?.stage ?? null,
      last_activity: lastActivity,
    });

    snapshot.stages.push(...stages);
    snapshot.concepts.push(...concepts);
    snapshot.attempts.push(...attempts);
    snapshot.activity.push(...activity);
    for (const r of Object.values(reading)) {
      snapshot.reading.push({
        topic,
        source: r.title ?? null,
        position: Math.round((r.position ?? 0) * 10_000) / 10_000,
        updated: localDay(r.updated),
      });
    }
  }

  snapshot.activity.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return snapshot;
}
