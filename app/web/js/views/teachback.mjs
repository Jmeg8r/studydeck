// WHAT: Teachback — a lightweight, durable record of explaining a topic to an audience.
// WHY: A presentation can be useful activity without proving it held up under questions.
//      This view records the audience, artifact, rubric provenance, questions, gaps, and
//      handoff without creating cards, updating mastery, or completing a schedule stage.
import { clear, el } from '../dom.mjs';
import { requestJsonWithMutation } from '../api.mjs';
import { resetMutationId } from '../mutation.mjs';

function field(label, control, hint = null) {
  const wrap = el('label', { class: 'qrow', style: 'display:block' });
  wrap.append(el('span', { class: 'who' }, label), control);
  if (hint) wrap.append(el('span', { class: 'q-hint' }, hint));
  return wrap;
}

function latestRecord(topic) {
  return topic.last_teachback ?? [...(topic.teachbacks ?? [])]
    .reverse()
    .find((record) => record.event_type === 'teachback_recorded') ?? null;
}

function recordSummary(record) {
  if (!record) return [
    'Last recorded teach-back: none yet.',
    'Return here after you explain the material to preserve the question, gap, and next action.',
  ];
  const quality = record.qualification?.qualifying_teachback
    ? 'qualifying teach-back evidence recorded'
    : 'activity record only — it does not claim teaching evidence';
  const gaps = record.no_gap_found
    ? 'Gaps: explicitly none found.'
    : `Gaps: ${record.gaps ?? 'none recorded.'}`;
  return [
    `Last recorded teach-back: ${record.outcome === 'confirmed' ? 'confirmed' : 'not yet solid'} · ${quality}.`,
    `Audience: ${record.audience ?? 'none recorded.'} · Artifact: ${record.artifact_reference ?? 'none recorded.'}`,
    gaps,
    `Reflection: ${record.reflection ?? 'none recorded.'}`,
    `Next action: ${record.resulting_actions ?? 'none recorded.'}`,
  ];
}

export function renderTeachback(root, state, { topic, reload }) {
  root.append(el('div', { class: 'crumb' }, `Studydeck / Teachback / ${topic.name}`));

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' }, 'Teachback · durable explanation handoff'));
  card.append(el('p', { class: 'q-hint' },
    'Record what happened after a presentation, article, video, notebook, or notes explain the topic to someone. ' +
    'This is append-only observed activity: it never creates cards, changes mastery, or marks a schedule stage done.'));
  for (const line of recordSummary(latestRecord(topic))) card.append(el('div', { class: 'q-hint' }, line));

  const form = el('form', { class: 'q-actions', style: 'display:block;margin-top:18px' });
  form.append(el('div', { class: 'cap' }, 'Record the explanation and its return path'));

  const outcome = el('select', { class: 'q-input', name: 'outcome' });
  outcome.append(el('option', { value: 'confirmed' }, 'Confirmed — I completed the teach-back'));
  outcome.append(el('option', { value: 'rejected' }, 'Not yet solid — record the concrete remediation'));
  const audience = el('input', { class: 'q-input', name: 'audience', maxlength: '500', required: '',
    placeholder: 'Audience or intended audience' });
  const artifactType = el('select', { class: 'q-input', name: 'artifact_type' });
  for (const [value, label] of [
    ['presentation', 'Presentation'], ['article', 'Article'], ['video', 'Video'], ['notebook', 'Notebook'], ['notes', 'Notes'],
  ]) artifactType.append(el('option', { value }, label));
  const artifactReference = el('input', { class: 'q-input', name: 'artifact_reference', maxlength: '2000', required: '',
    placeholder: 'Artifact filename, title, or stable reference' });
  const rubricPredeclared = el('input', { type: 'checkbox', name: 'rubric_predeclared' });
  const rubricRow = el('label', { class: 'qrow', style: 'display:flex;gap:8px;align-items:center' },
    rubricPredeclared, 'I wrote this rubric before the teach-back.');
  const rubric = el('textarea', { class: 'q-input', name: 'rubric', rows: '2', maxlength: '2000',
    placeholder: 'The criterion you set before explaining.' });
  const rubricReference = el('input', { class: 'q-input', name: 'rubric_reference', maxlength: '2000',
    placeholder: 'Source, note, or rubric reference set before explaining.' });
  const observable = el('textarea', { class: 'q-input', name: 'observable', rows: '2', maxlength: '2000',
    placeholder: 'Observable explanation, answer, output, or artifact check.' });
  const questions = el('textarea', { class: 'q-input', name: 'questions', rows: '2', maxlength: '2000', required: '',
    placeholder: 'Question received or anticipated; say what you tested, not merely “none”.' });
  const noGapFound = el('input', { type: 'checkbox', name: 'no_gap_found', checked: '' });
  const noGapRow = el('label', { class: 'qrow', style: 'display:flex;gap:8px;align-items:center' },
    noGapFound, 'No gap found — record that explicitly.');
  const gaps = el('textarea', { class: 'q-input', name: 'gaps', rows: '2', maxlength: '2000',
    placeholder: 'Specific gap discovered during the teach-back.' });
  const reflection = el('textarea', { class: 'q-input', name: 'reflection', rows: '2', maxlength: '2000', required: '',
    placeholder: 'What surprised you or remains uncertain?' });
  const resultingActions = el('textarea', { class: 'q-input', name: 'resulting_actions', rows: '2', maxlength: '2000', required: '',
    placeholder: 'Cards, misconception candidates, or a practice action that follows.' });
  const remediationTarget = el('textarea', { class: 'q-input', name: 'remediation_target', rows: '2', maxlength: '800',
    placeholder: 'concept:<slug>, source:<id>, criterion:<detail>, or /learn-practice <slug>.' });
  const ownership = el('select', { class: 'q-input', name: 'ownership' });
  ownership.append(el('option', { value: 'independent' }, 'Owned independently'));
  ownership.append(el('option', { value: 'assisted' }, 'Worked with assistance'));
  ownership.append(el('option', { value: 'agent_generated' }, 'Agent generated the material'));
  const aiContribution = el('select', { class: 'q-input', name: 'ai_contribution' });
  aiContribution.append(el('option', { value: 'none' }, 'No AI contribution'));
  aiContribution.append(el('option', { value: 'planning' }, 'AI helped plan'));
  aiContribution.append(el('option', { value: 'coaching' }, 'AI asked/coached'));
  aiContribution.append(el('option', { value: 'generated' }, 'AI generated material'));

  form.append(
    field('Outcome', outcome),
    field('Audience', audience),
    field('Artifact type', artifactType),
    field('Artifact reference', artifactReference, 'Saved as inert text; this browser will not open or execute it.'),
    rubricRow,
    field('Predeclared rubric', rubric, 'A rubric typed after the result is useful reflection, but cannot qualify the evidence.'),
    field('Rubric/source reference', rubricReference, 'Required with a predeclared rubric so the criterion has durable provenance.'),
    field('Observable explanation or result', observable, 'Needed with the predeclared rubric to make a qualifying teach-back claim.'),
    field('Question received or anticipated', questions),
    noGapRow,
    field('Gap discovered', gaps, 'Required unless “No gap found” is explicitly checked.'),
    field('Reflection', reflection),
    field('Resulting cards or practice action', resultingActions),
    field('Concrete remediation target', remediationTarget, 'Required unless this is qualifying evidence. Use concept:<slug>, source:<id>, criterion:<detail>, or /learn-practice <slug>.'),
    field('Ownership', ownership),
    field('AI contribution', aiContribution),
  );

  const submitRow = el('div', { class: 'q-actions' });
  const submit = el('button', { class: 'btn', type: 'submit' }, 'Record teach-back');
  const result = el('span', { class: 'q-hint' });
  submitRow.append(submit, result);
  form.append(submitRow);

  const mutationKey = `teachback:${topic.slug}`;
  const controls = [
    outcome, audience, artifactType, artifactReference, rubricPredeclared, rubric, rubricReference, observable,
    questions, noGapFound, gaps, reflection, resultingActions, remediationTarget, ownership, aiContribution,
  ];
  const resetForEditedRecord = () => resetMutationId(mutationKey);
  for (const control of controls) {
    control.addEventListener('input', resetForEditedRecord);
    control.addEventListener('change', resetForEditedRecord);
  }

  const syncRequirements = () => {
    rubric.required = rubricPredeclared.checked;
    rubricReference.required = rubricPredeclared.checked;
    gaps.required = !noGapFound.checked;
    gaps.disabled = noGapFound.checked;
    const qualifying = outcome.value === 'confirmed'
      && rubricPredeclared.checked
      && rubric.value.trim()
      && rubricReference.value.trim()
      && observable.value.trim()
      && questions.value.trim()
      && artifactReference.value.trim()
      && ownership.value !== 'agent_generated'
      && aiContribution.value !== 'generated';
    remediationTarget.required = !qualifying;
    submit.textContent = outcome.value === 'confirmed' ? 'Record teach-back' : 'Record remediation handoff';
  };
  outcome.addEventListener('change', syncRequirements);
  rubricPredeclared.addEventListener('change', syncRequirements);
  noGapFound.addEventListener('change', syncRequirements);
  for (const control of [rubric, rubricReference, observable, questions, artifactReference, ownership, aiContribution]) {
    control.addEventListener('input', syncRequirements);
    control.addEventListener('change', syncRequirements);
  }
  syncRequirements();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    result.textContent = 'Recording…';
    try {
      const response = await requestJsonWithMutation('/api/teachbacks', {
        method: 'POST',
        mutationKey,
        body: {
          topic_slug: topic.slug,
          outcome: outcome.value,
          audience: audience.value,
          artifact_type: artifactType.value,
          artifact_reference: artifactReference.value,
          rubric_predeclared: rubricPredeclared.checked,
          rubric: rubric.value || undefined,
          rubric_reference: rubricReference.value || undefined,
          observable: observable.value || undefined,
          questions: questions.value,
          no_gap_found: noGapFound.checked,
          gaps: noGapFound.checked ? undefined : gaps.value,
          reflection: reflection.value,
          resulting_actions: resultingActions.value,
          remediation_target: remediationTarget.value || undefined,
          ownership: ownership.value,
          ai_contribution: aiContribution.value,
        },
      });
      result.textContent = response.event.qualification?.qualifying_teachback
        ? 'Qualifying teach-back evidence recorded.'
        : 'Teach-back activity recorded without a qualifying evidence claim.';
      await reload();
    } catch (err) {
      result.textContent = err.message;
      submit.disabled = false;
    }
  });

  card.append(form);
  root.append(card);
}
