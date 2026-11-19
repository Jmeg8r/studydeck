// WHAT: Turning drafted debrief cards into stored cards with collision-free ids.
// WHY: Card ids used to be `card-debrief-<date>-<position>`, and every debrief restarted
//      positions at 1. A second debrief on the same day therefore collided with the
//      first one's ids, and the skip-if-exists guard dropped the new drafts — losing
//      exactly the misconceptions the capture-back step exists to retain. Identity is
//      now per SUBMISSION, so two debriefs on one day cannot overlap.
//
// Pure on purpose: the server does the model call and the writes, this decides ids.

/** Enough of the debrief's uuid to separate submissions within one topic. */
export const shortDebriefId = (debriefId) => String(debriefId).slice(0, 8);

/**
 * Build card records for one debrief.
 *
 * `existingIds` still guards against a genuine repeat — belt to the ledger's braces —
 * but it can no longer fire on an unrelated debrief that merely happened on the same day.
 *
 * Drafts are trusted to be non-empty: `cardsFromDebrief` in lib/ollama.mjs already drops
 * any the model returned without a usable front and back. That check stays in one place
 * on purpose — two functions both claiming to own the invariant is how they drift.
 */
export function buildDebriefCards(drafted, { debriefId, date, existingIds = new Set(), conceptSlug = null }) {
  const short = shortDebriefId(debriefId);
  const cards = [];

  for (const [i, draft] of drafted.entries()) {
    const position = i + 1;
    const id = `card-debrief-${date}-${short}-${position}`;
    if (existingIds.has(id)) continue;
    cards.push({
      id,
      front: draft.front,
      back: draft.back,
      concept_slug: conceptSlug,
      source: 'walk',
      // The full id, not the short one: this is the durable back-reference.
      source_ref: `debrief:${debriefId}:${position}`,
      created: date,
    });
  }

  return cards;
}
