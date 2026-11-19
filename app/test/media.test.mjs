// WHAT: Episode audio through the cockpit: ranges, HEAD, slow clients, the two deadlines,
//       which headers cross in each direction, and what a disconnect or an outage does.
//       docs/changes/2026-11-09-seekable-episode-audio, acceptance checks A1 to A8.
// WHY:  The route cut every download off 15 s after it started and answered ranges with
//       the whole file, so an iPhone could neither finish nor seek an episode. Nothing
//       tested the route at all.
//
// SAME RULE AS the *egress files: nothing here asserts what Open Notebook returns. The stub
// is a recorder wearing ON's audio URL; it serves a byte pattern of its own and computes
// ranges itself. Every assertion is over what the cockpit SENT upstream or RETURNED to the
// browser. If ON's real responses change, these keep passing; npm run verify:live and the
// live checks in the spec are what notice that.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-media-'));
const PASSWORD = 'media-test-password-not-real';
const EPISODE = 'episode:media-fixture';
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

/** What the stub does next; each test sets it and the stub reads it per request. */
let mode = 'serve';
/** Every request the stub received: method and headers. */
const seen = [];
/** Set when the stub's in-flight response is closed by the cockpit. */
let upstreamClosed = false;
/** How long the stub waits before answering at all: a busy runner, on purpose. */
let headerDelay = 0;
/** The gap between trickle slices, in ms. */
let trickleEvery = 30;

function sliceFor(rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  if (!m) return null;
  const size = BODY.length;
  let start;
  let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? 'unsatisfiable' : { start, end };
}

const onStub = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
  res.on('close', () => { if (!res.writableFinished) upstreamClosed = true; });
  if (headerDelay) setTimeout(() => answer(req, res), headerDelay);
  else answer(req, res);
});

function answer(req, res) {
  // Read once: a trickle still finishing after its test must not take the next test's mode.
  const current = mode;
  const every = trickleEvery;
  if (current === 'no-headers') return; // never answers
  if (req.method === 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json' });
    return res.end();
  }
  if (current === 'html-500') {
    res.writeHead(500, { 'content-type': 'text/html' });
    return res.end('<html>stack trace with secrets</html>');
  }
  if (current === 'not-modified') {
    res.writeHead(304, { etag: '"v1"', 'last-modified': 'Wed, 22 Jul 2026 14:09:32 GMT' });
    return res.end();
  }
  const base = {
    'content-type': 'audio/mpeg',
    'accept-ranges': 'bytes',
    etag: '"v1"',
    'last-modified': 'Wed, 22 Jul 2026 14:09:32 GMT',
    'set-cookie': 'upstream=leak',
    'cache-control': 'public, max-age=99999',
    'content-disposition': 'attachment; filename="upstream.mp3"',
  };
  const range = sliceFor(req.headers.range);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${BODY.length}`, 'content-length': '0' });
    return res.end();
  }
  const { start, end } = range ?? { start: 0, end: BODY.length - 1 };
  const chunk = BODY.subarray(start, end + 1);
  res.writeHead(range ? 206 : 200, {
    ...base,
    'content-length': String(chunk.length),
    ...(range ? { 'content-range': `bytes ${start}-${end}/${BODY.length}` } : {}),
  });
  if (current === 'serve') return res.end(chunk);
  // 'trickle': ten slices, trickleEvery ms apart. 'stall': two slices, then silence.
  const slices = 10;
  const size = Math.ceil(chunk.length / slices);
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (current === 'stall' && i >= 2) return;
    if (i >= slices) return res.end();
    res.write(chunk.subarray(i * size, (i + 1) * size));
    i += 1;
    setTimeout(tick, every);
  };
  tick();
}
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
const STUB_URL = `http://127.0.0.1:${onStub.address().port}`;

// An owned listener that hangs up at once: the outage, without lending the password to
// whatever else might hold a port (see degradation.test.mjs).
const deadOn = createServer();
deadOn.on('connection', (socket) => socket.destroy());
await new Promise((resolve) => deadOn.listen(0, '127.0.0.1', resolve));
const DEAD_URL = `http://127.0.0.1:${deadOn.address().port}`;

// Set before config.mjs loads: it resolves the environment once, at import.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = STUB_URL;
process.env.STUDYDECK_ON_PASSWORD = PASSWORD;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
const { SECURITY_HEADERS } = await import('../lib/guard.mjs');

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const PORT = app.address().port;
const AUDIO_PATH = `/api/on/episodes/${encodeURIComponent(EPISODE)}/audio`;

after(async () => {
  app.closeAllConnections();
  onStub.closeAllConnections();
  await Promise.all([app, onStub, deadOn].map((s) => new Promise((resolve) => s.close(resolve))));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/** One request to the cockpit; resolves with status, headers and the whole body. */
function audio(method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path: AUDIO_PATH, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const reset = (next = 'serve', timing = {}) => {
  mode = next;
  seen.length = 0;
  upstreamClosed = false;
  headerDelay = timing.headerDelay ?? 0;
  trickleEvery = timing.trickleEvery ?? 30;
};

test('A1: a range is forwarded and answered 206 with exactly those bytes', async () => {
  reset();
  const res = await audio('GET', { range: 'bytes=2-5' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 2-5/${BODY.length}`);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.deepEqual([...res.body], [...BODY.subarray(2, 6)]);
  assert.equal(seen.at(-1).headers.range, 'bytes=2-5');
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${PASSWORD}`);
});

test('A2: a body slower than the header deadline still arrives whole', async () => {
  const { fetchMedia } = await import('../lib/media.mjs');
  // CI runners took more than 50 ms to deliver the stub's headers, so the header deadline
  // fired before any body byte. headerDelay plays that slow runner on every run; the
  // deadline leaves it 900 ms more, and ten slices 150 ms apart still outlast it.
  const headerTimeout = 1000;
  reset('trickle', { headerDelay: 100, trickleEvery: 150 });
  const started = Date.now();
  const media = await fetchMedia(`${STUB_URL}/x`, { headerTimeout, idleTimeout: 1000 });
  const parts = [];
  for await (const c of media.body) parts.push(c);
  const elapsed = Date.now() - started;
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.concat(parts), BODY);
  assert.ok(elapsed > headerTimeout, `the body ended at ${elapsed} ms, inside the ${headerTimeout} ms header deadline, so this proved nothing`);
});

test('A3: no headers fails at the header deadline; a stalled body fails at the idle deadline', async () => {
  const { fetchMedia } = await import('../lib/media.mjs');
  reset('no-headers');
  const started = Date.now();
  await assert.rejects(() => fetchMedia(`${STUB_URL}/x`, { headerTimeout: 100, idleTimeout: 1000 }));
  assert.ok(Date.now() - started < 1000, 'the header deadline did not fire');

  reset('stall');
  const media = await fetchMedia(`${STUB_URL}/x`, { headerTimeout: 1000, idleTimeout: 150 });
  await assert.rejects(async () => { for await (const _ of media.body) { /* drain */ } });
});

test('A4: 304 and 416 pass through; an upstream 500 body never reaches the browser', async () => {
  reset('not-modified');
  const notModified = await audio('GET', { 'if-none-match': '"v1"' });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.etag, '"v1"');
  assert.equal(seen.at(-1).headers['if-none-match'], '"v1"');

  reset();
  const past = await audio('GET', { range: 'bytes=5000-' });
  assert.equal(past.status, 416);
  assert.equal(past.headers['content-range'], `bytes */${BODY.length}`);

  reset('html-500');
  const failed = await audio();
  assert.ok(failed.status >= 500, `answered ${failed.status}`);
  assert.doesNotMatch(failed.body.toString(), /stack trace|<html>/);
});

test('A5: HEAD is answered 200 with the full length from a one-byte probe', async () => {
  reset();
  const res = await audio('HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], String(BODY.length));
  assert.equal(res.headers['content-range'], undefined);
  assert.equal(res.body.length, 0);
  const probe = seen.at(-1);
  assert.equal(probe.method, 'GET');
  assert.equal(probe.headers.range, 'bytes=0-0');
});

test('A6: only media headers cross, in either direction, and the security headers stay', async () => {
  reset();
  const res = await audio('GET', { range: 'bytes=0-9', cookie: 'session=browser', 'x-custom': 'browser', 'accept-encoding': 'gzip' });
  const sent = seen.at(-1).headers;
  assert.equal(sent.cookie, undefined);
  assert.equal(sent['x-custom'], undefined);
  assert.equal(sent['accept-encoding'], 'identity');

  assert.equal(res.status, 206);
  for (const name of ['set-cookie', 'cache-control', 'content-disposition']) {
    assert.equal(res.headers[name], undefined, `${name} crossed to the browser`);
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(res.headers[name], value, `${name} missing on a 206`);
  }
});

test('A7: a client disconnect closes the upstream request and logs nothing', async () => {
  reset('trickle');
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: PORT, path: AUDIO_PATH, headers: { host: `127.0.0.1:${PORT}` } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.end();
      setTimeout(() => reject(new Error('no first chunk')), 2000);
    });
    for (let waited = 0; !upstreamClosed && waited < 2000; waited += 20) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    console.error = original;
  }
  assert.ok(upstreamClosed, 'the upstream request kept streaming after the client left');
  assert.deepEqual(errors, [], `a normal disconnect was logged: ${errors.join(' | ')}`);
});

test('A8: with Open Notebook down the route answers 503 naming it, and leaks no password', async () => {
  const before = config.openNotebook.baseUrl;
  config.openNotebook.baseUrl = DEAD_URL;
  try {
    const res = await audio();
    assert.equal(res.status, 503);
    assert.match(res.body.toString(), /Open Notebook/);
    assert.doesNotMatch(JSON.stringify(res.headers) + res.body.toString(), new RegExp(PASSWORD));
  } finally {
    config.openNotebook.baseUrl = before;
  }
});
