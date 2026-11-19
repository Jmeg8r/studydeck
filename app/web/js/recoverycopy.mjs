// WHAT: The words and the one action the Recovery view shows for each item.
// WHY:  Kept apart from the DOM so a node test can pin them: a wrong button here settles or
//       checks the wrong thing, and a wrong sentence misleads without anything failing.
//       Every line says what happened, why it matters, and what to do (design:ux-copy).

const WRITE_NOUN = {
  open_notebook_note: 'note',
  mindmap_note: 'mind-map note',
  podcast_episode: 'episode',
  podcast_standalone: 'episode',
  podcast_delete: 'episode delete',
};

const day = (ts) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : 'an unknown date');
const what = (item) => item.concept_title ?? item.concept_slug ?? 'an assessment';

export const EMPTY = 'Nothing to recover. Every graded attempt has updated mastery, and every Open Notebook write is confirmed.';
export const INTRO = "Work the cockpit started but couldn't finish. Nothing here repeats an action: checking Open Notebook only reads it.";

export function describeItem(item) {
  switch (item.type) {
    case 'mastery_owed':
      return `${what(item)} · ${item.kind} from ${day(item.ts)} · scored ${item.score}/${item.max}. `
        + 'Mastery was never updated, so confidence is lower than this result.';
    case 'factcheck_cards_owed':
      return `Fact-check on ${what(item)} from ${day(item.ts)}. Its corrective cards were never created.`;
    case 'mastery_ambiguous':
      return `${what(item)} · ${item.kind} from ${day(item.ts)}. Mastery may or may not have been updated. `
        + "It won't be applied automatically, so a confidence bump can't count twice.";
    case 'unfinished':
      return item.kind === 'quiz'
        ? `${what(item)} · ${item.kind}. Started ${day(item.ts)}, still waiting for a self-check mark. `
          + "Test Center can't reopen a saved quiz yet, so it stays listed here. It isn't counted as a problem."
        : `${what(item)} · ${item.kind}. Started ${day(item.ts)}, not finished.`;
    case 'operation_unresolved':
      return item.checkable
        ? `Open Notebook ${WRITE_NOUN[item.kind] ?? 'write'} "${item.label}" from ${day(item.ts)} never confirmed.`
        : `Open Notebook write "${item.label}" (${item.kind}) from ${day(item.ts)} never confirmed. `
          + "The cockpit can't check this kind of write. Look in Open Notebook for it before doing it again.";
    default:
      return `${item.kind ?? 'Item'} from ${day(item.ts)}.`;
  }
}

/** The one request an item allows, or null when Recovery must not act on it. */
export function actionFor(item) {
  if (item.type === 'mastery_owed') {
    return { label: 'Apply to mastery', path: '/api/recovery/settle', body: { attempt_id: item.attempt_id } };
  }
  if (item.type === 'factcheck_cards_owed') {
    return { label: 'Create the missing cards', path: '/api/recovery/settle', body: { attempt_id: item.attempt_id } };
  }
  if (item.type === 'operation_unresolved' && item.checkable) {
    return { label: 'Look for it in Open Notebook', path: '/api/recovery/reconcile', body: { operation_id: item.operation_id } };
  }
  return null;
}

/**
 * Where an unfinished attempt is picked up again. Recovery never grades one itself.
 * Fact-Check lists pending adjudications and Test Center's essay panel lists pending
 * essays; nothing reopens a saved quiz, so a quiz gets no link.
 */
export function resumeFor(item) {
  if (item.type !== 'unfinished') return null;
  if (item.kind === 'factcheck') return { label: 'Resume in Fact-Check', href: '#factcheck' };
  if (item.kind === 'essay') return { label: 'Resume in Test Center', href: '#testcenter' };
  return null;
}

export function outcomeMessage(item, outcome) {
  if (outcome === 'already_done') return 'This was already finished. Nothing was changed.';
  if (outcome === 'confirmed') return 'Found it in Open Notebook and marked it done.';
  if (outcome === 'still_unknown') {
    return 'Not found in Open Notebook, or found more than once. Nothing was changed. '
      + 'Check Open Notebook yourself before doing this again.';
  }
  return item.type === 'factcheck_cards_owed' ? 'Cards created.' : 'Mastery updated.';
}

export function errorMessage(err) {
  if (err?.status === 503 && /Open Notebook/.test(err.message ?? '')) {
    return "Open Notebook isn't reachable, so nothing was checked. Start it and try again.";
  }
  return err?.message ?? 'Something went wrong, and nothing was changed.';
}
