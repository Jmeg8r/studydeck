---
change: 2026-11-11-readjson-damage
status: accepted
track: T2
risk: medium
risk_reason: Every JSON sidecar, video job and Higgsfield storyboard read goes through readJsonSafe. A wrong branch could blank the cockpit or turn a missing job into a 500. Nothing writes differently, and no file format changes.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: readJsonSafe reports damage, not "missing"

Track: T2. One repo, no UI change. Two response surfaces change: `/api/health` and the
video and Higgsfield job reads. Risk is medium because every JSON sidecar read shares
this function.

## Problem

James wants this: a missing primary beside an unusable backup should read as damage,
not as missing.

Today `readJsonSafe` (`app/lib/atomic.mjs:127`) decides "missing" with `existsSync(path)`.
That is wrong twice:

1. **A missing primary beside an unusable `.bak` reads as missing.** The backup's parse
   error is thrown away (`:129-133`), and the result is `source: 'missing', error: null`.
   `/api/health` (`inspectSidecars`, `sidecar.mjs:349-375`) lists the file as healthy.
   The video and Higgsfield `get` return `null`, which reads as "no such job", not "job
   state is damaged". `restore.mjs:59-62` already treats a missing sidecar beside a backup
   as damage, so the recovery view and `/api/health` disagree.
2. **`existsSync` returns `false` on any stat error, not only on ENOENT.** When the cockpit
   got `EPERM` on every file under `/Volumes/Projects` (2026-11-11, fixed by a restart, cause
   unknown), each sidecar read as missing with no error. The cockpit served empty data and
   health reported nothing wrong. This is the failure hard rule 8 warns about: damage that
   shows up as "no cards", not as an error.

`readJsonValidated` (`atomic.mjs:180-193`, added 2026-11-11 for the renderer's manifest)
already does this right. It reads first, treats only `err.code === 'ENOENT'` as missing,
and reports a missing primary beside an unusable backup as `fallback` with the backup's
error.

## Proposed outcome

- `readJsonSafe` returns `source: 'missing'` only when the primary and its `.bak` are both
  absent (ENOENT).
- A missing primary beside an unusable `.bak` returns `source: 'fallback'` with an error
  that names the backup's problem.
- A primary that can't be read for any other reason (EPERM, EACCES, EISDIR) is unreadable,
  not missing. It falls back to the `.bak` as a corrupt primary does today, and its error
  carries the I/O `code`.
- `readJsonSafe` is built on the same core as `readJsonValidated`, with an accept-anything
  validator, so the two readers can't drift apart again. This reverses, on purpose, the
  2026-11-11 note at `atomic.mjs:145-149` that kept them separate.
- `inspectSidecars` no longer skips a file because `existsSync` said no to both copies.
  An EPERM sidecar shows up in `/api/health` as `fallback` and in `degraded`.
- Callers need no new branches. `sidecar.mjs:77` already logs `fallback`, `:375` already
  counts it as degraded, and the video and Higgsfield `get` already answer 500 "state is
  damaged" on `fallback`.

## Affected users and systems

- James, through the cockpit: `/api/health`, the sidecar-backed views, and the video and
  Higgsfield job routes.
- `app/lib/atomic.mjs`: `readJsonSafe` and the shared reader core.
- `app/lib/sidecar.mjs`: `inspectSidecars`'s pre-filter at `:351`.
- Unchanged callers that inherit the fix: `sidecar.mjs` `readJson`, `videogeneration.mjs:195`,
  `higgsfield.mjs:67`.
- `readJsonValidated` and `podcastrender.mjs` keep their behavior, pinned by
  `atomicvalidated.test.mjs`.

## Constraints

- Hard rule 5: Node stdlib only, and `npm test` passes with no `node_modules`.
- Hard rule 8: nothing on the write path changes. `writeJsonAtomicSync`, `retainBackup`
  and the `.bak` guarantee stay as they are.
- The return shape stays `{ value, source, error }`, with the same four sources. An
  optional `code` may be added, as `readJsonValidated` already does. No caller may need
  to change to keep working.
- Test first: a red commit for each behavior before the code that fixes it. The tests pin
  the boundary that broke, meaning what `/api/health` and a job `get` report, not only
  what `readJsonSafe` returns.
- Existing `atomic.test.mjs` and `atomiccharacter.test.mjs` cases keep passing unchanged.
  Any case that pinned the old "missing" answer for the backup case is changed in a
  commit that says so.
- No live mutation of the real `.learn` tree. Any live check runs against a `/tmp/learn`
  copy on port 4320.

## Out of scope

- The JSONL readers (`sidecar.mjs:94`, `:360`), which still use `existsSync`. See Open
  questions.
- `restore.mjs`'s own `classify`, and the recovery view.
- Any UI change. `/api/health`'s existing fields carry the new facts.
- Finding out why the cockpit got EPERM on 2026-11-11.
- `videogeneration.mjs` moving onto `resolveTool`, a separate backlog item.

## Success signals

- `npm test` passes with `node_modules` absent, and the count rises by the new cases.
- New tests, each red before its fix:
  - A missing primary beside a corrupt `.bak` gives `source: 'fallback'` and a non-null
    error naming the backup.
  - A primary that can't be read (a directory at the path, or a file with mode 000 where
    the platform enforces it) gives `fallback` or `backup`, never `missing`, and carries
    `code`.
  - `inspectSidecars` lists that file under `degraded`.
  - Video and Higgsfield `get` on a job whose `job.json` is missing beside a corrupt
    `.bak` throws the 500 "damaged" error and does not return `null`.
- `atomicvalidated.test.mjs` is unchanged and green.
- A live probe on a `/tmp/learn` copy: delete a sidecar, corrupt its `.bak`, and
  `curl localhost:4320/api/health` names the file under `degraded`.

## Open questions

- Should the JSONL readers get the same ENOENT treatment in this slice or the next? An
  EPERM `attempts.jsonl` reads as empty history today, which is the same failure. They
  read line by line with different fold semantics, so this intent leaves them out unless
  James says otherwise.
