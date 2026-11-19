// WHAT: Browser request-boundary tests.
// WHY: Views must share JSON/error/abort/mutation semantics without a DOM or a framework.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, parseJsonBody, requestJson, requestJsonWithMutation } from '../web/js/api.mjs';

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });

test('requestJson sets JSON headers and parses a successful body', async () => {
  let received;
  globalThis.fetch = async (path, init) => {
    received = { path, init };
    return new Response(JSON.stringify({ saved: true }), { status: 201, headers: { 'content-type': 'application/json' } });
  };

  assert.deepEqual(await requestJson('/api/example', { method: 'POST', body: { answer: 42 } }), { saved: true });
  assert.equal(received.path, '/api/example');
  assert.equal(received.init.headers.get('content-type'), 'application/json');
  assert.equal(received.init.body, '{"answer":42}');
});

test('requestJson normalizes JSON and non-JSON failures without exposing raw response text', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'please retry' }), { status: 503 });
  await assert.rejects(() => requestJson('/api/example'), (err) =>
    err instanceof ApiError && err.status === 503 && err.message === 'please retry');

  globalThis.fetch = async () => new Response('<html>gateway says too much</html>', { status: 502 });
  await assert.rejects(() => requestJson('/api/example'), (err) =>
    err instanceof ApiError && err.status === 502 && err.message === '/api/example → 502');
});

test('requestJson treats 204 and empty bodies as an explicit null payload', async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await requestJson('/api/example', { method: 'DELETE' }), null);
  assert.equal(await parseJsonBody(new Response('')), null);
});

test('requestJson passes an abort signal through unchanged', async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_path, init) => {
    assert.equal(init.signal, controller.signal);
    throw new DOMException('aborted', 'AbortError');
  };
  await assert.rejects(() => requestJson('/api/example', { signal: controller.signal }), { name: 'AbortError' });
});

test('mutation requests reuse their id after failure and clear it after success', async () => {
  const ids = [];
  let calls = 0;
  globalThis.fetch = async (_path, init) => {
    ids.push(JSON.parse(init.body).mutation_id);
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'response lost' }), { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const options = { mutationKey: 'api-test:one', method: 'POST', body: { value: 1 } };
  await assert.rejects(() => requestJsonWithMutation('/api/example', options), ApiError);
  await requestJsonWithMutation('/api/example', options);
  await requestJsonWithMutation('/api/example', options);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test('requestJson refuses a body that is already a JSON string, before sending anything', async () => {
  // Since 5ba3371 four views passed JSON.stringify(...) here. requestJson stringified it
  // again, the server received a JSON string instead of an object, and every Test Center
  // submission came back 400 "request body must be an object".
  let sent = 0;
  globalThis.fetch = async () => { sent += 1; return new Response('{}', { status: 201 }); };

  await assert.rejects(
    () => requestJson('/api/attempts', { method: 'POST', body: JSON.stringify({ topic_slug: 't' }) }),
    (err) => err instanceof TypeError && /object, not a string/.test(err.message),
  );
  assert.equal(sent, 0, 'a twice-encoded body must never reach the server');

  // Control: the same stub and route with an object body does send, so the silence above
  // is the guard and not a stub that was never reached.
  await requestJson('/api/attempts', { method: 'POST', body: { topic_slug: 't' } });
  assert.equal(sent, 1);
});
