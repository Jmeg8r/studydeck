import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortableDelay, isAbortError } from '../web/js/lifecycle.mjs';

test('an aborted view cancels its pending delay immediately', async () => {
  const controller = new AbortController();
  const pending = abortableDelay(60_000, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, (err) => isAbortError(err));
});

test('an already-cleaned-up view does not schedule another delay', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => abortableDelay(60_000, controller.signal), (err) => isAbortError(err));
});
