// WHAT: What `app/lib/claude.mjs` sends to the Claude API, when it retries, and where the
//       API key is allowed to appear.
// WHY:  The cockpit was local-only until the role sessions. This client is the one place
//       a secret and learner content leave the machine, so what it sends is pinned here
//       before anything is built on top of it.
//
// SAME RULE AS gradeegress/batchegress: nothing here asserts the SHAPE of a Claude
// response. The stub is a recorder; every assertion is over the request THIS APP SENT and
// what THIS APP returned or threw. The stub serves the minimum message-shaped body needed
// to get the client to the code under test. If the Messages API envelope changes, this
// file keeps passing and the real call breaks — the live acceptance run is the check on
// that, not this file.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-claude-egress-'));

// Not a real secret. Named so a grep for it in any output is unambiguous.
const FAKE_KEY = 'claude-egress-test-key-never-real';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Every request this app sent to "Claude", in order. */
const sent = [];
/** Scripted answers, consumed one per request. Empty means a plain success. */
let script = [];

const okBody = (text = 'A reply.') => ({
  type: 'message',
  model: 'stub-model',
  stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'text', text }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

const stub = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  sent.push({ method: req.method, path: new URL(req.url, 'http://stub').pathname, headers: req.headers, body });

  const next = script.shift() ?? { status: 200, body: okBody() };
  res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
  res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));

// Set before config.mjs is imported — it resolves once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_CLAUDE_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.STUDYDECK_ANTHROPIC_API_KEY = FAKE_KEY;

const { config, configSummary } = await import('../lib/config.mjs');
const { ClaudeError, createMessage, estimateCostUsd, health, resetFallbackState } = await import('../lib/claude.mjs');
const { handleRequest } = await import('../router.mjs');

// Asserted, not assumed: without this the file could reach the real API with a fake key.
assert.equal(config.claude.baseUrl, process.env.STUDYDECK_CLAUDE_BASE_URL, 'not talking to the recorder');

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** Console output captured for the whole file, so a leaked key anywhere is caught. */
const logged = [];
const originals = { log: console.log, warn: console.warn, error: console.error };
for (const level of Object.keys(originals)) {
  console[level] = (...args) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.stack}\n${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
}

after(() => {
  Object.assign(console, originals);
  server.close();
  stub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  sent.length = 0;
  script = [];
  resetFallbackState();
});

const noSleep = async () => {};
const ask = (overrides = {}) => createMessage({
  system: 'You are a fixture.',
  messages: [{ role: 'user', content: 'Hello.' }],
  maxTokens: 1000,
  effort: 'low',
  sleep: noSleep,
  ...overrides,
});

const rejection = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail('expected the call to reject');
};

test('a request carries the key header, the API version, the configured model and the effort', async () => {
  const reply = await ask();

  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/messages');
  assert.equal(request.headers['x-api-key'], FAKE_KEY);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body.model, config.claude.model);
  assert.equal(request.body.max_tokens, 1000);
  assert.deepEqual(request.body.output_config, { effort: 'low' });
  assert.equal(request.body.system, 'You are a fixture.');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Hello.' }]);
  // Opus 5.5 rejects every explicit thinking setting except adaptive; sending none is the
  // form that cannot go stale.
  assert.equal('thinking' in request.body, false);

  assert.equal(reply.text, 'A reply.');
  assert.equal(reply.stopReason, 'end_turn');
  assert.equal(reply.usage.input_tokens, 100);
});

test('the assistant content comes back verbatim, opaque blocks included', async () => {
  // Thinking blocks are bound to the conversation that produced them; a caller that
  // stored only the text could not continue the session.
  const reply = await ask();
  assert.deepEqual(reply.content, okBody().content);
});

test('refusal fallbacks are requested by default', async () => {
  await ask();
  assert.equal(sent[0].body.fallbacks, 'default');
  assert.equal(sent[0].headers['anthropic-beta'], FALLBACK_BETA);
});

test('an account without the fallback beta is retried once without it, and stays downgraded', async () => {
  script = [{
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: `Unexpected value(s) \`${FALLBACK_BETA}\` for the \`anthropic-beta\` header.` } },
  }];

  const reply = await ask();
  assert.equal(sent.length, 2, 'one refused request, one retry without the beta');
  assert.equal('fallbacks' in sent[1].body, false);
  assert.equal(sent[1].headers['anthropic-beta'], undefined);
  assert.equal(reply.fallbacksEnabled, false);

  // The 400 is paid once per process, not once per turn.
  sent.length = 0;
  await ask();
  assert.equal(sent.length, 1);
  assert.equal('fallbacks' in sent[0].body, false);
});

for (const status of [400, 401, 402, 403, 404, 413]) {
  test(`a ${status} is not retried`, async () => {
    script = [{ status, body: { type: 'error', error: { type: 'some_error', message: 'no' } } }];
    const err = await rejection(ask());
    assert.ok(err instanceof ClaudeError);
    assert.equal(sent.length, 1);
    assert.match(err.message, /Claude API/);
  });
}

for (const status of [429, 500, 529]) {
  test(`a ${status} is retried at most twice`, async () => {
    const failure = { status, body: { type: 'error', error: { type: 'some_error', message: 'busy' } } };
    script = [failure, failure, failure, failure];
    const err = await rejection(ask());
    assert.equal(sent.length, 3, 'the first attempt plus two retries');
    assert.equal(err.status, 503);
    assert.match(err.message, /Claude API/);
  });
}

test('a retryable failure followed by a success returns the success', async () => {
  script = [{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } }];
  const reply = await ask();
  assert.equal(sent.length, 2);
  assert.equal(reply.text, 'A reply.');
});

test('retry-after is honoured, and one too long to wait is not waited for', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };

  script = [{ status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }];
  await ask({ sleep });
  assert.deepEqual(waits, [3000]);

  waits.length = 0;
  sent.length = 0;
  script = [{ status: 429, headers: { 'retry-after': '3600' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }];
  const err = await rejection(ask({ sleep }));
  assert.equal(sent.length, 1, 'an hour-long wait is reported, not slept through');
  assert.deepEqual(waits, []);
  assert.equal(err.status, 503);
});

test('a body that is not a message is a 502, never a guessed reply', async () => {
  for (const body of ['<html>gateway</html>', { type: 'message' }, { type: 'message', content: 'text' }, { hello: 'world' }]) {
    script = [{ status: 200, body }];
    const err = await rejection(ask());
    assert.ok(err instanceof ClaudeError);
    assert.equal(err.status, 502);
  }
});

test('a refusal is returned as a refusal, not thrown and not read as a reply', async () => {
  script = [{ status: 200, body: { ...okBody(''), stop_reason: 'refusal', content: [] } }];
  const reply = await ask();
  assert.equal(reply.refusal, true);
  assert.equal(reply.text, '');
});

test('a request that never answers is a 503 naming the service', async () => {
  // The stub is given no chance to answer inside the client's deadline.
  const hanging = createServer(() => {});
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  try {
    const err = await rejection(ask({ baseUrl: `http://127.0.0.1:${hanging.address().port}`, timeoutMs: 50 }));
    assert.equal(err.status, 503);
    assert.match(err.message, /Claude API/);
    assert.match(err.message, /timed out/);
  } finally {
    hanging.closeAllConnections();
    hanging.close();
  }
});

test('headers that arrive promptly do not stop the deadline: a stalled body still times out', async () => {
  // fetch() resolves on headers. A deadline cleared at that point leaves the body read
  // with no limit, and a turn could hang long past the timeout the learner was promised.
  const stalling = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"type":"message",');
  });
  await new Promise((resolve) => stalling.listen(0, '127.0.0.1', resolve));
  try {
    const err = await rejection(ask({ baseUrl: `http://127.0.0.1:${stalling.address().port}`, timeoutMs: 50 }));
    assert.equal(err.status, 503);
    assert.match(err.message, /timed out/);
  } finally {
    stalling.closeAllConnections();
    stalling.close();
  }
});

test('a transport failure is reported by its error code, never by the runtime\'s own message', async () => {
  // Node's fetch error text is not ours to trust: for a header it rejects, the message
  // quotes the header VALUE, which here is the key.
  const dead = createServer();
  dead.on('connection', (socket) => socket.destroy());
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  try {
    const err = await rejection(ask({ baseUrl: `http://127.0.0.1:${dead.address().port}` }));
    assert.equal(err.status, 503);
    assert.match(err.message, /^The Claude API is unreachable \((connection failed|[A-Z_]+)\)\./);
  } finally {
    dead.close();
  }
});

for (const [label, badKey] of [
  ['an embedded newline', `claude-egress\ntest-key-never-real`],
  ['a trailing newline', `${FAKE_KEY}\n`],
  ['a space', 'claude egress key'],
  ['a non-ASCII character', 'claude-egress-kéy'],
]) {
  test(`a key with ${label} is refused before anything is sent, and is not echoed`, async () => {
    const err = await rejection(ask({ apiKey: badKey }));
    assert.equal(err.status, 503);
    assert.match(err.message, /STUDYDECK_ANTHROPIC_API_KEY/);
    for (const part of badKey.split(/\s+/).filter((p) => p.length > 3)) {
      assert.ok(!err.message.includes(part), 'no fragment of the key is in the message');
    }
    assert.equal(sent.length, 0);

    const state = await health({ apiKey: badKey });
    assert.equal(state.configured, false);
    assert.ok(!JSON.stringify(state).includes(badKey.trim().slice(0, 8)));
    assert.equal(sent.length, 0);
  });
}

test('a ClaudeError carries a message and a status and nothing else', async () => {
  // router.mjs logs the thrown error object on a 5xx. Anything hung on it reaches the log.
  script = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_KEY}` } } }];
  const err = await rejection(ask());
  assert.deepEqual(Object.keys(err).sort(), ['status']);
  assert.ok(!err.message.includes(FAKE_KEY), 'an upstream message echoing the key is redacted');
  assert.ok(!String(err.stack).includes(FAKE_KEY));
});

test('estimateCostUsd prices each kind of token from the configured table', () => {
  const prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 5 };
  const usage = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 100_000 };
  assert.equal(estimateCostUsd(usage, prices), 4 + 10 + 0.4 + 0.5);
  assert.equal(estimateCostUsd({}, prices), 0);
});

test('estimateCostUsd prices each cache-write lifetime at its own rate', () => {
  const prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 };
  const split = {
    cache_creation_input_tokens: 300_000,
    cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 200_000 },
  };
  assert.equal(estimateCostUsd(split, prices), 0.5 + 1.6);
  // A total with no breakdown is priced at the one-hour rate: the meter may over-report,
  // never under-report, against the spending limit.
  assert.equal(estimateCostUsd({ cache_creation_input_tokens: 100_000 }, prices), 0.8);
});

test('/api/roles/health reports the client state and answers 200', async () => {
  script = [{ status: 200, body: { id: config.claude.model } }];
  const res = await fetch(`${BASE}/api/roles/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.reachable, true);
  assert.equal(body.model, config.claude.model);
  assert.equal(sent[0].method, 'GET');
});

test('/api/roles/health is honest about a rejected key', async () => {
  script = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }];
  const res = await fetch(`${BASE}/api/roles/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reachable, true);
  assert.equal(body.authorized, false);
});

test('/api/roles/health passes on WHY the API refused, with the key redacted', async () => {
  // "returned 400" with no reason sends the learner guessing between a bad key, a bad model
  // name and a bad request. The API's own message is the only thing that tells them apart.
  script = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `the reason, echoing ${FAKE_KEY}` } } }];
  const res = await fetch(`${BASE}/api/roles/health`);
  const body = await res.json();
  assert.equal(body.authorized, false);
  assert.match(body.error, /returned 400: the reason, echoing \[redacted\]/);
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
});

test('the boot summary says whether the key resolved, never the key', () => {
  const summary = configSummary();
  assert.equal(summary.claudeKey, 'loaded');
  assert.ok(!JSON.stringify(summary).includes(FAKE_KEY));
});

test('the key appears in no response and no log line, on success and on failure', async () => {
  const seen = [];
  const capture = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    seen.push(JSON.stringify([...res.headers]), await res.text());
  };

  script = [{ status: 200, body: { id: config.claude.model } }];
  await capture('/api/roles/health');
  script = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `bad key ${FAKE_KEY}` } } }];
  await capture('/api/roles/health');
  script = [{ status: 500, body: { type: 'error', error: { type: 'api_error', message: `echo ${FAKE_KEY}` } } }];
  await capture('/api/roles/health');
  await capture('/api/health');

  // A control: the capture really is looking at what the server said.
  assert.ok(seen.some((text) => text.includes('claudeKey')), 'the capture saw /api/health');

  for (const status of [401, 500]) {
    script = Array.from({ length: 3 }, () => ({ status, body: { type: 'error', error: { type: 'x', message: `echo ${FAKE_KEY}` } } }));
    const err = await rejection(ask());
    console.error('[test] simulated router log', err);
  }
  assert.ok(logged.some((line) => line.includes('simulated router log')), 'the log capture is live');

  for (const text of [...seen, ...logged]) {
    assert.ok(!text.includes(FAKE_KEY), `the key leaked into: ${text.slice(0, 120)}`);
  }
});

test('health() without a key reports unconfigured and sends nothing', async () => {
  const state = await health({ apiKey: null });
  assert.deepEqual(state, { configured: false, reachable: false, authorized: false, model: config.claude.model });
  assert.equal(sent.length, 0);
});

test('createMessage without a key is a 503 that sends nothing', async () => {
  const err = await rejection(ask({ apiKey: null }));
  assert.equal(err.status, 503);
  assert.match(err.message, /STUDYDECK_ANTHROPIC_API_KEY/);
  assert.equal(sent.length, 0);
});
