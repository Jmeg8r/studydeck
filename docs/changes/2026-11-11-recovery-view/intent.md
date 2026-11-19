---
change: 2026-11-11-recovery-view
status: accepted
track: T2
risk: high
risk_reason: Settling an owed attempt applies mastery to state.json, so a wrong settle either double-counts confidence or bumps a concept the learner did not earn, and the confidence history has no undo. Reconcile appends to the operation ledger on the strength of what Open Notebook lists, so a wrong match marks a missing note or episode as done. It adds a new view and three routes, two of them mutating. It touches no Open Notebook write and no state.json write path other than the existing settlement.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a Recovery view that finishes what the cockpit already knows is unfinished

## Problem

This is slice R1 of porting PR #98's September snapshot (`264547c`): its Recovery view and
the `/api/recovery`, `/api/recovery/reconcile` and `/api/recovery/settle` routes. James
chose to split the snapshot's Recovery into two PRs; the backup restore is R2.

`main` already detects unfinished work and says so, then offers no way to act on it. The
health banner (`app/web/js/integrity.mjs`) reports three things:

1. **A graded attempt that never updated mastery.** The banner says: "Nothing in the cockpit
   finishes it yet, and repeating the quiz records a new attempt rather than this one."
   The only way to finish it today is to replay the original request with its
   `mutation_id`, which the learner no longer has.
2. **An Open Notebook write that never confirmed** (operation stage `prepared` or
   `ambiguous`). The banner says to check Open Notebook by hand before doing the action
   again. Nothing in the cockpit can look for it, or record that it landed.
3. **A fact-check whose cards were never created** (`factcheck_cards` not `complete`).
   Health does not count this one at all.

The cost: confidence stays lower than the results show, and a learner who repeats the
action to "fix" it makes a second attempt, or a second Open Notebook note or episode.

## Proposed outcome

- **A Recovery view** (nav item and `#recovery`) lists every owed item per topic, and the
  health banner links to it.
- **Owed mastery:** "Finish saved result" settles a stored final attempt through the
  existing `healUnappliedMastery`. It applies mastery once, from the stored score, never a
  fresh grade.
- **Unconfirmed Open Notebook write:** "Check external outcome" reads Open Notebook (GET
  only) for the note or episode the operation names. If exactly one match is found, it
  appends a `complete` revision of the operation. Otherwise it changes nothing and says
  the outcome is still unknown. It never creates, posts or deletes anything to find out.
- **Fact-check cards:** "Finish saved result" creates the missing cards through the
  existing `completeFactcheckCards`.
- **Unfinished attempts** (not yet final) get a "Resume assessment" link to where they
  started. Recovery does not grade them.
- **Every action can be replayed** without a second effect.

## Affected users and systems

- James, as the learner, in the cockpit.
- `app/router.mjs` (three routes), a new `app/lib/recovery.mjs`, a new
  `app/web/js/views/recovery.mjs`, nav wiring in `app/web/js/main.mjs`, and the banner in
  `app/web/js/integrity.mjs`.
- **Read:** `cockpit/attempts.jsonl`, `cockpit/operations.jsonl`, Open Notebook's note and
  episode lists.
- **Written:** `cockpit/operations.jsonl` (reconcile), `state.json` and `attempts.jsonl`
  through the existing settlement path, and the cards sidecar through the existing
  fact-check path.

## Constraints

- **Rule 7:** Recovery never reveals an answer. The list and every response carry no deck
  answer, fact-check truth or correction.
- **Rule 9:** every appending request is replay-safe. Settle is idempotent by
  construction, because an applied attempt is not owed. Reconcile's mutation id is
  derived from the operation and its revision; see Open questions.
- **Rules 10 and 11:** settlement runs under `withTopicLock`, as it does today. Nothing
  is inferred from the calendar or from partial evidence.
- **Ambiguous mastery is never settled here.** `mastery_settlement.stage: ambiguous`
  stays blocked and is shown read-only, as `owesMastery` already decides.
- **Rule 12:** the two POSTs go through the guard like every other mutating route. No
  CORS header anywhere.
- **Degradation:** with Open Notebook down, reconcile answers 503 naming the service and
  appends nothing. `/api/recovery` still lists local items.
- **What counts as owed must match `/api/health`.** The view and the banner must never
  disagree, so the list reuses `sidecar.mjs`'s predicates (`owesMastery`, the unresolved
  stages) rather than redefining them.
- Rule 5: no dependency, no build step.

## Out of scope

- **R2, explicit backup restore:** the snapshot's `app/lib/restore.mjs`, `app/recover.mjs`
  and `app/lib/schema.mjs`. That's the next PR.
- **Podcast rendition cards:** they need D5's `podcastrender.mjs`, which isn't on `main`.
- **"Retry saved request" cards:** they need a client-side saved-intent store
  (`pendingIntents`) that `main` doesn't have.
- **Resolving ambiguous mastery** (reconciling `state.json` by hand).
- **Reconciling operation kinds the snapshot didn't handle** (`summary_request`,
  `summary_draft`, `debrief`). These are listed with the "still unknown" answer.
- **Any automatic retry** of an Open Notebook create or delete.

## Success signals

- **Owed mastery:** on a `/tmp/learn` copy with an owed attempt, "Finish saved result"
  bumps that concept's confidence exactly once.
  - A second click, or a replayed POST, changes nothing.
  - `/api/health`'s `mastery_unapplied` drops by one.
  - Checked by hand against `state.json` and `attempts.jsonl`.
- **Recorders** (`app/test/recoveryegress.test.mjs`): reconcile sends GETs only to Open
  Notebook, and appends one `complete` revision when exactly one match exists.
  - It appends nothing for zero matches or for two.
  - Each "nothing written" assertion has a control that requires the write.
- **Degradation test:** with Open Notebook unreachable, reconcile is 503 naming Open
  Notebook, and `/api/recovery` is 200 with the local items.
- **Answer leak:** no deck answer, truth or correction appears in any Recovery response
  body (a planted fixture, asserted absent).
- **Consistency:** the counts in `/api/recovery` equal `/api/health`'s for the same tree.
- **Screenshots:**
  - the view with one owed item of each kind;
  - the empty state;
  - the banner's link.
- `npm test` with `node_modules` absent; `npm run verify` clean.

## Open questions

1. **Reconcile's mutation id is derived server-side,** not minted by the client (rule 9 as
   written). The derived id is deterministic per operation and revision, so a replay
   dedupes the same way. Is that acceptable, or should the client mint one?
2. **Should fact-check card completion be listed and counted?** Health doesn't count it
   today. Including it means adding a counter so rule "the view equals health" holds.
3. **Episode matching** reuses `matchRendition` from `podcastbatch.mjs`. Is its match rule
   strict enough to count as "exactly one", or does reconcile need its own stricter
   check? To be settled in the spec by reading it.
