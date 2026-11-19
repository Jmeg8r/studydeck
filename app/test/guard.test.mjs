// WHAT: The browser request boundary at HTTP level — assessment finding F8.
// WHY: The claim under test is "a page you did not open cannot make this server write", and
//      that claim lives entirely in headers: Host, Origin, Content-Type, and the absence of
//      any Access-Control-Allow-* on the way back. None of it is observable from a fake
//      req/res, and none of it is observable through `fetch` either — undici will not let a
//      caller set Host, which is the single most important header here. So these drive the
//      real handler with node:http, where every header is ours to forge.
//
// The mutating route used throughout is POST /api/reading with a deliberately unknown
// topic. It answers 400 once the guard lets it through, which makes "the guard passed" and
// "the guard refused" two different status codes rather than two shades of success — and it
// reaches that 400 without touching the learn tree, so these tests need no fixture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before config.mjs loads, same reason as routes.test.mjs: it resolves the learn root
// once at import time. Nothing here reads the tree, but a stray path is not worth the risk
// of a test one day writing into real study data.
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-guard-'));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { handleRequest } = await import('../router.mjs');
const { saveSketch } = await import('../lib/mindmap.mjs');
const { SECURITY_HEADERS } = await import('../lib/guard.mjs');
const { config } = await import('../lib/config.mjs');

const server = createServer(handleRequest);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const SELF = `127.0.0.1:${PORT}`;

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

/**
 * One raw request, with full control of every header including Host.
 *
 * `setHeader` on the client request rather than the options object for host: Node fills in
 * a Host from the connection options, and passing one in `headers` merges rather than
 * replaces on some paths. Setting it explicitly after construction is unambiguous.
 */
function raw(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    // undefined means "omit" — how a case asks for a request with no Origin at all, which
    // is a different thing from an empty one.
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) req.removeHeader(name);
      else req.setHeader(name, value);
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A well-formed mutating request from the cockpit's own page. */
const legitimate = (overrides = {}) =>
  raw('POST', '/api/reading', {
    headers: {
      host: SELF,
      origin: `http://${SELF}`,
      'content-type': 'application/json',
      ...overrides,
    },
    body: JSON.stringify({ topic_slug: 'no-such-topic', source_id: 'x', position: 0.5 }),
  });

test('the cockpit page can still mutate — the guard is not simply a wall', async () => {
  const res = await legitimate();
  // 400 from the route's own topic validation, which is only reachable past the guard.
  assert.equal(res.status, 400);
  assert.match(res.text, /known topic_slug/);
});

test('a mutating request with no Origin passes — curl and the test suite are not browsers', async () => {
  const res = await legitimate({ origin: undefined });
  assert.equal(res.status, 400);
});

test('a cross-origin Origin is refused', async () => {
  const res = await legitimate({ origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.match(res.text, /cross-origin/);
});

test('Origin: null is refused — a sandboxed iframe is not the cockpit', async () => {
  const res = await legitimate({ origin: 'null' });
  assert.equal(res.status, 403);
});

test('a same-host Origin on a different port is refused', async () => {
  // The port matters: another local app is a different origin, and treating loopback as one
  // trust domain would let anything else on the machine drive this one from a browser.
  const res = await legitimate({ origin: 'http://127.0.0.1:1' });
  assert.equal(res.status, 403);
});

test('the form-shaped CSRF POST is refused on content-type', async () => {
  // What a hostile page can actually send cross-origin without a preflight: a <form> or a
  // no-cors fetch, neither of which can set application/json. This is the attack F8 named.
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const res = await legitimate({ 'content-type': type });
    assert.equal(res.status, 415, `${type} should be refused`);
  }
});

test('a JSON content-type with parameters is accepted', async () => {
  const res = await legitimate({ 'content-type': 'application/JSON; charset=utf-8' });
  assert.equal(res.status, 400);
});

test('a rebound Host is refused, on reads as well as writes', async () => {
  // DNS rebinding reaches this server over an attacker-controlled NAME. It is a read attack
  // too — the point of rebinding is that the page can then see the response — so this check
  // has to cover GET, which is why it sits above the safe-method return in the guard.
  const write = await legitimate({ host: 'attacker.example' });
  assert.equal(write.status, 403);

  const read = await raw('GET', '/nope', { headers: { host: 'attacker.example' } });
  assert.equal(read.status, 403);
  assert.match(read.text, /loopback Host/);
});

test('loopback literals are accepted, on any port', async () => {
  // Any port: the suite itself is on an ephemeral one, and pinning the configured port
  // would mean these tests exercised something the browser never does.
  for (const host of [SELF, `localhost:${PORT}`, `[::1]:${PORT}`, '127.0.0.1']) {
    const res = await raw('GET', '/nope', { headers: { host } });
    assert.equal(res.status, 404, `${host} should reach routing`);
  }
});

test('no response carries a CORS grant — this is what makes a preflight unwinnable', async () => {
  // The reason there is no CSRF token: application/json forces a preflight cross-origin,
  // and a preflight cannot succeed against a server that never allows an origin. If this
  // assertion ever fails, the token argument in guard.mjs stops holding.
  const responses = [
    await legitimate(),
    await legitimate({ origin: 'http://evil.example' }),
    await raw('OPTIONS', '/api/reading', { headers: { host: SELF, origin: 'http://evil.example' } }),
    await raw('GET', '/nope', { headers: { host: SELF } }),
  ];
  for (const res of responses) {
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-methods'], undefined);
  }
});

test('the Recovery writes sit behind the guard like every other mutation', async () => {
  for (const path of ['/api/recovery/settle', '/api/recovery/reconcile']) {
    const send = (headers) => raw('POST', path, {
      headers: { host: SELF, origin: `http://${SELF}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ topic_slug: 'no-such-topic', attempt_id: 'x', operation_id: 'x' }),
    });
    // Control: the cockpit's own page reaches the route, which then refuses the topic.
    const own = await send({});
    assert.equal(own.status, 400, `${path}: ${own.text}`);
    assert.equal((await send({ origin: 'http://evil.example' })).status, 403, `${path} accepted a cross-origin write`);
    assert.equal((await send({ 'content-type': 'text/plain' })).status, 415, `${path} accepted a form-shaped write`);
    for (const res of [own, await send({ origin: 'http://evil.example' })]) {
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  }
});

test('the chapter render writes and reads sit behind the guard like every other route', async () => {
  // Each write is a render that spends local model and voice time, so another tab must not
  // be able to start, resume or publish one. The unknown topic makes "reached the route" a
  // 400 that touches nothing.
  const id = `render-${'0'.repeat(24)}`;
  for (const path of ['/api/podcast/renders', `/api/podcast/renders/${id}/resume`, `/api/podcast/renders/${id}/publish`]) {
    const send = (headers) => raw('POST', path, {
      headers: { host: SELF, origin: `http://${SELF}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ topic_slug: 'no-such-topic', source_id: 'x', mutation_id: 'x', episode_profile: 'x', speaker_profile: 'x' }),
    });
    const own = await send({});
    assert.equal(own.status, 400, `${path}: ${own.text}`);
    assert.match(own.text, /must be a known topic/, `${path} was refused before the route`);
    const refused = [
      [await send({ origin: 'http://evil.example' }), 403, 'a cross-origin write'],
      [await send({ 'content-type': 'text/plain' }), 415, 'a form-shaped write'],
      [await send({ host: 'attacker.example' }), 403, 'a rebound Host'],
    ];
    for (const [res, status, what] of refused) assert.equal(res.status, status, `${path} accepted ${what}`);
    for (const res of [own, ...refused.map(([res]) => res)]) {
      assert.equal(res.headers['access-control-allow-origin'], undefined, path);
      assert.equal(res.headers['access-control-allow-methods'], undefined, path);
    }
  }
  const audio = await raw('GET', `/api/podcast/renders/${id}/audio?topic=no-such-topic`, { headers: { host: 'attacker.example' } });
  assert.equal(audio.status, 403, 'a rebound Host may not read audio either');
});

test('security headers ride on every response, including refusals', async () => {
  // Set with res.setHeader before routing, so a route added later cannot forget them and
  // the handler's catch cannot bypass them. A 403 is the interesting case: it is written by
  // the error path, which never sees the security-header constant.
  const cases = [
    await raw('GET', '/nope', { headers: { host: SELF } }),          // 404, normal path
    await legitimate({ origin: 'http://evil.example' }),             // 403, catch path
    await legitimate(),                                              // 400, route's own reply
  ];
  for (const res of cases) {
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
});

test("the CSP blocks inline script, which is the reading view's injection sink", () => {
  // reading.mjs assigns rendered Open Notebook markdown to innerHTML. script-src without
  // 'unsafe-inline' is what stops an <img onerror=...> in a source document from running.
  const csp = SECURITY_HEADERS['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('an SVG sketch is refused at storage, not just at upload', async () => {
  // The browser file picker no longer offers SVG, but a picker is a suggestion. SVG was
  // being stored and then served back as image/svg+xml from this app's own origin, where
  // script inside it runs with the app's rights.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64');
  assert.throws(
    () => saveSketch('any-topic', `data:image/svg+xml;base64,${svg}`),
    (err) => err.status === 400 && /unsupported sketch type/.test(err.message),
  );
});

test('prototype-shaped sketch MIME types cannot fall through the allowlist', () => {
  // A valid, tiny WebP is deliberately paired with a malicious MIME. Before the
  // allowlist became a null-prototype map, `__proto__` produced a truthy extension and
  // WebP bytes skipped their own MIME check, creating a file with a nonsensical suffix.
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]).toString('base64');
  assert.throws(
    () => saveSketch('any-topic', `data:__proto__;base64,${webp}`),
    (err) => err.status === 400 && /unsupported sketch type/.test(err.message),
  );
});

// ---------- the tailnet door (docs/changes/2026-11-09-tailnet-access) ----------
//
// Tailscale Serve terminates HTTPS on the tailnet and forwards to this loopback port with
// the tailnet name in Host and the signed-in user in Tailscale-User-Login. These cases set
// config.tailnet directly, the way the suite sets the learn root, so the door can be
// opened and closed per case without touching the environment config.mjs read at import.

const TAILNET = {
  origin: 'https://box.tail0000.ts.net:4310',
  host: 'box.tail0000.ts.net:4310',
  user: 'james@example.com',
};

async function withTailnet(fn) {
  const before = config.tailnet;
  config.tailnet = TAILNET;
  try {
    return await fn();
  } finally {
    config.tailnet = before;
  }
}

const viaTailnet = (method, path, headers = {}, body) =>
  raw(method, path, {
    headers: { host: TAILNET.host, 'tailscale-user-login': TAILNET.user, ...headers },
    body,
  });

const tailnetWrite = (headers = {}) =>
  viaTailnet('POST', '/api/reading', {
    origin: TAILNET.origin,
    'content-type': 'application/json',
    ...headers,
  }, JSON.stringify({ topic_slug: 'no-such-topic', source_id: 'x', position: 0.5 }));

test('the configured tailnet Host with the configured user reaches routing, read and write', async () => {
  await withTailnet(async () => {
    assert.equal((await viaTailnet('GET', '/nope')).status, 404);
    // 400 from the route's topic validation: past the guard, the same proof as loopback.
    assert.equal((await tailnetWrite()).status, 400);
  });
});

test('the tailnet Host is matched without regard to case', async () => {
  await withTailnet(async () => {
    const res = await viaTailnet('GET', '/nope', { host: TAILNET.host.toUpperCase() });
    assert.equal(res.status, 404);
  });
});

test('the tailnet Host without the configured user is refused, on reads as well as writes', async () => {
  // A read matters as much as a write here: the learning record is what the door protects.
  await withTailnet(async () => {
    // No surrounding-whitespace case: HTTP strips it from header values before Node sees
    // them, so `user ` arrives as `user` and is the right user, not a near miss.
    for (const user of [undefined, '', 'someone-else@example.com', `${TAILNET.user}.evil.example`, TAILNET.user.toUpperCase()]) {
      const read = await viaTailnet('GET', '/nope', { 'tailscale-user-login': user });
      assert.equal(read.status, 403, `GET with user ${JSON.stringify(user)} should be refused`);
      assert.doesNotMatch(read.text, /james@example\.com/, 'the refusal must not name the expected user');
      const write = await tailnetWrite({ 'tailscale-user-login': user });
      assert.equal(write.status, 403, `POST with user ${JSON.stringify(user)} should be refused`);
    }
  });
});

test('only the exact configured tailnet Host opens the door', async () => {
  await withTailnet(async () => {
    for (const host of ['box.tail0000.ts.net', 'box.tail0000.ts.net:443', 'other.tail0000.ts.net:4310', 'box.tail0000.ts.net.evil.example:4310']) {
      const res = await viaTailnet('GET', '/nope', { host });
      assert.equal(res.status, 403, `${host} should be refused`);
    }
  });
});

test('a tailnet write from a foreign Origin is refused, including the plain-http form of its own name', async () => {
  await withTailnet(async () => {
    for (const origin of ['https://evil.example', `http://${TAILNET.host}`, 'null', 'https://box.tail0000.ts.net']) {
      const res = await tailnetWrite({ origin });
      assert.equal(res.status, 403, `Origin ${origin} should be refused`);
    }
    // No Origin at all is still "not a browser", exactly as on loopback.
    assert.equal((await tailnetWrite({ origin: undefined })).status, 400);
  });
});

test('with tailnet access off, the tailnet Host is refused as any other name', async () => {
  const before = config.tailnet;
  config.tailnet = null;
  try {
    const res = await viaTailnet('GET', '/nope');
    assert.equal(res.status, 403);
    assert.match(res.text, /loopback Host/);
  } finally {
    config.tailnet = before;
  }
});

test('a loopback request is unaffected by a Tailscale-User-Login header, with the door open or shut', async () => {
  // Loopback never needs the header and never reads it: a stray or forged value must not
  // change the answer in either direction.
  for (const tailnet of [null, TAILNET]) {
    const before = config.tailnet;
    config.tailnet = tailnet;
    try {
      const read = await raw('GET', '/nope', { headers: { host: SELF, 'tailscale-user-login': 'someone-else@example.com' } });
      assert.equal(read.status, 404);
      assert.equal((await legitimate({ 'tailscale-user-login': 'someone-else@example.com' })).status, 400);
      // A loopback page still has to send its own loopback Origin, never the tailnet one.
      assert.equal((await legitimate({ origin: TAILNET.origin })).status, 403);
    } finally {
      config.tailnet = before;
    }
  }
});

test('no tailnet response carries a CORS grant', async () => {
  await withTailnet(async () => {
    const responses = [
      await tailnetWrite(),
      await tailnetWrite({ origin: 'https://evil.example' }),
      await viaTailnet('OPTIONS', '/api/reading', { origin: 'https://evil.example' }),
      await viaTailnet('GET', '/nope', { 'tailscale-user-login': undefined }),
    ];
    for (const res of responses) {
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['access-control-allow-methods'], undefined);
    }
  });
});

const RAW_TARGET_TIMEOUT_MS = 2000;

/**
 * A request line node:http's client will not send: the target is raw text on a socket.
 * Resolves with whatever came back before the server closed the connection.
 */
function rawTarget(target, host) {
  return new Promise((resolve, reject) => {
    let text = '';
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    // A handler that never answers is the failure being pinned; end it as an empty reply.
    socket.setTimeout(RAW_TARGET_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
  });
}

test('a request target that is not a URL is answered, after the guard, and the server keeps serving', async () => {
  // Parsing the target before the try made a malformed one an unhandled rejection, reached
  // ahead of the boundary check by any caller at all, the tailnet included.
  assert.match(await rawTarget('http://[/', 'anything.example'), /^HTTP\/1\.1 403 /);
  assert.match(await rawTarget('http://[/', SELF), /^HTTP\/1\.1 400 /);
  assert.equal((await raw('GET', '/nope', { headers: { host: SELF } })).status, 404);
});

/** Runs `fn` with console.warn recorded instead of printed; returns the recorded lines. */
async function recordingWarnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test('a refused request logs the path it asked for; a target that is not a URL logs (unparsed)', async () => {
  // The guard runs before the target is parsed, so the catch has to work the path out for
  // itself — and must not throw while doing it, or the refusal never reaches the caller.
  const refused = await recordingWarnings(async () => {
    assert.equal((await raw('GET', '/api/state?date=2026-01-01', { headers: { host: 'rebind.example' } })).status, 403);
  });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /GET \/api\/state → 403/);
  // pathname only: the query string never reaches the log.
  assert.doesNotMatch(refused[0], /date=/);

  const malformed = await recordingWarnings(async () => {
    assert.match(await rawTarget('http://[/', SELF), /^HTTP\/1\.1 400 /);
  });
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /GET \(unparsed\) → 400/);
});
