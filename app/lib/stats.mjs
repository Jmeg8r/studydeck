// WHAT: Weakness evidence per concept and per domain, derived from recorded attempts.
// WHY: The honest distinction this module exists to preserve is **untested vs. clean**.
//      A concept you have never been quizzed on is not strong — it is unmeasured. Folding
//      those together would paint most of the map green and make the heatmap a liar.

import { flattenConcepts, readTopicState } from './learn.mjs';
import { isFinalAttempt, readAttempts, readCards, readReviews } from './sidecar.mjs';

/** Evidence levels a concept can be in. */
export const EVIDENCE = {
  UNTESTED: 'untested', // never quizzed — unknown, NOT good
  CLEAN: 'clean', // tested, nothing missed
  WEAK: 'weak', // tested, something missed
};

/**
 * Per-concept evidence from attempts and card reviews.
 *
 * `asked` counts gradeable questions across every attempt on that concept; `missed`
 * counts the ones that came back wrong. Both are plain sums over attempts.jsonl, so
 * the totals reconcile against a hand-count of the file.
 */
function conceptEvidence(topicSlug) {
  const attempts = readAttempts(topicSlug).filter(isFinalAttempt);
  const cards = readCards(topicSlug);
  const reviews = readReviews(topicSlug);
  const byConcept = new Map();
  // Some graded events genuinely belong to no single concept — a fact-check run covers
  // a whole chapter. They are counted here rather than dropped: dropping them made the
  // reconciliation panel disagree with the attempt log, and attributing them to an
  // arbitrary concept would be inventing evidence.
  const unattributed = { asked: 0, missed: 0, attempts: 0 };

  const entry = (slug) => {
    if (!byConcept.has(slug)) {
      byConcept.set(slug, { asked: 0, missed: 0, attempts: 0, cards: 0, card_reviews: 0, card_misses: 0 });
    }
    return byConcept.get(slug);
  };

  // Shortfall = max - score, NOT misses.length.
  //
  // A written answer has no per-item miss list, so an essay records `misses: []`. Using
  // the miss list would score a 0/5 essay as zero misses and classify the concept CLEAN —
  // the same unearned-pass trap that "untested vs clean" exists to prevent. For quizzes
  // and fact-checks the two are identical (verified: correct + missed === asked), so this
  // is strictly more accurate rather than a different convention.
  const shortfall = (a) => Math.max(0, (a.max ?? 0) - (a.score ?? 0));

  for (const attempt of attempts) {
    if (!attempt.concept_slug) {
      unattributed.attempts += 1;
      unattributed.asked += attempt.max ?? 0;
      unattributed.missed += shortfall(attempt);
      continue;
    }
    const row = entry(attempt.concept_slug);
    row.attempts += 1;
    row.asked += attempt.max ?? 0;
    row.missed += shortfall(attempt);
  }

  const reviewsByCard = new Map();
  for (const review of reviews) {
    if (!reviewsByCard.has(review.card_id)) reviewsByCard.set(review.card_id, []);
    reviewsByCard.get(review.card_id).push(review);
  }

  for (const card of cards) {
    if (!card.concept_slug) continue;
    const row = entry(card.concept_slug);
    row.cards += 1;
    for (const review of reviewsByCard.get(card.id) ?? []) {
      row.card_reviews += 1;
      if (review.result === 'miss') row.card_misses += 1;
    }
  }

  return { byConcept, unattributed };
}

function classify(row) {
  if (!row || row.asked === 0) {
    // Card reviews alone can still prove weakness even with no quiz attempt.
    if (row?.card_misses > 0) return EVIDENCE.WEAK;
    return EVIDENCE.UNTESTED;
  }
  return row.missed > 0 || row.card_misses > 0 ? EVIDENCE.WEAK : EVIDENCE.CLEAN;
}

/**
 * Weakness map for a topic: every concept classified, aggregated by domain.
 * Domains report untested counts separately so the UI can never imply coverage
 * it does not have.
 */
export function buildWeakness(topicSlug) {
  const state = readTopicState(topicSlug);
  const { byConcept: evidence, unattributed } = conceptEvidence(topicSlug);

  const domains = state.domains.map((domain) => {
    const concepts = domain.concepts.map((concept) => {
      const row = evidence.get(concept.slug) ?? null;
      const asked = row?.asked ?? 0;
      const missed = row?.missed ?? 0;
      return {
        name: concept.name,
        slug: concept.slug,
        status: concept.status,
        confidence: concept.confidence,
        evidence: classify(row),
        asked,
        missed,
        miss_rate: asked > 0 ? missed / asked : null, // null = no data, never 0
        cards: row?.cards ?? 0,
        card_reviews: row?.card_reviews ?? 0,
        card_misses: row?.card_misses ?? 0,
      };
    });

    const asked = concepts.reduce((n, c) => n + c.asked, 0);
    const missed = concepts.reduce((n, c) => n + c.missed, 0);
    return {
      name: domain.name,
      slug: domain.slug,
      concepts,
      asked,
      missed,
      miss_rate: asked > 0 ? missed / asked : null,
      untested: concepts.filter((c) => c.evidence === EVIDENCE.UNTESTED).length,
      weak: concepts.filter((c) => c.evidence === EVIDENCE.WEAK).length,
      clean: concepts.filter((c) => c.evidence === EVIDENCE.CLEAN).length,
    };
  });

  const all = flattenConcepts(state);
  return {
    domains,
    unattributed,
    totals: {
      concepts: all.length,
      // Per-concept sums, used by the heatmap.
      asked: domains.reduce((n, d) => n + d.asked, 0),
      missed: domains.reduce((n, d) => n + d.missed, 0),
      // Grand totals including work that belongs to no single concept. These are what
      // must equal a hand-count of attempts.jsonl.
      asked_all: domains.reduce((n, d) => n + d.asked, 0) + unattributed.asked,
      missed_all: domains.reduce((n, d) => n + d.missed, 0) + unattributed.missed,
      untested: domains.reduce((n, d) => n + d.untested, 0),
      weak: domains.reduce((n, d) => n + d.weak, 0),
      clean: domains.reduce((n, d) => n + d.clean, 0),
    },
  };
}
