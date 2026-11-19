---
change: 2026-11-09-topic-lock-ownership
status: accepted
track: T1
risk: medium
risk_reason: The topic lock is what keeps two cockpit writers off one state.json. If it is taken from a live owner, one concept update silently overwrites another; if it can never be reclaimed, every mutation on that topic fails until someone deletes the lock file by hand.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a topic lock is reclaimed only from an owner that is gone

## Problem

In James's words today: "Yes, split lock fix", choosing to pull the lock fix out of
PR #98 (`f850391` on `fix/coding-principles-studydeck`) instead of rebasing that
85-file PR.

`app/lib/lock.mjs` on `main` takes a topic lock from its holder in two cases where the
holder may still be writing:

1. **Age alone.** A lock older than `STALE_LOCK_MS` (60 s) is stolen whatever its
   recorded `pid` is doing. A mastery update whose render runs past a minute loses its
   lock to the next writer mid-mutation.
2. **Unreadable content.** `readLock` maps a lock file that does not parse to
   `ts: null`, which `lockAgeMs` reads as infinitely old, so it is stolen at once. The
   holder creates the file with `wx` and writes it in a second call, so a lock that is
   caught between the two is stolen from a live writer.

Either one lets two writers run read → modify → write → render on the same topic, the
race hard rules 4 and 10 exist to close.

## What changes

- A readable lock is reclaimed only when it is older than `STALE_LOCK_MS` **and** its
  recorded `pid` is confirmed absent (`process.kill(pid, 0)` fails with `ESRCH`). A live
  pid, or one that cannot be inspected (`EPERM`), keeps the lock.
- A lock with no usable owner (unreadable, or no valid `pid`/`ts`) is NOT taken at once.
  PR #98 made it permanent instead; that trades the race for a topic that stays locked
  after a crash between create and write. Here it is reclaimed once the **file itself**
  is older than `STALE_LOCK_MS` by its modification time: create-then-write takes
  microseconds, so an ownerless file that old was abandoned, not caught mid-write.
- `lockStatus().stale` reports the same rule, so the health endpoint says "reclaimable"
  only when the next writer would actually reclaim it.

## Out of scope

The rest of PR #98: its September application snapshot (`264547c`), its operator docs
(`0894d6a`, including `ops/README.md`) and its `CLAUDE.md` hunks. They are a separate
review. A recycled pid (a new process reusing a dead owner's id) still holds the lock;
the 409 message already says to remove `cockpit/state.lock` when the writer has crashed.

## Done when

- Two regression tests, committed first and seen failing on `main`'s code: an old lock
  owned by a live process is refused with a 409 and left byte-for-byte; a fresh partial
  lock is refused with a 409 and left byte-for-byte.
- A third test: an ownerless lock file older than `STALE_LOCK_MS` by mtime is reclaimed.
- The existing lock tests still pass, `npm test` passes with no install, Codex and the
  AI-review gate pass, and James approves the merge.
