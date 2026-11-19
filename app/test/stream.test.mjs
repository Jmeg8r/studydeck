// WHAT: Tests for pipeStream/pipeFile — the handlers that keep a failed download from
//       taking the process down.
// WHY: `.pipe()` does not forward errors. Every streamed route used to call
//      `createReadStream(path).pipe(res)` with no 'error' listener, and an unlistened
//      'error' on a stream is an UNHANDLED event: one bad read ended the whole cockpit.
//      The bug is invisible in a diff and impossible to see in a passing request, so it
//      is pinned here by actually making a stream fail.
//
// The first assertion is the one that matters: without the listener, `stream.emit('error')`
// below does not fail this test — it terminates the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeFile, pipeStream } from '../lib/stream.mjs';

/** A stand-in for ServerResponse: collects bytes and records an early destroy. */
function fakeResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  res.chunks = chunks;
  // Only an explicit destroy counts. A Writable auto-destroys itself after a normal
  // end(), so recording every destroy would report a healthy transfer as a failed one.
  res.destroyedEarly = false;
  const realDestroy = res.destroy.bind(res);
  res.destroy = (err) => {
    if (!res.writableEnded) res.destroyedEarly = true;
    return realDestroy(err);
  };
  return res;
}

const settled = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

test('a stream that fails mid-transfer destroys the response instead of the process', async () => {
  const res = fakeResponse();
  const source = new Readable({ read() {} });

  pipeStream(res, source, 'fixture');
  source.push('some bytes');
  // Reaching this line at all is the point: an unhandled 'error' would end the runner.
  source.emit('error', new Error('disk went away'));
  await settled(res, 'close');

  assert.equal(res.destroyedEarly, true, 'the response must be destroyed, not left hanging');
});

test('the response is destroyed rather than ended, so a truncated body reads as a failure', async () => {
  const res = fakeResponse();
  const source = new Readable({ read() {} });

  pipeStream(res, source, 'fixture');
  source.push('half a file');
  source.emit('error', new Error('EIO'));
  await settled(res, 'close');

  // Ending normally would hand the client a silently short file and call it a success.
  assert.equal(res.writableEnded, false);
});

test('a client that disconnects destroys the source stream', async () => {
  const res = fakeResponse();
  const source = new Readable({ read() {} });

  pipeStream(res, source, 'fixture');
  source.push('first chunk');
  // What a closed tab looks like mid-download. Without this the read stream stays open
  // with nothing draining it — one leaked descriptor per abandoned 46MB video.
  res.destroy();
  await settled(source, 'close');

  assert.equal(source.destroyed, true);
});

test('pipeFile streams a real file through to completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studydeck-stream-'));
  const path = join(dir, 'clip.txt');
  writeFileSync(path, 'the whole file');

  const res = fakeResponse();
  pipeFile(res, path);
  await settled(res, 'finish');

  assert.equal(Buffer.concat(res.chunks).toString(), 'the whole file');
  assert.equal(res.destroyedEarly, false, 'a healthy transfer must not be destroyed');
  rmSync(dir, { recursive: true, force: true });
});

test('pipeFile honours a byte range, and a missing file fails without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studydeck-stream-'));
  const path = join(dir, 'clip.txt');
  writeFileSync(path, '0123456789');

  const ranged = fakeResponse();
  pipeFile(ranged, path, { start: 2, end: 5 });
  await settled(ranged, 'finish');
  assert.equal(Buffer.concat(ranged.chunks).toString(), '2345');

  // ENOENT arrives as an 'error' event on the stream, not as a throw at the call site —
  // which is exactly why the missing listener was fatal rather than merely wrong.
  const missing = fakeResponse();
  pipeFile(missing, join(dir, 'not-here.txt'));
  await settled(missing, 'close');
  assert.equal(missing.destroyedEarly, true);

  rmSync(dir, { recursive: true, force: true });
});
