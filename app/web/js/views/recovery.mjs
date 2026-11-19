// WHAT: Recovery — the work the cockpit started but could not finish, and the one safe
//       action each item allows.
// WHY:  /api/health already reported owed mastery and unconfirmed Open Notebook writes, and
//       nothing in the cockpit could act on them. Every action here is replay-safe on the
//       server, so a double click or a lost response changes nothing twice. The status line
//       sits outside the list the view redraws, and takes focus after each action, so a
//       keyboard or screen-reader user is not dropped at the top of the page (WCAG 2.4.3).
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { createViewScope, isAbortError } from '../lifecycle.mjs';
import { setWorkingTopic } from '../topic.mjs';
import {
  EMPTY, INTRO, actionFor, describeItem, errorMessage, outcomeMessage, resumeFor,
} from '../recoverycopy.mjs';

const SECTIONS = [
  ['needs_action', 'Needs action'],
  ['blocked', "Can't be finished here"],
  ['in_progress', 'In progress'],
];

const domId = (...parts) => `recovery-${parts.join('-').replace(/[^A-Za-z0-9_-]/g, '-')}`;

/**
 * One action: POST it, then refresh the state other views render from. The refresh runs
 * after an error too, because the write may have landed before the response was lost.
 * The POST takes no view signal: aborting the browser request would not stop the server's
 * write, only hide it from the refresh. Returns the status line.
 */
export async function runRecoveryAction({ request, refresh, topicSlug, item, action }) {
  let message;
  try {
    const result = await request(action.path, {
      method: 'POST', body: { topic_slug: topicSlug, ...action.body },
    });
    message = outcomeMessage(item, result.outcome);
  } catch (err) {
    message = errorMessage(err);
  }
  await refresh();
  return message;
}

export function renderRecovery(root, { refresh, track } = {}) {
  // Settling writes state.json and cards.json, which Today, Stats and Flashcards read from
  // main.mjs's copy. Without a way to refresh it, and to hold navigation until that refresh
  // lands, they go stale, so refuse to draw at all.
  if (typeof refresh !== 'function') throw new TypeError('renderRecovery needs a refresh callback');
  if (typeof track !== 'function') throw new TypeError('renderRecovery needs a track callback');
  const scope = createViewScope();
  const status = el('p', { class: 'q-hint recovery-status', role: 'status', tabindex: '-1' });
  const list = el('div', { class: 'recovery-list' });
  clear(root);
  root.append(
    el('h1', { class: 'crumb recovery-title' }, 'Studydeck / Recovery'),
    el('p', { class: 'q-hint' }, INTRO),
    status,
    list,
  );

  async function run(button, topicSlug, item, action) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Working…';
    const message = await track(runRecoveryAction({ request: requestJson, refresh, topicSlug, item, action }));
    if (scope.signal.aborted) return;
    status.textContent = message;
    await load({ focusStatus: true });
  }

  function card(topicSlug, item) {
    const key = item.attempt_id ?? item.operation_id ?? item.ts;
    const describedBy = domId(topicSlug, key, 'text');
    const li = el('li', { class: 'card recovery-item' });
    li.append(el('p', { id: describedBy }, describeItem(item)));

    const action = actionFor(item);
    if (action) {
      const button = el('button', { class: 'btn primary', type: 'button', 'aria-describedby': describedBy }, action.label);
      button.addEventListener('click', () => run(button, topicSlug, item, action));
      li.append(button);
    }
    const resume = resumeFor(item);
    if (resume) {
      const link = el('a', { class: 'btn', href: resume.href, 'aria-describedby': describedBy }, resume.label);
      link.addEventListener('click', () => setWorkingTopic(topicSlug));
      li.append(link);
    }

    const ids = {
      topic_slug: topicSlug,
      ...(item.attempt_id ? { attempt_id: item.attempt_id, status: item.status } : {}),
      ...(item.operation_id ? { operation_id: item.operation_id, kind: item.kind, stage: item.stage } : {}),
    };
    li.append(el('details', {},
      el('summary', {}, 'Identifiers'),
      el('pre', { class: 'recovery-ids' }, JSON.stringify(ids, null, 2))));
    return li;
  }

  async function load({ focusStatus = false } = {}) {
    let payload;
    try {
      payload = await requestJson('/api/recovery', { signal: scope.signal });
    } catch (err) {
      if (scope.signal.aborted || isAbortError(err)) return;
      status.textContent = errorMessage(err);
      return;
    }
    if (scope.signal.aborted) return;

    clear(list);
    let shown = 0;
    for (const topic of payload.topics ?? []) {
      if (topic.error) list.append(el('p', { class: 'q-error', role: 'alert' }, `${topic.topic_slug}: ${topic.error}`));
      const sections = SECTIONS.filter(([field]) => (topic[field] ?? []).length > 0);
      if (sections.length === 0) continue;

      const headingId = domId(topic.topic_slug);
      const block = el('section', { class: 'recovery-topic', 'aria-labelledby': headingId });
      block.append(el('h2', { class: 'cap', id: headingId }, topic.topic_slug));
      for (const [field, title] of sections) {
        const items = topic[field];
        shown += items.length;
        const ul = el('ul', { class: 'recovery-items' });
        for (const item of items) ul.append(card(topic.topic_slug, item));
        block.append(el('h3', { class: 'recovery-section' }, `${title} (${items.length})`), ul);
      }
      list.append(block);
    }
    if (shown === 0) list.append(el('p', { class: 'q-hint' }, EMPTY));
    if (focusStatus) status.focus();
  }

  load();
  return () => scope.dispose();
}
