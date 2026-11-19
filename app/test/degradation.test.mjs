// WHAT: What the cockpit does when Open Notebook is not there.
// WHY: The README says the external services are "optional in the sense that the cockpit
//      degrades honestly when they're unreachable — it reports the outage rather than
//      inventing a result". That was a claim about behaviour with nothing checking it,
//      and it is the kind of claim that rots quietly: a route that starts returning an
//      empty list instead of an error still looks fine in the browser, right up until you
//      conclude a notebook is empty when it is actually unreachable.
//
// This closes the testable half of the gap `routes.test.mjs` documents. What stays
// untestable is unchanged: nothing here asserts the SHAPE of an ON response, because that
// would mean pinning a stub of an API this repo does not control. Being down is not part
// of ON's API — it is part of ours.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-degrade-'));

// Not a real secret, and the point of half these assertions is that it never leaves the
// process. Named so that a grep for it in any output is unambiguous.
const FAKE_PASSWORD = 'degradation-test-password-never-real';
const FAKE_CLAUDE_KEY = 'degradation-test-claude-key-never-real';

/**
 * A socket we OWN, which accepts and then hangs up without answering.
 *
 * Three ways to point the client at "nothing", and only this one is airtight. A fixed low
 * port (1) is privileged, so no user service can be there — but a root one could, and the
 * bearer header would then be sent to a stranger. Binding an ephemeral port and closing it
 * leaves a window for something else to take it before the test connects. Holding the port
 * for the test's lifetime removes the class: nothing unrelated can occupy it, the
 * credential can only reach our own listener, and the connection dies at once instead of
 * hanging for the client's 15s timeout.
 *
 * A reset rather than a refusal is also the more realistic outage — a service that accepts
 * and then dies is what a wedged container looks like.
 */
const deadOn = createServer();
deadOn.on('connection', (socket) => socket.destroy());
await new Promise((resolve) => deadOn.listen(0, '127.0.0.1', resolve));
const DEAD_ON_PORT = deadOn.address().port;

// Must be set before config.mjs is loaded — it resolves everything once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${DEAD_ON_PORT}`;
process.env.STUDYDECK_ON_PASSWORD = FAKE_PASSWORD;
// The Claude API is pointed at the same owned, dead listener, for the same reason: the
// key header can only ever reach a socket this test holds.
process.env.STUDYDECK_CLAUDE_BASE_URL = `http://127.0.0.1:${DEAD_ON_PORT}`;
process.env.STUDYDECK_ANTHROPIC_API_KEY = FAKE_CLAUDE_KEY;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');

/** Every configured topic needs a tree: buildState reads all of them. */
for (const topic of config.topics) {
  const dir = join(FIXTURE_ROOT, topic.slug);
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1,
    slug: topic.slug,
    topic: 'Degradation Fixture',
    created: '2026-07-29',
    last_updated: null,
    domains: [{
      slug: 'fixture-domain',
      name: 'Fixture Domain',
      concepts: [{
        name: 'Fixture Concept',
        slug: 'degradation-fixture-concept',
        status: 'unexplored',
        confidence: 0,
        practice_count: 0,
        explain_count: 0,
        last_explained: null,
        last_practiced: null,
        details: ['a detail'],
      }],
    }],
  }, null, 2)}\n`);
}

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  deadOn.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const get = (path) => fetch(`${BASE}${path}`);

test('a dead Open Notebook is reported as unreachable, not as no data', async () => {
  const res = await get('/api/on/health');
  assert.equal(res.status, 200); // the health probe itself answering IS the honest outcome
  const body = await res.json();

  assert.equal(body.reachable, false);
  assert.equal(body.version, null, 'an unreachable service must not be given a version');
  assert.match(body.error, /unreachable/);
  assert.match(
    body.error,
    new RegExp(`127\\.0\\.0\\.1:${DEAD_ON_PORT}`),
    'the address that failed is the first thing worth knowing',
  );
});

test('a route that needs Open Notebook fails loudly instead of returning an empty list', async () => {
  // The failure mode this exists to prevent: `{ sources: [] }` with a 200, which reads as
  // "this notebook is empty" and is indistinguishable from a notebook that really is.
  const topic = config.topics.find((t) => t.notebookId);
  assert.ok(topic, 'the fixture config needs at least one topic with a notebook mapped');

  const res = await get(`/api/on/sources?topic=${topic.slug}`);
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.match(body.error, /Open Notebook/);
  assert.equal(body.sources, undefined, 'no invented payload alongside the error');
});

test('a chapter render cannot start without Open Notebook, and says so with its password kept', async () => {
  // Create reads the topic's sources first, so a dead Open Notebook stops it there: a 503
  // naming the service, no rendition prepared, and the credential nowhere on the wire.
  const topic = config.topics.find((t) => t.notebookId);
  const res = await fetch(`${BASE}/api/podcast/renders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic_slug: topic.slug, mutation_id: 'degradation-render', source_id: 'source:one',
      episode_profile: 'study-chapter', speaker_profile: 'tech_experts',
    }),
  });
  const wire = `${JSON.stringify([...res.headers])}\n${await res.text()}`;
  assert.equal(res.status, 503, wire);
  assert.match(JSON.parse(wire.slice(wire.indexOf('\n') + 1)).error, /^Open Notebook unreachable at /);
  assert.ok(!wire.includes(FAKE_PASSWORD), 'create leaked the Open Notebook password');
  assert.equal(existsSync(join(FIXTURE_ROOT, topic.slug, 'cockpit', 'audio')), false, 'nothing was prepared');
});

test('the podcast view degrades to an error, never to an empty episode list', async () => {
  const res = await get('/api/on/podcast');
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.match(body.error, /Open Notebook/);
  assert.equal(body.episodes, undefined);
});

test('the study loop keeps working with every external service down', async () => {
  // This is what "optional" has to mean. Curriculum, schedule and mastery live on local
  // disk; if a dead notebook could take out /api/state, the cockpit would be unusable
  // offline and the word "optional" would be false.
  const state = await get('/api/state');
  assert.equal(state.status, 200);
  const body = await state.json();
  assert.ok(body.topics.length > 0);

  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
});

test('one unreadable topic is named as missing, and the other topics keep serving', async () => {
  // A 500 here blanks every view for every topic, the healthy ones included. Skipping the
  // broken topic without saying so would be worse in a quieter way: smaller totals that
  // read as less work done. So the response must both keep serving and name what is gone.
  const [broken, ...healthy] = config.topics;
  const path = join(FIXTURE_ROOT, broken.slug, 'state.json');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, '{ "version": 1, "domains": [ this is not json');
  try {
    const res = await get('/api/state');
    assert.equal(res.status, 200, 'one damaged topic must not fail the whole response');
    const body = await res.json();

    const served = body.topics.map((t) => t.slug);
    assert.ok(!served.includes(broken.slug), 'the damaged topic is not served as if it were whole');
    for (const t of healthy) assert.ok(served.includes(t.slug), `${t.slug} is still served`);

    assert.equal(body.incomplete, true);
    assert.deepEqual(body.unavailable_topics.map((t) => t.slug), [broken.slug]);
    assert.ok(body.unavailable_topics[0].error.length > 0, 'the cause travels with the slug');
  } finally {
    writeFileSync(path, original);
  }

  // Control: with the file restored, nothing is reported missing.
  const body = await (await get('/api/state')).json();
  assert.equal(body.incomplete, false);
  assert.deepEqual(body.unavailable_topics, []);
  assert.equal(body.topics.length, config.topics.length);
});

/**
 * Run `fn` with one JSONL row in a topic's cockpit sidecar, then remove the file. The
 * fixture topics start with no sidecars, so removing it restores the healthy state.
 */
async function withSidecarRow(slug, file, row, fn) {
  const path = join(FIXTURE_ROOT, slug, 'cockpit', file);
  writeFileSync(path, `${JSON.stringify(row)}\n`);
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

const healthFor = async (slug) => {
  const body = await (await get('/api/health')).json();
  return { status: body.status, topic: body.integrity.find((t) => t.topic_slug === slug) };
};

const stuckNote = (stage) => ({
  operation_id: 'open-notebook-note-degradation-fixture',
  origin_mutation_id: 'm-degradation-note',
  mutation_id: `m-degradation-note:note:1:${stage}`,
  revision: 1,
  ts: '2026-11-10T12:00:00.000Z',
  kind: 'open_notebook_note',
  stage,
  local_result: { note_title: 'Fixture highlight [StudyDeck abc123]' },
});

test('an Open Notebook write with an unconfirmed outcome makes health degraded, and names it', async () => {
  // The count alone was already in the response, and health still said ok: a write that
  // may have landed in Open Notebook, and that the cockpit will not repeat, was invisible.
  const slug = config.topics[0].slug;
  await withSidecarRow(slug, 'operations.jsonl', stuckNote('ambiguous'), async () => {
    const { status, topic } = await healthFor(slug);
    assert.equal(status, 'degraded');
    assert.deepEqual(topic.operations.unresolved_list, [{
      operation_id: 'open-notebook-note-degradation-fixture',
      kind: 'open_notebook_note',
      stage: 'ambiguous',
      ts: '2026-11-10T12:00:00.000Z',
      label: 'Fixture highlight [StudyDeck abc123]',
    }]);
  });
});

test('a completed Open Notebook write leaves health ok', async () => {
  // Control for the case above: the same row, finished, is not a fault.
  const slug = config.topics[0].slug;
  await withSidecarRow(slug, 'operations.jsonl', stuckNote('complete'), async () => {
    const { status, topic } = await healthFor(slug);
    assert.equal(status, 'ok');
    assert.equal(topic.operations.unresolved, 0);
  });
});

const gradedAttempt = (fields) => ({
  attempt_id: 'att-degradation', revision: 0, mutation_id: 'm-degradation-attempt', status: 'final',
  concept_slug: 'degradation-fixture-concept', mastery_applied: false, ...fields,
});

test('a graded attempt whose mastery never applied makes health degraded', async () => {
  const slug = config.topics[0].slug;
  await withSidecarRow(slug, 'attempts.jsonl', gradedAttempt({}), async () => {
    const { status, topic } = await healthFor(slug);
    assert.equal(topic.attempts.mastery_unapplied, 1);
    assert.equal(status, 'degraded');
  });
});

test('a graded attempt whose mastery settlement is ambiguous is counted once, as ambiguous', async () => {
  // An ambiguous settlement also leaves mastery_applied false. Counting it as unapplied
  // too would give it the unapplied advice, which is exactly what must not happen to it.
  const slug = config.topics[0].slug;
  await withSidecarRow(slug, 'attempts.jsonl', gradedAttempt({ mastery_settlement: { stage: 'ambiguous' } }), async () => {
    const { status, topic } = await healthFor(slug);
    assert.equal(topic.attempts.mastery_ambiguous, 1);
    assert.equal(topic.attempts.mastery_unapplied, 0);
    assert.equal(status, 'degraded');
  });
});

test('assessments that never update mastery by design leave health ok', async () => {
  // A finished fact-check only makes cards, and a confirmed essay with no concept has
  // nothing to settle: both stay mastery_applied: false for good. Neither owes anything,
  // so reporting them would put a permanent false alarm on every view.
  const slug = config.topics[0].slug;
  const cases = {
    'completed fact-check': gradedAttempt({ kind: 'factcheck' }),
    'essay with no concept': gradedAttempt({ kind: 'essay', concept_slug: null }),
  };
  for (const [name, attempt] of Object.entries(cases)) {
    await withSidecarRow(slug, 'attempts.jsonl', attempt, async () => {
      const { status, topic } = await healthFor(slug);
      assert.equal(topic.attempts.mastery_unapplied, 0, name);
      assert.equal(status, 'ok', name);
    });
  }
});

test('a final fact-check whose cards were never created makes health degraded', async () => {
  const slug = config.topics[0].slug;
  const owed = {
    attempt_id: 'degradation-factcheck', kind: 'factcheck', status: 'final', ts: '2026-11-10T12:00:00.000Z',
    factcheck_proposal: { source_id: 'source:fixture', section: 'all' },
    factcheck_adjudication: { results: [] },
  };
  await withSidecarRow(slug, 'attempts.jsonl', owed, async () => {
    const { status, topic } = await healthFor(slug);
    assert.equal(status, 'degraded');
    assert.equal(topic.attempts.factcheck_cards_owed, 1);
  });
  // Control: the same attempt with its cards made leaves health ok.
  await withSidecarRow(slug, 'attempts.jsonl', { ...owed, factcheck_cards: { status: 'complete', card_ids: [] } }, async () => {
    assert.equal((await healthFor(slug)).status, 'ok');
  });
});

test('Recovery keeps listing local work while Open Notebook is down, and reconcile says why it cannot check', async () => {
  const slug = config.topics[0].slug;
  const ledger = join(FIXTURE_ROOT, slug, 'cockpit', 'operations.jsonl');
  await withSidecarRow(slug, 'operations.jsonl', stuckNote('ambiguous'), async () => {
    const list = await get('/api/recovery');
    assert.equal(list.status, 200);
    const listed = (await list.json()).topics.find((t) => t.topic_slug === slug);
    assert.deepEqual(listed.needs_action.map((item) => item.operation_id), ['open-notebook-note-degradation-fixture']);

    const before = readFileSync(ledger, 'utf8');
    const res = await fetch(`${BASE}/api/recovery/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic_slug: slug, operation_id: 'open-notebook-note-degradation-fixture' }),
    });
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.match(JSON.parse(text).error, /Open Notebook/);
    assert.ok(!text.includes(FAKE_PASSWORD), 'the password leaked into a reconcile error');
    assert.equal(readFileSync(ledger, 'utf8'), before, 'an unreachable check appended to the ledger');
  });
});

test('the Open Notebook password never appears in a response, especially an error one', async () => {
  // Rule 6, checked on the path where secrets actually leak: an error message built by
  // string-joining whatever was in scope. onFetch attaches the bearer itself and the
  // failure text is composed from the URL and the reason, never the header.
  //
  // HEADERS TOO, not just bodies: a proxy route that forwarded an upstream header, or a
  // debug header added later, would sail past a body-only check while putting the
  // credential on the wire in the place least likely to be read.
  const paths = ['/api/on/health', '/api/on/podcast', '/api/on/sources?topic=' + config.topics[0].slug, '/api/health', '/api/state'];

  for (const path of paths) {
    const res = await get(path);
    const wire = `${JSON.stringify([...res.headers])}\n${await res.text()}`;
    assert.ok(!wire.includes(FAKE_PASSWORD), `${path} leaked the Open Notebook password`);
  }
});

test('/api/health reports whether the secret resolved, never the secret', async () => {
  const res = await get('/api/health');
  const body = await res.json();
  assert.equal(body.onPassword, 'loaded');
  assert.ok(!`${JSON.stringify([...res.headers])}${JSON.stringify(body)}`.includes(FAKE_PASSWORD));
});

test('a dead Claude API is reported as unreachable, and the study loop does not notice', async () => {
  const res = await get('/api/roles/health');
  assert.equal(res.status, 200); // the probe answering IS the honest outcome
  const body = await res.json();

  assert.equal(body.configured, true);
  assert.equal(body.reachable, false);
  assert.equal(body.authorized, false);
  assert.match(body.error, /Claude API is unreachable/);

  assert.equal((await get('/api/state')).status, 200);
});

test('the Claude API key never appears in a response, especially an error one', async () => {
  for (const path of ['/api/roles/health', '/api/health', '/api/state']) {
    const res = await get(path);
    const wire = `${JSON.stringify([...res.headers])}\n${await res.text()}`;
    assert.ok(!wire.includes(FAKE_CLAUDE_KEY), `${path} leaked the Claude API key`);
  }
});
