// WHAT: Assembles the single /api/state payload the frontend renders.
// WHY: Everything here is DERIVED on each request from state.json + sidecars +
//      the schedule table. Nothing derived is ever written back to disk, so there
//      is exactly one source of truth per fact and no cache to fall out of date.
import { config } from './config.mjs';
import { flattenConcepts, listDecks, listPracticeArtifacts, readTopicState, statusCounts } from './learn.mjs';
import {
  isFinalAttempt, readAttempts, readCards, readDebriefs, readMindMaps, readMisconceptionEvents, readReading, readReviews,
  readPracticeEvents, readSchedule, readStageEvents, readTeachbackEvents,
} from './sidecar.mjs';
import { deriveCards } from './cards.mjs';
import { buildWeakness } from './stats.mjs';
import { lapseRate } from './lapse.mjs';
import { conceptEvidence, itemRetentionEvidence, misconceptionCandidates, quizConfidenceEvidence } from './evidence.mjs';
import { activitySince, allComplete, stageStatesFor } from './stages.mjs';
import { FINAL_DAY, positionFor, timelineFor, todayISO } from './schedule.mjs';
import { latestPracticeEvidenceByConcept } from './practice.mjs';
import { latestTeachback } from './teachback.mjs';

const QUEUE_WINDOW_DAYS = 7;

// Opening a solution and rejecting an unfinished task are honest history, but neither
// is observed practice. Only a learner-confirmed evidence record counts as activity —
// and even that never completes a stage. Shared with the dashboard snapshot.
export const isObservedPractice = (event) => event?.event_type === 'evidence_recorded'
  && event.outcome === 'confirmed';

// As with practice, a confirmed teach-back is descriptive activity. Qualification is
// displayed with the record but is not consulted by the stage state machine.
export const isObservedTeachback = (event) => event?.event_type === 'teachback_recorded'
  && event.outcome === 'confirmed';

function buildTopic(topicConfig, referenceISO) {
  const { slug, ring } = topicConfig;
  const state = readTopicState(slug);
  const schedule = readSchedule(slug);
  const attempts = readAttempts(slug);
  const reviews = readReviews(slug);
  const cards = readCards(slug);
  const concepts = flattenConcepts(state);
  const itemRetention = itemRetentionEvidence(attempts);
  const misconceptions = misconceptionCandidates(attempts, readMisconceptionEvents(slug));
  const practiceEvents = readPracticeEvents(slug);
  const teachbacks = readTeachbackEvents(slug);
  const latestPracticeEvidence = latestPracticeEvidenceByConcept(practiceEvents);
  // Read once, not once per milestone: these feed the observed-activity summary for all
  // nine stages, so reading them inside the map meant nine file reads per topic per
  // request — and nine snapshots that could disagree with each other mid-render.
  const observedSources = {
    attempts,
    reviews,
    cards,
    mindmaps: readMindMaps(slug),
    debriefs: readDebriefs(slug),
    practice_evidence: practiceEvents.filter(isObservedPractice),
    teachbacks: teachbacks.filter(isObservedTeachback),
  };

  // Completion is recorded, never inferred: the calendar only decides when a stage
  // BECOMES available, and these events decide whether it is finished.
  const stages = stageStatesFor(schedule, readStageEvents(slug), referenceISO).map((stage) => ({
    ...stage,
    // Shown beside the stage so you can remember what you did before marking it done.
    // Never consulted to decide anything — see lib/stages.mjs.
    observed: activitySince(stage.due_date, { ...observedSources, attempts: attempts.filter(isFinalAttempt) }),
  }));
  const position = positionFor(schedule, stages, referenceISO);

  return {
    slug,
    ring,
    // Already in the committed config; the rail uses it to deep-link into Open Notebook's UI.
    notebook_id: topicConfig.notebookId ?? null,
    name: state.topic,
    created: state.created,
    schedule: { started: schedule.started, paused: schedule.paused },
    position,
    stages,
    timeline: timelineFor(schedule, stages, referenceISO),
    counts: statusCounts(state),
    concept_count: concepts.length,
    // Domain shape drives the mastery wheel: one ring per topic, one arc per concept.
    domains: state.domains.map((domain) => ({
      name: domain.name,
      slug: domain.slug,
      concepts: domain.concepts.map((c) => ({
        name: c.name,
        slug: c.slug,
        status: c.status,
        confidence: c.confidence,
        practice_count: c.practice_count,
        last_practiced: c.last_practiced,
      })),
    })),
    attempts,
    decks: listDecks(slug),
    // Exercise files are topic-owned learning artifacts. Listing maps only the current
    // curriculum; it never infers that an unfinished file is completed practice.
    practice_artifacts: listPracticeArtifacts(slug, concepts).map((artifact) => ({
      ...artifact,
      last_record: latestPracticeEvidence.get(artifact.concept_slug) ?? null,
    })),
    // The browser needs the reveal ledger to label an already-recorded locked file as
    // resumable. It contains metadata and learner reflections only, never protected file
    // contents; the content route independently checks the same durable event.
    practice_events: practiceEvents,
    teachbacks,
    last_teachback: latestTeachback(teachbacks),
    // Cards carry derived schedule state (due, streak, interval, miss rate);
    // the raw sidecar only ever stores content.
    cards: deriveCards(slug, referenceISO),
    reviews,
    // Misses recorded in attempts that have no card yet — the Flashcards view
    // offers to queue these rather than creating them as a side effect of a read.
    unqueued_misses: countUnqueuedMisses(attempts, cards),
    // Weakness evidence per concept/domain. Keeps "untested" distinct from "clean".
    weakness: buildWeakness(slug),
    // Confidence is evidence about calibration, not mastery. It derives solely from
    // final recorded quiz outcomes and never feeds the study plan or status counts.
    confidence_evidence: quizConfidenceEvidence(attempts),
    // Only newly persisted, server-verified answer-free quiz outcomes can establish
    // item-level retrieval evidence. This intentionally says nothing about transfer.
    item_retention_evidence: itemRetention,
    // Candidates are observed high-confidence errors, not diagnoses or repair claims.
    misconceptions,
    // Mapped-concept evidence never promotes an item repetition into concept retention
    // or transfer. It makes the remaining uncertainty and next attention explicit.
    concept_evidence: conceptEvidence(concepts, itemRetention, misconceptions),
    // The Phase 2 gate for the Anki/FSRS exporter (roadmap D-c). Derived, never stored:
    // reviews.jsonl decides, and this only reports what it says.
    lapse: lapseRate(reviews, referenceISO),
    // Reading positions by ON source id. Deliberately NOT fetched from ON here —
    // /api/state must stay fast and must not fail when ON is down.
    reading: readReading(slug),
  };
}

/**
 * How many recorded quiz misses are not yet represented by a card.
 * Takes already-loaded data — re-reading attempts.jsonl and cards.json here doubled
 * the file I/O for every topic on every /api/state request.
 */
function countUnqueuedMisses(attempts, cards) {
  const carded = new Set(cards.map((c) => c.source_ref).filter(Boolean));
  let count = 0;
  for (const attempt of attempts) {
    if (!isFinalAttempt(attempt) || attempt.kind !== 'quiz' || !attempt.deck_file) continue;
    for (const questionId of attempt.misses ?? []) {
      if (!carded.has(`${attempt.deck_file}:${questionId}`)) count += 1;
    }
  }
  return count;
}

/**
 * Which topic gets the hero slot.
 *
 * Paused topics are seeded curriculum with no clock running — never candidates.
 * Among active topics the one owing the oldest stage wins, because interleaving means the
 * thing you're behind on matters more than the thing you started last. A topic that owes
 * nothing yields to one that does, whatever the calendar says about either.
 */
function pickPrimary(topics) {
  const active = topics.filter((t) => !t.schedule.paused && t.position.dayN !== null);
  if (active.length === 0) return null;
  return active.sort((a, b) => {
    const owing = (b.position.owedDays ?? -1) - (a.position.owedDays ?? -1);
    if (owing !== 0) return owing;
    return (a.schedule.started ?? '').localeCompare(b.schedule.started ?? '');
  })[0];
}

/** The most recent graded attempt, used to surface "what you actually missed". */
function latestAttempt(topic) {
  const graded = topic.attempts.filter(isFinalAttempt);
  if (graded.length === 0) return null;
  return [...graded].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
}

function buildToday(primary) {
  if (!primary) {
    return {
      topic_slug: null,
      headline: 'No topic is on the clock',
      detail: 'Every configured topic is paused. Start one to begin its 30-day schedule.',
      steps: [],
      view: 'today',
      primary_action: null,
      secondary_action: null,
      day_label: null,
    };
  }

  const { current, next, dayN, owedDays, owedCount } = primary.position;
  const last = latestAttempt(primary);

  // `current` is the first stage you have not COMPLETED, not the last one the calendar
  // passed — so falling behind never advances the headline past work you still owe. When
  // nothing is owed, the honest answer is that the next stage has not come due yet, which
  // is a real state the old model could not represent.
  const action = current ?? next ?? null;
  const parts = [];
  if (action?.detail) parts.push(action.detail);
  if (last?.notes) parts.push(last.notes);
  else if (last) parts.push(`Last graded: ${last.score}/${last.max} on ${last.concept_slug}.`);

  const waiting = !current && next;
  // A finished pipeline is now a state the data can actually support. The old code had no
  // such state on purpose — nothing tracked whether a milestone was DONE, so claiming
  // completion would have been a guess. Recorded completions make it sayable.
  const finished = !action && allComplete(primary.stages);
  if (finished) parts.push(`All ${primary.stages.length} stages marked done.`);

  return {
    topic_slug: primary.slug,
    topic_name: primary.name,
    headline: finished
      ? `${primary.name} — pipeline complete`
      : waiting ? `Nothing owed — next up: ${next.title}` : action?.title ?? 'Start the topic',
    detail: parts.join(' '),
    steps: action?.steps ?? [],
    // The old scalar destination cannot express an ordered composite day. Keep it for
    // older callers, but make the action objects the authoritative Today contract.
    view: action?.primary_action?.view ?? action?.view ?? 'today',
    primary_action: action?.primary_action ?? null,
    secondary_action: action?.secondary_action ?? null,
    day_label: `DAY ${dayN} OF ${FINAL_DAY}`,
    // The stage the Mark-done button acts on, and how long it has been owed.
    stage_key: current?.key ?? null,
    owed_days: owedDays,
    owed_count: owedCount,
    waiting_until: waiting ? next.due_date : null,
  };
}

/**
 * Work across every active topic: everything still owed, then what is coming up.
 * Interleaved by design: once two topics are live, sessions mix them.
 *
 * An owed stage is NEVER dropped. The old queue kept only the current calendar milestone
 * and near-future ones, so an unfinished day-7 quiz silently disappeared when day 10
 * arrived — the cockpit advancing past required retrieval work without anyone deciding to.
 */
function buildQueue(topics, referenceISO) {
  const rows = [];
  for (const topic of topics) {
    const { dayN } = topic.position;
    if (topic.schedule.paused || dayN === null) continue;

    // The stage you owe first in this topic; later owed stages are queued behind it.
    const leading = topic.stages.find((s) => s.state === 'now');

    for (const stage of topic.stages) {
      const owed = stage.state === 'now' || stage.state === 'owed';
      const upcoming = stage.state === 'ahead' && stage.day > dayN && stage.day <= dayN + QUEUE_WINDOW_DAYS;
      if (!owed && !upcoming) continue;

      const owedDays = stage.owed_days ?? 0;
      rows.push({
        topic_slug: topic.slug,
        topic_name: topic.name,
        day: stage.day,
        key: stage.key,
        title: stage.title,
        state: stage.state,
        pill: owed
          ? (owedDays === 0 ? 'today' : `owed ${owedDays}d`)
          : `day ${stage.day}`,
        hot: owed,
        // Why a reachable stage is not the next action — it is queued behind an older one.
        after: stage.state === 'owed' && leading ? leading.label : null,
        // Owed work sorts ahead of everything upcoming, oldest owed first.
        sort: owed ? -1000 - owedDays : stage.day - dayN,
      });
    }
  }
  return rows.sort((a, b) => a.sort - b.sort || a.topic_slug.localeCompare(b.topic_slug));
}

export function buildState(referenceISO = todayISO()) {
  // Each topic is built on its own: one unreadable state.json used to fail the whole
  // response and blank every view, the healthy topics included. A skipped topic is named
  // in `unavailable_topics` so the browser can say so; dropped silently, it would read as
  // a smaller curriculum and smaller totals.
  const unavailable = [];
  const topics = config.topics.flatMap((t) => {
    try {
      return [buildTopic(t, referenceISO)];
    } catch (error) {
      console.error(`[state] topic ${t.slug} could not be built`, error);
      unavailable.push({ slug: t.slug, error: error.message });
      return [];
    }
  });
  const primary = pickPrimary(topics);

  const totals = topics.reduce(
    (acc, t) => {
      acc.concepts += t.concept_count;
      for (const [status, n] of Object.entries(t.counts)) acc[status] += n;
      return acc;
    },
    { concepts: 0, unexplored: 0, in_progress: 0, needs_practice: 0, mastered: 0 },
  );

  return {
    generated: new Date().toISOString(),
    date: referenceISO,
    topics,
    unavailable_topics: unavailable,
    incomplete: unavailable.length > 0,
    totals,
    today: buildToday(primary),
    queue: buildQueue(topics, referenceISO),
    // Badge counts for the left rail. Cards/decks land in M1-M2; the rail reads
    // whatever is real right now rather than hard-coding the comp's numbers.
    badges: {
      // The badge counts what needs doing today, not the whole deck of cards.
      flashcards: topics.reduce((n, t) => n + t.cards.filter((c) => c.due_now).length, 0),
      // Usable decks only: an unreadable one cannot be taken, so counting it would send
      // you to Test Center for work that is not there (F12).
      testcenter: topics.reduce((n, t) => n + t.decks.filter((d) => !d.unreadable).length, 0),
    },
    active_topics: topics.filter((t) => !t.schedule.paused).length,
  };
}
