// WHAT: What `POST /api/grade` sends to the local model, and what it refuses to record
//       when the model answers badly.
// WHY:  Roadmap A3. Essay grading is the second of the two model-backed routes that had
//       never executed under test — `routes.test.mjs` excluded it because reaching its
//       success path meant running the real model. The seam added in the debrief work
//       (STUDYDECK_OLLAMA_BASE_URL) removes that constraint, so the route can now be driven
//       against a recorder.
//
// SAME RULE AS batchegress/debriefegress: nothing here asserts the SHAPE of an ollama
// response. The stub is a recorder; every assertion is over the request THIS APP SENT and
// the attempt THIS APP WROTE. What the stub serves is the minimum needed to get the route
// to the code under test, chosen to be adversarial rather than convenient.
//
// The two cases worth the file are the ones where the model misbehaves, because the code
// that handles them carries comments and no tests:
//
//   - `clampScore` exists because "a model returning 9/5 must not corrupt the record"
//     (ollama.mjs). Nothing checked that it does not.
//   - `gradeEssay` throws rather than returning a guess when the response will not parse,
//     under the rule "never invent a grade from unparseable output". The thing that
//     actually matters there is not the 502 — it is that NO attempt is appended, because a
//     fabricated score written to append-only history cannot be taken back.
//
// A grade is also expensive: ~15s of local model time. The route checks the raw attempt log
// for the mutation id BEFORE calling the model, and the assertion that proves it is that a
// replay sends nothing at all.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-grade-egress-'));

const SOURCE_ID = 'source:grade-fixture';
const SOURCE_TITLE = 'Grade fixture lesson';
const SOURCE_TEXT = 'Freeze the pretrained body for one epoch so the randomly initialized head cannot damage useful features.';

/** Every request this app sent to "ollama", in order, with its body. */
const sent = [];
const bodies = [];

/**
 * What the stub puts in `message.content` for the next call.
 *
 * Fence-wrapped by default with leading prose, because that is what the local model
 * actually does (AGENTS.md, "External services"). A stub emitting bare JSON would stop
 * exercising `extractJson`, which is the only reason this route survives gemma4 at all.
 */
let nextContent = null;
/** When set, the stub answers with this status instead of a completion. */
let nextStatus = 0;
/** When set, the source recorder is unavailable before the model can be called. */
let sourceStatus = 0;

/** Source-grounding recorder: regular essay grading must resolve a source belonging to the topic. */
const onSent = [];
const onStub = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  onSent.push(`${req.method} ${url.pathname}${url.search}`);
  if (sourceStatus) {
    res.writeHead(sourceStatus, { 'content-type': 'application/json' });
    return res.end('{"error":"source recorder was told to fail"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (url.pathname === '/api/sources') {
    return res.end(JSON.stringify([{ id: SOURCE_ID, title: SOURCE_TITLE }]));
  }
  if (url.pathname === `/api/sources/${encodeURIComponent(SOURCE_ID)}`) {
    return res.end(JSON.stringify({ id: SOURCE_ID, title: SOURCE_TITLE, full_text: SOURCE_TEXT }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end('{"error":"unexpected ON request"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

const fenced = (obj) => `Sure — here is the grade:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;

const ollamaStub = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://stub').pathname;
  sent.push(`${req.method} ${pathname}`);
  bodies.push(
    await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    }),
  );

  if (nextStatus) {
    res.writeHead(nextStatus, { 'content-type': 'application/json' });
    return res.end('{"error":"stub was told to fail"}');
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: { content: nextContent } }));
});

await new Promise((resolve) => ollamaStub.listen(0, '127.0.0.1', resolve));

// Set before config.mjs is imported — it resolves once, at import time, into consts. A
// static import would be hoisted above these lines and snapshot the REAL tree and the REAL
// model, so every grade below would land on personal study data.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaStub.address().port}`;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'fixture-password';

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');

// Asserted, not assumed: without this the file is not hermetic. The equivalent check in
// debriefegress.test.mjs was added after a bite check showed a test passing in 19.9s by
// reaching the live model instead of the recorder.
assert.equal(config.ollama.baseUrl, process.env.STUDYDECK_OLLAMA_BASE_URL, 'not talking to the recorder');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the source recorder');

const TOPIC = config.topics[0].slug;
const CONCEPT = 'grade-fixture-concept';

// Schema-valid, because a grade carrying a concept_slug re-renders the knowledge map and
// render.mjs validates what it is handed. Every configured topic gets a tree.
for (const topic of config.topics) {
  mkdirSync(join(FIXTURE_ROOT, topic.slug, 'cockpit'), { recursive: true });
  writeFileSync(
    join(FIXTURE_ROOT, topic.slug, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        topic: `Fixture ${topic.slug}`,
        slug: topic.slug,
        created: '2026-07-30',
        domains: [
          {
            name: 'Grade Fixture Domain',
            slug: 'grade-fixture-domain',
            concepts: [
              {
                name: 'Grade Fixture Concept',
                slug: CONCEPT,
                status: 'unexplored',
                confidence: 0,
                practice_count: 0,
                explain_count: 0,
                last_explained: null,
                last_practiced: null,
                details: ['A concept that exists only so a grade has somewhere to land.'],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  ollamaStub.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const SUBMISSION = {
  question: 'Why does fine_tune freeze the body for one epoch?',
  rubric: 'Full marks for naming catastrophic forgetting and the head being randomly initialised.',
  answer: 'Because the head starts random, so its gradients would wreck the pretrained body.',
};

const grade = async (body) => {
  const res = await fetch(`${base}/api/grade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, source_id: SOURCE_ID, ...SUBMISSION, ...body }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  return res;
};

const confirmGrade = async (attemptId, body) => fetch(`${base}/api/attempts/${attemptId}/confirm-grade`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic_slug: TOPIC, ...body }),
});

const proposeGrade = async (attemptId, body) => fetch(`${base}/api/attempts/${attemptId}/propose-grade`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic_slug: TOPIC, ...body }),
});

const attemptsPath = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'attempts.jsonl');
const attempts = () =>
  existsSync(attemptsPath)
    ? readFileSync(attemptsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

test('the submission reaches the model, and the recorded grade is what came back', async () => {
  nextStatus = 0;
  nextContent = fenced({ score: 4, feedback: 'Right about the random head; say why one epoch.' });
  sent.length = 0;
  bodies.length = 0;

  const res = await grade({ mutation_id: 'm-grade', max: 5, confidence: 'certain' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(sent.length, 1, `expected one model call, got: ${sent.join(', ')}`);

  // What we SENT — ours to assert. All three parts of the submission must reach the model,
  // or the grade is about something other than what the learner wrote.
  const prompt = bodies[0].messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes(SUBMISSION.question), 'the question never reached the model');
  assert.ok(prompt.includes(SUBMISSION.rubric), 'the rubric never reached the model');
  assert.ok(prompt.includes(SUBMISSION.answer), 'the answer never reached the model');
  assert.ok(prompt.includes(SOURCE_TEXT), 'the selected source never grounded the model grade');
  assert.equal(bodies[0].stream, false, 'a streamed grade would not parse');

  // What we RECORDED.
  assert.equal(body.grade.score, 4);
  assert.equal(body.attempt.kind, 'essay');
  assert.equal(body.attempt.status, 'pending_confirmation');
  assert.equal(body.attempt.confidence, 'certain');
  assert.equal(body.attempt.evidence_policy, 'evidence-v1');
  assert.equal(body.mastery, null, 'a model proposal cannot move mastery before learner confirmation');
  assert.equal(attempts().length, 2, 'answer commit plus model proposal revision');
  assert.deepEqual(body.attempt.source_evidence, [{
    source_id: SOURCE_ID,
    source_title: SOURCE_TITLE,
    source_hash: body.attempt.source_evidence[0].source_hash,
    excerpt_hash: body.attempt.source_evidence[0].excerpt_hash,
    excerpt_chars: SOURCE_TEXT.length,
    verification: 'open_notebook',
  }]);
  assert.equal(body.attempt.rubric_provenance.prompt_version, 'essay-grade-source-rubric-v2');
  assert.match(body.attempt.rubric_provenance.rubric_hash, /^[a-f0-9]{64}$/);
  assert.ok(onSent.some((entry) => entry.includes(`/api/sources/${encodeURIComponent(SOURCE_ID)}`)),
    'the source detail was never resolved server-side');
  assert.equal(attempts()[0].mutation_id, 'm-grade');
  assert.equal(attempts()[1].mutation_id, 'm-grade:proposal');
  assert.equal(attempts()[1].score, 4);
});

test('essay confidence uses the shared ordinal vocabulary before recording', async () => {
  sent.length = 0;
  const res = await grade({ mutation_id: 'm-grade-confidence-invalid', confidence: 'very certain' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /confidence must be one of/);
  assert.deepEqual(sent, [], 'invalid confidence must be refused before the model call');
});

test('a replay does not spend another 15 seconds of model time', async () => {
  // The control is the test above: it proves this submission reaches the model at all, so
  // the silence here means the raw-attempt check stopped it rather than a 400 doing so.
  sent.length = 0;

  const res = await grade({ mutation_id: 'm-grade', max: 5 });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(body.attempt.duplicate, true);
  assert.deepEqual(sent, [], `a replay called the model: ${sent.join(', ')}`);
  assert.equal(attempts().length, 2, 'a replay appended a second attempt');
});

test('a score above the maximum is clamped, not recorded as given', async () => {
  // ollama.mjs says "a model returning 9/5 must not corrupt the record". Nothing checked
  // it. An out-of-range score in append-only history is not something you can take back,
  // and every derived stat downstream reads it.
  nextContent = fenced({ score: 9, feedback: 'Wildly overconfident marking.' });
  sent.length = 0;

  const res = await grade({ mutation_id: 'm-clamp', max: 5 });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.grade.score, 5, 'an out-of-range score was recorded as given');
  assert.equal(attempts().find((a) => a.mutation_id === 'm-clamp:proposal').score, 5);

  // And the negative direction, which a Math.min alone would miss.
  nextContent = fenced({ score: -3, feedback: 'Negative marking is not a thing here.' });
  const low = await grade({ mutation_id: 'm-clamp-low', max: 5 });
  assert.equal((await low.json()).grade.score, 0);
});

test('an unparseable response records a pending answer but never invents a grade', async () => {
  // The 502 is the least important half. The committed answer is recoverable, while a
  // fabricated score never enters the append-only history or any derived evidence.
  nextContent = 'I think this deserves about a four out of five, honestly. No JSON for you.';
  const before = attempts().length;
  sent.length = 0;

  const res = await grade({ mutation_id: 'm-garbage', max: 5 });

  assert.equal(res.status, 502);
  assert.equal(sent.length, 1, 'the model was not actually called');
  assert.equal(attempts().length, before + 1);
  const pending = attempts().find((a) => a.mutation_id === 'm-garbage');
  assert.equal(pending.status, 'grading_pending');
  assert.equal(pending.score, undefined);
});

test('a reply with no usable score or feedback records a pending answer, never a zero', async () => {
  // clampScore used to read anything Number() could not parse as 0, so a reply with
  // feedback and no score was recorded as 0 out of max: an invented grade, append-only.
  const unusable = [
    ['missing', { feedback: 'Reasonable answer.' }],
    ['null', { score: null, feedback: 'Reasonable answer.' }],
    ['words', { score: 'four', feedback: 'Reasonable answer.' }],
    ['fraction', { score: '4/5', feedback: 'Reasonable answer.' }],
    ['empty-string', { score: '', feedback: 'Reasonable answer.' }],
    ['object', { score: {}, feedback: 'Reasonable answer.' }],
    ['array', { score: [], feedback: 'Reasonable answer.' }],
    ['nan', { score: 'NaN', feedback: 'Reasonable answer.' }],
    ['blank-feedback', { score: 4, feedback: '   ' }],
  ];
  for (const [label, reply] of unusable) {
    nextContent = fenced(reply);
    const mutation = `m-unusable-${label}`;

    const res = await grade({ mutation_id: mutation, max: 5 });

    assert.equal(res.status, 502, `${label}: answered ${res.status}`);
    const pending = attempts().find((a) => a.mutation_id === mutation);
    assert.equal(pending?.status, 'grading_pending', `${label}: no pending attempt was kept`);
    assert.equal(pending.score, undefined, `${label}: a score was recorded`);
  }
});

test('a real zero and a numeric-string score are recorded as given', async () => {
  // Controls for the refusal above: 0 is a grade the model can legitimately give, and "4"
  // is a formatting quirk, not an invented score.
  nextContent = fenced({ score: 0, feedback: 'Does not address the question.' });
  const zero = await grade({ mutation_id: 'm-real-zero', max: 5 });
  assert.equal(zero.status, 201);
  assert.equal((await zero.json()).grade.score, 0);

  nextContent = fenced({ score: '4', feedback: 'Mostly right.' });
  const quoted = await grade({ mutation_id: 'm-quoted-four', max: 5 });
  assert.equal(quoted.status, 201);
  assert.equal((await quoted.json()).grade.score, 4);
});

test('a model error preserves the answer as a resumable grading-pending attempt', async () => {
  nextStatus = 500;
  const before = attempts().length;
  sent.length = 0;

  const res = await grade({ mutation_id: 'm-down', max: 5 });
  const body = await res.json();
  // Restore shared recorder state before assertions so an assertion failure cannot leak a
  // forced model outage into the next lifecycle test.
  nextStatus = 0;

  assert.equal(res.status, 503);
  // The control this test was missing. Without it a 503 raised by some future validation
  // branch — one that never reaches the model at all — passes here looking like a correct
  // degradation. Every other "nothing happened" assertion in these files carries one; this
  // is the same discipline applied to a failure path rather than a silence.
  assert.equal(sent.length, 1, 'the fallback fired without the model ever being called');
  // The study flow must never be blocked by a cold local model — the route says so in the
  // response, and the view shows it verbatim.
  assert.match(body.error, /Claude session/i);
  assert.equal(attempts().length, before + 1, 'a failed grade lost the committed answer');
  const pending = attempts().at(-1);
  assert.equal(pending.status, 'grading_pending');
  assert.equal(pending.answer, SUBMISSION.answer);
  assert.equal(pending.mastery_applied, false);

});

test('retrying a recorded pending essay remains resumable without a second model call', async () => {
  nextStatus = 500;
  const first = await grade({ mutation_id: 'm-pending-retry', max: 5 });
  const firstBody = await first.json();
  nextStatus = 0;
  sent.length = 0;

  const replay = await grade({ mutation_id: 'm-pending-retry', max: 5 });
  const body = await replay.json();

  assert.equal(replay.status, 409, 'a pending assessment is not a successful graded replay');
  assert.equal(body.attempt.attempt_id, firstBody.attempt.attempt_id);
  assert.equal(body.attempt.status, 'grading_pending');
  assert.equal(body.grade, undefined, 'there is no grade to dereference or display');
  assert.deepEqual(sent, [], 'a retry must not spend another model call');
  assert.equal(attempts().filter((attempt) => attempt.mutation_id === 'm-pending-retry').length, 1,
    'a retry must not orphan a second pending answer');
});

test('a source-service outage still preserves the answer without claiming unverified evidence', async () => {
  sourceStatus = 503;
  const before = attempts().length;
  sent.length = 0;

  const res = await grade({ mutation_id: 'm-source-down', max: 5 });
  const body = await res.json();
  // Restore shared recorder state before assertions so a deliberately failing assertion
  // cannot cascade into unrelated tests in this process.
  sourceStatus = 0;

  assert.equal(res.status, 503);
  assert.deepEqual(sent, [], 'a source-grounding failure must not send an ungrounded prompt to the model');
  assert.equal(attempts().length, before + 1, 'a source outage lost the committed answer');
  const pending = attempts().at(-1);
  assert.equal(pending.status, 'grading_pending');
  assert.equal(pending.answer, SUBMISSION.answer);
  assert.deepEqual(pending.source_evidence, [], 'unverified source evidence must not be represented as verified');
  assert.deepEqual(pending.source_request, { source_id: SOURCE_ID, verification: 'pending_open_notebook' });
  assert.equal(body.attempt.attempt_id, pending.attempt_id);
});

test('a bounded manual proposal resumes a persisted answer and finalizes exactly once', async () => {
  nextStatus = 500;
  const failed = await grade({ mutation_id: 'm-manual-resume', max: 5, concept_slug: CONCEPT });
  const failedBody = await failed.json();
  assert.equal(failed.status, 503);
  nextStatus = 0;

  const proposal = await proposeGrade(failedBody.attempt.attempt_id, {
    mutation_id: 'm-manual-proposal',
    assessor_type: 'manual',
    score: 4,
    feedback: 'Manual assessment based on the selected source passage.',
    source_evidence: [{ reference: 'Lesson 1, paragraph 4', passage: SOURCE_TEXT }],
  });
  const proposalBody = await proposal.json();
  assert.equal(proposal.status, 201);
  assert.equal(proposalBody.attempt.status, 'pending_confirmation');
  assert.equal(proposalBody.attempt.assessor_type, 'manual');
  assert.equal(proposalBody.attempt.source_evidence[0].source_id, SOURCE_ID,
    'the original server-verified source evidence must survive manual resume');

  const confirmed = await confirmGrade(failedBody.attempt.attempt_id, {
    mutation_id: 'm-manual-confirm', action: 'accept',
  });
  const confirmedBody = await confirmed.json();
  assert.equal(confirmed.status, 201);
  assert.equal(confirmedBody.attempt.status, 'final');
  assert.ok(confirmedBody.mastery);

  const replay = await confirmGrade(failedBody.attempt.attempt_id, {
    mutation_id: 'm-manual-confirm', action: 'accept',
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});

test('a proposal mutation cannot replay against another pending essay', async () => {
  nextStatus = 500;
  const first = await grade({ mutation_id: 'm-propose-replay-one', max: 5 });
  const firstBody = await first.json();
  const second = await grade({ mutation_id: 'm-propose-replay-two', max: 5 });
  const secondBody = await second.json();
  nextStatus = 0;

  const proposal = {
    mutation_id: 'm-cross-propose', score: 4, feedback: 'Manual source-grounded proposal.',
    source_evidence: [{ reference: 'Lesson 1, paragraph 4', passage: SOURCE_TEXT }],
  };
  assert.equal((await proposeGrade(firstBody.attempt.attempt_id, proposal)).status, 201);
  const conflict = await proposeGrade(secondBody.attempt.attempt_id, proposal);
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /different attempt/i);
  assert.equal(attempts().find((attempt) => attempt.attempt_id === secondBody.attempt.attempt_id)?.status, 'grading_pending');
});

test('a learner-confirmed grade attributed to a concept moves mastery; unconfirmed work does not', async () => {
  nextContent = fenced({ score: 5, feedback: 'Complete.' });
  const confidenceBefore = JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'state.json'), 'utf8'))
    .domains[0].concepts.find((concept) => concept.slug === CONCEPT).confidence;

  const attributed = await grade({ mutation_id: 'm-mastery', max: 5, concept_slug: CONCEPT });
  const body = await attributed.json();
  assert.equal(attributed.status, 201);
  assert.equal(body.attempt.status, 'pending_confirmation');
  assert.equal(body.mastery, null);

  let state = JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'state.json'), 'utf8'));
  let concept = state.domains[0].concepts.find((c) => c.slug === CONCEPT);
  assert.equal(concept.confidence, confidenceBefore, 'a model proposal changed confidence before confirmation');

  const confirmed = await confirmGrade(body.attempt.attempt_id, { mutation_id: 'm-mastery-confirm', action: 'accept' });
  const confirmation = await confirmed.json();
  assert.equal(confirmed.status, 201);
  assert.equal(confirmation.attempt.status, 'final');
  assert.ok(confirmation.mastery, 'a confirmed grade did not move mastery');

  state = JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'state.json'), 'utf8'));
  concept = state.domains[0].concepts.find((c) => c.slug === CONCEPT);
  assert.ok(concept.confidence > 0, 'confidence did not move');
  assert.ok(concept.confidence <= 1, 'confidence exceeded the cap the schema enforces');

  // Unattributed work is still recorded, but must not move any concept: "mastery only
  // moves when the work is attributable to a concept".
  const unattributed = await grade({ mutation_id: 'm-nomastery', max: 5 });
  assert.equal((await unattributed.json()).mastery, null);
});

test('correcting and disputing model proposals preserve their distinct evidence states', async () => {
  nextContent = fenced({ score: 5, feedback: 'Complete.' });
  const corrected = await grade({ mutation_id: 'm-correct', max: 5, concept_slug: CONCEPT });
  const correctedAttempt = (await corrected.json()).attempt;
  const correction = await confirmGrade(correctedAttempt.attempt_id, {
    mutation_id: 'm-correct-confirm', action: 'correct', score: 3, rationale: 'The rubric overweights the final sentence.',
  });
  const correctionBody = await correction.json();
  assert.equal(correction.status, 201);
  assert.equal(correctionBody.attempt.status, 'final');
  assert.equal(correctionBody.attempt.score, 3);
  assert.equal(correctionBody.attempt.learner_confirmation.action, 'correct');

  const disputed = await grade({ mutation_id: 'm-dispute', max: 5, concept_slug: CONCEPT });
  const disputedAttempt = (await disputed.json()).attempt;
  const dispute = await confirmGrade(disputedAttempt.attempt_id, {
    mutation_id: 'm-dispute-confirm', action: 'dispute', rationale: 'The source passage is ambiguous.',
  });
  const disputeBody = await dispute.json();
  assert.equal(dispute.status, 201);
  assert.equal(disputeBody.attempt.status, 'disputed');
  assert.equal(disputeBody.mastery, null);
});

test('a confirmation mutation cannot replay against another essay attempt', async () => {
  nextContent = fenced({ score: 4, feedback: 'Mostly correct.' });
  const one = (await (await grade({ mutation_id: 'm-replay-one', max: 5 })).json()).attempt;
  const two = (await (await grade({ mutation_id: 'm-replay-two', max: 5 })).json()).attempt;
  assert.equal((await confirmGrade(one.attempt_id, { mutation_id: 'm-cross-attempt', action: 'accept' })).status, 201);

  const conflict = await confirmGrade(two.attempt_id, { mutation_id: 'm-cross-attempt', action: 'accept' });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /different attempt/i);
  assert.equal(attempts().find((attempt) => attempt.attempt_id === two.attempt_id && attempt.status === 'pending_confirmation')?.attempt_id,
    two.attempt_id, 'the second attempt must remain unmodified');
});

test('concurrent confirmation requests append and settle one final essay revision', async () => {
  nextContent = fenced({ score: 4, feedback: 'Good.' });
  const attempt = (await (await grade({ mutation_id: 'm-concurrent-confirm-grade', max: 5, concept_slug: CONCEPT })).json()).attempt;
  const [left, right] = await Promise.all([
    confirmGrade(attempt.attempt_id, { mutation_id: 'm-concurrent-confirm', action: 'accept' }),
    confirmGrade(attempt.attempt_id, { mutation_id: 'm-concurrent-confirm', action: 'accept' }),
  ]);
  assert.ok([200, 201].includes(left.status));
  assert.ok([200, 201].includes(right.status));
  assert.equal(attempts().filter((row) => row.mutation_id === 'm-concurrent-confirm').length, 1);
  // Settlement keeps the learner confirmation while appending its prepared/applied
  // revisions, so mutation identity — not that inherited evidence — identifies the one
  // actual confirmation write.
  assert.equal(attempts().filter((row) => row.attempt_id === attempt.attempt_id
    && row.mutation_id === 'm-concurrent-confirm').length, 1);
});

test('concurrent grade requests record and assess one essay only', async () => {
  nextContent = fenced({ score: 4, feedback: 'Good.' });
  sent.length = 0;
  const [left, right] = await Promise.all([
    grade({ mutation_id: 'm-concurrent-grade', max: 5, concept_slug: CONCEPT }),
    grade({ mutation_id: 'm-concurrent-grade', max: 5, concept_slug: CONCEPT }),
  ]);
  const bodies = await Promise.all([left.json(), right.json()]);
  assert.deepEqual([left.status, right.status].sort(), [201, 409]);
  assert.equal(sent.filter((entry) => entry === 'POST /api/chat').length, 1);
  assert.equal(attempts().filter((row) => row.mutation_id === 'm-concurrent-grade').length, 1);
  assert.equal(bodies.filter((body) => body.attempt?.attempt_id).length, 2);
});

test('an incomplete submission is refused before the model is called', async () => {
  sent.length = 0;

  assert.equal((await grade({ mutation_id: 'm-noq', question: '  ' })).status, 400);
  assert.equal((await grade({ mutation_id: 'm-nor', rubric: '' })).status, 400);
  assert.equal((await grade({ mutation_id: 'm-noa', answer: '\n' })).status, 400);
  assert.equal((await grade({ mutation_id: 'm-nt', topic_slug: 'no-such-topic' })).status, 400);

  const noId = await fetch(`${base}/api/grade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, ...SUBMISSION }),
  });
  assert.equal(noId.status, 400, 'an append with no mutation_id was accepted');

  assert.deepEqual(sent, [], `a refused grade still called the model: ${sent.join(', ')}`);
});
