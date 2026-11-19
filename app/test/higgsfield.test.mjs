import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHiggsfieldService, normalizeStoryboard } from '../lib/higgsfield.mjs';

const waitFor = async (service, id) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = service.get(id);
    if (job.status === 'prepared' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('storyboard did not settle');
};

test('a storyboard file missing beside an unusable backup is damaged state, not an unknown job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studydeck-higgsfield-'));
  const service = createHiggsfieldService({ dir, prepare: async () => { throw new Error('get must not prepare'); } });
  const damaged = randomUUID();
  writeFileSync(join(dir, `${damaged}.json.bak`), '{');

  assert.throws(() => service.get(damaged), (err) => err.status === 500 && /damaged/.test(err.message));
  assert.equal(service.get(randomUUID()), null, 'a job with neither file is still unknown');
});

test('a prepared storyboard survives a retry and a service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studydeck-higgsfield-'));
  let calls = 0;
  const service = createHiggsfieldService({ dir, prepare: async () => {
    calls += 1;
    return { prompt: 'Create a three-scene explainer.', scenes: [], source_count: 1 };
  } });
  const input = { topicSlug: 'synthetic-topic', topicName: 'Synthetic topic',
    notebookId: 'notebook:synthetic', mutationId: 'same-intent' };
  const first = service.start(input);
  const ready = await waitFor(service, first.id);
  assert.equal(ready.status, 'prepared');
  assert.equal(service.start(input).id, first.id);
  const restarted = createHiggsfieldService({ dir, prepare: async () => { throw new Error('must not run again'); } });
  assert.equal(restarted.start(input).id, first.id);
  assert.equal(calls, 1);
  assert.match(restarted.get(first.id).prompt, /three-scene/);
});

test('storyboard validation rejects ungrounded narration anchors', () => {
  const scenes = Array.from({ length: 3 }, (_, index) => ({
    title: `Scene ${index + 1}`, visual_prompt: 'A clear cinematic illustration with a slow camera move.',
    narration: 'A grounded explanation about the material, spoken clearly for the learner.',
    source_ids: ['source:one'],
  }));
  assert.equal(normalizeStoryboard({ scenes }, new Set(['source:one'])).length, 3);
  assert.throws(() => normalizeStoryboard({ scenes: [{ ...scenes[0], source_ids: ['source:fake'] }, ...scenes.slice(1)] },
    new Set(['source:one'])), /source anchor/);
});

// One damaged storyboard file used to make list() throw, and start() calls list() to find a
// replay, so it took down the storyboard list and every new one with it
// (job-list-damage, 2026-11-11).
const DAMAGED_STORYBOARD = 'Higgsfield storyboard state is damaged';

function seedStoryboards({ healthy = [], damaged = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'studydeck-higgsfield-'));
  let prepares = 0;
  const service = createHiggsfieldService({ dir, prepare: async () => {
    prepares += 1;
    return { prompt: 'Create a three-scene explainer.', scenes: [], source_count: 1 };
  } });
  for (const job of healthy) writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job));
  for (const id of damaged) writeFileSync(join(dir, `${id}.json`), '{');
  return { service, prepares: () => prepares };
}

const healthyStoryboard = (overrides = {}) => ({ id: randomUUID(), topic_slug: 'synthetic-topic',
  topic_name: 'Synthetic topic', notebook_id: 'notebook:synthetic', mutation_id: 'healthy-intent',
  status: 'prepared', progress: 'Ready', created_at: '2026-11-10T12:00:00.000Z', ...overrides });

test('a damaged storyboard file is listed as a marker beside the healthy storyboards', () => {
  const healthy = healthyStoryboard();
  const damaged = randomUUID();
  const { service } = seedStoryboards({ healthy: [healthy], damaged: [damaged] });

  assert.deepEqual(service.list(), [healthy, { id: damaged, status: 'damaged', error: DAMAGED_STORYBOARD }]);
});

test('dated storyboards list newest first, then damaged markers by id', () => {
  const older = healthyStoryboard({ created_at: '2026-11-09T00:00:00.000Z', mutation_id: 'older' });
  const newer = healthyStoryboard({ created_at: '2026-11-10T00:00:00.000Z', mutation_id: 'newer' });
  const damaged = [randomUUID(), randomUUID()].sort();
  const { service } = seedStoryboards({ healthy: [older, newer], damaged: [...damaged].reverse() });

  assert.deepEqual(service.list().map((job) => job.id), [newer.id, older.id, ...damaged]);
});

test('control: get still refuses a damaged storyboard with a 500', () => {
  const damaged = randomUUID();
  const { service } = seedStoryboards({ healthy: [healthyStoryboard()], damaged: [damaged] });

  assert.throws(() => service.get(damaged), (err) => err.status === 500 && err.message === DAMAGED_STORYBOARD);
});

test('start finds a storyboard replay among the healthy ones beside a damaged one', () => {
  const healthy = healthyStoryboard();
  const { service, prepares } = seedStoryboards({ healthy: [healthy], damaged: [randomUUID()] });
  const input = { topicSlug: 'synthetic-topic', notebookId: 'notebook:synthetic', mutationId: 'healthy-intent' };

  assert.equal(service.start(input).id, healthy.id);
  assert.throws(() => service.start({ ...input, notebookId: 'notebook:other' }), (err) => err.status === 409);
  assert.equal(prepares(), 0, 'a replay must not prepare');
});

test('start prepares a fresh mutation even when a damaged storyboard exists', async () => {
  const healthy = healthyStoryboard();
  const { service, prepares } = seedStoryboards({ healthy: [healthy], damaged: [randomUUID()] });

  const job = service.start({ topicSlug: 'synthetic-topic', notebookId: 'notebook:synthetic', mutationId: 'fresh-intent' });
  assert.notEqual(job.id, healthy.id);
  assert.equal((await waitFor(service, job.id)).status, 'prepared');
  assert.equal(prepares(), 1);
});
