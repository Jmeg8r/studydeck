// WHAT: The full-screen Observatory — the variant-A graft on the shared wheel.
// WHY: The compact widget answers "how am I doing"; this answers "where am I in the
//      whole map". Same geometry, same data, more room — so it gets the guide rings,
//      the degree scale and every domain named.
import { clear, el } from '../dom.mjs';
import { renderWheel } from '../wheel.mjs';
import { schedulePosition, workingTopic } from '../topic.mjs';

const LEGEND = [
  ['unexplored', 'Unexplored', 'rgba(242,229,196,0.12)'],
  ['in_progress', 'In progress', 'rgba(79,179,170,0.55)'],
  ['needs_practice', 'Needs practice', '#f0a840'],
  ['mastered', 'Mastered', '#4fb3aa'],
];

// The hub caption reaches ~63px from the centre and the inner ring starts at ~14.1% of the
// wheel's size (measured 2026-11-10), so below this the hub sits above the wheel instead.
const HUB_FITS_FROM = 460;

/** Fit the wheel to the viewport — it is the whole point of the view. */
function wheelSize() {
  const available = Math.min(window.innerWidth - 420, window.innerHeight - 150);
  return Math.max(360, Math.min(760, available));
}

export function openObservatory(state) {
  // Captured before anything moves focus, so closing can hand it back.
  const launcher = document.activeElement;
  // A real modal dialog, not a positioned div: showModal() makes the page beneath inert, so
  // Tab cannot wander onto rail controls hidden under a full-window overlay.
  const overlay = el('dialog', { class: 'observatory', 'aria-labelledby': 'observatory-title' });

  const header = el('header', { class: 'obs-head' });
  const masthead = el('div', { class: 'obs-masthead', id: 'observatory-title' });
  masthead.append('The Study ', el('em', {}, 'Observatory'));
  // The working topic, not the schedule's nomination: this overlay sits ON TOP of the rail,
  // so its "Day N" and the rail's day counter are read together and must not disagree. It
  // resolves its own rather than being handed one — it is opened imperatively from Today and
  // Stats, and both are cross-topic views that deliberately receive no topic to pass on.
  const working = workingTopic(state);
  header.append(
    masthead,
    el('div', { class: 'obs-sc' }, `${state.totals.concepts} concepts · ${state.topics.length} topics`),
    el('div', { class: 'obs-sc' }, working
      ? `${schedulePosition(working)}${working.position.dayN ? ' of 30' : ''}`
      : 'no topic on the clock'),
  );

  const close = el('button', { class: 'obs-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close Observatory' }, '✕');
  header.append(close);
  overlay.append(header);

  const stage = el('div', { class: 'obs-stage' });

  // Legend — mastery states, then which ring is which topic.
  const legend = el('aside', { class: 'obs-legend' });
  legend.append(el('h4', {}, 'Mastery states'));
  for (const [, label, colour] of LEGEND) {
    const row = el('div', { class: 'obs-row' });
    row.append(el('span', { class: 'obs-sw', style: `background:${colour}` }), label);
    legend.append(row);
  }
  legend.append(el('h4', { style: 'margin-top:24px' }, 'Rings'));
  state.topics.forEach((topic, i) => {
    legend.append(el('div', { class: 'obs-row dim' },
      `${i === 0 ? 'Inner' : 'Outer'} — ${topic.name} · ${topic.concept_count}`));
  });
  stage.append(legend);

  // The wheel, plus a hub reporting how much of the map has actually been touched.
  const size = wheelSize();
  const field = el('div', { class: size < HUB_FITS_FROM ? 'obs-field compact' : 'obs-field' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  // One image to a screen reader, not 49 unlabelled shapes: the picker is the way in.
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Mastery wheel: ${state.totals.concepts} concepts across ${state.topics.length} topics`);
  field.append(svg);

  const touched = state.totals.concepts - state.totals.unexplored;
  const hub = el('div', { class: 'obs-hub' });
  hub.append(
    el('div', { class: 'obs-n' }, String(touched)),
    el('div', { class: 'obs-d' }, `of ${state.totals.concepts} touched`),
  );
  field.append(hub);
  stage.append(field);

  // Detail panel — starts as an instruction, becomes the chosen concept. Polite, so a
  // screen reader announces the result of a pick without interrupting.
  const detail = el('aside', { class: 'obs-detail', 'aria-live': 'polite' });
  detail.append(
    el('h4', {}, 'Inspect'),
    el('p', { class: 'obs-p' }, 'Click any cell, or choose a concept, to read its domain and evidence.'),
  );
  stage.append(detail);
  overlay.append(stage);

  const selectConcept = ({ topic, domain, concept }) => {
    // Evidence comes from the weakness map, which keeps untested distinct from clean.
    const evidence = topic.weakness?.domains
      .find((d) => d.slug === domain.slug)?.concepts
      .find((c) => c.slug === concept.slug);

    clear(detail);
    detail.append(
      el('h4', {}, domain.name),
      el('div', { class: 'obs-concept' }, concept.name),
      el('p', { class: 'obs-p' }, `${topic.name} · ${concept.status.replace('_', ' ')} · confidence ${concept.confidence}`),
    );
    if (evidence) {
      const line = evidence.evidence === 'untested'
        ? 'Never quizzed — unmeasured, not mastered.'
        : `${evidence.asked - evidence.missed}/${evidence.asked} correct across ${evidence.asked} questions.`;
      detail.append(el('p', { class: `obs-p ${evidence.evidence}` }, line));
      if (evidence.cards > 0) {
        detail.append(el('p', { class: 'obs-p' }, `${evidence.cards} card${evidence.cards === 1 ? '' : 's'} queued.`));
      }
    }
  };

  // The keyboard path to every cell: one tab stop, built from the same topics → domains →
  // concepts walk the wheel draws, so the two cannot offer different concepts.
  const choices = state.topics.flatMap((topic) => topic.domains.flatMap((domain) =>
    domain.concepts.map((concept) => ({ topic, domain, concept }))));
  const picker = el('select', { id: 'observatory-concept', class: 'obs-picker' });
  picker.append(el('option', { value: '' }, 'Choose a concept'));
  choices.forEach(({ topic, domain, concept }, index) => picker.append(el('option', { value: String(index) },
    `${topic.name} / ${domain.name} / ${concept.name} · ${concept.status.replaceAll('_', ' ')}`)));
  picker.addEventListener('change', () => {
    if (picker.value !== '') selectConcept(choices[Number(picker.value)]);
  });
  legend.append(el('h4', { style: 'margin-top:24px' }, el('label', { for: 'observatory-concept' }, 'Inspect a concept')), picker);

  queueMicrotask(() => overlay.open && renderWheel(svg, state.topics, {
    size,
    outerRadius: size / 2.1,
    variant: 'observatory',
    onSelect: selectConcept,
  }));

  // Every way out goes through close(), and the one 'close' listener does the cleanup —
  // including Escape, which the native dialog turns into a close on its own.
  const dismiss = () => overlay.close();
  overlay.addEventListener('close', () => {
    overlay.remove();
    window.removeEventListener('hashchange', dismiss);
    launcher?.focus?.({ preventScroll: true });
  }, { once: true });
  close.addEventListener('click', dismiss);
  // The dialog box fills the window, so a click whose target is the dialog itself landed on
  // its padding, not on any content.
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  // Back, or a rail link, re-renders the view beneath; left open, this would cover it.
  window.addEventListener('hashchange', dismiss);

  document.body.append(overlay);
  overlay.showModal();
  close.focus();
}
