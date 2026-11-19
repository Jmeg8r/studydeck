// WHAT: Idempotent speaker-profile creation against Open Notebook.
// WHY: Profiles are global ON configuration rather than topic-owned learner data, so the
//      route uses their stable name plus normalized payload as deterministic recovery
//      identity. This recorder tests what StudyDeck sends and re-reads, not ON's contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-speaker-profile-'));
const sent = [];
const profiles = [];
let acceptThenDrop = false;

const bodyOf = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try { resolve(JSON.parse(raw)); } catch { resolve(null); }
  });
});

const onStub = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const body = await bodyOf(req);
  sent.push(`${req.method} ${url.pathname}`);
  if (req.method === 'GET' && url.pathname === '/api/speaker-profiles') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(profiles));
  }
  if (req.method === 'GET' && url.pathname === '/api/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('[{"id":"model:tts"}]');
  }
  if (req.method === 'POST' && url.pathname === '/api/speaker-profiles') {
    const profile = { id: `speaker:${profiles.length + 1}`, ...body };
    profiles.push(profile);
    if (acceptThenDrop) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"response deliberately lost after creation"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(profile));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'speaker-profile-egress-password-never-real';

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the recorder');

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const request = () => fetch(`${base}/api/on/speaker-profiles`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Fixture voices',
    description: 'A deterministic test profile.',
    speakers: [{ name: 'Ada', voice_id: 'af_nova', backstory: 'Teaches clearly.', personality: 'curious' }],
  }),
});

const postCount = () => sent.filter((entry) => entry === 'POST /api/speaker-profiles').length;

test('an exact repeated profile request reuses its deterministic ON identity', async () => {
  sent.length = 0;
  profiles.length = 0;
  acceptThenDrop = false;

  const first = await request();
  assert.equal(first.status, 201);
  assert.equal(postCount(), 1, 'control: create reached the external write');

  const replay = await request();
  const body = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(postCount(), 1, 'an exact repeat must not create another global profile');
});

test('a response-lost profile create reconciles before the caller can duplicate it', async () => {
  sent.length = 0;
  profiles.length = 0;
  acceptThenDrop = true;

  const first = await request();
  const body = await first.json();
  assert.equal(first.status, 200, 'the route found the externally-created profile after its lost response');
  assert.equal(body.replayed, true);
  assert.equal(postCount(), 1);

  acceptThenDrop = false;
  const replay = await request();
  assert.equal(replay.status, 200);
  assert.equal(postCount(), 1, 'a later retry still reads the existing profile instead of posting');
});
