# existsSync is not a "missing" check

**Date:** 2026-11-11
**Context:** StudyDeck cockpit. Changes `2026-11-11-readjson-damage` (PR #157) and
`2026-11-11-job-list-damage` (PR #158).

## The problem

`readJsonSafe` decided "this sidecar doesn't exist yet" with `existsSync`. That call also
returns false on EPERM and on an unreadable parent directory, so a damaged sidecar read as
an empty one. The UI showed "no cards" instead of an error, which is the failure rule 8
exists to prevent.

## The approach

1. **Read first, then branch on `err.code`.** Call `readFileSync` and catch. Only `ENOENT`
   means missing. Any other code (EPERM, EACCES, EISDIR) is damage, and it keeps its code
   so it can't pass for missing further up.
2. **Missing means both copies are missing.** A primary that is ENOENT beside a `.bak`
   that is unusable is damage (`source: 'fallback'` with the backup's error), not a fresh
   file. The old reader dropped the backup's error and reported nothing.
3. **Collapse the duplicate reader.** `readJsonValidated` already branched on `err.code`.
   `readJsonSafe` became that reader with an accept-anything validator, so the two can't
   drift apart again.
4. **Follow the new "damaged" result to every caller.** Once damage stopped looking like
   missing, a list that mapped `get()` over every job file threw on the first bad one. Each
   `start()` called `list()` first, so one bad file failed four routes with a 500. PR #158
   made `read()` return damage as a value. `get()` still refuses it; `list()` shows it as
   `{ id, status: 'damaged', error }` and lists the other jobs.

## The judgment calls

- **#158 was not folded into #157.** The security review of #157 found the list problem.
  It was rated low and became its own slice, so each PR kept one reviewable claim.
- **A replay inside a damaged job file is accepted, not guarded.** Its `mutation_id` can't
  be read, so a replay starts a second local render. That costs local compute only; nothing
  is billed or leaves the machine (job-list-damage spec F2).
- **No `existsSync` in front of the read as a "fast path".** It is the check that lied.

## The reusable rule

Never use `existsSync` to decide "missing". Attempt the operation, and treat only `ENOENT`
as missing; every other error is damage and must reach the caller with its code. Then check
every caller of that reader, because a caller that treated "missing" as normal may not
handle "damaged" at all.

Still open: the JSONL readers in `app/lib/sidecar.mjs` (lines 94 and 361) have the same blind
spot, so an EPERM `attempts.jsonl` reads as an empty history.
