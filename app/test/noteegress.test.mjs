// WHAT: Durable, retry-safe `POST /api/on/notes` writes.
// WHY: Open Notebook exposes no idempotency key. A dropped response used to make a Reading
//      Room retry create a duplicate highlight. This recorder asserts this app's outbound
//      requests and its operation ledger, never Open Notebook's response contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-note-egress-'));
const sent = [];
const bodies = [];
const notes = [];
let acceptThenDrop = false;

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try { resolve(JSON.parse(raw)); } catch { resolve(null); }
  });
});

const onStub = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://stub').pathname);
  const body = await readBody(req);
  sent.push(`${req.method} ${pathname}`);
  bodies.push(body);

  if (req.method === 'GET' && pathname === '/api/notes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(notes));
  }
  if (req.method === 'POST' && pathname === '/api/notes') {
    const note = { id: `note:fixture-${notes.length + 1}`, title: body.title };
    notes.push(note);
    if (acceptThenDrop) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"response deliberately lost after creation"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(note));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'note-egress-password-never-real';

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the recorder');

const TOPIC = config.topics.find((topic) => topic.notebookId).slug;
mkdirSync(join(FIXTURE_ROOT, TOPIC, 'cockpit'), { recursive: true });

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const operations = () => {
  const path = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'operations.jsonl');
  return readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
};

const postNote = async (mutationId) => fetch(`${base}/api/on/notes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    topic_slug: TOPIC,
    title: 'Highlight — Fixture chapter',
    content: '> durable retry evidence',
    mutation_id: mutationId,
  }),
});

const postCount = () => sent.filter((request) => request === 'POST /api/notes').length;

test('a note is prepared before its Open Notebook POST and exact replay creates no duplicate', async () => {
  sent.length = 0;
  bodies.length = 0;
  notes.length = 0;
  acceptThenDrop = false;

  const first = await postNote('note-create');
  const created = await first.json();
  assert.equal(first.status, 201);
  assert.equal(postCount(), 1);
  assert.equal(operations()[1].stage, 'prepared', 'the external POST must follow a durable prepare row');
  assert.equal(operations().at(-1).stage, 'complete');
  assert.match(bodies[sent.findIndex((request) => request === 'POST /api/notes')].title, /\[StudyDeck [a-f0-9]{12}\]$/);

  const replay = await postNote('note-create');
  const replayed = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.replayed, true);
  assert.equal(postCount(), 1, 'an acknowledged replay must not make a second external note');
});

test('a lost POST response reconciles by marker and never blindly posts again', async () => {
  sent.length = 0;
  bodies.length = 0;
  notes.length = 0;
  acceptThenDrop = true;

  const first = await postNote('note-lost-response');
  assert.equal(first.status, 500);
  assert.equal(postCount(), 1, 'control: the first attempt reached the external write');
  assert.equal(operations().at(-1).stage, 'ambiguous');

  acceptThenDrop = false;
  const retry = await postNote('note-lost-response');
  const recovered = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.id, notes[0].id);
  assert.equal(postCount(), 1, 'recovery must list and reconcile, never duplicate the note');
  assert.equal(operations().at(-1).stage, 'complete');
});

test('two notes carrying the same marker leave the operation ambiguous instead of picking one', async () => {
  // The marker is unique per learner action, so two matches mean a duplicate already exists.
  // Completing against the first would hide it; the operation has to stay visible.
  sent.length = 0;
  bodies.length = 0;
  notes.length = 0;
  acceptThenDrop = true;

  const first = await postNote('note-duplicate-marker');
  assert.equal(first.status, 500);
  assert.equal(postCount(), 1, 'control: the first attempt reached the external write');
  notes.push({ id: 'note:fixture-duplicate', title: notes[0].title });

  acceptThenDrop = false;
  const retry = await postNote('note-duplicate-marker');
  assert.equal(retry.status, 409);
  assert.equal(postCount(), 1, 'a duplicate marker must never trigger another POST');
  assert.equal(operations().at(-1).stage, 'ambiguous');
});
