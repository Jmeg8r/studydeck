// WHAT: POST /api/recovery/settle: finish an owed result once, and refuse everything else.
// WHY:  Settling applies mastery to state.json, and a doubly-applied confidence bump is
//       indistinguishable from real progress. This drives the real route, real
//       applyMastery and real render against a copy of a committed topic, and checks the
//       files byte for byte: once on the first call, never again on a replay, and never for
//       an attempt that is not owed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-recovery-settle-'));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { REPO_ROOT } = await import('../lib/config.mjs');
const { handleRequest } = await import('../router.mjs');

const TOPIC = 'ai-agent-design-patterns';
cpSync(join(REPO_ROOT, '.learn', 'topics', TOPIC), join(FIXTURE_ROOT, TOPIC), { recursive: true });
const STATE = join(FIXTURE_ROOT, TOPIC, 'state.json');
const ATTEMPTS = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'attempts.jsonl');
const CARDS = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'cards.json');
const state = () => JSON.parse(readFileSync(STATE, 'utf8'));
const CONCEPT = state().domains[0].concepts[0].slug;
const confidence = () => state().domains.flatMap((d) => d.concepts).find((c) => c.slug === CONCEPT).confidence;
const bytes = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const record = (attempt) => appendFileSync(ATTEMPTS, `${JSON.stringify({ ts: '2026-11-10T10:00:00Z', concept_slug: CONCEPT, ...attempt })}\n`);
record({ attempt_id: 'r-owed', mutation_id: 'm-owed', revision: 1, kind: 'quiz', status: 'final', deck_file: 'deck.json', score: 2, max: 2, misses: [], mastery_applied: false });
record({ attempt_id: 'r-pending', mutation_id: 'm-pending', revision: 0, kind: 'quiz', status: 'pending_self_grade', score: 1, max: 2, mastery_applied: false });
record({ attempt_id: 'r-ambiguous', mutation_id: 'm-ambiguous', revision: 2, kind: 'quiz', status: 'final', score: 1, max: 2, mastery_applied: false, mastery_settlement: { stage: 'ambiguous' } });
record({
  attempt_id: 'r-factcheck', mutation_id: 'm-factcheck', revision: 1, kind: 'factcheck', status: 'final',
  factcheck_proposal: { source_id: 'source:recovery-fixture', section: 's1' },
  factcheck_adjudication: { results: [{ id: 'k1', adjudication: 'accepted', correct: false, truth: true, text: 'A fixture claim', answered: true, marked: false }] },
});

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;
after(() => {
  app.close();
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const settle = async (attemptId) => {
  const res = await fetch(`${base}/api/recovery/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic_slug: TOPIC, attempt_id: attemptId }),
  });
  return { status: res.status, body: await res.json() };
};

test('owed mastery is applied once, and the attempt stops being owed', async () => {
  const before = confidence();
  const { status, body } = await settle('r-owed');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.outcome, 'applied');
  assert.ok(confidence() > before, `confidence did not move: ${before} → ${confidence()}`);
  assert.equal(body.item.attempt_id, 'r-owed');
});

test('a replay answers already_done and changes no byte of state or history', async () => {
  const stateBefore = bytes(STATE);
  const attemptsBefore = bytes(ATTEMPTS);
  const { status, body } = await settle('r-owed');
  assert.equal(status, 200);
  assert.equal(body.outcome, 'already_done');
  assert.equal(bytes(STATE), stateBefore, 'a replay rewrote state.json');
  assert.equal(bytes(ATTEMPTS), attemptsBefore, 'a replay appended to attempts.jsonl');
});

test('owed fact-check cards are created once', async () => {
  const first = await settle('r-factcheck');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.outcome, 'applied');
  const cards = JSON.parse(bytes(CARDS)).filter((c) => c.source_ref?.startsWith('factcheck:source:recovery-fixture'));
  assert.equal(cards.length, 1);

  const cardsBefore = bytes(CARDS);
  const replay = await settle('r-factcheck');
  assert.equal(replay.body.outcome, 'already_done');
  assert.equal(bytes(CARDS), cardsBefore, 'a replay changed the cards');
});

for (const [label, attemptId] of [['an unfinished attempt', 'r-pending'], ['ambiguous mastery', 'r-ambiguous']]) {
  test(`${label} is refused with 409 and nothing is written`, async () => {
    const stateBefore = bytes(STATE);
    const attemptsBefore = bytes(ATTEMPTS);
    const { status, body } = await settle(attemptId);
    assert.equal(status, 409, JSON.stringify(body));
    assert.ok(body.error, 'the refusal says why');
    assert.equal(bytes(STATE), stateBefore);
    assert.equal(bytes(ATTEMPTS), attemptsBefore);
  });
}

test('an unknown attempt is 404, and a malformed id is refused before any lookup', async () => {
  assert.equal((await settle('no-such-attempt')).status, 404);
  assert.equal((await settle('../../etc/passwd')).status, 400);
});
