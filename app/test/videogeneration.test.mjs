import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createVideoService, normalizeVideoScript } from '../lib/videogeneration.mjs';

const waitFor = async (service, id) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = service.get(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle');
};

test('one mutation starts one render and publishes only after render completes', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studydeck-video-'));
  let renders = 0;
  const service = createVideoService({ outputDir, workDir: join(outputDir, '.jobs'),
    render: async (job, publishPath) => {
      renders += 1;
      writeFileSync(publishPath, 'fake mp4');
      return { slides: 3, used_sources: ['source:one'] };
    } });

  const first = service.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'same-intent' });
  const replay = service.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'same-intent' });
  assert.equal(replay.id, first.id);
  const done = await waitFor(service, first.id);
  assert.equal(done.status, 'completed');
  assert.equal(renders, 1);
  assert.equal(readFileSync(join(outputDir, done.file), 'utf8'), 'fake mp4');
  assert.equal(readdirSync(outputDir).filter((name) => name.endsWith('.mp4')).length, 1);
  const restarted = createVideoService({ outputDir, workDir: join(outputDir, '.jobs'),
    render: async () => { throw new Error('a replay must not render again'); } });
  assert.equal(restarted.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'same-intent' }).id, first.id);
});

test('a job file missing beside an unusable backup is damaged state, not an unknown job', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studydeck-video-'));
  const workDir = join(outputDir, '.jobs');
  const service = createVideoService({ outputDir, workDir,
    render: async () => { throw new Error('get must not render'); } });
  const damaged = randomUUID();
  mkdirSync(join(workDir, damaged));
  writeFileSync(join(workDir, damaged, 'job.json.bak'), '{');

  assert.throws(() => service.get(damaged), (err) => err.status === 500 && /damaged/.test(err.message));
  assert.equal(service.get(randomUUID()), null, 'a job with neither file is still unknown');
});

test('failed render leaves no published video and reports a retryable job', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'studydeck-video-'));
  const service = createVideoService({ outputDir, workDir: join(outputDir, '.jobs'),
    render: async () => { throw new Error('local TTS unavailable'); } });
  const job = service.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'fail-once' });
  const failed = await waitFor(service, job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /local TTS unavailable/);
  assert.equal(readdirSync(outputDir).filter((name) => name.endsWith('.mp4')).length, 0);
});

test('script validation refuses invented source anchors and incomplete slides', () => {
  const slides = Array.from({ length: 3 }, (_, index) => ({
    title: `Point ${index + 1}`, bullets: ['A useful idea', 'A second idea'],
    narration: 'A concise explanation of a source-grounded concept that gives the learner context.',
    source_ids: ['source:one'],
  }));
  assert.equal(normalizeVideoScript({ slides }, new Set(['source:one'])).length, 3);
  assert.throws(() => normalizeVideoScript({ slides: [{ ...slides[0], source_ids: ['source:invented'] }, ...slides.slice(1)] }, new Set(['source:one'])), /source anchor/);
  assert.throws(() => normalizeVideoScript({ slides: slides.slice(0, 2) }, new Set(['source:one'])), /3 to 5 slides/);
});

// One damaged job file used to make list() throw, and start() calls list() to find a replay,
// so it took down the job list and every new render with it (job-list-damage, 2026-11-11).
const DAMAGED_JOB = 'Video job state is damaged';

function seedVideoJobs({ healthy = [], damaged = [] }) {
  const outputDir = mkdtempSync(join(tmpdir(), 'studydeck-video-'));
  const workDir = join(outputDir, '.jobs');
  let renders = 0;
  const service = createVideoService({ outputDir, workDir, render: async (job, publishPath) => {
    renders += 1;
    writeFileSync(publishPath, 'fake mp4');
    return { slides: 3 };
  } });
  for (const job of healthy) {
    mkdirSync(join(workDir, job.id));
    writeFileSync(join(workDir, job.id, 'job.json'), JSON.stringify(job));
  }
  for (const id of damaged) {
    mkdirSync(join(workDir, id));
    writeFileSync(join(workDir, id, 'job.json'), '{');
  }
  return { service, renders: () => renders };
}

const healthyVideoJob = (overrides = {}) => ({ id: randomUUID(), topic_slug: 'test-topic', topic_name: 'Test topic',
  notebook_id: 'notebook:one', mutation_id: 'healthy-intent', file: 'healthy.mp4', status: 'completed',
  progress: 'Ready', created_at: '2026-11-10T12:00:00.000Z', ...overrides });

test('a damaged job file is listed as a marker beside the healthy jobs', () => {
  const healthy = healthyVideoJob();
  const damaged = randomUUID();
  const { service } = seedVideoJobs({ healthy: [healthy], damaged: [damaged] });

  assert.deepEqual(service.list(), [healthy, { id: damaged, status: 'damaged', error: DAMAGED_JOB }]);
});

test('dated jobs list newest first, then damaged markers by id', () => {
  const older = healthyVideoJob({ created_at: '2026-11-09T00:00:00.000Z', mutation_id: 'older' });
  const newer = healthyVideoJob({ created_at: '2026-11-10T00:00:00.000Z', mutation_id: 'newer' });
  const damaged = [randomUUID(), randomUUID()].sort();
  const { service } = seedVideoJobs({ healthy: [older, newer], damaged: [...damaged].reverse() });

  assert.deepEqual(service.list().map((job) => job.id), [newer.id, older.id, ...damaged]);
});

test('control: get still refuses a damaged job with a 500', () => {
  const damaged = randomUUID();
  const { service } = seedVideoJobs({ healthy: [healthyVideoJob()], damaged: [damaged] });

  assert.throws(() => service.get(damaged), (err) => err.status === 500 && err.message === DAMAGED_JOB);
});

test('start finds a replay among the healthy jobs beside a damaged one', () => {
  const healthy = healthyVideoJob();
  const { service, renders } = seedVideoJobs({ healthy: [healthy], damaged: [randomUUID()] });

  assert.equal(service.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'healthy-intent' }).id, healthy.id);
  assert.throws(() => service.start({ topicSlug: 'test-topic', notebookId: 'notebook:two', mutationId: 'healthy-intent' }),
    (err) => err.status === 409);
  assert.equal(renders(), 0, 'a replay must not render');
});

test('start renders a fresh mutation even when a damaged job exists', async () => {
  const healthy = healthyVideoJob();
  const { service, renders } = seedVideoJobs({ healthy: [healthy], damaged: [randomUUID()] });

  const job = service.start({ topicSlug: 'test-topic', notebookId: 'notebook:one', mutationId: 'fresh-intent' });
  assert.notEqual(job.id, healthy.id);
  assert.equal((await waitFor(service, job.id)).status, 'completed');
  assert.equal(renders(), 1);
});
