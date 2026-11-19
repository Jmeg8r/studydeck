// WHAT: The exit-code contract of `npm run verify`.
// WHY: The exit code IS the interface — it is what a script or a pre-session habit acts on,
//      and it was documented before it was implemented: the header promised "2 = could not
//      check" while the code could only ever exit 0 or 1, so an unreadable directory threw,
//      node exited 1, and "I could not look" was reported as "I looked and found damage".
//      Asserting the codes is the only way that promise stays true (CodeRabbit on #31).
//
// Spawned as a real process rather than imported: the module exits on load, so importing it
// would take the test runner down with it, and an exit code cannot be observed any other way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';

const VERIFY = join(dirname(dirname(fileURLToPath(import.meta.url))), 'verify.mjs');

/** Resolves with the exit code rather than rejecting — a non-zero code is the subject here. */
function runVerify(learnRoot, { args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [VERIFY, ...args],
      { env: { ...process.env, STUDYDECK_LEARN_ROOT: learnRoot, ...env } },
      (err, stdout) => resolve({ code: err?.code ?? 0, stdout }),
    );
  });
}

/**
 * A tree with a real state.json for every CONFIGURED topic — verify walks the config, not
 * the directory, so a fixture covering only one topic would report the others as damaged
 * and the exit code would be right for the wrong reason.
 */
function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'verify-test-'));
  for (const topic of config.topics) {
    mkdirSync(join(root, topic.slug, 'quizzes', 'concept-a'), { recursive: true });
    mkdirSync(join(root, topic.slug, 'cockpit'), { recursive: true });
    writeFileSync(
      join(root, topic.slug, 'state.json'),
      JSON.stringify({
        version: 1, topic: topic.slug, slug: topic.slug, created: '2026-07-28',
        domains: [{ name: 'D', slug: 'd', concepts: [{ name: 'C', slug: 'c', status: 'unexplored', confidence: 0 }] }],
      }),
    );
    writeFileSync(
      join(root, topic.slug, 'quizzes', 'concept-a', 'deck-ok.json'),
      JSON.stringify({ concept_slug: 'c', concept_name: 'C', created: '2026-07-28', questions: [{ id: 'q1' }] }),
    );
  }
  return root;
}

test('verify exits 0 and reports nothing damaged on a clean tree', async () => {
  const root = buildTree();
  try {
    const { code, stdout } = await runVerify(root);
    // The false-positive case matters as much as the positive one: a checker that flags a
    // healthy tree gets ignored, and then it is decoration.
    assert.equal(code, 0, `expected a clean exit, got ${code}:\n${stdout}`);
    assert.match(stdout, /No damage found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify exits 1 and names the file when a deck is corrupt', async () => {
  const root = buildTree();
  try {
    writeFileSync(join(root, config.topics[0].slug, 'quizzes', 'concept-a', 'deck-bad.json'), '{"truncated":');
    const { code, stdout } = await runVerify(root);
    assert.equal(code, 1, `expected a damage exit, got ${code}:\n${stdout}`);
    assert.match(stdout, /deck-bad\.json cannot be parsed/);
    assert.match(stdout, /Nothing here has been modified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Every file under `dir`, as path -> sha256 of its bytes.
 *
 * Names alone are not enough: comparing directory entries passes a run that rewrites
 * `state.json`, a deck's contents, or a nested sidecar while leaving every filename intact —
 * which is exactly the damage "read-only" is supposed to rule out. (CodeRabbit on #31.)
 */
function snapshot(dir, base = dir, acc = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(path, base, acc);
    else acc.set(relative(base, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return acc;
}

test('verify never writes to the tree it is checking', async () => {
  // Read-only is the whole basis for running this on real study data without a copy. A
  // repair tool that runs automatically is how one bad file becomes a bad backup too.
  const root = buildTree();
  const slug = config.topics[0].slug;
  try {
    writeFileSync(join(root, slug, 'quizzes', 'concept-a', 'deck-bad.json'), '{"truncated":');
    const before = snapshot(root);

    await runVerify(root);

    const after = snapshot(root);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file added or removed');
    for (const [path, hash] of before) {
      assert.equal(after.get(path), hash, `${path} was modified by a read-only check`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify exits 2 — the check could not complete — rather than reporting damage', async () => {
  // The distinction CodeRabbit caught: a filesystem failure used to surface as exit 1,
  // making "I could not look" indistinguishable from "I looked and found damage". Pointing
  // the learn root at a path where a topic directory is a FILE makes state.json unreadable
  // with ENOTDIR — an I/O failure, not a parse failure.
  const root = mkdtempSync(join(tmpdir(), 'verify-unchecked-'));
  try {
    for (const topic of config.topics) writeFileSync(join(root, topic.slug), 'not a directory');
    const { code, stdout } = await runVerify(root);
    assert.equal(code, 2, `expected an incomplete-check exit, got ${code}:\n${stdout}`);
    assert.match(stdout, /COULD NOT CHECK/);
    assert.match(stdout, /INCOMPLETE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  --live: the reporting boundary, not just the classifier            */
/*                                                                     */
/*  oncontract.test.mjs pins what inspectSourcesPayload RETURNS. That  */
/*  is not the same as what verify.mjs DOES with it, and the gap was   */
/*  a real bug: `degraded` fell through to the success branch, printed */
/*  "id and title present on every source", and exited 0 — a false     */
/*  statement about the exact damage the probe exists to surface.      */
/*  A status-set test cannot see that; only running the reporter can.  */
/* ------------------------------------------------------------------ */

/** An ON stub serving one payload, for driving `--live` end to end. */
function onStubServing(payload) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  // Rejects on a bind failure rather than hanging. Without the error listener a sandbox
  // that refuses the bind produces a test that never settles, and a hung run reports as a
  // timeout with no cause — the least actionable failure there is.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const liveEnv = (server) => ({
  STUDYDECK_ON_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  STUDYDECK_ON_PASSWORD: 'verify-live-test-password-never-real',
});

test('--live exits 1 on a DEGRADED shape, which used to report clean', async () => {
  // The regression this test exists for. A missing title takes listSources' "(untitled)"
  // fallback, so nothing throws — chapter ordering collapses and episode names stop being
  // unique while every screen still renders. Reporting that as ok, under a line claiming
  // both fields are present, is the failure mode this whole checker exists to prevent.
  const root = buildTree();
  const server = await onStubServing([{ id: 'source:x' }]);
  try {
    const { code, stdout } = await runVerify(root, { args: ['--live'], env: liveEnv(server) });
    assert.equal(code, 1, `a degraded shape should be damage, got ${code}:\n${stdout}`);
    assert.match(stdout, /SHAPE DEGRADED/);
    assert.doesNotMatch(stdout, /id and title present on every source/, 'it claimed the fields were present');
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--live exits 1 on a DRIFTED shape', async () => {
  const root = buildTree();
  const server = await onStubServing([{ title: 'no id here' }]);
  try {
    const { code, stdout } = await runVerify(root, { args: ['--live'], env: liveEnv(server) });
    assert.equal(code, 1, `expected damage, got ${code}:\n${stdout}`);
    assert.match(stdout, /SHAPE DRIFTED/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--live exits 2 — not 0 — when the notebook is empty', async () => {
  // An empty list is both what an empty notebook returns and what drift looks like from
  // outside, so it is indeterminate. Exiting 0 here would mean "I looked and there was
  // nothing to look at" reported as a clean bill of health.
  const root = buildTree();
  const server = await onStubServing([]);
  try {
    const { code, stdout } = await runVerify(root, { args: ['--live'], env: liveEnv(server) });
    assert.equal(code, 2, `expected an incomplete run, got ${code}:\n${stdout}`);
    assert.match(stdout, /COULD NOT CHECK/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('--live exits 0 only when the shape is actually intact', async () => {
  // The false-positive guard: without this, the three tests above would also pass on a
  // reporter that called EVERYTHING damaged.
  const root = buildTree();
  const server = await onStubServing([{ id: 'source:x', title: '1. Chapter One' }]);
  try {
    const { code, stdout } = await runVerify(root, { args: ['--live'], env: liveEnv(server) });
    assert.equal(code, 0, `expected a clean exit, got ${code}:\n${stdout}`);
    assert.match(stdout, /id and title present on every source/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('without --live, nothing is probed at all', async () => {
  // The opt-in half of the contract: `npm run verify` must stay local, offline and instant,
  // so a machine with no Open Notebook still gets a usable integrity check.
  const root = buildTree();
  const server = await onStubServing([{ title: 'would be drift if probed' }]);
  try {
    const { code, stdout } = await runVerify(root, { env: liveEnv(server) });
    assert.equal(code, 0, `the offline run should ignore ON entirely, got ${code}:\n${stdout}`);
    assert.doesNotMatch(stdout, /ON sources/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
