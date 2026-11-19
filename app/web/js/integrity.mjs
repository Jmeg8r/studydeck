// WHAT: The storage-integrity banner — corruption said out loud, on every view.
// WHY: Assessment finding F12. Every corruption path in this app degrades quietly: a
//      corrupt JSON sidecar falls back to empty, a torn JSONL line is skipped, a malformed
//      deck used to vanish from its own list. Each one surfaces to the user as *less data*,
//      which is indistinguishable from having done less work — so the natural reading of a
//      damaged file is "I have no cards yet", and the real condition is never suspected.
//
//      `/api/health` has reported this since #18, and nothing in the browser read it, so in
//      practice it was still invisible. Diagnostics nobody is looking at are not
//      diagnostics; this is what turns that endpoint into something you cannot miss.
import { el } from './dom.mjs';
import { requestJson } from './api.mjs';

/** Dismissed for this tab only. sessionStorage, so a reload after a repair re-checks. */
const DISMISSED_KEY = 'studydeck.integrity.dismissed';

/**
 * One line per damaged thing, in the user's terms rather than the file format's.
 *
 * Deliberately concrete: the file, and what it means for what you are looking at. "attempts
 * .jsonl recovered from backup" is actionable in a way "status: degraded" never is.
 */
export function describe(topic) {
  const lines = [];
  const where = topic.topic_slug;

  for (const file of topic.degraded ?? []) {
    lines.push(`${where}: ${file} was recovered from its backup — the last write before the crash is gone.`);
  }
  if (topic.unparseable_lines > 0) {
    lines.push(`${where}: ${topic.unparseable_lines} unreadable line${topic.unparseable_lines === 1 ? '' : 's'} skipped in the append-only history — that history is incomplete.`);
  }
  for (const file of topic.stale_temp_files ?? []) {
    lines.push(`${where}: a temp file (${file}) was left behind by a write that died — the data it held never landed.`);
  }
  for (const deck of topic.unreadable_decks ?? []) {
    // Damaged content and an unreadable disk need different words, because they need
    // different actions — repair the file, versus look at permissions or the drive.
    lines.push(deck.kind === 'io'
      ? `${where}: deck ${deck.file} could not be read at all (${deck.error}) — this is a disk or permissions problem, not a damaged file.`
      : `${where}: deck ${deck.file} cannot be parsed (${deck.error}) — it is listed in Test Center but cannot be taken.`);
  }
  // Open Notebook has no idempotency key, so the cockpit never repeats these on its own:
  // a repeat may make a second note or episode. Hence "check first", not "try again".
  for (const op of topic.operations?.unresolved_list ?? []) {
    lines.push(`${where}: an Open Notebook write (${op.kind}, "${op.label}", ${op.ts ?? 'time unknown'}) never confirmed whether it landed — check Open Notebook for it before doing that action again. Recovery can look for it without repeating it.`);
  }
  const unapplied = topic.attempts?.mastery_unapplied ?? 0;
  if (unapplied > 0) {
    lines.push(`${where}: ${unapplied} graded attempt${unapplied === 1 ? '' : 's'} never updated mastery — confidence there is lower than your results show. Finish ${unapplied === 1 ? 'it' : 'them'} in Recovery; repeating the quiz would record a new attempt instead.`);
  }
  const cardsOwed = topic.attempts?.factcheck_cards_owed ?? 0;
  if (cardsOwed > 0) {
    lines.push(`${where}: ${cardsOwed} fact-check${cardsOwed === 1 ? '' : 's'} finished, but the corrective cards were never created. Create them in Recovery.`);
  }
  const ambiguous = topic.attempts?.mastery_ambiguous ?? 0;
  if (ambiguous > 0) {
    lines.push(`${where}: ${ambiguous} graded attempt${ambiguous === 1 ? '' : 's'} may or may not have updated mastery — it will not be applied automatically until the topic's state is reconciled.`);
  }
  return lines;
}

/** Whether Recovery can act on anything health reports. Storage damage is not its work. */
export function hasRecoverableWork(integrity) {
  return (integrity ?? []).some((topic) => (topic.attempts?.mastery_unapplied ?? 0) > 0
    || (topic.attempts?.factcheck_cards_owed ?? 0) > 0
    || (topic.operations?.unresolved ?? 0) > 0);
}

/**
 * One line per topic /api/state could not build. `[]` when every topic was built, and for
 * a server old enough not to send the field.
 */
export function unavailableTopicLines(state) {
  return (state.unavailable_topics ?? []).map((t) =>
    `${t.slug}: could not be read (${t.error}) — it is left out of every view, and the totals and badges below leave it out too.`);
}

/**
 * Put a banner above the view for every topic /api/state had to skip.
 *
 * No dismiss button, unlike the storage banner: a recovered backup is an event you can
 * acknowledge, while an unreadable topic is still missing on every load until it is fixed.
 */
export function renderUnavailableTopics(host, state) {
  const lines = unavailableTopicLines(state);
  if (lines.length === 0) return;

  const banner = el('div', { class: 'integrity-banner', role: 'status' });
  banner.append(el('strong', {}, lines.length === 1 ? 'A topic could not be loaded' : 'Some topics could not be loaded'));
  const list = el('ul', { class: 'integrity-list' });
  for (const line of lines) list.append(el('li', {}, line));
  banner.append(list);
  banner.append(el('p', { class: 'integrity-hint' },
    `Run npm run verify, and check the server log for the full error.${state.topics?.length ? ' The other topics are unaffected.' : ''}`));
  host.prepend(banner);
}

/**
 * Fetch health and, if anything is damaged, put a banner above the view.
 *
 * Failure here is deliberately silent: this is a diagnostic, and a diagnostic that breaks
 * the cockpit when it cannot reach its own endpoint is worse than no diagnostic. The rail's
 * ON status takes the same line.
 */
export async function renderIntegrityBanner(host) {
  if (sessionStorage.getItem(DISMISSED_KEY)) return;

  let health;
  try {
    health = await requestJson('/api/health');
  } catch {
    return;
  }
  if (health.status !== 'degraded') return;

  const lines = (health.integrity ?? []).flatMap(describe);
  if (lines.length === 0) return;

  const banner = el('div', { class: 'integrity-banner', role: 'status' });
  // Not every line is damage: a write whose outcome is unconfirmed is intact data with an
  // open question, and npm run verify does not report it. The words cover both.
  banner.append(el('strong', {}, 'Stored study data needs attention'));
  const list = el('ul', { class: 'integrity-list' });
  for (const line of lines) list.append(el('li', {}, line));
  banner.append(list);
  banner.append(el('p', { class: 'integrity-hint' },
    'Run npm run verify for the storage report. Counts and mastery below come from what could be read and settled, so they may understate your work.'));

  if (hasRecoverableWork(health.integrity)) {
    banner.append(el('a', { class: 'btn small primary', href: '#recovery' }, 'Open Recovery'));
  }

  const dismiss = el('button', { class: 'btn small', type: 'button' }, 'Dismiss for this session');
  dismiss.addEventListener('click', () => {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    banner.remove();
  });
  banner.append(dismiss);

  // Prepended, not appended: it must precede the numbers it is a caveat about.
  host.prepend(banner);
}
