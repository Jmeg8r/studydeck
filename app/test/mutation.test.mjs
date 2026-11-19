// WHAT: Tests for the browser-side mutation-id helper.
// WHY: Server-side dedupe is only real if the CLIENT reuses one id across retries. Three
//      views minted nothing at all, and the two that did rolled the logic by hand — one of
//      them wrongly at first, minting inside the click handler so every click got a fresh
//      id while the comment above it claimed the id was reused (caught in #20's review).
//
//      The invariant is small and easy to get backwards, which is the argument for testing
//      it directly rather than trusting each view to re-derive it: the id must survive a
//      FAILURE (that is the case a retry needs deduplicating) and must be dropped on
//      SUCCESS (or the next genuine action is swallowed as a replay of the last one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, withMutationId } from '../web/js/mutation.mjs';
import { buildEssayGradeRequest, pendingEssayAttempts } from '../web/js/views/essay.mjs';

test('a retry after a failure reuses the same id', async () => {
  const seen = [];
  const send = (id) => {
    seen.push(id);
    return seen.length === 1 ? Promise.reject(new Error('response lost')) : Promise.resolve('ok');
  };

  await assert.rejects(() => withMutationId('review:card-1:hit', send), /response lost/);
  assert.equal(await withMutationId('review:card-1:hit', send), 'ok');

  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the retry must carry the id the failed request carried');
});

test('the id is dropped once the request succeeds', async () => {
  const seen = [];
  const send = (id) => { seen.push(id); return Promise.resolve('ok'); };

  await withMutationId('review:card-1:hit', send);
  await withMutationId('review:card-1:hit', send);

  // A second successful click on the same card is a NEW review, not a replay of the first.
  // Reusing the id here would have the server return the first result and record nothing.
  assert.notEqual(seen[0], seen[1]);
});

test('different intents never share an id', async () => {
  const seen = new Map();
  const capture = (key) => withMutationId(key, (id) => { seen.set(key, id); return Promise.resolve(); });

  await capture('review:card-1:hit');
  await capture('review:card-1:miss');
  await capture('review:card-2:hit');

  assert.equal(new Set(seen.values()).size, 3, 'hit, miss and a different card are three intents');
});

test('concurrent calls under one key share the in-flight id', async () => {
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const send = (id) => { seen.push(id); return gate; };

  const first = withMutationId('mindmap:topic', send);
  const second = withMutationId('mindmap:topic', send);
  release('ok');
  await Promise.all([first, second]);

  // A double click before the first response lands is the exact case dedupe exists for.
  assert.equal(seen[0], seen[1]);
});

test('the id is a real UUID, not a counter that resets with the page', async () => {
  let captured;
  await withMutationId('k', (id) => { captured = id; return Promise.resolve(); });
  assert.match(captured, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('an essay request carries the stable mutation id and the complete submission', () => {
  const request = buildEssayGradeRequest({
    topicSlug: 'deep-learning',
    conceptSlug: 'your-first-model',
    sourceId: 'source:lesson-1',
    question: 'Why hold out a validation set?',
    rubric: 'Explains model selection.',
    answer: 'It checks generalisation.',
    max: '7',
    confidence: 'likely',
    mutationId: 'essay-intent-1',
  });

  assert.deepEqual(request, {
    topic_slug: 'deep-learning',
    concept_slug: 'your-first-model',
    source_id: 'source:lesson-1',
    question: 'Why hold out a validation set?',
    rubric: 'Explains model selection.',
    answer: 'It checks generalisation.',
    max: 7,
    confidence: 'likely',
    mutation_id: 'essay-intent-1',
  });
});

test('the browser resume surface includes only pending essay revisions', () => {
  const pending = pendingEssayAttempts({
    topics: [{
      slug: 'deep-learning', name: 'Deep learning', attempts: [
        { kind: 'essay', attempt_id: 'pending-grade', status: 'grading_pending' },
        { kind: 'essay', attempt_id: 'pending-confirmation', status: 'pending_confirmation' },
        { kind: 'essay', attempt_id: 'settled', status: 'final' },
        { kind: 'quiz', attempt_id: 'not-an-essay', status: 'pending_self_grade' },
      ],
    }],
  });
  assert.deepEqual(pending.map((attempt) => attempt.attempt_id), ['pending-grade', 'pending-confirmation']);
  assert.equal(pending[0].topic_slug, 'deep-learning');
});

// A reload is a fresh copy of the module over the same tab storage. Importing under a new
// query string gives a fresh module instance, which is the closest node:test gets to one.
const STORAGE_KEY = 'studydeck.pending-intents.v1';
let reloads = 0;

function tabStorage({ failWrites = false } = {}) {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('QuotaExceededError');
      items.set(key, String(value));
    },
    removeItem: (key) => items.delete(key),
  };
}

async function loadPage(storage) {
  globalThis.sessionStorage = storage;
  reloads += 1;
  return import(`../web/js/mutation.mjs?reload=${reloads}`);
}

const savedCount = (storage) => JSON.parse(storage.getItem(STORAGE_KEY) ?? '{"intents":[]}').intents.length;
const lost = () => Promise.reject(new Error('response lost'));

test('after a reload, the same request reuses the id its lost response carried', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  const payload = { topic_slug: 't', deck_file: 'd.json', responses: { q1: 'b' } };
  let before;
  const first = await loadPage(storage);
  await assert.rejects(() => first.withMutationId('attempt:t:d.json', (id) => { before = id; return lost(); }, { payload }));

  const reloaded = await loadPage(storage);
  let after;
  await reloaded.withMutationId('attempt:t:d.json', (id) => { after = id; return Promise.resolve('ok'); }, { payload });
  assert.equal(after, before, 'a retry of the identical request must not record it a second time');
});

test('after a reload, a different request under the same key is a new intent', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  let before;
  const first = await loadPage(storage);
  await assert.rejects(() => first.withMutationId('attempt:t:d.json',
    (id) => { before = id; return lost(); }, { payload: { responses: { q1: 'b' } } }));

  const reloaded = await loadPage(storage);
  let after;
  await reloaded.withMutationId('attempt:t:d.json',
    (id) => { after = id; return Promise.resolve('ok'); }, { payload: { responses: { q1: 'c' } } });
  // Reusing the id here would have first-wins dedupe hand back the earlier attempt's
  // results for these new answers and record nothing.
  assert.notEqual(after, before);
});

test('within one page, a changed request under the same key gets a new id', async () => {
  const seen = [];
  const send = (id) => { seen.push(id); return seen.length === 1 ? lost() : Promise.resolve('ok'); };
  await assert.rejects(() => withMutationId('attempt:t:edit.json', send, { payload: { answer: 'first' } }));
  await withMutationId('attempt:t:edit.json', send, { payload: { answer: 'edited' } });
  assert.notEqual(seen[0], seen[1]);
});

test('the fingerprint ignores mutation_id and key order', async () => {
  const seen = [];
  const send = (id) => { seen.push(id); return seen.length === 1 ? lost() : Promise.resolve('ok'); };
  await assert.rejects(() => withMutationId('order', send, { payload: { a: 1, b: { c: 2, d: 3 }, mutation_id: 'x' } }));
  await withMutationId('order', send, { payload: { b: { d: 3, c: 2 }, a: 1 } });
  assert.equal(seen[0], seen[1]);
});

test('a failed request is saved, and success or reset removes it', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  const page = await loadPage(storage);
  await assert.rejects(() => page.withMutationId('debrief:t', lost, { payload: { topic_slug: 't' } }));
  await assert.rejects(() => page.withMutationId('mindmap:t', lost, { payload: { topic_slug: 't' } }));
  assert.equal(savedCount(storage), 2);

  await page.withMutationId('debrief:t', () => Promise.resolve('ok'), { payload: { topic_slug: 't' } });
  page.resetMutationId('mindmap:t');
  assert.equal(savedCount(storage), 0);
});

test('storage holds hashes, never the learner\'s answers or a content-bearing key', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  const page = await loadPage(storage);
  await assert.rejects(() => page.withMutationId('reading-highlight:t:s:a highlighted passage', lost,
    { payload: { answer: 'my private essay text' } }));
  const raw = storage.getItem(STORAGE_KEY);
  assert.ok(raw, 'the failed intent must be saved');
  assert.doesNotMatch(raw, /private essay/);
  assert.doesNotMatch(raw, /highlighted passage/);
});

test('an intent restored but not yet retried survives the next save', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  const first = await loadPage(storage);
  let before;
  await assert.rejects(() => first.withMutationId('podcast:n:e', (id) => { before = id; return lost(); }, { payload: { n: 1 } }));

  // Another action saves first; the podcast retry comes after a SECOND reload.
  const second = await loadPage(storage);
  await assert.rejects(() => second.withMutationId('debrief:t', lost, { payload: { t: 1 } }));
  const third = await loadPage(storage);
  let after;
  await third.withMutationId('podcast:n:e', (id) => { after = id; return Promise.resolve('ok'); }, { payload: { n: 1 } });
  assert.equal(after, before);
});

test('storage that refuses writes still yields a working id, with one warning', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.after(() => { delete globalThis.sessionStorage; });
  const page = await loadPage(tabStorage({ failWrites: true }));
  const seen = [];
  const send = (id) => { seen.push(id); return seen.length === 1 ? lost() : Promise.resolve('ok'); };
  await assert.rejects(() => page.withMutationId('k2', send, { payload: { a: 1 } }));
  await page.withMutationId('k2', send, { payload: { a: 1 } });
  await assert.rejects(() => page.withMutationId('k3', lost, { payload: { a: 1 } }));
  assert.equal(seen[0], seen[1], 'the in-page retry still reuses the id');
  assert.equal(warnings.length, 1);
});

test('concurrent identical requests share an id even when the first resolves at once', async () => {
  const seen = [];
  const send = (id) => { seen.push(id); return Promise.resolve('ok'); };
  const payload = { topic_slug: 't', text: 'same' };
  // Fired in the same tick, like a double click. If the id is only reserved after an
  // await, the first call can succeed and clear it before the second reserves one.
  await Promise.all([
    withMutationId('debrief:concurrent', send, { payload }),
    withMutationId('debrief:concurrent', send, { payload }),
  ]);
  assert.equal(seen[0], seen[1]);
});

test('after a reload, resetMutationId also discards the saved id', async (t) => {
  t.after(() => { delete globalThis.sessionStorage; });
  const storage = tabStorage();
  const payload = { topic_slug: 't', answer: 'x' };
  let before;
  const first = await loadPage(storage);
  await assert.rejects(() => first.withMutationId('essay:t', (id) => { before = id; return lost(); }, { payload }));

  const reloaded = await loadPage(storage);
  // The learner edits the form (reset), then puts the field back as it was. That is a
  // deliberately new intent, so the old id must not come back.
  reloaded.resetMutationId('essay:t');
  assert.equal(savedCount(storage), 0);
  let after;
  await reloaded.withMutationId('essay:t', (id) => { after = id; return Promise.resolve('ok'); }, { payload });
  assert.notEqual(after, before);
});

test('the synchronous sha256 matches crypto.subtle', async () => {
  // Lengths around the 55/56/64-byte padding boundaries, multi-block input and non-ASCII.
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000),
    'reading-highlight:t:s:“quoted” — passage', '日本語のテキスト', '🦀'.repeat(40)];
  for (const text of inputs) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(sha256(text), expected, `sha256 of ${text.length} chars`);
  }
});
