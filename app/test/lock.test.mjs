// WHAT: Tests for the per-topic mutation lock in lib/lock.mjs.
// WHY: The lock guards read → modify → write → render on state.json. If two of those
//      interleave, one silently overwrites the other's concept update; if a lock is ever
//      leaked, every later mutation on that topic fails forever. Both directions are
//      pinned here: mutations serialise, and the lock is always released — including
//      when the mutation throws.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { STALE_LOCK_MS, lockStatus, withTopicLock } from '../lib/lock.mjs';

const SLUG = 'lock-fixture';
let fixtureRoot;
let originalLearnRoot;

const lockFile = () => join(fixtureRoot, SLUG, 'cockpit', 'state.lock');

beforeEach(() => {
  originalLearnRoot = config.learnRoot;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lock-test-'));
  config.learnRoot = fixtureRoot;
  mkdirSync(join(fixtureRoot, SLUG, 'cockpit'), { recursive: true });
});

afterEach(() => {
  config.learnRoot = originalLearnRoot;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('concurrent mutations on one topic run one at a time', async () => {
  const events = [];
  const slow = withTopicLock(SLUG, async () => {
    events.push('a:start');
    await new Promise((r) => setTimeout(r, 20));
    events.push('a:end');
  });
  const fast = withTopicLock(SLUG, async () => {
    events.push('b:start');
    events.push('b:end');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('the lock is released after a successful mutation', async () => {
  await withTopicLock(SLUG, async () => {
    assert.equal(lockStatus(SLUG).held, true);
    assert.equal(lockStatus(SLUG).ours, true);
  });
  assert.equal(existsSync(lockFile()), false);
  assert.deepEqual(lockStatus(SLUG), { held: false });
});

test('a throwing mutation releases the lock and does not wedge the topic', async () => {
  await assert.rejects(withTopicLock(SLUG, async () => { throw new Error('render rejected it'); }), /render rejected it/);
  assert.equal(existsSync(lockFile()), false);

  // The chain must still accept work — one failure used to be enough to poison it.
  const after = await withTopicLock(SLUG, async () => 'ok');
  assert.equal(after, 'ok');
});

test('a fresh lock from another process is refused with a 409, not stolen', async () => {
  writeFileSync(lockFile(), JSON.stringify({ pid: 999999, ts: new Date().toISOString(), token: 'other' }));

  await assert.rejects(
    withTopicLock(SLUG, async () => 'should not run'),
    (err) => err.status === 409 && /another process/.test(err.message),
  );
  assert.equal(existsSync(lockFile()), true, "someone else's live lock is left alone");
});

test('a stale lock is stolen, because its holder is dead and will never release it', async () => {
  const longAgo = new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString();
  writeFileSync(lockFile(), JSON.stringify({ pid: 999999, ts: longAgo, token: 'abandoned' }));

  const result = await withTopicLock(SLUG, async () => 'ran');
  assert.equal(result, 'ran');
  assert.equal(existsSync(lockFile()), false);
});

test('lockStatus reports staleness without taking the lock', () => {
  const longAgo = new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString();
  writeFileSync(lockFile(), JSON.stringify({ pid: 999999, ts: longAgo, token: 'abandoned' }));

  const status = lockStatus(SLUG);
  assert.equal(status.held, true);
  assert.equal(status.stale, true);
  assert.equal(status.ours, false);
  assert.equal(status.pid, 999999);
});

test('an old lock owned by a live process cannot be stolen', async () => {
  const bytes = JSON.stringify({ pid: process.pid, ts: new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString(), token: 'live-owner' });
  writeFileSync(lockFile(), bytes);

  await assert.rejects(withTopicLock(SLUG, async () => 'must not run'), (err) => err.status === 409);
  assert.equal(readFileSync(lockFile(), 'utf8'), bytes, 'a live owner keeps its lock however old it is');
});

test('a partially written lock is held while it is fresh', async () => {
  // openSync(wx) and the write are two calls; another writer can see the file between them.
  const bytes = '{"pid":';
  writeFileSync(lockFile(), bytes);

  await assert.rejects(withTopicLock(SLUG, async () => 'must not run'), (err) => err.status === 409);
  assert.equal(readFileSync(lockFile(), 'utf8'), bytes);
});

test('an ownerless lock file left for longer than STALE_LOCK_MS is reclaimed', async () => {
  // Create-then-write takes microseconds, so an unreadable file this old was abandoned
  // by a crash between the two, not caught mid-write. Holding it forever would leave the
  // topic unmutable until someone deleted the file by hand.
  writeFileSync(lockFile(), '{"pid":');
  const longAgo = new Date(Date.now() - STALE_LOCK_MS - 1000);
  utimesSync(lockFile(), longAgo, longAgo);

  assert.equal(await withTopicLock(SLUG, async () => 'ran'), 'ran');
  assert.equal(existsSync(lockFile()), false);
});
