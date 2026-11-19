// WHAT: The video and Higgsfield job routes with one damaged job file beside a healthy one.
//       docs/changes/2026-11-11-job-list-damage.
// WHY:  list() mapped get() over every job file, and get() throws a 500 on damage. start()
//       calls list() to find a mutation_id replay, so one bad file made both list routes AND
//       both start routes answer 500. The detail routes for the damaged id are controls: they
//       must keep refusing it. A fresh start runs the real render/prepare, whose first step
//       calls Open Notebook; that points at a socket this file owns and hangs up on, so the
//       job fails there before ollama or TTS is reached (degradation.test.mjs explains why
//       an owned socket and not a fixed port). If that first step ever changes, this file
//       could reach ollama.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-jobdamage-'));
const SHELF = join(FIXTURE_ROOT, 'shelf');
const LEARN = join(FIXTURE_ROOT, 'learn');
const TOPIC = 'ai-agent-design-patterns';
const SETTLE_POLLS = 100;
const SETTLE_INTERVAL_MS = 50;

mkdirSync(SHELF);
mkdirSync(LEARN);

const deadOn = createServer();
deadOn.on('connection', (socket) => socket.destroy());
await new Promise((resolve) => deadOn.listen(0, '127.0.0.1', resolve));

// Set before config.mjs and the job services load: all of them read the environment once, at import.
process.env.STUDYDECK_VIDEO_DIR = SHELF;
process.env.STUDYDECK_LEARN_ROOT = LEARN;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${deadOn.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'jobdamage-test-not-real';

const { handleRequest } = await import('../router.mjs');
const { config } = await import('../lib/config.mjs');
const NOTEBOOK = config.topics.find((topic) => topic.slug === TOPIC).notebookId;

// The routes read each topic's state.json for its display name.
for (const topic of config.topics) {
  mkdirSync(join(LEARN, topic.slug, 'cockpit'), { recursive: true });
  writeFileSync(join(LEARN, topic.slug, 'state.json'), `${JSON.stringify({
    version: 1, slug: topic.slug, topic: 'Job damage fixture', created: '2026-11-11', last_updated: null, domains: [],
  }, null, 2)}\n`);
}

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const PORT = app.address().port;

after(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => deadOn.close(resolve));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: { host: `127.0.0.1:${PORT}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || 'null') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Wait for a real job to leave `running`, so `after` never removes a directory it still writes. */
async function settle(detailPath) {
  for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
    const res = await call('GET', detailPath);
    if (res.body?.status !== 'running') return res;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
  }
  throw new Error(`${detailPath} did not settle`);
}

const healthyJob = (overrides) => ({ id: randomUUID(), topic_slug: TOPIC, topic_name: 'Agent design patterns',
  notebook_id: NOTEBOOK, progress: 'Ready', created_at: '2026-11-10T12:00:00.000Z', ...overrides });

const services = [
  {
    name: 'video', list: '/api/videos/jobs', start: '/api/videos/generate', detail: '/api/videos/jobs/',
    message: 'Video job state is damaged',
    healthy: healthyJob({ mutation_id: 'route-video-intent', file: 'healthy.mp4', status: 'completed' }),
    damaged: randomUUID(),
    seed(job, damaged) {
      const dir = join(SHELF, '.video-renders');
      mkdirSync(join(dir, job.id), { recursive: true });
      writeFileSync(join(dir, job.id, 'job.json'), JSON.stringify(job));
      mkdirSync(join(dir, damaged));
      writeFileSync(join(dir, damaged, 'job.json'), '{');
    },
  },
  {
    name: 'Higgsfield', list: '/api/videos/higgsfield', start: '/api/videos/higgsfield/prepare',
    detail: '/api/videos/higgsfield/', message: 'Higgsfield storyboard state is damaged',
    healthy: healthyJob({ mutation_id: 'route-higgsfield-intent', status: 'prepared' }),
    damaged: randomUUID(),
    seed(job, damaged) {
      const dir = join(SHELF, '.higgsfield-prep');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job));
      writeFileSync(join(dir, `${damaged}.json`), '{');
    },
  },
];

for (const service of services) service.seed(service.healthy, service.damaged);

for (const service of services) {
  test(`${service.name}: the list answers 200 with the healthy job and a damaged marker`, async () => {
    const res = await call('GET', service.list);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.jobs, [service.healthy, { id: service.damaged, status: 'damaged', error: service.message }]);
  });

  test(`${service.name} control: the damaged job's detail route still answers 500`, async () => {
    const res = await call('GET', `${service.detail}${service.damaged}`);
    assert.equal(res.status, 500);
  });

  test(`${service.name}: a start replay beside a damaged job returns the healthy job`, async () => {
    const res = await call('POST', service.start, { topic_slug: TOPIC, mutation_id: service.healthy.mutation_id });
    assert.equal(res.status, 202);
    assert.equal(res.body.id, service.healthy.id);
  });

  test(`${service.name}: a fresh start beside a damaged job starts a new job`, async () => {
    const res = await call('POST', service.start, { topic_slug: TOPIC, mutation_id: `route-${service.name}-fresh` });
    assert.equal(res.status, 202);
    assert.notEqual(res.body.id, service.healthy.id);
    const settled = await settle(`${service.detail}${res.body.id}`);
    assert.equal(settled.body.status, 'failed', 'Open Notebook is unreachable, so the real job fails');
  });
}
