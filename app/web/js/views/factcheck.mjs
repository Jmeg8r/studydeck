// WHAT: Fact-Check — verify AI-written claims against what you actually know.
// WHY: Step 4b. Verification is the active ingredient, so claims arrive WITHOUT their
//      truth values (same principle as answer-free quiz decks) and every mark you get
//      wrong becomes a card.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { withMutationId } from '../mutation.mjs';

const CONFIDENCE_BANDS = [['', 'How confident?'], ['unsure', 'Unsure'], ['likely', 'Likely'], ['certain', 'Certain']];

function runView(root, topic, record, onDone) {
  const marks = {};
  const confidence = {};
  root.append(el('div', { class: 'crumb' },
    `Studydeck / Fact-Check / ${record.source_title}${record.section ? ` § ${record.section}` : ''}`));

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' }, `${record.claims.length} claims · mark each before revealing`));
  card.append(el('p', { class: 'q-hint' },
    'Some of these are deliberately wrong. Decide from what you know and the source — ' +
    'the ones you call incorrectly become flashcards.'));

  for (const claim of record.claims) {
    const block = el('div', { class: 'q-block' });
    block.append(el('div', { class: 'q-prompt' }, claim.text));

    const row = el('div', { class: 'q-selfgrade' });
    for (const [label, value] of [['True', true], ['False', false]]) {
      const btn = el('button', { class: 'btn small', type: 'button' }, label);
      btn.addEventListener('click', () => {
        marks[claim.id] = value;
        [...row.querySelectorAll('button')].forEach((b) => b.classList.remove('primary'));
        btn.classList.add('primary');
      });
      row.append(btn);
    }
    block.append(row);

    const confidenceSelect = el('select', { class: 'q-input' });
    for (const [value, label] of CONFIDENCE_BANDS) confidenceSelect.append(el('option', { value }, label));
    confidenceSelect.addEventListener('change', () => {
      if (confidenceSelect.value) confidence[claim.id] = confidenceSelect.value;
      else delete confidence[claim.id];
    });
    block.append(el('div', { class: 'q-hint' }, 'Confidence before feedback'), confidenceSelect);
    card.append(block);
  }

  const actions = el('div', { class: 'q-actions' });
  const submit = el('button', { class: 'btn primary', type: 'button' }, 'Reveal and score');
  let confirmedUnmarked = false;
  submit.addEventListener('click', async () => {
    const unmarked = record.claims.filter((c) => !(c.id in marks)).length;
    // The warning was previously shown and then ignored — submission continued in the
    // same click, so it only ever flashed. Now it actually holds, once.
    if (unmarked > 0 && !confirmedUnmarked) {
      confirmedUnmarked = true;
      actions.querySelector('.q-error')?.remove();
      actions.append(el('span', { class: 'q-error' },
        `${unmarked} still unmarked — those count as wrong. Click again to score anyway.`));
      return;
    }
    if (record.claims.some((claim) => claim.id in marks && !confidence[claim.id])) {
      actions.querySelector('.q-error')?.remove();
      actions.append(el('span', { class: 'q-error' }, 'Choose a confidence band for every mark before feedback.'));
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Scoring…';
    try {
      // One id per claim set: scoreRun mints cards, so a retry after a lost response
      // must be recognised rather than scored (and carded) a second time.
      const request = {
        topic_slug: topic.slug,
        source_id: record.source_id,
        section: record.section,
        marks,
        confidence,
      };
      const scored = await withMutationId(
        `factcheck:${record.source_id}#${record.section || 'all'}`,
        (mutationId) => requestJson('/api/factcheck/run', { method: 'POST', body: { ...request, mutation_id: mutationId } }),
        { payload: request },
      );
      clear(root);
      resultsView(root, topic, record, scored, onDone);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Reveal and score';
      actions.append(el('span', { class: 'q-error' }, err.message));
    }
  });
  actions.append(submit);
  card.append(actions);
  root.append(card);
}

function resultsView(root, topic, record, scored, onDone) {
  root.append(el('div', { class: 'crumb' }, 'Studydeck / Fact-Check / Results'));

  const head = el('div', { class: 'card' });
  // A fresh /run response has proposals but no adjudication object yet; all claims are
  // therefore pending even though the compact API response omits a redundant list.
  const pending = scored.pending ?? (scored.attempt?.status === 'pending_confirmation'
    ? scored.results.map((result) => result.id)
    : []);
  const unresolved = pending.length + (scored.disputed?.length ?? 0);
  head.append(el('div', { class: 'cap' }, unresolved ? 'Model proposals — learner confirmation required' : 'Learner-adjudicated'));
  if (scored.max != null) head.append(el('h2', { class: 'score-line' }, `${scored.score} / ${scored.max}`));
  head.append(el('p', { class: 'q-hint' },
    unresolved > 0
      ? 'Confirm, correct, or dispute every proposed verdict. Disputed and unanswered decisions stay out of mastery and do not make cards.'
      : scored.created_cards.length > 0
      ? `${scored.created_cards.length} card${scored.created_cards.length === 1 ? '' : 's'} queued from the marks you got wrong — they are the strongest kind.`
      : 'Every claim called correctly. No cards needed.'));
  root.append(head);

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  const decisions = {};
  for (const result of scored.results) {
    const block = el('div', { class: 'q-block' });
    const verdict = result.correct ? 'correct' : 'missed';
    const head2 = el('div', { class: 'q-prompt' });
    head2.append(el('span', { class: `verdict ${verdict}` }, verdict));
    head2.append(` ${result.text}`);
    block.append(head2);

    block.append(el('div', { class: 'q-hint' },
      `Actually ${result.truth ? 'TRUE' : 'FALSE'} · you marked ${result.answered ? (result.marked ? 'true' : 'false') : 'nothing'}`));
    if (result.confidence) block.append(el('div', { class: 'q-hint' }, `Confidence before feedback: ${result.confidence}`));
    if (result.correction) block.append(el('div', { class: 'q-explain' }, `Model note: ${result.correction}`));

    if (unresolved > 0) {
      const controls = el('div', { class: 'q-selfgrade' });
      const select = (decision, button) => {
        decisions[result.id] = decision;
        [...controls.querySelectorAll('button')].forEach((item) => item.classList.remove('primary'));
        button.classList.add('primary');
      };
      const choices = [
        ['Accept model verdict', { action: 'accept' }],
        ['Correct: true', { action: 'correct', truth: true }],
        ['Correct: false', { action: 'correct', truth: false }],
        ['Dispute', { action: 'dispute' }],
      ];
      for (const [label, decision] of choices) {
        const button = el('button', { class: 'btn small', type: 'button' }, label);
        button.addEventListener('click', () => select(decision, button));
        controls.append(button);
        if ((result.adjudication === 'accepted' && decision.action === 'accept') ||
          (result.adjudication === 'corrected' && decision.action === 'correct' && result.truth === decision.truth) ||
          (result.adjudication === 'disputed' && decision.action === 'dispute')) {
          select(decision, button);
        }
      }
      block.append(controls);
    }
    card.append(block);
  }

  const actions = el('div', { class: 'q-actions' });
  if (unresolved > 0) {
    const settle = el('button', { class: 'btn primary', type: 'button' }, 'Record adjudications');
    settle.addEventListener('click', async () => {
      actions.querySelector('.q-error')?.remove();
      settle.disabled = true;
      settle.textContent = 'Recording…';
      try {
        const request = { topic_slug: topic.slug, decisions };
        const outcome = await withMutationId(`factcheck-adjudicate:${scored.attempt.attempt_id}`, (mutationId) =>
          requestJson(`/api/factcheck/runs/${encodeURIComponent(scored.attempt.attempt_id)}/adjudicate`, { method: 'POST', body: {
            ...request, mutation_id: mutationId,
          }}), { payload: request });
        clear(root);
        resultsView(root, topic, record, outcome, onDone);
      } catch (err) {
        settle.disabled = false;
        settle.textContent = 'Record adjudications';
        actions.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    actions.append(settle);
  }
  const done = el('button', { class: 'btn primary', type: 'button' }, 'Back to Fact-Check');
  done.addEventListener('click', onDone);
  actions.append(done);
  card.append(actions);
  root.append(card);
}

export function renderFactCheck(root, state, { topic }) {

  const showHome = async () => {
    clear(root);
    root.append(el('div', { class: 'crumb' }, 'Studydeck / Fact-Check'));
    root.append(el('div', { class: 'loading' }, 'Loading…'));

    let existing = {};
    let sources = [];
    try {
      [existing, sources] = await Promise.all([
        requestJson(`/api/factcheck?topic=${encodeURIComponent(topic.slug)}`),
        requestJson(`/api/on/sources?topic=${encodeURIComponent(topic.slug)}`).then((p) => p.sources).catch(() => []),
      ]);
    } catch (err) {
      clear(root);
      root.append(el('div', { class: 'crumb' }, 'Studydeck / Fact-Check'));
      const panel = el('div', { class: 'error-panel' });
      panel.append(el('h2', {}, 'Could not load fact-check state'), el('pre', {}, err.message));
      root.append(panel);
      return;
    }

    clear(root);
    root.append(el('div', { class: 'crumb' }, 'Studydeck / Fact-Check'));

    // Proposals are visible only because their marks were already appended. Surface them
    // again after a reload so an interrupted learner can finish adjudicating rather than
    // creating a second run (and a second piece of learning history).
    const topicState = state.topics.find((item) => item.slug === topic.slug);
    const pendingRuns = (topicState?.attempts ?? []).filter((attempt) =>
      attempt.kind === 'factcheck' && attempt.status === 'pending_confirmation' && attempt.factcheck_proposal);
    if (pendingRuns.length > 0) {
      const pending = el('div', { class: 'card' });
      pending.append(el('div', { class: 'cap' }, `Pending adjudications · ${pendingRuns.length}`));
      pending.append(el('p', { class: 'q-hint' },
        'These recorded marks have model proposals awaiting your confirmation. They do not count toward mastery yet.'));
      for (const attempt of pendingRuns) {
        const proposal = attempt.factcheck_proposal;
        const row = el('div', { class: 'qrow' });
        row.append(el('span', {}, `${proposal.source_title}${proposal.section ? ` § ${proposal.section}` : ''}`));
        const resume = el('button', { class: 'btn small', type: 'button' }, 'Resume');
        resume.addEventListener('click', () => {
          clear(root);
          const adjudication = attempt.factcheck_adjudication;
          resultsView(root, topic, proposal, {
            attempt,
            results: adjudication?.results ?? proposal.results,
            score: adjudication?.score ?? null,
            max: adjudication?.max ?? null,
            pending: adjudication?.pending,
            disputed: adjudication?.disputed ?? [],
            created_cards: [],
          }, showHome);
        });
        row.append(resume);
        pending.append(row);
      }
      root.append(pending);
    }

    const sets = Object.entries(existing);
    const ready = el('div', { class: 'card' });
    ready.append(el('div', { class: 'cap' }, `Claim sets ready · ${sets.length}`));

    if (sets.length === 0) {
      ready.append(el('p', { class: 'q-hint' },
        'None yet. Generate a set from a source below — the local model writes eight claims, ' +
        'five true and three subtly wrong.'));
    }
    for (const [, record] of sets) {
      const row = el('div', { class: 'qrow' });
      const label = el('span', {}, `${record.source_title}${record.section ? ` § ${record.section}` : ''}`);
      label.append(el('span', { class: 'who' },
        ` · ${record.claims.length} claims · generated ${record.generated.slice(0, 10)}${record.truncated ? ' · from an excerpt' : ''}`));
      const run = el('button', { class: 'btn small', type: 'button' }, 'Run');
      run.addEventListener('click', () => {
        clear(root);
        // No client-side stripping: the server never sent the verdicts. Discarding them
        // here was security theatre — the payload had already crossed the wire.
        runView(root, topic, record, showHome);
      });
      row.append(label, run);
      ready.append(row);
    }
    root.append(ready);

    // Generation is a slow local-model call, so it is explicit and clearly labelled.
    const gen = el('div', { class: 'card', style: 'margin-top:18px' });
    gen.append(el('div', { class: 'cap' }, 'Generate a new set'));
    if (sources.length === 0) {
      gen.append(el('p', { class: 'q-hint' },
        'No sources available — the Reading Room needs Open Notebook running to list them.'));
      root.append(gen);
      return;
    }

    gen.append(el('p', { class: 'q-hint' },
      'Runs the fact_check_claims transformation on the local model. Expect roughly a minute; ' +
      'the result is saved so a re-run is instant.'));

    const picker = el('select', { class: 'q-input' });
    for (const source of sources) picker.append(el('option', { value: source.id }, source.title));
    gen.append(picker);

    const actions = el('div', { class: 'q-actions' });
    const go = el('button', { class: 'btn primary', type: 'button' }, 'Generate claims');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Generating… (~1 min)';
      actions.querySelector('.q-error')?.remove();
      try {
        const source = await requestJson(`/api/on/sources/${encodeURIComponent(picker.value)}`);
        await requestJson('/api/factcheck/generate', { method: 'POST', body: {
          topic_slug: topic.slug,
          source_id: source.id,
          source_title: source.title,
          text: source.text,
        }});
        showHome();
      } catch (err) {
        go.disabled = false;
        go.textContent = 'Generate claims';
        actions.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    actions.append(go);
    gen.append(actions);
    root.append(gen);
  };

  showHome();
}
