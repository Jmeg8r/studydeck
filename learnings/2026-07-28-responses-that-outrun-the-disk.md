# Responses that outrun the disk

**Date:** 2026-07-28
**Context:** StudyDeck cockpit — closing P1 findings F5, F4, F2 and F3 from the
2026-07-27 project assessment (PRs #18 and #19).

## The problem

Four findings that read as four unrelated bugs — non-atomic writes, colliding debrief
card ids, leaked fact-check verdicts, a discardable quiz attempt — turned out to be one
failure repeated. In every case **the response described something the disk did not**:

- A truncate-then-write left a corrupt file, and the reader turned that into an empty
  fallback, so the UI said "no cards" when it meant "this file is broken."
- A second same-day debrief hit ids the first one owned, so the response reported zero
  cards when the note had saved fine — reading exactly like a cold model.
- `GET /api/factcheck` returned the verdicts and the browser discarded them on render, so
  the code looked like it protected the answers while the payload sat in devtools.
- The grade route revealed every answer without writing an attempt, so history could
  disagree with what the learner had actually seen.

Each is invisible in a diff, because the code is locally correct. They only appear when
you hold the response and the file side by side.

## The approach

1. **Order the fixes by what the other fixes need.** F5 first, because idempotent replay
   is what makes F4's "retry doesn't duplicate the note" possible, and F3's finalize step
   needs mutation ids and revisioned records. Fixing F4 first would have meant building
   its dedupe twice.
2. **Fold at the reader, not the writer.** Attempts gained `attempt_id` + `revision`, and
   `readAttempts` collapses the log to the newest revision per attempt. Because every
   consumer already went through that one function, `derive.mjs`, `stats.mjs` and
   `cards.mjs` needed *no changes* and cannot drift apart. Legacy records carrying neither
   field pass through untouched — pinned by a test using the exact shape already on disk.
3. **Back up only what still parses.** `writeJsonAtomicSync` refuses to copy an unparseable
   primary over `<name>.bak`. Without that check, the first read after a corrupt write
   destroys the only good copy — a backup scheme that turns one bad file into two.
4. **Say what recovery actually buys.** `.bak` is one write behind, so the write that
   crashed is still lost. That went in the PR body, `CLAUDE.md`, and a test assertion,
   because "crash-safe" invites the reader to assume more than it delivers.
5. **Two halves of idempotency, and they are not interchangeable.** The on-disk ledger
   dedupes a mutation only *after* it is recorded; work spanning awaits (a debrief spends
   ~15s) needs an in-process map keyed by mutation to collapse concurrent requests. A
   restart empties the map and only the ledger survives — so both are required.
6. **Delete the hole rather than guarding it.** F3's dry-run grade route was removed
   outright instead of gated behind a ticket. Fewer moving parts, and no route left that
   could reveal an answer at all.
7. **Verify mutations against a copy.** `STUDYDECK_LEARN_ROOT` points the app at a scratch
   tree, so driving the write paths cannot record attempts and confidence bumps that were
   never earned. Adding it immediately exposed a hardcoded `./.learn/topics/<slug>` in
   `renderTopic` — state.json and the knowledge map would have rendered in two different
   directories.

## What it cost to find

- **The score line was the last bug, and only clicking found it.** After finalization the
  results screen read `1 / 7 auto-graded`, counting the self-marked item, because
  `correct !== null` becomes true for both once marked. The attempt record kept the
  distinction; the screen threw it away. Every test passed. Reading the diff would not
  have caught it — it is the same "UI implies more than the data supports" failure the
  whole pass was about, reintroduced *by the fix*.
- **Review caught the same class three more times.** A card id built from an 8-char prefix
  of client-supplied text (two mutations sharing a prefix → one id for two cards, and
  reviews resolve by id); a replay branch that revealed a grading of the retried payload
  rather than the recorded one; and — the worst of them — `mastery_applied` stamped on the
  attempt *at append time*, before the update it described had run. A failed render or a
  topic lock held by another process then left an attempt permanently marked done with no
  mastery behind it, and the retry returned a cheerful replay forever.
- **The flag fix needed a second write, and that is the point.** `mastery_applied` now
  means "it happened", not "it was supposed to": the attempt appends with `false`, and a
  follow-up record at the same revision flips it once `applyAttemptToState` actually
  returns. That is what makes retrying safe, which is what makes healing possible —
  `/api/health` reports `mastery_unapplied`, and resubmitting the same mutation id
  finishes what was owed. Verified by holding the topic lock from another process:
  confidence moved `0.05 → 0.17` exactly once across three retries.
- **And the first heal attempt didn't fire.** The finalize route's `already_final` early
  return sat above the heal, so the retry short-circuited before reaching it. Only driving
  the sequence live — block, observe, release, retry — showed that; the unit tests passed
  the whole time, because they tested the heal helper rather than the route that guards it.

## The transferable rule

**When a write and a response disagree, the bug is invisible in the diff.** So verify the
pair, not the code: after any change to a mutation path, re-read the file it wrote and
check that every number in the response can be derived from it. If the response contains
something the file does not — a revealed answer, a score, a status — ask what happens when
the request is retried, when it arrives twice at once, and when the process dies halfway.

Corollary: **a fallback that hides a distinction is a bug, not resilience.** Returning `[]`
for a corrupt file, discarding secrets client-side, counting a self-marked item as
auto-graded — each replaces a fact with a plausible-looking substitute. Report the
degraded state (`source: 'backup'`, `status: 'degraded'`, `pending_self_grade`) and let the
surface show it.

## See also

- `tasks/project-assessment-2026-07-27.md` — the findings, with the original statements.
- `tasks/implementation-notes.md` — per-PR design notes, deviations, and verification logs.
- `CLAUDE.md` hard rules 7–10 — the storage and secrecy invariants this established.
