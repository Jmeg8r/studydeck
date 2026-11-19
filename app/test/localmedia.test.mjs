// WHAT: The local video shelf over HTTP: HEAD, validators, conditional requests, If-Range,
//       and the byte ranges that already worked. docs/changes/2026-11-10-local-video-validators.
// WHY:  Measured on 2026-11-10 against a 46MB tutorial: HEAD answered 404 JSON, no response
//       carried an ETag or Last-Modified (so every reopen re-downloaded the whole file), and a
//       stale If-Range still got a 206 slice, which splices two versions of a re-rendered
//       file. The range cases are controls: the fix moves that parsing, so it must not change it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-localmedia-'));
const SHELF = join(FIXTURE_ROOT, 'shelf');
const LEARN = join(FIXTURE_ROOT, 'learn');
const CLIP = 'fixture-clip.mp4';
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
// A fractional second on purpose: HTTP dates carry whole seconds, so a validator that compared
// raw milliseconds would never let this file revalidate.
const MTIME = new Date('2026-07-22T14:09:32.500Z');
const LAST_MODIFIED = 'Wed, 22 Jul 2026 14:09:32 GMT';

mkdirSync(SHELF);
mkdirSync(LEARN);
writeFileSync(join(SHELF, CLIP), BODY);
// An empty file is where a suffix range resolves to no bytes at all.
const EMPTY = 'empty-clip.mp4';
writeFileSync(join(SHELF, EMPTY), Buffer.alloc(0));
utimesSync(join(SHELF, CLIP), MTIME, MTIME);

// Set before config.mjs and videos.mjs load: both read the environment once, at import.
process.env.STUDYDECK_VIDEO_DIR = SHELF;
process.env.STUDYDECK_LEARN_ROOT = LEARN;
process.env.STUDYDECK_ON_BASE_URL = 'http://127.0.0.1:9';
process.env.STUDYDECK_ON_PASSWORD = 'localmedia-test-not-real';

const { handleRequest } = await import('../router.mjs');

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const PORT = app.address().port;

after(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/** One request to the cockpit; resolves with status, headers and the whole body. */
function video(method = 'GET', headers = {}, name = CLIP) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: PORT, method, path: `/media/videos/${encodeURIComponent(name)}`,
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// --- Controls: what already worked, and must keep working through the move.

test('control: a full GET is 200, every byte, and advertises ranges', async () => {
  const res = await video();
  assert.equal(res.status, 200);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.deepEqual(res.body, BODY);
});

test('control: prefix, open-ended and suffix ranges return exactly those bytes', async () => {
  for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=100-', 100, 999], ['bytes=-100', 900, 999]]) {
    const res = await video('GET', { range });
    assert.equal(res.status, 206, range);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/1000`, range);
    assert.deepEqual(res.body, BODY.subarray(start, end + 1), range);
  }
});

test('control: past-the-end and multi-range requests are 416 with the size', async () => {
  for (const range of ['bytes=5000-', 'bytes=0-1,5-6']) {
    const res = await video('GET', { range });
    assert.equal(res.status, 416, range);
    assert.equal(res.headers['content-range'], 'bytes */1000', range);
  }
});

// Codex review of PR #144: the move gave suffix ranges an early return that skipped the bounds
// check sendVideo applied to every range, so these wrote a 206 and then threw in the stream.
test('control: a suffix range that selects no bytes is 416, never a 206', { timeout: 5000 }, async () => {
  for (const [name, range, size] of [[CLIP, 'bytes=-0', 1000], [EMPTY, 'bytes=-5', 0], [EMPTY, 'bytes=-0', 0]]) {
    const res = await video('GET', { range }, name);
    assert.equal(res.status, 416, `${name} ${range}`);
    assert.equal(res.headers['content-range'], `bytes */${size}`, `${name} ${range}`);
  }
  assert.equal((await video()).status, 200, 'the server is still answering afterwards');
});

test('control: a name that is not on the shelf is 404', async () => {
  assert.equal((await video('GET', {}, 'not-here.mp4')).status, 404);
  assert.equal((await video('GET', {}, '../package.json')).status, 404);
});

// --- The change.

test('HEAD answers 200 with the GET headers and no body', async () => {
  const get = await video();
  const head = await video('HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  for (const name of ['content-type', 'content-length', 'accept-ranges', 'etag', 'last-modified']) {
    assert.equal(head.headers[name], get.headers[name], name);
  }
});

test('GET carries a strong ETag and the file time as Last-Modified', async () => {
  const res = await video();
  assert.match(res.headers.etag ?? '', /^"[^"]+"$/, 'a strong, quoted ETag');
  assert.equal(res.headers['last-modified'], LAST_MODIFIED);
});

test('a matching If-None-Match, *, or its weak form is 304 with no body; another tag is 200', async () => {
  const { etag } = (await video()).headers;
  assert.ok(etag, "GET carries an ETag to revalidate with");
  for (const tag of [etag, '*', `W/${etag}`, `"other", ${etag}`]) {
    const res = await video('GET', { 'if-none-match': tag });
    assert.equal(res.status, 304, tag);
    assert.equal(res.body.length, 0, tag);
  }
  assert.equal((await video('GET', { 'if-none-match': '"other"' })).status, 200);
});

test('If-Modified-Since revalidates at whole-second resolution, and yields to If-None-Match', async () => {
  assert.equal((await video('GET', { 'if-modified-since': LAST_MODIFIED })).status, 304);
  assert.equal((await video('GET', { 'if-modified-since': 'Wed, 22 Jul 2026 14:09:31 GMT' })).status, 200);
  // RFC 9110 13.1.3: when If-None-Match is present, If-Modified-Since is ignored.
  assert.equal((await video('GET', { 'if-none-match': '"other"', 'if-modified-since': LAST_MODIFIED })).status, 200);
});

test('If-Range with a stale validator gets the whole file; a current one gets the range', async () => {
  const { etag } = (await video()).headers;
  assert.ok(etag, "GET carries an ETag to revalidate with");
  const stale = await video('GET', { range: 'bytes=0-99', 'if-range': '"stale"' });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body, BODY);
  for (const validator of [etag, LAST_MODIFIED]) {
    const res = await video('GET', { range: 'bytes=0-99', 'if-range': validator });
    assert.equal(res.status, 206, validator);
    assert.deepEqual(res.body, BODY.subarray(0, 100), validator);
  }
});

test('the security headers ride on HEAD and 304 as well as on GET', async () => {
  const { etag } = (await video()).headers;
  assert.ok(etag, "GET carries an ETag to revalidate with");
  for (const res of [await video('HEAD'), await video('GET', { 'if-none-match': etag })]) {
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
});
