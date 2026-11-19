// WHAT: The routes with one topic's attempts.jsonl damaged (a directory at its path).
//       docs/changes/2026-11-12-jsonl-damage.
// WHY:  The JSONL readers used existsSync, so damage either escaped as a raw I/O error that
//       took /api/health down for every topic, or read as an empty history. Pinned here at
//       the boundary the browser sees: health stays 200 and names the file, /api/state stays
//       200 with the topic marked unavailable, and an attempt answers 500 naming the file
//       without writing anything. No message may carry an absolute path (spec concern 3).
//       Open Notebook points at a socket this file owns and hangs up on, so nothing here can
//       reach a real service (degradation.test.mjs explains why an owned socket).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-jsonldamage-'));
const CONCEPT = 'jsonl-damage-concept';
const DECK_FILE = 'jsonl-damage-quiz.json';
const UNREADABLE = 'attempts.jsonl is unreadable (EISDIR)';

const deadOn = createServer();
deadOn.on('connection', (socket) => socket.destroy());
await new Promise((resolve) => deadOn.listen(0, '127.0.0.1', resolve));

// Set before config.mjs loads: it reads the environment once, at import.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${deadOn.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'jsonldamage-test-not-real';

const { handleRequest } = await import('../router.mjs');
const { config } = await import('../lib/config.mjs');
const DAMAGED = config.topics[0].slug;
const HEALTHY = config.topics.slice(1).map((topic) => topic.slug);

const DECK = {
  concept_slug: CONCEPT,
  concept_name: 'JSONL Damage Concept',
  created: '2026-11-12',
  questions: [
    { id: 'q1', type: 'short_answer', gradeable: 'exact', prompt: 'One plus one?', answer: 'two', explanation: 'Addition.' },
  ],
};

// buildState reads every configured topic, so each needs a tree.
for (const slug of [DAMAGED, ...HEALTHY]) {
  const dir = join(FIXTURE_ROOT, slug);
  mkdirSync(join(dir, 'quizzes', CONCEPT), { recursive: true });
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1, topic: `Fixture ${slug}`, slug, created: '2026-11-12', domains: [{
      name: 'Fixture Domain', slug: 'fixture-domain', concepts: [{
        name: 'JSONL Damage Concept', slug: CONCEPT, status: 'unexplored', confidence: 0,
        practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null,
        details: ['A concept that exists only so the attempts route has a deck.'],
      }],
    }],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'quizzes', CONCEPT, DECK_FILE), JSON.stringify(DECK));
}
const damagedPath = join(FIXTURE_ROOT, DAMAGED, 'cockpit', 'attempts.jsonl');
mkdirSync(damagedPath);

const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const PORT = app.address().port;

after(async () => {
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => deadOn.close(resolve));
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: { host: `127.0.0.1:${PORT}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || 'null') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('GET /api/health stays 200 and names the damaged attempts.jsonl', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'degraded');
  const topic = res.body.integrity.find((t) => t.topic_slug === DAMAGED);
  assert.ok(topic, `no integrity entry for ${DAMAGED}: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.ok(topic.degraded.includes('attempts.jsonl'), `degraded was ${JSON.stringify(topic.degraded)}`);
  const entry = topic.files.find((f) => f.file === 'attempts.jsonl');
  assert.equal(entry.code, 'EISDIR');
  assert.equal(entry.error, UNREADABLE);
});

test('GET /api/state stays 200 and marks only the damaged topic unavailable', async () => {
  const res = await call('GET', '/api/state');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.unavailable_topics, [{ slug: DAMAGED, error: UNREADABLE }]);
  for (const slug of HEALTHY) {
    assert.ok(res.body.topics.some((t) => t.slug === slug), `${slug} should still build`);
  }
});

test('POST /api/attempts answers 500 naming the file and writes nothing', async () => {
  const res = await call('POST', '/api/attempts', {
    topic_slug: DAMAGED,
    deck_file: DECK_FILE,
    mutation_id: 'jsonl-damage-attempt',
    responses: { q1: 'two' },
  });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: UNREADABLE });
  assert.deepEqual(readdirSync(damagedPath), [], 'nothing landed at the damaged path');
});
