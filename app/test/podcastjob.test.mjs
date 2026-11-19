import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveJobStatus, normalizePodcastJob } from '../lib/podcastjob.mjs';

test('active job spellings stay non-terminal at the server boundary', () => {
  for (const status of ['new', 'running', 'pending', 'queued', 'started', 'processing', 'in_progress', 'submitted']) {
    const normalized = normalizePodcastJob({ status }, 'job:fallback');
    assert.equal(normalized.terminal, false, status);
    assert.equal(normalized.successful, false, status);
  }
});

test('terminal failures are retryable and successful jobs are explicit', () => {
  assert.deepEqual(
    normalizePodcastJob({ job_id: 'job:one', status: 'failed', error_message: 'model stopped' }, 'job:fallback'),
    { job_id: 'job:one', status: 'failed', progress: null, result: null, error: 'model stopped', updated: null, terminal: true, successful: false, retryable: true },
  );
  const success = normalizePodcastJob({ status: 'completed' }, 'job:fallback');
  assert.equal(success.terminal, true);
  assert.equal(success.successful, true);
  assert.equal(success.retryable, false);
});

test('only completed is a success: canceled, unknown and a missing status are failures', () => {
  for (const job of [{ status: 'canceled' }, { status: 'unknown' }, {}]) {
    const normalized = normalizePodcastJob(job, 'job:fallback');
    assert.equal(normalized.terminal, true, JSON.stringify(job));
    assert.equal(normalized.successful, false, JSON.stringify(job));
    assert.equal(normalized.retryable, true, JSON.stringify(job));
    assert.equal(normalized.error, `Open Notebook reported the job as ${normalized.status}`);
  }
  const completedWithError = normalizePodcastJob({ status: 'completed', error_message: 'audio missing' }, 'job:x');
  assert.equal(completedWithError.successful, false);
  assert.equal(completedWithError.error, 'audio missing');
});

test('isActiveJobStatus ignores case and refuses terminal statuses', () => {
  assert.equal(isActiveJobStatus('NEW'), true);
  assert.equal(isActiveJobStatus('Running'), true);
  for (const status of ['completed', 'failed', 'canceled', 'unknown', null, undefined]) {
    assert.equal(isActiveJobStatus(status), false, String(status));
  }
});
