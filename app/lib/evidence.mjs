// WHAT: Durable learning-evidence policy primitives.
// WHY: Confidence is a learner prediction made before feedback, not a score and not a
//      replacement mastery percentage. Keeping its vocabulary and sample threshold here
//      makes every later display reproducible rather than a view-specific guess.
import { createHash } from 'node:crypto';

export const EVIDENCE_POLICY = Object.freeze({
  version: 'evidence-v1',
  confidenceBands: Object.freeze(['unsure', 'likely', 'certain']),
  confidenceMinimumSample: 5,
});

// A retrieval policy is separate from confidence alignment: expanding the former must
// not silently reinterpret the confidence records already written under evidence-v1.
export const RETRIEVAL_POLICY = Object.freeze({
  version: 'retrieval-v1',
  checkpoints_days: Object.freeze([0, 7, 30, 90]),
  checkpoint_gaps_days: Object.freeze([0, 7, 23, 60]),
});

export function isConfidenceBand(value) {
  return EVIDENCE_POLICY.confidenceBands.includes(value);
}

const RETRIEVAL_FORMAT = Object.freeze({
  multiple_choice: 'recognition',
  multi_select: 'recognition',
  true_false: 'recognition',
  fill_in_blank: 'free_recall',
  short_answer: 'free_recall',
  error_correction: 'explanation',
});

/**
 * Freeze the evidence-relevant facts about a server-graded quiz at submission time.
 *
 * No response, answer, prompt, or explanation is copied here. The assessment hash lets
 * later derivation distinguish an unchanged item from a source that has been edited.
 * `self_grade` rows are preserved for audit but intentionally cannot qualify for the
 * deterministic retention calculation below.
 */
export function retrievalEvidenceForQuiz(deckFile, deck, graded) {
  const results = new Map(graded.results.map((result) => [result.id, result]));
  return {
    policy: RETRIEVAL_POLICY.version,
    assessment_id: deckFile,
    assessment_version: createHash('sha256').update(JSON.stringify(deck)).digest('hex'),
    items: deck.questions.map((question) => {
      const result = results.get(question.id);
      return {
        question_id: question.id,
        retrieval_format: RETRIEVAL_FORMAT[question.type] ?? 'free_recall',
        verification_method: question.gradeable === 'ai_only' ? 'self_grade' : 'deterministic_deck',
        // The server only supplied the answer after the surrounding append committed.
        answer_free: true,
        correct: result?.correct ?? null,
      };
    }),
  };
}

/** Preserve the original assessment snapshot while a pending self-check is finalized. */
export function finalizeRetrievalEvidence(retrievalEvidence, graded) {
  if (retrievalEvidence?.policy !== RETRIEVAL_POLICY.version || !Array.isArray(retrievalEvidence.items)) {
    return retrievalEvidence;
  }
  const results = new Map(graded.results.map((result) => [result.id, result]));
  return {
    ...retrievalEvidence,
    items: retrievalEvidence.items.map((item) => {
      const result = results.get(item.question_id);
      return result ? { ...item, correct: result.correct } : item;
    }),
  };
}

/** Accuracy by ordinal confidence band; below-policy samples stay explicitly insufficient. */
export function confidenceAlignment(events) {
  return EVIDENCE_POLICY.confidenceBands.map((band) => {
    const sample = events.filter((event) => event.confidence === band && typeof event.correct === 'boolean');
    const correct = sample.filter((event) => event.correct).length;
    return {
      band,
      sample: sample.length,
      correct,
      insufficient: sample.length < EVIDENCE_POLICY.confidenceMinimumSample,
      ...(sample.length >= EVIDENCE_POLICY.confidenceMinimumSample ? { accuracy: correct / sample.length } : {}),
    };
  });
}

/**
 * Convert final, recorded quiz attempts into evidence events without re-grading old
 * responses against a deck that may later be edited. `misses` is the durable outcome
 * recorded when feedback was released; an answer is correct exactly when its id is not
 * in that list. Only records written under this policy participate in its summary.
 */
export function quizConfidenceEvidence(attempts) {
  const events = [];
  let excluded = 0;

  for (const attempt of attempts) {
    if (attempt.kind !== 'quiz' || attempt.status === 'pending_self_grade' ||
      attempt.evidence_policy !== EVIDENCE_POLICY.version || !Array.isArray(attempt.misses)) continue;
    for (const [questionId, band] of Object.entries(attempt.confidence ?? {})) {
      if (!isConfidenceBand(band)) {
        excluded += 1;
        continue;
      }
      events.push({ confidence: band, correct: !attempt.misses.includes(questionId) });
    }
  }

  return {
    policy: EVIDENCE_POLICY.version,
    minimum_sample: EVIDENCE_POLICY.confidenceMinimumSample,
    samples: events.length,
    excluded,
    bands: confidenceAlignment(events),
  };
}

/**
 * Item-level retention from persisted, server-verified quiz outcomes.
 *
 * This intentionally makes the smallest defensible claim. It requires a final,
 * deterministic, answer-free event whose assessment version was frozen at submission;
 * a self-grade, a legacy row, or a pending attempt cannot become evidence just because it
 * later looks favourable. Repeating the same item may demonstrate item retention, but
 * never concept retention or transfer. One event advances at most one checkpoint.
 */
export function itemRetentionEvidence(attempts, referenceAt = new Date().toISOString()) {
  const groups = new Map();
  for (const attempt of attempts) {
    if (attempt.kind !== 'quiz' || attempt.status !== 'final' ||
      !attempt.attempt_id || !validTimestamp(attempt.ts)) continue;
    const retrieval = attempt.retrieval_evidence;
    if (retrieval?.policy !== RETRIEVAL_POLICY.version ||
      typeof retrieval.assessment_id !== 'string' || typeof retrieval.assessment_version !== 'string' ||
      !Array.isArray(retrieval.items)) continue;

    for (const item of retrieval.items) {
      if (typeof item?.question_id !== 'string' || typeof item.retrieval_format !== 'string' ||
        item.verification_method !== 'deterministic_deck' || item.answer_free !== true || typeof item.correct !== 'boolean') continue;
      // A changed assessment source cannot quietly extend the retention line of the old
      // item. The display id remains human-readable; this key keeps its source version.
      const key = `${retrieval.assessment_id}\0${retrieval.assessment_version}\0${item.question_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          item_id: `${retrieval.assessment_id}:${item.question_id}`,
          assessment_version: retrieval.assessment_version,
          concept_slug: attempt.concept_slug ?? null,
          retrieval_format: item.retrieval_format,
          events: [],
        });
      }
      groups.get(key).events.push({ at: attempt.ts, attempt_id: attempt.attempt_id, correct: item.correct });
    }
  }

  return [...groups.values()].map((group) => {
    group.events.sort((left, right) => left.at.localeCompare(right.at));
    const initial = group.events.find((event) => event.correct);
    if (!initial) return null;
    let checkpoint = 0;
    let last = initial;
    let failed = null;
    for (const event of group.events.filter((event) => event.at > initial.at)) {
      const requiredDays = RETRIEVAL_POLICY.checkpoint_gaps_days[checkpoint + 1];
      if (requiredDays === undefined || elapsedDays(last.at, event.at) < requiredDays) continue;
      if (!event.correct) {
        failed = event;
        break;
      }
      checkpoint += 1;
      last = event;
    }
    const nextGapDays = RETRIEVAL_POLICY.checkpoint_gaps_days[checkpoint + 1];
    const nextDue = nextGapDays === undefined ? null : atPlusDays(last.at, nextGapDays);
    const attention = failed
      ? { state: 'needs_repair', failed_at: failed.at, attempt_id: failed.attempt_id }
      : nextDue && validTimestamp(referenceAt) && Date.parse(referenceAt) >= Date.parse(nextDue)
        ? { state: 'verification_due', due_at: nextDue }
        : { state: 'none' };
    return {
      item_id: group.item_id,
      assessment_version: group.assessment_version,
      concept_slug: group.concept_slug,
      retrieval_format: group.retrieval_format,
      initial_demonstration: eventReference(initial),
      retention_horizon_days: RETRIEVAL_POLICY.checkpoints_days[checkpoint],
      last_verification: eventReference(last),
      current_attention: attention,
    };
  }).filter(Boolean);
}

const validTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const elapsedDays = (earlier, later) => (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
const atPlusDays = (at, days) => new Date(Date.parse(at) + days * 86_400_000).toISOString();
const eventReference = (event) => ({ at: event.at, attempt_id: event.attempt_id });

/**
 * Summarize evidence at the mapped-concept level without upgrading item repetition into
 * a concept or transfer claim.  The curriculum status remains the upstream
 * learn-anything value; these records only place it beside observations from cockpit
 * sidecars.  Unknown historical slugs are intentionally excluded: this view is about
 * the current mapped StudyDeck curriculum, not an attempt to recreate a removed map.
 */
export function conceptEvidence(concepts, itemEvidence = [], misconceptions = []) {
  const mapped = new Map(concepts
    .filter((concept) => typeof concept?.slug === 'string')
    .map((concept) => [concept.slug, concept]));

  return [...mapped.values()].map((concept) => {
    const items = itemEvidence.filter((item) => item.concept_slug === concept.slug);
    const candidates = misconceptions.filter((candidate) => candidate.concept_slug === concept.slug);
    const needsRepairItems = items.filter((item) => item.current_attention?.state === 'needs_repair');
    const dueItems = items.filter((item) => item.current_attention?.state === 'verification_due');
    const uncharacterized = candidates.filter((candidate) => candidate.state === 'candidate');
    const confirmed = candidates.filter((candidate) => candidate.state === 'confirmed_misconception');
    const currentAttention = needsRepairItems.length > 0 || confirmed.length > 0
      ? {
        state: 'needs_repair',
        item_count: needsRepairItems.length,
        confirmed_misconception_count: confirmed.length,
      }
      : uncharacterized.length > 0
        ? { state: 'needs_characterization', candidate_count: uncharacterized.length }
        : dueItems.length > 0
          ? { state: 'verification_due', item_count: dueItems.length }
          : { state: 'none' };

    return {
      concept_slug: concept.slug,
      concept_name: concept.name ?? concept.slug,
      upstream_status: concept.status ?? null,
      initial_demonstration_count: items.length,
      item_retention_horizon_days: items.length > 0
        ? Math.max(...items.map((item) => item.retention_horizon_days))
        : null,
      concept_retention: 'unverified',
      near_transfer: 'unverified',
      open_misconception_candidates: uncharacterized.length,
      confirmed_misconceptions_needing_repair: confirmed.length,
      current_attention: currentAttention,
    };
  }).filter((concept) => concept.initial_demonstration_count > 0 ||
    concept.open_misconception_candidates > 0 || concept.confirmed_misconceptions_needing_repair > 0);
}

/**
 * High-confidence quiz misses are candidates for learner characterization, not diagnoses.
 * The identity points to the folded source attempt so a repeated request never creates a
 * second candidate, and a same-session correction cannot be mistaken for repair.
 */
export function misconceptionCandidates(attempts, events = []) {
  const candidates = [];
  for (const attempt of attempts) {
    if (attempt.kind !== 'quiz' || attempt.status !== 'final' ||
      attempt.evidence_policy !== EVIDENCE_POLICY.version || !Array.isArray(attempt.misses)) continue;
    for (const questionId of attempt.misses) {
      if (attempt.confidence?.[questionId] !== 'certain') continue;
      const id = `quiz:${attempt.attempt_id}:${questionId}`;
      const latest = events.filter((event) => event.candidate_id === id).at(-1);
      candidates.push({
        id,
        attempt_id: attempt.attempt_id,
        question_id: questionId,
        concept_slug: attempt.concept_slug ?? null,
        detected_at: attempt.ts,
        response_format: 'quiz',
        state: latest?.action ?? 'candidate',
        characterization: latest?.rationale ?? null,
      });
    }
  }
  return candidates;
}
