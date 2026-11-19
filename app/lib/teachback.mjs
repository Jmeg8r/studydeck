// WHAT: Evidence policy for learner-recorded teach-backs.
// WHY: A presentation can be useful activity without proving an explanation held up under
//      questions. Keeping the qualification rule pure makes that distinction inspectable
//      and prevents a route or view from silently turning attendance into mastery.

export const TEACHBACK_VOCABULARY = {
  outcomes: ['confirmed', 'rejected'],
  artifactTypes: ['presentation', 'article', 'video', 'notebook', 'notes'],
  ownership: ['independent', 'assisted', 'agent_generated'],
  aiContributions: ['none', 'planning', 'coaching', 'generated'],
};

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Classify a teach-back record without treating it as a mastery or stage signal.
 *
 * `rubric_predeclared` is deliberately separate from the rubric text: text typed after
 * the explanation may still be valuable reflection, but it cannot honestly claim the
 * criterion was set before the result was known.
 */
export function qualificationForTeachback(event = {}) {
  const reasons = [];
  if (event.outcome !== 'confirmed') reasons.push('teach-back was not confirmed');
  if (event.rubric_predeclared !== true) reasons.push('rubric was not predeclared');
  if (!hasText(event.rubric)) reasons.push('no rubric was recorded');
  if (!hasText(event.rubric_reference)) reasons.push('no rubric/reference provenance was recorded');
  if (!hasText(event.observable)) reasons.push('no observable explanation or result was recorded');
  if (!hasText(event.questions)) reasons.push('no received or anticipated question was recorded');
  if (!hasText(event.artifact_reference)) reasons.push('no teach-back artifact reference was recorded');
  if (event.ownership === 'agent_generated' || event.ai_contribution === 'generated') {
    reasons.push('teach-back material was agent generated');
  }

  return {
    evidence_quality: reasons.length === 0 ? 'qualifying' : 'activity_only',
    qualifying_teachback: reasons.length === 0,
    reasons,
  };
}

/** Latest record stays in file order, matching every other append-only sidecar. */
export function latestTeachback(events = []) {
  return [...events].reverse().find((event) => event?.event_type === 'teachback_recorded') ?? null;
}
