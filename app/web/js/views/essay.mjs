// WHAT: Written-answer grading against a rubric, on the local model.
// WHY: Step 8 of the spec — self-explanation. You write the answer, the model grades it
//      against a rubric drawn from the sources, and a weak grade sends that section back
//      to re-reading rather than just re-quizzing.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { resetMutationId, withMutationId } from '../mutation.mjs';

/** Rubrics are written by the learner: grading against your own criteria is the point. */
const PLACEHOLDER_RUBRIC =
  'What must a strong answer contain? One criterion per line, e.g.\n' +
  '- states that the validation set is held out from training\n' +
  '- explains that it exists to detect overfitting';
const CONFIDENCE_BANDS = [['', 'How confident?'], ['unsure', 'Unsure'], ['likely', 'Likely'], ['certain', 'Certain']];

/** Build the browser payload independently of the DOM so its replay contract stays testable. */
export function buildEssayGradeRequest({ topicSlug, conceptSlug, sourceId, question, rubric, answer, max, confidence, mutationId }) {
  return {
    topic_slug: topicSlug,
    concept_slug: conceptSlug || null,
    source_id: sourceId,
    question,
    rubric,
    answer,
    max: Number(max) || 5,
    confidence,
    mutation_id: mutationId,
  };
}

/** Pending assessment revisions stay out of learning stats, but must never become invisible. */
export function pendingEssayAttempts(state) {
  return state.topics.flatMap((topic) => topic.attempts
    .filter((attempt) => attempt.kind === 'essay' && ['grading_pending', 'pending_confirmation'].includes(attempt.status))
    .map((attempt) => ({ ...attempt, topic_slug: topic.slug, topic_name: topic.name })));
}

export function renderEssay(root, state, { onGraded, topic }) {
  const concepts = topic.domains.flatMap((d) => d.concepts.map((c) => ({ ...c, domain: d.name })));

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Written answer · graded on the local model'));
  card.append(el('p', { class: 'q-hint' },
    'Write the answer from memory, then have it graded against your own rubric. ' +
    'Grading runs on gemma4 locally — expect roughly 15 seconds.'));

  const conceptPicker = el('select', { class: 'q-input' });
  conceptPicker.append(el('option', { value: '' }, '— no concept (not counted toward mastery) —'));
  for (const concept of concepts) {
    conceptPicker.append(el('option', { value: concept.slug }, `${concept.domain} · ${concept.name}`));
  }

  // Only source metadata crosses this boundary before the answer is committed. The server
  // resolves the selected source and keeps the answer-bearing grounding excerpt there.
  const sourcePicker = el('select', { class: 'q-input', disabled: true });
  sourcePicker.append(el('option', { value: '' }, 'Loading topic sources…'));

  const question = el('textarea', { class: 'q-input', rows: '2', placeholder: 'The question or prompt you are answering' });
  const rubric = el('textarea', { class: 'q-input', rows: '4', placeholder: PLACEHOLDER_RUBRIC });
  const answer = el('textarea', { class: 'q-input', rows: '8', placeholder: 'Your answer, from memory' });
  const max = el('input', { class: 'q-input', type: 'number', min: '1', max: '20', value: '5' });
  const confidence = el('select', { class: 'q-input' });
  for (const [value, label] of CONFIDENCE_BANDS) confidence.append(el('option', { value }, label));

  for (const [label, node] of [
    ['Concept', conceptPicker], ['Source grounding', sourcePicker], ['Question', question], ['Rubric', rubric],
    ['Your answer', answer], ['Confidence before assessment', confidence], ['Max score', max],
  ]) {
    card.append(el('div', { class: 'q-hint', style: 'margin:14px 0 6px' }, label), node);
  }

  const actions = el('div', { class: 'q-actions' });
  const grade = el('button', { class: 'btn primary', type: 'button' }, 'Grade answer');
  const output = el('div');
  const intentKey = `essay:${topic.slug}`;

  // Editing means the learner has deliberately moved on from a failed submission. Leave
  // the id intact for an unchanged retry, where it protects a response lost after append.
  for (const field of [conceptPicker, sourcePicker, question, rubric, answer, confidence, max]) {
    field.addEventListener(field === conceptPicker ? 'change' : 'input', () => resetMutationId(intentKey));
  }

  grade.addEventListener('click', async () => {
    actions.querySelector('.q-error')?.remove();
    clear(output);
    if (!confidence.value) {
      actions.append(el('span', { class: 'q-error' }, 'Choose your confidence before assessment.'));
      return;
    }
    grade.disabled = true;
    grade.textContent = 'Grading… (~15s)';
    try {
      const fields = {
        topicSlug: topic.slug,
        conceptSlug: conceptPicker.value,
        sourceId: sourcePicker.value,
        question: question.value,
        rubric: rubric.value,
        answer: answer.value,
        max: max.value,
        confidence: confidence.value,
      };
      const body = await withMutationId(intentKey, async (mutationId) => {
        try {
          return await requestJson('/api/grade', { method: 'POST', body: buildEssayGradeRequest({ ...fields, mutationId }) });
        } catch (err) {
          // A 409 here means the durable answer exists but has no model proposal yet.
          // Refresh into the resume surface before preserving the mutation id via rejection.
          if (err.status === 409 && err.payload?.pending_assessment) onGraded?.();
          throw err;
        }
      }, { payload: buildEssayGradeRequest({ ...fields, mutationId: null }) });

      output.append(el('h2', { class: 'score-line' }, `${body.grade.score} / ${body.grade.max}`));
      if (body.attempt.confidence) output.append(el('div', { class: 'q-hint' }, `Confidence before assessment: ${body.attempt.confidence}`));
      output.append(el('div', { class: 'q-explain' }, body.grade.feedback));
      renderMastery(output, body.mastery);
      if (body.attempt.status === 'pending_confirmation') {
        renderConfirmation(output, body.attempt, topic.slug, onGraded);
      }
      if (body.grade.score / body.grade.max < 0.5) {
        // The spec's error routing for essays: re-read, don't just re-quiz.
        output.append(el('p', { class: 'q-hint' },
          'Weak grade — the spec routes this back to re-reading that section, not another quiz.'));
      }
      grade.textContent = 'Grade another';
      grade.disabled = false;
      onGraded?.();
    } catch (err) {
      grade.disabled = false;
      grade.textContent = 'Grade answer';
      actions.append(el('span', { class: 'q-error' }, err.message));
    }
  });

  actions.append(grade);
  card.append(actions, output);
  root.append(card);
  loadEssaySources(sourcePicker, topic.slug);
  renderPendingEssays(root, state, onGraded);
}

async function loadEssaySources(sourcePicker, topicSlug) {
  try {
    const body = await requestJson(`/api/on/sources?topic=${encodeURIComponent(topicSlug)}`);
    sourcePicker.replaceChildren(el('option', { value: '' }, '— choose the source you studied —'));
    for (const source of body.sources ?? []) {
      sourcePicker.append(el('option', { value: source.id }, source.title));
    }
    sourcePicker.disabled = (body.sources ?? []).length === 0;
  } catch {
    sourcePicker.replaceChildren(el('option', { value: '' }, 'Source list unavailable — resume a saved assessment below'));
  }
}

function renderMastery(output, mastery) {
  if (mastery?.band && mastery.before && mastery.after) {
    output.append(el('p', { class: 'q-hint' },
      `${mastery.band} — ${mastery.before.status} → ${mastery.after.status}, ` +
      `confidence ${mastery.before.confidence} → ${mastery.after.confidence}.`));
  } else if (mastery?.band) {
    output.append(el('p', { class: 'q-hint' }, `${mastery.band} mastery update recovered and recorded.`));
  }
  if (mastery?.error) {
    output.append(el('p', { class: 'q-error' }, `Grade recorded, but mastery not updated: ${mastery.error}`));
  }
}

/** Model feedback is a proposal; only an explicit recorded learner decision may settle it. */
function renderConfirmation(output, attempt, topicSlug, onGraded) {
  const panel = el('div', { class: 'q-actions' });
  panel.append(el('p', { class: 'q-hint' },
    'Model proposal only — confirm, correct, or dispute it before it can count toward mastery.'));
  const accept = el('button', { class: 'btn primary', type: 'button' }, 'Accept grade');
  const dispute = el('button', { class: 'btn small', type: 'button' }, 'Dispute');
  const correctedScore = el('input', { class: 'q-input', type: 'number', min: '0', max: String(attempt.max), value: String(attempt.score) });
  const rationale = el('textarea', { class: 'q-input', rows: '2', placeholder: 'Why is this score different? (required to correct)' });
  const correct = el('button', { class: 'btn small', type: 'button' }, 'Record correction');

  const send = async (action, extra = {}) => {
    const request = { topic_slug: topicSlug, action, ...extra };
    return withMutationId(`essay-confirm:${attempt.attempt_id}:${action}`, (mutationId) =>
      requestJson(`/api/attempts/${encodeURIComponent(attempt.attempt_id)}/confirm-grade`, {
        method: 'POST', body: { ...request, mutation_id: mutationId },
      }), { payload: request });
  };

  const decide = async (action, extra) => {
    panel.querySelector('.q-error')?.remove();
    for (const control of [accept, dispute, correct]) control.disabled = true;
    try {
      const body = await send(action, extra);
      clear(panel);
      panel.append(el('p', { class: 'q-hint' },
        action === 'dispute' ? 'Grade disputed. It remains out of mastery and learning statistics.' : 'Grade confirmed and recorded.'));
      renderMastery(panel, body.mastery);
      onGraded?.();
    } catch (err) {
      for (const control of [accept, dispute, correct]) control.disabled = false;
      panel.append(el('span', { class: 'q-error' }, err.message));
    }
  };

  accept.addEventListener('click', () => decide('accept'));
  dispute.addEventListener('click', () => decide('dispute'));
  correct.addEventListener('click', () => decide('correct', { score: Number(correctedScore.value), rationale: rationale.value }));
  panel.append(accept, dispute, el('span', { class: 'q-hint' }, 'Correct score:'), correctedScore, rationale, correct);
  output.append(panel);
}

/** One explicit browser return path for model outages and unconfirmed model proposals. */
function renderPendingEssays(root, state, onGraded) {
  const pending = pendingEssayAttempts(state);
  if (pending.length === 0) return;

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Resume assessments · ${pending.length}`));
  card.append(el('p', { class: 'q-hint' },
    'These recorded answers are pending assessment or your confirmation. They do not affect mastery or learning statistics.'));
  for (const attempt of pending) {
    const panel = el('div', { class: 'q-block' });
    panel.append(el('div', { class: 'q-prompt' }, attempt.question || 'Written answer'));
    const evidence = attempt.source_evidence?.[0];
    panel.append(el('div', { class: 'q-hint' },
      `${attempt.topic_name} · ${evidence?.source_title ?? evidence?.reference ?? 'source evidence pending'} · ${attempt.status.replace('_', ' ')}`));
    if (attempt.status === 'pending_confirmation') {
      const grade = attempt.provisional_grade ?? attempt;
      panel.append(el('div', { class: 'score-line' }, `${grade.score} / ${grade.max ?? attempt.max}`));
      panel.append(el('div', { class: 'q-explain' }, grade.feedback ?? attempt.grade_feedback ?? 'No feedback was recorded.'));
      renderConfirmation(panel, attempt, attempt.topic_slug, onGraded);
    } else {
      renderManualProposal(panel, attempt, onGraded);
    }
    card.append(panel);
  }
  root.append(card);
}

/** Manual/external fallback preserves its own bounded source reference instead of guessing a grade. */
function renderManualProposal(panel, attempt, onGraded) {
  panel.append(el('p', { class: 'q-hint' },
    'The local model did not finish. Record a manual or external proposed grade, then explicitly confirm it.'));
  const assessor = el('select', { class: 'q-input' });
  assessor.append(el('option', { value: 'manual' }, 'Manual rubric'), el('option', { value: 'external_agent' }, 'External assessor'));
  const score = el('input', { class: 'q-input', type: 'number', min: '0', max: String(attempt.max), value: String(attempt.max) });
  const feedback = el('textarea', { class: 'q-input', rows: '3', placeholder: 'Criterion-level feedback (required)' });
  const reference = el('input', { class: 'q-input', placeholder: 'Source or passage reference (required only if no saved source evidence)' });
  const passage = el('textarea', { class: 'q-input', rows: '3', placeholder: 'Bounded supporting passage (required only if no saved source evidence)' });
  const submit = el('button', { class: 'btn primary', type: 'button' }, 'Record proposed grade');
  const controls = el('div', { class: 'q-actions' });
  submit.addEventListener('click', async () => {
    controls.querySelector('.q-error')?.remove();
    submit.disabled = true;
    try {
      const request = {
        topic_slug: attempt.topic_slug,
        assessor_type: assessor.value,
        score: Number(score.value),
        feedback: feedback.value,
        source_evidence: reference.value.trim() || passage.value.trim()
          ? [{ reference: reference.value, passage: passage.value }]
          : [],
      };
      const body = await withMutationId(`essay-proposal:${attempt.attempt_id}`, (mutationId) =>
        requestJson(`/api/attempts/${encodeURIComponent(attempt.attempt_id)}/propose-grade`, {
          method: 'POST', body: { ...request, mutation_id: mutationId },
        }), { payload: request });
      clear(panel);
      panel.append(el('p', { class: 'q-hint' }, 'Proposed grade recorded. Confirm or correct it before it can count.'));
      renderConfirmation(panel, body.attempt, attempt.topic_slug, onGraded);
      onGraded?.();
    } catch (err) {
      submit.disabled = false;
      controls.append(el('span', { class: 'q-error' }, err.message));
    }
  });
  controls.append(submit);
  for (const [label, field] of [
    ['Assessor', assessor], ['Proposed score', score], ['Feedback', feedback], ['Fallback source reference', reference], ['Fallback supporting passage', passage],
  ]) controls.append(el('span', { class: 'q-hint' }, label), field);
  panel.append(controls);
}
