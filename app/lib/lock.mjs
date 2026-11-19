// WHAT: A per-topic mutation lock guarding state.json + its render.
// WHY: A mastery update is read → modify → write → render, and the render can take
//      seconds. Two of those interleaving would let one overwrite the other's concept
//      update, or leave state.json and knowledge-map.md describing different things.
//
// Two layers, because they cover different failures:
//   1. an in-process promise chain per slug — the real serializer for this server, and
//      the one that keeps working once a handler awaits mid-mutation;
//   2. an advisory lock FILE — catches a second cockpit process started against the
//      same .learn/ tree, and leaves evidence when one dies mid-mutation.
//
// HONEST LIMIT: a `/learn:quiz` CLI session does not take this lock. Nothing here can
// stop a concurrent CLI write — it makes the in-app race impossible and a foreign write
// visible, which is as far as an advisory lock can go. The single-writer convention in
// CLAUDE.md is still the rule that actually protects you.
//
// RECLAIMING: age is never enough on its own, because a long render keeps its owner busy
// past any threshold. A lock is reclaimed only when its recorded pid is confirmed gone,
// or, when no owner can be read at all, once the file has sat untouched long enough that
// it cannot be a writer caught between creating the file and writing it.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { cockpitDir } from './learn.mjs';

/** A lock must be at least this old before it can be reclaimed. */
export const STALE_LOCK_MS = 60_000;

const LOCK_FILE = 'state.lock';

/** slug -> tail of the in-process mutation chain. */
const chains = new Map();

const lockPath = (slug) => join(cockpitDir(slug), LOCK_FILE);

/**
 * The held lock, or null if there is none. `owned` is false when the file names no
 * usable owner: acquire() creates it and writes it in two calls, so another process can
 * read it empty or half written. Such a lock is aged by the file's mtime instead.
 */
function readLock(slug) {
  const path = lockPath(slug);
  if (!existsSync(path)) return null;
  let record = null;
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null; // released between the check and the read
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) record = {};
  const { pid = null, ts = null, token = null } = record;
  const owned = Number.isInteger(pid) && pid > 0 && !Number.isNaN(Date.parse(ts ?? ''));
  return { pid, ts, token, owned, mtimeMs };
}

const lockAgeMs = (lock) => {
  const started = lock.owned ? Date.parse(lock.ts) : lock.mtimeMs;
  return Number.isFinite(started) ? Date.now() - started : 0;
};

function ownerIsDead(pid) {
  try {
    process.kill(pid, 0); // existence probe only; no signal is delivered
    return false;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal; only ESRCH means gone.
    return err.code === 'ESRCH';
  }
}

const reclaimable = (lock) =>
  lockAgeMs(lock) > STALE_LOCK_MS && (!lock.owned || ownerIsDead(lock.pid));

/** Take the file lock, reclaiming it once if its holder is gone. */
function acquire(slug) {
  const path = lockPath(slug);
  mkdirSync(cockpitDir(slug), { recursive: true });
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const held = readLock(slug);
      if (attempt === 0 && !held) continue; // released between the open and the read
      if (attempt === 0 && reclaimable(held)) {
        console.warn(
          `[lock] reclaiming a ${slug} lock after ${Math.round(lockAgeMs(held) / 1000)}s — ` +
          (held.owned
            ? `its process ${held.pid} no longer exists`
            : 'it names no owner and was never finished, so its writer crashed'),
        );
        try { unlinkSync(path); } catch { /* someone else got there first */ }
        continue;
      }
      throw Object.assign(
        new Error(
          `another process (pid ${held?.pid ?? 'unknown'}) is mutating "${slug}" — ` +
          'wait for it to finish, or remove cockpit/state.lock if it has crashed',
        ),
        { status: 409 },
      );
    }

    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token }));
    } finally {
      closeSync(fd);
    }
    return token;
  }

  throw Object.assign(new Error(`could not acquire the "${slug}" mutation lock`), { status: 409 });
}

/** Release only OUR lock — never delete one that was stolen from us in the meantime. */
function release(slug, token) {
  const held = readLock(slug);
  if (held && held.token !== token) return;
  try {
    unlinkSync(lockPath(slug));
  } catch { /* already gone */ }
}

/**
 * Run `fn` holding the topic's mutation lock. In-process callers queue rather than
 * fail; a foreign process holding the lock surfaces as a 409.
 */
export function withTopicLock(slug, fn) {
  const previous = chains.get(slug) ?? Promise.resolve();
  const run = previous.then(async () => {
    const token = acquire(slug);
    try {
      return await fn();
    } finally {
      release(slug, token);
    }
  });
  // The chain must survive a failed mutation, or one error would wedge the topic.
  chains.set(slug, run.then(() => undefined, () => undefined));
  return run;
}

/** Non-secret lock state for the health endpoint. */
export function lockStatus(slug) {
  const held = readLock(slug);
  if (!held) return { held: false };
  return {
    held: true,
    pid: held.pid,
    since: held.ts,
    age_ms: lockAgeMs(held),
    // True only when the next writer would reclaim it, so a busy owner never reads as stale.
    stale: reclaimable(held),
    ours: held.pid === process.pid,
  };
}
