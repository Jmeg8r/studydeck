// WHAT: Walk-debrief capture box — paste the capture-back, get an ON note and cards.
// WHY: The spec makes capture-back mandatory at the end of every voice session (Step 7),
//      and its error-routing rule turns each misconception into a flashcard.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { withMutationId } from '../mutation.mjs';

const PROMPT_REMINDER =
  'At the end of the walk, ask: "Summarize this discussion: list every point I got wrong, ' +
  'fuzzy, or asked to have re-explained, as bullet points." Paste that summary here.';

export function renderDebrief(root, state, { onSaved, topic }) {

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Walk debrief · capture-back'));
  card.append(el('p', { class: 'q-hint' }, PROMPT_REMINDER));

  const text = el('textarea', { class: 'q-input', rows: '8', placeholder: '- I confused validation and test sets\n- Fuzzy on what fine_tune does to the body' });
  card.append(text);

  const actions = el('div', { class: 'q-actions' });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save debrief');
  const output = el('div');

  save.addEventListener('click', async () => {
    actions.querySelector('.q-error')?.remove();
    clear(output);
    save.disabled = true;
    save.textContent = 'Saving… (~15s for cards)';
    try {
      // One id per submission, held across retries. Card generation takes ~15s, so a lost
      // response is a real possibility; clicking Save again then replays the recorded
      // outcome instead of writing a second ON note and a second set of cards.
      //
      // The ok-check is INSIDE the helper on purpose: it clears the id when `send`
      // resolves, so returning a failed response instead of throwing would drop the id
      // and let the retry record a second debrief.
      const request = { topic_slug: topic.slug, text: text.value };
      const body = await withMutationId(`debrief:${topic.slug}`, (mutationId) =>
        requestJson('/api/debrief', {
          method: 'POST', body: { ...request, mutation_id: mutationId },
        }), { payload: request });

      // Note and cards can succeed independently — report each honestly.
      output.append(el('p', { class: 'q-hint' },
        body.note ? `Saved to Open Notebook as “Walk debrief”.` : `Note not saved: ${body.note_error}`));

      if (body.created_cards.length > 0) {
        output.append(el('p', { class: 'q-hint' }, `${body.created_cards.length} cards queued:`));
        for (const cardItem of body.created_cards) {
          const row = el('div', { class: 'qrow' });
          row.append(el('span', {}, cardItem.front));
          output.append(row);
        }
      } else if (body.cards_error) {
        output.append(el('p', { class: 'q-error' }, `Cards not generated: ${body.cards_error}`));
        output.append(el('p', { class: 'q-hint' },
          'The debrief text itself is safe — only the card generation failed.'));
      }

      save.textContent = 'Save another';
      save.disabled = false;
      text.value = '';
      // The helper already dropped the id on success, so "Save another" is a NEW
      // mutation even on the same day — exactly the case whose colliding card ids
      // used to be dropped.
      onSaved?.();
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save debrief';
      actions.append(el('span', { class: 'q-error' }, err.message));
    }
  });

  actions.append(save);
  card.append(actions, output);
  root.append(card);
}
