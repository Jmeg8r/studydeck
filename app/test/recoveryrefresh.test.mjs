// WHAT: After a Recovery action, the cockpit's shared state is refreshed, not just the list.
// WHY:  Settling writes state.json and cards.json. Today, Stats and Flashcards render from the
//       state main.mjs loaded at boot, so a Recovery page that reloads only /api/recovery left
//       new cards missing and mastery stale until a full reload (Codex, run 1). A separate
//       file, loaded with import(), so a missing export fails only this.
import test from 'node:test';
import assert from 'node:assert/strict';

const owed = { type: 'mastery_owed', attempt_id: 'a1', kind: 'quiz', ts: '2026-11-11T00:00:00Z', score: 1, max: 2 };
const action = { label: 'Apply to mastery', path: '/api/recovery/settle', body: { attempt_id: 'a1' } };

test('a settled item refreshes the shared state after the server answers', async () => {
  const { runRecoveryAction } = await import('../web/js/views/recovery.mjs');
  const calls = [];
  const message = await runRecoveryAction({
    request: async (path, options) => { calls.push(['request', path, options.body]); return { outcome: 'applied' }; },
    refresh: async () => { calls.push(['refresh']); },
    topicSlug: 'ai-engineering', item: owed, action,
  });
  assert.equal(message, 'Mastery updated.');
  assert.deepEqual(calls, [
    ['request', '/api/recovery/settle', { topic_slug: 'ai-engineering', attempt_id: 'a1' }],
    ['refresh'],
  ], 'refresh runs once, after the POST');
});

test('a failed request still refreshes, because the write may have landed before it failed', async () => {
  const { runRecoveryAction } = await import('../web/js/views/recovery.mjs');
  let refreshed = 0;
  const message = await runRecoveryAction({
    request: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
    refresh: async () => { refreshed += 1; },
    topicSlug: 'ai-engineering', item: owed, action,
  });
  assert.equal(message, 'boom');
  assert.equal(refreshed, 1);
});

test('leaving the view neither cancels the write nor skips the refresh', async () => {
  // Aborting a browser request does not stop a settle already running on the server, so the
  // write may commit after the learner has moved on. The POST outlives the view, and the
  // refresh follows it; only painting into the gone view is the caller's to suppress
  // (Codex, run 2).
  const { runRecoveryAction } = await import('../web/js/views/recovery.mjs');
  const view = new AbortController();
  let sentSignal = 'not sent';
  let refreshed = 0;
  const message = await runRecoveryAction({
    request: async (path, options) => { sentSignal = options.signal; view.abort(); return { outcome: 'applied' }; },
    refresh: async () => { refreshed += 1; },
    topicSlug: 'ai-engineering', item: owed, action, signal: view.signal,
  });
  assert.equal(sentSignal, undefined, 'the POST carries no view signal');
  assert.equal(refreshed, 1);
  assert.equal(message, 'Mastery updated.');
});

test('Recovery refuses to render without a way to refresh the shared state', async () => {
  // The wiring in main.mjs is the boundary that broke. A view that can settle state but was
  // given no refresh fails loudly, before it draws anything, instead of going stale quietly.
  const { renderRecovery } = await import('../web/js/views/recovery.mjs');
  assert.throws(() => renderRecovery(null), TypeError);
  assert.throws(() => renderRecovery(null, {}), TypeError);
});
