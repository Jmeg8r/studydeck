// WHAT: Route-level HTTP tests — the handler on a real socket, driven with fetch.
// WHY: Assessment finding F6. Every route claim in the P1 pass (#18, #19, #20) rested on
//      manual curl runs, because importing server.mjs bound port 4310 as a side effect and
//      nothing could exercise a route without a live cockpit. router.mjs now exports the
//      handler and server.mjs owns the socket, so the tests below attach the REAL handler
//      to their own server on an ephemeral port. There is no test-only routing path to
//      drift from what serves the browser.
//
// Real HTTP rather than a fake req/res on purpose: the invariants worth pinning here —
// answers withheld until an attempt is on disk, a replay that appends nothing, a body
// ceiling enforced mid-stream — all live in status codes, headers and stream handling that
// a mock response object cannot observe.
//
// NOT covered here: /api/on/*, /api/tts/*, /api/grade and /api/debrief call Open Notebook
// or ollama, and this file has no recorder. That is now a division of labour rather than a
// gap — see gradeegress.test.mjs, debriefegress.test.mjs, mindmapegress.test.mjs and
// batchegress.test.mjs, which drive those routes against recorders and assert what this app
// SENDS. This file keeps the routes whose behaviour is entirely local.
//
// (Until 2026-07-30 this header said exercising them "would either hit live services or
// assert against a stub of an API this repo does not control". The second half was wrong,
// and #40 proved it: asserting what we send is not asserting what they return. The
// distinction is one sentence wide and it kept four routes untested for months.)
//
// /api/mindmap/run is covered here only with `save_note: false` — the local half, record
// the run and dedupe the replay. The note push, including the assertion that a replay
// pushes no SECOND note, lives in mindmapegress.test.mjs; a test that omitted the flag
// HERE would still write a real note into the real notebook, because this file points at
// no stub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-routes-'));

// Must be set before config.mjs is loaded — it resolves the learn root once, at import
// time, into a const. A static import would be hoisted above this line and snapshot the
// REAL .learn/ tree, so every mutation below would land on personal study data.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { config } = await import('../lib/config.mjs');

const CONCEPT = 'route-fixture-concept';
const DECK_FILE = 'route-fixture-quiz.json';
const FC_SOURCE = 'route-fixture-source';

// Any real milestone key — the stage route validates against the table, so a made-up
// one would 400 before the mutation_id check and the assertion would prove nothing.
const { MILESTONES } = await import('../lib/schedule.mjs');
const MILESTONE = MILESTONES[0].key;

/** Both configured topics need a tree: buildState reads every topic in the config. */
const TOPIC = config.topics[0].slug;

const DECK = {
  concept_slug: CONCEPT,
  concept_name: 'Route Fixture Concept',
  created: '2026-07-28',
  questions: [
    { id: 'q1', type: 'short_answer', gradeable: 'exact', prompt: 'One plus one?', answer: 'two', explanation: 'Addition.' },
    { id: 'q2', type: 'true_false', gradeable: 'exact', prompt: 'The sky is green.', answer: false, explanation: 'It is not.' },
    { id: 'q3', type: 'short_answer', gradeable: 'accepted', prompt: 'Name a colour.', answer: 'blue', accepted_answers: ['red', 'green'] },
  ],
};

// Same deck plus one self-checked item, so an attempt lands `pending_self_grade` and the
// finalize route has something real to settle.
const SELF_CHECK_FILE = 'route-fixture-selfcheck.json';
const SELF_CHECK_DECK = {
  ...DECK,
  questions: [
    ...DECK.questions,
    { id: 'q4', type: 'error_correction', gradeable: 'ai_only', prompt: 'Spot the error.', answer: 'The head is trained, not the body.' },
  ],
};

function buildTopicFixture(slug) {
  const dir = join(FIXTURE_ROOT, slug);
  mkdirSync(join(dir, 'quizzes', CONCEPT), { recursive: true });
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        topic: `Fixture ${slug}`,
        slug,
        created: '2026-07-28',
        domains: [
          {
            name: 'Fixture Domain',
            slug: 'fixture-domain',
            concepts: [
              {
                name: 'Route Fixture Concept',
                slug: CONCEPT,
                status: 'unexplored',
                confidence: 0,
                practice_count: 0,
                explain_count: 0,
                last_explained: null,
                last_practiced: null,
                details: ['A concept that exists only so routes have something to move.'],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, 'quizzes', CONCEPT, DECK_FILE), JSON.stringify(DECK));
  writeFileSync(join(dir, 'quizzes', CONCEPT, SELF_CHECK_FILE), JSON.stringify(SELF_CHECK_DECK));
  if (slug === TOPIC) {
    mkdirSync(join(dir, 'exercises', CONCEPT), { recursive: true });
    writeFileSync(join(dir, 'exercises', CONCEPT, 'README.md'), '# Route fixture practice');
  }

  // A stored claim set, so POST /api/factcheck/run has something to score. Generation
  // calls the local model; scoring a stored set does not, so the run route is reachable
  // in a test while the generate route is not.
  writeFileSync(
    join(dir, 'cockpit', 'factchecks.json'),
    JSON.stringify({
      [`${FC_SOURCE}#all`]: {
        source_id: FC_SOURCE,
        source_title: 'Route Fixture Source',
        section: null,
        generated: '2026-07-28T00:00:00.000Z',
        model: 'fixture',
        claims: [
          { id: 'c1', text: 'This claim is true.', truth: true, correction: null },
          { id: 'c2', text: 'This claim is false.', truth: false, correction: 'Actually the opposite.' },
        ],
      },
    }),
  );
}

for (const topic of config.topics) buildTopicFixture(topic.slug);

const { handleRequest } = await import('../router.mjs');

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  // fetch (undici) pools keep-alive sockets, and `close()` only refuses NEW connections —
  // the runner would sit until keepAliveTimeout expired, and a late pooled request could
  // reach a fixture directory that no longer exists.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const get = (path) => fetch(`${BASE}${path}`);
const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Raw attempt log lines — the append-only truth, before any folding. */
const rawAttemptLines = (slug = TOPIC) => {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', 'attempts.jsonl');
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/**
 * Raw stage events — the only thing that may ever mean "this stage is done".
 *
 * ENOENT only. A blanket catch would swallow a JSON parse error too, so a corrupted log
 * would read as zero events at both ends of a before/after comparison and the "no event
 * was written" assertion would pass on a file that is actually broken.
 */
const rawStageLines = (slug = TOPIC) => {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', 'stages.jsonl');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

/** Practice evidence and reveal records are append-only, like attempts and stages. */
const rawPracticeLines = (slug = TOPIC) => {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', 'practice.jsonl');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

/** Teach-back records are append-only activity/evidence history, never stage events. */
const rawTeachbackLines = (slug = TOPIC) => {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', 'teachbacks.jsonl');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const conceptState = (slug = TOPIC) => {
  const state = JSON.parse(readFileSync(join(FIXTURE_ROOT, slug, 'state.json'), 'utf8'));
  return state.domains.flatMap((d) => d.concepts).find((c) => c.slug === CONCEPT);
};

/* ------------------------------------------------------------------ */
/*  Read routes                                                        */
/* ------------------------------------------------------------------ */

test('GET /api/state derives a payload for every configured topic', async () => {
  const res = await get('/api/state');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

  const state = await res.json();
  assert.deepEqual(
    state.topics.map((t) => t.slug),
    config.topics.map((t) => t.slug),
  );
  assert.equal(state.topics[0].counts.unexplored, 1);
  assert.ok(state.topics.every((topic) => Array.isArray(topic.practice_artifacts)));
  const guide = state.topics[0].stages.find((stage) => stage.key === 'guide');
  assert.equal(guide.primary_action.view, 'testcenter');
  assert.equal(guide.secondary_action.view, 'lab');
  assert.equal(guide.complete, false, 'an action instruction is never a completion event');
});

test('GET /api/practice previews only mapped text artifacts', async () => {
  const good = await get(`/api/practice/${TOPIC}/${CONCEPT}/README.md`);
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { file: 'README.md', content: '# Route fixture practice' });

  const traversal = await get(`/api/practice/${TOPIC}/${CONCEPT}/..%2Fstate.json`);
  assert.equal(traversal.status, 400);
  const unmapped = await get(`/api/practice/${TOPIC}/not-a-mapped-concept/README.md`);
  assert.equal(unmapped.status, 404);
});

test('GET /api/practice never exposes protected or symlinked artifacts', async () => {
  const dir = join(FIXTURE_ROOT, TOPIC, 'exercises', CONCEPT);
  const outside = join(FIXTURE_ROOT, 'practice-route-escape.txt');
  writeFileSync(join(dir, 'solution.py'), 'answer = 42\n');
  writeFileSync(outside, 'outside the approved practice root\n');
  symlinkSync(outside, join(dir, 'outside.txt'));

  const solution = await get(`/api/practice/${TOPIC}/${CONCEPT}/solution.py`);
  assert.equal(solution.status, 404);
  const escaped = await get(`/api/practice/${TOPIC}/${CONCEPT}/outside.txt`);
  assert.equal(escaped.status, 404);
});

test('a practice reveal is committed before an answer-bearing artifact reaches the browser', async () => {
  const dir = join(FIXTURE_ROOT, TOPIC, 'exercises', CONCEPT);
  const stateBefore = readFileSync(join(FIXTURE_ROOT, TOPIC, 'state.json'), 'utf8');
  writeFileSync(join(dir, 'answer-key.py'), 'answer = 42\n');

  const before = await get(`/api/practice/${TOPIC}/${CONCEPT}/answer-key.py`);
  assert.equal(before.status, 404, 'a direct GET must not become a reveal path');
  assert.equal(rawPracticeLines().length, 0, 'nothing has been recorded yet');

  const payload = {
    topic_slug: TOPIC,
    concept_slug: CONCEPT,
    file: 'answer-key.py',
    confirmed: true,
    mutation_id: 'm-practice-reveal',
  };
  const first = await post('/api/practice/reveal', payload);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.artifact.content, 'answer = 42\n');
  assert.equal(firstBody.event.event_type, 'answer_revealed');
  assert.equal(firstBody.event.artifact_file, 'answer-key.py');
  assert.equal(rawPracticeLines().length, 1, 'the reveal event is durable before content returns');
  assert.equal(readFileSync(join(FIXTURE_ROOT, TOPIC, 'state.json'), 'utf8'), stateBefore,
    'revealing an answer is evidence, never a direct mastery write');

  const directAfter = await get(`/api/practice/${TOPIC}/${CONCEPT}/answer-key.py`);
  assert.equal(directAfter.status, 200, 'the recorded reveal permits a later resume read');
  assert.deepEqual(await directAfter.json(), { file: 'answer-key.py', content: 'answer = 42\n' });

  const stateWire = await (await get('/api/state')).text();
  assert.ok(!stateWire.includes('answer = 42'), 'the state payload carries reveal metadata, never answer content');

  const replay = await post('/api/practice/reveal', payload);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).artifact.content, 'answer = 42\n');
  assert.equal(rawPracticeLines().length, 1, 'a lost response cannot record two reveals');
});

test('a reveal request without explicit consent cannot leak content or create a ledger row', async () => {
  const dir = join(FIXTURE_ROOT, TOPIC, 'exercises', CONCEPT);
  writeFileSync(join(dir, 'guarded-solution.py'), 'secret_answer = 8675309\n');
  const before = rawPracticeLines().length;

  const missingConsent = await post('/api/practice/reveal', {
    topic_slug: TOPIC, concept_slug: CONCEPT, file: 'guarded-solution.py', confirmed: false,
    mutation_id: 'm-practice-no-consent',
  });
  assert.equal(missingConsent.status, 400);
  assert.ok(!(await missingConsent.text()).includes('8675309'), 'an error response must not include protected content');
  assert.equal(rawPracticeLines().length, before);

  const ordinaryFile = await post('/api/practice/reveal', {
    topic_slug: TOPIC, concept_slug: CONCEPT, file: 'README.md', confirmed: true,
    mutation_id: 'm-practice-not-protected',
  });
  assert.equal(ordinaryFile.status, 400);
  assert.equal(rawPracticeLines().length, before, 'ordinary previews do not create fake reveal events');
});

test('practice evidence is a replay-safe observation, not a covert mastery update', async () => {
  // Use the other configured topic so this test proves the reveal disqualification itself,
  // rather than depending on test order or on another test's ledger row.
  const evidenceTopic = config.topics[1].slug;
  const dir = join(FIXTURE_ROOT, evidenceTopic, 'exercises', CONCEPT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Independent practice fixture');
  writeFileSync(join(dir, 'solution.py'), 'answer = 42\n');
  const stateBefore = readFileSync(join(FIXTURE_ROOT, evidenceTopic, 'state.json'), 'utf8');
  const payload = {
    topic_slug: evidenceTopic,
    concept_slug: CONCEPT,
    mode: 'project',
    outcome: 'confirmed',
    evidence_kind: 'transfer',
    artifact_file: 'README.md',
    rubric: 'Explain the chosen boundary and show a normal plus failing case.',
    observable: 'Ran the exercise with one normal case and one failing boundary case.',
    reflection: 'The boundary case exposed an assumption I had not named.',
    next_action: 'Add the missing assertion, then explain why it matters aloud.',
    ownership: 'independent',
    ai_contribution: 'none',
    hint_use: 'none',
    mutation_id: 'm-practice-evidence',
  };

  const first = await post('/api/practice/evidence', payload);
  assert.equal(first.status, 201);
  const body = await first.json();
  assert.equal(body.event.event_type, 'evidence_recorded');
  assert.equal(body.event.qualification.evidence_quality, 'qualifying');
  assert.equal(body.event.qualification.independent_near_transfer, true);
  assert.equal(rawPracticeLines(evidenceTopic).filter((row) => row.mutation_id === payload.mutation_id).length, 1);
  assert.equal(readFileSync(join(FIXTURE_ROOT, evidenceTopic, 'state.json'), 'utf8'), stateBefore,
    'a practice record must not edit learn-anything state.json');
  const state = await (await get('/api/state')).json();
  const indexed = state.topics.find((topic) => topic.slug === evidenceTopic).practice_artifacts
    .find((artifact) => artifact.concept_slug === CONCEPT);
  assert.equal(indexed.last_record.reflection, payload.reflection,
    'the resume surface receives the recorded reflection, not a derived mastery claim');

  const replay = await post('/api/practice/evidence', { ...payload, reflection: 'This changed payload is a retry, not a new record.' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).event.reflection, payload.reflection);
  assert.equal(rawPracticeLines(evidenceTopic).filter((row) => row.mutation_id === payload.mutation_id).length, 1);

  const beforeInvalid = rawPracticeLines(evidenceTopic).length;
  const noRubric = await post('/api/practice/evidence', { ...payload, rubric: ' ', mutation_id: 'm-practice-no-rubric' });
  assert.equal(noRubric.status, 400, 'the browser form is not the only place that requires a pre-submission rubric');
  assert.equal(rawPracticeLines(evidenceTopic).length, beforeInvalid, 'a rejected evidence claim writes nothing');

  // A disclosed answer cannot later be represented as independent near transfer, even if
  // the learner supplies otherwise-qualifying text in the event body.
  const reveal = await post('/api/practice/reveal', {
    topic_slug: evidenceTopic, concept_slug: CONCEPT, file: 'solution.py', confirmed: true,
    mutation_id: 'm-practice-evidence-reveal',
  });
  assert.equal(reveal.status, 201);
  const afterReveal = await post('/api/practice/evidence', { ...payload, mutation_id: 'm-practice-after-reveal' });
  assert.equal(afterReveal.status, 201);
  const afterRevealBody = await afterReveal.json();
  assert.equal(afterRevealBody.event.qualification.independent_near_transfer, false);
  assert.ok(afterRevealBody.event.qualification.reasons.includes('answer-bearing artifact was revealed'));
});

test('teach-back evidence is replay-safe observed activity, not a covert mastery or stage update', async () => {
  const teachbackTopic = config.topics[1].slug;
  const stateBefore = readFileSync(join(FIXTURE_ROOT, teachbackTopic, 'state.json'), 'utf8');
  const stagesBefore = rawStageLines(teachbackTopic);
  const payload = {
    topic_slug: teachbackTopic,
    outcome: 'confirmed',
    audience: 'A study partner new to the fast.ai lesson',
    artifact_type: 'notes',
    artifact_reference: 'lesson-1-tensor-shape-teachback.md',
    rubric_predeclared: true,
    rubric: 'Explain each tensor shape transition and defend the batch-axis choice.',
    rubric_reference: 'Lesson 1 tensor-shape notes, section 2.',
    observable: 'Explained the transition aloud, answered the batch-axis question, and wrote the correction.',
    questions: 'Why does the batch dimension remain first after the model call?',
    no_gap_found: true,
    gaps: null,
    reflection: 'The question exposed that I had memorised an example rather than the rule.',
    resulting_actions: 'Add the batch-axis distinction to the next flashcard review.',
    remediation_target: null,
    ownership: 'independent',
    ai_contribution: 'none',
    mutation_id: 'm-teachback-evidence',
  };

  const first = await post('/api/teachbacks', payload);
  assert.equal(first.status, 201);
  const body = await first.json();
  assert.equal(body.event.event_type, 'teachback_recorded');
  assert.equal(body.event.qualification.evidence_quality, 'qualifying');
  assert.equal(body.event.qualification.qualifying_teachback, true);
  assert.equal(rawTeachbackLines(teachbackTopic).filter((row) => row.mutation_id === payload.mutation_id).length, 1);
  assert.equal(readFileSync(join(FIXTURE_ROOT, teachbackTopic, 'state.json'), 'utf8'), stateBefore,
    'a teach-back record must not edit learn-anything state.json');
  assert.deepEqual(rawStageLines(teachbackTopic), stagesBefore,
    'observed teach-back activity must not create a stage-complete event');

  const state = await (await get('/api/state')).json();
  const topic = state.topics.find((item) => item.slug === teachbackTopic);
  assert.equal(topic.teachbacks.at(-1).reflection, payload.reflection,
    'the resume surface gets the recorded reflection, not a mastery inference');

  const replay = await post('/api/teachbacks', { ...payload, reflection: 'Changed body on a lost-response retry.' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).event.reflection, payload.reflection);
  assert.equal(rawTeachbackLines(teachbackTopic).filter((row) => row.mutation_id === payload.mutation_id).length, 1);

  const beforeRejected = rawTeachbackLines(teachbackTopic).length;
  const genericHandoff = await post('/api/teachbacks', {
    ...payload,
    outcome: 'rejected',
    no_gap_found: false,
    gaps: 'I could not explain why the dimensions stay aligned.',
    remediation_target: 're-read',
    mutation_id: 'm-teachback-generic-handoff',
  });
  assert.equal(genericHandoff.status, 400, 'a weak teach-back needs a concrete remediation target');
  assert.equal(rawTeachbackLines(teachbackTopic).length, beforeRejected, 'a rejected validation payload writes nothing');
});

test('an activity-only teach-back needs an exact concrete remediation target', async () => {
  const teachbackTopic = config.topics[1].slug;
  const before = rawTeachbackLines(teachbackTopic).length;
  const base = {
    topic_slug: teachbackTopic,
    outcome: 'confirmed',
    audience: 'A study partner new to the topic',
    artifact_type: 'notes',
    artifact_reference: 'teachback-activity-only.md',
    rubric_predeclared: false,
    questions: 'Why does this boundary matter?',
    no_gap_found: true,
    gaps: null,
    reflection: 'I can describe the surface but not yet defend the boundary.',
    resulting_actions: 'Resume with a focused concept explanation.',
    ownership: 'independent',
    ai_contribution: 'none',
  };

  const missing = await post('/api/teachbacks', { ...base, mutation_id: 'm-teachback-missing-remediation' });
  assert.equal(missing.status, 400, 'activity history without qualifying evidence needs a return target');
  assert.equal(rawTeachbackLines(teachbackTopic).length, before, 'the rejected record is never appended');

  const generic = await post('/api/teachbacks', {
    ...base, remediation_target: 're-read', mutation_id: 'm-teachback-generic-remediation',
  });
  assert.equal(generic.status, 400, 'a generic phrase is not a concrete return target');
  assert.equal(rawTeachbackLines(teachbackTopic).length, before);

  const specific = await post('/api/teachbacks', {
    ...base, remediation_target: 'concept:route-fixture-concept', mutation_id: 'm-teachback-concrete-remediation',
  });
  assert.equal(specific.status, 201);
  assert.equal((await specific.json()).event.qualification.evidence_quality, 'activity_only');
  assert.equal(rawTeachbackLines(teachbackTopic).length, before + 1);
});

test('POST /api/practice/scaffold is retired: the browser never writes exercise files', async () => {
  const scaffoldTopic = config.topics[1].slug;
  const payload = { topic_slug: scaffoldTopic, concept_slug: CONCEPT, language: 'python' };
  const exercises = join(FIXTURE_ROOT, scaffoldTopic, 'exercises');
  const conceptDir = join(exercises, CONCEPT);
  // Another route test deliberately creates an exercise for this fixture topic. Remove
  // only that disposable directory so this assertion still pins the missing-directory
  // case without depending on top-level test order.
  rmSync(conceptDir, { recursive: true, force: true });
  assert.equal(existsSync(conceptDir), false, 'fixture starts with no target exercise directory');

  const rejected = await post('/api/practice/scaffold', payload);
  assert.equal(rejected.status, 404);
  assert.equal(existsSync(conceptDir), false, 'a loopback POST must not create the missing artifact directory');
});

test('GET /api/state honours the ?date override without touching the clock', async () => {
  const res = await get('/api/state?date=2026-01-01');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).date, '2026-01-01');
});

test('GET /api/health reports integrity and never serialises the ON password', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);

  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.status, 'ok');
  assert.equal(body.onPassword, config.openNotebook.password ? 'loaded' : 'MISSING');
  assert.equal(body.integrity.length, config.topics.length);
  // The secret is loaded server-side at boot (AGENTS.md rule 6). A route that summarises
  // config is exactly where it would leak, so assert on the wire bytes, not the shape.
  if (config.openNotebook.password) assert.ok(!raw.includes(config.openNotebook.password));
});

test('GET /api/health flips to degraded for a corrupt deck, and back when it is gone', async () => {
  // Decks live in .learn/, not the cockpit sidecar, so inspectSidecars cannot see them —
  // a corrupt deck was the one corruption with no report anywhere (F12). This is the exact
  // payload the browser banner reads, so if `degraded` does not flip here, nothing tells
  // the user their deck list just got shorter.
  const broken = join(FIXTURE_ROOT, TOPIC, 'quizzes', CONCEPT, 'route-fixture-broken.json');
  writeFileSync(broken, '{"concept_slug": "truncated"');

  try {
    const body = await (await get('/api/health')).json();
    assert.equal(body.status, 'degraded');

    const topic = body.integrity.find((t) => t.topic_slug === TOPIC);
    assert.equal(topic.unreadable_decks.length, 1);
    assert.equal(topic.unreadable_decks[0].file, 'route-fixture-broken.json');
    assert.match(topic.unreadable_decks[0].error, /JSON/);
  } finally {
    rmSync(broken, { force: true });
  }

  // Back to ok once removed: a banner that cannot clear is one you learn to ignore.
  assert.equal((await (await get('/api/health')).json()).status, 'ok');
});

test('GET /api/decks lists fixture decks without question content', async () => {
  const res = await get('/api/decks');
  assert.equal(res.status, 200);

  const decks = await res.json();
  const deck = decks.find((d) => d.topic_slug === TOPIC && d.file === DECK_FILE);
  assert.ok(deck, 'fixture deck should be listed');
  assert.equal(deck.question_count, 3);
  assert.equal(deck.questions, undefined);
});

test('GET a deck strips every answer field from the wire', async () => {
  const res = await get(`/api/decks/${TOPIC}/${DECK_FILE}`);
  assert.equal(res.status, 200);

  const raw = await res.text();
  const deck = JSON.parse(raw);
  assert.equal(deck.questions.length, 3);
  for (const q of deck.questions) {
    assert.equal(q.answer, undefined);
    assert.equal(q.accepted_answers, undefined);
    assert.equal(q.explanation, undefined);
  }
  // Substring check as well as key check: a nested copy under any other key would still
  // hand the learner the answers, and the key assertions above would pass.
  assert.ok(!/\btwo\b/i.test(raw), 'answer text must not appear anywhere in the payload');
  assert.ok(!raw.includes('Addition.'), 'explanation text must not appear anywhere either');
});

test('deck routes reject unknown topics, bad file names, and non-GET methods', async () => {
  assert.equal((await get(`/api/decks/no-such-topic/${DECK_FILE}`)).status, 404);
  assert.equal((await get(`/api/decks/${TOPIC}/no-such-deck.json`)).status, 404);
  // %2F keeps the traversal inside one path segment, so it reaches readDeck intact.
  assert.equal((await get(`/api/decks/${TOPIC}/..%2F..%2Fstate.json`)).status, 400);
  assert.equal((await post(`/api/decks/${TOPIC}/${DECK_FILE}`, {})).status, 405);
});

/* ------------------------------------------------------------------ */
/*  Commit-before-reveal                                               */
/*                                                                     */
/*  ORDER MATTERS from here to the end of the reviews section. These   */
/*  build one history on purpose — an attempt, its replay, the card it  */
/*  produced, its finalization — because that sequence IS the property  */
/*  under test. Running one alone (`--test-name-pattern`) or resorting  */
/*  them will fail on missing state, not on a real regression.         */
/* ------------------------------------------------------------------ */

test('POST /api/attempts records the attempt before it reveals any answer', async () => {
  assert.equal(rawAttemptLines().length, 0, 'fixture starts with no history');

  const res = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: DECK_FILE,
    mutation_id: 'm-first',
    responses: { q1: 'two', q2: 'false', q3: 'purple' },
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.attempt.score, 2);
  assert.equal(body.attempt.max, 3);
  assert.deepEqual(body.attempt.misses, ['q3']);
  assert.equal(body.attempt.status, 'final');
  assert.equal(body.attempt.retrieval_evidence.policy, 'retrieval-v1');
  assert.match(body.attempt.retrieval_evidence.assessment_version, /^[a-f0-9]{64}$/);
  assert.deepEqual(body.attempt.retrieval_evidence.items, [
    { question_id: 'q1', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: true },
    { question_id: 'q2', retrieval_format: 'recognition', verification_method: 'deterministic_deck', answer_free: true, correct: true },
    { question_id: 'q3', retrieval_format: 'free_recall', verification_method: 'deterministic_deck', answer_free: true, correct: false },
  ]);
  // The reveal only happens here, on the response that already wrote the record.
  assert.equal(body.results.find((r) => r.id === 'q1').answer, 'two');

  const lines = rawAttemptLines();
  assert.equal(lines.length, 3, 'the attempt, its write-ahead settlement, and its applied follow-up');
  assert.equal(lines[0].mutation_id, 'm-first');
  assert.equal(lines[0].mastery_applied, false, 'never true at append time');
  assert.equal(lines[1].mastery_settlement.stage, 'prepared');
  assert.equal(lines[1].mastery_applied, false);
  assert.equal(lines[2].mastery_settlement.stage, 'applied');
  assert.equal(lines[2].mastery_applied, true);

  // Mastery really moved: 2/3 is a partial band, so confidence +0.05 and one practice.
  assert.equal(body.mastery.band, 'partial');
  assert.equal(conceptState().confidence, 0.05);
  assert.equal(conceptState().practice_count, 1);
  assert.equal(conceptState().status, 'needs_practice');
});

test('quiz confidence is stored before feedback, validates its vocabulary, and survives replay', async () => {
  const payload = {
    topic_slug: TOPIC,
    deck_file: DECK_FILE,
    mutation_id: 'm-confidence-evidence',
    responses: { q1: 'red', q2: 'blue', q3: 'green' },
    confidence: { q1: 'certain', q2: 'likely', q3: 'unsure' },
  };
  const first = await post('/api/attempts', payload);
  const firstBody = await first.json();

  assert.equal(first.status, 201);
  assert.deepEqual(firstBody.attempt.confidence, payload.confidence);
  assert.equal(firstBody.attempt.evidence_policy, 'evidence-v1');
  assert.deepEqual(firstBody.results.map((result) => result.confidence), ['certain', 'likely', 'unsure']);

  const state = await (await get('/api/state')).json();
  const evidence = state.topics.find((topic) => topic.slug === TOPIC).confidence_evidence;
  assert.equal(evidence.policy, 'evidence-v1');
  assert.deepEqual(evidence.bands.map((band) => [band.band, band.sample, band.insufficient]), [
    ['unsure', 1, true], ['likely', 1, true], ['certain', 1, true],
  ]);
  const retention = state.topics.find((topic) => topic.slug === TOPIC).item_retention_evidence;
  const recognised = retention.find((item) => item.item_id === `${DECK_FILE}:q2`);
  assert.equal(recognised.retrieval_format, 'recognition');
  assert.equal(recognised.retention_horizon_days, 0, 'one event establishes only initial demonstration');

  const replay = await post('/api/attempts', { ...payload, confidence: { q1: 'unsure' } });
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.deepEqual(replayBody.results.map((result) => result.confidence), ['certain', 'likely', 'unsure']);

  const invalid = await post('/api/attempts', {
    ...payload, mutation_id: 'm-confidence-invalid', confidence: { q1: 'very certain' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /confidence must be one of/);

  const unanswered = await post('/api/attempts', {
    ...payload, mutation_id: 'm-confidence-unanswered', confidence: { q1: 'certain' }, responses: {},
  });
  assert.equal(unanswered.status, 400);
  assert.match((await unanswered.json()).error, /confidence requires a submitted answer/);
});

test('a learner characterizes a high-confidence miss with one replay-safe event', async () => {
  const run = await post('/api/attempts', {
    topic_slug: TOPIC, deck_file: DECK_FILE, mutation_id: 'm-misconception-source',
    responses: { q1: 'three' }, confidence: { q1: 'certain' },
  });
  const attempt = (await run.json()).attempt;
  const candidateId = `quiz:${attempt.attempt_id}:q1`;
  const payload = {
    topic_slug: TOPIC, mutation_id: 'm-misconception-characterize',
    action: 'classified_slip', rationale: 'I read the prompt too quickly.',
  };
  const first = await post(`/api/misconceptions/${encodeURIComponent(candidateId)}/characterize`, payload);
  assert.equal(first.status, 201);
  const replay = await post(`/api/misconceptions/${encodeURIComponent(candidateId)}/characterize`, payload);
  assert.equal(replay.status, 200);
  const state = await (await get('/api/state')).json();
  const candidate = state.topics.find((topic) => topic.slug === TOPIC).misconceptions
    .find((item) => item.id === candidateId);
  assert.equal(candidate.state, 'classified_slip');
  assert.equal(candidate.characterization, 'I read the prompt too quickly.');
});

test('a replayed mutation_id returns the first result and appends nothing', async () => {
  const before = rawAttemptLines().length;
  const confidenceBefore = conceptState().confidence;

  const res = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: DECK_FILE,
    mutation_id: 'm-first',
    // A retry carrying a DIFFERENT payload must still be graded from what was stored,
    // or the reveal would contradict the attempt it returns.
    responses: { q1: 'two', q2: 'false', q3: 'blue' },
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.replayed, true);
  assert.equal(body.attempt.score, 2, 'the stored score, not the retry payload');
  assert.equal(body.results.find((r) => r.id === 'q3').response, 'purple');
  assert.equal(rawAttemptLines().length, before, 'no second record');
  assert.equal(conceptState().confidence, confidenceBefore, 'no second confidence bump');
});

test('concurrent HTTP attempt submissions record one attempt and settle it once', async () => {
  const before = rawAttemptLines().length;
  const payload = {
    topic_slug: TOPIC, deck_file: DECK_FILE, mutation_id: 'm-concurrent-attempt',
    responses: { q1: 'two', q2: 'false', q3: 'blue' },
  };
  const [left, right] = await Promise.all([post('/api/attempts', payload), post('/api/attempts', payload)]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal(leftBody.attempt.attempt_id, rightBody.attempt.attempt_id);
  assert.equal(rawAttemptLines().filter((row) => row.mutation_id === 'm-concurrent-attempt').length, 1);
  assert.equal(rawAttemptLines().length, before + 3, 'one attempt and its one settlement sequence');
});

test('the misses of a recorded attempt become review cards', async () => {
  const res = await get('/api/state');
  const topic = (await res.json()).topics.find((t) => t.slug === TOPIC);

  const card = topic.cards.find((c) => c.source_ref === `${DECK_FILE}:q3`);
  assert.ok(card, 'the miss should be queued as a card');
  assert.match(card.id, /^card-v2-quiz-miss-/, 'new generated cards use the versioned hashed identity');
  assert.equal(card.source, 'quiz-miss');
  assert.equal(card.front, 'Name a colour.');
  assert.equal(topic.unqueued_misses, 0, 'nothing missed should be left without a card');
});

test('POST /api/attempts validates its input before writing anything', async () => {
  const before = rawAttemptLines().length;

  // Assert the REASON, not just the code: a missing mutation_id is now also a 400, so a
  // bare status check would pass even if these stopped being validated at all.
  const missingDeck = await post('/api/attempts', { topic_slug: TOPIC });
  assert.equal(missingDeck.status, 400);
  assert.match((await missingDeck.json()).error, /deck_file/);

  const missingTopic = await post('/api/attempts', { deck_file: DECK_FILE });
  assert.equal(missingTopic.status, 400);
  assert.match((await missingTopic.json()).error, /topic_slug/);

  assert.equal(
    (await post('/api/attempts', { topic_slug: 'no-such-topic', deck_file: DECK_FILE })).status,
    404,
  );
  assert.equal(rawAttemptLines().length, before);
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await fetch(`${BASE}/api/attempts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/);
});

/* ------------------------------------------------------------------ */
/*  Self-checked items and finalize                                    */
/* ------------------------------------------------------------------ */

test('an attempt with self-checked items waits for finalize before mastery moves', async () => {
  const confidenceBefore = conceptState().confidence;

  const res = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: SELF_CHECK_FILE,
    mutation_id: 'm-selfcheck',
    responses: { q1: 'two', q2: 'false', q3: 'blue', q4: 'the body is frozen' },
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.attempt.status, 'pending_self_grade');
  assert.deepEqual(body.attempt.pending, ['q4']);
  assert.deepEqual(body.attempt.retrieval_evidence.items.find((item) => item.question_id === 'q4'), {
    question_id: 'q4', retrieval_format: 'explanation', verification_method: 'self_grade', answer_free: true, correct: null,
  });
  assert.equal(body.mastery, null, 'mastery waits — applying now and again at finalize doubles it');
  assert.equal(conceptState().confidence, confidenceBefore);

  // Abandoning here is honest, not silent: the attempt is on disk and unapplied.
  const attempt = rawAttemptLines().at(-1);
  assert.equal(attempt.mastery_applied, false);
});

test('POST /api/attempts/:id/finalize appends a revision and applies mastery once', async () => {
  const pending = rawAttemptLines().findLast((a) => a.status === 'pending_self_grade');
  const before = conceptState();

  const res = await post(`/api/attempts/${pending.attempt_id}/finalize`, {
    topic_slug: TOPIC,
    mutation_id: 'm-finalize',
    self_grades: { q4: true },
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.attempt.attempt_id, pending.attempt_id, 'same attempt, not a new one');
  assert.equal(body.attempt.revision, 1);
  assert.equal(body.attempt.status, 'final');
  assert.equal(body.attempt.score, 4);
  assert.equal(body.attempt.pending, undefined);
  assert.deepEqual(body.attempt.retrieval_evidence.items.find((item) => item.question_id === 'q4'), {
    question_id: 'q4', retrieval_format: 'explanation', verification_method: 'self_grade', answer_free: true, correct: true,
  });

  // 4/4 is a strong band: +0.12 and a second practice on a concept that had one.
  assert.equal(body.mastery.band, 'strong');
  assert.equal(conceptState().confidence, Math.round((before.confidence + 0.12) * 100) / 100);
  assert.equal(conceptState().practice_count, before.practice_count + 1);

  // Both revisions stay on disk — that is what makes the log auditable — but every
  // reader folds to the newest.
  const revisions = rawAttemptLines().filter((a) => a.attempt_id === pending.attempt_id);
  assert.ok(revisions.length >= 2);
  assert.deepEqual([...new Set(revisions.map((a) => a.revision))].sort(), [0, 1]);
});

test('a replayed finalize does not bump confidence a second time', async () => {
  const attemptId = rawAttemptLines().findLast((a) => a.revision === 1).attempt_id;
  const confidenceBefore = conceptState().confidence;
  const linesBefore = rawAttemptLines().length;

  const res = await post(`/api/attempts/${attemptId}/finalize`, {
    topic_slug: TOPIC,
    mutation_id: 'm-finalize',
    self_grades: { q4: true },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).already_final, true);
  assert.equal(conceptState().confidence, confidenceBefore);
  assert.equal(rawAttemptLines().length, linesBefore);
});

test('concurrent HTTP finalizations append one revision and apply mastery once', async () => {
  const created = await post('/api/attempts', {
    topic_slug: TOPIC, deck_file: SELF_CHECK_FILE, mutation_id: 'm-concurrent-finalize-attempt',
    responses: { q1: 'two', q2: 'false', q3: 'blue', q4: 'the body is frozen' },
  });
  const pending = (await created.json()).attempt;
  const payload = { topic_slug: TOPIC, mutation_id: 'm-concurrent-finalize', self_grades: { q4: true } };
  const [left, right] = await Promise.all([
    post(`/api/attempts/${pending.attempt_id}/finalize`, payload),
    post(`/api/attempts/${pending.attempt_id}/finalize`, payload),
  ]);
  const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal(leftBody.attempt.attempt_id, pending.attempt_id);
  assert.equal(rightBody.attempt.attempt_id, pending.attempt_id);
  assert.equal(rawAttemptLines().filter((row) => row.mutation_id === 'm-concurrent-finalize').length, 1);
  assert.equal(rawAttemptLines().filter((row) => row.attempt_id === pending.attempt_id && row.status === 'final').length, 3,
    'the final revision carries its prepared and applied settlement follow-ups');
});

test('a pending self-graded attempt cannot create cards or unqueued misses', async () => {
  const res = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: SELF_CHECK_FILE,
    mutation_id: 'm-pending-miss',
    // q1 is deterministically wrong, but q4 is still awaiting the learner. The entire
    // attempt remains provisional and must not create a corrective card before it is final.
    responses: { q1: 'wrong', q2: 'false', q3: 'blue', q4: 'the body is frozen' },
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.attempt.status, 'pending_self_grade');
  assert.equal(body.queued_cards.length, 0);

  const topic = (await get('/api/state').then((response) => response.json())).topics.find((item) => item.slug === TOPIC);
  assert.ok(!topic.cards.some((card) => card.source_ref === `${SELF_CHECK_FILE}:q1`));
  assert.equal(topic.unqueued_misses, 0, 'a provisional miss must not enter learning evidence');
});

test('finalize rejects an unknown attempt and an unknown topic', async () => {
  assert.equal(
    (await post('/api/attempts/does-not-exist/finalize', { topic_slug: TOPIC })).status,
    404,
  );
  assert.equal(
    (await post('/api/attempts/does-not-exist/finalize', { topic_slug: 'no-such-topic' })).status,
    400,
  );
  assert.equal((await post('/api/attempts/some-id/not-an-action', { topic_slug: TOPIC })).status, 404);
});

/* ------------------------------------------------------------------ */
/*  Reviews and cards                                                  */
/* ------------------------------------------------------------------ */

test('POST /api/reviews logs a review and dedupes on mutation_id', async () => {
  const card = await get('/api/state')
    .then((r) => r.json())
    .then((s) => s.topics.find((t) => t.slug === TOPIC).cards[0]);

  const payload = {
    topic_slug: TOPIC,
    card_id: card.id,
    result: 'hit',
    mutation_id: 'm-review',
  };
  const first = await post('/api/reviews', payload);
  assert.equal(first.status, 201);

  // A card's rung is its consecutive-hit streak, so a double-logged review would
  // silently lengthen the interval.
  const replay = await post('/api/reviews', payload);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);

  assert.equal((await post('/api/reviews', { ...payload, result: 'maybe' })).status, 400);
});

/* ------------------------------------------------------------------ */
/*  Fact-check runs                                                    */
/* ------------------------------------------------------------------ */

test('a fact-check run records an attempt carrying the same identity a quiz does', async () => {
  const res = await post('/api/factcheck/run', {
    topic_slug: TOPIC,
    source_id: FC_SOURCE,
    mutation_id: 'm-factcheck',
    marks: { c1: true, c2: true }, // c2 is false — marking it true is the miss
    confidence: { c1: 'certain', c2: 'likely' },
  });
  assert.equal(res.status, 201);

  const { attempt, results, created_cards: created } = await res.json();
  assert.equal(attempt.kind, 'factcheck');
  assert.equal(attempt.status, 'pending_confirmation');
  assert.deepEqual(attempt.confidence, { c1: 'certain', c2: 'likely' });
  assert.equal(attempt.evidence_policy, 'evidence-v1');
  assert.equal(attempt.score, undefined, 'a model verdict is not yet learning evidence');
  assert.equal(created.length, 0, 'model-only disagreements create no corrective cards');
  assert.equal(results.find((result) => result.id === 'c2').truth, false, 'verdict is revealed only after the marks append');
  assert.equal(results.find((result) => result.id === 'c2').confidence, 'likely');
  // Rule 9 applies to every append path, not just quizzes. Without these, foldAttempts
  // handles the row through its legacy branch and findAttempt can never resolve it.
  assert.ok(attempt.attempt_id, 'a factcheck attempt needs an attempt_id');
  assert.equal(attempt.revision, 0);

  const invalid = await post('/api/factcheck/run', {
    topic_slug: TOPIC, source_id: FC_SOURCE, mutation_id: 'm-factcheck-confidence-invalid',
    marks: {}, confidence: { c1: 'certain' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /confidence requires a submitted true\/false mark/);
});

test('fact-check claims require final learner adjudication before they create evidence or cards', async () => {
  const run = await post('/api/factcheck/run', {
    topic_slug: TOPIC, source_id: FC_SOURCE, mutation_id: 'm-fc-adjudicate',
    marks: { c1: true, c2: true },
  });
  const proposed = await run.json();
  const before = rawAttemptLines().length;

  const partial = await post(`/api/factcheck/runs/${proposed.attempt.attempt_id}/adjudicate`, {
    topic_slug: TOPIC, mutation_id: 'm-fc-adjudicate-partial',
    decisions: { c1: { action: 'accept' }, c2: { action: 'dispute', rationale: 'The wording is ambiguous.' } },
  });
  const partialBody = await partial.json();
  assert.equal(partial.status, 201);
  assert.equal(partialBody.attempt.status, 'pending_confirmation');
  assert.deepEqual(partialBody.disputed, ['c2']);
  assert.equal(partialBody.created_cards.length, 0, 'a disputed model claim must not create a card');

  const final = await post(`/api/factcheck/runs/${proposed.attempt.attempt_id}/adjudicate`, {
    topic_slug: TOPIC, mutation_id: 'm-fc-adjudicate-final',
    decisions: {
      c1: { action: 'accept' },
      c2: { action: 'correct', truth: false, correction: 'The learner-confirmed correction.' },
    },
  });
  const finalBody = await final.json();
  assert.equal(final.status, 201);
  assert.equal(finalBody.attempt.status, 'final');
  assert.equal(finalBody.score, 1);
  assert.equal(finalBody.max, 2);
  assert.equal(finalBody.created_cards.length, 1);
  assert.match(finalBody.created_cards[0].id, /^card-v2-factcheck-/, 'fact-check cards share the v2 generated identity scheme');
  assert.equal(finalBody.attempt.factcheck_cards.status, 'complete', 'the card write has its own durable completion marker');
  assert.equal(rawAttemptLines().length, before + 3,
    'each adjudication revision is appended, followed by one durable corrective-card completion marker');

  const replay = await post(`/api/factcheck/runs/${proposed.attempt.attempt_id}/adjudicate`, {
    topic_slug: TOPIC, mutation_id: 'm-fc-adjudicate-final', decisions: {},
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(rawAttemptLines().length, before + 3, 'a replay must not append another adjudication or card marker');
});

test('resuming one fact-check claim preserves earlier learner adjudications', async () => {
  const run = await post('/api/factcheck/run', {
    topic_slug: TOPIC, source_id: FC_SOURCE, mutation_id: 'm-fc-resume',
    marks: { c1: true, c2: true },
  });
  const proposed = await run.json();

  const first = await post(`/api/factcheck/runs/${proposed.attempt.attempt_id}/adjudicate`, {
    topic_slug: TOPIC, mutation_id: 'm-fc-resume-c1',
    decisions: { c1: { action: 'accept' } },
  });
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.attempt.status, 'pending_confirmation');
  assert.equal(firstBody.results.find((result) => result.id === 'c1').adjudication, 'accepted');

  // A resumed browser view sends the decision made on this interaction. Omitting c1
  // must retain its durable learner confirmation rather than silently returning it to
  // model-only pending evidence.
  const resumed = await post(`/api/factcheck/runs/${proposed.attempt.attempt_id}/adjudicate`, {
    topic_slug: TOPIC, mutation_id: 'm-fc-resume-c2',
    decisions: { c2: { action: 'correct', truth: false, correction: 'Learner confirmed the correction.' } },
  });
  const resumedBody = await resumed.json();
  assert.equal(resumed.status, 201);
  assert.equal(resumedBody.attempt.status, 'final');
  assert.equal(resumedBody.results.find((result) => result.id === 'c1').adjudication, 'accepted');
  assert.equal(resumedBody.results.find((result) => result.id === 'c2').adjudication, 'corrected');
});

test('a fact-check run does not reveal a claim verdict until it is submitted', async () => {
  const raw = await get(`/api/factcheck?topic=${TOPIC}`).then((r) => r.text());
  assert.ok(raw.includes('This claim is false.'), 'the claim text itself is expected');
  assert.ok(!raw.includes('Actually the opposite.'), 'the correction must not cross the wire');
  assert.ok(!/"truth"/.test(raw), 'no truth values before submit');
});

test('a replayed fact-check run scores nothing a second time', async () => {
  // Self-contained: its own mutation id and its own first run, so it does not silently
  // depend on the test above having created one. Run alone, this still means something.
  const run = { topic_slug: TOPIC, source_id: FC_SOURCE, mutation_id: 'm-fc-replay', marks: { c1: true, c2: false } };

  const first = await post('/api/factcheck/run', run);
  assert.equal(first.status, 201);
  const before = rawAttemptLines().length;

  const replay = await post('/api/factcheck/run', run);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  // Raw, not folded: the assertion is that nothing was APPENDED. scoreRun mints cards, so
  // a re-scored replay is a write the caller never asked for — and folding would hide a
  // duplicate append behind the very dedupe being tested.
  assert.equal(rawAttemptLines().length, before);
});

/* ------------------------------------------------------------------ */
/*  Mind-map runs                                                      */
/* ------------------------------------------------------------------ */

test('a replayed mind-map run records one run and pushes no second note', async () => {
  // `save_note: false` keeps this off Open Notebook, so the local half of the route is
  // reachable in a test. Without it this would write a real note into the real notebook.
  const run = { topic_slug: TOPIC, recalled: [CONCEPT], sketch: null, save_note: false, mutation_id: 'm-mindmap' };

  const first = await post('/api/mindmap/run', run);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.total, 1);
  assert.equal(firstBody.run.recalled.length, 1);

  const replay = await post('/api/mindmap/run', run);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.run.duplicate, true);
  assert.equal(replayBody.run.ts, firstBody.run.ts, 'the stored run, not a fresh one');
  // The note is the expensive, externally-visible half — a retry must not push a second.
  assert.equal(replayBody.note, null);

  const runs = JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'mindmaps.json'), 'utf8'));
  assert.equal(runs.filter((r) => r.mutation_id === 'm-mindmap').length, 1);
});

test('a replayed run with a sketch writes no second file to disk', async () => {
  // The first version of this test passed `sketch: null` and proved nothing: the sketch
  // was saved BEFORE the duplicate check, and its filename is timestamped, so every retry
  // left a fresh orphan of up to 8MB that no run referenced. Same class of repeated
  // expensive side effect as the duplicate note — just invisible without a real sketch.
  const sketchDir = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'sketches');
  const run = {
    topic_slug: TOPIC,
    recalled: [],
    save_note: false,
    mutation_id: 'm-mindmap-sketch',
    sketch: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wlbc1cAAAAASUVORK5CYII=',
  };

  assert.equal((await post('/api/mindmap/run', run)).status, 201);
  const afterFirst = readdirSync(sketchDir);
  assert.equal(afterFirst.length, 1, 'the first run saves one sketch');

  assert.equal((await post('/api/mindmap/run', run)).status, 200);
  assert.deepEqual(readdirSync(sketchDir), afterFirst, 'a replay must not write another');
});

test('a sketch MIME label cannot smuggle non-raster bytes into same-origin storage', async () => {
  const res = await post('/api/mindmap/run', {
    topic_slug: TOPIC, recalled: [], save_note: false, mutation_id: 'm-mindmap-bad-bytes',
    sketch: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /do not match declared type/);
});

/* ------------------------------------------------------------------ */
/*  mutation_id is mandatory on appends, and only on appends           */
/* ------------------------------------------------------------------ */

test('every appending route refuses a request with no mutation_id', async () => {
  const card = await get('/api/state')
    .then((r) => r.json())
    .then((s) => s.topics.find((t) => t.slug === TOPIC).cards[0]);

  // A route cannot tell "no id" from "a client that never retries", so the only way the
  // dedupe guarantee is real is to refuse the request that cannot be protected. Falling
  // back to a server-minted UUID made every request unique and deduplicated nothing.
  // A REAL pending attempt: finalize resolves the attempt (404) and short-circuits on an
  // already-final one (200, no append) before it ever reaches the id check, so a made-up
  // id would make the assertion below pass without testing anything.
  const pending = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: SELF_CHECK_FILE,
    mutation_id: 'm-needs-finalize',
    responses: { q1: 'two', q2: 'false', q3: 'blue', q4: 'something' },
  }).then((r) => r.json());
  assert.equal(pending.attempt.status, 'pending_self_grade');

  const candidateSource = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: DECK_FILE,
    mutation_id: 'm-misconception-needs-characterization',
    responses: { q1: 'three' },
    confidence: { q1: 'certain' },
  }).then((r) => r.json());
  const candidateId = `quiz:${candidateSource.attempt.attempt_id}:q1`;
  writeFileSync(join(FIXTURE_ROOT, TOPIC, 'exercises', CONCEPT, 'solution.py'), 'answer = 42\n');

  const appends = [
    ['/api/attempts', { topic_slug: TOPIC, deck_file: DECK_FILE, responses: {} }],
    [`/api/attempts/${pending.attempt.attempt_id}/finalize`, { topic_slug: TOPIC, self_grades: { q4: true } }],
    ['/api/reviews', { topic_slug: TOPIC, card_id: card.id, result: 'hit' }],
    ['/api/cards', { topic_slug: TOPIC, front: 'f', back: 'b' }],
    ['/api/factcheck/run', { topic_slug: TOPIC, source_id: FC_SOURCE, marks: {} }],
    ['/api/mindmap/run', { topic_slug: TOPIC, recalled: [], save_note: false }],
    ['/api/schedule/stage', { topic_slug: TOPIC, milestone_key: MILESTONE, action: 'complete' }],
    ['/api/schedule/reset', { topic_slug: TOPIC, started: '2026-07-01' }],
    ['/api/practice/reveal', {
      topic_slug: TOPIC, concept_slug: CONCEPT, file: 'solution.py', confirmed: true,
    }],
    ['/api/practice/evidence', {
      topic_slug: TOPIC, concept_slug: CONCEPT, mode: 'project', outcome: 'confirmed', evidence_kind: 'practice',
      artifact_file: 'README.md', rubric: 'Run a normal and boundary check.',
      observable: 'Both command outputs were captured.', reflection: 'The boundary was initially unclear.',
      next_action: 'Name the boundary in the README.', ownership: 'independent', ai_contribution: 'none', hint_use: 'none',
    }],
    ['/api/teachbacks', {
      topic_slug: TOPIC, outcome: 'confirmed', audience: 'study partner', artifact_type: 'notes',
      artifact_reference: 'lesson-notes.md', rubric_predeclared: true, rubric: 'Explain the concept.',
      rubric_reference: 'Lesson notes, section 1.',
      observable: 'Explained it aloud.', questions: 'Why does this work?', no_gap_found: true, gaps: null,
      reflection: 'One detail is still fuzzy.', resulting_actions: 'Make a card for that detail.',
      ownership: 'independent', ai_contribution: 'none',
    }],
    [`/api/misconceptions/${encodeURIComponent(candidateId)}/characterize`, {
      topic_slug: TOPIC,
      action: 'classified_slip',
      rationale: 'I read the prompt too quickly.',
    }],
  ];

  // Counted AFTER the setup append above, so the assertion is about the refusals only.
  const before = rawAttemptLines().length;
  const practiceBefore = rawPracticeLines().length;

  for (const [path, body] of appends) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} → ${res.status}`);
    assert.match((await res.json()).error, /mutation_id is required/, path);
  }

  // An empty or blank id is the same failure as none — it deduplicates nothing.
  for (const blank of ['', '   ', null, 42]) {
    const res = await post('/api/reviews', { topic_slug: TOPIC, card_id: card.id, result: 'hit', mutation_id: blank });
    assert.equal(res.status, 400, `mutation_id=${JSON.stringify(blank)} → ${res.status}`);
  }

  assert.equal(rawAttemptLines().length, before, 'a refused append writes nothing');
  assert.equal(rawPracticeLines().length, practiceBefore, 'a refused practice append writes no reveal or evidence row');
});

test('routes that SET a value still take no mutation_id', async () => {
  // The other half of the tightening, and the half that would be an outage if wrong.
  // These rewrite an identical file on replay, so an id would advertise a protection that
  // is not running (rule 9), and /api/cards/sync is idempotent by source_ref instead.
  assert.equal((await post('/api/schedule/start', { topic_slug: TOPIC, started: '2026-07-01' })).status, 200);
  assert.equal((await post('/api/schedule/pause', { topic_slug: TOPIC, paused: true })).status, 200);
  assert.equal((await post('/api/reading', { topic_slug: TOPIC, source_id: 's1', position: 0.5 })).status, 200);
  assert.equal((await post('/api/cards/sync', { topic_slug: TOPIC })).status, 201);

  // Un-pause so later reads see the topic as it was.
  assert.equal((await post('/api/schedule/pause', { topic_slug: TOPIC, paused: false })).status, 200);
});

test('topic, concept, score, and position boundaries refuse invalid records before a write', async () => {
  const attemptsBefore = rawAttemptLines().length;
  const invalid = [
    ['/api/cards/sync', { topic_slug: '../outside' }],
    ['/api/reading', { topic_slug: TOPIC, source_id: 's1', position: 1.01 }],
    ['/api/reading', { topic_slug: TOPIC, source_id: 's1', position: Number.NaN }],
    ['/api/grade', {
      topic_slug: TOPIC, question: 'q', rubric: 'r', answer: 'a', max: 2.5,
      concept_slug: CONCEPT, mutation_id: 'm-invalid-max',
    }],
    ['/api/grade', {
      topic_slug: TOPIC, question: 'q', rubric: 'r', answer: 'a', max: 5,
      concept_slug: 'not-a-real-concept', mutation_id: 'm-invalid-concept',
    }],
    ['/api/cards', {
      topic_slug: TOPIC, front: 'f', back: 'b', concept_slug: 'not-a-real-concept', mutation_id: 'm-invalid-card-concept',
    }],
  ];
  for (const [path, body] of invalid) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} should reject ${JSON.stringify(body)}`);
  }
  assert.equal(rawAttemptLines().length, attemptsBefore, 'invalid validation inputs must not append an attempt');
});

test('bounded route fields reject oversized strings and objects before creating durable records', async () => {
  const cardsBefore = await get('/api/state')
    .then((res) => res.json())
    .then((state) => state.topics.find((topic) => topic.slug === TOPIC).cards.length);
  const hugeFront = 'x'.repeat(8_001);
  const card = await post('/api/cards', {
    topic_slug: TOPIC, front: hugeFront, back: 'bounded', mutation_id: 'm-huge-card',
  });
  assert.equal(card.status, 400);
  assert.match((await card.json()).error, /front must be 1-8000 characters/);

  const tooManyResponses = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`q${index}`, 'answer']));
  const attempt = await post('/api/attempts', {
    topic_slug: TOPIC, deck_file: DECK_FILE, responses: tooManyResponses, mutation_id: 'm-many-responses',
  });
  assert.equal(attempt.status, 400);
  assert.match((await attempt.json()).error, /responses has too many entries/);

  const cardsAfter = await get('/api/state')
    .then((res) => res.json())
    .then((state) => state.topics.find((topic) => topic.slug === TOPIC).cards.length);
  assert.equal(cardsAfter, cardsBefore, 'rejected bounded fields must not create a card');
});

test('the suspend toggle takes no mutation_id either — it sets a flag', async () => {
  const card = await get('/api/state')
    .then((r) => r.json())
    .then((s) => s.topics.find((t) => t.slug === TOPIC).cards[0]);

  const res = await post('/api/cards', { topic_slug: TOPIC, card_id: card.id, suspended: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).suspended, true);

  await post('/api/cards', { topic_slug: TOPIC, card_id: card.id, suspended: false });
});

/* ------------------------------------------------------------------ */
/*  Routing, static files, and limits                                  */
/* ------------------------------------------------------------------ */

test('a malformed percent-escape is a 400, not a 500', async () => {
  // decodeURIComponent throws URIError on these. Unguarded, the server reported its own
  // fault (500) plus a stack trace for what is plainly a bad request.
  for (const path of ['/api/decks/%E0%A4%A/deck.json', '/media/videos/%ZZ', '/%E0%A4%A']) {
    const res = await get(path);
    assert.equal(res.status, 400, `${path} → ${res.status}`);
    assert.match((await res.json()).error, /percent-escape/);
  }
});

test('unrouted /api paths are 501, not 404 or a static file read', async () => {
  const res = await get('/api/not-a-route');
  assert.equal(res.status, 501);
  assert.equal((await res.json()).route, '/api/not-a-route');
});

test('GET / serves the cockpit shell', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('static requests cannot walk out of app/web', async () => {
  for (const path of ['/..%2F..%2Fpackage.json', '/../../package.json', '/..%5C..%5Cpackage.json']) {
    const res = await get(path);
    const raw = await res.text();
    assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`);
    assert.ok(!raw.includes('"studydeck"'), `${path} must not serve repo files`);
  }
});

test('sketch media only serves real, well-named files', async () => {
  // Encoded: fetch normalizes a literal ../../ out of the path before it is sent, so the
  // plain form would 404 for the wrong reason and never reach the name guard at all.
  assert.equal((await get(`/media/sketches/${TOPIC}/..%2F..%2Fstate.json`)).status, 404);
  assert.equal((await get(`/media/sketches/${TOPIC}/sketch-nope.png`)).status, 404);
  assert.equal((await get('/media/sketches/no-such-topic/sketch-a.png')).status, 404);
});

test('a body over the 1 MB ceiling is refused with a 413 the client can read', async () => {
  const before = rawAttemptLines().length;

  // The status, not just the refusal. Destroying the request in the same tick as the
  // rejection used to tear the socket down before the response flushed — measured five
  // runs, five ECONNRESETs — so the caller could not tell "too large" from "the network
  // dropped". readJsonBody pauses, and the body is discarded rather than the socket
  // destroyed; see the repeat test below for why one pass through here proves little.
  const res = await post('/api/attempts', {
    topic_slug: TOPIC,
    deck_file: DECK_FILE,
    notes: 'x'.repeat(1_200_000),
    responses: { q1: 'two', q2: 'false', q3: 'blue' },
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  assert.equal(rawAttemptLines().length, before, 'an oversized body must never be recorded');
});

test('EVERY oversized body is refused readably, not most of them', async () => {
  // The single assertion above passes most of the time, which is indistinguishable from
  // passing. The refusal was written and then thrown away by the RST from `req.destroy()`,
  // so the client saw EPIPE/ECONNRESET instead. Only a repeat can see that.
  //
  // The count is measured against the unfixed router, not reasoned about — twice, because
  // the first estimate was wrong. At 25 iterations it caught the bug in 5 of 15 runs; at
  // 200, in 8 of 10. That implies well under 1% per request in here, far below the 8.5% a
  // standalone probe showed, because in-suite requests reuse a warm keep-alive socket.
  //
  // So 25 would have shipped as a guard that misses two regressions in three. 200 costs
  // ~0.9s and catches ~80% per run — and since CI runs this on every push, a reverted fix
  // does not survive a pull request. Raising it further buys little for the time.
  const ITERATIONS = 200;
  const before = rawAttemptLines().length;
  const outcomes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    try {
      // The per-request deadline is not belt-and-braces. Reintroducing the drain deadlock
      // showed this loop hanging the whole runner past five minutes instead of failing:
      // `fetch` waits forever by default, so one stalled request blocks CI with no verdict.
      // A guard that hangs is worse than one that fails — this turns a stall into a result.
      const res = await fetch(`${BASE}/api/attempts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic_slug: TOPIC,
          deck_file: DECK_FILE,
          notes: 'x'.repeat(1_200_000),
          responses: { q1: 'two' },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      outcomes.push(res.status);
      await res.json();
    } catch (err) {
      // The regressions this guards: a transport error, or a stall, in place of the status.
      outcomes.push(err.cause?.code ?? err.name ?? err.message);
    }
  }

  const bad = outcomes.filter((o) => o !== 413);
  assert.deepEqual(bad, [], `every attempt must read the 413; got ${JSON.stringify(bad)}`);
  assert.equal(rawAttemptLines().length, before, 'no oversized body may be recorded');
});

/**
 * POST a body with `node:http`, resolving only when BOTH sides are finished — the request
 * stream closed and the response ended (or the connection failed).
 *
 * `fetch` cannot express this: it resolves as soon as the response HEADERS arrive, so a
 * `fetch`-based race is satisfied by the 413 alone while the upload is still draining
 * behind it. The hang this guards against lives on the upload side, which `fetch` has
 * already stopped watching by then.
 */
function postUntilBothSidesFinish(path, payload) {
  return new Promise((resolve) => {
    const seen = [];
    let reqDone = false;
    let resDone = false;
    const settle = () => { if (reqDone && resDone) resolve(seen.join(' + ')); };

    const req = request(
      { host: '127.0.0.1', port: server.address().port, method: 'POST', path,
        headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume(); // drain, or 'end' never fires
        res.on('end', () => { seen.push(`status ${res.statusCode}`); resDone = true; settle(); });
      },
    );
    req.on('error', (err) => {
      // A refusal the client could not read: still a settled outcome, not a hang.
      seen.push(`error ${err.code ?? err.message}`);
      reqDone = true; resDone = true; settle();
    });
    req.on('close', () => { reqDone = true; settle(); });
    req.on('socket', (socket) => {
      // Past MAX_DISCARD_BYTES the server destroys the socket while 12 MB is still being
      // written. Once the ClientRequest has already emitted 'close', Node reports that write
      // failure on the SOCKET, where an unlistened 'error' throws — so this test crashed
      // with an uncaught ECONNRESET on ~2 runs in 8, on the very teardown it exists to
      // observe. The outcome is already recorded by the handlers above; this only stops a
      // late write error from taking the process down.
      socket.on('error', () => {});
    });
    req.write(payload);
    req.end();
  });
}

test('a refused body far over the ceiling settles instead of hanging', async () => {
  // The deadlock that draining introduced and destroying had hidden: readJsonBody's `data`
  // listener stays attached after it rejects, and it used to `pause()` on every later
  // chunk — so the single `resume()` in discardBody survived exactly one chunk and the
  // request hung. Measured by reintroducing it: roughly 1 request in 40 stalled, and the
  // 413 was still logged every time, so the server looked healthy from its own log. It is
  // invisible while the socket is being torn down instead of drained.
  //
  // 12 MB is past MAX_DISCARD_BYTES, so this also walks the cap. The assertion is
  // deliberately about SETTLING, not which outcome: past the cap `discardBody` destroys,
  // and whether the client has already read the 413 by then is genuine timing. Asserting a
  // winner would be asserting a race. Hanging is the only real failure.
  //
  // Both sides must finish, which is why this does not use `post()`/`fetch`: fetch resolves
  // on response HEADERS, so the 413 alone would satisfy it while the upload is still
  // draining — and the upload side is exactly where the hang lives.
  //
  // `.unref()` is load-bearing: a pending timer keeps Node's event loop alive, so without
  // it this file sat idle for the full 10 seconds AFTER the race had already resolved —
  // 11.4s for a suite that runs in 2.5. The per-test duration reads 24ms either way, which
  // is what makes it easy to miss; only wall-clock against CPU (13%) shows the waiting.
  const payload = JSON.stringify({ topic_slug: TOPIC, deck_file: DECK_FILE, notes: 'x'.repeat(12_000_000) });
  const settled = await Promise.race([
    postUntilBothSidesFinish('/api/attempts', payload),
    new Promise((resolve) => { setTimeout(() => resolve('HUNG'), 10_000).unref(); }),
  ]);
  assert.notEqual(settled, 'HUNG', `a refused oversized body must never hang; got ${settled}`);
});

/* ------------------------------------------------------------------ */
/*  Rescheduling (roadmap B1)                                          */
/* ------------------------------------------------------------------ */

test('rescheduling moves a date and completes nothing', async () => {
  await post('/api/schedule/start', { topic_slug: TOPIC, started: '2026-07-01' });
  // A delta, not a zero: earlier tests in this file may legitimately have recorded stages.
  const stageEventsBefore = rawStageLines().length;

  const res = await post('/api/schedule/reschedule', {
    topic_slug: TOPIC,
    milestone_key: MILESTONE,
    date: '2026-08-01',
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.schedule.step_overrides[MILESTONE], '2026-08-01');

  const moved = body.stages.find((s) => s.key === MILESTONE);
  assert.equal(moved.due_date, '2026-08-01');
  assert.equal(moved.rescheduled, true);
  // The assertion this route exists to keep honest: moving a not-before date is not
  // progress. A reschedule that ticked anything off would invert hard rule 11.
  assert.equal(body.stages.some((s) => s.complete), false, 'a reschedule completed a stage');
  assert.equal(rawStageLines().length, stageEventsBefore, 'a reschedule wrote a stage event');
});

test('a reschedule takes no mutation_id, and clearing one restores the spec date', async () => {
  // It SETS a value, so a replay rewrites the identical file — an id here would advertise
  // a protection that is not running (rule 9), exactly like start and pause above.
  const replay = await post('/api/schedule/reschedule', {
    topic_slug: TOPIC,
    milestone_key: MILESTONE,
    date: '2026-08-01',
  });
  assert.equal(replay.status, 200);

  const cleared = await post('/api/schedule/reschedule', {
    topic_slug: TOPIC,
    milestone_key: MILESTONE,
    date: null,
  });
  assert.equal(cleared.status, 200);
  const body = await cleared.json();
  assert.equal(body.schedule.step_overrides[MILESTONE], undefined);
  assert.equal(body.stages.find((s) => s.key === MILESTONE).rescheduled, false);
});

test('re-anchoring to today leaves exactly one thing to do', async () => {
  // The case this exists for: back from a fortnight away with every stage owed at once.
  // A queue saying "do nine things today" is honest and useless.
  // Local calendar date, matching both the server's todayISO and the view's own helper.
  // toISOString() is UTC, so for part of the day in US time zones this test would submit
  // tomorrow's date and validate a contract the UI never exercises.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const res = await post('/api/schedule/reschedule', { topic_slug: TOPIC, from: today });
  assert.equal(res.status, 200);
  const body = await res.json();

  const nowStages = body.stages.filter((s) => s.state === 'now');
  assert.equal(nowStages.length, 1, 'a re-anchored pipeline should owe one thing, not nine');
  assert.equal(nowStages[0].due_date, today);
  assert.equal(body.stages.filter((s) => s.state === 'owed').length, 0);
  assert.equal(body.stages.some((s) => s.complete), false);
});

test('re-anchoring to a FUTURE date leaves nothing due yet', async () => {
  // Not a curiosity — it is the difference between a not-before date and a to-do list.
  // Written the other way round first, and the route was right: pushing the pipeline into
  // next month should mean nothing is owed today, not that something is.
  const res = await post('/api/schedule/reschedule', { topic_slug: TOPIC, from: '2099-01-01' });
  const body = await res.json();

  assert.equal(body.stages.filter((s) => s.state === 'now').length, 0);
  assert.equal(body.stages.filter((s) => s.state === 'owed').length, 0);
  assert.equal(body.stages.every((s) => s.complete === false), true);
});

test('a reschedule validates its input and refuses a topic that is not running', async () => {
  assert.equal((await post('/api/schedule/reschedule', { topic_slug: TOPIC })).status, 400);
  assert.equal(
    (await post('/api/schedule/reschedule', { topic_slug: TOPIC, milestone_key: 'no-such-stage', date: '2026-08-01' })).status,
    400,
  );
  // Matches the pattern, is not a date — the same trap /api/schedule/start guards against.
  assert.equal(
    (await post('/api/schedule/reschedule', { topic_slug: TOPIC, milestone_key: MILESTONE, date: '2026-02-31' })).status,
    400,
  );
  assert.equal((await post('/api/schedule/reschedule', { topic_slug: TOPIC, from: 'soon' })).status, 400);

  await post('/api/schedule/pause', { topic_slug: TOPIC, paused: true });
  const paused = await post('/api/schedule/reschedule', { topic_slug: TOPIC, from: '2026-08-10' });
  assert.equal(paused.status, 409, 'rescheduling a paused topic should refuse, not silently store dates');
  await post('/api/schedule/pause', { topic_slug: TOPIC, paused: false });
});

/* ------------------------------------------------------------------ */
/*  Resetting the start date (change 2026-11-05-schedule-reset)        */
/* ------------------------------------------------------------------ */

const rawSidecar = (name, slug = TOPIC) => {
  try {
    return readFileSync(join(FIXTURE_ROOT, slug, 'cockpit', name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

test('a reset restarts the pipeline: new start, no reschedules, completed stages reopened', async () => {
  await post('/api/schedule/start', { topic_slug: TOPIC, started: '2026-07-01' });
  const second = MILESTONES[1].key;
  for (const [key, id] of [[MILESTONE, 'reset-fixture-a'], [second, 'reset-fixture-b']]) {
    const done = await post('/api/schedule/stage', { topic_slug: TOPIC, milestone_key: key, action: 'complete', mutation_id: id });
    assert.ok([200, 201].includes(done.status));
  }
  await post('/api/schedule/reschedule', { topic_slug: TOPIC, milestone_key: second, date: '2026-09-01' });
  await post('/api/schedule/pause', { topic_slug: TOPIC, paused: true });

  // History the reset must not touch. Compared as raw bytes, so even a rewrite that kept
  // the same records would fail.
  const attemptsBefore = rawSidecar('attempts.jsonl');
  const reviewsBefore = rawSidecar('reviews.jsonl');
  const stageEventsBefore = rawStageLines().length;

  const res = await post('/api/schedule/reset', { topic_slug: TOPIC, started: '2026-11-05', mutation_id: 'reset-1' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.schedule.started, '2026-11-05');
  assert.equal(body.schedule.paused, false, 'a reset puts the topic back on the clock');
  assert.deepEqual(body.schedule.step_overrides, {}, 'old reschedules point at the old anchor');
  assert.deepEqual([...body.reopened].sort(), [MILESTONE, second].sort());
  assert.equal(body.stages.some((s) => s.complete), false, 'every stage is owed again');

  // Reopened by APPENDED undo events, never by rewriting the log (hard rule 11).
  // Then one `reset` marker, last, under the request's own id: what a replay looks for.
  const appended = rawStageLines().slice(stageEventsBefore);
  assert.equal(appended.length, 3);
  assert.ok(appended.slice(0, 2).every((e) => e.action === 'undo' && e.note === 'schedule reset'));
  assert.deepEqual(
    { action: appended[2].action, mutation_id: appended[2].mutation_id, milestone_key: appended[2].milestone_key },
    { action: 'reset', mutation_id: 'reset-1', milestone_key: undefined },
  );

  assert.equal(rawSidecar('attempts.jsonl'), attemptsBefore, 'a reset rewrote attempt history');
  assert.equal(rawSidecar('reviews.jsonl'), reviewsBefore, 'a reset rewrote review history');
});

test('a replayed reset appends nothing', async () => {
  const before = rawStageLines().length;
  const replay = await post('/api/schedule/reset', { topic_slug: TOPIC, started: '2026-11-05', mutation_id: 'reset-1' });
  assert.equal(replay.status, 200);
  assert.equal(rawStageLines().length, before, 'a replay must not append a second undo');
  assert.equal((await replay.json()).schedule.started, '2026-11-05');
});

test('a reset replayed AFTER new progress leaves that progress alone', async () => {
  // Codex review of PR #111: per-stage ids only dedupe the stages the ORIGINAL reset
  // reopened. A response lost after the write, then a stage completed and a date moved,
  // then the client's retry: the retry must recognise the reset as done, not run again
  // and undo the work recorded since.
  const id = 'reset-after-progress';
  assert.equal((await post('/api/schedule/reset', { topic_slug: TOPIC, started: '2026-11-05', mutation_id: id })).status, 200);

  const done = await post('/api/schedule/stage', {
    topic_slug: TOPIC, milestone_key: MILESTONE, action: 'complete', mutation_id: 'progress-after-reset',
  });
  assert.ok([200, 201].includes(done.status));
  await post('/api/schedule/reschedule', { topic_slug: TOPIC, milestone_key: MILESTONES[2].key, date: '2026-12-01' });
  const scheduleBefore = rawSidecar('schedule.json');
  const stagesBefore = rawStageLines().length;

  const replay = await post('/api/schedule/reset', { topic_slug: TOPIC, started: '2026-11-05', mutation_id: id });
  assert.equal(replay.status, 200);
  assert.equal(rawStageLines().length, stagesBefore, 'the replay appended an undo over newer progress');
  assert.equal(rawSidecar('schedule.json'), scheduleBefore, 'the replay rewrote the schedule');
  const body = await replay.json();
  assert.equal(body.stages.find((s) => s.key === MILESTONE).complete, true);
});

test('a reset validates its input before writing anything', async () => {
  const scheduleBefore = rawSidecar('schedule.json');
  const stagesBefore = rawStageLines().length;

  assert.equal((await post('/api/schedule/reset', { topic_slug: TOPIC, started: '2026-02-31', mutation_id: 'reset-bad-date' })).status, 400);
  assert.equal((await post('/api/schedule/reset', { topic_slug: TOPIC, started: 'soon', mutation_id: 'reset-bad-word' })).status, 400);
  assert.equal((await post('/api/schedule/reset', { topic_slug: 'no-such-topic', mutation_id: 'reset-bad-topic' })).status, 400);

  assert.equal(rawSidecar('schedule.json'), scheduleBefore);
  assert.equal(rawStageLines().length, stagesBefore);
});
