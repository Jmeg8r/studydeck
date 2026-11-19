// WHAT: What `POST /api/debrief` DOES on its create path — the one route in this repo
//       whose happy case had never executed under test.
// WHY:  Tracked as a follow-up since PR #21. The route's replay branch was driven live
//       (11ms, no ON or model call) and `buildDebriefCards` is unit-tested in
//       debrief.test.mjs, but the path that actually creates something — push a note to
//       Open Notebook, draft cards on the local model, write them, append the ledger —
//       had only ever run in James's hands. It writes a note indistinguishable from real
//       study data, so nobody wanted to run it twice to check.
//
// HOW THIS DOES NOT BREAK THE "no ON stubs" RULE. Same distinction `batchegress.test.mjs`
// turns on, and it is the whole reason this file can exist: the convention (AGENTS.md,
// "Being DOWN is our behaviour; being UP is theirs") forbids asserting the SHAPE OF A
// RESPONSE from a service this repo does not control. Nothing here asserts what Open
// Notebook or ollama returned. Both stubs below are RECORDERS: every assertion is over the
// requests THIS APP SENT and the files THIS APP WROTE, both of which are ours in exactly
// the way being unreachable is ours in degradation.test.mjs.
//
// The stubs do have to SERVE something — a note id, a chat completion carrying JSON — or
// the route never reaches the code under test. That is the minimum each client function
// needs to get past its own mapping, and no assertion rests on any of it. If ON changes
// the shape of a created note tomorrow, this file keeps passing and the real route breaks;
// that gap belongs to the manual list and is stated here so a green run does not read as
// more than it is.
//
// The dangerous case is CONCURRENCY, not a malformed body. `runDebrief` is two awaits long
// — a note push and a ~15s card draft. The operation ledger now becomes durable before the
// first external write; `shareInFlight` still collapses same-process overlap while that
// durable state protects a restart. The test that would fail without either is "two
// concurrent identical submissions send exactly one POST /api/notes".
//
// Every "sent nothing" assertion here carries a control that must send the thing, for the
// reason #40 established the hard way — silence also passes for a request that 400'd
// before it reached the mutating code, which is precisely what happened on that PR's first
// run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-debrief-egress-'));
const FAKE_PASSWORD = 'debrief-egress-password-never-real';

/** Every request this app sent to either service, in order: `METHOD /path`. */
const sent = [];
/** The bodies this app sent, parallel to `sent`, so we can assert what we transmitted. */
const bodies = [];

const NOTE_ID = 'note:debrief-egress';

/** Flipped by the partial-failure test; reset by the helper that sets it. */
let notesFail = false;
/** Flipped when the local card-drafting model fails after a note already exists. */
let cardsFail = false;
/** Flipped when the local model answers with cards that have no usable front or back. */
let cardsBlank = false;
/** Durable operation stage observed by ON when a note POST arrives. */
const noteOperationStages = [];

const readBody = (req) =>
  new Promise((resolve) => {
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
  });

/** A recorder wearing Open Notebook's URLs. */
const onStub = createServer(async (req, res) => {
  // Decoded, because ON ids carry a colon and the client percent-encodes them into the path.
  const pathname = decodeURIComponent(new URL(req.url, 'http://stub').pathname);
  sent.push(`${req.method} ${pathname}`);
  bodies.push(await readBody(req));

  if (req.method === 'POST' && pathname === '/api/notes') {
    noteOperationStages.push(operations().at(-1)?.stage ?? null);
    if (notesFail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"detail":"stub was told to fail this note"}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: NOTE_ID, title: 'ignored by every assertion here' }));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"detail":"stub has no route for this"}');
});

/**
 * A recorder wearing ollama's URLs.
 *
 * The completion it serves is deliberately FENCE-WRAPPED with leading commentary, because
 * that is what the local model actually does (AGENTS.md, "External services") and
 * `extractJson` exists to survive it. A stub returning clean JSON would quietly stop
 * exercising the parser the route depends on.
 */
const ollamaStub = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://stub').pathname;
  sent.push(`${req.method} ${pathname}`);
  bodies.push(await readBody(req));

  if (req.method === 'POST' && pathname === '/api/chat') {
    if (cardsFail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"stub was told to fail card drafting"}');
    }
    const cards = cardsBlank
      ? { cards: [{ front: '  ', back: 'An answer with no question.' }, { front: 'A question with no answer?', back: '' }] }
      : {
        cards: [
          { front: 'What is a validation set for?', back: 'Measuring generalisation, not fitting.' },
          { front: 'What does fine_tune freeze?', back: 'The body, for one epoch, then unfreezes it.' },
        ],
      };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        message: { content: `Here you go:\n\`\`\`json\n${JSON.stringify(cards)}\n\`\`\`` },
      }),
    );
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"stub has no route for this"}');
});

await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => ollamaStub.listen(0, '127.0.0.1', resolve));

// All four must be set before config.mjs is imported — it resolves everything once, at
// import time, into consts. A static import would be hoisted above these lines and
// snapshot the REAL tree and the REAL services, so this file would push notes into the
// study notebook.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = FAKE_PASSWORD;
process.env.STUDYDECK_OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaStub.address().port}`;

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');

// Both clients must be pointed at the recorders, asserted rather than assumed. This is not
// belt-and-braces: it was checked, and without it the file is not hermetic. Disabling the
// ollama seam makes two tests below fail — but the partial-failure test PASSES, in 19.9s
// instead of 26ms, because it reached the real model on this machine and got usable cards
// back. A test that silently talks to a live service is the exact false green this whole
// file exists to stop, and on a laptop with ollama running nothing else here catches it.
assert.equal(config.ollama.baseUrl, process.env.STUDYDECK_OLLAMA_BASE_URL, 'not talking to the ollama recorder');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the ON recorder');

/** A topic with a notebook mapped — an unmapped one takes the `note_error` branch instead. */
const TOPIC = config.topics.find((t) => t.notebookId).slug;

// Every configured topic gets a cockpit directory: the sidecar writers create files, not
// the directories above them.
for (const topic of config.topics) {
  mkdirSync(join(FIXTURE_ROOT, topic.slug, 'cockpit'), { recursive: true });
  writeFileSync(
    join(FIXTURE_ROOT, topic.slug, 'state.json'),
    `${JSON.stringify({ version: 1, topic: `Fixture ${topic.slug}`, slug: topic.slug, created: '2026-07-30', domains: [] }, null, 2)}\n`,
  );
}

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  ollamaStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const TEXT = 'I was fuzzy on what a validation set is for, and I got fine_tune backwards.';

/**
 * One debrief submission, with the no-CORS check folded in.
 *
 * Why here as well as in `guard.test.mjs`: the headers are set once at the top of
 * `handleRequest`, but nothing stops a ROUTE adding its own later, and the absence of a
 * CSRF token rests entirely on no response ever allowing an origin (AGENTS.md rule 12).
 */
const debrief = async (body) => {
  const res = await fetch(`${base}/api/debrief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, text: TEXT, ...body }),
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
  return res;
};

const notesSent = () => sent.filter((r) => r === 'POST /api/notes');
const chatsSent = () => sent.filter((r) => r === 'POST /api/chat');

const ledger = () =>
  readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'debriefs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const operations = () => {
  const path = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'operations.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
};

const cardsOnDisk = () =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, TOPIC, 'cockpit', 'cards.json'), 'utf8'));

test('the create path pushes one note, drafts cards, and records what it did', async () => {
  sent.length = 0;
  bodies.length = 0;
  noteOperationStages.length = 0;

  const res = await debrief({ mutation_id: 'm-create' });
  const body = await res.json();

  // 201, not 200: this created something. The replay branch is the one that answers 200.
  assert.equal(res.status, 201);
  assert.equal(notesSent().length, 1, `expected exactly one note push, got: ${sent.join(', ')}`);
  assert.equal(chatsSent().length, 1, `expected exactly one card draft, got: ${sent.join(', ')}`);

  // What we SENT to Open Notebook — ours to assert. The title convention is the spec's
  // (Appendix A), and the content must be the debrief verbatim, not a summary of it.
  const notePush = bodies[sent.indexOf('POST /api/notes')];
  assert.match(notePush.title, /^Walk debrief \d{4}-\d{2}-\d{2} · [a-f0-9]{8}$/,
    'the deterministic marker is the reconciliation identity for a lost response');
  assert.equal(notePush.content, TEXT);
  assert.equal(notePush.notebook_id, config.topics.find((t) => t.slug === TOPIC).notebookId);

  // What we SENT to the model: the debrief text must reach it, or the cards are invented.
  const draft = bodies[sent.indexOf('POST /api/chat')];
  assert.ok(
    draft.messages.some((m) => m.role === 'user' && m.content === TEXT),
    'the debrief text never reached the model',
  );

  // What we WROTE. Two drafts in, two cards out, and they are on disk rather than only in
  // the response — a card the UI shows but never persisted is the failure F4 produced.
  assert.equal(body.created_cards.length, 2);
  assert.equal(body.note.id, NOTE_ID);
  assert.equal(body.note_error, null);
  assert.equal(cardsOnDisk().length, 2);
  assert.deepEqual(noteOperationStages, ['prepared'], 'the operation must be durable before the external write');
  const operation = operations().filter((entry) => entry.origin_mutation_id === 'm-create');
  assert.deepEqual(operation.map((entry) => entry.stage),
    ['started', 'prepared', 'external_created', 'local_written', 'complete']);
  assert.equal(operation.at(-1).external.note_id, NOTE_ID);

  const rows = ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mutation_id, 'm-create');
  assert.equal(rows[0].note_id, NOTE_ID);
  assert.deepEqual(
    rows[0].card_ids.slice().sort(),
    cardsOnDisk().map((c) => c.id).sort(),
  );
});

test('a replay of that mutation_id sends nothing and creates nothing', async () => {
  // The control is the test above: it proves this fixture reaches the mutating code, so
  // the silence below means the ledger stopped it rather than a 400 doing so.
  const before = cardsOnDisk().length;
  sent.length = 0;

  const res = await debrief({ mutation_id: 'm-create' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.replayed, true);
  assert.deepEqual(sent, [], `a replay sent: ${sent.join(', ')}`);
  assert.equal(cardsOnDisk().length, before, 'a replay created another card');
  assert.equal(ledger().length, 1, 'a replay appended a second ledger row');

  // A replay reports the first run's outcome, not an empty one — the UI shows these.
  assert.equal(body.note.id, NOTE_ID);
  assert.equal(body.created_cards.length, 2);
});

test('two concurrent submissions of the same mutation send exactly ONE note', async () => {
  // The window this file exists for. The ledger is written LAST, so for ~15s a second
  // request finds no record of the first. Without shareInFlight both run: two notes in the
  // notebook, two card sets, two ledger rows. Nothing proved that until now.
  sent.length = 0;
  const before = cardsOnDisk().length;

  const [a, b] = await Promise.all([
    debrief({ mutation_id: 'm-concurrent' }),
    debrief({ mutation_id: 'm-concurrent' }),
  ]);

  assert.equal(
    notesSent().length,
    1,
    `concurrent submissions pushed ${notesSent().length} notes: ${sent.join(', ')}`,
  );
  assert.equal(chatsSent().length, 1, `concurrent submissions drafted cards twice: ${sent.join(', ')}`);

  // Both callers still get an answer — collapsing the run must not drop a response.
  assert.ok([200, 201].includes(a.status));
  assert.ok([200, 201].includes(b.status));
  const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
  assert.equal(bodyA.debrief_id, bodyB.debrief_id, 'the two callers saw different runs');

  // Exactly one run's worth of durable effect, and exactly one of them was told it created it.
  assert.equal(cardsOnDisk().length, before + 2);
  assert.equal(ledger().filter((r) => r.mutation_id === 'm-concurrent').length, 1);
  assert.equal([a.status, b.status].filter((s) => s === 201).length, 1);
});

test('an ambiguous note outcome is durable and the replay does not retry it', async () => {
  // The route pushes the note first and drafts cards second, so ON failing must not cost
  // the cards. The ledger records what actually happened; a replay reports THAT, rather
  // than re-running the half that failed and pushing a note the first attempt did not.
  notesFail = true;
  sent.length = 0;
  const before = cardsOnDisk().length;

  const res = await debrief({ mutation_id: 'm-partial' });
  const body = await res.json();
  // Restore shared recorder state before assertions: a failing assertion must not make a
  // later transaction look like an ambiguous note outcome for the wrong reason.
  notesFail = false;

  assert.equal(res.status, 503);
  assert.equal(notesSent().length, 1, 'the failing note was not attempted');
  assert.equal(body.note, null);
  assert.ok(body.note_error, 'a failed note push reported no error');
  assert.equal(body.created_cards.length, 2, 'a failed note cost the cards');
  assert.equal(cardsOnDisk().length, before + 2);

  assert.equal(operations().at(-1).stage, 'ambiguous');

  // Now the replay, with the stub healthy again: it must still report the failure rather
  // than quietly succeeding, or a retry silently changes history.
  sent.length = 0;

  const replay = await debrief({ mutation_id: 'm-partial' });
  const replayBody = await replay.json();

  assert.equal(replay.status, 409);
  assert.equal(replayBody.replayed, true);
  assert.deepEqual(sent, [], `a replay of a partial run retried: ${sent.join(', ')}`);
  assert.equal(replayBody.note, null);
  assert.ok(replayBody.note_error);
  assert.equal(cardsOnDisk().length, before + 2);
});

test('a known card-drafting failure resumes cards without a second note', async () => {
  cardsFail = true;
  sent.length = 0;
  const before = cardsOnDisk().length;

  const first = await debrief({ mutation_id: 'm-cards-retry' });
  const firstBody = await first.json();
  cardsFail = false;

  assert.equal(first.status, 503);
  assert.equal(firstBody.note.id, NOTE_ID);
  assert.equal(notesSent().length, 1);
  assert.equal(chatsSent().length, 1);
  assert.equal(cardsOnDisk().length, before);
  assert.equal(operations().at(-1).stage, 'failed_known');

  sent.length = 0;
  const retry = await debrief({ mutation_id: 'm-cards-retry' });
  const retryBody = await retry.json();

  assert.equal(retry.status, 200);
  assert.equal(retryBody.note.id, NOTE_ID);
  assert.deepEqual(notesSent(), [], `a known-missing card retry created another note: ${sent.join(', ')}`);
  assert.equal(chatsSent().length, 1, 'the missing card stage did not resume');
  assert.equal(cardsOnDisk().length, before + 2);
  assert.equal(operations().at(-1).stage, 'complete');
});

test('a reply whose cards are all unusable is a card-drafting failure, not zero cards', async () => {
  // cardsFromDebrief drops unusable drafts one by one, by design. When it drops every one,
  // the model failed; recording success with no cards would read as "nothing to learn".
  cardsBlank = true;
  try {
    const before = cardsOnDisk().length;

    const res = await debrief({ mutation_id: 'm-cards-blank' });

    assert.equal(res.status, 503);
    assert.equal(cardsOnDisk().length, before);
    assert.equal(operations().at(-1).stage, 'failed_known');
  } finally {
    cardsBlank = false;
  }
});

test('a card failure after an ambiguous note keeps it ambiguous, so a retry never posts it again', async () => {
  // The note may exist in ON with its response lost. Recording the card failure as
  // failed_known drops that ambiguity, and a failed_known retry with no note id posts the
  // note again: a duplicate. Both ways cards can fail are covered: the model erroring, and
  // the model answering with no usable card.
  for (const [label, fail] of [['model-error', () => { cardsFail = true; }], ['blank-cards', () => { cardsBlank = true; }]]) {
    const mutation = `m-ambiguous-${label}`;
    notesFail = true;
    fail();
    try {
      sent.length = 0;
      const first = await debrief({ mutation_id: mutation });
      assert.equal(first.status, 503, `${label}: first answered ${first.status}`);
      assert.equal(notesSent().length, 1, `${label}: the note was not attempted`);
    } finally {
      notesFail = false;
      cardsFail = false;
      cardsBlank = false;
    }

    assert.equal(operations().at(-1).stage, 'ambiguous', `${label}: the note's ambiguity was overwritten`);

    sent.length = 0;
    const retry = await debrief({ mutation_id: mutation });
    assert.deepEqual(notesSent(), [], `${label}: a retry posted the possibly-created note again`);
    assert.equal(retry.status, 409, `${label}: retry answered ${retry.status}`);
  }
});

test('an unknown topic and an empty debrief are refused before anything is sent', async () => {
  sent.length = 0;

  const unknown = await debrief({ topic_slug: 'no-such-topic', mutation_id: 'm-unknown' });
  assert.equal(unknown.status, 400);

  const empty = await debrief({ text: '   ', mutation_id: 'm-empty' });
  assert.equal(empty.status, 400);

  const noId = await fetch(`${base}/api/debrief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, text: TEXT }),
  });
  assert.equal(noId.status, 400, 'an append with no mutation_id was accepted');

  assert.deepEqual(sent, [], `a refused debrief still sent: ${sent.join(', ')}`);
});
