// WHAT: Roles — the AI learning roles the cockpit runs as conversations and diagnoses.
// WHY: Learning comes from producing, not consuming. Each role here exists to make the
//      learner produce: the Interviewer asks what they need, the Socratic questioner makes
//      them find the gap, the Sparring partner pushes back, and the Diagnostician looks
//      across recorded misses for one cause behind several.
//
// Three rules shape the view:
//   - Nothing the model writes is ever parsed as HTML. Every turn is a text node.
//   - The server holds the conversation. This view keeps no transcript of its own; after
//     any failure it re-reads the session and offers to finish whatever is waiting.
//   - A session is activity evidence. Nothing here claims mastery or completes a stage.
import { clear, el } from '../dom.mjs';
import { resetMutationId } from '../mutation.mjs';
import { requestJson, requestJsonWithMutation } from '../api.mjs';

const MS_PER_SECOND = 1000;
const TIMER_TICK_MS = 250;
const EGRESS_SEEN_KEY = 'studydeck.roles.egress-seen';

export const ROLE_CHOICES = [
  {
    id: 'interviewer', label: 'Interviewer', needsConcept: false,
    blurb: 'Asks what you want to be able to do, what you know and how you will be tested. Ends with a summary you confirm.',
  },
  {
    id: 'socratic', label: 'Socratic questioner', needsConcept: true,
    blurb: 'Asks questions until you find the gap yourself. It will not give you the answer.',
  },
  {
    id: 'sparring', label: 'Sparring partner', needsConcept: true,
    blurb: 'Plays a counterpart you describe and pushes back on vague answers. Optional timer per answer.',
  },
];

const roleLabel = (id) => ROLE_CHOICES.find((role) => role.id === id)?.label ?? id;

/** "$0.04" — an estimate from token counts, so it is never shown to more than a cent. */
export const formatCost = (usd) => `$${(Number(usd) || 0).toFixed(2)}`;

/** One line describing a past session in the list. */
export function sessionLine(session) {
  const turns = session.status === 'closed'
    ? `${session.turn_count ?? 0} turn${session.turn_count === 1 ? '' : 's'} · ${formatCost(session.cost_usd)}`
    : 'in progress';
  return `${roleLabel(session.role)} · ${String(session.started ?? '').slice(0, 10)} · ${turns}`;
}

/**
 * Where a per-answer timer stands. Expiry changes the label and nothing else: the
 * composer stays usable, because a time limit that locks the answer cannot be extended
 * and teaches nothing about the answer you would have given.
 */
export function timerState(elapsedMs, timerSeconds) {
  if (!timerSeconds) return { label: '', overTime: false };
  const remaining = Math.ceil(timerSeconds - elapsedMs / MS_PER_SECOND);
  if (remaining > 0) return { label: `${remaining}s left`, overTime: false };
  return { label: `Over time by ${-remaining}s — you can still send`, overTime: true };
}

/**
 * Card drafts for a closed session: one per learner turn, front prefilled with the
 * question it answered. The back is left empty on purpose — writing it is the point.
 */
export function cardDrafts(turns) {
  return turns
    .filter((turn) => turn.role === 'learner' && !turn.kind)
    .map((turn) => {
      const asked = [...turns].reverse().find((t) => t.role === 'counterpart' && t.index < turn.index && !t.refusal);
      return { turn_index: turn.index, front: asked?.text ?? '', said: turn.text };
    });
}

/**
 * Who wrote a card's answer side, after something happens to it.
 *
 * Recorded on the card so an AI-written answer is never passed off as the learner's. An
 * edit to an AI draft is still an AI draft underneath, so it gets its own value and can
 * never drift back to `learner`; only a fresh draft resets it.
 */
export function nextBackOrigin(current, event) {
  if (event === 'drafted') return 'ai_draft';
  if (event === 'edited' && current !== 'learner') return 'ai_draft_edited';
  return current;
}

const UNGROUNDED_NOTES = Object.freeze({
  no_notebook: 'this topic has no notebook',
  unreachable: "Open Notebook didn't answer",
  no_sources: 'the notebook has none yet',
});

/**
 * The label a fresh draft arrives with. It says what the draft was made from: a draft
 * made without the learner's sources must never read as if it had been checked against them.
 */
export function draftNote({ grounded, ungrounded_reason: reason }) {
  if (grounded) return 'AI draft from the local model, using your sources. Check it before you keep it.';
  const why = UNGROUNDED_NOTES[reason] ?? UNGROUNDED_NOTES.no_sources;
  return `AI draft made without your sources: ${why}. Check it carefully before you keep it.`;
}

/** What a diagnosis used and what it left out, as sentences. */
export function evidenceLines(evidence) {
  if (!evidence) return [];
  const lines = [`Used ${evidence.misses_sent} recorded miss${evidence.misses_sent === 1 ? '' : 'es'} across ${evidence.distinct_questions} question${evidence.distinct_questions === 1 ? '' : 's'}.`];
  const reasons = {
    pending: 'still waiting for a self-grade',
    deck_changed: 'the deck was edited after the attempt',
    deck_missing: 'the deck is no longer on disk',
    no_deck_hash: 'recorded before decks were fingerprinted',
    over_limit: 'beyond the limit for one diagnosis',
  };
  for (const [key, why] of Object.entries(reasons)) {
    const count = evidence.left_out?.[key] ?? 0;
    if (count) lines.push(`Left out ${count}: ${why}.`);
  }
  return lines;
}

const RESULT_TEXT = {
  no_evidence: 'No eligible misses to diagnose yet. A diagnosis needs misses from finished quiz attempts.',
  insufficient_evidence: 'Not enough evidence for a shared cause. That is a result, not a failure.',
  no_shared_pattern: 'No shared pattern: these misses look unrelated to each other.',
};

/**
 * Tells a late reply whether the screen it was meant for is still the one showing.
 *
 * Roles moves between screens without leaving the view: back to the list, into another
 * session. A request started on one screen can finish after the learner has moved on, and
 * painting its result then would replace whatever they are now typing. `enter()` marks a
 * new screen; a handler keeps the token it started under and checks it before it paints.
 */
export function createScreenGuard() {
  let current = 0;
  let disposed = false;
  return {
    enter: () => (current += 1),
    token: () => current,
    isCurrent: (token) => !disposed && token === current,
    dispose: () => { disposed = true; },
  };
}

function labelled(labelText, control, hint = null) {
  const wrap = el('label', { class: 'roles-field' }, el('span', { class: 'cap' }, labelText), control);
  if (hint) wrap.append(el('span', { class: 'q-hint' }, hint));
  return wrap;
}

function banner(kind, ...lines) {
  const node = el('div', { class: `roles-banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' });
  for (const line of lines) node.append(el('p', {}, line));
  return node;
}

export function renderRoles(root, state, { topic, refreshState = null }) {
  const screen = createScreenGuard();
  let timerHandle = null;
  let onVisibility = null;
  const stopTimer = () => {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
  };

  root.append(el('div', { class: 'crumb' }, `Studydeck / Roles / ${topic.name}`));
  const status = el('div', {});
  const stage = el('div', { class: 'roles' });
  root.append(status, stage);

  const concepts = (topic.domains ?? []).flatMap((domain) => domain.concepts ?? []);
  const withTopic = (path) => `${path}${path.includes('?') ? '&' : '?'}topic=${encodeURIComponent(topic.slug)}`;

  // ---------- health ----------

  let available = false;
  requestJson('/api/roles/health').then((health) => {
    if (!status.isConnected) return;
    available = health.configured && health.reachable && health.authorized;
    if (!health.configured) {
      status.append(banner('warn',
        'The roles are off: no Claude API key is set.',
        'Give the process that starts the cockpit STUDYDECK_ANTHROPIC_API_KEY, as the README\'s External services section describes, then restart it. Past sessions below can still be read.'));
    } else if (!available) {
      status.append(banner('warn',
        health.error ?? 'The Claude API is not answering.',
        'Starting a session or sending a turn will fail until it does. Past sessions below can still be read.'));
    }
  }).catch(() => {});

  // ---------- home ----------

  async function showHome() {
    const here = screen.enter();
    stopTimer();
    clear(stage);
    stage.append(egressNotice());

    const picker = el('div', { class: 'card' });
    picker.append(el('div', { class: 'cap' }, 'Start a session'));
    const setup = el('div', {});
    const buttons = el('div', { class: 'roles-picker' });
    for (const role of ROLE_CHOICES) {
      const button = el('button', { class: 'roles-choice', type: 'button' }, el('b', {}, role.label), el('span', {}, role.blurb));
      button.addEventListener('click', () => showSetup(setup, role));
      buttons.append(button);
    }
    picker.append(buttons, setup);
    stage.append(picker);

    const history = el('div', { class: 'card' });
    history.append(el('div', { class: 'cap' }, 'Sessions for this topic'));
    const summaryCard = el('div', { class: 'card' });
    const diagnosisCard = el('div', { class: 'card' });
    stage.append(history, summaryCard, diagnosisCard);

    try {
      const listing = await requestJson(withTopic('/api/roles/sessions'));
      if (!screen.isCurrent(here)) return;
      if (!listing.sessions.length) {
        history.append(el('p', { class: 'q-hint' }, 'No sessions yet for this topic. Pick a role to start one.'));
      }
      for (const session of listing.sessions) {
        const row = el('div', { class: 'qrow' }, el('span', {}, sessionLine(session)));
        const open = el('button', { class: 'btn small', type: 'button' }, session.status === 'closed' ? 'Read session' : 'Continue session');
        open.addEventListener('click', () => openSession(session.session_id));
        row.append(open);
        history.append(row);
      }
      renderSummary(summaryCard, listing.summary);
    } catch (err) {
      if (!screen.isCurrent(here)) return;
      history.append(banner('error', `Could not load sessions: ${err.message}`));
    }
    renderDiagnosis(diagnosisCard);
  }

  function egressNotice() {
    let seen = false;
    try {
      seen = localStorage.getItem(EGRESS_SEEN_KEY) === '1';
    } catch {
      seen = false;
    }
    const details = el('details', { class: 'card roles-egress', ...(seen ? {} : { open: '' }) });
    details.append(el('summary', { class: 'cap' }, 'What leaves this machine'));
    details.append(
      el('p', {}, 'Everything else in StudyDeck runs locally. The roles do not: they send text to Anthropic\'s Claude API.'),
      el('p', {}, 'Sent: what you type in a session, short excerpts from this topic\'s sources, the names of concepts you have missed, and your confirmed interview summary. A diagnosis also sends questions you got wrong, what you answered and the correct answer.'),
      el('p', {}, 'Never sent: a question you have not attempted, its answer, or a fact-check answer.'),
      el('p', {}, 'Kept only on this machine: the full conversations. Committed with the repository: that a session happened, what it cost, a summary you confirm, and diagnosis findings.'),
    );
    details.addEventListener('toggle', () => {
      try {
        localStorage.setItem(EGRESS_SEEN_KEY, '1');
      } catch { /* a blocked store only means the notice opens again next time */ }
    });
    return details;
  }

  function showSetup(host, role) {
    clear(host);
    const form = el('form', { class: 'roles-setup' });
    form.append(el('p', { class: 'q-hint' }, `${role.label}: ${role.blurb}`));

    const concept = el('select', { class: 'q-input', name: 'concept' });
    concept.append(el('option', { value: '' }, 'The whole topic'));
    for (const c of concepts) concept.append(el('option', { value: c.slug }, c.name));
    if (role.needsConcept && concepts.length) form.append(labelled('Concept', concept));

    const counterpart = el('textarea', { class: 'q-input', rows: '2', maxlength: '600', required: '' });
    const timer = el('input', { class: 'q-input', type: 'number', min: '10', max: '600', step: '5', inputmode: 'numeric' });
    if (role.id === 'sparring') {
      form.append(
        labelled('Who are you sparring with?', counterpart, 'For example: a tough hiring manager for a data engineering role.'),
        labelled('Seconds per answer (optional)', timer, 'Leave empty for no timer. When time runs out you can still send your answer; it is marked as over time.'),
      );
    }

    // A failed start keeps its mutation id so a plain retry is not a second session. An edit to
    // the setup is a new intent, so it must not replay the earlier start with the old setup.
    const startKey = `roles-start:${topic.slug}:${role.id}`;
    for (const field of [concept, counterpart, timer]) field.addEventListener('input', () => resetMutationId(startKey));
    concept.addEventListener('change', () => resetMutationId(startKey));

    const go = el('button', { class: 'btn primary', type: 'submit' }, `Start ${role.label.toLowerCase()} session`);
    const note = el('span', { class: 'q-hint', role: 'status' });
    form.append(el('div', { class: 'q-actions' }, go, note));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const here = screen.token();
      go.disabled = true;
      note.textContent = 'Starting… the first question can take a few seconds.';
      try {
        const session = await requestJsonWithMutation('/api/roles/sessions', {
          method: 'POST',
          mutationKey: startKey,
          body: {
            topic_slug: topic.slug,
            role: role.id,
            concept_slug: role.needsConcept ? concept.value || null : null,
            ...(role.id === 'sparring' ? { counterpart: counterpart.value, timer_seconds: timer.value ? Number(timer.value) : null } : {}),
          },
        });
        if (screen.isCurrent(here)) showSession(session);
      } catch (err) {
        if (!screen.isCurrent(here)) return;
        note.textContent = '';
        form.append(banner('error', `The session could not start. ${err.message}`, 'If it was created, it is listed below and can be continued from there.'));
        go.disabled = false;
      }
    });
    host.append(form);
    (role.id === 'sparring' ? counterpart : go).focus();
  }

  function renderSummary(card, summary) {
    clear(card);
    card.append(el('div', { class: 'cap' }, 'Your interview summary'));
    card.append(el('p', { class: 'q-hint' }, summary
      ? 'Given to every role at the start of a session on this topic. Revising it changes later sessions, not one in progress.'
      : 'None yet. An interview ends with a summary you confirm; you can also write one here.'));
    const box = el('textarea', { class: 'q-input', rows: '4', maxlength: '4000' });
    box.value = summary?.summary ?? '';
    const save = el('button', { class: 'btn', type: 'button' }, 'Save summary');
    const note = el('span', { class: 'q-hint', role: 'status' });
    save.addEventListener('click', async () => {
      if (!box.value.trim()) {
        note.textContent = 'Write a summary before saving.';
        return;
      }
      save.disabled = true;
      try {
        await requestJsonWithMutation('/api/roles/summaries', {
          method: 'POST', mutationKey: `roles-summary:${topic.slug}:${box.value}`,
          body: { topic_slug: topic.slug, summary: box.value },
        });
        note.textContent = 'Saved. This summary is committed with the repository.';
      } catch (err) {
        note.textContent = `Not saved. ${err.message}`;
      }
      save.disabled = false;
    });
    card.append(labelled('Summary', box), el('div', { class: 'q-actions' }, save, note));
  }

  // ---------- a session ----------

  async function openSession(sessionId) {
    const here = screen.token();
    try {
      const session = await requestJson(withTopic(`/api/roles/sessions/${sessionId}`));
      if (screen.isCurrent(here)) showSession(session);
    } catch (err) {
      if (screen.isCurrent(here)) stage.prepend(banner('error', `That session could not be opened. ${err.message}`));
    }
  }

  /** `carry` is text the learner had typed that a rebuild of this screen must not lose. */
  function showSession(session, { carry = '' } = {}) {
    const here = screen.enter();
    stopTimer();
    clear(stage);
    const closed = session.status === 'closed';

    const card = el('div', { class: 'card' });
    const back = el('button', { class: 'btn small', type: 'button' }, 'Back to roles');
    back.addEventListener('click', showHome);
    card.append(el('div', { class: 'roles-head' },
      el('div', { class: 'cap' }, `${roleLabel(session.role)} · ${closed ? 'closed' : 'in progress'}`), back));

    const log = el('div', { class: 'roles-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', tabindex: '0' });
    for (const turn of session.turns) log.append(turnNode(turn));
    card.append(log);

    const meter = el('p', { class: 'q-hint', role: 'status' },
      `${session.learner_turns} of ${session.limits.max_turns} turns · about ${formatCost(session.cost_usd)} of ${formatCost(session.limits.spend_usd)}`);
    card.append(meter);
    stage.append(card);
    log.scrollTop = log.scrollHeight;

    if (closed) {
      if (session.summary) card.append(el('p', { class: 'roles-summary' }, `Confirmed summary: ${session.summary}`));
      if (session.role !== 'interviewer') stage.append(cardsPanel(session));
      return;
    }

    const controls = el('div', {});
    card.append(controls);

    if (session.pending) {
      // A turn is stored and its reply never arrived. Writing a new one would be refused,
      // so the only thing offered is to finish the one that is waiting.
      const retry = el('button', { class: 'btn primary', type: 'button' }, 'Ask for the reply again');
      const note = el('span', { class: 'q-hint', role: 'status' });
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        note.textContent = 'Waiting for a reply…';
        try {
          const resumed = await requestJson(`/api/roles/sessions/${session.session_id}/resume`, { method: 'POST', body: { topic_slug: topic.slug } });
          if (screen.isCurrent(here)) showSession(resumed);
        } catch (err) {
          if (!screen.isCurrent(here)) return;
          note.textContent = `Still no reply. ${err.message}`;
          retry.disabled = false;
        }
      });
      controls.append(
        banner('warn',
          session.pending.kind === 'opening' ? 'This session has not received its first question yet.' : 'Your last turn is saved, but its reply did not arrive.',
          'Nothing was lost. Ask again when the Claude API is answering.'),
        el('div', { class: 'q-actions' }, retry, endButton(session), note),
      );
      return;
    }

    if (session.limits.reached) {
      controls.append(banner('warn',
        session.limits.reached === 'turns'
          ? `This session has reached its limit of ${session.limits.max_turns} turns.`
          : `This session has reached its spending limit of ${formatCost(session.limits.spend_usd)}.`,
        'End the session to keep its record.'));
      controls.append(closePanel(session));
      return;
    }

    const typing = composer(session, carry);
    controls.append(typing.form, closePanel(session, typing));
  }

  function turnNode(turn) {
    const who = turn.role === 'learner' ? 'You' : 'Counterpart';
    const node = el('div', { class: `roles-turn ${turn.role}` });
    node.append(el('span', { class: 'cap' }, turn.kind === 'summary_draft' ? 'Draft summary' : who));
    node.append(el('p', {}, turn.refusal ? 'This turn could not be answered. Carry on with your next one.' : turn.text));
    if (turn.timing?.over_time) node.append(el('span', { class: 'pill owed' }, 'over time'));
    return node;
  }

  function composer(session, carry = '') {
    const here = screen.token();
    const form = el('form', { class: 'roles-composer' });
    const box = el('textarea', { class: 'q-input', rows: '4', maxlength: '4000', required: '' });
    box.value = carry;
    const send = el('button', { class: 'btn primary', type: 'submit' }, 'Send turn');
    const note = el('span', { class: 'q-hint', role: 'status' });
    const clock = el('span', { class: 'roles-clock', role: 'timer', 'aria-live': 'off' });
    form.append(labelled('Your turn', box), el('div', { class: 'q-actions' }, send, clock, note));

    // The clock starts once the counterpart's reply is on screen, so the model's own
    // response time is never counted against the learner.
    const shownAt = performance.now();
    let tabHidden = false;
    if (session.timer_seconds) {
      onVisibility = () => { if (document.hidden) tabHidden = true; };
      document.addEventListener('visibilitychange', onVisibility);
      const tick = () => {
        const { label, overTime } = timerState(performance.now() - shownAt, session.timer_seconds);
        clock.textContent = label;
        clock.classList.toggle('over', overTime);
      };
      tick();
      timerHandle = setInterval(tick, TIMER_TICK_MS);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      const elapsed = Math.round(performance.now() - shownAt);
      stopTimer();
      send.disabled = true;
      box.disabled = true;
      note.textContent = 'Waiting for a reply…';
      try {
        const result = await requestJsonWithMutation(`/api/roles/sessions/${session.session_id}/turns`, {
          method: 'POST',
          mutationKey: `roles-turn:${session.session_id}:${session.next_index}`,
          body: {
            topic_slug: topic.slug,
            index: session.next_index,
            text,
            ...(session.timer_seconds ? { timing: { elapsed_ms: elapsed, tab_hidden: tabHidden } } : {}),
          },
        });
        if (screen.isCurrent(here)) showSession(result.session);
      } catch (err) {
        if (!screen.isCurrent(here)) return;
        // Whether the turn was stored decides what can be offered next, and only the
        // server knows. Re-read the session rather than guess from the error.
        try {
          const current = await requestJson(withTopic(`/api/roles/sessions/${session.session_id}`));
          if (!screen.isCurrent(here)) return;
          if (current.pending) return showSession(current);
          // The session moved on without this turn. Keep what was typed.
          if (current.next_index !== session.next_index) return showSession(current, { carry: text });
        } catch { /* fall through to showing the original failure */ }
        if (!screen.isCurrent(here)) return;
        box.disabled = false;
        send.disabled = false;
        note.textContent = '';
        form.append(banner('error', `Your turn was not sent. ${err.message}`, 'Your text is still in the box. Send it again when ready.'));
      }
    });
    queueMicrotask(() => box.focus());
    return {
      form,
      text: () => box.value,
      /** Held while another request for this session is in flight, so two cannot race. */
      setBusy: (busy) => {
        box.disabled = busy;
        send.disabled = busy;
      },
    };
  }

  function endButton(session, summaryBox = null) {
    const end = el('button', { class: 'btn', type: 'button' }, summaryBox ? 'Confirm summary and end session' : 'End session');
    end.addEventListener('click', async () => {
      if (summaryBox && !summaryBox.value.trim()) {
        summaryBox.focus();
        return;
      }
      const here = screen.token();
      end.disabled = true;
      try {
        await requestJsonWithMutation(`/api/roles/sessions/${session.session_id}/close`, {
          method: 'POST', mutationKey: `roles-close:${session.session_id}`,
          body: { topic_slug: topic.slug, ...(summaryBox ? { summary: summaryBox.value } : {}) },
        });
        if (screen.isCurrent(here)) await openSession(session.session_id);
      } catch (err) {
        if (!screen.isCurrent(here)) return;
        end.disabled = false;
        end.after(banner('error', `The session was not ended. ${err.message}`));
      }
    });
    return end;
  }

  function closePanel(session, typing) {
    const here = screen.token();
    const panel = el('div', { class: 'roles-close' });
    if (session.role !== 'interviewer') {
      panel.append(el('div', { class: 'q-actions' }, endButton(session),
        el('span', { class: 'q-hint' }, 'After ending you can turn your stumbles into flashcards.')));
      return panel;
    }

    const draftTurn = [...session.turns].reverse().find((turn) => turn.kind === 'summary_draft');
    const box = el('textarea', { class: 'q-input', rows: '5', maxlength: '4000' });
    box.value = draftTurn?.text ?? '';
    const draft = el('button', { class: 'btn', type: 'button' }, draftTurn ? 'Draft the summary again' : 'Draft a summary');
    const note = el('span', { class: 'q-hint', role: 'status' });
    draft.addEventListener('click', async () => {
      // A draft is a turn of its own. The composer is held while it is in flight, or a
      // turn sent meanwhile would race it and lose; whatever was typed is carried over.
      draft.disabled = true;
      typing.setBusy(true);
      note.textContent = 'Drafting…';
      try {
        const result = await requestJsonWithMutation(`/api/roles/sessions/${session.session_id}/summary`, {
          method: 'POST', mutationKey: `roles-draft:${session.session_id}:${session.next_index}`,
          body: { topic_slug: topic.slug },
        });
        if (screen.isCurrent(here)) showSession(result.session, { carry: typing.text() });
      } catch (err) {
        if (!screen.isCurrent(here)) return;
        // The request may have been stored before it failed; only the server knows.
        try {
          const current = await requestJson(withTopic(`/api/roles/sessions/${session.session_id}`));
          if (!screen.isCurrent(here)) return;
          if (current.pending) return showSession(current);
        } catch { /* fall through to the message below */ }
        if (!screen.isCurrent(here)) return;
        typing.setBusy(false);
        note.textContent = `No draft. ${err.message} You can write the summary yourself below.`;
        draft.disabled = false;
      }
    });
    panel.append(
      el('div', { class: 'cap' }, 'End the interview'),
      labelled('Summary to confirm', box, 'Edit it until it is true. It is committed with the repository and given to later sessions on this topic.'),
      el('div', { class: 'q-actions' }, draft, endButton(session, box), note),
    );
    return panel;
  }

  function cardsPanel(session) {
    const panel = el('div', { class: 'card' });
    panel.append(el('div', { class: 'cap' }, 'Turn stumbles into flashcards'));
    const drafts = cardDrafts(session.turns);
    if (!drafts.length) {
      panel.append(el('p', { class: 'q-hint' }, 'This session has no turns of yours to make cards from.'));
      return panel;
    }
    panel.append(el('p', { class: 'q-hint' },
      'Tick the turns where you stumbled. Writing the answer side yourself is the practice; the local model can draft one for you to check and edit.'));

    const rows = drafts.map((draft) => {
      const made = session.card_ids?.some((id) => id.endsWith(`-${draft.turn_index}`));
      const pick = el('input', {
        type: 'checkbox',
        'aria-label': `Make a card from your turn: ${draft.said}`,
        ...(made ? { disabled: '' } : {}),
      });
      const front = el('textarea', { class: 'q-input', rows: '2', maxlength: '8000' });
      front.value = draft.front;
      const backSide = el('textarea', { class: 'q-input', rows: '2', maxlength: '8000' });
      const entry = { draft, pick, front, backSide, origin: 'learner' };

      // The answer side can be written by hand, or drafted by the local model and then
      // kept, edited or replaced. A draft arrives locked and labelled, so it is a
      // deliberate act to accept it as written or to change it.
      const draftButton = el('button', { class: 'btn small', type: 'button' }, 'Draft the answer with AI');
      const editButton = el('button', { class: 'btn small', type: 'button', hidden: '' }, 'Edit the draft');
      const aiNote = el('span', { class: 'roles-ai-note', role: 'status' });
      const lock = (locked) => {
        backSide.readOnly = locked;
        backSide.classList.toggle('locked', locked);
        editButton.hidden = !locked;
      };
      backSide.addEventListener('input', () => {
        entry.origin = nextBackOrigin(entry.origin, 'edited');
        if (entry.origin === 'ai_draft_edited') aiNote.textContent = 'AI draft, edited by you.';
        if (entry.origin === 'learner') draftButton.textContent = backSide.value.trim() ? 'Replace my answer with an AI draft' : 'Draft the answer with AI';
      });
      editButton.addEventListener('click', () => {
        lock(false);
        backSide.focus();
      });
      draftButton.addEventListener('click', async () => {
        draftButton.disabled = true;
        // Hold both sides still while the model works: a front edited mid-draft would get an
        // answer to the old question, and a back typed mid-draft would be overwritten.
        const backWasLocked = backSide.readOnly;
        entry.drafting = true;
        front.readOnly = true;
        backSide.readOnly = true;
        editButton.disabled = true;
        const release = () => {
          entry.drafting = false;
          front.readOnly = false;
          editButton.disabled = false;
        };
        aiNote.textContent = 'Drafting with the local model… this can take up to a minute.';
        try {
          const result = await requestJson(`/api/roles/sessions/${session.session_id}/card-draft`, {
            method: 'POST', body: { topic_slug: topic.slug, turn_index: draft.turn_index, front: front.value },
          });
          if (!panel.isConnected) return;
          release();
          // A cleared front was answered against the transcript question; show which one.
          if (!front.value.trim()) front.value = result.front;
          backSide.value = result.back;
          entry.origin = nextBackOrigin(entry.origin, 'drafted');
          lock(true);
          aiNote.textContent = draftNote(result);
          draftButton.textContent = 'Draft again';
          editButton.focus();
        } catch (err) {
          if (!panel.isConnected) return;
          release();
          backSide.readOnly = backWasLocked;
          aiNote.textContent = `No draft. ${err.message}`;
        }
        draftButton.disabled = false;
      });

      const fields = el('div', { class: 'roles-card-fields', hidden: '' },
        labelled('Front (the question)', front),
        labelled('Back (what you should have said)', backSide),
        el('div', { class: 'roles-card-tools' }, draftButton, editButton, aiNote));
      entry.fields = fields;
      pick.addEventListener('change', () => { fields.hidden = !pick.checked; });
      const row = el('div', { class: 'roles-card-row' },
        el('label', { class: 'roles-check' }, pick, el('span', {}, made ? `Card already made — you said: ${draft.said}` : `You said: ${draft.said}`)),
        fields);
      panel.append(row);
      return entry;
    });

    const make = el('button', { class: 'btn primary', type: 'button' }, 'Create cards');
    const note = el('span', { class: 'q-hint', role: 'status' });
    make.addEventListener('click', async () => {
      const chosen = rows.filter((row) => row.pick.checked);
      if (!chosen.length) {
        note.textContent = 'Tick at least one turn first.';
        return;
      }
      // A pending draft would land after the card was saved with the old answer.
      if (chosen.some((row) => row.drafting)) {
        note.textContent = 'Wait for the AI draft to finish before creating cards.';
        return;
      }
      const empty = chosen.find((row) => !row.front.value.trim() || !row.backSide.value.trim());
      if (empty) {
        note.textContent = 'Each ticked card needs a front and a back.';
        (empty.front.value.trim() ? empty.backSide : empty.front).focus();
        return;
      }
      make.disabled = true;
      try {
        const result = await requestJsonWithMutation(`/api/roles/sessions/${session.session_id}/cards`, {
          method: 'POST', mutationKey: `roles-cards:${session.session_id}:${chosen.map((row) => row.draft.turn_index).join(',')}`,
          body: { topic_slug: topic.slug, cards: chosen.map((row) => ({ turn_index: row.draft.turn_index, front: row.front.value, back: row.backSide.value, back_origin: row.origin })) },
        });
        note.textContent = result.created.length === 1
          ? '1 card created. It is in Flashcards.'
          : `${result.created.length} cards created. They are in Flashcards.`;
        for (const row of chosen) {
          row.pick.checked = false;
          row.pick.disabled = true;
          row.fields.hidden = true;
        }
        // Flashcards reads the shell's cached state, not the server. Without this the
        // message above would send the learner to a list that does not have the card yet.
        await refreshState?.();
      } catch (err) {
        note.textContent = `No cards were created. ${err.message}`;
      }
      make.disabled = false;
    });
    panel.append(el('div', { class: 'q-actions' }, make, note));
    return panel;
  }

  // ---------- diagnosis ----------

  async function renderDiagnosis(card) {
    clear(card);
    card.append(el('div', { class: 'cap' }, 'Diagnostician'));
    card.append(el('p', { class: 'q-hint' },
      'Looks across your recorded misses on this topic for one misunderstanding behind several of them. What it returns are hypotheses for you to accept or reject.'));
    const run = el('button', { class: 'btn primary', type: 'button' }, 'Run a diagnosis');
    const note = el('span', { class: 'q-hint', role: 'status' });
    const results = el('div', {});
    card.append(el('div', { class: 'q-actions' }, run, note), results);

    const showAll = async () => {
      clear(results);
      try {
        const { diagnoses } = await requestJson(withTopic('/api/roles/diagnoses'));
        if (!results.isConnected) return;
        for (const diagnosis of diagnoses) results.append(diagnosisNode(diagnosis));
      } catch (err) {
        results.append(banner('error', `Could not load past diagnoses: ${err.message}`));
      }
    };

    run.addEventListener('click', async () => {
      run.disabled = true;
      note.textContent = 'Reading your misses… this can take up to a minute.';
      try {
        const diagnosis = await requestJsonWithMutation('/api/roles/diagnoses', {
          method: 'POST', mutationKey: `roles-diagnosis:${topic.slug}`, body: { topic_slug: topic.slug },
        });
        note.textContent = '';
        if (diagnosis.recorded) await showAll();
        else {
          clear(results);
          results.append(diagnosisNode(diagnosis));
        }
      } catch (err) {
        note.textContent = '';
        results.prepend(banner('error', `No diagnosis was recorded. ${err.message}`));
      }
      run.disabled = false;
    });
    await showAll();
  }

  function diagnosisNode(diagnosis) {
    const node = el('div', { class: 'roles-diagnosis' });
    if (diagnosis.ts) node.append(el('div', { class: 'cap' }, `Diagnosis · ${diagnosis.ts.slice(0, 10)}`));
    for (const line of evidenceLines(diagnosis.evidence)) node.append(el('p', { class: 'q-hint' }, line));
    if (RESULT_TEXT[diagnosis.result]) node.append(el('p', {}, RESULT_TEXT[diagnosis.result]));
    if (diagnosis.dropped_findings) {
      node.append(el('p', { class: 'q-hint' },
        `${diagnosis.dropped_findings} proposed finding${diagnosis.dropped_findings === 1 ? ' was' : 's were'} discarded for citing misses that were not in the request.`));
    }

    for (const finding of diagnosis.findings ?? []) {
      const block = el('div', { class: 'roles-finding' });
      block.append(el('p', { class: 'roles-finding-title' }, finding.misunderstanding));
      if (finding.explanation) block.append(el('p', {}, finding.explanation));
      if (finding.suggested_repair) block.append(el('p', { class: 'q-hint' }, `To repair: ${finding.suggested_repair}`));
      block.append(el('p', { class: 'q-hint' },
        `Rests on ${finding.support.length} miss${finding.support.length === 1 ? '' : 'es'} across ${finding.distinct_questions} question${finding.distinct_questions === 1 ? '' : 's'}` +
        `${finding.single_question ? ' — a single question, so treat it as weak' : ''}.`));

      const stateText = el('span', { class: `pill${finding.state === 'accepted' ? ' hot' : ''}`, role: 'status' },
        finding.state === 'open' ? 'undecided' : finding.state);
      const actions = el('div', { class: 'q-actions' }, stateText);
      for (const [decision, label] of [['accepted', 'Accept hypothesis'], ['rejected', 'Reject hypothesis']]) {
        const button = el('button', { class: 'btn small', type: 'button' }, label);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const updated = await requestJsonWithMutation(`/api/roles/diagnoses/${diagnosis.diagnosis_id}/decisions`, {
              method: 'POST', mutationKey: `roles-decision:${diagnosis.diagnosis_id}:${finding.id}:${decision}`,
              body: { topic_slug: topic.slug, finding_id: finding.id, decision },
            });
            node.replaceWith(diagnosisNode(updated));
          } catch (err) {
            actions.append(el('span', { class: 'q-error', role: 'alert' }, `Not recorded. ${err.message}`));
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      block.append(actions);
      node.append(block);
    }
    return node;
  }

  showHome();
  return () => {
    screen.dispose();
    stopTimer();
  };
}
