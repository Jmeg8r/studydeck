// WHAT: The expanding-interval schedule from tasks/study-flow.md, plus day-N math.
// WHY: The schedule table is the one place the 30-day pipeline is encoded. Everything
//      the UI shows about "what day am I on / what's next" is derived from here —
//      never stored — so there's exactly one source of truth per fact.

const action = (view, label, duration, why, returnPath) => ({
  view, label, duration, why, return_path: returnPath,
});

/**
 * The spec's schedule table. `day` is days since the topic started.
 * `label` is the short tick label on the timeline strip; `title` is the hero headline.
 *
 * `primary_action` is the one concrete next click. A `secondary_action` is present only
 * when the milestone deliberately combines two ordered activities. These instructions are
 * static schedule metadata, never evidence that either activity or the stage happened.
 */
export const MILESTONES = [
  {
    day: 0,
    key: 'prime',
    label: 'PRIME',
    title: 'Prime the topic — pretest, gather sources, then one listen',
    detail:
      'Fail the pretest on purpose (that is the point), curate every source yourself, ' +
      'then listen to the overview exactly once. Priming is the map, not the territory.',
    steps: ['0 pretest', '1 sources', '2 priming audio', '3 video overview (optional)'],
    view: 'testcenter',
    primary_action: action('testcenter', 'Take the pretest', '10–15 min',
      'A cold retrieval attempt exposes the map you need before new material feels familiar.',
      'Return to Today, then use the overview handoff before marking the priming stage done.'),
    secondary_action: action('podcast', 'Then listen to the overview once', '15–25 min',
      'One overview gives the new terms a place to attach without substituting for study.',
      'Return to Today for the first deep-study session; the stage is still yours to mark done.'),
  },
  {
    day: 1,
    key: 'study',
    label: 'STUDY',
    title: 'Deep study, session 1',
    detail: 'Full reading, annotations captured as notes. Evening session — sleep does the consolidating.',
    steps: ['5 deep study'],
    view: 'reading',
    primary_action: action('reading', 'Open the deep-study session', '45–60 min',
      'This is the first deliberate pass through the material, while the priming questions are still active.',
      'Capture your notes, then return to Today when this study session is complete.'),
  },
  {
    day: 2,
    key: 'map',
    label: 'MAP',
    title: 'Deep study session 2, then draw the map from memory',
    detail:
      'Finish the read, sketch the concept map from memory BEFORE seeing the real one, ' +
      'then diff. Gaps in your sketch are tomorrow’s study targets. Fact-check the infographic after.',
    steps: ['5 deep study', '4 mind map (sketch → diff)', '4b infographic fact-check'],
    view: 'reading',
    primary_action: action('reading', 'Finish deep study', '35–50 min',
      'A second pass completes the source work before memory is tested against the map.',
      'Return to Today, then make the memory-first map as the required continuation.'),
    secondary_action: action('mindmap', 'Then draw the map from memory', '20–30 min',
      'Retrieving structure before seeing the reference reveals what the reading did not stick.',
      'Review the diff and return to Today; recording the stage remains an explicit choice.'),
  },
  {
    day: 3,
    key: 'walk',
    label: 'WALK',
    title: 'Walking deep-dive, then voice Q&A',
    detail:
      'Long-form audio while walking, then talk it through out loud — keep asking "why" until the chain ' +
      'bottoms out. Capture-back at the end is mandatory: every fuzzy point becomes a card.',
    steps: ['6 walking deep-dive', '7 voice Q&A', 'capture-back (mandatory)'],
    view: 'podcast',
    primary_action: action('podcast', 'Start the walking deep-dive', '30–45 min',
      'A change of setting makes the long-form explanation a fresh retrieval and elaboration pass.',
      'Return to Today for the capture-back continuation after the walk and voice Q&A.'),
    secondary_action: action('flashcards', 'Capture fuzzy points as cards', '10–15 min',
      'Capture-back converts a vague explanation into specific future retrieval prompts.',
      'Return to Today once the fuzzy points are captured; only you record the stage as done.'),
  },
  {
    day: 4,
    key: 'guide',
    label: 'GUIDE',
    title: 'Study guide, essays, then build it',
    detail:
      'Write the answers yourself and have them graded against a rubric. Then implement the concept — ' +
      'explaining a pattern and building it are different memories.',
    steps: ['8 study guide + essays', '8b build it'],
    view: 'testcenter',
    primary_action: action('testcenter', 'Write and grade the study-guide essays', '25–40 min',
      'Self-explanation exposes gaps before implementation makes an answer feel familiar.',
      'Return to Today, then continue into the Practice Lab with the exact build handoff.'),
    secondary_action: action('lab', 'Then build it in Practice Lab', '30–60 min',
      'Implementing the concept tests a different memory than explaining it on paper.',
      'Record the artifact-backed handoff in Practice Lab, then return here to mark the stage deliberately.'),
  },
  {
    day: 7,
    key: 'quiz',
    label: 'QUIZ',
    title: 'Flashcard session, then the full quiz',
    detail: 'First real retrieval test at distance. Retest against the pretest baseline — that delta is the whole point.',
    steps: ['9 flashcards', '10 full quiz'],
    view: 'flashcards',
    primary_action: action('flashcards', 'Review the due flashcards', '15–25 min',
      'Retrieval first makes the later full quiz measure what is available without prompts.',
      'Return to Today, then continue to the full quiz while the retrieval result is fresh.'),
    secondary_action: action('testcenter', 'Then take the full quiz', '20–35 min',
      'The full quiz checks the topic at distance rather than rewarding rereading fluency.',
      'Review the recorded result, then return to Today to decide whether the stage is complete.'),
    flashcards: true,
  },
  {
    day: 10,
    key: 'present',
    label: 'PRESENT',
    title: 'Presentation v1 — say it all out loud',
    detail: 'Present to a person, or to Claude as a naive audience that asks follow-ups. Once, not on a loop.',
    steps: ['11 present'],
    view: 'teachback',
    primary_action: action('teachback', 'Record presentation v1', '20–30 min',
      'Explaining to a real or naive audience exposes the causal links a solo review can hide.',
      'Record questions, gaps, and the next targeted action in Teachback, then return to Today.'),
  },
  {
    day: 14,
    key: 'again',
    label: 'AGAIN',
    title: 'Flashcard review, then re-present from memory',
    detail: 'Slides as prompt only this time. Massed practice produces fluency that decays — spacing is doing the work.',
    steps: ['9 flashcard review', '11 re-present'],
    view: 'flashcards',
    primary_action: action('flashcards', 'Review the due flashcards', '15–25 min',
      'Spacing makes this retrieval a separate measurement from the first presentation.',
      'Return to Today, then re-present from memory as the required continuation.'),
    secondary_action: action('teachback', 'Then re-present from memory', '15–25 min',
      'Teaching after a delay tests whether the explanation survives without the slides doing the work.',
      'Record the audience, questions, gaps, and return action in Teachback before coming back here.'),
    flashcards: true,
  },
  {
    day: 30,
    key: 'teach',
    label: 'TEACH',
    title: 'Final review, then teach it for real',
    detail: 'Terminal form: an ASTGL article or video. Teaching readers IS the Feynman step.',
    steps: ['9 final review', '11 teach for real'],
    view: 'flashcards',
    primary_action: action('flashcards', 'Run the final card review', '20–30 min',
      'A last answer-free retrieval brings weak details into view before the terminal teach-back.',
      'Return to Today, then move to the teach-for-real continuation.'),
    secondary_action: action('teachback', 'Then teach it for real', '30–60 min',
      'An article, video, or live explanation is the terminal Feynman check for this topic.',
      'Record the teach-back artifact and any question or gap, then return to Today for explicit completion.'),
    flashcards: true,
  },
];

export const FINAL_DAY = MILESTONES[MILESTONES.length - 1].day;

/** Local calendar date as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Whole days between two YYYY-MM-DD strings.
 * Both are parsed as UTC midnight so the difference is exact and DST-proof —
 * mixing local-parsed and UTC-parsed dates here would drift by a day.
 */
export function daysBetween(fromISO, toISO) {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Calendar date for a given day-N of a topic, as YYYY-MM-DD. */
export function dateForDay(startedISO, dayN) {
  const start = Date.parse(`${startedISO}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  return new Date(start + dayN * 86_400_000).toISOString().slice(0, 10);
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(dateISO, days) {
  const base = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** The scheduled flashcard sessions — days 7, 14 and 30 in the spec's table. */
export const FLASHCARD_MILESTONES = MILESTONES.filter((m) => m.flashcards);

/**
 * Where a topic sits on the schedule.
 *
 * `current` is the first milestone you have NOT completed whose date has arrived — not
 * the last one the calendar has passed. Slippage is expected (the spec: order and spacing
 * matter, exact days don't), so falling behind moves nothing forward on its own.
 *
 * Takes stage states from lib/stages.mjs rather than computing completion itself; a
 * milestone is done only when a recorded event says so.
 */
export function positionFor(schedule, stageStates, referenceISO = todayISO()) {
  const idle = { dayN: null, current: null, next: MILESTONES[0], daysToNext: null, owedDays: null, owedCount: 0 };
  if (schedule.paused || !schedule.started) return idle;

  const dayN = daysBetween(schedule.started, referenceISO);
  if (dayN === null) return idle;

  const states = stageStates ?? [];
  const current = states.find((s) => s.state === 'now') ?? null;
  // "Next" is the first thing after the current action, whether or not its date has come.
  const after = current ? states.slice(states.findIndex((s) => s.key === current.key) + 1) : states;
  const next = after.find((s) => !s.complete) ?? null;

  return {
    dayN,
    current,
    next,
    daysToNext: next ? next.day - dayN : null,
    // How long the current action has been owed. 0 means it came due today.
    owedDays: current?.owed_days ?? null,
    owedCount: states.filter((s) => s.state === 'now' || s.state === 'owed').length,
  };
}

/**
 * Milestones decorated for the timeline strip.
 *
 * States come straight from the stage model: done / now / owed / ahead. The strip used to
 * paint everything left of today as `done`, which is the finding this replaces — a stage
 * you never did looked identical to one you finished.
 */
export function timelineFor(schedule, stageStates, referenceISO = todayISO()) {
  const states = stageStates ?? [];
  return MILESTONES.map((m) => {
    const stage = states.find((s) => s.key === m.key);
    return {
      day: m.day,
      key: m.key,
      label: m.label,
      title: m.title,
      state: stage?.state ?? 'ahead',
      owed_days: stage?.owed_days ?? null,
      completed_on: stage?.completed_on ?? null,
    };
  });
}
