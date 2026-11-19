// WHAT: Durable standalone podcast generation for a mapped StudyDeck notebook.
// WHY: The route formerly accepted arbitrary/no notebook ids, leaving no truthful owner
//      for a recovery record. It now writes to the mapped topic's operation ledger and
//      reconciles a response-lost generate by deterministic episode name.
//      The job poll is driven here too: what the cockpit tells the Podcast view about a
//      job decides whether it keeps polling, so a queued job must never read as finished.
//      The stub serves Open Notebook's own status words (surreal_commands: new, running,
//      completed, failed, canceled; `unknown` when it has no record); the assertions are
//      on what THIS app answers, not on ON's reply.
//      Each render is named for its own request (a rendition), so an older recording with
//      the same title can never settle a newer request whose outcome was lost. The stub
//      also answers the read-only preflight, which must refuse an unusable profile before
//      any render is sent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podcastProviderFixture } from './fixtures/podcast-provider.mjs';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcast-egress-'));
const sent = [];
const episodes = [];
let acceptThenDrop = false;
let dropBeforeAcceptance = false;
let incompleteProfile = false;
let languageModelName;
let jobReply = { status: 'new' };

const bodyOf = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try { resolve(JSON.parse(raw)); } catch { resolve(null); }
  });
});

const onStub = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://stub').pathname);
  const body = await bodyOf(req);
  sent.push(`${req.method} ${pathname}`);
  if (podcastProviderFixture(req, res, { incomplete: incompleteProfile, languageModelName })) return;
  if (req.method === 'GET' && pathname === '/api/podcasts/episodes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(episodes));
  }
  if (req.method === 'POST' && pathname === '/api/podcasts/generate') {
    if (dropBeforeAcceptance) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"lost before Open Notebook accepted it"}');
    }
    episodes.push({ id: `episode:${episodes.length + 1}`, name: body.episode_name, job_status: 'queued' });
    if (acceptThenDrop) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"response deliberately lost after acceptance"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"job_id":"job:standalone","status":"queued"}');
  }
  if (req.method === 'GET' && pathname === '/api/podcasts/jobs/job:poll') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ job_id: 'job:poll', ...jobReply }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'podcast-egress-password-never-real';
// The preflight also reads the local TTS voice list and Ollama's model tags. Both point
// at the same recorder, so no test reaches a real service.
process.env.STUDYDECK_TTS_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;
process.env.STUDYDECK_OLLAMA_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
const { appendOperation } = await import('../lib/sidecar.mjs');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the recorder');
const TOPIC = config.topics.find((topic) => topic.notebookId);
mkdirSync(join(FIXTURE_ROOT, TOPIC.slug, 'cockpit'), { recursive: true });

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const request = (mutationId) => fetch(`${base}/api/on/podcast/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    episode_profile: 'study-chapter', speaker_profile: 'fixture-voices',
    episode_name: 'Fixture standalone episode', notebook_id: TOPIC.notebookId, mutation_id: mutationId,
  }),
});

const postCount = () => sent.filter((entry) => entry === 'POST /api/podcasts/generate').length;

test('a mapped standalone generation replays its accepted job without a second POST', async () => {
  sent.length = 0;
  episodes.length = 0;
  acceptThenDrop = false;

  assert.equal((await request('standalone-create')).status, 202);
  assert.equal(postCount(), 1, 'control: the initial render reached Open Notebook');

  sent.length = 0;
  const replay = await request('standalone-create');
  const body = await replay.json();
  assert.equal(replay.status, 202);
  assert.equal(body.replayed, true);
  assert.equal(postCount(), 0, `replay started another render: ${sent.join(', ')}`);
});

test('a response-lost standalone render reconciles by episode name before retrying', async () => {
  sent.length = 0;
  episodes.length = 0;
  acceptThenDrop = true;

  assert.equal((await request('standalone-lost-response')).status, 500);
  assert.equal(postCount(), 1);

  acceptThenDrop = false;
  sent.length = 0;
  const replay = await request('standalone-lost-response');
  const body = await replay.json();
  assert.equal(replay.status, 202);
  assert.equal(body.replayed, true);
  assert.equal(postCount(), 0, `recovery started another render: ${sent.join(', ')}`);
});

test('an unmapped notebook is rejected before any render request', async () => {
  sent.length = 0;
  const res = await fetch(`${base}/api/on/podcast/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      episode_profile: 'study-chapter', speaker_profile: 'fixture-voices', episode_name: 'No owner',
      notebook_id: 'notebook:unmapped', mutation_id: 'standalone-unmapped',
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(postCount(), 0);
});

test('an older rendition cannot settle a new ambiguous render with the same title', async () => {
  episodes.length = 0;
  acceptThenDrop = false;
  assert.equal((await request('rendition-old')).status, 202);
  dropBeforeAcceptance = true;
  assert.equal((await request('rendition-new')).status, 500);
  dropBeforeAcceptance = false;

  sent.length = 0;
  const retry = await request('rendition-new');
  assert.equal(retry.status, 409, 'the older recording settled a request it does not belong to');
  assert.match((await retry.json()).error, /ambiguous/);
  assert.equal(postCount(), 0, 'an ambiguous operation never auto-creates another render');
});

test('an incomplete selected profile is refused before generation', async (t) => {
  incompleteProfile = true;
  t.after(() => { incompleteProfile = false; });
  sent.length = 0;
  const res = await request('missing-outline');
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /outline/i);
  assert.equal(postCount(), 0, `an unusable profile was sent for rendering: ${sent.join(', ')}`);
  const ledger = readFileSync(join(FIXTURE_ROOT, TOPIC.slug, 'cockpit', 'operations.jsonl'), 'utf8');
  assert.equal(ledger.includes('"missing-outline"'), false, 'a refused request left an operation in the ledger');
});

test('a model registered without a tag matches the :latest that Ollama lists', async (t) => {
  languageModelName = 'fixture-language';
  t.after(() => { languageModelName = undefined; });
  sent.length = 0;
  const res = await request('untagged-model');
  assert.equal(res.status, 202, `a usable untagged model was refused: ${(await res.clone().text())}`);
  assert.equal(postCount(), 1);
});

// A request recorded before renditions existed: its episode_name is the caller's plain
// title, and its input_hash was computed over that title. This is the record the route
// wrote at 7ef47ff, rebuilt here, because a client may still replay its mutation_id.
const legacyStandalone = (mutation, stage, extra = {}) => {
  const title = 'Fixture standalone episode';
  const inputHash = createHash('sha256').update(JSON.stringify({
    notebook_id: TOPIC.notebookId, episode_profile: 'study-chapter', speaker_profile: 'fixture-voices',
    episode_name: title, briefing_suffix: null,
  })).digest('hex');
  appendOperation(TOPIC.slug, {
    operation_id: `podcast-standalone-${createHash('sha256').update(`${TOPIC.slug}\0${mutation}`).digest('hex')}`,
    origin_mutation_id: mutation, mutation_id: `${mutation}:podcast-standalone:${stage}`, revision: 0,
    ts: new Date().toISOString(), kind: 'podcast_standalone', topic_slug: TOPIC.slug, input_hash: inputHash,
    stage, local_result: { source_id: `notebook:${TOPIC.notebookId}`, episode_name: title }, ...extra,
  });
  return title;
};

test('a request accepted before renditions still replays its job', async () => {
  legacyStandalone('legacy-accepted', 'complete', { external: { job_id: 'job:legacy', status: 'queued' } });
  sent.length = 0;
  const res = await request('legacy-accepted');
  const body = await res.json();
  assert.equal(res.status, 202, `the replay was refused: ${JSON.stringify(body)}`);
  assert.equal(body.replayed, true);
  assert.equal(body.job_id, 'job:legacy');
  assert.equal(postCount(), 0);
});

test('a request left ambiguous before renditions is never settled by its plain title', async () => {
  const title = legacyStandalone('legacy-ambiguous', 'ambiguous');
  episodes.length = 0;
  episodes.push({ id: 'episode:plain', name: title, job_status: 'completed' });
  sent.length = 0;
  const res = await request('legacy-ambiguous');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ambiguous/, 'the replay was refused for its input, not for its outcome');
  assert.equal(postCount(), 0);
});

/** What the cockpit tells the Podcast view about job:poll while ON answers `reply`. */
const pollJob = async (reply) => {
  jobReply = reply;
  const res = await fetch(`${base}/api/on/podcast/jobs/${encodeURIComponent('job:poll')}`);
  assert.equal(res.status, 200);
  return res.json();
};

test('a job Open Notebook has queued but not started keeps the view polling', async () => {
  const job = await pollJob({ status: 'new' });
  assert.equal(job.terminal, false, 'a queued job was reported as finished');
  assert.equal(job.successful, false);
});

for (const status of ['canceled', 'unknown']) {
  test(`a job reported as ${status} with no error message is a failure that names its status`, async () => {
    const job = await pollJob({ status });
    assert.equal(job.terminal, true);
    assert.equal(job.successful, false, `${status} was reported as a successful render`);
    assert.equal(job.retryable, true);
    assert.match(String(job.error), new RegExp(status));
  });
}

test('controls: completed is a success, and failed passes its message through', async () => {
  const done = await pollJob({ status: 'completed' });
  assert.equal(done.terminal, true);
  assert.equal(done.successful, true);
  assert.equal(done.error, null);

  const failed = await pollJob({ status: 'failed', error_message: 'outline model stopped' });
  assert.equal(failed.successful, false);
  assert.equal(failed.error, 'outline model stopped');
});

// Open Notebook sends `error_message: ''` rather than leaving the field out (seen live on
// 2026-11-09, on a running job). A blank message must read as no message.
for (const [status, blank] of [['failed', ''], ['canceled', ''], ['failed', '   ']]) {
  test(`a ${status} job with a blank error message still says what happened (${JSON.stringify(blank)})`, async () => {
    const job = await pollJob({ status, error_message: blank });
    assert.equal(job.successful, false);
    assert.match(String(job.error), new RegExp(`reported the job as ${status}`), 'the view would print an empty failure');
  });
}

test('a blank error message on a running or completed job is no error at all', async () => {
  const running = await pollJob({ status: 'running', error_message: '' });
  assert.equal(running.terminal, false);
  assert.equal(running.error, null);

  const done = await pollJob({ status: 'completed', error_message: '' });
  assert.equal(done.successful, true);
  assert.equal(done.error, null);
});
