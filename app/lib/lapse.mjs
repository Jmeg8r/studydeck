// WHAT: The lapse rate that decides whether the review heuristic has hit its ceiling.
// WHY:  Roadmap D-c. `tasks/study-flow.md` has said since 2026-07-16 that the Anki/FSRS
//       exporter gets built "if the review heuristic's ceiling is hit after ~2 weeks", and
//       nothing has ever measured that. A gate whose trigger cannot be evaluated is not a
//       gate; it is a hunch with a date on it.
//
//       The contract this implements is written down in `tasks/roadmap-2026-07-30.md` §5,
//       and deliberately written BEFORE the data existed — a threshold chosen after seeing
//       the number is not a threshold. If any constant below moves, move it there too, in a
//       commit that says why.
//
// The measurement is narrower than "how often do I miss cards", on purpose. Missing a card
// at its 1-day or 3-day rung says something about the material; missing one that had
// survived to a long interval says something about the SCHEDULER, which is the only thing
// FSRS would replace.
import { INTERVALS } from './cards.mjs';
import { daysBetween, todayISO } from './schedule.mjs';

/** A review counts as mature when the card's interval going into it was at least this long. */
export const MATURE_INTERVAL_DAYS = 7;

/** Rolling window, matching the spec's own "~2 weeks". */
export const WINDOW_DAYS = 14;

/**
 * Below this many mature reviews the rate is not reported AT ALL.
 *
 * One miss in three is 33% and means nothing. A gate that three reviews can trip is worse
 * than no gate, because it will trip early, get overridden, and stop being believed.
 */
export const MIN_MATURE_REVIEWS = 30;

/** The one judgment call here. Written before the data existed so it cannot be fitted to it. */
export const THRESHOLD = 0.2;

/** Outcomes. `insufficient` is a real answer, not a degraded `ok` — see the note below. */
export const LAPSE_STATUS = {
  INSUFFICIENT: 'insufficient', // not enough mature reviews to say anything
  HOLDING: 'holding', // measured, and the heuristic is coping
  CEILING: 'ceiling', // measured, and it is not
};

/**
 * The interval a card was sitting on when a given review happened.
 *
 * A card's rung is its consecutive-hit streak, so the interval going INTO review `i` is
 * decided by the reviews before it. The first review of a card has no prior interval — the
 * card was on its initial schedule, which is first exposure rather than retention — so it
 * can never be mature and returns null.
 */
function intervalBefore(history, index) {
  if (index <= 0) return null;
  let streak = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (history[i].result !== 'hit') break;
    streak += 1;
  }
  return INTERVALS[Math.min(streak, INTERVALS.length - 1)];
}

/**
 * Lapse rate over the window.
 *
 * Takes reviews ONLY, not cards. Maturity is decided entirely by a card's own review
 * history — the rung is its consecutive-hit streak — so the card record adds nothing, and a
 * `cards` parameter would imply a dependency that does not exist.
 *
 * Pure: a function of (reviews, reference date). Nothing here reads the filesystem, so the
 * contract is testable without a server and without waiting two weeks.
 */
export function lapseRate(reviews = [], referenceISO = todayISO(), options = {}) {
  const {
    windowDays = WINDOW_DAYS,
    minMature = MIN_MATURE_REVIEWS,
    threshold = THRESHOLD,
  } = options;

  const byCard = new Map();
  for (const review of reviews) {
    if (!review?.card_id) continue;
    if (!byCard.has(review.card_id)) byCard.set(review.card_id, []);
    byCard.get(review.card_id).push(review);
  }

  let mature = 0;
  let lapses = 0;

  for (const [, history] of byCard) {
    // Sorted because maturity depends on what came BEFORE each review, and jsonl append
    // order is not guaranteed to be timestamp order across sessions.
    history.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    history.forEach((review, index) => {
      // The whole history decides maturity; only the window decides what is counted. A
      // review's rung comes from reviews that may well predate the window, and dropping
      // those would make every card look young and the rate look artificially clean.
      const age = daysBetween(String(review.ts).slice(0, 10), referenceISO);
      if (age === null || age < 0 || age >= windowDays) return;

      const interval = intervalBefore(history, index);
      if (interval === null || interval < MATURE_INTERVAL_DAYS) return;

      mature += 1;
      if (review.result === 'miss') lapses += 1;
    });
  }

  // Reported as its own outcome rather than as a 0% pass. A green zero on three reviews is
  // the same lie as `verify:live` calling an empty notebook clean — "I looked and there was
  // nothing to look at" presented as a result.
  if (mature < minMature) {
    return {
      status: LAPSE_STATUS.INSUFFICIENT,
      rate: null,
      mature_reviews: mature,
      lapses,
      needed: minMature - mature,
      window_days: windowDays,
      min_mature: minMature,
      threshold,
    };
  }

  const rate = lapses / mature;
  return {
    status: rate > threshold ? LAPSE_STATUS.CEILING : LAPSE_STATUS.HOLDING,
    rate,
    mature_reviews: mature,
    lapses,
    needed: 0,
    window_days: windowDays,
    min_mature: minMature,
    threshold,
  };
}
