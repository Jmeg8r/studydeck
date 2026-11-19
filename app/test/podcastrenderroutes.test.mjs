// WHAT: The chapter renderer's HTTP routes: create, read, audio, resume and publish, driven
//       through the real handleRequest over node:http.
// WHY:  D5d1 tested podcastrender.mjs on fakes; these test what the routes add on top of it:
//       validation, status codes, replay behaviour, the missing-audio checks, and that
//       nothing falls through to the 501 catch-all. Nothing real is reached. One stub server
//       stands in for Open Notebook, Ollama and Speaches through the base-URL seams, and one
//       fake executable stands in for ffmpeg and ffprobe through STUDYDECK_FFMPEG/FFPROBE, as
//       CI has no ffmpeg. The stub's answers are INPUTS that get a request through, never
//       assertions about those services (.claude/rules/testing.md): if their shapes move,
//       these keep passing and the live render is what notices.
//       Renditions past rendering (qc_passed, published, failed, interrupted) are planted,
//       not rendered. A render started by a route ends quickly: the stub's /api/chat
//       answers text that is not JSON, so the first section fails its three tries.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { podcastProviderFixture } from './fixtures/podcast-provider.mjs';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcastrenderroutes-'));
const CHAPTER = 'Agents plan, act and observe. '.repeat(60);
const MODEL = 'fixture-language:latest';

// ffmpeg and ffprobe both answer -version; as ffprobe, any file probes as two seconds of
// audio, and each probe is logged so a test can show none ran.
const FAKE_AV = join(FIXTURE_ROOT, 'bin', 'fake-av');
const PROBES = join(FIXTURE_ROOT, 'bin', 'probes.log');
mkdirSync(join(FIXTURE_ROOT, 'bin'));
writeFileSync(PROBES, '');
writeFileSync(FAKE_AV, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('-version')) process.exit(0);
require('node:fs').appendFileSync(${JSON.stringify(PROBES)}, args.at(-1) + '\\n');
const size = require('node:fs').statSync(args.at(-1)).size;
process.stdout.write(JSON.stringify({ format: { duration: '2.0', size: String(size) }, streams: [{ codec_type: 'audio' }] }));
`);
chmodSync(FAKE_AV, 0o755);

// What /api/chat does; a test that needs a render held running swaps it for a gate.
let chat = async () => ({ message: { content: 'not json' } });
let ollamaDown = false;
const stubLog = [];
const stub = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const path = decodeURIComponent(url.pathname);
  stubLog.push(`${req.method} ${path}`);
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (path === '/api/sources' && req.method === 'GET') return send(200, [{ id: 'source:one', title: 'Chapter One' }]);
  if (path === '/api/sources/source:one') return send(200, { id: 'source:one', title: 'Chapter One', full_text: CHAPTER });
  // A reset, as a wedged Ollama looks: the connection opens and dies without an answer.
  if (ollamaDown && (path === '/api/show' || path === '/api/tags')) return req.socket.destroy();
  if (path === '/api/show') return send(200, { model_info: { 'fixture.context_length': 32768 } });
  if (path === '/api/tags') return send(200, { models: [{ name: MODEL, digest: 'd'.repeat(64) }] });
  if (path === '/api/chat') return send(200, await chat());
  if (path === '/v1/audio/speech') return send(500, { error: 'not in these tests' });
  if (podcastProviderFixture(req, res)) return undefined;
  return send(404, { error: `stub has no ${path}` });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB = `http://127.0.0.1:${stub.address().port}`;

// Before config.mjs loads: it resolves all of these once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = STUB;
process.env.STUDYDECK_ON_PASSWORD = 'podcastrenderroutes-not-real';
process.env.STUDYDECK_OLLAMA_BASE_URL = STUB;
process.env.STUDYDECK_TTS_BASE_URL = STUB;
process.env.STUDYDECK_FFMPEG = FAKE_AV;
process.env.STUDYDECK_FFPROBE = FAKE_AV;

const { handleRequest } = await import('../router.mjs');
const { config } = await import('../lib/config.mjs');
const { idle } = await import('../lib/podcastrender.mjs');
const { digest, planChapter, PROMPT_VERSION } = await import('../lib/podcastquality.mjs');
const { podcastPreflight } = await import('../lib/opennotebook.mjs');
const TOPIC = config.topics[0].slug;
const AUDIO = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'audio');
// What the stub's profiles produce, so a planted rendition matches a fresh preflight and a
// resume compares like with like.
const CONFIGURATION = await podcastPreflight({ episodeProfile: 'study-chapter', speakerProfile: 'tech_experts' });

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await idle();
  for (const s of [server, stub]) { s.closeAllConnections(); await new Promise((resolve) => s.close(resolve)); }
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const post = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json() });

let counter = 0;
const createBody = (changes = {}) => ({
  topic_slug: TOPIC, mutation_id: `routes-${counter += 1}`, source_id: 'source:one',
  episode_profile: 'study-chapter', speaker_profile: 'tech_experts', ...changes,
});

// ---- Step 2: create (R1) and unmatched paths (R6) ----

test('create answers 202 with the rendition summary', async () => {
  const { status, body } = await json(await post('/api/podcast/renders', createBody()));
  await idle();
  assert.equal(status, 202, JSON.stringify(body));
  assert.match(body.rendition.id, /^render-[a-f0-9]{24}$/);
  assert.equal(body.rendition.topic_slug, TOPIC);
});

test('create replayed with the same mutation_id and input returns the same rendition', async () => {
  const request = createBody();
  const first = await json(await post('/api/podcast/renders', request));
  await idle();
  const second = await json(await post('/api/podcast/renders', request));
  await idle();
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.rendition.id, first.body.rendition.id);
});

test('create replayed with the same mutation_id and different input is a 409', async () => {
  const request = createBody();
  assert.equal((await post('/api/podcast/renders', request)).status, 202);
  await idle();
  const { status, body } = await json(await post('/api/podcast/renders', { ...request, episode_profile: 'other-profile' }));
  assert.equal(status, 409);
  assert.match(body.error, /different generation input/);
});

test('create refuses each malformed field with 400 before anything is prepared', async () => {
  const cases = {
    'unknown topic': { topic_slug: 'no-such-topic' },
    'missing source_id': { source_id: undefined },
    'source_id with a slash': { source_id: 'source/../one' },
    'missing mutation_id': { mutation_id: undefined },
    'mutation_id over 120 characters': { mutation_id: 'm'.repeat(121) },
    'empty episode_profile': { episode_profile: '' },
    'speaker_profile over 200 characters': { speaker_profile: 's'.repeat(201) },
    'speaker_profile not a string': { speaker_profile: 7 },
  };
  for (const [name, changes] of Object.entries(cases)) {
    const res = await post('/api/podcast/renders', createBody(changes));
    assert.equal(res.status, 400, name);
  }
});

test('a path under /api/podcast/renders that no route serves is a 404 naming the route group', async () => {
  const id = `render-${'a'.repeat(24)}`;
  const cases = [
    ['DELETE', `/api/podcast/renders/${id}`],
    ['POST', `/api/podcast/renders/${id}/rename`],
    ['GET', `/api/podcast/renders/${id}/resume`],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(`${BASE}${path}?topic=${TOPIC}`, { method, headers: { 'content-type': 'application/json' } });
    const body = await res.json();
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.match(body.error, /podcast render route/i, `${method} ${path}`);
  }
});

// ---- Planted renditions, for steps 3 to 6 ----

let planted = 0;
const RUNTIME = { model: MODEL, digest: 'd'.repeat(64), capacity: 32768, context_tokens: 16384, prompt_version: PROMPT_VERSION };
const CANDIDATE = Buffer.from('candidate audio bytes, not really mp3');

/** A valid manifest as a render would leave it; `changes` override any field. */
function rendition(changes = {}) {
  planted += 1;
  return {
    version: 1, id: `render-${digest(['routes', planted]).slice(0, 24)}`, topic_slug: TOPIC,
    mutation_id: `planted-${planted}`, input_hash: 'h'.repeat(64),
    input: { source_id: 'source:one', episode_profile: 'study-chapter', speaker_profile: 'tech_experts' },
    created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:00:00.000Z',
    stage: 'queued', source: { id: 'source:one', title: 'Chapter One', text: CHAPTER, sha256: digest(CHAPTER) },
    configuration: CONFIGURATION, runtime: RUNTIME, plan: planChapter(CHAPTER, { contextTokens: 16384 }),
    transcript: [], transcript_attempts: [], clips: [], timings: {}, progress: 'Queued',
    ...changes,
  };
}

/** The QC'd states: the candidate on disk, and the sha256 QC measured. */
const checked = (stage, changes = {}) => rendition({
  stage, progress: stage,
  audio_qc: { version: 1, passed: true, issues: [], repetitions: [], asset: { duration: 2, bytes: CANDIDATE.length, sha256: digest(CANDIDATE) } },
  ...changes,
});

/** Write a manifest (and, unless told not to, its candidate) to disk; returns its directory. */
function plant(m, { raw, candidate = Boolean(m.audio_qc) } = {}) {
  const dir = join(AUDIO, m.id);
  mkdirSync(join(dir, 'clips'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), raw ?? `${JSON.stringify(m, null, 2)}\n`);
  if (candidate) writeFileSync(join(dir, 'candidate.mp3'), CANDIDATE);
  return dir;
}

/** sha256 and mtime of every file under `dir`, so "changed nothing" can be asserted. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex') + statSync(p).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

const get = (path, init) => fetch(`${BASE}${path}`, init);

// ---- Step 3: read (R2) ----

test('read answers 200 with the summary, the transcript and every transcript attempt', async () => {
  const transcript = [{ speaker: 'Reader', dialogue: 'Agents plan, then act.', section: 's1' }];
  const attempts = [{ section: 's1', attempt: 1, passed: false, response_text: 'not json' }];
  const m = checked('qc_passed', { transcript, transcript_sha256: digest(transcript), transcript_attempts: attempts });
  plant(m);
  const { status, body } = await json(await get(`/api/podcast/renders/${m.id}?topic=${TOPIC}`));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rendition.id, m.id);
  assert.equal(body.rendition.stage, 'qc_passed');
  assert.deepEqual(body.transcript, transcript);
  assert.deepEqual(body.transcript_attempts, attempts);
});

test('read answers 404 for a well-formed id with no rendition', async () => {
  const res = await get(`/api/podcast/renders/render-${'0'.repeat(24)}?topic=${TOPIC}`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Rendition not found/);
});

test('read answers 400 for a malformed id or a missing or unknown topic', async () => {
  const m = rendition();
  plant(m);
  const cases = {
    'id too short': `/api/podcast/renders/render-abc?topic=${TOPIC}`,
    'id in capitals': `/api/podcast/renders/render-${'A'.repeat(24)}?topic=${TOPIC}`,
    'id that climbs': `/api/podcast/renders/..%2Fmanifest?topic=${TOPIC}`,
    'no topic': `/api/podcast/renders/${m.id}`,
    'unknown topic': `/api/podcast/renders/${m.id}?topic=no-such-topic`,
  };
  for (const [name, path] of Object.entries(cases)) {
    assert.equal((await get(path)).status, 400, name);
  }
});

test('read answers 409 for a damaged manifest and leaves both files as they were', async () => {
  const m = rendition();
  const dir = plant(m, { raw: 'not json' });
  writeFileSync(join(dir, 'manifest.json.bak'), `${JSON.stringify(m, null, 2)}\n`);
  const before = snapshot(dir);
  const { status, body } = await json(await get(`/api/podcast/renders/${m.id}?topic=${TOPIC}`));
  assert.equal(status, 409);
  assert.match(body.error, /needs repair/);
  assert.deepEqual(snapshot(dir), before);
});

// ---- Step 4: audio (R3, spec concern 3) ----

test('audio serves the candidate as audio/mpeg, its ETag the sha256 QC measured', async () => {
  const m = checked('qc_passed');
  plant(m);
  const res = await get(`/api/podcast/renders/${m.id}/audio?topic=${TOPIC}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('etag'), `"${m.audio_qc.asset.sha256}"`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), CANDIDATE);
});

test('audio answers HEAD with the same headers and no body', async () => {
  const m = checked('published');
  plant(m);
  const res = await get(`/api/podcast/renders/${m.id}/audio?topic=${TOPIC}`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('etag'), `"${m.audio_qc.asset.sha256}"`);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('audio answers a Range request with 206 and only those bytes, so a player can seek', async () => {
  const m = checked('qc_passed');
  plant(m);
  const res = await get(`/api/podcast/renders/${m.id}/audio?topic=${TOPIC}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(res.status, 206);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), CANDIDATE.subarray(0, 10));
});

test('audio answers 404 for a rendition that has no checked audio yet', async () => {
  const m = rendition({ stage: 'transcript_ready' });
  plant(m);
  const { status, body } = await json(await get(`/api/podcast/renders/${m.id}/audio?topic=${TOPIC}`));
  assert.equal(status, 404);
  assert.equal(body.error, 'This rendition has no checked audio yet');
});

test('audio answers 404 naming the cause when the candidate is not on this machine', async () => {
  const m = checked('qc_passed');
  const dir = plant(m, { candidate: false });
  const before = snapshot(dir);
  const { status, body } = await json(await get(`/api/podcast/renders/${m.id}/audio?topic=${TOPIC}`));
  assert.equal(status, 404);
  assert.equal(body.error, 'Candidate audio is not on this machine; re-render to listen');
  assert.deepEqual(snapshot(dir), before);
});

// ---- Step 5: resume (R4, spec concern 2) ----
// Resume carries no mutation_id. A replay changes nothing while the rendition is queued,
// running or finished; after `failed` it is a fresh resume, which these tests pin too.

const resume = (id, topic = TOPIC) => post(`/api/podcast/renders/${id}/resume`, { topic_slug: topic });

test('resume replayed while the render is running changes nothing on disk', async () => {
  let entered;
  const inChat = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  chat = async () => { entered(); await gate; return { message: { content: 'not json' } }; };
  try {
    const m = rendition();
    const dir = plant(m);
    const first = await json(await resume(m.id));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    await inChat;
    const before = snapshot(dir);
    const replay = await json(await resume(m.id));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.rendition.interrupted, false, 'the replay sees the running job');
    assert.deepEqual(snapshot(dir), before);
  } finally {
    release();
    chat = async () => ({ message: { content: 'not json' } });
    await idle();
  }
});

test('resume replayed on a qc_passed or published rendition changes nothing on disk', async () => {
  for (const stage of ['qc_passed', 'published']) {
    const m = checked(stage);
    const dir = plant(m);
    const before = snapshot(dir);
    for (const attempt of ['first', 'replay']) {
      const { status, body } = await json(await resume(m.id));
      assert.equal(status, 200, `${stage} ${attempt}`);
      assert.equal(body.rendition.stage, stage, `${stage} ${attempt}`);
    }
    assert.deepEqual(snapshot(dir), before, stage);
  }
});

test('resume queues an interrupted rendition again', async () => {
  const m = rendition({ stage: 'transcript_ready', progress: 'Voicing' });
  plant(m);
  const { status, body } = await json(await resume(m.id));
  await idle();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rendition.stage, 'queued');
});

test('resume after failed is a fresh resume: the rendition is queued again', async () => {
  const m = rendition({ stage: 'failed', progress: 'Failed', error: 'Speech service returned 500' });
  plant(m);
  const { status, body } = await json(await resume(m.id));
  await idle();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rendition.stage, 'queued');
});

test('resume refuses needs_review with 409, an unknown id with 404 and an unknown topic with 400', async () => {
  const m = rendition({ stage: 'needs_review', progress: 'Needs review' });
  const dir = plant(m);
  const before = snapshot(dir);
  const review = await json(await resume(m.id));
  assert.equal(review.status, 409);
  assert.match(review.body.error, /failed QC/);
  assert.deepEqual(snapshot(dir), before);
  assert.equal((await resume(`render-${'0'.repeat(24)}`)).status, 404);
  assert.equal((await resume(m.id, 'no-such-topic')).status, 400);
});

// ---- Step 6: publish (R5, spec concern 3) ----
// Publish carries no mutation_id: a replay returns the published rendition unchanged.

const publish = (id, body = { full_listen_confirmed: true }) =>
  post(`/api/podcast/renders/${id}/publish`, { topic_slug: TOPIC, ...body });
const readManifest = (m) => JSON.parse(readFileSync(join(AUDIO, m.id, 'manifest.json'), 'utf8'));

test('publish marks a qc_passed rendition published after a confirmed full listen', async () => {
  const m = checked('qc_passed');
  plant(m);
  const { status, body } = await json(await publish(m.id));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.rendition.stage, 'published');
  const saved = readManifest(m);
  assert.equal(saved.stage, 'published');
  assert.equal(saved.review.full_listen_confirmed, true);
  assert.equal(saved.review.asset_sha256, m.audio_qc.asset.sha256);
});

test('publish replayed leaves the published rendition byte-identical', async () => {
  const m = checked('qc_passed');
  const dir = plant(m);
  assert.equal((await publish(m.id)).status, 200);
  const before = snapshot(dir);
  const { status, body } = await json(await publish(m.id));
  assert.equal(status, 200);
  assert.equal(body.rendition.stage, 'published');
  assert.deepEqual(snapshot(dir), before);
});

test('publish without full_listen_confirmed exactly true is a 409 that changes nothing', async () => {
  for (const [name, confirmation] of Object.entries({ missing: {}, false: { full_listen_confirmed: false }, 'the string true': { full_listen_confirmed: 'true' } })) {
    const m = checked('qc_passed');
    const dir = plant(m);
    const before = snapshot(dir);
    const { status, body } = await json(await publish(m.id, confirmation));
    assert.equal(status, 409, name);
    assert.match(body.error, /confirmation of a full listen/, name);
    assert.deepEqual(snapshot(dir), before, name);
  }
});

test('publish refuses a candidate that changed after QC with 409', async () => {
  const m = checked('qc_passed');
  const dir = plant(m);
  writeFileSync(join(dir, 'candidate.mp3'), Buffer.from('different bytes after QC'));
  const before = snapshot(dir);
  const { status, body } = await json(await publish(m.id));
  assert.equal(status, 409);
  assert.match(body.error, /Candidate changed after QC/);
  assert.deepEqual(snapshot(dir), before);
});

test('publish refuses a candidate that is not on this machine with 409, without probing', async () => {
  const m = checked('qc_passed');
  const dir = plant(m, { candidate: false });
  const before = snapshot(dir);
  const probes = readFileSync(PROBES, 'utf8');
  const { status, body } = await json(await publish(m.id));
  assert.equal(status, 409);
  assert.equal(body.error, 'Candidate audio is not on this machine; re-render to listen');
  assert.deepEqual(snapshot(dir), before);
  assert.equal(readFileSync(PROBES, 'utf8'), probes, 'ffprobe never ran');
});

// ---- Step 7: degradation (R8) ----
// Open Notebook down is in degradation.test.mjs, which owns a dead listener. Ollama down
// needs Open Notebook up, so it is here. Each route meets Ollama on a different path:
// create's preflight checks Ollama's tags first and names it itself; resume checks the
// model (modelRuntime, step 1) before it runs the preflight.

const OLLAMA_DOWN = new RegExp(`Ollama unreachable at ${STUB.replace(/\./g, '\\.')} `);

test('create with Ollama down is a 503 naming Ollama, and prepares nothing', async () => {
  const renditions = () => (existsSync(AUDIO) ? readdirSync(AUDIO).length : 0);
  const before = renditions();
  ollamaDown = true;
  try {
    const { status, body } = await json(await post('/api/podcast/renders', createBody()));
    assert.equal(status, 503, JSON.stringify(body));
    assert.match(body.error, OLLAMA_DOWN);
    assert.ok(!JSON.stringify(body).includes('podcastrenderroutes-not-real'), 'the Open Notebook password stays server-side');
  } finally {
    ollamaDown = false;
  }
  assert.equal(renditions(), before, 'no rendition was prepared');
});

test('resume with Ollama down is a 503 naming Ollama, and changes nothing', async () => {
  const m = rendition({ stage: 'failed', progress: 'Failed', error: 'Speech service returned 500' });
  const dir = plant(m);
  const before = snapshot(dir);
  ollamaDown = true;
  try {
    const { status, body } = await json(await resume(m.id));
    assert.equal(status, 503, JSON.stringify(body));
    assert.match(body.error, new RegExp(`^${OLLAMA_DOWN.source}`));
  } finally {
    ollamaDown = false;
  }
  assert.deepEqual(snapshot(dir), before);
});

// ---- D5e step 1: the list (R1) ----
// The collection GET was a 404 in D5d2 (no route served it). D5e gives it one, so that
// case moved out of the unmatched-paths test above.

const list = (topic) => get(`/api/podcast/renders${topic === undefined ? '' : `?topic=${topic}`}`);

test('the list answers every rendition of the topic, newest first, with a damaged one as needs_repair', async () => {
  const older = rendition({ created_at: '2026-11-11T01:00:00.000Z' });
  const newer = checked('qc_passed', { created_at: '2026-11-11T02:00:00.000Z' });
  plant(older);
  plant(newer);
  const damaged = rendition({ created_at: '2026-11-11T03:00:00.000Z' });
  plant(damaged, { raw: 'not json' });
  const { status, body } = await json(await list(TOPIC));
  assert.equal(status, 200, JSON.stringify(body));
  const ids = body.renditions.map((r) => r.id);
  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id), 'newest first');
  const repair = body.renditions.find((r) => r.id === damaged.id);
  assert.equal(repair.status, 'needs_repair');
  assert.equal(body.renditions.find((r) => r.id === newer.id).stage, 'qc_passed');
});

test('the list makes no Open Notebook request, so it works while Open Notebook is down', async () => {
  // Control first (.claude/rules/testing.md): the same log does record Open Notebook
  // requests, so the silence below means the list sent none, not that nothing was logged.
  stubLog.length = 0;
  assert.equal((await post('/api/podcast/renders', createBody())).status, 202);
  await idle();
  assert.ok(stubLog.includes('GET /api/sources'), `control: create reads the sources (${stubLog.join(', ')})`);
  stubLog.length = 0;
  assert.equal((await list(TOPIC)).status, 200);
  assert.deepEqual(stubLog, []);
});

test('the list refuses a missing or unknown topic with 400', async () => {
  assert.equal((await list()).status, 400);
  assert.equal((await list('no-such-topic')).status, 400);
});
