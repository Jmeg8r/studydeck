// WHAT: Flashcard queueing from misses, and the expanding-interval due logic.
// WHY: Cards themselves are stored (cards.json is the durable record of what you got
//      wrong and why). Everything about WHEN a card is due is derived from reviews.jsonl
//      on each request — one source of truth per fact, and no schedule to fall stale.

import { readDeck } from './learn.mjs';
import { isFinalAttempt, readAttempts, readCards, readReviews, readSchedule, writeCards } from './sidecar.mjs';
import { FLASHCARD_MILESTONES, addDays, dateForDay, daysBetween, todayISO } from './schedule.mjs';
import { generatedCardId } from './cardidentity.mjs';

/**
 * The spec's expanding interval table, in days.
 *
 * A card's rung is its consecutive-hit streak, clamped to the table. A miss drops it
 * back to rung 0 — which is the spec's error-routing rule, "miss resets the next
 * review to +1d". Deliberately NOT FSRS; that is Phase 2 (Anki export).
 */
export const INTERVALS = [1, 3, 7, 14, 30];

/** Stable key for one missed question, so re-syncing never duplicates a card. */
const missKey = (deckFile, questionId) => `${deckFile}:${questionId}`;

/**
 * Build cards for every quiz miss that isn't carded yet.
 *
 * Idempotent by `source_ref`, so it is safe to call repeatedly — on every new attempt
 * and as a backfill over history. Returns the cards it created.
 */
export function syncCardsFromAttempts(topicSlug) {
  // A miss is corrective-card evidence only after its containing attempt is final.
  // Pending self-checks and model proposals may still change before adjudication, and a
  // card would reveal a conclusion those records are expressly forbidden to advance.
  const attempts = readAttempts(topicSlug).filter(isFinalAttempt);
  const cards = readCards(topicSlug);
  const existing = new Set(cards.map((c) => c.source_ref).filter(Boolean));
  const created = [];

  for (const attempt of attempts) {
    if (attempt.kind !== 'quiz' || !attempt.deck_file) continue;

    let deck;
    try {
      deck = readDeck(topicSlug, attempt.deck_file);
    } catch {
      // Deck deleted or renamed since the attempt — the attempt still stands as
      // history, there is just nothing to build a card from.
      continue;
    }

    for (const questionId of attempt.misses ?? []) {
      const ref = missKey(attempt.deck_file, questionId);
      if (existing.has(ref)) continue;

      const question = deck.questions.find((q) => q.id === questionId);
      if (!question) continue;

      const answer = Array.isArray(question.answer) ? question.answer.join(' · ') : String(question.answer);
      const card = {
        id: generatedCardId('quiz-miss', ref),
        front: question.prompt,
        back: question.explanation ? `${answer}\n\n${question.explanation}` : answer,
        concept_slug: attempt.concept_slug ?? deck.concept_slug,
        source: 'quiz-miss',
        source_ref: ref,
        // Created when the miss happened, not when the card was materialized — the
        // card's schedule should follow the mistake, not the backfill run.
        created: String(attempt.ts).slice(0, 10),
      };
      cards.push(card);
      existing.add(ref);
      created.push(card);
    }
  }

  if (created.length > 0) writeCards(topicSlug, cards);
  return created;
}

/**
 * First due date for a never-reviewed card: the topic's next scheduled flashcard
 * session at or after the card was created.
 *
 * WHY schedule-driven rather than created + 1 day: the spec puts flashcard sessions
 * on days 7, 14 and 30, and interleaves topics within them. A card made from the
 * day-0 pretest is therefore first due on day 7, not the morning after.
 */
function firstDueDate(card, schedule) {
  if (!schedule.started) return card.created;
  const createdDay = daysBetween(schedule.started, card.created) ?? 0;
  const milestone = FLASHCARD_MILESTONES.find((m) => m.day >= createdDay);
  // Past the last scheduled session, the card is simply due now.
  if (!milestone) return card.created;
  return dateForDay(schedule.started, milestone.day);
}

/**
 * Derive a card's schedule state from its review history.
 * Nothing here is persisted — reviews.jsonl is the only input that matters.
 */
export function deriveCard(card, reviews, schedule, today = todayISO()) {
  const history = reviews
    .filter((r) => r.card_id === card.id)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const hits = history.filter((r) => r.result === 'hit').length;
  const misses = history.filter((r) => r.result === 'miss').length;

  // Consecutive hits ending at the most recent review; any miss resets it.
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].result !== 'hit') break;
    streak += 1;
  }

  let due;
  let interval = null;
  if (history.length === 0) {
    due = firstDueDate(card, schedule);
  } else {
    const last = history[history.length - 1];
    // Rung 0 (a 1-day interval) is reached only by a miss — that is the reset rule.
    interval = INTERVALS[Math.min(streak, INTERVALS.length - 1)];
    due = addDays(String(last.ts).slice(0, 10), interval);
  }

  const overdueDays = due ? (daysBetween(due, today) ?? 0) : 0;

  return {
    ...card,
    reviews: history.length,
    hits,
    misses,
    // Weak = you have ever gotten it wrong in review. Drives the weak-only filter.
    miss_rate: history.length > 0 ? misses / history.length : 0,
    streak,
    interval,
    due,
    due_now: !card.suspended && overdueDays >= 0,
    overdue_days: overdueDays,
    last_reviewed: history.length ? String(history[history.length - 1].ts).slice(0, 10) : null,
  };
}

/** Every card for a topic, decorated with derived schedule state. */
export function deriveCards(topicSlug, today = todayISO()) {
  const schedule = readSchedule(topicSlug);
  const reviews = readReviews(topicSlug);
  return readCards(topicSlug).map((card) => deriveCard(card, reviews, schedule, today));
}
