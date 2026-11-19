---
change: 2026-11-12-jsonl-damage
status: accepted
track: T2
risk: medium
risk_reason: Every JSONL sidecar read goes through readJsonlDetailed, including the mutation_id replay check in appendUnique that rule 9 relies on. A wrong branch could blank the attempt history, or let a replay append a duplicate. Nothing writes differently and no file format changes.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the JSONL readers report damage, not empty history

Track: T2. One repo, no UI change. Two response surfaces change: `/api/health` and every
route that reads a JSONL sidecar. Risk is medium because every JSONL read, including the
replay check, shares one function.

## Problem

This is the open question left by `2026-11-11-readjson-damage` (PR #157), which fixed the
JSON readers and left the JSONL readers out on purpose.

`readJsonlDetailed` (`app/lib/sidecar.mjs:92`) and the JSONL loop in `inspectSidecars`
(`:359`) still decide "missing" with `existsSync`. Probed on this machine (2026-11-12,
Node 24, uid 501):

| Damage | `existsSync` | `readFileSync` | What the cockpit does today |
|---|---|---|---|
| File with mode 000 | `true` | throws `EACCES` | The throw escapes `readJsonlDetailed`. Every route that reads that file answers 500, and so does `/api/health`, for every topic, because `inspectSidecars` throws too. |
| Cockpit directory not searchable | `false` | throws `EACCES` | Reads as a file that was never written: empty attempt history, no error. `/api/health` leaves the file out and reports nothing. |
| A directory at the file's path | `true` | throws `EISDIR` | Same as mode 000: 500 everywhere, health included. |

The second row is the failure hard rule 8 warns about: damage that shows up as "no
attempts", not as an error. The first and third are loud but take down `/api/health`,
the one route meant to report damage.

The replay check in `appendUnique` (`:119`) reads through the same function. In the
second row it finds no earlier `mutation_id` and moves on to the append. The append fails
on the same directory today, so no duplicate is written, but that is luck, not design.

## Proposed outcome

- `readJsonlDetailed` reads first and treats only `err.code === 'ENOENT'` as a file that
  doesn't exist yet (`rows: []`). Any other read error is damage and is thrown with the
  file name, the I/O `code`, and `status: 500`. Damage never comes back as empty rows.
- `appendUnique` therefore refuses to append when its replay check can't read the file.
  It must never append without having read the history (rule 9).
- `inspectSidecars` catches that error per file and lists the file with
  `source: 'fallback'`, the error and its `code`, and counts it under `degraded`.
  JSONL has no `.bak`, so `fallback` is the honest source. `/api/health` keeps answering
  200 and names the damaged file instead of failing for every topic.
- The existing per-line tolerance stays as it is: a torn or unparseable line is skipped,
  logged and counted in `skipped_lines`. Only a file that can't be read at all is damage.

## Affected users and systems

- James, through the cockpit: `/api/health`, and every view built on attempts, reviews,
  debriefs, operations, stages, misconceptions, practice, teach-backs, sessions,
  diagnoses and transcripts.
- `app/lib/sidecar.mjs`: `readJsonlDetailed`, `appendUnique`'s replay check, and the
  JSONL loop in `inspectSidecars`.
- Unchanged callers that inherit the fix: every `read*` export built on `readJsonl`, and
  through them `stats`, `cards`, `derive`, `recovery`, `restore`, `settlement`,
  `sessions`, `diagnosis` and `dashsnapshot`.

## Constraints

- Hard rule 5: Node stdlib only, and `npm test` passes with no `node_modules`.
- Hard rule 8: nothing on the write path changes. `appendLineSync` stays as it is.
- Hard rule 9: no append without a successful replay read. `readAttemptsRaw` stays the
  replay read; folding is untouched.
- `inspectSidecars`'s return shape stays the same; a damaged JSONL entry uses the fields
  a damaged JSON entry already uses. An optional `code` may be added.
- Test first: a red commit for each behavior before the code that fixes it. The tests pin
  the boundary that broke: what `/api/health` reports and what a route answers, not only
  what `readJsonlDetailed` returns.
- Permission-based tests skip when run as root (root ignores mode 000), as the #157 tests
  do. The `EISDIR` case runs everywhere, so CI still has one red-then-green case.
- No live mutation of the real `.learn` tree. Any live check runs against a `/tmp/learn`
  copy on port 4320.

## Out of scope

- A `.bak` or any other recovery for JSONL files. Append-only history has no backup
  today, and adding one is a design change of its own.
- The recovery view and `restore.mjs`'s own `classify`.
- Any UI change. `/api/health`'s existing fields carry the new facts.
- Finding out why the cockpit got EPERM on 2026-11-11.
- Reading Forgejo Actions job logs to confirm root-skipped tests in CI (separate follow-up).

## Success signals

- `npm test` passes with `node_modules` absent, and the count rises by the new cases.
- New tests, each red before its fix:
  - A directory at `attempts.jsonl`'s path: `/api/health` answers 200 and lists
    `attempts.jsonl` under `degraded` with `code: 'EISDIR'`.
  - The same damage: a route that reads attempts answers 500 naming the file, not 200
    with an empty history.
  - An unsearchable cockpit directory (non-root only): the same two answers, with
    `EACCES`, instead of an empty history.
  - An append with a `mutation_id` against an unreadable file throws and writes no line.
  - A JSONL file that doesn't exist still reads as `[]`, and health still leaves it out.
- The existing torn-line tests stay green and unchanged.
- A live probe on a `/tmp/learn` copy: replace `attempts.jsonl` with a directory, and
  `curl localhost:4320/api/health` answers 200 and names it under `degraded`.

## Open questions

- Should a damaged JSONL read answer 500 on every route that uses it (proposed), or
  should read-only views log it and render empty while only health and the append path
  refuse? This intent proposes the 500: an empty history is the exact symptom being
  removed, and a view that renders empty is how it stayed hidden. Its cost is that one
  damaged file blocks every view that reads it, as a damaged video or Higgsfield job file
  already does for that job's own `get`.
