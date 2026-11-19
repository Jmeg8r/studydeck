// WHAT: The lifecycle of a role session — start, turn, summary draft, close, cards.
// WHY: A conversation with a paid API has two failure modes the rest of the cockpit does
//      not: a turn can be billed twice, and a reply can be lost between the model and the
//      disk. Both are closed the same way, by the order things are written:
//
//        1. the learner's turn is stored BEFORE the model is called;
//        2. the model's reply is stored BEFORE it is returned.
//
//      A retry therefore finds the turn on disk and knows exactly what it still owes: the
//      stored reply (no call), or the one call that never landed. `mutation_id` alone
//      would not do this — it deduplicates a record, not a charge.
//
// A session is activity evidence, like Practice Lab and Teachback. Nothing here changes
// mastery, appends a stage event or writes to Open Notebook.
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { ClaudeError, createMessage, estimateCostUsd } from './claude.mjs';
import { shareInFlight } from './inflight.mjs';
import { flattenConcepts, readTopicState } from './learn.mjs';
import { notebookForTopic, OpenNotebookError } from './opennotebook.mjs';
import { draftCardBack } from './ollama.mjs';
import { buildSystemPrompt, CONVERSATION_ROLES, KICKOFF, ROLE_LIMITS, SUMMARY_REQUEST } from './roles.mjs';
import { todayISO } from './schedule.mjs';
import {
  appendSessionEvent, appendTranscript, isFinalAttempt, readAttempts, readCards,
  readSessionEvents, readTranscript, writeCards,
} from './sidecar.mjs';
import { collectSources } from './videogeneration.mjs';

const MS_PER_SECOND = 1000;
/** How much of the session id goes into a card id — enough to be unique per topic. */
const CARD_ID_PREFIX_LENGTH = 8;
const CARD_ROLES = new Set(['socratic', 'sparring']);
/** Who wrote a card's answer side. Kept on the card so an AI-written answer is never mistaken for the learner's. */
export const BACK_ORIGINS = Object.freeze(['learner', 'ai_draft', 'ai_draft_edited']);
/** Why a card draft had no source excerpts, keyed by `excerptsFor`'s status. A count of 0 is `no_sources`. */
const UNGROUNDED_REASONS = Object.freeze({ none: 'no_notebook', unavailable: 'unreachable' });

const CLOSED = 'This session is closed. Start a new one to continue.';

const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

/** In-process half of start idempotency; the session event is the durable half. */
const startsInFlight = new Map();

/**
 * One queue per session: turns for a session run strictly one after another.
 *
 * What this prevents is a second charge for one turn. A duplicate request arriving while
 * the first is still waiting on the model finds the learner turn on disk with no reply,
 * and would conclude a call is owed. Queued behind the first, it finds the reply instead.
 *
 * A DIFFERENT reply to the same turn does not need the queue: the learner turn is written
 * synchronously before the first await, so the second request already sees it and is
 * refused. Both cases are pinned in rolesessions.test.mjs, and only the first fails with
 * this queue removed.
 */
const queues = new Map();
function enqueue(sessionId, task) {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const settled = run.catch(() => {}).finally(() => {
    if (queues.get(sessionId) === settled) queues.delete(sessionId);
  });
  queues.set(sessionId, settled);
  return run;
}

/** Latest state per session, from the append-only event file. */
export function foldSessions(events) {
  const sessions = new Map();
  for (const event of events) {
    if (event.event === 'session_started') {
      sessions.set(event.session_id, {
        session_id: event.session_id,
        role: event.role,
        concept_slug: event.concept_slug ?? null,
        started: event.ts,
        status: 'open',
        excerpts: event.excerpts,
        timer_seconds: event.timer_seconds ?? null,
        card_ids: [],
      });
      continue;
    }
    const session = sessions.get(event.session_id);
    if (!session) continue;
    if (event.event === 'session_closed') {
      Object.assign(session, {
        status: 'closed',
        closed: event.ts,
        turn_count: event.turn_count,
        usage: event.usage,
        cost_usd: event.cost_usd,
        ...(event.summary ? { summary: event.summary } : {}),
      });
    } else if (event.event === 'cards_created') {
      session.card_ids.push(...event.card_ids);
    }
  }
  return [...sessions.values()];
}

/** The newest confirmed interview summary for a topic, or null. File order is time order. */
export function latestSummary(events) {
  let latest = null;
  for (const event of events) {
    if (event.event === 'summary_revised' || (event.event === 'session_closed' && event.summary)) {
      latest = { summary: event.summary, ts: event.ts, session_id: event.session_id ?? null };
    }
  }
  return latest;
}

function requireSession(topicSlug, sessionId) {
  const session = foldSessions(readSessionEvents(topicSlug)).find((s) => s.session_id === sessionId);
  if (!session) throw fail(404, 'unknown session');
  return session;
}

/**
 * A transcript is a header, the turns in order, and any charges that bought nothing.
 *
 * A charge is a response that was billed and could not be used as a reply. It is kept so
 * the money is counted, and kept apart from the turns so it never shifts a turn's index
 * and is never replayed to the model.
 */
function loadTranscript(topicSlug, sessionId) {
  const [header, ...lines] = readTranscript(topicSlug, sessionId);
  const turns = lines.filter((line) => line.type === 'turn');
  const charges = lines.filter((line) => line.type === 'charge');
  if (header?.type !== 'header') {
    throw fail(409, 'This session has no transcript on this machine. Transcripts are not committed, so a session can only be continued where it was started.');
  }
  return { header, turns, charges };
}

/** Everything the session has cost: replies that were used, and responses that were not. */
function totals(turns, charges) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let cost = 0;
  for (const line of [...turns.filter((turn) => turn.role === 'assistant'), ...charges]) {
    for (const key of Object.keys(usage)) usage[key] += line.usage?.[key] ?? 0;
    cost += line.cost_usd ?? 0;
  }
  return { usage, cost_usd: cost };
}

const SPEND_LIMIT = `This session has reached its spending limit of $${ROLE_LIMITS.sessionSpendUsd.toFixed(2)}. End the session to keep its record.`;

/**
 * The turn still waiting for its reply, if there is one.
 *
 * Carries the `mutation_id` on purpose. The browser holds that id in memory only, so after
 * a reload this is the one place it can learn which id finishes the turn it left waiting;
 * a fresh id would be refused for as long as the turn stays unanswered.
 */
function pendingTurn(turns) {
  const last = turns.at(-1);
  if (last?.role !== 'user') return null;
  return {
    ...(last.mutation_id ? { mutation_id: last.mutation_id } : {}),
    index: last.index,
    kind: last.kind ?? (last.index === 0 ? 'opening' : 'turn'),
    ...(last.hidden ? {} : { text: last.content }),
  };
}

const learnerTurnCount = (turns) => turns.filter((turn) => turn.role === 'user' && !turn.hidden).length;

/** What the browser sees: visible text only. Thinking blocks and the system prompt stay here. */
function visibleTurn(turn) {
  return {
    index: turn.index,
    role: turn.role === 'user' ? 'learner' : 'counterpart',
    text: turn.role === 'user' ? turn.content : turn.text,
    ...(turn.kind ? { kind: turn.kind } : {}),
    ...(turn.refusal ? { refusal: true } : {}),
    ...(turn.timing ? { timing: turn.timing } : {}),
  };
}

function sessionView(session, header, turns, charges) {
  const { usage, cost_usd: cost } = totals(turns, charges);
  const learnerTurns = learnerTurnCount(turns);
  return {
    ...session,
    model: header.model,
    turns: turns.filter((turn) => !turn.hidden).map(visibleTurn),
    next_index: turns.length,
    pending: pendingTurn(turns),
    learner_turns: learnerTurns,
    usage,
    cost_usd: cost,
    limits: {
      max_turns: ROLE_LIMITS.maxTurns,
      spend_usd: ROLE_LIMITS.sessionSpendUsd,
      turns_left: Math.max(0, ROLE_LIMITS.maxTurns - learnerTurns),
      reached: learnerTurns >= ROLE_LIMITS.maxTurns ? 'turns' : cost >= ROLE_LIMITS.sessionSpendUsd ? 'spend' : null,
    },
  };
}

/**
 * Concept names the learner has missed in a final attempt — names only, never questions.
 * Most recent miss first, so the cap keeps the concepts missed lately.
 */
export function missedConceptNames(topicSlug, concepts, attempts = readAttempts(topicSlug)) {
  const names = new Map(concepts.map((concept) => [concept.slug, concept.name ?? concept.slug]));
  const missed = new Set();
  for (const attempt of [...attempts].reverse()) {
    if (!isFinalAttempt(attempt) || !attempt.misses?.length || !names.has(attempt.concept_slug)) continue;
    missed.add(names.get(attempt.concept_slug));
    if (missed.size >= ROLE_LIMITS.maxMissedConcepts) break;
  }
  return [...missed];
}

/**
 * Bounded excerpts from the topic's notebook, or none.
 *
 * Optional on purpose: an interview has to work on a topic with no sources yet, and Open
 * Notebook being down must not stop a conversation that does not strictly need it. The
 * session record says which happened. A notebook with no readable sources is a count of
 * 0, not an outage: `collectSources` refuses it with a plain 400, while a failure of Open
 * Notebook itself is an `OpenNotebookError` or a fetch that never connected.
 */
async function excerptsFor(topicSlug) {
  const notebookId = notebookForTopic(topicSlug);
  if (!notebookId) return { excerpts: [], status: 'none' };
  try {
    const { sources } = await collectSources(notebookId);
    return { excerpts: sources, status: sources.length };
  } catch (err) {
    const empty = !(err instanceof OpenNotebookError) && err.status === 400;
    return { excerpts: [], status: empty ? 0 : 'unavailable' };
  }
}

/**
 * Make sure the transcript ends with a reply, calling the model only if it does not.
 *
 * Assistant content is stored and replayed exactly as it arrived. A refused turn is kept
 * for the record but left out of what is replayed: it has no content to send back.
 */
async function advance(topicSlug, sessionId, header, turns, charges) {
  const last = turns.at(-1);
  if (last?.role === 'assistant') return last;
  // Checked here as well as before a new turn is stored: a retry of a waiting turn is a
  // purchase too, and an unusable response may have used up the budget since.
  if (totals(turns, charges).cost_usd >= ROLE_LIMITS.sessionSpendUsd) throw fail(409, SPEND_LIMIT);

  const reply = await createMessage({
    system: header.system,
    messages: turns
      .filter((turn) => !turn.refusal)
      .map((turn) => ({ role: turn.role, content: turn.content })),
    maxTokens: header.max_tokens,
    effort: header.effort,
    model: header.model,
  });
  if (!reply.refusal && !reply.text) {
    // Billed, and not a reply: the model spent its output without writing any text. The
    // charge is recorded before the error so a retry loop cannot spend unseen.
    const charge = {
      type: 'charge',
      reason: 'no_text',
      stop_reason: reply.stopReason,
      usage: reply.usage,
      cost_usd: estimateCostUsd(reply.usage),
      ts: now(),
    };
    appendTranscript(topicSlug, sessionId, charge);
    charges.push(charge);
    throw new ClaudeError('The Claude API returned a reply with no text. Your text is kept; try again.', 502);
  }

  const turn = {
    type: 'turn',
    index: turns.length,
    role: 'assistant',
    content: reply.content,
    text: reply.text,
    ...(reply.refusal ? { refusal: true } : {}),
    ...(last?.kind === 'summary_request' ? { kind: 'summary_draft' } : {}),
    stop_reason: reply.stopReason,
    usage: reply.usage,
    cost_usd: estimateCostUsd(reply.usage),
    model: reply.model,
    fallbacks_enabled: reply.fallbacksEnabled,
    ts: now(),
  };
  appendTranscript(topicSlug, sessionId, turn);
  turns.push(turn);
  return turn;
}

export function listSessions(topicSlug) {
  const events = readSessionEvents(topicSlug);
  return {
    sessions: foldSessions(events).reverse(),
    summary: latestSummary(events),
    limits: ROLE_LIMITS,
  };
}

export function getSession(topicSlug, sessionId) {
  const session = requireSession(topicSlug, sessionId);
  const { header, turns, charges } = loadTranscript(topicSlug, sessionId);
  return sessionView(session, header, turns, charges);
}

/**
 * Start a session and return it with the role's opening turn.
 *
 * The session is recorded before the model is called, so a start that fails at the model
 * leaves a session whose opening is still owed; retrying with the same `mutation` finds
 * it and makes that one call rather than starting a second session.
 */
export async function startSession({ topicSlug, role, conceptSlug = null, counterpart = null, timerSeconds = null, mutation }) {
  if (!CONVERSATION_ROLES.includes(role)) throw fail(400, `role must be one of: ${CONVERSATION_ROLES.join(', ')}`);
  if (role === 'sparring' && !counterpart) throw fail(400, 'counterpart is required for a sparring session: say who you are sparring with');

  const { result } = await shareInFlight(startsInFlight, `${topicSlug}:${mutation}`, async () => {
    let started = readSessionEvents(topicSlug)
      .find((event) => event.event === 'session_started' && event.mutation_id === mutation);

    if (!started) {
      const state = readTopicState(topicSlug);
      const concepts = flattenConcepts(state);
      const concept = conceptSlug ? concepts.find((c) => c.slug === conceptSlug) : null;
      if (conceptSlug && !concept) throw fail(400, 'concept_slug must belong to the selected topic');

      const { excerpts, status: excerptStatus } = await excerptsFor(topicSlug);
      const summary = latestSummary(readSessionEvents(topicSlug));
      const sessionId = randomUUID();

      appendTranscript(topicSlug, sessionId, {
        type: 'header',
        session_id: sessionId,
        role,
        model: config.claude.model,
        effort: config.claude.effort[role],
        max_tokens: ROLE_LIMITS.turnMaxTokens,
        timer_seconds: role === 'sparring' ? timerSeconds : null,
        // An array with a cache breakpoint: this prefix is identical on every turn of the
        // session, so every turn after the first reads it from cache.
        system: [{
          type: 'text',
          text: buildSystemPrompt({
            role,
            topicName: state.topic ?? topicSlug,
            conceptName: concept?.name ?? null,
            summary: summary?.summary ?? null,
            excerpts,
            missedConcepts: missedConceptNames(topicSlug, concepts),
            counterpart: role === 'sparring' ? counterpart : null,
          }),
          // One hour, not the five-minute default. Measured on the first live sessions
          // (2026-10-11): a learner thinking before each answer paused longer than five
          // minutes on 8 of 13 turns, and every such pause re-bought the whole prompt. A
          // one-hour write costs 2x input instead of 1.25x, and is paid once per session.
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
        created: now(),
      });
      appendTranscript(topicSlug, sessionId, { type: 'turn', index: 0, role: 'user', content: KICKOFF, hidden: true, ts: now() });

      started = appendSessionEvent(topicSlug, {
        event: 'session_started',
        session_id: sessionId,
        mutation_id: mutation,
        ts: now(),
        role,
        concept_slug: conceptSlug,
        timer_seconds: role === 'sparring' ? timerSeconds : null,
        excerpts: excerptStatus,
        used_summary: Boolean(summary),
      });
    }

    return enqueue(started.session_id, async () => {
      const session = requireSession(topicSlug, started.session_id);
      const { header, turns, charges } = loadTranscript(topicSlug, started.session_id);
      // A replayed start reads back a closed session; it never buys its missing opening.
      if (session.status !== 'closed') await advance(topicSlug, started.session_id, header, turns, charges);
      return sessionView(session, header, turns, charges);
    });
  });
  return result;
}

/** Whether a self-reported answer time ran past the session's timer. */
function timingFor(header, timing) {
  if (!timing) return null;
  return {
    elapsed_ms: timing.elapsed_ms,
    tab_hidden: Boolean(timing.tab_hidden),
    over_time: header.timer_seconds != null && timing.elapsed_ms > header.timer_seconds * MS_PER_SECOND,
    self_reported: true,
  };
}

async function submit(topicSlug, sessionId, { index = null, text, mutation, timing = null, hidden = false, kind = null }) {
  return enqueue(sessionId, async () => {
    const session = requireSession(topicSlug, sessionId);
    const { header, turns, charges } = loadTranscript(topicSlug, sessionId);

    const prior = turns.find((turn) => turn.role === 'user' && turn.mutation_id === mutation);
    if (prior) {
      // A replay. The reply is either on disk already (nothing to pay for) or was never
      // stored (one call still owed). A stored reply can be read back from a closed
      // session; an owed one cannot be bought for it — closing ended the spending.
      const stored = turns[prior.index + 1]?.role === 'assistant' ? turns[prior.index + 1] : null;
      if (!stored && session.status === 'closed') throw fail(409, CLOSED);
      const reply = stored ?? await advance(topicSlug, sessionId, header, turns, charges);
      return { reply: visibleTurn(reply), replayed: true, session: sessionView(session, header, turns, charges) };
    }

    if (session.status === 'closed') throw fail(409, CLOSED);
    if (turns.at(-1)?.role === 'user') {
      throw fail(409, 'The previous turn is still waiting for its reply. Send it again before writing a new one.');
    }
    if (index !== null && index !== turns.length) {
      throw fail(409, 'That turn has already been answered. Reload the session to continue from its latest turn.');
    }
    // The turn limit counts what the learner wrote, so a summary request is exempt from
    // it. The spending limit counts money, and a summary draft costs money like any turn.
    if (!hidden && learnerTurnCount(turns) >= ROLE_LIMITS.maxTurns) {
      throw fail(409, `This session has reached its limit of ${ROLE_LIMITS.maxTurns} turns. End the session to keep its record.`);
    }
    if (totals(turns, charges).cost_usd >= ROLE_LIMITS.sessionSpendUsd) throw fail(409, SPEND_LIMIT);

    const turn = {
      type: 'turn',
      index: turns.length,
      role: 'user',
      content: text,
      mutation_id: mutation,
      ...(hidden ? { hidden: true } : {}),
      ...(kind ? { kind } : {}),
      ...(timing ? { timing: timingFor(header, timing) } : {}),
      ts: now(),
    };
    appendTranscript(topicSlug, sessionId, turn);
    turns.push(turn);

    const reply = await advance(topicSlug, sessionId, header, turns, charges);
    return { reply: visibleTurn(reply), replayed: false, session: sessionView(session, header, turns, charges) };
  });
}

/**
 * Finish whatever the session is waiting on: its opening, a turn, or a summary draft.
 *
 * One route for every kind of waiting turn, so "left unanswered and now stuck" cannot
 * recur one kind at a time. It carries no `mutation_id` because it appends nothing of the
 * caller's: the turn it completes is already on disk, and with nothing waiting it is a
 * read. Run twice at once it still makes one call — the second is queued behind the
 * first and finds the reply stored.
 */
export function resumeSession(topicSlug, sessionId) {
  return enqueue(sessionId, async () => {
    const session = requireSession(topicSlug, sessionId);
    const { header, turns, charges } = loadTranscript(topicSlug, sessionId);
    if (pendingTurn(turns)) {
      if (session.status === 'closed') throw fail(409, CLOSED);
      await advance(topicSlug, sessionId, header, turns, charges);
    }
    return sessionView(session, header, turns, charges);
  });
}

export const sendTurn = (topicSlug, sessionId, { index, text, mutation, timing }) =>
  submit(topicSlug, sessionId, { index, text, mutation, timing });

/** Ask the Interviewer for a summary to confirm. The draft is a turn like any other. */
export function draftSummary(topicSlug, sessionId, { mutation }) {
  if (requireSession(topicSlug, sessionId).role !== 'interviewer') {
    throw fail(400, 'Only an interview ends with a summary.');
  }
  return submit(topicSlug, sessionId, { text: SUMMARY_REQUEST, mutation, hidden: true, kind: 'summary_request' });
}

/**
 * Close a session and record its outcome. Needs no provider.
 *
 * `summary` is what the learner confirmed, possibly edited from the draft. It is the one
 * piece of a conversation that is committed, and it feeds later sessions on the topic.
 */
export function closeSession(topicSlug, sessionId, { mutation, summary = null }) {
  // Queued behind any turn still waiting on the model: the outcome records what the
  // session cost, and a reply that lands after the totals were taken would be missing
  // from the committed record for good.
  return enqueue(sessionId, async () => {
    const session = requireSession(topicSlug, sessionId);
    if (session.status === 'closed') return { ...session, duplicate: true };
    if (summary && session.role !== 'interviewer') throw fail(400, 'Only an interview ends with a summary.');

    const { turns, charges } = loadTranscript(topicSlug, sessionId);
    const { usage, cost_usd: cost } = totals(turns, charges);
    appendSessionEvent(topicSlug, {
      event: 'session_closed',
      session_id: sessionId,
      mutation_id: mutation,
      ts: now(),
      turn_count: learnerTurnCount(turns),
      usage,
      cost_usd: cost,
      ...(summary ? { summary } : {}),
    });
    return requireSession(topicSlug, sessionId);
  });
}

/** Replace the topic's interview summary. Appends; the earlier one stays in history. */
export function reviseSummary(topicSlug, { summary, mutation }) {
  const event = appendSessionEvent(topicSlug, { event: 'summary_revised', mutation_id: mutation, ts: now(), summary });
  return { summary: latestSummary(readSessionEvents(topicSlug)), duplicate: Boolean(event.duplicate) };
}

/** The closed session, its turns, and the learner turn a card is being made from. */
function cardSource(topicSlug, sessionId, turnIndex) {
  const session = requireSession(topicSlug, sessionId);
  if (!CARD_ROLES.has(session.role)) throw fail(400, 'Cards come from a Socratic or sparring session.');
  if (session.status !== 'closed') throw fail(409, 'End the session before turning its stumbles into cards.');
  const { turns } = loadTranscript(topicSlug, sessionId);
  const turn = turns[turnIndex];
  if (!turn || turn.role !== 'user' || turn.hidden) {
    throw fail(400, `turn_index ${turnIndex} is not one of your turns in this session`);
  }
  return { session, turns, turn };
}

/**
 * Ask the LOCAL model to draft a card's answer side. Stores nothing.
 *
 * Local on purpose: a card is made after its session is closed, and closing is where the
 * spending stopped. The draft is returned to the browser and exists nowhere else until
 * the learner creates the card, at which point it is recorded as an AI draft.
 */
export async function draftSessionCard(topicSlug, sessionId, { turnIndex, front }) {
  const { turns, turn } = cardSource(topicSlug, sessionId, turnIndex);
  // The learner may have rewritten the front; the draft must answer the card as it stands.
  // A blank front falls back to the question the turn answered.
  const question = front?.trim() || (turns.slice(0, turnIndex).reverse().find((t) => t.role === 'assistant' && !t.refusal)?.text ?? '');
  const { excerpts, status } = await excerptsFor(topicSlug);
  const back = await draftCardBack({ question, said: turn.content, excerpts });
  const grounded = excerpts.length > 0;
  return {
    turn_index: turnIndex, front: question, back, origin: 'ai_draft',
    grounded, ungrounded_reason: grounded ? null : UNGROUNDED_REASONS[status] ?? 'no_sources',
  };
}

/**
 * Turn chosen stumbles from a closed session into flashcards.
 *
 * The learner writes both sides. No model drafts the back, so no answer is invented —
 * and writing it is the production step the whole feature exists to encourage. A card's
 * id comes from the session and the turn, so a retry cannot make a second card.
 */
export function createSessionCards(topicSlug, sessionId, { cards, mutation }) {
  const session = requireSession(topicSlug, sessionId);
  if (!CARD_ROLES.has(session.role)) throw fail(400, 'Cards come from a Socratic or sparring session.');
  if (session.status !== 'closed') throw fail(409, 'End the session before turning its stumbles into cards.');

  const { turns } = loadTranscript(topicSlug, sessionId);
  const stored = readCards(topicSlug);
  const existing = new Set(stored.map((card) => card.id));
  const created = [];

  for (const card of cards) {
    const turn = turns[card.turn_index];
    if (!turn || turn.role !== 'user' || turn.hidden) {
      throw fail(400, `turn_index ${card.turn_index} is not one of your turns in this session`);
    }
    const id = `card-session-${sessionId.slice(0, CARD_ID_PREFIX_LENGTH)}-${card.turn_index}`;
    if (existing.has(id)) continue;
    existing.add(id);
    created.push({
      id,
      front: card.front,
      back: card.back,
      back_origin: card.back_origin ?? 'learner',
      concept_slug: session.concept_slug,
      source: 'session',
      source_ref: `session:${sessionId}:${card.turn_index}`,
      created: todayISO(),
    });
  }

  if (created.length) {
    writeCards(topicSlug, [...stored, ...created]);
    appendSessionEvent(topicSlug, {
      event: 'cards_created',
      session_id: sessionId,
      mutation_id: mutation,
      ts: now(),
      card_ids: created.map((card) => card.id),
    });
  }
  return { created, session: requireSession(topicSlug, sessionId) };
}
