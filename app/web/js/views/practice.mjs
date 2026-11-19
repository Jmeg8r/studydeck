// WHAT: Practice Lab — an evidence-oriented handoff to learn-anything's Project or Chat mode.
// WHY: An exercise file proves only that a file exists. The cockpit can index it and record
//      what the learner observed, but it must not execute a learner command, manufacture a
//      scaffold, mark a stage complete, or write learn-anything mastery on the learner's behalf.
import { clear, el } from '../dom.mjs';
import { requestJson, requestJsonWithMutation } from '../api.mjs';
import { resetMutationId } from '../mutation.mjs';

const artifactUrl = (topicSlug, conceptSlug, file) =>
  `/api/practice/${encodeURIComponent(topicSlug)}/${encodeURIComponent(conceptSlug)}/${encodeURIComponent(file)}`;

const allConcepts = (topic) => topic.domains.flatMap((domain) => domain.concepts);

const artifactFor = (topic, conceptSlug) =>
  (topic.practice_artifacts ?? []).find((artifact) => artifact.concept_slug === conceptSlug) ?? null;

const answerWasRevealed = (topic, conceptSlug, file) =>
  (topic.practice_events ?? []).some((event) => event.event_type === 'answer_revealed'
    && event.concept_slug === conceptSlug && event.artifact_file === file);

const latestEvidenceFor = (topic, conceptSlug) => [...(topic.practice_events ?? [])]
  .reverse()
  .find((event) => event.event_type === 'evidence_recorded' && event.concept_slug === conceptSlug) ?? null;

function field(label, control, hint = null) {
  const wrap = el('label', { class: 'qrow', style: 'display:block' });
  wrap.append(el('span', { class: 'who' }, label), control);
  if (hint) wrap.append(el('span', { class: 'q-hint' }, hint));
  return wrap;
}

async function copyCommand(command, result) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      // Fallback for an older local browser. The command is plain text and never executed
      // by this app; this only puts the exact external handoff onto the learner's clipboard.
      const scratch = document.createElement('textarea');
      scratch.value = command;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.append(scratch);
      scratch.select();
      if (!document.execCommand('copy')) throw new Error('copy was not available');
      scratch.remove();
    }
    result.textContent = 'Copied. Run it in your agent or IDE — this browser will not execute it.';
  } catch (err) {
    result.textContent = `Could not copy automatically: ${err.message}`;
  }
}

function recordSummary(record) {
  if (!record) return [
    'Last recorded result: none yet.',
    'Reflection: record what surprised you after you actually work the task.',
    'Next action: choose one small observable check before returning here.',
  ];
  const result = record.outcome === 'confirmed' ? 'confirmed evidence' : 'not completed';
  const qualification = record.qualification?.independent_near_transfer
    ? 'independent near-transfer claim recorded'
    : record.qualification?.evidence_quality === 'qualifying'
      ? 'qualifying practice evidence recorded'
      : 'activity recorded without a qualifying claim';
  return [
    `Last recorded result: ${result} · ${qualification}.`,
    `Reflection: ${record.reflection ?? 'none recorded.'}`,
    `Next action: ${record.next_action ?? 'none recorded.'}`,
  ];
}

function previewButton({ topic, conceptSlug, file, preview, label = file }) {
  const open = el('button', { class: 'btn small', type: 'button' }, label);
  open.addEventListener('click', async () => {
    open.disabled = true;
    try {
      const source = await requestJson(artifactUrl(topic.slug, conceptSlug, file));
      preview.textContent = source.content;
      preview.style.display = '';
    } catch (err) {
      preview.textContent = err.message;
      preview.style.display = '';
    } finally {
      open.disabled = false;
    }
  });
  return open;
}

function practiceWorkspace(topic, concept, modeSelect, reload) {
  let artifact = artifactFor(topic, concept.slug);
  const safeFiles = artifact?.files ?? [];
  const lockedFiles = artifact?.locked_files ?? [];
  const currentArtifact = safeFiles[0] ?? lockedFiles[0] ?? null;
  const panel = el('div', { class: 'card', style: 'margin-top:18px' });
  panel.append(el('div', { class: 'cap' }, `${concept.name} · practical evidence`));
  panel.append(el('p', { class: 'q-hint' },
    `Goal: apply ${concept.name} in a small task with an observable result before treating it as transfer evidence.`));
  panel.append(el('div', { class: 'q-hint' },
    `Current artifact: ${currentArtifact ?? 'none indexed yet — use the handoff above to create or resume it outside the browser.'}`));

  for (const line of recordSummary(artifact?.last_record ?? latestEvidenceFor(topic, concept.slug))) {
    panel.append(el('div', { class: 'q-hint' }, line));
  }

  const preview = el('pre', {
    class: 'q-explain', style: 'display:none;white-space:pre-wrap;max-height:360px;overflow:auto',
  });
  const files = el('div', { class: 'q-actions', style: 'margin-top:12px' });
  for (const file of safeFiles) files.append(previewButton({ topic, conceptSlug: concept.slug, file, preview }));
  for (const file of lockedFiles) {
    if (answerWasRevealed(topic, concept.slug, file)) {
      files.append(previewButton({ topic, conceptSlug: concept.slug, file, preview, label: `Open ${file}` }));
      continue;
    }
    const reveal = el('button', { class: 'btn small', type: 'button' }, `Reveal ${file}`);
    reveal.addEventListener('click', async () => {
      const accepted = window.confirm(
        `Reveal ${file}? This records the reveal and means later work on ${concept.name} cannot establish independent near transfer.`,
      );
      if (!accepted) return;
      reveal.disabled = true;
      try {
        const result = await requestJsonWithMutation('/api/practice/reveal', {
          method: 'POST',
          mutationKey: `practice:reveal:${topic.slug}:${concept.slug}:${file}`,
          body: { topic_slug: topic.slug, concept_slug: concept.slug, file, confirmed: true },
        });
        preview.textContent = result.artifact.content;
        preview.style.display = '';
        // Keep this live session honest without erasing the answer preview through a full
        // app reload. The server keeps enforcing the same ledger check on every future GET.
        (topic.practice_events ??= []).push(result.event);
        reveal.replaceWith(previewButton({ topic, conceptSlug: concept.slug, file, preview, label: `Open ${file}` }));
      } catch (err) {
        preview.textContent = err.message;
        preview.style.display = '';
        reveal.disabled = false;
      }
    });
    files.append(reveal);
  }
  if (files.childNodes.length > 0) panel.append(el('div', { class: 'q-hint' }, 'Indexed artifacts (plain text only):'), files, preview);

  const form = el('form', { class: 'q-actions', style: 'display:block;margin-top:18px' });
  form.append(el('div', { class: 'cap' }, 'Record what actually happened'));
  form.append(el('p', { class: 'q-hint' },
    'This append-only record is for evidence and resuming work. It never changes mastery or marks a schedule stage done.'));

  const outcome = el('select', { class: 'q-input', name: 'outcome' });
  outcome.append(el('option', { value: 'confirmed' }, 'Confirmed — I completed the work'));
  outcome.append(el('option', { value: 'rejected' }, 'Not completed — record the honest handoff'));
  const evidenceKind = el('select', { class: 'q-input', name: 'evidence_kind' });
  evidenceKind.append(el('option', { value: 'practice' }, 'Practice evidence'));
  evidenceKind.append(el('option', { value: 'transfer' }, 'Near-transfer evidence'));
  const artifactFile = el('select', { class: 'q-input', name: 'artifact_file' });
  artifactFile.append(el('option', { value: '' }, modeSelect.value === 'chat' ? 'No local artifact (Chat Mode)' : 'Choose the exercise artifact'));
  for (const file of safeFiles) artifactFile.append(el('option', { value: file }, file));
  for (const file of lockedFiles.filter((file) => answerWasRevealed(topic, concept.slug, file))) {
    artifactFile.append(el('option', { value: file }, `${file} (revealed)`));
  }
  if (safeFiles.length > 0) artifactFile.value = safeFiles[0];

  const rubric = el('textarea', { class: 'q-input', name: 'rubric', rows: '2', maxlength: '2000', placeholder: 'The criterion you set before submitting this evidence.' });
  const observable = el('textarea', { class: 'q-input', name: 'observable', rows: '2', maxlength: '2000', placeholder: 'A test result, output, source, or other observable result.' });
  const reflection = el('textarea', { class: 'q-input', name: 'reflection', rows: '2', maxlength: '2000', placeholder: 'What surprised you or remains uncertain?' });
  const nextAction = el('textarea', { class: 'q-input', name: 'next_action', rows: '2', maxlength: '800', placeholder: 'The one meaningful thing to do when you resume.' });
  const ownership = el('select', { class: 'q-input', name: 'ownership' });
  ownership.append(el('option', { value: 'independent' }, 'Owned independently'));
  ownership.append(el('option', { value: 'assisted' }, 'Worked with assistance'));
  ownership.append(el('option', { value: 'agent_generated' }, 'Agent generated the work'));
  const aiContribution = el('select', { class: 'q-input', name: 'ai_contribution' });
  aiContribution.append(el('option', { value: 'none' }, 'No AI contribution'));
  aiContribution.append(el('option', { value: 'planning' }, 'AI helped plan'));
  aiContribution.append(el('option', { value: 'debugging' }, 'AI helped debug'));
  aiContribution.append(el('option', { value: 'generated' }, 'AI generated material'));
  const hintUse = el('select', { class: 'q-input', name: 'hint_use' });
  hintUse.append(el('option', { value: 'none' }, 'No hint used'));
  hintUse.append(el('option', { value: 'hint' }, 'Hint used'));
  hintUse.append(el('option', { value: 'full_solution' }, 'Full solution used'));

  form.append(
    field('Outcome', outcome),
    field('Evidence type', evidenceKind),
    field('Artifact reference', artifactFile, 'Project Mode needs an indexed artifact; Chat Mode may record a conversation handoff.'),
    field('Rubric', rubric, 'Required for a confirmed record; it is retained with the evidence.'),
    field('Observable result', observable, 'Required for a confirmed record — do not substitute time spent for an output or check.'),
    field('Reflection', reflection),
    field('Next action', nextAction),
    field('Ownership', ownership),
    field('AI contribution', aiContribution),
    field('Hint use', hintUse),
  );
  form.append(el('div', { class: 'q-hint' },
    'A revealed answer, full solution, or agent-generated work can remain useful practice history, but cannot establish independent near transfer.'));
  const submitRow = el('div', { class: 'q-actions' });
  const submit = el('button', { class: 'btn', type: 'submit' }, 'Record confirmed evidence');
  const result = el('span', { class: 'q-hint' });
  submitRow.append(submit, result);
  form.append(submitRow);

  const mutationKey = `practice:evidence:${topic.slug}:${concept.slug}`;
  const resetForEditedEvidence = () => resetMutationId(mutationKey);
  for (const control of [outcome, evidenceKind, artifactFile, rubric, observable, reflection, nextAction, ownership, aiContribution, hintUse]) {
    control.addEventListener('input', resetForEditedEvidence);
    control.addEventListener('change', resetForEditedEvidence);
  }
  const syncRequirements = () => {
    const confirmed = outcome.value === 'confirmed';
    rubric.required = confirmed;
    observable.required = confirmed;
    artifactFile.required = modeSelect.value === 'project';
    submit.textContent = confirmed ? 'Record confirmed evidence' : 'Record not-completed handoff';
  };
  outcome.addEventListener('change', syncRequirements);
  syncRequirements();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    result.textContent = 'Recording…';
    try {
      const response = await requestJsonWithMutation('/api/practice/evidence', {
        method: 'POST',
        mutationKey,
        body: {
          topic_slug: topic.slug,
          concept_slug: concept.slug,
          mode: modeSelect.value,
          outcome: outcome.value,
          evidence_kind: evidenceKind.value,
          artifact_file: artifactFile.value || undefined,
          rubric: rubric.value,
          observable: observable.value,
          reflection: reflection.value,
          next_action: nextAction.value,
          ownership: ownership.value,
          ai_contribution: aiContribution.value,
          hint_use: hintUse.value,
        },
      });
      artifact ??= { concept_slug: concept.slug, concept_name: concept.name, files: [], locked_files: [] };
      artifact.last_record = response.event;
      const quality = response.event.qualification?.independent_near_transfer
        ? 'Independent near-transfer claim recorded.'
        : response.event.qualification?.evidence_quality === 'qualifying'
          ? 'Qualifying practice evidence recorded.'
          : 'Activity handoff recorded.';
      result.textContent = quality;
      // Refresh after acknowledging success so Today and any artifact summary read the
      // persisted event. Unlike a reveal, this response carries no protected content.
      await reload();
    } catch (err) {
      result.textContent = err.message;
      submit.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

export function renderPractice(root, state, { topic, reload }) {
  root.append(el('div', { class: 'crumb' }, `Studydeck / Practice Lab / ${topic.name}`));

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' }, 'Practice Lab · external harness handoff'));
  card.append(el('p', { class: 'q-hint' },
    'Project Mode creates or resumes artifacts through learn-anything. Chat Mode keeps a conceptual session in the agent. ' +
    'The browser only indexes existing artifacts and records learner-confirmed evidence.'));

  const concepts = allConcepts(topic);
  const controls = el('div', { class: 'q-actions' });
  const conceptSelect = el('select', { class: 'q-input' });
  for (const concept of concepts) conceptSelect.append(el('option', { value: concept.slug }, concept.name));
  const modeSelect = el('select', { class: 'q-input' });
  modeSelect.append(el('option', { value: 'project' }, 'Project Mode'));
  modeSelect.append(el('option', { value: 'chat' }, 'Chat Mode'));
  const copy = el('button', { class: 'btn small', type: 'button' }, 'Copy handoff');
  const result = el('span', { class: 'q-hint' });
  controls.append(conceptSelect, modeSelect, copy, result);
  card.append(controls);

  const command = el('code', { class: 'q-explain', style: 'display:block;margin-top:12px;white-space:pre-wrap' });
  const commandHint = el('div', { class: 'q-hint' });
  card.append(command, commandHint);
  const workspace = el('div');
  card.append(workspace);
  root.append(card);

  const refreshWorkspace = () => {
    const concept = concepts.find((item) => item.slug === conceptSelect.value) ?? concepts[0];
    if (!concept) return;
    const handoff = `/learn-practice ${concept.slug}`;
    command.textContent = handoff;
    commandHint.textContent = modeSelect.value === 'project'
      ? `Run this exact command in your agent or IDE. It owns .learn/topics/${topic.slug}/exercises/${concept.slug}/; StudyDeck will not create or run files there.`
      : 'Run this exact command in your agent, then choose Chat Mode. Keep the conversation’s output and return here to record what actually happened.';
    copy.onclick = () => copyCommand(handoff, result);
    clear(workspace);
    workspace.append(practiceWorkspace(topic, concept, modeSelect, reload));
  };
  conceptSelect.addEventListener('change', refreshWorkspace);
  modeSelect.addEventListener('change', refreshWorkspace);
  refreshWorkspace();
}
