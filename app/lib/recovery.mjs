// WHAT: The Recovery list: per topic, the work the cockpit started but could not finish.
// WHY:  /api/health already counts owed mastery and unconfirmed Open Notebook writes, then
//       offered no way to act on them. This lists the same things, through the same
//       predicates, so the view and the banner can never disagree about what is owed.
//       Attempt records carry answers (responses, results, misses, fact-check truths), so
//       every item is built from an allowlist of fields: a field added to a record later
//       cannot leak through here, because nothing here names it (rule 7).
import { config } from './config.mjs';
import { flattenConcepts, readTopicState } from './learn.mjs';
import {
  isFinalAttempt, isUnresolvedOperation, owesFactcheckCards, owesMastery,
  readAttempts, readOperations,
} from './sidecar.mjs';

/** Operation kinds Recovery can check in Open Notebook without writing anything there. */
export const CHECKABLE_KINDS = new Set([
  'open_notebook_note', 'mindmap_note', 'podcast_episode', 'podcast_standalone', 'podcast_delete',
]);

const byTs = (a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? ''));

/** Titles are a courtesy for the view; a topic whose state cannot be read still lists. */
function conceptTitles(slug) {
  try {
    return new Map(flattenConcepts(readTopicState(slug)).map((c) => [c.slug, c.title ?? c.name ?? null]));
  } catch {
    return new Map();
  }
}

export function projectAttempt(type, attempt, titles = new Map()) {
  const final = isFinalAttempt(attempt);
  return {
    type,
    attempt_id: attempt.attempt_id ?? null,
    kind: attempt.kind ?? null,
    status: attempt.status ?? 'final',
    ts: attempt.ts ?? null,
    concept_slug: attempt.concept_slug ?? null,
    concept_title: titles.get(attempt.concept_slug) ?? null,
    deck_file: attempt.deck_file ?? null,
    // A final score was revealed when the attempt was recorded; a provisional one was not.
    score: final ? attempt.score ?? null : null,
    max: final ? attempt.max ?? null : null,
  };
}

export function projectOperation(operation) {
  const local = operation.local_result ?? {};
  return {
    type: 'operation_unresolved',
    operation_id: operation.operation_id,
    kind: operation.kind ?? null,
    stage: operation.stage,
    ts: operation.ts ?? null,
    label: local.note_title ?? local.episode_name ?? local.title ?? operation.operation_id,
    checkable: CHECKABLE_KINDS.has(operation.kind),
  };
}

function topicRecovery(slug) {
  const attempts = readAttempts(slug);
  const operations = readOperations(slug).filter(isUnresolvedOperation);
  const titles = conceptTitles(slug);

  const masteryOwed = attempts.filter(owesMastery);
  const cardsOwed = attempts.filter(owesFactcheckCards);
  return {
    topic_slug: slug,
    counts: {
      mastery_owed: masteryOwed.length,
      factcheck_cards_owed: cardsOwed.length,
      operations_unresolved: operations.length,
    },
    needs_action: [
      ...masteryOwed.map((a) => projectAttempt('mastery_owed', a, titles)),
      ...cardsOwed.map((a) => projectAttempt('factcheck_cards_owed', a, titles)),
      ...operations.map(projectOperation),
    ].sort(byTs),
    blocked: attempts
      .filter((a) => a.mastery_settlement?.stage === 'ambiguous')
      .map((a) => projectAttempt('mastery_ambiguous', a, titles))
      .sort(byTs),
    // Normal in-progress state, not a fault: listed so it can be resumed, never counted.
    in_progress: attempts
      .filter((a) => !isFinalAttempt(a))
      .map((a) => projectAttempt('unfinished', a, titles))
      .sort(byTs),
  };
}

/** One entry per topic; a topic that cannot be read says why without hiding the rest. */
export function recoveryList(topics = config.topics) {
  return {
    topics: topics.map(({ slug }) => {
      try {
        return topicRecovery(slug);
      } catch (err) {
        return {
          topic_slug: slug,
          error: `could not read this topic's history (${err.code ?? err.message})`,
          counts: { mastery_owed: 0, factcheck_cards_owed: 0, operations_unresolved: 0 },
          needs_action: [], blocked: [], in_progress: [],
        };
      }
    }),
  };
}
