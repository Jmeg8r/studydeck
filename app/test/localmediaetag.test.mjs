// WHAT: sendLocalMedia's optional content-hash ETag.
// WHY:  A rendered chapter is replaced in place when it is re-rendered, so a size-and-mtime
//       ETag can match two different files and a browser would keep the old audio. With
//       `sha256` given, the hash is the strong ETag. Without it, nothing changes: the video
//       route passes none, and localmedia.test.mjs still pins that path through the router.
//       Driven directly through a local server, because no route passes sha256 until D5d.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendLocalMedia } from '../lib/localmedia.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-localmediaetag-'));
const FILE = join(ROOT, 'chapter.mp3');
writeFileSync(FILE, Buffer.from('ID3 not really audio, but bytes enough to serve'));
const SHA = 'a'.repeat(64);

let options = { path: FILE, type: 'audio/mpeg' };
const server = createServer((req, res) => sendLocalMedia(req, res, options));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(ROOT, { recursive: true, force: true });
});

test('control: without sha256 the ETag is still size and mtime', async () => {
  options = { path: FILE, type: 'audio/mpeg' };
  const { size, mtimeMs } = statSync(FILE);
  const res = await fetch(url);
  await res.arrayBuffer();
  assert.equal(res.headers.get('etag'), `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`);
});

test('with sha256 the hash is the strong ETag, and If-None-Match on it is 304', async () => {
  options = { path: FILE, type: 'audio/mpeg', sha256: SHA };
  const res = await fetch(url);
  await res.arrayBuffer();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('etag'), `"${SHA}"`);

  const revalidated = await fetch(url, { headers: { 'if-none-match': `"${SHA}"` } });
  assert.equal(revalidated.status, 304);
  assert.equal((await revalidated.arrayBuffer()).byteLength, 0);

  const stale = await fetch(url, { headers: { 'if-none-match': '"some-older-render"' } });
  await stale.arrayBuffer();
  assert.equal(stale.status, 200, 'another render\'s tag gets the new bytes');
});
