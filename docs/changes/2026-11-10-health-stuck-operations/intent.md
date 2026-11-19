---
change: 2026-11-10-health-stuck-operations
status: accepted
track: T1
risk: medium
risk_reason: Changes when /api/health reports degraded and what the storage banner tells the learner. Too narrow and an external write whose outcome is unknown stays invisible, inviting a duplicate note or episode; too wide and an ordinary in-flight request raises a false alarm on every view.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: health says so when an operation is stuck

## Problem

In James's words today: "Yes, start it", the next slice of porting PR #98's September
snapshot (`264547c`): health shows stuck operations.

The cockpit records each write it makes to Open Notebook (notes, mind-map notes, debrief
notes, sources, podcast episodes) as an append-only operation in `cockpit/operations.jsonl`.
An operation that reached `prepared` (the request may have been sent) or `ambiguous` (it
was sent and the answer was lost) has an outcome nobody confirmed. The cockpit deliberately
will not repeat it automatically, because repeating it can create a second note or episode.
Graded attempts have the same partial state for mastery: `mastery_applied: false`, or a
settlement left `ambiguous`.

`inspectSidecars` already counts all three, and `/api/health` already returns the counts:
`operations.unresolved`, `attempts.mastery_unapplied` and `attempts.mastery_ambiguous`.
Nothing acts on them. Health's `status` stays `ok` whatever they say, and the storage
banner, which shows only when status is `degraded`, has no line for them. A test in
`sidecar.test.mjs` asserts the count with the message "health must not hide an external
write that cannot safely replay", while the route hides it. The count is tested; what the
route does with it is not.

## Outcome

- `/api/health` reports `degraded` when any topic has an unresolved operation, an attempt
  whose mastery did not apply, or an attempt whose mastery settlement is ambiguous, as the
  snapshot does.
- Each topic's report lists its unresolved operations, with kind, stage, when it was
  recorded, and the title or episode name it was for, so the learner can look for it in
  Open Notebook. A count alone gives nothing to look for.
- The banner gives one line per unresolved operation and one line per kind of mastery
  problem, saying what it means and what to do. It tells the learner to check Open
  Notebook before doing the action again, because a repeat may duplicate it.

## Out of scope

- Resolving or retrying operations from the browser.
- The snapshot's other new health fields: canonical state, recording problems, and the
  per-topic `inspection_error` guard. They belong to other slices.
- `npm run verify` reporting the same conditions.
- `pending_self_grade` and `mastery_prepared`, which are owed work rather than faults.
