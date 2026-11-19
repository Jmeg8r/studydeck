// WHAT: The working topic — which topic the single-topic views act on.
// WHY: Assessment finding F7. Reading, Mind Map, Fact-Check, Essay and Debrief each did
//      `state.topics.find(t => t.slug === state.today.topic_slug) ?? state.topics[0]`, so a
//      second topic's sources, map, claims, essays and debriefs were unreachable unless it
//      happened to be the one the schedule nominated that morning. Five copies of the same
//      silent fallback is also five places to fix when it is wrong.
//
//      The distinction this module exists to keep: `state.today.topic_slug` is what the
//      SCHEDULE recommends today, and the working topic is what YOU chose to open. Reading
//      the first as if it were the second is precisely the bug — the recommendation is an
//      input to the default, never the answer.
//
//      Deliberately NOT server state. It is a per-browser view preference, not a study
//      record: nothing in `.learn/` or `cockpit/` changes when you switch, so persisting it
//      through a route would mean a mutation, a sidecar and a lock for something that
//      belongs beside the theme. localStorage, same as the theme, same lifetime.
//
//      Scope is the five single-topic views only. Today, Flashcards and Test Center keep
//      interleaving across topics on purpose — mixing topics is what makes retrieval harder
//      and the memory stick, so a global filter would quietly switch off the thing the
//      schedule is built around.
const WORKING_TOPIC_KEY = 'studydeck.topic';

/**
 * The topic the single-topic views should act on.
 *
 * Resolution order, and every step of it earns its place:
 *   1. an explicit choice, IF that topic still exists — a slug in localStorage outlives the
 *      topic it names, and a stale one must not strand every view on a topic that is gone;
 *   2. today's recommendation, so a first run opens on whatever the schedule nominated;
 *   3. the first configured topic, for the case where nothing is on the clock.
 *
 * Never returns undefined for a non-empty topic list, because every caller renders with it.
 */
export function workingTopic(state) {
  const stored = localStorage.getItem(WORKING_TOPIC_KEY);
  return (
    state.topics.find((t) => t.slug === stored)
    ?? state.topics.find((t) => t.slug === state.today.topic_slug)
    ?? state.topics[0]
  );
}

export function setWorkingTopic(slug) {
  localStorage.setItem(WORKING_TOPIC_KEY, slug);
}

/**
 * Where a topic stands on its schedule, as a short phrase for a status line.
 *
 * `position.dayN` is null until a topic is started, and a picker can now select a topic that
 * never was. Before F7 both the rail footer and the Observatory only ever resolved the topic
 * the SCHEDULE nominated — started by construction — so `Day ${dayN}` was always a number.
 * Pointed at the working topic, the first paused one rendered "Day null". A day that does
 * not exist is not a number to print: say what is true instead.
 *
 * Lives here rather than in main.mjs because the Observatory needs the same phrase, and it
 * is opened from Today and Stats — importing it from the shell would be a cycle.
 */
export function schedulePosition(topic) {
  if (!topic.schedule.started) return 'Not started';
  if (topic.schedule.paused) return 'Paused';
  return `Day ${topic.position.dayN}`;
}
