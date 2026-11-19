# Staging instead of rollback

**Problem:** making a blocking render asynchronous silently converted a private intermediate
state into a published one — a rollback that had always been correct became a number readers
could see and then have taken away.

**Where:** studydeck, `app/lib/mastery.mjs`. PR #33, squash-merged to main as `87aea96` —
so the three rounds it went through (the async fix, the staging rewrite the review forced,
the cleanup guard) survive only in that commit's message, not as commits of their own.

## The approach

1. **Fix the stated bug first, and measure it rather than trusting the finding's number.**
   `execFileSync` held the single event loop for the render child's whole runtime. The
   finding cited 30s; that is the child's *timeout*, not a measurement — a real render is
   40ms. What justified the change was the tail: with a render rigged to take 2s, `/api/health`
   served 6 requests in 3s (p95 2068.9ms) sync versus 133 (p50 3.5ms) async.
2. **Then ask what the `await` changed underneath.** Requests are now served *during* the
   render, and `/api/state` reads `state.json` without the topic lock. The old order —
   write, render, roll the bytes back on rejection — had been safe only because nothing
   could run in between. Nobody had written that precondition down; it was a property of
   the synchrony being removed.
3. **Check the cheap remedy is actually implementable before adopting it.** Keeping the new
   state private requires `render.mjs` to be satisfiable by a scratch directory. Verified,
   not assumed: it reads only `<dir>/state.json` and writes only `<dir>/knowledge-map.md`.
4. **Prepare in `mkdtemp`, render there, publish only on acceptance** — `state.json` first,
   then the map it produced, two atomic writes back to back. The rollback path disappeared
   entirely, because nothing is overwritten until the result is known good.
5. **Pin the ordering with a test that fails for the right reason.** With a slow render in
   flight, the live `state.json` must read byte-identical to its pre-mutation bytes; the
   bump may appear only once the render has been accepted and the publishing writes have
   landed. Re-introducing the single early write makes exactly the two staging tests fail,
   on "state.json was published before the render finished".

## The judgment calls

- **Not taking the topic lock on the read path.** It would have fixed the same observability
  hole, and serialised every `/api/state` behind a render — the exact outage the PR exists
  to remove. The cheaper-looking fix restored the bug in a new place.
- **The rest of the filesystem work stays synchronous, on evidence.** `buildState` blocks
  ~2.6ms warm; async fs would not make it faster (syscall-and-CPU work, not waiting), only
  interleave inside those 2.6ms, in exchange for reworking `atomic.mjs`. The numbers are in
  the code comment so the next person re-derives from them instead of from the 30s.
- **A known crash window kept and documented rather than closed.** Between the two publishing
  writes: microseconds, versus the render's whole runtime before — and self-healing, since
  render regenerates the map from the entire state.
- **The cleanup failure was not unit-tested, deliberately.** Forcing `rmSync` to fail needs a
  `chmod` that does nothing when the suite runs as root, or a seam existing only for that
  test. A test that quietly passes by exercising nothing is worse than none.

## The one that was nearly missed

`rmSync` sat unguarded in a `finally`, so a throw there **replaced** whatever the `try`
produced — and `force` suppresses `ENOENT` only, not `EACCES`/`EPERM`/`EBUSY`. The damage is
not the leaked temp directory. The chain is: cleanup throws *after* both publishing writes
have landed → the caller receives a rejection for a mutation that durably applied →
`applyMastery` turns it into `{ error }` → `settleMastery` therefore skips the
`mastery_applied` marker → the next replay reads "no marker" as work still owed and applies
the confidence bump **a second time**. `settlement.mjs` is written to prevent exactly that
double-apply, and this path walks around it rather than through it — silently, and
indistinguishable from real study progress afterwards.

## The reusable rule

**Write-then-roll-back is not a durability pattern, it is a pattern that borrows an
assumption — that nobody can read between the write and the rollback. When you make
something async, that assumption is what you just deleted.** Stage the mutation somewhere
nobody is looking and publish only the accepted result; then there is nothing to roll back.
And audit every `finally` on the same question a fix like this asks: if this throws *after*
the work succeeded, whose retry logic now believes the work is still owed?
