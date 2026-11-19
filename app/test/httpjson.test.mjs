// WHAT: fetchJson's transport contract: a bounded body, a deadline that covers the body,
//       an external abort, a JSON-object-only result, and 502 for protocol failures.
// WHY:  The chapter renderer (D5d) calls Ollama through it. A POST whose response breaks
//       may already have committed, so a broken response must never read as a definite
//       upstream rejection. This is our contract, served by a local server on 127.0.0.1,
//       not an imitation of any provider's API. Ported from 264547c and extended.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (req.url === '/stalled') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
  if (req.url === '/empty') { res.writeHead(204); return res.end(); }
  if (req.url === '/declared-large') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999' });
    return res.end('{}');
  }
  if (req.url === '/streamed-large') {
    res.writeHead(200, { 'content-type': 'application/json' }); // no length: chunked
    return res.end(JSON.stringify({ text: 'x'.repeat(4096) }));
  }
  if (req.url === '/html') { res.writeHead(200); return res.end('<html>wrong endpoint</html>'); }
  if (req.url === '/number') { res.writeHead(200); return res.end('42'); }
  if (req.url === '/null') { res.writeHead(200); return res.end('null'); }
  if (req.url === '/array') { res.writeHead(200); return res.end('[1,2]'); }
  if (req.url === '/teapot') { res.writeHead(418); return res.end('{"error":"no"}'); }
  if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 500); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

const load = () => import('../lib/httpjson.mjs');

test('an object body is returned, and 204 is null', async () => {
  const { fetchJson } = await load();
  assert.deepEqual(await fetchJson(base), { ok: true });
  assert.equal(await fetchJson(`${base}/empty`), null);
});

test('the deadline covers a body that stalls after its headers', async () => {
  const { fetchJson } = await load();
  const start = Date.now();
  await assert.rejects(fetchJson(`${base}/stalled`, { timeout: 80 }), /timed out/);
  assert.ok(Date.now() - start < 1000);
});

test('a body over maxBytes is refused, whether declared or streamed, as a 502', async () => {
  const { fetchJson } = await load();
  for (const path of ['/declared-large', '/streamed-large']) {
    await assert.rejects(fetchJson(`${base}${path}`, { maxBytes: 512 }), (err) => {
      assert.match(err.message, /too large/, path);
      assert.equal(err.status, 502, path);
      return true;
    });
  }
});

test('a body that is not a JSON object is a protocol failure, 502', async () => {
  const { fetchJson } = await load();
  for (const path of ['/html', '/number', '/null', '/array']) {
    await assert.rejects(fetchJson(`${base}${path}`), (err) => {
      assert.match(err.message, /invalid JSON/, path);
      assert.equal(err.status, 502, path);
      return true;
    });
  }
});

test('an upstream status is kept, so a real rejection is not mistaken for a broken response', async () => {
  const { fetchJson } = await load();
  await assert.rejects(fetchJson(`${base}/teapot`), (err) => err.status === 418 && /HTTP 418/.test(err.message));
});

test('a refused connection is a 502, never a definite rejection', async () => {
  const { fetchJson } = await load();
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(fetchJson(`http://127.0.0.1:${port}/`), (err) => err.status === 502);
});

test('an external abort ends the request with the caller\'s reason', async () => {
  const { fetchJson } = await load();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('view closed')), 30);
  await assert.rejects(fetchJson(`${base}/slow`, { signal: controller.signal }), /view closed/);
  const already = AbortSignal.abort(new Error('closed before start'));
  await assert.rejects(fetchJson(`${base}/slow`, { signal: already }), /closed before start/);
});
