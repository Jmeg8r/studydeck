// WHAT: Evidence policy for the Practice Lab.
// WHY: A local exercise file proves only that a file exists. This module keeps the
//      stronger claim — independently applying a concept at near transfer — explicit,
//      inspectable, and separate from learn-anything mastery updates.

/** Values accepted at the route boundary. Keeping them here makes the UI and ledger speak one vocabulary. */
export const PRACTICE_VOCABULARY = {
  modes: ['project', 'chat'],
  outcomes: ['confirmed', 'rejected'],
  evidenceKinds: ['practice', 'transfer'],
  ownership: ['independent', 'assisted', 'agent_generated'],
  aiContributions: ['none', 'planning', 'debugging', 'generated'],
  hintUse: ['none', 'hint', 'full_solution'],
};

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Classify a record without promoting it.  `independent_near_transfer` is evidence
 * vocabulary for the learner to inspect, not a mastery signal and never a stage event.
 */
export function qualificationForPracticeEvidence(event, { answerRevealed = false } = {}) {
  const qualityReasons = [];
  if (event.outcome !== 'confirmed') qualityReasons.push('activity was not confirmed');
  if (!hasText(event.rubric)) qualityReasons.push('no rubric was recorded');
  if (!hasText(event.observable)) qualityReasons.push('no observable output, test, or source was recorded');

  const transferReasons = [...qualityReasons];
  if (event.evidence_kind !== 'transfer') transferReasons.push('this record is practice, not transfer');
  if (event.ownership !== 'independent') transferReasons.push('work was not owned independently');
  if (event.ai_contribution !== 'none') transferReasons.push('AI contributed to the work');
  if (event.hint_use === 'full_solution') transferReasons.push('a full solution was used');
  if (answerRevealed) transferReasons.push('answer-bearing artifact was revealed');

  return {
    // A rejected activity is still useful history, but it is not a quality claim.
    evidence_quality: qualityReasons.length === 0 ? 'qualifying' : 'recorded_not_qualifying',
    independent_near_transfer: transferReasons.length === 0,
    reasons: transferReasons,
  };
}

/** Latest evidence record per mapped concept, preserving the append log as the authority. */
export function latestPracticeEvidenceByConcept(events = []) {
  const latest = new Map();
  for (const event of events) {
    if (event?.event_type !== 'evidence_recorded' || !event.concept_slug) continue;
    latest.set(event.concept_slug, event);
  }
  return latest;
}
