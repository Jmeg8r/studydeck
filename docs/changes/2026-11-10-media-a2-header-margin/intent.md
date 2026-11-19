---
change: 2026-11-10-media-a2-header-margin
status: accepted
track: T1
risk: low
risk_reason: Test-only. One test's deadlines and the stub's timing knobs in app/test/media.test.mjs change; app/lib/media.mjs and every route are untouched. The failure mode is a test that proves less than it claims, which the new elapsed-time assertion guards.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: A2 stops failing on a busy CI runner

## Problem

`A2: a body slower than the header deadline still arrives whole` in
`app/test/media.test.mjs` fails now and then in CI with
`media response headers timed out`, about 90 ms in. It came in with `05562a5` and
`2d0b7c3` on 2026-11-09. The forge job logs show it in five runs since then, on both Node
versions:

| Task | Commit | Node | Failed after |
|---|---|---|---|
| 20033 | `aa1459c` | 24 | 85.7 ms |
| 20454 | `b167bb4` | 22 | 83.1 ms |
| 20511 | `db893d7` | 24 | 85.9 ms |
| 20561 | `016b878` (`main`) | 22 | 90.2 ms |
| 20653 | PR 146 | 24 | 94.6 ms |

A sixth single-job failure, task 20254 on `86c84ac`, was a different test
(`probeWorkerPickup → timeout, not unavailable, when reads fail then recover`) and is not
part of this change. Twelve local runs never failed.

The test calls `fetchMedia` with `headerTimeout: 50`. The stub is on the same machine, but
on a loaded runner its response headers can take more than 50 ms. Then the header deadline
fires before any body byte, which is not what A2 is about. The bug is the margin between
how long headers take to arrive and the deadline, not `fetchMedia`.

## Outcome

- A2's header deadline sits well above how long headers take on a loaded runner. The test
  delays the stub's headers on purpose, so that margin is tested every run.
- The trickled body still takes clearly longer than the header deadline. A2 measures this
  and fails if the body finishes inside the deadline, because then it would prove nothing.
- A3's header-deadline check keeps its meaning: no headers at all still fails at the header
  deadline, well under a second.
- `npm test` passes with no `node_modules`.

## Out of scope

- `app/lib/media.mjs` and its defaults. The code behaves as designed.
- The `probeWorkerPickup` failure in task 20254.
- A7's trickle timing, which is not flaky.
