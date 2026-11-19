// WHAT: Stats — attempt history, weakness heatmap by domain, Observatory launcher.
// WHY: Every number here is a plain sum over attempts.jsonl, so it can be checked by
//      hand against the file. Nothing is smoothed, weighted or estimated.
import { el } from '../dom.mjs';
import { requestJsonWithMutation } from '../api.mjs';
import { resetMutationId } from '../mutation.mjs';
import { openObservatory } from './observatory.mjs';

const CHARACTERIZATIONS = [
  ['confirmed_misconception', 'This was a misconception'],
  ['classified_slip', 'This was a slip'],
  ['dismissed_item_defect', 'The item was ambiguous or defective'],
  ['dismissed_grading_defect', 'The grading was defective'],
];

const characterizationLabel = (state) =>
  CHARACTERIZATIONS.find(([value]) => value === state)?.[1] ?? 'needs characterization';

/** Heatmap cell colour. Untested is deliberately NOT on the good/bad axis. */
function cellStyle(concept) {
  if (concept.evidence === 'untested') return 'untested';
  if (concept.evidence === 'clean') return 'clean';
  // Weak: intensity tracks how much of it came back wrong.
  const rate = concept.miss_rate ?? 1;
  if (rate >= 0.6) return 'weak-high';
  if (rate >= 0.3) return 'weak-mid';
  return 'weak-low';
}

function attemptsCard(state) {
  const rows = state.topics
    .flatMap((t) => t.attempts.filter((a) => !a.status || a.status === 'final').map((a) => ({ ...a, topic_name: t.name })))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' }, `Attempt history · ${rows.length}`));

  if (rows.length === 0) {
    card.append(el('p', { class: 'q-hint' }, 'No graded attempts yet. Take a deck in the Test Center.'));
    return card;
  }

  for (const attempt of rows) {
    const row = el('div', { class: 'qrow' });
    const pct = attempt.max > 0 ? Math.round((attempt.score / attempt.max) * 100) : 0;

    const label = el('span', {}, `${attempt.concept_slug} · ${attempt.kind}`);
    const bits = [
      attempt.ts.slice(0, 10),
      `${(attempt.misses ?? []).length} missed`,
      attempt.self_graded?.length ? `${attempt.self_graded.length} self-graded` : null,
      attempt.pending?.length ? `${attempt.pending.length} ungraded` : null,
    ].filter(Boolean);
    label.append(el('span', { class: 'who' }, ` · ${bits.join(' · ')}`));

    row.append(label, el('span', { class: 'pill' }, `${attempt.score}/${attempt.max} · ${pct}%`));
    card.append(row);

    if (attempt.notes) {
      card.append(el('div', { class: 'q-explain', style: 'margin:-6px 0 12px' }, attempt.notes));
    }
  }
  return card;
}

function heatmapCard(state) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Weakness by domain'));
  card.append(el('p', { class: 'q-hint' },
    'One square per concept. Untested squares are unmeasured — not passed. ' +
    'Colour intensity on the weak ones tracks how much came back wrong.'));

  for (const topic of state.topics) {
    card.append(el('div', { class: 'heat-topic' }, topic.name));

    for (const domain of topic.weakness.domains) {
      const row = el('div', { class: 'heat-row' });
      const label = el('span', { class: 'heat-label' }, domain.name);

      const grid = el('span', { class: 'heat-grid' });
      for (const concept of domain.concepts) {
        const cell = el('span', { class: `heat-cell ${cellStyle(concept)}` });
        const detail = concept.evidence === 'untested'
          ? 'never quizzed'
          : `${concept.asked - concept.missed}/${concept.asked} correct`;
        cell.title = `${concept.name} — ${detail}`;
        grid.append(cell);
      }

      const summary = domain.asked > 0
        ? `${domain.asked - domain.missed}/${domain.asked}`
        : `${domain.untested} untested`;
      row.append(label, grid, el('span', { class: 'heat-sum' }, summary));
      card.append(row);
    }
  }
  return card;
}

function reconciliationCard(state) {
  // The M3 verification, rendered: every figure is a plain sum you can hand-check.
  const attempts = state.topics.flatMap((t) => t.attempts.filter((a) => !a.status || a.status === 'final'));
  const asked = attempts.reduce((n, a) => n + (a.max ?? 0), 0);
  const correct = attempts.reduce((n, a) => n + (a.score ?? 0), 0);
  // Shortfall, not miss-list length — see stats.mjs. An essay has no per-item misses.
  const missed = attempts.reduce((n, a) => n + Math.max(0, (a.max ?? 0) - (a.score ?? 0)), 0);
  // Compare against the grand totals, which include graded work that belongs to no
  // single concept (a fact-check run covers a whole chapter).
  const weakness = state.topics.reduce((acc, t) => {
    acc.asked += t.weakness.totals.asked_all;
    acc.missed += t.weakness.totals.missed_all;
    acc.unattributed += t.weakness.unattributed.asked;
    return acc;
  }, { asked: 0, missed: 0, unattributed: 0 });

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Reconciliation'));
  card.append(el('p', { class: 'q-hint' },
    'These totals are summed two independent ways — straight from the attempt log, and ' +
    'through the per-concept weakness map. They must agree.'));

  const rows = [
    ['Attempts recorded', attempts.length, attempts.length],
    ['Questions graded', asked, weakness.asked],
    ['Missed', missed, weakness.missed],
    ['Correct', correct, weakness.asked - weakness.missed],
  ];
  for (const [label, fromLog, fromMap] of rows) {
    const row = el('div', { class: 'qrow' });
    row.append(
      el('span', {}, label),
      el('span', { class: `pill${fromLog === fromMap ? '' : ' hot'}` },
        fromLog === fromMap ? `${fromLog} ✓` : `${fromLog} vs ${fromMap} — MISMATCH`),
    );
    card.append(row);
  }

  // Named explicitly rather than quietly folded in: these questions are counted in the
  // totals but cannot appear in the per-concept heatmap.
  if (weakness.unattributed > 0) {
    card.append(el('p', { class: 'q-hint', style: 'margin-top:12px' },
      `${weakness.unattributed} of those questions are not attributed to a single concept ` +
      '(fact-check runs cover a whole chapter), so they count in these totals but not in the heatmap above.'));
  }
  return card;
}

/** Calibration is rendered as recorded evidence, never as a new mastery score. */
function confidenceEvidenceCard(state) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Confidence alignment · quiz evidence'));
  card.append(el('p', { class: 'q-hint' },
    'Before feedback, each answered quiz item carries Unsure, Likely, or Certain. ' +
    'This compares those predictions with the recorded outcome; it does not change mastery or scheduling.'));

  for (const topic of state.topics) {
    const evidence = topic.confidence_evidence;
    if (!evidence) continue;
    card.append(el('div', { class: 'heat-topic' }, topic.name));
    for (const band of evidence.bands) {
      const row = el('div', { class: 'qrow' });
      const needed = Math.max(0, evidence.minimum_sample - band.sample);
      const detail = band.insufficient
        ? `${band.sample}/${evidence.minimum_sample} samples · ${needed} more before a rate is meaningful`
        : `${band.correct}/${band.sample} correct · ${Math.round(band.accuracy * 100)}%`;
      row.append(
        el('span', {}, band.band[0].toUpperCase() + band.band.slice(1)),
        el('span', { class: 'pill' }, detail),
      );
      card.append(row);
    }
    if (evidence.excluded > 0) {
      card.append(el('div', { class: 'q-hint' },
        `${evidence.excluded} malformed historical confidence sample${evidence.excluded === 1 ? '' : 's'} excluded.`));
    }
  }
  return card;
}

/** Item retention is deliberately kept apart from upstream confidence and concept claims. */
function itemRetentionCard(state) {
  const items = state.topics.flatMap((topic) => (topic.item_retention_evidence ?? [])
    .map((item) => ({ ...item, topic_name: topic.name })));
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Item retention · ${items.length} recorded item${items.length === 1 ? '' : 's'}`));
  card.append(el('p', { class: 'q-hint' },
    'Only server-verified, answer-free quiz outcomes recorded under the retrieval policy appear here. ' +
    'Repeating an unchanged item can establish item retention only; concept retention and near transfer remain unverified.'));
  if (items.length === 0) {
    card.append(el('p', { class: 'q-hint' }, 'No eligible retrieval evidence has been recorded under this policy yet.'));
    return card;
  }
  for (const item of items) {
    const row = el('div', { class: 'qrow' });
    const attention = item.current_attention ?? { state: 'none' };
    const label = attention.state === 'needs_repair'
      ? `Needs repair · failed verification ${attention.failed_at.slice(0, 10)}`
      : attention.state === 'verification_due'
        ? `Verification due · checkpoint opened ${attention.due_at.slice(0, 10)}`
        : item.retention_horizon_days === 0
      ? `Initially demonstrated ${item.initial_demonstration.at.slice(0, 10)}`
      : `Item retained through ${item.retention_horizon_days} days · verified ${item.last_verification.at.slice(0, 10)}`;
    row.append(
      el('span', {}, `${item.topic_name} · ${item.concept_slug ?? 'unattributed'} · ${item.retrieval_format}`),
      el('span', { class: `pill${attention.state === 'needs_repair' ? ' owed' : ''}` }, label),
    );
    card.append(row);
  }
  return card;
}

/** Mapped-concept rows name uncertainty rather than infer it from repeated items. */
function conceptEvidenceCard(state) {
  const concepts = state.topics.flatMap((topic) => (topic.concept_evidence ?? [])
    .map((concept) => ({ ...concept, topic_name: topic.name })));
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Concept evidence · ${concepts.length} mapped concept${concepts.length === 1 ? '' : 's'}`));
  card.append(el('p', { class: 'q-hint' },
    'These rows keep the curriculum status separate from recorded item evidence. ' +
    'Item repetition does not establish concept retention or near transfer.'));
  if (concepts.length === 0) {
    card.append(el('p', { class: 'q-hint' }, 'No mapped concepts have recorded retrieval evidence or misconception candidates yet.'));
    return card;
  }
  for (const concept of concepts) {
    const attention = concept.current_attention ?? { state: 'none' };
    const label = attention.state === 'needs_repair'
      ? 'Needs repair'
      : attention.state === 'needs_characterization'
        ? 'Needs characterization'
        : attention.state === 'verification_due'
          ? 'Verification due'
          : 'No current attention';
    const detail = [
      `Upstream status: ${concept.upstream_status ?? 'unknown'}`,
      concept.initial_demonstration_count > 0
        ? `${concept.initial_demonstration_count} item${concept.initial_demonstration_count === 1 ? '' : 's'} initially demonstrated; longest item evidence ${concept.item_retention_horizon_days}d`
        : 'No item retrieval demonstration',
      'Concept retention: unverified',
      'Near transfer: unverified',
      concept.open_misconception_candidates > 0
        ? `${concept.open_misconception_candidates} candidate${concept.open_misconception_candidates === 1 ? '' : 's'} to characterize`
        : null,
      concept.confirmed_misconceptions_needing_repair > 0
        ? `${concept.confirmed_misconceptions_needing_repair} confirmed misconception${concept.confirmed_misconceptions_needing_repair === 1 ? '' : 's'} needing repair`
        : null,
    ].filter(Boolean).join(' · ');
    const row = el('div', { class: 'qrow' });
    row.append(
      el('span', {}, `${concept.topic_name} · ${concept.concept_name}`),
      el('span', { class: `pill${attention.state === 'needs_repair' || attention.state === 'needs_characterization' ? ' owed' : ''}` }, label),
    );
    card.append(row, el('p', { class: 'q-hint', style: 'margin:-6px 0 12px' }, detail));
  }
  return card;
}

function misconceptionCandidatesCard(state, { reload }) {
  const candidates = state.topics.flatMap((topic) => (topic.misconceptions ?? [])
    .map((candidate) => ({ ...candidate, topic_slug: topic.slug, topic_name: topic.name })));
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Possible misconceptions · ${candidates.length}`));
  card.append(el('p', { class: 'q-hint' },
    'A certain answer that was wrong is a candidate, not a diagnosis. It may be a slip, an ambiguous item, or a real misconception; no same-session correction counts as repair.'));
  if (candidates.length === 0) {
    card.append(el('p', { class: 'q-hint' }, 'No high-confidence quiz misses are recorded yet.'));
    return card;
  }
  for (const candidate of candidates) {
    const item = el('div', { class: 'qrow' });
    const stateLabel = characterizationLabel(candidate.state);
    const isNew = candidate.state === 'candidate';
    const details = el('span', {}, `${candidate.topic_name} · ${candidate.concept_slug ?? 'unattributed'} · ${candidate.question_id}`);
    const pill = el('span', { class: `pill${isNew ? ' owed' : ''}` }, stateLabel);
    item.append(details, pill);
    card.append(item);

    if (!isNew && candidate.characterization) {
      card.append(el('p', { class: 'q-hint', style: 'margin:-6px 0 12px' },
        `Recorded rationale: ${candidate.characterization}`));
    }

    const action = el('select', { class: 'q-input' });
    action.append(el('option', { value: '' }, isNew ? '— characterize this error —' : '— revise characterization —'));
    for (const [value, label] of CHARACTERIZATIONS) action.append(el('option', { value }, label));
    const rationale = el('textarea', {
      class: 'q-input', rows: '2',
      placeholder: 'Why? This explanation is required and becomes part of the append-only learning record.',
    });
    const actions = el('div', { class: 'q-actions' });
    const submit = el('button', { class: 'btn small', type: 'button' },
      isNew ? 'Record characterization' : 'Record revision');
    const mutationKey = `misconception:${candidate.id}`;
    // Editing is a deliberately new intent; a retry of unchanged text reuses its id.
    action.addEventListener('change', () => resetMutationId(mutationKey));
    rationale.addEventListener('input', () => resetMutationId(mutationKey));

    submit.addEventListener('click', async () => {
      actions.querySelector('.q-error')?.remove();
      if (!action.value) {
        actions.append(el('span', { class: 'q-error' }, 'Choose a characterization first.'));
        return;
      }
      if (!rationale.value.trim()) {
        actions.append(el('span', { class: 'q-error' }, 'Explain why before recording this characterization.'));
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Recording…';
      try {
        await requestJsonWithMutation(`/api/misconceptions/${encodeURIComponent(candidate.id)}/characterize`, {
          method: 'POST',
          mutationKey,
          body: {
            topic_slug: candidate.topic_slug,
            action: action.value,
            rationale: rationale.value,
          },
        });
        reload();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = isNew ? 'Record characterization' : 'Record revision';
        actions.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    actions.append(submit);
    card.append(action, rationale, actions);
  }
  return card;
}

/**
 * The Phase 2 gate for the Anki/FSRS exporter (roadmap D-c).
 *
 * `tasks/study-flow.md` has gated that exporter since 2026-07-16 on "if the review
 * heuristic's ceiling is hit after ~2 weeks", and nothing measured it — so the gate could
 * only ever open on a hunch. The contract is in `tasks/roadmap-2026-07-30.md` §5; this
 * renders it and decides nothing.
 *
 * Three states, and `insufficient` is the one that matters most. Below the sample minimum
 * the rate is not shown at all, because a green 0% on four reviews is the same lie as
 * `verify:live` calling an empty notebook clean: "I looked and there was nothing to look
 * at", presented as a pass.
 */
function lapseCard(state, primary) {
  const lapse = primary?.lapse;
  if (!lapse) return null;

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' },
    `Scheduler health · lapse rate over ${lapse.window_days} days`));

  const pct = (n) => `${(n * 100).toFixed(0)}%`;

  if (lapse.status === 'insufficient') {
    card.append(el('div', { class: 'qrow' },
      el('span', {}, 'Not enough evidence yet'),
      el('span', { class: 'pill' }, `${lapse.mature_reviews}/${lapse.min_mature}`)));
    card.append(el('div', { class: 'q-hint' },
      `A lapse rate needs ${lapse.min_mature} reviews of cards that had reached a ` +
      `${'\u2265'}7-day interval; there are ${lapse.mature_reviews}. ` +
      `${lapse.needed} more to go before this can say anything — deliberately blank rather ` +
      'than showing a percentage that would be noise.'));
    return card;
  }

  const ceiling = lapse.status === 'ceiling';
  card.append(el('div', { class: 'qrow' },
    el('span', {}, ceiling ? 'Ceiling reached — the heuristic is losing mature cards' : 'Holding'),
    el('span', { class: `pill ${ceiling ? 'owed' : 'hot'}` }, pct(lapse.rate))));
  card.append(el('div', { class: 'q-hint' },
    `${lapse.lapses} lapse${lapse.lapses === 1 ? '' : 's'} in ${lapse.mature_reviews} mature ` +
    `review${lapse.mature_reviews === 1 ? '' : 's'} · threshold ${pct(lapse.threshold)}.`));

  if (ceiling) {
    card.append(el('div', { class: 'q-hint' },
      'Two consecutive weekly readings above the threshold is the trigger to build the ' +
      'Anki/FSRS exporter (study-flow.md Phase 2, item 7). One reading is noise.'));
  }
  return card;
}

export function renderStats(root, state, { reload }) {
  root.append(el('div', { class: 'crumb' }, 'Studydeck / Stats'));

  const bar = el('div', { class: 'card' });
  const flex = el('div', { class: 'filter-bar' });
  flex.append(el('div', { class: 'cap' },
    `${state.totals.concepts} concepts · ${state.totals.unexplored} unexplored · ` +
    `${state.totals.needs_practice} needs practice`));
  const obs = el('button', { class: 'btn primary', type: 'button' }, 'Open Observatory');
  obs.addEventListener('click', () => openObservatory(state));
  flex.append(obs);
  bar.append(flex);
  root.append(bar);

  root.append(el('div', { style: 'height:18px' }));
  root.append(attemptsCard(state));
  root.append(heatmapCard(state));
  // Same primary-topic selection today.mjs uses, so both views agree on which topic they
  // are describing rather than each picking one.
  const primary = state.topics.find((t) => t.slug === state.today.topic_slug) ?? state.topics[0] ?? null;
  const lapse = lapseCard(state, primary);
  if (lapse) root.append(lapse);

  root.append(confidenceEvidenceCard(state));
  root.append(itemRetentionCard(state));
  root.append(conceptEvidenceCard(state));
  root.append(misconceptionCandidatesCard(state, { reload }));
  root.append(reconciliationCard(state));
}
