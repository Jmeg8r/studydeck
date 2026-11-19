// WHAT: Recording that an attempt's mastery update actually landed, and finishing one
//       that did not.
// WHY: `mastery_applied` used to be stamped on the attempt at append time, before
//       applyAttemptToState had run. A rejected render — or the topic lock held by another
//       process — then left an attempt permanently marked done with no mastery behind it,
//       and every retry returned a successful-looking replay, so the confidence bump was
//       lost silently and nothing could find it.
//
//       The flag now means "it happened", never "it is supposed to". That is what makes a
//       retry safe, and a safe retry is what makes healing possible at all.
//
// Split out of server.mjs so the wiring is testable with a fake mastery function: the
// first version of the heal never fired (an early return in the route sat above it) and
// the whole suite stayed green, because nothing exercised the sequence itself.
import { shareInFlight } from './inflight.mjs';
import { appendAttempt, findAttempt, isFinalAttempt, readAttempts } from './sidecar.mjs';
import { readMasterySnapshot, regenerateKnowledgeMap, sameMasterySnapshot } from './mastery.mjs';

/** Heals in flight, keyed `topic:attempt`. */
const healing = new Map();

/**
 * Reconstruct the self-grade map from a finalised attempt's own record.
 * A self-checked item is a hit unless the attempt recorded it as a miss.
 */
export const selfGradesOf = (attempt) =>
  Object.fromEntries((attempt.self_graded ?? []).map((id) => [id, !(attempt.misses ?? []).includes(id)]));

const preparedSettlement = (attempt) => attempt.mastery_settlement?.stage === 'prepared'
  ? attempt.mastery_settlement
  : null;

function settlementMutation(attempt, stage) {
  const origin = attempt.mastery_settlement?.origin_mutation_id ?? attempt.mutation_id;
  return `${origin}:mastery:${stage}`;
}

function markSettlement(topicSlug, attempt, settlement, masteryApplied = false) {
  return appendAttempt(topicSlug, {
    ...attempt,
    mutation_id: settlementMutation(attempt, settlement.stage),
    mastery_settlement: settlement,
    mastery_applied: masteryApplied,
  });
}

async function reconcilePrepared(topicSlug, attempt) {
  if (attempt.mastery_settlement?.stage === 'ambiguous') {
    return {
      state: 'ambiguous',
      mastery: { error: 'mastery settlement is ambiguous; reconcile this topic before another update' },
    };
  }
  const prepared = preparedSettlement(attempt);
  if (!prepared) return { state: 'none' };

  const current = readMasterySnapshot(topicSlug, attempt.concept_slug);
  if (sameMasterySnapshot(current, prepared.after)) {
    // State is already the intended result. Regenerate the map from that authoritative
    // state before saying the transaction completed; never apply confidence again.
    await regenerateKnowledgeMap(topicSlug);
    markSettlement(topicSlug, attempt, { ...prepared, stage: 'applied' }, true);
    return { state: 'applied', mastery: { recovered: true, band: prepared.band } };
  }
  if (sameMasterySnapshot(current, prepared.before)) return { state: 'before', prepared };

  markSettlement(topicSlug, attempt, {
    ...prepared,
    stage: 'ambiguous',
    observed: current,
    error: 'state no longer matches the prepared before or after fingerprint',
  });
  return {
    state: 'ambiguous',
    mastery: { error: 'mastery settlement is ambiguous; reconcile this topic before another update' },
  };
}

/**
 * Apply mastery for a recorded attempt, then note that it landed.
 *
 * The follow-up carries the SAME revision, so `foldAttempts` treats it as a newer view of
 * one attempt rather than a second attempt. It is skipped entirely when the update failed,
 * which is what leaves the partial commit visible and retryable.
 */
export function settleMastery(topicSlug, attempt, _graded, applyMastery) {
  return shareInFlight(healing, `${topicSlug}:${attempt.attempt_id}`, async () => {
    // The first append is the durable authority. A replay is allowed to carry different
    // fields, but must never alter which score or concept reaches state.json.
    const current = findAttempt(topicSlug, attempt.attempt_id);
    if (!current || !isFinalAttempt(current) || current.mastery_applied || !current.concept_slug) return null;

    // A later mutation must not obscure whether an older prepared transition landed.
    // `readAttempts` preserves first-record order while folding revisions, so only the
    // records before this attempt are candidates; checking every other record would make
    // A wait on B while B waits on A.
    const history = readAttempts(topicSlug);
    const currentIndex = history.findIndex((row) => row.attempt_id === current.attempt_id);
    const earlier = history.slice(0, Math.max(0, currentIndex)).find((row) =>
      isFinalAttempt(row) && !row.mastery_applied &&
      (preparedSettlement(row) || row.mastery_settlement?.stage === 'ambiguous'),
    );
    if (earlier) {
      const prior = await settleMastery(topicSlug, earlier, null, applyMastery);
      if (prior?.error) {
        return { error: `an earlier mastery settlement (${earlier.attempt_id}) requires reconciliation first` };
      }
    }

    const recovery = await reconcilePrepared(topicSlug, current);
    if (recovery.state === 'applied' || recovery.state === 'ambiguous') return recovery.mastery;

    const mastery = await applyMastery(topicSlug, current.concept_slug, {
      score: current.score,
      max: current.max,
    }, {
      // `applyAttemptToState` invokes this only after staging has accepted but before it
      // publishes state.json. The append is the crash-recovery write-ahead record.
      date: recovery.prepared?.practice_date,
      onPrepared: async (staged) => {
        const next = {
          stage: 'prepared',
          before: staged.before,
          after: staged.after,
          practice_date: staged.practice_date,
          state_digest: staged.state_digest,
          // Lets `npm run recover` place a state.json.bak in this log (restore.mjs, drift).
          replaced_digest: staged.replaced_digest,
          map_digest: staged.map_digest,
          band: staged.band,
          origin_mutation_id: current.mutation_id,
        };
        if (recovery.prepared) {
          if (
            !sameMasterySnapshot(next.before, recovery.prepared.before) ||
            !sameMasterySnapshot(next.after, recovery.prepared.after)
          ) {
            throw new Error('prepared mastery settlement no longer matches the authoritative state');
          }
          return;
        }
        markSettlement(topicSlug, current, next);
      },
    });
    if (!mastery.error) {
      const latest = findAttempt(topicSlug, current.attempt_id) ?? current;
      const prepared = preparedSettlement(latest);
      markSettlement(topicSlug, latest, { ...(prepared ?? {}), stage: 'applied' }, true);
    }
    return mastery;
  }).then(({ result }) => result);
}

/**
 * Finish an attempt that is complete but whose mastery never landed.
 *
 * Returns null — doing nothing — when there is nothing owed, which is the common case and
 * the reason this is safe to call on every replay.
 *
 * The whole check → grade → apply → append runs once per attempt at a time. Reading the
 * flag and acting on it is a check-then-act: two replays overlapping (a double click, two
 * tabs) would both see the update as owed and both apply it, and a doubly-applied
 * confidence bump is silent corruption — indistinguishable from real study progress. The
 * topic lock inside applyAttemptToState does NOT close this: it serialises the two writes
 * rather than preventing the second, and it cannot be taken around the check here because
 * it is not reentrant.
 *
 * This is an in-process guard, which matches the exposure: `app/` binds 127.0.0.1:4310, so
 * a second cockpit could not start alongside it, and the CLI never settles mastery.
 */
export function healUnappliedMastery(topicSlug, attemptId, deck, applyMastery) {
  // `deck` remains accepted for source compatibility with callers during M1. The stored
  // final score/max are authoritative, so recovery no longer depends on a later deck read.
  void deck;
  return settleMastery(topicSlug, { attempt_id: attemptId }, null, applyMastery);
}
