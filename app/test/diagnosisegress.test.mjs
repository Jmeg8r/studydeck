// WHAT: What a diagnosis sends to the Claude API, what it leaves out, and what it records.
// WHY:  The Diagnostician is the one role allowed to send a stored answer, and only for a
//       question the learner has already attempted and had revealed (AGENTS.md rule 7).
//       So the interesting assertions are about what is NOT in the request: a pending
//       attempt, a question from a deck edited since the attempt, and above all the
//       answer to a question never attempted.
//
//       The second half is what comes back. A model can cite evidence it was never given,
//       or answer in prose. A finding is kept only if every attempt it cites was sent, and
//       a reply that cannot be parsed records nothing — a made-up diagnosis written to
//       append-only history cannot be taken back.
//
// SAME RULE AS the other *egress files: nothing here asserts the SHAPE of a Claude
// response. The stub is a recorder, and what it serves is chosen to be adversarial. If the
// Messages API envelope moves, this file keeps passing and the real call breaks.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-diagnosis-egress-'));
const FAKE_KEY = 'diagnosis-egress-test-key-never-real';
const CONCEPT = 'diagnosis-fixture-concept';

// What may be sent: a missed question from a final attempt, with its answer.
const Q1_PROMPT = 'ZZ-Q1-PROMPT-why-freeze-the-body';
const Q1_ANSWER = 'ZZ-Q1-ANSWER-to-protect-features';
const Q1_RESPONSE = 'ZZ-Q1-RESPONSE-to-save-memory';
const Q2_PROMPT = 'ZZ-Q2-PROMPT-what-is-a-learning-rate';
// What may not: never attempted, still pending, or from a deck edited since.
const UNATTEMPTED_ANSWER = 'ZZ-UNATTEMPTED-ANSWER-never-revealed';
const PENDING_PROMPT = 'ZZ-PENDING-PROMPT-awaiting-self-grade';
const CHANGED_PROMPT = 'ZZ-CHANGED-PROMPT-edited-after-the-attempt';

const deckA = {
  concept_slug: CONCEPT, concept_name: 'Diagnosis Fixture Concept',
  questions: [
    { id: 'q1', type: 'short_answer', gradeable: 'accepted', prompt: Q1_PROMPT, answer: Q1_ANSWER, explanation: 'because the head is random' },
    { id: 'q2', type: 'short_answer', gradeable: 'accepted', prompt: Q2_PROMPT, answer: 'step size', explanation: 'it scales the update' },
    { id: 'q3', type: 'short_answer', gradeable: 'ai_only', prompt: PENDING_PROMPT, answer: 'pending answer', explanation: '' },
    { id: 'q9', type: 'short_answer', gradeable: 'accepted', prompt: 'a question nobody has attempted', answer: UNATTEMPTED_ANSWER, explanation: '' },
  ],
};
const deckB = {
  concept_slug: CONCEPT, concept_name: 'Diagnosis Fixture Concept',
  questions: [{ id: 'q1', type: 'short_answer', gradeable: 'accepted', prompt: CHANGED_PROMPT, answer: 'changed', explanation: '' }],
};
// The same recipe evidence.mjs uses when it freezes an attempt.
const hashOf = (deck) => createHash('sha256').update(JSON.stringify(deck)).digest('hex');

const attempt = (id, fields) => ({
  ts: `2026-10-0${id}T10:00:00.000Z`, kind: 'quiz', attempt_id: `attempt-${id}`, mutation_id: `fixture-attempt-${id}`,
  revision: 0, concept_slug: CONCEPT, score: 0, max: 1, status: 'final', ...fields,
});
const ATTEMPTS = [
  attempt(1, { deck_file: 'deck-a.json', misses: ['q1', 'q2'], responses: { q1: Q1_RESPONSE, q2: 'momentum' }, retrieval_evidence: { assessment_version: hashOf(deckA) } }),
  attempt(2, { deck_file: 'deck-a.json', misses: ['q1'], responses: { q1: Q1_RESPONSE }, retrieval_evidence: { assessment_version: hashOf(deckA) } }),
  attempt(3, { deck_file: 'deck-a.json', misses: ['q3'], responses: { q3: 'unsure' }, status: 'pending_self_grade', retrieval_evidence: { assessment_version: hashOf(deckA) } }),
  attempt(4, { deck_file: 'deck-b.json', misses: ['q1'], responses: { q1: 'x' }, retrieval_evidence: { assessment_version: 'a-hash-from-before-the-edit' } }),
  attempt(5, { deck_file: 'deck-a.json', misses: ['q2'], responses: { q2: 'momentum' } }),
  attempt(6, { deck_file: 'deck-gone.json', misses: ['q1'], responses: { q1: 'x' }, retrieval_evidence: { assessment_version: 'whatever' } }),
];

const sent = [];
let script = [];
const fenced = (obj) => `Here is the diagnosis:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
const message = (text, extra = {}) => ({
  type: 'message', model: 'stub-model', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'text', text }],
  usage: { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...extra,
});
const GOOD = {
  result: 'findings',
  findings: [{
    misunderstanding: 'Treats freezing as a memory optimisation.',
    explanation: 'Both answers frame it as cost, not as protecting learned features.',
    suggested_repair: 'Explain what a random head does to pretrained weights in the first epoch.',
    support: [{ attempt_id: 'attempt-1', question_id: 'q1' }, { attempt_id: 'attempt-2', question_id: 'q1' }, { attempt_id: 'attempt-1', question_id: 'q2' }],
  }],
};

const stub = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  sent.push({ body: raw ? JSON.parse(raw) : null, raw });
  const next = script.shift() ?? { status: 200, body: message(fenced(GOOD)) };
  res.writeHead(next.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(next.body));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));

// A dead Open Notebook: a diagnosis reads no sources, and this proves it does not try.
const deadOn = createServer();
deadOn.on('connection', (socket) => socket.destroy());
await new Promise((resolve) => deadOn.listen(0, '127.0.0.1', resolve));

process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_CLAUDE_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.STUDYDECK_ANTHROPIC_API_KEY = FAKE_KEY;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${deadOn.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'fixture-password';

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
const { resetFallbackState } = await import('../lib/claude.mjs');
const { ROLE_LIMITS } = await import('../lib/roles.mjs');

assert.equal(config.claude.baseUrl, process.env.STUDYDECK_CLAUDE_BASE_URL, 'not talking to the recorder');

const TOPIC = config.topics[0].slug;
const EMPTY_TOPIC = config.topics[1].slug;

for (const topic of config.topics) {
  const dir = join(FIXTURE_ROOT, topic.slug);
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, slug: topic.slug, topic: `Fixture ${topic.slug}`, created: '2026-10-11', last_updated: null,
    domains: [{ slug: 'fixture-domain', name: 'Fixture Domain', concepts: [{
      name: 'Diagnosis Fixture Concept', slug: CONCEPT, status: 'unexplored', confidence: 0, practice_count: 0,
      explain_count: 0, last_explained: null, last_practiced: null, details: ['a detail'],
    }] }],
  }));
}
const topicDir = join(FIXTURE_ROOT, TOPIC);
mkdirSync(join(topicDir, 'quizzes', CONCEPT), { recursive: true });
writeFileSync(join(topicDir, 'quizzes', CONCEPT, 'deck-a.json'), JSON.stringify(deckA));
writeFileSync(join(topicDir, 'quizzes', CONCEPT, 'deck-b.json'), JSON.stringify(deckB));
writeFileSync(join(topicDir, 'cockpit', 'attempts.jsonl'), `${ATTEMPTS.map((a) => JSON.stringify(a)).join('\n')}\n`);

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  stub.close();
  deadOn.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  script = [];
  resetFallbackState();
});

let counter = 0;
const mint = () => `diag-mut-${counter += 1}-xxxxxxxx`;
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const diagnose = (overrides = {}) => post('/api/roles/diagnoses', { topic_slug: TOPIC, mutation_id: mint(), ...overrides });
const listed = async (topic = TOPIC) => (await (await fetch(`${BASE}/api/roles/diagnoses?topic=${topic}`)).json());
const diagnosesFile = join(topicDir, 'cockpit', 'diagnoses.jsonl');
const recorded = () => (existsSync(diagnosesFile) ? readFileSync(diagnosesFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('a diagnosis sends final-attempt misses with their answers, and nothing it has no right to', async () => {
  const { status, body } = await diagnose();
  assert.equal(status, 201);
  assert.equal(sent.length, 1);
  const { raw, body: request } = sent[0];

  assert.equal(request.model, config.claude.model);
  assert.deepEqual(request.output_config, { effort: config.claude.effort.diagnostician });
  assert.equal(request.max_tokens, ROLE_LIMITS.diagnosisMaxTokens);

  for (const allowed of [Q1_PROMPT, Q1_ANSWER, Q1_RESPONSE, Q2_PROMPT, 'attempt-1', 'attempt-2']) {
    assert.ok(raw.includes(allowed), `the request should carry ${allowed}`);
  }
  assert.ok(!raw.includes(UNATTEMPTED_ANSWER), 'the answer to a question never attempted was sent');
  assert.ok(!raw.includes(PENDING_PROMPT), 'a pending attempt was sent');
  assert.ok(!raw.includes(CHANGED_PROMPT), 'a question from a deck edited since the attempt was sent');
  assert.ok(!raw.includes('attempt-5'), 'an attempt with no recorded deck hash was sent');

  assert.deepEqual(body.evidence, {
    misses_sent: 3,
    distinct_questions: 2,
    left_out: { pending: 1, deck_changed: 1, deck_missing: 1, no_deck_hash: 1, over_limit: 0 },
  });
});

test('a topic with no eligible misses is answered without a request', async () => {
  const empty = await diagnose({ topic_slug: EMPTY_TOPIC });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.result, 'no_evidence');
  assert.equal(sent.length, 0);

  // The control: the same route does send when there is something to send.
  await diagnose();
  assert.equal(sent.length, 1);
});

test('repeated misses of one question are one piece of support', async () => {
  const { body } = await diagnose();
  const [finding] = body.findings;
  assert.equal(finding.support.length, 3);
  assert.equal(finding.distinct_questions, 2, 'q1 was missed twice and still counts once');
  assert.equal(finding.single_question, false);
  assert.equal(finding.state, 'open');
});

test('a finding resting on one question is labelled as such', async () => {
  script = [{ status: 200, body: message(fenced({ result: 'findings', findings: [{ ...GOOD.findings[0], support: [{ attempt_id: 'attempt-1', question_id: 'q1' }, { attempt_id: 'attempt-2', question_id: 'q1' }] }] })) }];
  const { body } = await diagnose();
  assert.equal(body.findings[0].single_question, true);
});

test('a finding that cites evidence it was not given is dropped and counted', async () => {
  script = [{ status: 200, body: message(fenced({
    result: 'findings',
    findings: [
      GOOD.findings[0],
      { misunderstanding: 'Invented.', explanation: 'Cites a pending attempt.', suggested_repair: 'n/a', support: [{ attempt_id: 'attempt-3', question_id: 'q3' }] },
      { misunderstanding: 'Also invented.', explanation: 'Cites nothing real.', suggested_repair: 'n/a', support: [{ attempt_id: 'attempt-99', question_id: 'q1' }] },
      { misunderstanding: 'Half real.', explanation: 'One real citation, one not.', suggested_repair: 'n/a', support: [{ attempt_id: 'attempt-1', question_id: 'q2' }, { attempt_id: 'attempt-99', question_id: 'q7' }] },
    ],
  })) }];
  const { body } = await diagnose();
  assert.equal(body.findings.length, 2);
  assert.equal(body.dropped_findings, 2);
  assert.deepEqual(body.findings[1].support, [{ attempt_id: 'attempt-1', question_id: 'q2' }], 'an uncited part of a real finding is trimmed');
});

test('findings that all cite nothing real leave "not enough evidence", not an empty success', async () => {
  script = [{ status: 200, body: message(fenced({ result: 'findings', findings: [{ misunderstanding: 'x', explanation: 'y', suggested_repair: 'z', support: [{ attempt_id: 'nope', question_id: 'q1' }] }] })) }];
  const { body } = await diagnose();
  assert.equal(body.result, 'insufficient_evidence');
  assert.equal(body.findings.length, 0);
  assert.equal(body.dropped_findings, 1);
});

test('"no shared pattern" and "not enough evidence" are results, and are stored', async () => {
  for (const result of ['no_shared_pattern', 'insufficient_evidence']) {
    script = [{ status: 200, body: message(fenced({ result, findings: [] })) }];
    const { status, body } = await diagnose();
    assert.equal(status, 201);
    assert.equal(body.result, result);
  }
  const { diagnoses } = await listed();
  assert.ok(diagnoses.some((d) => d.result === 'no_shared_pattern'));
});

test('a reply that cannot be parsed is a 502 and records nothing', async () => {
  const before = recorded();
  for (const text of ['I think you misunderstand freezing.', '```json\n{"result": "findings", "findings": "many"}\n```', '{"result":"a_new_kind","findings":[]}']) {
    script = [{ status: 200, body: message(text) }];
    const { status, body } = await diagnose();
    assert.equal(status, 502, text);
    assert.match(body.error, /diagnosis/);
  }
  assert.equal(recorded(), before);
});

test('a refused request records nothing', async () => {
  const before = recorded();
  script = [{ status: 200, body: message('', { stop_reason: 'refusal', content: [] }) }];
  assert.equal((await diagnose()).status, 502);
  assert.equal(recorded(), before);
});

test('a replayed diagnosis returns the stored one and sends nothing', async () => {
  const mutation = mint();
  const first = await diagnose({ mutation_id: mutation });
  assert.equal(sent.length, 1, 'the control: the first request did go out');

  const replay = await diagnose({ mutation_id: mutation });
  assert.equal(sent.length, 1);
  assert.equal(replay.body.diagnosis_id, first.body.diagnosis_id);
  assert.equal(replay.body.replayed, true);
});

test('a hypothesis can be accepted or rejected, and the decision is appended, not edited in', async () => {
  const { body: diagnosis } = await diagnose();
  const findingId = diagnosis.findings[0].id;
  const decide = (decision, extra = {}) => post(`/api/roles/diagnoses/${diagnosis.diagnosis_id}/decisions`, {
    topic_slug: TOPIC, finding_id: findingId, decision, mutation_id: mint(), ...extra,
  });

  sent.length = 0;
  const rejected = await decide('rejected', { note: 'I did know this; I misread the question.' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.findings[0].state, 'rejected');
  assert.equal(sent.length, 0, 'deciding needs no provider');

  const accepted = await decide('accepted');
  assert.equal(accepted.body.findings[0].state, 'accepted', 'the latest decision wins');

  const lines = readFileSync(diagnosesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.event === 'hypothesis_decided' && l.diagnosis_id === diagnosis.diagnosis_id).length, 2);

  assert.equal((await decide('maybe')).status, 400);
  const unknown = await post(`/api/roles/diagnoses/${diagnosis.diagnosis_id}/decisions`, { topic_slug: TOPIC, finding_id: 'f99', decision: 'accepted', mutation_id: mint() });
  assert.equal(unknown.status, 404);
});

test('with the Claude API down a diagnosis says so, and past diagnoses can still be read', async () => {
  const before = recorded();
  script = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'not serving you' } } }];
  const { status, body } = await diagnose();
  assert.equal(status, 503);
  assert.match(body.error, /Claude API/);
  assert.equal(recorded(), before);

  const res = await fetch(`${BASE}/api/roles/diagnoses?topic=${TOPIC}`);
  assert.equal(res.status, 200);
});

test('a diagnosis changes no mastery, completes no stage and reads no notebook', () => {
  assert.equal(existsSync(join(topicDir, 'cockpit', 'stages.jsonl')), false);
  assert.equal(JSON.parse(readFileSync(join(topicDir, 'state.json'), 'utf8')).domains[0].concepts[0].confidence, 0);
});
