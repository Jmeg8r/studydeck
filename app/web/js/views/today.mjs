// WHAT: The Today view — hero action, schedule strip, interleaved queue, mastery wheel.
// WHY (schedule semantics): a stage is done only when you say so. The calendar decides
//      when a stage becomes available and nothing more, so a stage you never finished
//      stays at the front however many days pass over it.
import { renderTimeline } from '../timeline.mjs';
import { renderWheel } from '../wheel.mjs';
import { openObservatory } from './observatory.mjs';
import { el, text } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { withMutationId } from '../mutation.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Built as nodes rather than an innerHTML string — no markup parsing on this path. */
function playIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 5l12 7-12 7z');
  svg.append(path);
  return svg;
}

/** "1 graded attempt, 2 card reviews" — what happened, never what it proves. */
function observedLine(observed) {
  if (!observed) return null;
  // Both forms spelled out: appending an "s" to the phrase produced "2 card queueds",
  // because the noun is not always the last word.
  const parts = [
    [observed.attempts, 'graded attempt', 'graded attempts'],
    [observed.reviews, 'card review', 'card reviews'],
    [observed.cards, 'card queued', 'cards queued'],
    [observed.mindmap_runs, 'mind-map run', 'mind-map runs'],
    [observed.debriefs, 'debrief', 'debriefs'],
    [observed.practice_evidence, 'practice evidence record', 'practice evidence records'],
    [observed.teachbacks, 'teach-back record', 'teach-back records'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);

  return parts.length
    ? `Recorded since this became due: ${parts.join(', ')}. Only you can say whether the stage is finished.`
    : 'Nothing recorded since this became due.';
}

/** Local calendar date, matching the server's todayISO — a UTC slice would drift a day. */
function todayISODate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function heroSection(state, primary, { onStart, onStageAction, reload }) {
  const { today } = state;
  const hero = el('section', { class: 'hero' });
  const stage = primary?.stages.find((s) => s.key === today.stage_key) ?? null;

  const left = el('div');
  left.append(el('div', { class: 'cap' }, 'Your one next action'));

  const heading = el('h2', {}, today.headline);
  if (stage && typeof today.owed_days === 'number') {
    const late = today.owed_days > 0;
    heading.append(el('span', { class: `pill ${late ? 'owed' : 'hot'}` },
      late ? `owed ${today.owed_days}d` : 'due today'));
  }
  left.append(heading);

  if (today.detail) left.append(el('p', {}, today.detail));
  if (today.steps?.length) left.append(el('div', { class: 'q-hint' }, today.steps.join('  ·  ')));

  // Actions are schedule instructions, not a hidden completion state. Keeping their why,
  // duration, and return path beside the one navigation control makes composite days
  // legible without implying the first click completed anything.
  if (today.primary_action) {
    left.append(el('div', { class: 'cap', style: 'margin-top:16px' }, 'Why this now?'));
    left.append(el('div', { class: 'q-hint' }, today.primary_action.why));
    left.append(el('div', { class: 'q-hint' },
      `${today.primary_action.duration} · Return: ${today.primary_action.return_path}`));
  }
  if (today.secondary_action) {
    const continuation = el('div', { class: 'q-actions' });
    const next = el('button', { class: 'btn small', type: 'button' }, today.secondary_action.label);
    next.addEventListener('click', () => onStart(today.secondary_action.view));
    continuation.append(next, el('span', { class: 'q-hint' },
      `Then · ${today.secondary_action.duration} · ${today.secondary_action.why}`));
    left.append(continuation, el('div', { class: 'q-hint' }, `Return: ${today.secondary_action.return_path}`));
  }

  if (stage) {
    const observed = observedLine(stage.observed);
    if (observed) left.append(el('div', { class: 'q-hint' }, observed));
  }
  if (today.owed_count > 1) {
    left.append(el('div', { class: 'q-hint' },
      `${today.owed_count} stages owed in total — they stay in the queue until you close them.`));
    // The pile-up is honest — an unfinished stage stays owed however long it sits — but a
    // queue saying "do six things today" is not actionable. Re-anchoring moves the
    // REMAINING pipeline forward as a unit, keeping the spacing that does the real work.
    // It completes nothing; the wording says so, because a control that looked like it
    // tidied stages away would invert the rule the stage model exists to enforce.
    const catchUp = el('div', { class: 'q-actions' });
    const shift = el('button', { class: 'btn small', type: 'button' }, 'Re-anchor from today');
    shift.title = 'Move the remaining stages forward, keeping their spacing. Nothing is marked done.';
    shift.addEventListener('click', async () => {
      shift.disabled = true;
      catchUp.querySelector('.q-error')?.remove();
      try {
        await requestJson('/api/schedule/reschedule', { method: 'POST', body: { topic_slug: state.today.topic_slug ?? primary?.slug, from: todayISODate() } });
        reload();
      } catch (err) {
        shift.disabled = false;
        catchUp.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    catchUp.append(shift);
    catchUp.append(el('span', { class: 'q-hint' }, 'Nothing is marked done — only the dates move.'));
    left.append(catchUp);
  }
  if (today.waiting_until) {
    left.append(el('div', { class: 'q-hint' }, `Nothing is owed. The next stage opens ${today.waiting_until}.`));
  }

  // Marking done is the ONLY thing that completes a stage. Nothing infers it.
  if (stage) {
    const actions = el('div', { class: 'q-actions' });
    const done = el('button', { class: 'btn', type: 'button' }, 'Mark done');
    done.addEventListener('click', () => onStageAction(done, actions, stage.key, 'complete'));
    actions.append(done);
    left.append(actions);
  }

  hero.append(left);

  if (today.day_label) {
    const action = today.primary_action ?? { label: 'Start', duration: today.day_label, view: today.view };
    const start = el('button', { class: 'start', type: 'button' });
    start.title = `${action.label} · ${action.duration}`;
    start.setAttribute('aria-label', `${action.label} (${action.duration})`);
    start.append(playIcon(), text(action.label), el('small', {}, `${action.duration} · ${today.day_label}`));
    start.addEventListener('click', () => onStart(action.view));
    hero.append(start);
  }
  return hero;
}

/** Undo a completion — the correction path for a stage marked done in error. */
function completedCard(primary, onStageAction) {
  const done = primary.stages.filter((s) => s.complete);
  if (done.length === 0) return null;

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Completed · ${done.length} of ${primary.stages.length}`));

  for (const stage of done) {
    const row = el('div', { class: 'qrow' });
    const label = el('span', {}, stage.title);
    label.append(el('span', { class: 'who' },
      ` · day ${stage.day}${stage.completed_on ? ` · marked done ${stage.completed_on}` : ''}`));
    const undo = el('button', { class: 'btn small', type: 'button' }, 'Undo');
    undo.addEventListener('click', () => onStageAction(undo, row, stage.key, 'undo'));
    row.append(label, undo);
    card.append(row);
  }
  return card;
}

function scheduleStrip(primary) {
  const strip = el('div', { class: 'tl-strip' });
  strip.append(el('div', { class: 'cap' }, 'Schedule · intervals expand as memory holds'));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  strip.append(svg);
  // Deferred: the SVG needs to be in the document before CSS tokens resolve.
  queueMicrotask(() => renderTimeline(svg, primary.timeline, { dayN: primary.position.dayN }));
  return strip;
}

function queueCard(state) {
  const card = el('div', { class: 'card' });
  const owed = state.queue.filter((q) => q.hot).length;
  card.append(el('div', { class: 'cap' },
    owed > 0 ? `Queue · ${owed} owed, then the next 7 days` : 'Queue · next 7 days'));

  if (state.queue.length === 0) {
    card.append(el('div', { class: 'qrow' }, el('span', { class: 'empty' },
      'Nothing scheduled. Every topic is paused — start one to put it on the clock.')));
    return card;
  }

  const multiTopic = new Set(state.queue.map((q) => q.topic_slug)).size > 1;
  for (const item of state.queue) {
    const row = el('div', { class: 'qrow' });
    const label = el('span', {}, item.title);
    if (multiTopic) label.append(el('span', { class: 'who' }, ` · ${item.topic_name}`));
    // An owed stage that is not the next action says what it is waiting behind, so
    // "not now" never reads as "not needed".
    if (item.after) label.append(el('span', { class: 'who' }, ` · after ${item.after}`));
    // Coral for anything genuinely late, amber for what is due today, plain for upcoming.
    const tone = item.pill.startsWith('owed') ? ' owed' : item.hot ? ' hot' : '';
    row.append(label, el('span', { class: `pill${tone}` }, item.pill));
    card.append(row);
  }
  return card;
}

/**
 * Put a topic on the clock, or take it off. The only writer of schedule.json's dates.
 *
 * No `mutation_id` here, deliberately: these set a value rather than appending a record,
 * so a replayed request writes the identical file. The id exists to deduplicate APPENDS —
 * carrying one the server would ignore would suggest a protection that isn't operating.
 */
function scheduleControls(state, reload) {
  const idle = state.topics.filter((t) => t.schedule.paused || !t.schedule.started);
  const running = state.topics.filter((t) => !t.schedule.paused && t.schedule.started);
  if (idle.length === 0 && running.length === 0) return null;

  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Topics on the clock'));

  const rowFor = (topic, label, body, path) => {
    const row = el('div', { class: 'qrow' });
    const name = el('span', {}, topic.name);
    name.append(el('span', { class: 'who' },
      topic.schedule.started ? ` · started ${topic.schedule.started}` : ' · not started'));
    const button = el('button', { class: 'btn small', type: 'button' }, label);
    button.addEventListener('click', async () => {
      button.disabled = true;
      row.querySelector('.q-error')?.remove();
      try {
        await requestJson(path, { method: 'POST', body: { topic_slug: topic.slug, ...body } });
        reload();
      } catch (err) {
        button.disabled = false;
        row.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    row.append(name, button);
    return row;
  };

  for (const topic of idle) {
    const row = topic.schedule.started
      ? rowFor(topic, 'Resume', { paused: false }, '/api/schedule/pause')
      : rowFor(topic, 'Start', {}, '/api/schedule/start');
    if (topic.schedule.started) row.append(resetControl(topic, row, reload));
    card.append(row);
  }
  for (const topic of running) {
    const row = rowFor(topic, 'Pause', { paused: true }, '/api/schedule/pause');
    row.append(resetControl(topic, row, reload));
    card.append(row);
  }
  return card;
}

/**
 * Restart a topic's pipeline on the same notebook. Reopening completed stages cannot be
 * undone in one click, so the button only opens a confirmation that says what will change.
 * The mutation key includes the date: a retry of the same reset reuses its id, while
 * picking a different date is a new intent.
 */
function resetControl(topic, row, reload) {
  const open = el('button', { class: 'btn small', type: 'button' }, 'Reset…');
  open.addEventListener('click', () => {
    open.hidden = true;
    const done = topic.stages.filter((s) => s.complete).length;
    const panel = el('div', { class: 'reset-panel' });
    const date = el('input', { type: 'date', value: todayISODate(), 'aria-label': `New start date for ${topic.name}` });
    const confirm = el('button', { class: 'btn small primary', type: 'button' }, 'Reset start date');
    const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
    panel.append(
      el('label', {}, 'New day 0 ', date),
      el('p', { class: 'reset-note' },
        `Reopens ${done} completed stage${done === 1 ? '' : 's'} and clears reschedules. ` +
        'Quiz history, cards and mastery are kept.'),
      confirm, cancel);
    cancel.addEventListener('click', () => {
      panel.remove();
      open.hidden = false;
    });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      panel.querySelector('.q-error')?.remove();
      const started = date.value;
      try {
        const request = { topic_slug: topic.slug, started };
        await withMutationId(`reset:${topic.slug}:${started}`, (mutationId) =>
          requestJson('/api/schedule/reset', { method: 'POST', body: {
            ...request, mutation_id: mutationId,
          }}), { payload: request });
        reload();
      } catch (err) {
        confirm.disabled = false;
        panel.append(el('span', { class: 'q-error' }, err.message));
      }
    });
    row.after(panel);
  });
  return open;
}

function wheelCard(state) {
  const card = el('div', { class: 'card wheel-wrap' });
  card.append(el('div', { class: 'cap' }, `Mastery · ${state.totals.concepts} concepts`));

  // The widget is the door to the full-screen Observatory (the variant-A graft).
  const button = el('button', { class: 'wheel-btn', type: 'button', title: 'Open the Observatory' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  button.append(svg);
  button.addEventListener('click', () => openObservatory(state));
  card.append(button);
  queueMicrotask(() => renderWheel(svg, state.topics));

  const stats = el('div', { class: 'wheel-stats' });
  const cells = [
    { n: state.totals.needs_practice, label: 'practicing', cls: 'a' },
    { n: state.totals.in_progress + state.totals.mastered, label: 'in progress', cls: 't' },
    { n: state.totals.unexplored, label: 'unexplored', cls: '' },
  ];
  for (const cell of cells) {
    const ws = el('div', { class: 'ws' });
    ws.append(el('b', { class: cell.cls }, String(cell.n)), text(cell.label));
    stats.append(ws);
  }
  card.append(stats);
  return card;
}

export function renderToday(root, state, { navigate, reload }) {
  const primary = state.topics.find((t) => t.slug === state.today.topic_slug) ?? null;

  // One id per (topic, stage, action), minted once and kept until that request succeeds.
  // Generating it inside the handler, as this first did, gave every click a fresh id and
  // defeated the dedupe the comment claimed to rely on. The shared helper now owns that
  // invariant — and unlike the Map this replaced, its ids outlive a re-render, so a retry
  // after navigating away and back is still recognised.
  const onStageAction = async (button, container, milestoneKey, action) => {
    const topicSlug = state.today.topic_slug ?? primary?.slug;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = action === 'complete' ? 'Marking…' : 'Undoing…';
    container.querySelector('.q-error')?.remove();
    try {
      // Cleared on success by the helper: the next click on this stage is a NEW intent,
      // not a retry of this one.
      const request = { topic_slug: topicSlug, milestone_key: milestoneKey, action };
      await withMutationId(`stage:${topicSlug}:${milestoneKey}:${action}`, (mutationId) =>
        requestJson('/api/schedule/stage', { method: 'POST', body: {
          ...request, mutation_id: mutationId,
        }}), { payload: request });
      reload();
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      container.append(el('span', { class: 'q-error' }, err.message));
    }
  };

  const dateLabel = new Date(`${state.date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  root.append(el('div', { class: 'crumb' }, `Studydeck / Today — ${dateLabel}`));
  root.append(heroSection(state, primary, { onStart: navigate, onStageAction, reload }));
  if (primary) root.append(scheduleStrip(primary));

  const cols = el('div', { class: 'cols' });
  cols.append(queueCard(state), wheelCard(state));
  root.append(cols);

  if (primary) {
    const completed = completedCard(primary, onStageAction);
    if (completed) root.append(completed);
  }
  const controls = scheduleControls(state, reload);
  if (controls) root.append(controls);
}
