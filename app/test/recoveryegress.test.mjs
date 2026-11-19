// WHAT: What POST /api/recovery/reconcile SENDS to Open Notebook, and what it appends.
// WHY:  Open Notebook has no idempotency key, so a retried create or delete can make a
//       second note or episode. Reconcile therefore only ever reads, and completes an
//       operation only on exactly one match. This recorder asserts this app's outbound
//       requests and its operation ledger, never Open Notebook's response contract. The
//       stub has to serve something note- and episode-shaped to reach the code under test:
//       if those lists drift upstream, these keep passing and the real route breaks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-recovery-egress-'));
const sent = [];

const RENDITION = 'Chapter 1 · sd-0123abcd-r-0123456789abcdef';
const notes = [
  { id: 'note:one', title: 'Highlight [StudyDeck 111111111111]' },
  { id: 'note:dup-a', title: 'Highlight [StudyDeck 222222222222]' },
  { id: 'note:dup-b', title: 'Highlight [StudyDeck 222222222222]' },
  { id: 'note:mindmap', title: 'Mind map diff — 2026-11-10 [StudyDeck 444444444444]' },
];
const episodes = [
  { id: 'podcast_episode:rendered', name: RENDITION, job_status: 'completed' },
  { id: 'podcast_episode:legacy', name: 'Chapter 2', job_status: 'completed' },
  { id: 'podcast_episode:present', name: 'Still here', job_status: 'completed' },
];

const onStub = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  sent.push(`${req.method} ${url.pathname}`);
  res.writeHead(req.method === 'GET' ? 200 : 405, { 'content-type': 'application/json' });
  if (req.method !== 'GET') return res.end('{"detail":"the recorder refuses every write"}');
  if (url.pathname === '/api/notes') return res.end(JSON.stringify(notes));
  if (url.pathname === '/api/podcasts/episodes') return res.end(JSON.stringify(episodes));
  res.end('[]');
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'recovery-egress-password-never-real';

const { config } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');
assert.equal(config.openNotebook.baseUrl, process.env.STUDYDECK_ON_BASE_URL, 'not talking to the recorder');

const TOPIC = config.topics.find((topic) => topic.notebookId).slug;
const OPERATIONS = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'operations.jsonl');
mkdirSync(join(FIXTURE_ROOT, TOPIC, 'cockpit'), { recursive: true });

const op = (id, kind, stage, local_result) => ({
  operation_id: id, origin_mutation_id: `m-${id}`, mutation_id: `m-${id}:seed`, revision: 1,
  ts: '2026-11-10T10:00:00Z', kind, topic_slug: TOPIC, stage, local_result,
});
const note = (marker) => ({ notebook_id: 'notebook:fixture', note_title: `Highlight [StudyDeck ${marker}]` });
writeFileSync(OPERATIONS, `${[
  op('op-note', 'open_notebook_note', 'prepared', note('111111111111')),
  op('op-note-dup', 'open_notebook_note', 'ambiguous', note('222222222222')),
  op('op-note-missing', 'open_notebook_note', 'prepared', note('333333333333')),
  op('op-mindmap', 'mindmap_note', 'ambiguous', { mindmap_ts: '2026-11-10T09:00:00Z', note_title: notes[3].title }),
  op('op-episode', 'podcast_episode', 'prepared', { source_id: 'source:a', episode_name: RENDITION }),
  op('op-episode-legacy', 'podcast_episode', 'ambiguous', { source_id: 'source:b', episode_name: 'Chapter 2' }),
  op('op-delete-gone', 'podcast_delete', 'ambiguous', { source_id: 'episode:podcast_episode:gone', episode_id: 'podcast_episode:gone' }),
  op('op-delete-present', 'podcast_delete', 'ambiguous', { source_id: 'episode:podcast_episode:present', episode_id: 'podcast_episode:present' }),
  op('op-debrief', 'debrief', 'ambiguous', { debrief_id: 'd1', card_ids: [] }),
].map((row) => JSON.stringify(row)).join('\n')}\n`);

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;
after(() => {
  app.close();
  onStub.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const ledger = () => readFileSync(OPERATIONS, 'utf8');
const latest = (id) => ledger().trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.operation_id === id).at(-1);
const reconcile = async (operationId) => {
  const res = await fetch(`${base}/api/recovery/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, operation_id: operationId }),
  });
  return { status: res.status, body: await res.json() };
};
const writesSent = () => sent.filter((request) => !request.startsWith('GET '));

test('exactly one matching note completes the operation, and only GETs are sent', async () => {
  sent.length = 0;
  const { status, body } = await reconcile('op-note');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.outcome, 'confirmed');
  assert.equal(latest('op-note').stage, 'complete');
  assert.deepEqual(latest('op-note').external, { note_id: 'note:one' });
  assert.ok(sent.length > 0, 'control: the route reached Open Notebook');
  assert.deepEqual(writesSent(), []);
});

test('a confirmed operation replays as already_done and appends nothing', async () => {
  const before = ledger();
  const { status, body } = await reconcile('op-note');
  assert.equal(status, 200);
  assert.equal(body.outcome, 'already_done');
  assert.equal(ledger(), before);
});

for (const [label, id] of [
  ['two notes carrying one marker', 'op-note-dup'],
  ['no note carrying the marker', 'op-note-missing'],
  ['an untagged legacy episode name', 'op-episode-legacy'],
  ['a deleted episode that is still listed', 'op-delete-present'],
]) {
  test(`${label}: still_unknown, nothing appended, nothing written`, async () => {
    sent.length = 0;
    const before = ledger();
    const { status, body } = await reconcile(id);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.outcome, 'still_unknown');
    assert.equal(ledger(), before, `${id} was appended to`);
    assert.ok(sent.length > 0, 'control: the route looked in Open Notebook');
    assert.deepEqual(writesSent(), []);
  });
}

for (const [label, id, external] of [
  ['a mind-map note', 'op-mindmap', { note_id: 'note:mindmap' }],
  ['a rendition', 'op-episode', { episode_id: 'podcast_episode:rendered', status: 'completed' }],
]) {
  test(`${label} with exactly one match is confirmed`, async () => {
    sent.length = 0;
    const { body } = await reconcile(id);
    assert.equal(body.outcome, 'confirmed', JSON.stringify(body));
    assert.equal(latest(id).stage, 'complete');
    assert.deepEqual(latest(id).external, external);
    assert.deepEqual(writesSent(), []);
  });
}

test('a delete is confirmed when the episode is gone from a successful list', async () => {
  sent.length = 0;
  const { body } = await reconcile('op-delete-gone');
  assert.equal(body.outcome, 'confirmed', JSON.stringify(body));
  assert.equal(latest('op-delete-gone').stage, 'complete');
  assert.deepEqual(writesSent(), []);
});

test('a revision appended by reconcile carries a derived, replay-safe mutation id', () => {
  assert.equal(latest('op-note').revision, 2);
  assert.equal(latest('op-note').mutation_id, 'm-op-note:note:2:complete');
});

test('a kind Recovery cannot check is refused with 409, and nothing is sent', async () => {
  sent.length = 0;
  const before = ledger();
  const { status, body } = await reconcile('op-debrief');
  assert.equal(status, 409);
  assert.ok(body.error);
  assert.deepEqual(sent, []);
  assert.equal(ledger(), before);
});

test('an unknown operation is 404, and a malformed id is refused', async () => {
  assert.equal((await reconcile('op-nope')).status, 404);
  assert.equal((await reconcile('op note; rm')).status, 400);
});

test('no response carries the Open Notebook password', async () => {
  const { body } = await reconcile('op-note-missing');
  assert.ok(!JSON.stringify(body).includes(process.env.STUDYDECK_ON_PASSWORD));
});
