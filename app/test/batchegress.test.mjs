// WHAT: What a `dry_run: true` batch SENDS — specifically, that it sends nothing that
//       changes anything.
// WHY:  CodeRabbit on #39, and it was right. `podcastbatch.test.mjs` pins the report's
//       contents, but the promise the flag actually makes lives in the router: the early
//       return sits above the delete loop and the generate loop, and if a later edit moves
//       it below either one, a preview silently starts deleting episodes and firing
//       half-hour renders. Nothing was watching that line.
//
// HOW THIS DOES NOT BREAK THE "no ON stubs" RULE, because the distinction is the whole
// reason this file can exist at all. The convention (AGENTS.md, "Being DOWN is our
// behaviour; being UP is theirs") forbids asserting the SHAPE OF AN ON RESPONSE — that
// pins a stub of an API this repo does not control, and ON's routes have already churned
// twice. Nothing here asserts what ON returns. The stub below is a RECORDER: every
// assertion is about the requests THIS APP SENT, which is ours, in exactly the way being
// unreachable is ours in degradation.test.mjs.
//
// What it therefore does NOT catch, stated so nobody reads more into a green run: if ON's
// `/api/sources` shape drifts, the stub keeps feeding sources, this file keeps passing, and
// the real route 400s on an empty notebook long before it reaches the code under test.
//
// That is still true and always will be — a hermetic suite cannot see an upstream change.
// It is no longer only a warning, though: `npm run verify:live` probes the live shape
// (lib/oncontract.mjs). Do not move that check in here. This file has to keep passing with
// Open Notebook switched off, and a probe that needs ON up is the opposite kind of tool.
//
// The control test is the load-bearing half. A dry-run assertion of the form "no DELETE was
// sent" passes trivially if the request 400'd, or if the fixture never produced a deletable
// row — so the same fixture is run WITHOUT the flag and asserted to send both a DELETE and
// a generate. That is what proves the fixture reaches the mutating code, and therefore that
// the dry run's silence means something.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podcastProviderFixture } from './fixtures/podcast-provider.mjs';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-egress-'));

const FAKE_PASSWORD = 'egress-test-password-never-real';

/** Every request this app sent to "Open Notebook", in order: `METHOD /path`. */
const sent = [];

const SOURCE_ID = 'source:egress-fixture';
const SOURCE_TITLE = 'Chapter 1 — Egress Fixture';
const STALE_EPISODE_ID = 'episode:egress-stale';

// Assigned once `episodeNameFor` and the topic are available, which cannot happen until the
// stub is listening (its port decides the base URL, which must be set before config loads).
// The stub reads this at request time, so it is always populated by then.
let STALE_EPISODE_NAME;
let deleteFails = false;
let staleStatus = 'failed';
// Off by default, so the earlier tests see only the stale row. When on, an accepted
// generate leaves an episode under the name it was sent, as Open Notebook does.
let recordRenders = false;
let dropBeforeAcceptance = false;
// The local voice service answering 500, so the preflight cannot pass.
let voicesDown = false;
const rendered = [];

/**
 * A recorder wearing Open Notebook's URLs.
 *
 * It answers the four calls the batch makes with the minimum each client function needs to
 * get past its own mapping — no more, because the bodies are not what is under test. The
 * episode it serves is deliberately the WORST case for a preview: the tagged name for this
 * topic+source, no audio, terminally failed. That makes the source a retry target AND makes
 * the row deletable, so a dry run has something to destroy if the ordering is ever wrong.
 */
const onStub = createServer(async (req, res) => {
  // Decoded, because ON ids contain a colon and the client percent-encodes them into the
  // path. Matching and asserting on the decoded form keeps both readable and keeps the
  // fixture's ids the same string everywhere.
  const pathname = decodeURIComponent(new URL(req.url, 'http://stub').pathname);
  sent.push(`${req.method} ${pathname}`);
  if (voicesDown && pathname === '/v1/audio/voices') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end('{"detail":"voice service down"}');
  }
  if (podcastProviderFixture(req, res)) return;

  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && pathname === '/api/sources') {
    return json([{ id: SOURCE_ID, title: SOURCE_TITLE }]);
  }
  if (req.method === 'GET' && pathname === `/api/sources/${SOURCE_ID}`) {
    return json({ id: SOURCE_ID, title: SOURCE_TITLE, full_text: 'Body text for the render.' });
  }
  if (req.method === 'GET' && pathname === '/api/podcasts/episodes') {
    return json([{ id: STALE_EPISODE_ID, name: STALE_EPISODE_NAME, job_status: staleStatus }, ...rendered]);
  }
  if (req.method === 'DELETE' && pathname === `/api/podcasts/episodes/${STALE_EPISODE_ID}`) {
    if (deleteFails) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"temporary delete failure"}');
    }
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'POST' && pathname === '/api/podcasts/generate') {
    if (dropBeforeAcceptance) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"lost before Open Notebook accepted it"}');
    }
    if (recordRenders) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      rendered.push({ id: `episode:rendered-${rendered.length + 1}`, name: JSON.parse(raw).episode_name, job_status: 'completed' });
    }
    return json({ job_id: 'job:egress-stub', status: 'queued' });
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

// Both must be set before config.mjs is imported — it resolves everything once, at import
// time, into consts. The learn root is redirected too: this route does not read the study
// tree, but nothing in a test should be one refactor away from writing to the real one.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = FAKE_PASSWORD;
// The preflight's voice list and model tags come from the same recorder.
process.env.STUDYDECK_TTS_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;
process.env.STUDYDECK_OLLAMA_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;

const { config } = await import('../lib/config.mjs');
const { episodeNameFor } = await import('../lib/podcastbatch.mjs');
const { handleRequest } = await import('../router.mjs');

/** A topic with a notebook mapped — an unmapped one 400s before any of this runs. */
const TOPIC = config.topics.find((t) => t.notebookId).slug;
STALE_EPISODE_NAME = episodeNameFor(TOPIC, SOURCE_ID, SOURCE_TITLE);

// The worker pre-flight shells out to `docker logs`, so on this machine it would spend 12s
// failing to find a stub episode name and on CI it would return 'unavailable' — a test
// whose duration and path depend on whether Docker is installed. Clearing the container
// name takes the documented 'unavailable' branch immediately, everywhere. The probe itself
// is tested in workerhealth.test.mjs; what matters here is only that a generate was SENT.
config.openNotebook.workerContainer = null;

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * One batch request, with the no-CORS check folded in so every response here gets it.
 *
 * Why here as well as in `guard.test.mjs`: the headers are set once at the top of
 * `handleRequest`, but nothing stops a *route* adding its own later, and the absence of a
 * CSRF token rests entirely on no response ever allowing an origin (AGENTS.md rule 12). It
 * costs two assertions to stop this route being the one that quietly breaks that argument.
 */
const batch = async (body) => {
  const res = await fetch(`${base}/api/on/podcast/generate-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic_slug: TOPIC,
      episode_profile: 'study-chapter',
      speaker_profile: 'tech_experts',
      ...(body.dry_run ? {} : { mutation_id: 'batch-egress-mutation' }),
      ...body,
    }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
  return res;
};

const mutating = () => sent.filter((r) => !r.startsWith('GET '));

test('a dry run with a deletable target sends no DELETE and no generate', async () => {
  sent.length = 0;
  const res = await batch({ retry_only: true, dry_run: true });
  const body = await res.json();

  // The fixture really is the dangerous case: one target, one row the real run would drop.
  assert.equal(res.status, 200);
  assert.equal(body.dry_run, true);
  assert.equal(body.would_generate, 1);
  assert.equal(body.would_delete, 1);
  assert.deepEqual(body.would_delete_episodes, [
    { episode_id: STALE_EPISODE_ID, name: STALE_EPISODE_NAME, status: 'failed' },
  ]);

  // The assertion this file exists for.
  assert.deepEqual(mutating(), [], `a preview sent a mutating request: ${mutating().join(', ')}`);
});

test('a dry run of a FULL batch sends no generate either', async () => {
  sent.length = 0;
  const res = await batch({ dry_run: true });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.retry_only, false);
  assert.equal(body.would_generate, 1);
  assert.deepEqual(mutating(), [], `a preview sent a mutating request: ${mutating().join(', ')}`);
});

test('the SAME fixture without the flag does delete and does generate', async () => {
  // Without this, the two tests above would pass on a route that 400s early or on a fixture
  // that never had anything to delete — proving nothing about the ordering they exist for.
  sent.length = 0;
  const res = await batch({ retry_only: true, mutation_id: 'batch-delete-control' });

  assert.equal(res.status, 202);
  assert.ok(
    sent.includes(`DELETE /api/podcasts/episodes/${STALE_EPISODE_ID}`),
    `the real run did not delete the stale row: ${sent.join(', ')}`,
  );
  assert.ok(
    sent.includes('POST /api/podcasts/generate'),
    `the real run did not fire a render: ${sent.join(', ')}`,
  );
});

test('a retry leaves an episode Open Notebook has queued but not started alone', async (t) => {
  // `new` is surreal_commands' status for a job the worker has not picked up yet. The
  // control above runs this same fixture at `failed` and requires the DELETE and the
  // generate, so the silence here means the row was seen as in flight.
  sent.length = 0;
  staleStatus = 'new';
  t.after(() => { staleStatus = 'failed'; });
  const res = await batch({ retry_only: true, mutation_id: 'batch-queued-episode' });

  assert.ok(res.status < 300, `retry run answered ${res.status}`);
  assert.deepEqual(mutating(), [], `a retry touched a queued render: ${mutating().join(', ')}`);
});

test('an uncertain stale deletion blocks that source from another render', async (t) => {
  sent.length = 0;
  deleteFails = true;
  t.after(() => { deleteFails = false; });
  const res = await batch({ retry_only: true, mutation_id: 'batch-delete-ambiguous' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.count, 0);
  assert.equal(body.delete_errors.length, 1);
  assert.equal(body.delete_errors[0].ambiguous, true);
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 0,
    `an uncertain delete still generated: ${sent.join(', ')}`);
});

test('a repeated batch mutation replays its child operation without another render request', async () => {
  sent.length = 0;
  const res = await batch({ mutation_id: 'batch-replay' });
  assert.equal(res.status, 202);
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 1);

  sent.length = 0;
  const replay = await batch({ mutation_id: 'batch-replay' });
  const body = await replay.json();
  assert.equal(replay.status, 202);
  assert.equal(body.episodes[0].replayed, true);
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 0,
    `replayed batch generated again: ${sent.join(', ')}`);
});

test("a chapter's earlier recording cannot settle a re-render whose outcome was lost", async (t) => {
  recordRenders = true;
  t.after(() => { recordRenders = false; dropBeforeAcceptance = false; rendered.length = 0; });
  // The control: an accepted render leaves a finished episode for this chapter.
  assert.equal((await batch({ mutation_id: 'batch-rendition-old' })).status, 202);
  assert.equal(rendered.length, 1);

  dropBeforeAcceptance = true;
  await batch({ mutation_id: 'batch-rendition-new' });
  dropBeforeAcceptance = false;

  sent.length = 0;
  const retry = await (await batch({ mutation_id: 'batch-rendition-new' })).json();
  assert.equal(retry.episodes[0].accepted, false, 'the older recording settled a re-render it does not belong to');
  assert.equal(retry.episodes[0].ambiguous, true);
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 0,
    `an ambiguous re-render was sent again: ${sent.join(', ')}`);
});

test('a chapter render accepted before renditions still replays its job', async () => {
  // The record the batch wrote at 7ef47ff, rebuilt: named for the chapter, with no rendition,
  // and hashed over that name. A client may still replay its batch mutation_id.
  const { appendOperation } = await import('../lib/sidecar.mjs');
  const mutation = 'batch-legacy-accepted';
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  appendOperation(TOPIC, {
    operation_id: `podcast-episode-${sha256(`${TOPIC}\0${mutation}\0${SOURCE_ID}`)}`,
    origin_mutation_id: mutation, mutation_id: `${mutation}:podcast:${SOURCE_ID}:complete`, revision: 0,
    ts: new Date().toISOString(), kind: 'podcast_episode', topic_slug: TOPIC,
    input_hash: sha256(JSON.stringify({
      source_id: SOURCE_ID, episode_name: STALE_EPISODE_NAME, episode_profile: 'study-chapter',
      speaker_profile: 'tech_experts', briefing_suffix: null, content_hash: sha256('Body text for the render.'),
    })),
    stage: 'complete', external: { job_id: 'job:legacy-chapter', status: 'queued' },
    local_result: { source_id: SOURCE_ID, title: SOURCE_TITLE, episode_name: STALE_EPISODE_NAME },
  });

  sent.length = 0;
  const body = await (await batch({ mutation_id: mutation })).json();
  assert.equal(body.episodes[0].accepted, true, `the replay was refused: ${JSON.stringify(body.episodes[0])}`);
  assert.equal(body.episodes[0].replayed, true);
  assert.equal(body.episodes[0].job_id, 'job:legacy-chapter');
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 0);
});

test('an accepted batch replays its jobs while the voice service is down', async (t) => {
  t.after(() => { voicesDown = false; });
  assert.equal((await batch({ mutation_id: 'batch-replay-voices-down' })).status, 202);

  // Replaying needs nothing from the voice service, so its outage must not strand the
  // accepted job ids behind a preflight.
  voicesDown = true;
  sent.length = 0;
  const replay = await batch({ mutation_id: 'batch-replay-voices-down' });
  const body = await replay.json();
  assert.equal(replay.status, 202, `the replay was refused: ${JSON.stringify(body)}`);
  assert.equal(body.episodes[0].replayed, true);
  assert.equal(sent.filter((entry) => entry === 'POST /api/podcasts/generate').length, 0);

  // The control: new work under the same outage is still refused before anything is sent.
  sent.length = 0;
  const fresh = await batch({ mutation_id: 'batch-new-voices-down' });
  assert.equal(fresh.status, 503);
  assert.deepEqual(mutating(), [], `new work was sent without a preflight: ${mutating().join(', ')}`);
});
