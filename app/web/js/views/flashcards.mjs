// WHAT: Flashcards — due queue, review session, weak-cards-only filter.
// WHY: Retrieval practice only works if the answer stays hidden until you have
//      actually tried to recall it, so the back of a card is never in the DOM
//      until you ask to see it.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { withMutationId } from '../mutation.mjs';
import { renderDebrief } from './debrief.mjs';

/** Flatten every topic's cards, tagged with their topic — the spec interleaves them. */
function allCards(state) {
  return state.topics.flatMap((t) => t.cards.map((c) => ({ ...c, topic_slug: t.slug, topic_name: t.name })));
}

function dueLabel(card) {
  if (card.suspended) return 'suspended';
  if (card.overdue_days > 0) return `${card.overdue_days}d overdue`;
  if (card.overdue_days === 0) return 'due today';
  return `in ${-card.overdue_days}d`;
}

// ---------- review session ----------

function session(root, queue, index, { onDone, reload }) {
  const card = queue[index];
  if (!card) return onDone();

  root.append(el('div', { class: 'crumb' }, `Studydeck / Flashcards / ${index + 1} of ${queue.length}`));

  const wrap = el('div', { class: 'card' });
  wrap.append(el('div', { class: 'cap' }, `${card.topic_name} · ${card.concept_slug ?? 'unassigned'}`));
  wrap.append(el('div', { class: 'card-front' }, card.front));

  const actions = el('div', { class: 'q-actions' });
  const reveal = el('button', { class: 'btn primary', type: 'button' }, 'Show answer');

  reveal.addEventListener('click', () => {
    reveal.remove();
    // Only now does the answer enter the document.
    wrap.insertBefore(el('div', { class: 'card-back' }, card.back), actions);

    for (const [label, result, cls] of [['I got it', 'hit', 'primary'], ['I missed it', 'miss', '']]) {
      const btn = el('button', { class: `btn ${cls}`.trim(), type: 'button' }, label);
      btn.addEventListener('click', async () => {
        [...actions.querySelectorAll('button')].forEach((b) => { b.disabled = true; });
        try {
          // Keyed by card AND verdict: "hit on this card" and "miss on this card" are
          // different intents, and sharing an id would swallow the second as a replay.
          const request = { topic_slug: card.topic_slug, card_id: card.id, result };
          await withMutationId(`review:${card.id}:${result}`, (mutationId) =>
            requestJson('/api/reviews', { method: 'POST', body: { ...request, mutation_id: mutationId } }),
          { payload: request });
          clear(root);
          session(root, queue, index + 1, { onDone, reload });
        } catch (err) {
          // Re-enable, or the session is stuck: the buttons were disabled on click and
          // nothing turned them back on, so a failed review could only be escaped by
          // reloading — and the stable mutation id above exists precisely so the RETRY
          // is recognised. An id no one can ever send twice protects nothing.
          [...actions.querySelectorAll('button')].forEach((b) => { b.disabled = false; });
          actions.querySelector('.q-error')?.remove();
          actions.append(el('span', { class: 'q-error' }, err.message));
        }
      });
      actions.append(btn);
    }
  });

  actions.append(reveal);
  wrap.append(actions);
  root.append(wrap);
}

// ---------- list ----------

export function renderFlashcards(root, state, { reload, refreshState, topic }) {
  let weakOnly = false;

  const paint = () => {
    clear(root);
    root.append(el('div', { class: 'crumb' }, 'Studydeck / Flashcards'));

    const cards = allCards(state);
    const unqueued = state.topics.reduce((n, t) => n + (t.unqueued_misses ?? 0), 0);

    // Misses without cards: offered, never created behind your back.
    if (unqueued > 0) {
      const banner = el('div', { class: 'card' });
      banner.append(el('div', { class: 'cap' }, 'Unqueued misses'));
      banner.append(el('p', { class: 'q-hint' },
        `${unqueued} recorded quiz miss${unqueued === 1 ? '' : 'es'} ${unqueued === 1 ? 'has' : 'have'} no card yet. ` +
        'Caught errors make the strongest cards — queue them and they land on the next scheduled session.'));
      const queueBtn = el('button', { class: 'btn primary', type: 'button' }, 'Queue cards from misses');
      queueBtn.addEventListener('click', async () => {
        queueBtn.disabled = true;
        queueBtn.textContent = 'Queueing…';
        try {
          await requestJson('/api/cards/sync', { method: 'POST', body: {} });
          reload();
        } catch (err) {
          queueBtn.disabled = false;
          banner.append(el('span', { class: 'q-error' }, err.message));
        }
      });
      banner.append(queueBtn);
      root.append(banner);
    }

    if (cards.length === 0) {
      const empty = el('div', { class: 'card', style: 'margin-top:18px' });
      empty.append(el('div', { class: 'cap' }, 'No cards yet'));
      empty.append(el('p', { class: 'q-hint' },
        'Cards come from quiz misses, walk debriefs and fact-check errors — the things you actually got wrong.'));
      root.append(empty);
      // The debrief box is one of the ways cards get created, so it must be reachable
      // precisely when there are none yet.
      renderDebrief(root, state, { onSaved: refreshState, topic });
      return;
    }

    const visible = weakOnly ? cards.filter((c) => c.miss_rate > 0) : cards;
    const due = visible.filter((c) => c.due_now);

    const head = el('div', { class: 'card', style: 'margin-top:18px' });
    const bar = el('div', { class: 'filter-bar' });
    bar.append(el('div', { class: 'cap' },
      `${due.length} due · ${visible.length} shown · ${cards.length} total`));

    const toggle = el('button', { class: `btn small${weakOnly ? ' primary' : ''}`, type: 'button' },
      weakOnly ? 'Weak cards only ✓' : 'Weak cards only');
    toggle.addEventListener('click', () => { weakOnly = !weakOnly; paint(); });
    bar.append(toggle);

    if (due.length > 0) {
      const start = el('button', { class: 'btn primary', type: 'button' }, `Review ${due.length}`);
      start.addEventListener('click', () => {
        clear(root);
        session(root, due, 0, { onDone: reload, reload });
      });
      bar.append(start);
    }
    head.append(bar);

    if (visible.length === 0) {
      head.append(el('p', { class: 'q-hint', style: 'margin-top:14px' },
        'No cards have been missed in review yet — nothing qualifies as weak.'));
    }

    for (const card of visible) {
      const row = el('div', { class: 'qrow' });
      const label = el('span', {}, card.front.length > 88 ? `${card.front.slice(0, 88)}…` : card.front);
      const meta = [
        card.concept_slug,
        card.source,
        card.reviews > 0 ? `${card.hits}/${card.reviews} hit` : 'never reviewed',
        card.interval ? `${card.interval}d interval` : null,
      ].filter(Boolean).join(' · ');
      label.append(el('span', { class: 'who' }, ` · ${meta}`));
      row.append(label, el('span', { class: `pill${card.due_now ? ' hot' : ''}` }, dueLabel(card)));
      head.append(row);
    }
    root.append(head);

    // Step 7's mandatory capture-back: its misconceptions become cards, so it lives here.
    renderDebrief(root, state, { onSaved: refreshState, topic });
  };

  paint();
}
