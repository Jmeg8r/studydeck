---
change: 2026-11-10-media-a2-header-margin
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: A2 stops failing on a busy CI runner

## Files that change

- `app/test/media.test.mjs` only.

## Order of work

1. **Commit 1, test only** (`test(media): ...`). Give the stub two settings that `reset()`
   puts back to their defaults for each test:
   - `headerDelay` (default 0): how long the stub waits before it answers at all;
   - `trickleEvery` (default 30): the gap between trickle slices, so A7 is unchanged.

   A2 sets `headerDelay: 100`, which is a slow runner on purpose and twice the old 50 ms
   deadline. It also checks that the body took longer than `headerTimeout`. With A2's
   current deadlines it must fail every time with `media response headers timed out`. The
   red run goes in the commit message.
2. **Commit 2, the fix** (`fix(media): ...`). A2 uses `headerTimeout: 1000`, the value A3's
   stall leg already relies on, and `trickleEvery: 150`. Headers then arrive about 900 ms
   inside the deadline, even with the 100 ms delay. The ten slices end about 1.6 s after
   the request starts, well past the deadline. `setTimeout` can only run late, so a busy
   runner makes the body longer, not shorter. Then run the test file 20 times,
   then again under CPU load, then `npm test` with no `node_modules`.
3. PR through `forge-pr create`, then `/gstack-codex review origin/main` posted verbatim,
   then the AI gate, then James's merge approval. Acceptance of this intent and plan is its
   own commit once James approves.

## Risks

- **A2 gets slower**, by about 1.5 s. The body has to outlast a deadline that is now
  comfortable, and that costs time. A 600 ms deadline with 100 ms slices would save about
  0.5 s, but leaves less headroom on a runner that already lags 40 ms on a 50 ms timer.
- **A test that passes can still prove nothing.** If someone later shortens the trickle
  below the deadline, A2 would pass without testing anything. The elapsed-time check stops
  that.

## Proof

- **Commit 1** (`c0a9f36`): with no `node_modules`, A2 still at `headerTimeout: 50`, the
  file fails A2 with `media response headers timed out` on Node 24.14.0 (52.985 ms) and
  22.23.1 (52.865 ms), 7 pass, 1 fail. That is the error the forge logs show. Three more
  runs failed the same way.
- **Commit 2**: the media file passed 20 of 20 idle (ten each on Node 24 and 22), and 20 of
  20 under load (56 `yes` processes on 28 cores). A2 takes about 1.46 s and A3 about 0.3 s.
  `npm test` with no `node_modules`: 620 pass, 0 fail on Node 24.14.0 and on 22.23.1.

## Deviations

- **The stub now reads `mode` once per request.** The first run of commit 2 broke A3, which
  this change does not touch. The stub's trickle loop read the shared `mode` on every tick.
  A2's response sends `res.end()` one gap after its last slice, and by then A3 had set
  `mode` to `'stall'`. So A2's last tick took the stall branch and never ended the
  response. A3's stall request reused that keep-alive socket and queued behind a response
  that never finished, so its headers timed out after 1000 ms. With a 30 ms gap, the
  window had only ever overlapped `'no-headers'`, which does nothing to a running trickle.
  The stub's own comment already said it reads the mode per request. `answer()` now does
  that, for `mode` and `trickleEvery`.
