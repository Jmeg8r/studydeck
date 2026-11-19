// WHAT: The half of `POST /api/mindmap/run` that pushes a note to Open Notebook.
// WHY:  Roadmap A4. `routes.test.mjs` covers this route, but only with `save_note: false`
//       — its own header says so, because a test that omitted the flag would have written
//       a real note into the real notebook. That left the two claims the route actually
//       makes about the note untested:
//
//         - a recognised replay "must not create a SECOND note: the first request already
//           pushed this diff, and the note is the expensive, externally-visible half"
//         - "a failure there must not lose the run, which is already on disk"
//
//       The first is the one that bit before: a retried run used to append a second run AND
//       create a second note, so one recall session appeared twice in the study record. The
//       replay guard was added; nothing proved the NOTE half of it, because with notes
//       disabled there was no note to count.
//
// SAME RULE AS batchegress/debriefegress: this asserts what THIS APP SENT, never the shape
// of what Open Notebook returned. The stub is a recorder.
//
// Every "no note was pushed" assertion carries a control that must push one — silence
// otherwise also passes for a run that 400'd before reaching the push, which is exactly the
// failure #40 caught on its first run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-mindmap-egress-'));
const FAKE_PASSWORD = 'mindmap-egress-password-never-real';
const NOTE_ID = 'note:mindmap-egress';

const sent = [];
const bodies = [];
const notes = [];
let notesFail = false;
let acceptThenDrop = false;

const onStub = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://stub').pathname);
  sent.push(`${req.method} ${pathname}`);
  bodies.push(
    await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    }),
  );

  if (req.method === 'GET' && pathname === '/api/notes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(notes));
  }

  if (req.method === 'POST' && pathname === '/api/notes') {
    if (notesFail) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end('{"detail":"stub was told to fail this note"}');
    }
    const note = { id: NOTE_ID, title: bodies.at(-1).title };
    notes.push(note);
    if (acceptThenDrop) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end('{"detail":"response deliberately lost after creation"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(note));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

// Set before config.mjs is imported — it resolves once, at import time, into consts.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = FAKE_PASSWORD;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');

assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the recorder');

/** A topic with a notebook mapped — without one the route skips the push entirely. */
const TOPIC = config.topics.find((t) => t.notebookId).slug;
const RECALLED = 'mindmap-fixture-recalled';
const MISSED = 'mindmap-fixture-missed';

// Two concepts, one recalled and one not, so the diff has real content on both sides. A
// fixture where everything is recalled would produce an empty gap list and the note body
// assertion would prove nothing.
for (const topic of config.topics) {
  mkdirSync(join(FIXTURE_ROOT, topic.slug, 'cockpit'), { recursive: true });
  writeFileSync(
    join(FIXTURE_ROOT, topic.slug, 'state.json'),
    `${JSON.stringify(
      {
        version: 1,
        topic: `Fixture ${topic.slug}`,
        slug: topic.slug,
        created: '2026-07-30',
        domains: [
          {
            name: 'Mind Map Fixture Domain',
            slug: 'mindmap-fixture-domain',
            concepts: [RECALLED, MISSED].map((slug) => ({
              name: slug === RECALLED ? 'Recalled Concept' : 'Missed Concept',
              slug,
              status: 'unexplored',
              confidence: 0,
              practice_count: 0,
              explain_count: 0,
              last_explained: null,
              last_practiced: null,
              details: ['A concept that exists only so a diff has two sides.'],
            })),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const run = async (body) => {
  const res = await fetch(`${base}/api/mindmap/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, recalled: [RECALLED], sketch: null, ...body }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  return res;
};

const notesPushed = () => sent.filter((r) => r === 'POST /api/notes');
const runsOnDisk = () =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'mindmaps.json'), 'utf8'));

test('the retrieval preflight contains no authoritative concept names', async () => {
  const res = await fetch(`${base}/api/mindmap?topic=${encodeURIComponent(TOPIC)}`);
  const raw = await res.text();

  assert.equal(res.status, 200);
  assert.ok(!raw.includes('Recalled Concept'));
  assert.ok(!raw.includes('Missed Concept'));
  assert.match(raw, /sketch_limit_bytes/);
});

test('a run pushes exactly one note carrying the diff it recorded', async () => {
  sent.length = 0;
  bodies.length = 0;

  const res = await run({ mutation_id: 'm-run' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(notesPushed().length, 1, `expected one note push, got: ${sent.join(', ')}`);
  assert.equal(body.note.id, NOTE_ID);
  assert.equal(body.note_error, null);

  // What we SENT. The note is the externally-visible artifact of the whole step, so its
  // body has to be the diff and not a placeholder: the gap it names is the study target.
  const push = bodies[sent.indexOf('POST /api/notes')];
  assert.match(push.title, /^Mind map diff — \d{4}-\d{2}-\d{2} \[StudyDeck [a-f0-9]{12}\]$/);
  assert.equal(push.notebook_id, config.topics.find((t) => t.slug === TOPIC).notebookId);
  assert.ok(push.content.includes('Recalled 1 of 2'), `note body did not carry the diff: ${push.content}`);
  assert.ok(push.content.includes('Missed Concept'), 'the gap was not named in the note');
  assert.ok(!push.content.includes('Recalled Concept'), 'a recalled concept was listed as a gap');
});

test('a replay pushes NO second note — the diff is already in the notebook', async () => {
  // The assertion routes.test.mjs could not make: with save_note disabled there was no
  // note to count, so the replay guard's externally-visible half went unproven. The
  // control is the test above, which pushed one from this same fixture.
  sent.length = 0;
  const before = runsOnDisk().length;

  const res = await run({ mutation_id: 'm-run' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.replayed, true);
  assert.deepEqual(body.note, { id: NOTE_ID }, 'a lost response replays the stored external result');
  assert.deepEqual(notesPushed(), [], `a replay pushed a note: ${sent.join(', ')}`);
  assert.equal(runsOnDisk().length, before, 'a replay appended a second run');
});

test('save_note: false records the run and sends nothing', async () => {
  sent.length = 0;
  const before = runsOnDisk().length;

  const res = await run({ mutation_id: 'm-nonote', save_note: false });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.deepEqual(sent, [], `a save_note:false run sent: ${sent.join(', ')}`);
  assert.equal(body.note, null);
  // The run itself is still recorded — the flag suppresses the push, not the work.
  assert.equal(runsOnDisk().length, before + 1);
});

test('a failed note does not lose the run', async () => {
  // "A failure there must not lose the run, which is already on disk." The recall session
  // is the expensive part — it is the learner's memory, not a retryable computation.
  notesFail = true;
  sent.length = 0;
  const before = runsOnDisk().length;

  const res = await run({ mutation_id: 'm-notefail' });
  const body = await res.json();

  assert.equal(res.status, 201, 'a failed note push failed the whole run');
  assert.equal(notesPushed().length, 1, 'the note was not attempted');
  assert.equal(body.note, null);
  assert.ok(body.note_error, 'a failed push reported no error');
  assert.equal(runsOnDisk().length, before + 1, 'the run was lost with the note');
  assert.equal(body.run.recall_rate, 0.5);

  notesFail = false;
});

test('an ambiguous note outcome is recorded and is never blindly retried', async () => {
  // A 502 could mean the remote service created a note before its response was lost.
  // Retrying would turn one learner action into two notes, so the durable prepared record
  // has to become visible for reconciliation instead of triggering another POST.
  sent.length = 0;
  const res = await run({ mutation_id: 'm-notefail' });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.replayed, true);
  assert.match(body.error, /ambiguous/i);
  assert.deepEqual(notesPushed(), [], `an ambiguous retry pushed another note: ${sent.join(', ')}`);

  const operations = readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'operations.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(operations.at(-1).stage, 'ambiguous');
  assert.equal(operations.at(-1).origin_mutation_id, 'm-notefail');
});

test('a response-lost note is reconciled by its marker instead of posted twice', async () => {
  sent.length = 0;
  notes.length = 0;
  acceptThenDrop = true;

  const first = await run({ mutation_id: 'm-reconcile-note' });
  const created = await first.json();
  assert.equal(first.status, 201, 'the durable local recall run still succeeds');
  assert.equal(created.note, null);
  assert.equal(notesPushed().length, 1, 'control: the initial request reached the note create path');

  acceptThenDrop = false;
  sent.length = 0;
  const replay = await run({ mutation_id: 'm-reconcile-note' });
  const recovered = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.note, { id: NOTE_ID });
  assert.deepEqual(notesPushed(), [], `reconciliation posted another note: ${sent.join(', ')}`);
});

test('two notes carrying the same marker leave the mind-map note ambiguous', async () => {
  // Two matches for a marker unique to one run mean a duplicate already exists in the
  // notebook; reconciling against either would hide it.
  sent.length = 0;
  notes.length = 0;
  acceptThenDrop = true;

  const first = await run({ mutation_id: 'm-duplicate-marker' });
  assert.equal(first.status, 201);
  assert.equal(notesPushed().length, 1, 'control: the initial request reached the note create path');
  notes.push({ id: `${NOTE_ID}-duplicate`, title: notes[0].title });

  acceptThenDrop = false;
  sent.length = 0;
  const replay = await run({ mutation_id: 'm-duplicate-marker' });
  const body = await replay.json();
  assert.equal(replay.status, 409);
  assert.match(body.error, /ambiguous/i);
  assert.deepEqual(notesPushed(), [], `a duplicate marker posted another note: ${sent.join(', ')}`);
  const operations = readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'operations.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(operations.filter((o) => o.origin_mutation_id === 'm-duplicate-marker').at(-1).stage, 'ambiguous');
});

test('an unknown topic is refused before anything is sent', async () => {
  sent.length = 0;

  assert.equal((await run({ mutation_id: 'm-nt', topic_slug: 'no-such-topic' })).status, 400);

  const noId = await fetch(`${base}/api/mindmap/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, recalled: [RECALLED] }),
  });
  assert.equal(noId.status, 400, 'an append with no mutation_id was accepted');

  assert.deepEqual(sent, [], `a refused run still sent: ${sent.join(', ')}`);
});
