// WHAT: The mastery mutation — that it keeps the server answering while the render runs,
//       and that making it asynchronous did not cost the rollback it is built around.
// WHY:  Assessment finding F13. `execFileSync` held the single event loop for the child's
//       entire runtime, so during a render nothing was served: not a static asset, not
//       /api/health, which is the endpoint you reach for while the cockpit looks hung.
//
// The probe below is a 5ms interval, and the assertion is that it TICKED. A timer cannot
// fire while synchronous work holds the loop, so tick count is a direct measurement of the
// block rather than a proxy for it — the synchronous version scores exactly zero, which is
// what makes this a regression test and not a description.
//
// Timings measured while writing this (library level, 5ms probe, real render):
//   renderTopic sync           40ms wall,   0 ticks
//   applyAttemptToState sync   57ms wall,   0 ticks
//   a render rigged to take 2s 2044ms wall, 0 ticks   <- the stall tracked the child 1:1
//   the same, async            2038ms wall, 363 ticks, max gap 6.0ms
// The everyday saving is ~40ms nobody can feel. What this removes is the tail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-mastery-'));

// Must be set before config.mjs is loaded — it resolves the learn root once, at import
// time, into a const. A static import would be hoisted above this line and snapshot the
// REAL .learn/ tree, so every mutation below would land on personal study data.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { config } = await import('../lib/config.mjs');
const { applyAttemptToState, performanceBand, renderTopic } = await import('../lib/mastery.mjs');

const TOPIC = config.topics[0].slug;
const CONCEPT = 'mastery-fixture-concept';

/** The real renderer, for a fixture that wants to be slow AND still produce a valid map. */
const REAL_RENDER = fileURLToPath(
  new URL('../../.claude/skills/learn-anything-quiz/scripts/render.mjs', import.meta.url),
);

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

/** A state.json the real render.mjs accepts. `extraConcept` lets a test make it invalid. */
function seedTopic(extraConcept = null) {
  const dir = join(FIXTURE_ROOT, TOPIC);
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  const state = {
    version: 1,
    slug: TOPIC,
    topic: 'Mastery Fixture',
    created: '2026-07-28',
    last_updated: null,
    domains: [
      {
        slug: 'fixture-domain',
        name: 'Fixture Domain',
        concepts: [
          {
            name: 'Fixture Concept',
            slug: CONCEPT,
            status: 'unexplored',
            confidence: 0.1,
            practice_count: 0,
            explain_count: 0,
            last_explained: null,
            last_practiced: null,
            details: ['a detail'],
          },
          ...(extraConcept ? [extraConcept] : []),
        ],
      },
    ],
  };
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return join(dir, 'state.json');
}

/** Write a stand-in render script and return its path. */
function fixtureScript(name, body) {
  const path = join(FIXTURE_ROOT, name);
  writeFileSync(path, body);
  return path;
}

/**
 * Run `fn` while a 5ms interval ticks, and report how many ticks landed.
 * Zero ticks means the event loop was held for the whole call.
 */
async function ticksDuring(fn) {
  const ticks = [];
  const timer = setInterval(() => ticks.push(Date.now()), 5);
  try {
    return { result: await fn(), ticks: ticks.length };
  } finally {
    clearInterval(timer);
  }
}

test('renderTopic keeps serving the rest of the app while the child runs', async () => {
  // Busy-waits rather than sleeping: a child that only sleeps would leave the parent free
  // even under execFileSync's own internals on some platforms, and the claim being pinned
  // is about the PARENT's loop during a genuinely busy child.
  const slow = fixtureScript(
    'slow-render.mjs',
    'const end = Date.now() + 250; while (Date.now() < end) {}\nconsole.log("rendered");\n',
  );

  seedTopic();
  const { result, ticks } = await ticksDuring(() => renderTopic(TOPIC, { script: slow }));

  assert.equal(result.ok, true);
  assert.equal(result.output, 'rendered');
  // execFileSync scored exactly 0 here. Asserting >5 rather than >40 leaves room for a
  // loaded CI runner without weakening the thing being claimed.
  assert.ok(ticks > 5, `event loop was blocked during the render (only ${ticks} ticks in 250ms)`);
});

test('a render that fails is reported, never thrown', async () => {
  const failing = fixtureScript(
    'failing-render.mjs',
    'console.error("state.json failed validation: concept 2 has no name");\nprocess.exit(1);\n',
  );

  seedTopic();
  const render = await renderTopic(TOPIC, { script: failing });

  assert.equal(render.ok, false);
  // The child's own diagnosis has to survive: it is the only thing that says WHICH file is
  // wrong, and it ends up in the 500 body and the server log.
  assert.match(render.output, /concept 2 has no name/);
});

test('a wedged render is killed at the ceiling instead of hanging forever', async () => {
  const wedged = fixtureScript('wedged-render.mjs', 'setTimeout(() => {}, 60_000);\n');

  seedTopic();
  const started = Date.now();
  const render = await renderTopic(TOPIC, { script: wedged, timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(render.ok, false);
  // The real ceiling is 30s; what matters is that it IS one — the child is killed and the
  // mutation reports a failure, rather than the request waiting on a process that is never
  // going to exit.
  assert.ok(elapsed < 5_000, `render was not killed by its timeout (took ${elapsed}ms)`);
});

test('a missing render script is reported without spawning anything', async () => {
  seedTopic();
  const render = await renderTopic(TOPIC, { script: null });

  assert.equal(render.ok, false);
  assert.match(render.output, /render\.mjs not found/);
});

test('applyAttemptToState applies the update table and re-renders', async () => {
  const statePath = seedTopic();
  const before = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(before.domains[0].concepts[0].confidence, 0.1);

  const result = await applyAttemptToState(TOPIC, CONCEPT, { score: 10, max: 10 });

  assert.equal(result.band, 'strong');
  assert.equal(performanceBand(10, 10), 'strong');

  const after = JSON.parse(readFileSync(statePath, 'utf8')).domains[0].concepts[0];
  assert.equal(after.confidence, 0.22); // 0.1 + the table's 0.12 for a strong band
  assert.equal(after.practice_count, 1);
  assert.equal(after.status, 'in_progress');

  // The map is published from the staging directory, not re-rendered in place, so its
  // arrival in the live tree is part of the contract rather than a side effect.
  const map = readFileSync(join(FIXTURE_ROOT, TOPIC, 'knowledge-map.md'), 'utf8');
  assert.match(map, /Fixture Concept/);
});

test('the live state.json is untouched until the render has accepted it', async () => {
  // The window CodeRabbit found on #33: once the render is awaited, requests are served
  // during it, and /api/state reads state.json without the topic lock. Publishing before
  // the render made a confidence bump briefly observable — and takeable back. Staging is
  // what closes that, and this is the assertion that says so.
  const statePath = seedTopic();
  const before = readFileSync(statePath, 'utf8');

  const slow = fixtureScript(
    'slow-real-render.mjs',
    // Busy-wait, then do the REAL render against whatever directory it is handed, so the
    // mutation still succeeds and this pins the ORDER rather than a failure path.
    // Spawned, not imported: render.mjs runs its CLI only when it is the entry module, so
    // an `import` of it is a silent no-op that renders nothing.
    "import { execFileSync } from 'node:child_process';\n" +
      'const end = Date.now() + 400; while (Date.now() < end) {}\n' +
      `execFileSync(process.execPath, [${JSON.stringify(REAL_RENDER)}, process.argv[2]], { stdio: 'inherit' });\n`,
  );

  const mutation = applyAttemptToState(TOPIC, CONCEPT, { score: 10, max: 10 }, { script: slow });

  // Mid-render: the reader still sees the old numbers, byte for byte.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(readFileSync(statePath, 'utf8'), before, 'state.json was published before the render finished');

  await mutation;
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).domains[0].concepts[0].confidence, 0.22);
});

test('a rejected render leaves state.json at the exact bytes it started with', async () => {
  // Invalid on a DIFFERENT concept than the one being updated: applyBand overwrites the
  // status of its own concept, so making that one invalid would be repaired by the very
  // mutation under test and the render would pass.
  const statePath = seedTopic({
    name: 'Broken Concept',
    slug: 'broken-concept',
    status: 'not_a_real_status',
    confidence: 0.1,
    practice_count: 0,
    explain_count: 0,
    last_explained: null,
    last_practiced: null,
    details: [],
  });
  const original = readFileSync(statePath, 'utf8');

  await assert.rejects(
    () => applyAttemptToState(TOPIC, CONCEPT, { score: 10, max: 10 }),
    /render\.mjs rejected the state update/,
  );

  // Byte-for-byte, not a parsed comparison: a re-serialised match would hide a formatting
  // change that makes the next diff unreadable. Since the mutation is staged, this now
  // asserts the live file was never WRITTEN — not that a rollback undid it.
  assert.equal(readFileSync(statePath, 'utf8'), original);
});

test('a failed mutation does not wedge the topic for the next one', async () => {
  // withTopicLock chains promises per slug, so a rejection that escaped the chain would
  // leave every later mutation of this topic waiting on a promise that never settles.
  const statePath = seedTopic();
  await assert.rejects(() => applyAttemptToState(TOPIC, 'no-such-concept', { score: 1, max: 1 }));

  const result = await applyAttemptToState(TOPIC, CONCEPT, { score: 0, max: 10 });
  assert.equal(result.band, 'weak');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).domains[0].concepts[0].status, 'needs_practice');
});
