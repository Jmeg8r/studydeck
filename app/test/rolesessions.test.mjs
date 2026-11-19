// WHAT: What a role session sends to the Claude API, how many times, and what it writes.
// WHY:  A conversation with a paid API can bill a turn twice or lose a reply between the
//       model and the disk. sessions.mjs closes both by the ORDER of its writes, and the
//       only honest test of an ordering is to count outbound requests while breaking it:
//       replay a turn, fail the model mid-turn, send two replies at once.
//
// SAME RULE AS gradeegress/claudeegress: nothing here asserts the SHAPE of a Claude
// response. The stub is a recorder; assertions are over what THIS APP SENT and WROTE. The
// stub serves the minimum message-shaped body that gets a route to the code under test.
// If the Messages API envelope moves, this file keeps passing and the real call breaks.
//
// Every "nothing was sent" assertion below has a control beside it that requires a send,
// so silence cannot also pass for a request that never reached the client at all.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-role-sessions-'));
const FAKE_KEY = 'role-sessions-test-key-never-real';

// Planted in the deck, the attempt log and the fact-check store. None may ever appear in
// an outbound request from a conversational role (AGENTS.md rule 7).
const DECK_QUESTION = 'ZZ-DECK-QUESTION-what-freezes-first';
const DECK_ANSWER = 'ZZ-DECK-ANSWER-the-pretrained-body';
const LEARNER_RESPONSE = 'ZZ-LEARNER-RESPONSE-the-head';
const FACT_TRUTH = 'ZZ-FACTCHECK-TRUTH-one-epoch';
const SECRETS = [DECK_QUESTION, DECK_ANSWER, LEARNER_RESPONSE, FACT_TRUTH];

const SOURCE_ID = 'source:role-fixture';
const SOURCE_TEXT = 'Freeze the pretrained body first so the new head cannot damage useful features.';
const CONCEPT = 'role-fixture-concept';
const CONCEPT_NAME = 'Role Fixture Concept';

/** Every request this app sent to "Claude", in order. */
const sent = [];
/** Scripted answers, consumed one per request. Empty means a plain success. */
let script = [];
/** When set, the stub holds every response until this resolves. */
let gate = null;
let replyCounter = 0;

const okBody = (text) => ({
  type: 'message',
  model: 'stub-model',
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: `opaque-${replyCounter}` }, { type: 'text', text }],
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const claudeStub = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  sent.push({ path: new URL(req.url, 'http://stub').pathname, body: raw ? JSON.parse(raw) : null, raw });
  if (gate) await gate;
  replyCounter += 1;
  const next = script.shift() ?? { status: 200, body: okBody(`Question ${replyCounter}?`) };
  res.writeHead(next.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(next.body));
});
await new Promise((resolve) => claudeStub.listen(0, '127.0.0.1', resolve));

const onSent = [];
/** When set, Open Notebook answers every request with a 500. */
let onDown = false;
/** When set, the notebook is healthy but has no sources. */
let onEmpty = false;
const onStub = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  onSent.push(`${req.method} ${url.pathname}`);
  if (onDown) {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end('{"error":"source recorder was told to fail"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (url.pathname === '/api/sources' && onEmpty) return res.end('[]');
  if (url.pathname === '/api/sources') return res.end(JSON.stringify([{ id: SOURCE_ID, title: 'Role fixture lesson' }]));
  if (url.pathname === `/api/sources/${encodeURIComponent(SOURCE_ID)}`) {
    return res.end(JSON.stringify({ id: SOURCE_ID, title: 'Role fixture lesson', full_text: SOURCE_TEXT }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end('{"error":"unexpected ON request"}');
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

// Set before config.mjs is imported — it resolves once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_CLAUDE_BASE_URL = `http://127.0.0.1:${claudeStub.address().port}`;
process.env.STUDYDECK_ANTHROPIC_API_KEY = FAKE_KEY;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'fixture-password';

/** Every request this app sent to the LOCAL model, in order. Card drafts are its only use here. */
const localSent = [];
/** What the local model's reply text will be; null means a fenced, well-formed draft. */
let localContent = null;
let localStatus = 0;
const ollamaStub = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  localSent.push({ path: new URL(req.url, 'http://stub').pathname, raw });
  if (localStatus) {
    res.writeHead(localStatus, { 'content-type': 'application/json' });
    return res.end('{"error":"stub was told to fail"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  // Fence-wrapped with leading prose by default, because that is what the local model does.
  const content = localContent ?? 'Sure:\n```json\n{"back":"A drafted answer from the local model."}\n```';
  return res.end(JSON.stringify({ message: { content } }));
});
await new Promise((resolve) => ollamaStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaStub.address().port}`;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
const { ROLE_LIMITS } = await import('../lib/roles.mjs');
const { resetFallbackState } = await import('../lib/claude.mjs');

assert.equal(config.claude.baseUrl, process.env.STUDYDECK_CLAUDE_BASE_URL, 'not talking to the recorder');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the source recorder');

const TOPIC = config.topics.find((t) => t.notebookId).slug;
const EMPTY_TOPIC = config.topics.find((t) => t.slug !== TOPIC).slug;

const topicState = (slug, concepts) => ({
  version: 1, slug, topic: `Fixture ${slug}`, created: '2026-10-11', last_updated: null,
  domains: concepts.length ? [{ slug: 'fixture-domain', name: 'Fixture Domain', concepts }] : [],
});
const concept = {
  name: CONCEPT_NAME, slug: CONCEPT, status: 'unexplored', confidence: 0, practice_count: 0,
  explain_count: 0, last_explained: null, last_practiced: null, details: ['a detail'],
};

for (const topic of config.topics) {
  const dir = join(FIXTURE_ROOT, topic.slug);
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  const concepts = topic.slug === TOPIC ? [concept] : [];
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(topicState(topic.slug, concepts), null, 2)}\n`);
}

// The dangerous fixture: a deck with an answer, a final attempt that missed it, and a
// fact-check truth, all sitting where a careless prompt builder could reach them.
const topicDir = join(FIXTURE_ROOT, TOPIC);
mkdirSync(join(topicDir, 'quizzes', CONCEPT), { recursive: true });
writeFileSync(join(topicDir, 'quizzes', CONCEPT, 'fixture-deck.json'), JSON.stringify({
  concept_slug: CONCEPT, concept_name: CONCEPT_NAME,
  questions: [{ id: 'q1', type: 'short_answer', gradeable: 'accepted', prompt: DECK_QUESTION, answer: DECK_ANSWER, explanation: DECK_ANSWER }],
}));
writeFileSync(join(topicDir, 'cockpit', 'attempts.jsonl'), `${JSON.stringify({
  ts: '2026-10-10T10:00:00.000Z', kind: 'quiz', attempt_id: 'attempt-fixture-1', mutation_id: 'fixture-attempt',
  revision: 0, concept_slug: CONCEPT, deck_file: 'fixture-deck.json', score: 0, max: 1, misses: ['q1'],
  responses: { q1: LEARNER_RESPONSE }, status: 'final',
})}\n`);
writeFileSync(join(topicDir, 'cockpit', 'factchecks.json'), JSON.stringify({
  [CONCEPT]: { claims: [{ id: 'c1', text: 'a claim', truth: FACT_TRUTH, correction: FACT_TRUTH }] },
}));

const STATE_BEFORE = readFileSync(join(topicDir, 'state.json'));

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  claudeStub.close();
  onStub.close();
  ollamaStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  onSent.length = 0;
  script = [];
  gate = null;
  onDown = false;
  onEmpty = false;
  localSent.length = 0;
  localContent = null;
  localStatus = 0;
  resetFallbackState();
});

/**
 * One answer that makes the client give up at once. A 401 is not retried, so a test that
 * needs "the provider is not serving us" does not sit through the retry backoff.
 */
const UNAVAILABLE = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'not serving you' } } };

let mutationCounter = 0;
const mint = () => `mut-${mutationCounter += 1}-${'x'.repeat(8)}`;

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
};

const start = (overrides = {}) => post('/api/roles/sessions', {
  topic_slug: TOPIC, role: 'socratic', concept_slug: CONCEPT, mutation_id: mint(), ...overrides,
});
const turn = (session, overrides = {}) => post(`/api/roles/sessions/${session.session_id}/turns`, {
  topic_slug: TOPIC, index: session.next_index, text: 'Because the head starts random.', mutation_id: mint(), ...overrides,
});
const close = (session, overrides = {}) => post(`/api/roles/sessions/${session.session_id}/close`, {
  topic_slug: TOPIC, mutation_id: mint(), ...overrides,
});

const transcriptPath = (slug, id) => join(FIXTURE_ROOT, slug, 'cockpit', 'transcripts', `${id}.jsonl`);
const transcript = (slug, id) => readFileSync(transcriptPath(slug, id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sessionEvents = (slug) => {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', 'sessions.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('starting a session sends one request and returns the opening turn', async () => {
  const { status, body } = await start();
  assert.equal(status, 201);
  assert.equal(sent.length, 1);
  assert.equal(body.turns.length, 1, 'the kickoff the API needs is not shown');
  assert.equal(body.turns[0].role, 'counterpart');
  assert.equal(body.next_index, 2);

  const request = sent[0].body;
  assert.equal(request.model, config.claude.model);
  assert.deepEqual(request.output_config, { effort: config.claude.effort.socratic });
  assert.equal(request.max_tokens, ROLE_LIMITS.turnMaxTokens);
  // One hour, not the five-minute default: a learner who thinks before answering pauses
  // longer than five minutes more often than not, and each pause then re-buys the prompt.
  assert.deepEqual(request.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.match(request.system[0].text, /Socratic questioner/);
  assert.ok(request.system[0].text.includes(CONCEPT_NAME));
  assert.ok(request.system[0].text.includes(SOURCE_TEXT), 'bounded excerpts ground the questions');
});

test('a cache write is priced at the one-hour rate the sessions actually use', async () => {
  // The spending meter is only as honest as the price table. A one-hour cache write
  // costs twice the input price; pricing it at the five-minute rate would under-report
  // every session's first turn. A write the API does not break down is priced as one hour.
  assert.equal(config.claude.pricePerMTok.cacheWrite1h, config.claude.pricePerMTok.input * 2);

  const written = okBody('A first question?');
  written.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 };
  script = [{ status: 200, body: written }];
  const { body: session } = await start();
  assert.equal(session.cost_usd, config.claude.pricePerMTok.input * 2);
});

test('a cache write is priced at the lifetime the API reports, not the one this app asks for', async () => {
  // A session started before the one-hour change keeps its saved five-minute policy and
  // replays it on every turn. The API's usage says which lifetime each written token got,
  // so the meter charges that, and never prices a five-minute write at the one-hour rate.
  const prices = config.claude.pricePerMTok;
  const written = okBody('A first question?');
  written.usage = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
  };
  script = [{ status: 200, body: written }];
  const { body: session } = await start();
  assert.equal(session.cost_usd, prices.cacheWrite);
  assert.ok(prices.cacheWrite < prices.cacheWrite1h, 'the five-minute rate is the cheaper one');
});

test('the browser is never sent the system prompt or a thinking block', async () => {
  const { body } = await start();
  const wire = JSON.stringify([body, (await get(`/api/roles/sessions/${body.session_id}?topic=${TOPIC}`)).body]);
  assert.ok(!wire.includes('opaque-'));
  assert.ok(!wire.includes('Socratic questioner. Ask'));
  assert.ok(!wire.includes(SOURCE_TEXT));
});

test('no conversational role is ever sent a deck question, a deck answer or a fact-check truth', async () => {
  for (const role of ['interviewer', 'socratic', 'sparring']) {
    const { body: session } = await start({ role, ...(role === 'sparring' ? { counterpart: 'A tough hiring manager.' } : {}) });
    await turn(session);
  }
  assert.equal(sent.length, 6, 'the control: all six requests really went out');
  for (const request of sent) {
    for (const secret of SECRETS) assert.ok(!request.raw.includes(secret), `a request carried ${secret}`);
  }
  // The missed concept is named, which is the most a role is allowed to know about a miss.
  assert.ok(sent[2].raw.includes(CONCEPT_NAME));
});

test('a turn replays the stored conversation verbatim, opaque blocks included', async () => {
  const { body: session } = await start();
  await turn(session);

  const second = sent[1].body;
  assert.deepEqual(second.system, sent[0].body.system, 'the system prompt is frozen for the session');
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[0], sent[0].body.messages[0]);
  assert.equal(second.messages[1].role, 'assistant');
  assert.equal(second.messages[1].content[0].type, 'thinking');
  assert.match(second.messages[1].content[0].signature, /^opaque-/);
  assert.deepEqual(second.messages[2], { role: 'user', content: 'Because the head starts random.' });
});

test('a replayed turn whose reply is stored sends nothing', async () => {
  const { body: session } = await start();
  const mutation = mint();
  const first = await turn(session, { mutation_id: mutation });
  assert.equal(sent.length, 2, 'the control: the first send of this turn did go out');

  const replay = await turn(session, { mutation_id: mutation });
  assert.equal(sent.length, 2, 'the replay paid for nothing');
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.reply, first.body.reply);
});

test('a turn whose model call failed is retried with exactly one call and stored once', async () => {
  const { body: session } = await start();
  const mutation = mint();
  script = [UNAVAILABLE];

  const failed = await turn(session, { mutation_id: mutation });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /Claude API/);

  sent.length = 0;
  const retried = await turn(session, { mutation_id: mutation });
  assert.equal(retried.status, 200);
  assert.equal(sent.length, 1, 'the retry owed one call and made one');

  const learnerTurns = transcript(TOPIC, session.session_id).filter((l) => l.type === 'turn' && l.role === 'user' && !l.hidden);
  assert.equal(learnerTurns.length, 1, 'the learner turn was stored once, before the failed call');
});

test('two different replies to one turn: one is answered, one is refused, one call is made', async () => {
  const { body: session } = await start();
  sent.length = 0;
  let release;
  gate = new Promise((resolve) => { release = resolve; });

  const a = turn(session, { text: 'First answer.' });
  const b = turn(session, { text: 'A different answer.' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const results = await Promise.all([a, b]);

  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(sent.length, 1);
});

test('the same turn sent twice at once is one call: the second waits for the first', async () => {
  // A double-click, or a retry fired while the first request is still in flight. The
  // second finds the learner turn on disk with no reply yet; without the per-session
  // queue it would conclude a call is owed and pay for a second one.
  const { body: session } = await start();
  sent.length = 0;
  let release;
  gate = new Promise((resolve) => { release = resolve; });

  const mutation = mint();
  const a = turn(session, { mutation_id: mutation });
  const b = turn(session, { mutation_id: mutation });
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const results = await Promise.all([a, b]);

  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(sent.length, 1);
  assert.deepEqual(results[0].body.reply, results[1].body.reply);
});

test('a new turn is refused while the previous one still waits for its reply', async () => {
  const { body: session } = await start();
  script = [UNAVAILABLE];
  assert.equal((await turn(session)).status, 503);

  const other = await turn(session, { text: 'Something else entirely.' });
  assert.equal(other.status, 409);
  assert.match(other.body.error, /still waiting/);
});

test('reading a session back restores the conversation, so a reload continues it', async () => {
  const { body: session } = await start();
  await turn(session);
  const { body: restored } = await get(`/api/roles/sessions/${session.session_id}?topic=${TOPIC}`);

  assert.deepEqual(restored.turns.map((t) => t.role), ['counterpart', 'learner', 'counterpart']);
  assert.equal(restored.next_index, 4);
  const next = await turn(restored);
  assert.equal(next.status, 200);
});

test('with the Claude API down, generating routes say so and local routes keep working', async () => {
  const { body: session } = await start({ role: 'interviewer', concept_slug: null });
  const down = () => { script = [UNAVAILABLE]; };

  down();
  const started = await start();
  assert.equal(started.status, 503);
  assert.match(started.body.error, /Claude API/);
  down();
  assert.equal((await turn(session)).status, 503);

  script = [];
  assert.equal((await get(`/api/roles/sessions?topic=${TOPIC}`)).status, 200);
  assert.equal((await get(`/api/roles/sessions/${session.session_id}?topic=${TOPIC}`)).status, 200);
  assert.equal((await get('/api/state')).status, 200);
  sent.length = 0;
  assert.equal((await close(session)).status, 200);
  assert.equal(sent.length, 0, 'closing needs no provider');
});

test('with Open Notebook down a session still starts, without excerpts, and says so', async () => {
  onDown = true;
  const { status, body } = await start();
  assert.equal(status, 201);
  assert.equal(body.excerpts, 'unavailable');
  assert.ok(!sent[0].body.system[0].text.includes(SOURCE_TEXT));
  assert.ok(!sent[0].body.system[0].text.includes('Source excerpts'));
});

test('a start that failed at the model is finished by a retry, not duplicated', async () => {
  const mutation = mint();
  const before = sessionEvents(TOPIC).filter((e) => e.event === 'session_started').length;
  script = [UNAVAILABLE];
  assert.equal((await start({ mutation_id: mutation })).status, 503);

  const retried = await start({ mutation_id: mutation });
  assert.equal(retried.status, 201);
  assert.equal(sessionEvents(TOPIC).filter((e) => e.event === 'session_started').length, before + 1);
});

test('an interview runs on a topic with no concepts, and its summary feeds the next session', async () => {
  const { status, body: session } = await start({ topic_slug: EMPTY_TOPIC, role: 'interviewer', concept_slug: null });
  assert.equal(status, 201);

  script = [{ status: 200, body: okBody('Goal: pass the interview. Level: not stated.') }];
  const draft = await post(`/api/roles/sessions/${session.session_id}/summary`, { topic_slug: EMPTY_TOPIC, mutation_id: mint() });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.reply.kind, 'summary_draft');

  const confirmed = 'ZZ-CONFIRMED-SUMMARY goal: pass a timed interview in three weeks.';
  const closed = await close(session, { topic_slug: EMPTY_TOPIC, summary: confirmed });
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.summary, confirmed);

  sent.length = 0;
  await start({ topic_slug: EMPTY_TOPIC, role: 'interviewer', concept_slug: null });
  assert.ok(sent[0].body.system[0].text.includes(confirmed));

  const revised = 'ZZ-REVISED-SUMMARY goal: pass it in two weeks.';
  await post('/api/roles/summaries', { topic_slug: EMPTY_TOPIC, summary: revised, mutation_id: mint() });
  sent.length = 0;
  await start({ topic_slug: EMPTY_TOPIC, role: 'interviewer', concept_slug: null });
  assert.ok(sent[0].body.system[0].text.includes(revised));
  assert.ok(!sent[0].body.system[0].text.includes(confirmed));
});

test('closing records an outcome with usage and cost, and a transcript is not the committed record', async () => {
  const { body: session } = await start();
  await turn(session);
  const { body: closed } = await close(session);

  assert.equal(closed.turn_count, 1);
  assert.equal(closed.usage.input_tokens, 2000);
  assert.equal(closed.cost_usd, (2000 * 4 + 200 * 20) / 1_000_000);

  const committed = readFileSync(join(topicDir, 'cockpit', 'sessions.jsonl'), 'utf8');
  assert.ok(!committed.includes('Because the head starts random.'), 'the learner\'s words are not in the committed file');
  assert.ok(!committed.includes('opaque-'));
  assert.ok(existsSync(transcriptPath(TOPIC, session.session_id)));

  const again = await turn({ ...session, next_index: 4 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /closed/);
});

test('the turn limit stops a further turn and names itself; closing still works', async () => {
  const { body: session } = await start();
  let current = session;
  for (let i = 0; i < ROLE_LIMITS.maxTurns; i += 1) {
    const { status, body } = await turn(current);
    assert.equal(status, 200);
    current = body.session;
  }
  assert.equal(current.limits.reached, 'turns');

  sent.length = 0;
  const over = await turn(current);
  assert.equal(over.status, 409);
  assert.match(over.body.error, new RegExp(`limit of ${ROLE_LIMITS.maxTurns} turns`));
  assert.equal(sent.length, 0);
  assert.equal((await close(current)).status, 200);
});

test('the spending limit stops a further turn and names itself', async () => {
  const { body: session } = await start();
  // One reply priced past the whole session budget.
  const costly = okBody('An expensive question?');
  costly.usage.output_tokens = Math.ceil((ROLE_LIMITS.sessionSpendUsd / config.claude.pricePerMTok.output) * 1_000_000);
  script = [{ status: 200, body: costly }];
  const { body } = await turn(session);
  assert.equal(body.session.limits.reached, 'spend');

  sent.length = 0;
  const over = await turn(body.session);
  assert.equal(over.status, 409);
  assert.match(over.body.error, /spending limit/);
  assert.equal(sent.length, 0);
});

test('closing while a turn is in flight waits for it, so the recorded cost includes that reply', async () => {
  const { body: session } = await start();
  let release;
  gate = new Promise((resolve) => { release = resolve; });

  const pending = turn(session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closing = close(session);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [turned, closed] = await Promise.all([pending, closing]);

  assert.equal(turned.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.turn_count, 1);
  assert.equal(closed.body.usage.input_tokens, 2000, 'the opening and the in-flight reply are both counted');
});

test('a retry after the session is closed makes no paid call', async () => {
  const { body: session } = await start();
  const mutation = mint();
  script = [UNAVAILABLE];
  assert.equal((await turn(session, { mutation_id: mutation })).status, 503);
  assert.equal((await close(session)).status, 200);

  sent.length = 0;
  const retried = await turn(session, { mutation_id: mutation });
  assert.equal(retried.status, 409);
  assert.match(retried.body.error, /closed/);
  assert.equal(sent.length, 0);
});

test('a turn whose reply is stored can still be replayed after the session is closed', async () => {
  const { body: session } = await start();
  const mutation = mint();
  const first = await turn(session, { mutation_id: mutation });
  await close(session);

  sent.length = 0;
  const replay = await turn(session, { mutation_id: mutation });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.reply, first.body.reply);
  assert.equal(sent.length, 0);
});

test('a summary draft is bound by the spending limit like any other turn', async () => {
  const { body: session } = await start({ role: 'interviewer', concept_slug: null });
  const costly = okBody('An expensive question?');
  costly.usage.output_tokens = Math.ceil((ROLE_LIMITS.sessionSpendUsd / config.claude.pricePerMTok.output) * 1_000_000);
  script = [{ status: 200, body: costly }];
  await turn(session);

  sent.length = 0;
  const draft = await post(`/api/roles/sessions/${session.session_id}/summary`, { topic_slug: TOPIC, mutation_id: mint() });
  assert.equal(draft.status, 409);
  assert.match(draft.body.error, /spending limit/);
  assert.equal(sent.length, 0);

  // Closing with a summary the learner wrote by hand still works at the limit.
  const closed = await close(session, { summary: 'Goal: written by hand at the limit.' });
  assert.equal(closed.body.summary, 'Goal: written by hand at the limit.');
});

test('a paid reply with no text is still counted, and cannot be retried past the spending limit', async () => {
  // The model can spend its whole output on thinking and return no text. That response
  // was billed. Discarding it would let a retry loop spend without the limit ever moving.
  const { body: session } = await start();
  const empty = okBody('');
  empty.stop_reason = 'max_tokens';
  empty.content = [{ type: 'thinking', thinking: '', signature: 'opaque-empty' }];
  empty.usage.output_tokens = Math.ceil((ROLE_LIMITS.sessionSpendUsd / config.claude.pricePerMTok.output) * 1_000_000);
  script = [{ status: 200, body: empty }];

  const mutation = mint();
  const failed = await turn(session, { mutation_id: mutation });
  assert.equal(failed.status, 502);

  const { body: after1 } = await get(`/api/roles/sessions/${session.session_id}?topic=${TOPIC}`);
  assert.ok(after1.cost_usd >= ROLE_LIMITS.sessionSpendUsd, 'the unusable reply was charged to the session');
  assert.equal(after1.limits.reached, 'spend');

  sent.length = 0;
  const retried = await turn(session, { mutation_id: mutation });
  assert.equal(retried.status, 409);
  assert.match(retried.body.error, /spending limit/);
  assert.equal(sent.length, 0);

  const { body: closed } = await close(session);
  assert.ok(closed.cost_usd >= ROLE_LIMITS.sessionSpendUsd, 'the committed outcome carries the charge too');
});

test('an unanswered turn survives a reload: the session says what to resend, and resending works', async () => {
  // The browser keeps a turn's mutation id in memory only. After a reload it has to be
  // told the id, or it can never finish the turn it left waiting.
  const { body: session } = await start();
  const mutation = mint();
  script = [UNAVAILABLE];
  await turn(session, { mutation_id: mutation, text: 'An answer left waiting.' });

  const { body: reloaded } = await get(`/api/roles/sessions/${session.session_id}?topic=${TOPIC}`);
  assert.deepEqual(reloaded.pending, { mutation_id: mutation, index: session.next_index, kind: 'turn', text: 'An answer left waiting.' });

  sent.length = 0;
  const resent = await turn(session, { mutation_id: reloaded.pending.mutation_id, index: reloaded.pending.index, text: reloaded.pending.text });
  assert.equal(resent.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(resent.body.session.pending, null);
});

test('resume finishes whatever is waiting — an opening, a turn or a summary — and buys nothing twice', async () => {
  const resume = (id) => post(`/api/roles/sessions/${id}/resume`, { topic_slug: TOPIC });
  const reload = async (id) => (await get(`/api/roles/sessions/${id}?topic=${TOPIC}`)).body;

  // An opening that failed. The start's own mutation id is gone after a reload, and the
  // session would otherwise sit open and unusable for good.
  const before = new Set(sessionEvents(TOPIC).filter((e) => e.event === 'session_started').map((e) => e.session_id));
  script = [UNAVAILABLE];
  assert.equal((await start({ role: 'interviewer', concept_slug: null })).status, 503);
  const stranded = sessionEvents(TOPIC).find((e) => e.event === 'session_started' && !before.has(e.session_id));
  assert.equal((await reload(stranded.session_id)).pending.kind, 'opening');

  sent.length = 0;
  const opened = await resume(stranded.session_id);
  assert.equal(opened.status, 200);
  assert.equal(sent.length, 1, 'the control: resuming an owed reply does call the model');
  assert.equal(opened.body.pending, null);
  assert.equal(opened.body.turns.length, 1);

  // Nothing waiting: resume is a read.
  sent.length = 0;
  assert.equal((await resume(stranded.session_id)).status, 200);
  assert.equal(sent.length, 0);

  // A turn that failed.
  script = [UNAVAILABLE];
  await turn(opened.body);
  sent.length = 0;
  const answered = await resume(stranded.session_id);
  assert.equal(sent.length, 1);
  assert.deepEqual(answered.body.turns.map((t) => t.role), ['counterpart', 'learner', 'counterpart']);

  // A summary request that failed.
  script = [UNAVAILABLE];
  await post(`/api/roles/sessions/${stranded.session_id}/summary`, { topic_slug: TOPIC, mutation_id: mint() });
  sent.length = 0;
  const drafted = await resume(stranded.session_id);
  assert.equal(sent.length, 1);
  assert.equal(drafted.body.turns.at(-1).kind, 'summary_draft');

  // Closed: nothing more is bought.
  const { body: live } = await start();
  script = [UNAVAILABLE];
  await turn(live);
  await close(live);
  sent.length = 0;
  const closed = await resume(live.session_id);
  assert.equal(closed.status, 409);
  assert.equal(sent.length, 0);
});

test('an unanswered summary request can be resumed the same way', async () => {
  const { body: session } = await start({ role: 'interviewer', concept_slug: null });
  const mutation = mint();
  script = [UNAVAILABLE];
  const failed = await post(`/api/roles/sessions/${session.session_id}/summary`, { topic_slug: TOPIC, mutation_id: mutation });
  assert.equal(failed.status, 503);

  const { body: reloaded } = await get(`/api/roles/sessions/${session.session_id}?topic=${TOPIC}`);
  assert.equal(reloaded.pending.kind, 'summary_request');
  assert.equal(reloaded.pending.mutation_id, mutation);
  assert.equal('text' in reloaded.pending, false, 'the fixed request text is the server\'s, not the learner\'s');

  const resumed = await post(`/api/roles/sessions/${session.session_id}/summary`, { topic_slug: TOPIC, mutation_id: reloaded.pending.mutation_id });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.reply.kind, 'summary_draft');
});

test('a refused turn is shown as unanswered and the session carries on without it', async () => {
  const { body: session } = await start();
  script = [{ status: 200, body: { ...okBody(''), stop_reason: 'refusal', content: [] } }];
  const refused = await turn(session);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.reply.refusal, true);

  const next = await turn(refused.body.session);
  assert.equal(next.status, 200);
  assert.ok(sent.at(-1).body.messages.every((m) => m.role === 'user' || m.content.length > 0), 'an empty assistant turn is never replayed');
});

test('sparring needs a counterpart, records a self-reported timer, and expiry locks nothing', async () => {
  assert.equal((await start({ role: 'sparring' })).status, 400);

  const { body: session } = await start({ role: 'sparring', counterpart: 'A tough hiring manager for a data role.', timer_seconds: 30 });
  assert.ok(sent.at(-1).body.system[0].text.includes('A tough hiring manager for a data role.'));

  const late = await turn(session, { timing: { elapsed_ms: 45_000, tab_hidden: true } });
  assert.equal(late.status, 200, 'an answer after the timer is still accepted');
  const stored = late.body.session.turns.find((t) => t.role === 'learner');
  assert.deepEqual(stored.timing, { elapsed_ms: 45_000, tab_hidden: true, over_time: true, self_reported: true });
});

test('stumbles become cards the learner wrote, once, without touching Open Notebook', async () => {
  const { body: session } = await start();
  const { body: after1 } = await turn(session);
  const learnerIndex = after1.session.turns.find((t) => t.role === 'learner').index;
  const cards = [{ turn_index: learnerIndex, front: 'Why freeze the body first?', back: 'So the random head cannot wreck good features.' }];

  const early = await post(`/api/roles/sessions/${session.session_id}/cards`, { topic_slug: TOPIC, cards, mutation_id: mint() });
  assert.equal(early.status, 409, 'cards come from a closed session');

  await close(session);
  onSent.length = 0;
  sent.length = 0;
  const made = await post(`/api/roles/sessions/${session.session_id}/cards`, { topic_slug: TOPIC, cards, mutation_id: mint() });
  assert.equal(made.status, 200);
  assert.equal(made.body.created.length, 1);
  assert.equal(made.body.created[0].source, 'session');
  assert.equal(made.body.created[0].source_ref, `session:${session.session_id}:${learnerIndex}`);
  assert.equal(made.body.created[0].concept_slug, CONCEPT);

  const again = await post(`/api/roles/sessions/${session.session_id}/cards`, { topic_slug: TOPIC, cards, mutation_id: mint() });
  assert.equal(again.body.created.length, 0, 'a second request makes no second card');
  assert.deepEqual(onSent, [], 'Open Notebook is read-only for sessions');
  assert.equal(sent.length, 0, 'no model drafts a card');

  const bad = await post(`/api/roles/sessions/${session.session_id}/cards`, {
    topic_slug: TOPIC, cards: [{ turn_index: 1, front: 'x', back: 'y' }], mutation_id: mint(),
  });
  assert.equal(bad.status, 400, 'a counterpart turn is not a stumble');
});

/** A closed Socratic session with one learner turn, ready for cards. */
async function closedSessionWithOneTurn() {
  const { body: session } = await start();
  const { body } = await turn(session, { text: 'To save memory.' });
  await close(session);
  const learner = body.session.turns.find((t) => t.role === 'learner');
  const asked = body.session.turns.find((t) => t.role === 'counterpart');
  return { session, learnerIndex: learner.index, question: asked.text };
}
const draft = (session, turnIndex) => post(`/api/roles/sessions/${session.session_id}/card-draft`, { topic_slug: TOPIC, turn_index: turnIndex });

test('a card draft comes from the LOCAL model: the question and the stumble go there, and nothing is spent', async () => {
  const { session, learnerIndex, question } = await closedSessionWithOneTurn();
  sent.length = 0;

  const { status, body } = await draft(session, learnerIndex);
  assert.equal(status, 200);
  assert.equal(body.back, 'A drafted answer from the local model.');
  assert.equal(body.origin, 'ai_draft');

  assert.equal(localSent.length, 1, 'the control: the local model was asked');
  assert.equal(localSent[0].path, '/api/chat');
  assert.ok(localSent[0].raw.includes(question), 'the question the turn answered is sent');
  assert.ok(localSent[0].raw.includes('To save memory.'), 'what the learner said is sent');
  assert.ok(localSent[0].raw.includes(SOURCE_TEXT), 'the draft is grounded in the source excerpts');
  // Measured 2026-11-08 on gemma4:31b-mlx: thinking took a draft from 18 s to 130 s, and past
  // the 5-minute timeout when the model was busy. A 1-3 sentence answer does not need it.
  assert.equal(JSON.parse(localSent[0].raw).think, false, 'a draft asks the model not to think first');
  for (const secret of SECRETS) assert.ok(!localSent[0].raw.includes(secret), `the draft request carried ${secret}`);

  // A closed session buys nothing: the paid API is not called for a draft.
  assert.equal(sent.length, 0);
});

test('a draft is not a card: nothing is stored until the learner creates it', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();
  const cardsFile = join(topicDir, 'cockpit', 'cards.json');
  const before = existsSync(cardsFile) ? readFileSync(cardsFile, 'utf8') : null;
  const eventsBefore = sessionEvents(TOPIC).length;

  // The control: a route that 404'd would also store nothing.
  assert.equal((await draft(session, learnerIndex)).status, 200);
  assert.equal(existsSync(cardsFile) ? readFileSync(cardsFile, 'utf8') : null, before);
  assert.equal(sessionEvents(TOPIC).length, eventsBefore);
});

test('a draft the local model garbles is a 502, never a made-up answer', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();
  for (const content of ['I would say the answer is about features.', '```json\n{"back": ""}\n```', '{"answer":"wrong key"}']) {
    localContent = content;
    const { status, body } = await draft(session, learnerIndex);
    assert.equal(status, 502, content);
    assert.match(body.error, /draft/);
  }
});

test('with the local model down a draft says so, and the card can still be written by hand', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();
  localStatus = 500;
  const down = await draft(session, learnerIndex);
  assert.equal(down.status, 503);
  assert.match(down.body.error, /local model/i);
  // The grading fallback is the wrong advice here, and it points at the paid API a draft avoids.
  assert.doesNotMatch(down.body.error, /grade|Claude/i);
  assert.match(down.body.error, /write the answer yourself/i);

  const made = await post(`/api/roles/sessions/${session.session_id}/cards`, {
    topic_slug: TOPIC, mutation_id: mint(),
    cards: [{ turn_index: learnerIndex, front: 'Why freeze the body?', back: 'Written by hand.' }],
  });
  assert.equal(made.status, 200);
  assert.equal(made.body.created[0].back_origin, 'learner');
});

test('a draft is only for a learner turn in a closed Socratic or sparring session', async () => {
  const { body: open } = await start();
  const { body: mid } = await turn(open);
  const openLearner = mid.session.turns.find((t) => t.role === 'learner').index;
  assert.equal((await draft(open, openLearner)).status, 409, 'an open session');

  const { session } = await closedSessionWithOneTurn();
  assert.equal((await draft(session, 1)).status, 400, 'a counterpart turn');
  assert.equal((await draft(session, 99)).status, 400, 'a turn that does not exist');

  const { body: interview } = await start({ role: 'interviewer', concept_slug: null });
  await close(interview);
  assert.equal((await draft(interview, 2)).status, 400, 'an interview');
  assert.equal(localSent.length, 0, 'none of these reached the model');
});

test('a card records whether its answer was the learner\'s, an AI draft, or an AI draft they edited', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();
  const make = (origin) => post(`/api/roles/sessions/${session.session_id}/cards`, {
    topic_slug: TOPIC, mutation_id: mint(),
    cards: [{ turn_index: learnerIndex, front: 'Why freeze the body?', back: 'An answer.', ...(origin ? { back_origin: origin } : {}) }],
  });

  assert.equal((await make('made_up')).status, 400);
  const made = await make('ai_draft_edited');
  assert.equal(made.body.created[0].back_origin, 'ai_draft_edited');

  const stored = JSON.parse(readFileSync(join(topicDir, 'cockpit', 'cards.json'), 'utf8')).find((c) => c.id === made.body.created[0].id);
  assert.equal(stored.back_origin, 'ai_draft_edited');
});

test('a draft says whether your sources went into it, and an outage is never passed off as grounded', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();

  const grounded = await draft(session, learnerIndex);
  assert.equal(grounded.status, 200);
  assert.equal(grounded.body.grounded, true);
  assert.equal(grounded.body.ungrounded_reason, null);

  // Open Notebook only grounds a draft; the local model can still answer without it.
  onDown = true;
  const bare = await draft(session, learnerIndex);
  assert.equal(bare.status, 200);
  assert.equal(bare.body.grounded, false);
  assert.equal(bare.body.ungrounded_reason, 'unreachable');
  assert.ok(!localSent.at(-1).raw.includes(SOURCE_TEXT), 'the control: no excerpt went into the ungrounded draft');
});

test('an empty notebook is not an outage: the draft says the notebook has no sources', async () => {
  const { session, learnerIndex } = await closedSessionWithOneTurn();
  onEmpty = true;
  const { status, body } = await draft(session, learnerIndex);
  assert.equal(status, 200);
  assert.equal(body.grounded, false);
  assert.equal(body.ungrounded_reason, 'no_sources');
});

test('a draft answers the front the learner edited, not the transcript question', async () => {
  const { session, learnerIndex, question } = await closedSessionWithOneTurn();
  const edited = 'What is the difference between freezing and fine-tuning?';
  const { status, body } = await post(`/api/roles/sessions/${session.session_id}/card-draft`, {
    topic_slug: TOPIC, turn_index: learnerIndex, front: edited,
  });
  assert.equal(status, 200);
  assert.equal(body.front, edited);
  assert.ok(localSent.at(-1).raw.includes(edited), 'the edited front is the question drafted against');
  assert.ok(!localSent.at(-1).raw.includes(question), 'the transcript question is not');

  const cleared = await post(`/api/roles/sessions/${session.session_id}/card-draft`, { topic_slug: TOPIC, turn_index: learnerIndex, front: '   ' });
  assert.equal(cleared.body.front, question, 'a cleared front falls back to the question the turn answered');

  const wrongType = await post(`/api/roles/sessions/${session.session_id}/card-draft`, { topic_slug: TOPIC, turn_index: learnerIndex, front: 7 });
  assert.equal(wrongType.status, 400, 'a front that is not a string is refused');
});

test('a session id that is not a UUID never reaches the filesystem', async () => {
  for (const id of ['..%2F..%2Fstate', 'not-a-uuid', '00000000-0000-4000-8000-00000000000g']) {
    const res = await get(`/api/roles/sessions/${id}?topic=${TOPIC}`);
    assert.ok([400, 403, 404].includes(res.status), `${id} → ${res.status}`);
  }
  const unknown = await get(`/api/roles/sessions/00000000-0000-4000-8000-000000000000?topic=${TOPIC}`);
  assert.equal(unknown.status, 404);
});

test('the new routes hold the browser boundary: no cross-origin write, no CORS header', async () => {
  const res = await fetch(`${BASE}/api/roles/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ topic_slug: TOPIC, role: 'socratic', mutation_id: mint() }),
  });
  assert.equal(res.status, 403);

  const form = await fetch(`${BASE}/api/roles/sessions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);

  for (const path of ['/api/roles/health', `/api/roles/sessions?topic=${TOPIC}`]) {
    const ok = await fetch(`${BASE}${path}`);
    for (const [name] of ok.headers) assert.ok(!name.startsWith('access-control-'), `${path} sent ${name}`);
  }
});

test('sessions change no mastery and complete no stage', () => {
  assert.deepEqual(readFileSync(join(topicDir, 'state.json')), STATE_BEFORE);
  assert.equal(existsSync(join(topicDir, 'cockpit', 'stages.jsonl')), false);
});
