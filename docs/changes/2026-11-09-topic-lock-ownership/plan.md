---
change: 2026-11-09-topic-lock-ownership
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a topic lock is reclaimed only from an owner that is gone

## Files that change

- `app/test/lock.test.mjs`: three new tests (below).
- `app/lib/lock.mjs`: `readLock`, a new `ownerIsDead`, a `reclaimable` rule shared by
  `acquire` and `lockStatus`, and the header comment's description of staleness.

Nothing else. `app/router.mjs` reads `lockStatus` for the health payload and keeps its
shape; only the meaning of `stale` tightens to "would be reclaimed".

## Order of work

1. **Commit 1, tests only** (`test(lock): ...`). Add to `app/test/lock.test.mjs`:
   - an old lock (`ts` = now − `STALE_LOCK_MS` − 1 s) owned by `process.pid` is refused
     with a 409 and the file is unchanged byte for byte;
   - a partial lock (`{"pid":`, fresh mtime) is refused with a 409 and unchanged;
   - an ownerless lock (`{"pid":` with mtime set back past `STALE_LOCK_MS` via
     `utimesSync`) is reclaimed and the mutation runs.
   Run them against `main`'s `lock.mjs` and record the result: the first two must FAIL
   (today's code steals both); the third passes on `main` too and is there to pin that
   the fix does not regress it.
2. **Commit 2, the fix** (`fix(lock): ...`). In `lock.mjs`:
   - `readLock` returns `null` for a missing file, the parsed record for a JSON object,
     and an ownerless marker otherwise; it also returns the file's mtime.
   - `ownerIsDead(pid)`: integer pid > 0, `process.kill(pid, 0)`, true only on `ESRCH`.
   - `reclaimable(lock)`: owned (valid integer `pid` and parseable `ts`) → age >
     `STALE_LOCK_MS` and `ownerIsDead`; ownerless → file mtime age > `STALE_LOCK_MS`.
   - `acquire` steals only when `reclaimable`; its warning names which rule fired.
   - `lockStatus.stale` = `reclaimable(lock)`.
3. Update the existing stale-lock tests only if their fixture stops matching the rule
   (pid 999999 is expected to be absent, so they should pass unchanged).

## Risks

- **pid 999999 exists on this machine.** The existing "stale lock is stolen" test would
  then hold. Check with `kill -0 999999` before relying on it; if it is ever live the
  test needs a pid found absent at run time.
- **`EPERM` on another user's pid** keeps the lock. That is the conservative choice and
  matches the intent.
- **mtime granularity** is at worst a second on APFS, far below 60 s.

## Proof

- Commit 1 on its own: `node --test app/test/lock.test.mjs` shows the two new
  ownership tests failing, everything else passing.
- Commit 2: `node --test app/test/lock.test.mjs` all pass; `npm test` all pass with no
  `node_modules`.
- `/gstack-codex review origin/main` posted verbatim on the PR with GATE: PASS/FAIL;
  `forge-pr status` SAFE.

## Options not taken

- **Keep #98's version** (an ownerless lock is held forever): closes the race but turns a
  crash between create and write into a topic that cannot be mutated until the file is
  deleted by hand.
- **Write the lock atomically (temp file, then link/rename)** so it is never partial:
  removes the partial case at the source, but `rename` does not fail on an existing
  target, so exclusive creation would need `linkSync`, a bigger change to a hot path for
  no gain over the mtime rule.
