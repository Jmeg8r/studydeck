// WHAT: Test Center — deck list, the runner, and server-graded results.
// WHY: The browser never sees an answer until the attempt that earned it is on disk, and
//      it never computes a score. Both properties are what keep a retake an honest
//      measurement.
//
// Submitting IS recording. There is no Discard: the old flow graded without writing,
// revealed every answer, and then let you throw the attempt away and retake it knowing
// the answers — which made the append-only history incomplete and the pretest baseline
// worthless. Self-checked items stay pending on the recorded attempt and are finalised
// separately; walking away from this screen keeps the auto-graded result.
import { clear, el } from '../dom.mjs';
import { requestJson as api } from '../api.mjs';
import { renderScoreChart } from '../chart.mjs';
import { withMutationId } from '../mutation.mjs';
import { renderEssay } from './essay.mjs';

const REVIEW_NOTE =
  'Spot-the-error items are not auto-graded — learn-anything reserves them for self-check. ' +
  'Compare your answer with the reference, then mark it honestly. Self-marked items are ' +
  'recorded as such.';
const CONFIDENCE_BANDS = [['', 'How confident?'], ['unsure', 'Unsure'], ['likely', 'Likely'], ['certain', 'Certain']];

// ---------- deck list ----------

function deckList(root, state, onOpen) {
  root.append(el('div', { class: 'crumb' }, 'Studydeck / Test Center'));

  const decks = state.topics.flatMap((t) => t.decks.map((d) => ({ ...d, topic_name: t.name, topic: t })));
  const card = el('div', { class: 'card' });
  // Counted apart, so the heading never implies a broken deck is one you can take.
  const unreadable = decks.filter((d) => d.unreadable).length;
  card.append(el('div', { class: 'cap' },
    `Decks · ${decks.length - unreadable}${unreadable > 0 ? ` · ${unreadable} unreadable` : ''}`));

  if (decks.length === 0) {
    card.append(el('div', { class: 'qrow' }, el('span', { class: 'empty' },
      'No decks yet. Run /learn:quiz in a Claude session to generate one — it persists here for token-free retakes.')));
    root.append(card);
    return;
  }

  for (const deck of decks) {
    // A deck that cannot be parsed is SHOWN, not skipped (F12). Dropping it made a corrupt
    // file look like a deck you never created — the one place you would have noticed it
    // missing said nothing. No Start button: there is nothing behind it to take.
    if (deck.unreadable) {
      const row = el('div', { class: 'qrow' });
      const label = el('span', {}, deck.file);
      label.append(el('span', { class: 'who' }, ` · ${deck.topic_name} · cannot be read: ${deck.unreadable}`));
      row.append(label, el('span', { class: 'pill owed' }, 'unreadable'));
      card.append(row);
      continue;
    }

    const attempts = deck.topic.attempts.filter((a) => a.deck_file === deck.file);
    const last = attempts[attempts.length - 1];

    const row = el('div', { class: 'qrow' });
    const label = el('span', {}, deck.concept_name);
    label.append(el('span', { class: 'who' },
      ` · ${deck.question_count} questions · ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}` +
      (last ? ` · last ${last.score}/${last.max}` : '')));

    const run = el('button', { class: 'btn', type: 'button' }, attempts.length ? 'Retake' : 'Start');
    run.addEventListener('click', () => onOpen(deck));
    row.append(label, run);
    card.append(row);
  }
  root.append(card);

  // History for the deck that actually has attempts.
  const withHistory = decks.find((d) => d.topic.attempts.some((a) => a.deck_file === d.file));
  if (withHistory) {
    const history = withHistory.topic.attempts
      .filter((a) => a.deck_file === withHistory.file)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    const chartCard = el('div', { class: 'card', style: 'margin-top:18px' });
    chartCard.append(el('div', { class: 'cap' }, `Score history · ${withHistory.concept_name}`));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chartCard.append(svg);
    queueMicrotask(() => renderScoreChart(svg, history));
    root.append(chartCard);
  }
}

// ---------- runner ----------

function questionField(question, responses, confidence) {
  const block = el('div', { class: 'q-block' });
  block.append(el('div', { class: 'q-prompt' }, `${question.id.toUpperCase()}. ${question.prompt}`));

  const name = `resp-${question.id}`;

  if (question.type === 'multiple_choice' || question.type === 'multi_select') {
    const multi = question.type === 'multi_select';
    if (multi) block.append(el('div', { class: 'q-hint' }, 'select all that apply'));

    for (const option of question.options) {
      const id = `${name}-${option.slice(0, 12).replace(/\W/g, '')}`;
      const wrap = el('label', { class: 'q-option', for: id });
      const input = el('input', { type: multi ? 'checkbox' : 'radio', name, id, value: option });
      input.addEventListener('change', () => {
        if (multi) {
          const chosen = [...block.querySelectorAll('input:checked')].map((i) => i.value);
          responses[question.id] = chosen;
        } else {
          responses[question.id] = option;
        }
      });
      wrap.append(input, el('span', {}, option));
      block.append(wrap);
    }
  } else if (question.type === 'true_false') {
    for (const option of ['true', 'false']) {
      const id = `${name}-${option}`;
      const wrap = el('label', { class: 'q-option', for: id });
      const input = el('input', { type: 'radio', name, id, value: option });
      input.addEventListener('change', () => { responses[question.id] = option; });
      wrap.append(input, el('span', {}, option === 'true' ? 'True' : 'False'));
      block.append(wrap);
    }
  } else if (question.type === 'error_correction') {
    block.append(el('div', { class: 'q-hint' }, 'self-checked after submit — explain the error in your own words'));
    const area = el('textarea', { class: 'q-input', rows: '4', placeholder: 'What is wrong, and why?' });
    area.addEventListener('input', () => { responses[question.id] = area.value; });
    block.append(area);
  } else {
    const input = el('input', { class: 'q-input', type: 'text', placeholder: 'Your answer' });
    input.addEventListener('input', () => { responses[question.id] = input.value; });
    block.append(input);
  }

  const confidenceSelect = el('select', { class: 'q-input' });
  for (const [value, label] of CONFIDENCE_BANDS) confidenceSelect.append(el('option', { value }, label));
  confidenceSelect.addEventListener('change', () => {
    if (confidenceSelect.value) confidence[question.id] = confidenceSelect.value;
    else delete confidence[question.id];
  });
  block.append(el('div', { class: 'q-hint' }, 'Confidence before feedback'), confidenceSelect);

  return block;
}

function runner(root, deck, safeDeck, onRecorded, onCancel) {
  const responses = {};
  const confidence = {};
  root.append(el('div', { class: 'crumb' }, `Studydeck / Test Center / ${deck.concept_name}`));

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' },
    `${safeDeck.questions.length} questions · answers stay on the server until you submit`));
  card.append(el('p', { class: 'q-hint' },
    'Submitting records the attempt. That is deliberate — an attempt you could see and ' +
    'then discard would make every later retake meaningless.'));
  for (const question of safeDeck.questions) card.append(questionField(question, responses, confidence));

  const actions = el('div', { class: 'q-actions' });
  const submit = el('button', { class: 'btn primary', type: 'button' }, 'Submit and record');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');

  submit.addEventListener('click', async () => {
    const missingConfidence = safeDeck.questions.filter((question) => {
      const response = responses[question.id];
      const answered = Array.isArray(response) ? response.length > 0 : response !== undefined && response !== null && response !== '';
      return answered && !confidence[question.id];
    });
    if (missingConfidence.length > 0) {
      actions.querySelector('.q-error')?.remove();
      actions.append(el('span', { class: 'q-error' }, 'Choose a confidence band for every answer before feedback.'));
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Grading…';
    actions.querySelector('.q-error')?.remove();
    try {
      // Keyed by the deck rather than held in a const minted at render time: a retry
      // after navigating away and back would otherwise carry a NEW id and record a second
      // attempt for one submission. Cleared on success, so a genuine retake is a new run.
      // The payload binds the id to these answers: changed answers are a new attempt.
      const request = { topic_slug: deck.topic_slug, deck_file: deck.file, responses, confidence };
      const saved = await withMutationId(`attempt:${deck.topic_slug}:${deck.file}`, (mutationId) =>
        api('/api/attempts', {
          method: 'POST',
          body: { ...request, mutation_id: mutationId },
        }), { payload: request });
      onRecorded(saved);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Submit and record';
      actions.append(el('span', { class: 'q-error' }, err.message));
    }
  });
  cancel.addEventListener('click', onCancel);

  actions.append(submit, cancel);
  card.append(actions);
  root.append(card);
}

// ---------- results ----------

/** The mastery outcome, or an honest account of why there isn't one yet. */
function masteryBlock(container, attempt, mastery) {
  if (attempt.status === 'pending_self_grade') {
    container.append(el('p', { class: 'q-hint' },
      'Mastery has not moved yet: the self-check item below has to be marked first. ' +
      'The attempt itself is already saved — leaving now keeps it.'));
    return;
  }

  if (mastery?.error) {
    // The attempt is on disk; only the mastery update failed. Say exactly that, so
    // nobody retakes the deck thinking nothing was saved.
    container.append(el('p', { class: 'q-error' },
      `Attempt saved, but mastery was not updated: ${mastery.error}`));
    container.append(el('p', { class: 'q-hint' },
      'Do not retake to "fix" this — the attempt is already recorded and a second run would double-count.'));
    return;
  }

  if (!mastery) return;

  container.append(el('p', { class: 'q-hint' },
    `Performance band: ${mastery.band}. ` +
    `${mastery.before.status} → ${mastery.after.status}, ` +
    `confidence ${mastery.before.confidence} → ${mastery.after.confidence}, ` +
    `practice count ${mastery.before.practice_count} → ${mastery.after.practice_count}.`));
  if (mastery.render) container.append(el('div', { class: 'q-explain' }, mastery.render));
}

function results(root, deck, saved, onDone) {
  const selfGrades = {};
  const { attempt, results: graded } = saved;
  root.append(el('div', { class: 'crumb' }, `Studydeck / Test Center / ${deck.concept_name} / Results`));

  const auto = graded.filter((r) => r.correct !== null);
  const pending = graded.filter((r) => r.correct === null);

  const summary = el('div', { class: 'card' });
  summary.append(el('div', { class: 'cap' }, 'Recorded · graded by the server'));
  // A self-marked score must never be presented as a machine-graded one — the whole point
  // of keeping `self_graded` on the attempt is that the distinction survives.
  const selfMarked = attempt.self_graded?.length ?? 0;
  summary.append(el('h2', { class: 'score-line' },
    `${attempt.score} / ${attempt.max}` + (
      pending.length > 0 ? ' auto-graded so far'
        : selfMarked > 0 ? ` · ${auto.length - selfMarked} auto-graded, ${selfMarked} self-marked`
          : ' auto-graded')));
  masteryBlock(summary, attempt, saved.mastery);
  if (pending.length) {
    summary.append(el('p', { class: 'q-hint' }, REVIEW_NOTE));
  }
  root.append(summary);

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  for (const result of graded) {
    const block = el('div', { class: 'q-block' });
    const verdict = result.correct === null ? 'self-check' : result.correct ? 'correct' : 'missed';
    const head = el('div', { class: 'q-prompt' });
    head.append(el('span', { class: `verdict ${verdict.replace('-', '')}` }, verdict));
    head.append(` ${result.id.toUpperCase()}. ${result.prompt}`);
    block.append(head);

    const given = Array.isArray(result.response) ? result.response.join(' · ') : result.response;
    block.append(el('div', { class: 'q-hint' }, `You answered: ${given || '(blank)'}`));
    if (result.confidence) block.append(el('div', { class: 'q-hint' }, `Confidence before feedback: ${result.confidence}`));

    const answerText = Array.isArray(result.answer) ? result.answer.join(' · ') : String(result.answer);
    block.append(el('div', { class: 'q-answer' }, `Answer: ${answerText}`));
    if (result.explanation) block.append(el('div', { class: 'q-explain' }, result.explanation));

    // ai_only items: the learner marks their own, and it is recorded as self-graded.
    if (result.correct === null) {
      const marks = el('div', { class: 'q-selfgrade' });
      marks.append(el('span', { class: 'q-hint' }, 'Did you get it?'));
      for (const [label, value] of [['I got it', true], ['I missed it', false]]) {
        const btn = el('button', { class: 'btn small', type: 'button' }, label);
        btn.addEventListener('click', () => {
          selfGrades[result.id] = value;
          [...marks.querySelectorAll('button')].forEach((b) => b.classList.remove('primary'));
          btn.classList.add('primary');
        });
        marks.append(btn);
      }
      block.append(marks);
    }
    card.append(block);
  }

  const actions = el('div', { class: 'q-actions' });
  const done = el('button', { class: 'btn', type: 'button' }, 'Back to Test Center');
  done.addEventListener('click', onDone);

  // Nothing here can discard the attempt — it is already history. The only thing left to
  // do is finalise the items the server cannot grade.
  if (pending.length > 0) {
    const finalize = el('button', { class: 'btn primary', type: 'button' }, 'Finalize attempt');

    finalize.addEventListener('click', async () => {
      actions.querySelector('.q-error')?.remove();
      if (Object.keys(selfGrades).length < pending.length) {
        actions.append(el('span', { class: 'q-error' }, 'Mark the self-check item first.'));
        return;
      }
      finalize.disabled = true;
      finalize.textContent = 'Finalizing…';
      try {
        const request = { topic_slug: deck.topic_slug, self_grades: selfGrades };
        const finalized = await withMutationId(`finalize:${attempt.attempt_id}`, (mutationId) =>
          api(`/api/attempts/${encodeURIComponent(attempt.attempt_id)}/finalize`, {
            method: 'POST',
            body: { ...request, mutation_id: mutationId },
          }), { payload: request });
        // Re-render from the finalized revision: same screen, now with mastery on it.
        clear(root);
        results(root, deck, { ...finalized, results: finalized.results ?? graded }, onDone);
      } catch (err) {
        finalize.disabled = false;
        finalize.textContent = 'Finalize attempt';
        actions.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    actions.append(finalize);
  }

  actions.append(done);
  card.append(actions);
  root.append(card);
}

// ---------- entry ----------

export function renderTestCenter(root, state, { reload, refreshState, topic }) {
  const show = (fn) => { clear(root); fn(root); };

  const openDeck = async (deck) => {
    clear(root);
    root.append(el('div', { class: 'loading' }, 'Loading deck…'));
    try {
      const safeDeck = await api(`/api/decks/${deck.topic_slug}/${encodeURIComponent(deck.file)}`);
      show((r) => runner(r, deck, safeDeck,
        (saved) => show((r2) => results(r2, deck, saved, reload)),
        () => show((r2) => deckList(r2, state, openDeck))));
    } catch (err) {
      show((r) => {
        const panel = el('div', { class: 'error-panel' });
        panel.append(el('h2', {}, 'Could not open the deck'), el('pre', {}, err.message));
        r.append(panel);
      });
    }
  };

  deckList(root, state, openDeck);
  // Step 8: written answers graded against a rubric on the local model.
  renderEssay(root, state, { onGraded: refreshState, topic });
}
