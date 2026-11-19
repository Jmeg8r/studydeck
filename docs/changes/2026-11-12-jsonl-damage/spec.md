---
change: 2026-11-12-jsonl-damage
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: []
claude_config_sha: 58442fe
---
# Spec: the JSONL readers report damage, not empty history

## Flagged concerns

1. **A JSONL read now throws inside `try` blocks that were written for Open Notebook
   failures.** Several routes wrap an ON call and a sidecar write in one `try`, then
   classify any error by `err.status` (`router.mjs:283`, `:408`, `:474`, `:520`, `:1441`).
   A 500 from a damaged `operations.jsonl` would land there as "ON outcome unknown", and
   the `catch` then tries to append a revision through the same unreadable file and throws
   again. Today a mode-000 file already throws there, so this is not new for that case.
   It is new for the unsearchable-directory case, which used to read as empty and carry on.
   *Source:* the intent's "Callers need no new branches" stance, and rule 9.
   *Recommendation:* accept with no new branches. The second throw escapes the `catch` and
   reaches the top-level handler as a 500 that names the file, which is the outcome R2
   asks for. Nothing is recorded with a wrong classification, because the revision append
   is the thing that fails. The plan lists these five sites and the tests pin one of them
   (the append refusing), not all five.
   *James (2026-11-12):* accepted as recommended.

2. **An unsearchable cockpit directory flags every JSONL sidecar, including ones never
   written.** When the directory can't be searched, `EACCES` on a file says nothing about
   whether it exists. All ten JSONL sidecars report `fallback` and land in `degraded`.
   *Source:* the intent's rule that only ENOENT means missing; same call as
   readjson-damage concern 2. *Recommendation:* accept. "Can't verify" is damage.
   *James (2026-11-12):* accepted as recommended.

3. **The error text reaches the browser, so it must not carry an absolute path.**
   `readFileSync`'s own message reads `EACCES: permission denied, open '/Volumes/…'`. The
   top-level handler sends `err.message` as the 500 body (`router.mjs:3200`).
   *Source:* rule 6's spirit (send the browser only what it needs) and `security-review`.
   *Recommendation:* the thrown message is built from the sidecar's name and the code only:
   `<name> is unreadable (<code>)`, for example `attempts.jsonl is unreadable (EACCES)`. The
   full `readFileSync` error, path included, goes to the server log only. `/api/health`
   uses the same short message. This is stricter than readjson-damage, which accepted the
   path in health; here the same text also reaches every route's 500 body.
   *James (2026-11-12):* accepted as recommended.

## Requirements

- **R1** `readJsonlDetailed` reads first. `ENOENT` returns `{ rows: [], skipped: 0 }`.
  (intent: "treats only `err.code === 'ENOENT'` as a file that doesn't exist yet")
- **R2** Any other read error throws an `Error` with message `<name> is unreadable (<code>)`,
  `status: 500`, `code: <code>` and `file: <name>`, where `<name>` is the sidecar's path
  relative to the cockpit directory (`attempts.jsonl`, `transcripts/<id>.jsonl`). The
  original error is logged once with `console.error` and attached as `cause`.
  (intent: "thrown with the file name, the I/O `code`, and `status: 500`"; concern 3)
- **R3** `appendUnique` writes no line when its replay read throws; the error propagates.
  (intent: "must never append without having read the history")
- **R4** `inspectSidecars` drops the `existsSync` pre-filter, calls `readJsonlDetailed` for
  each JSONL sidecar, skips a file only when it reads as ENOENT, and on a thrown R2 error
  lists `{ file, source: 'fallback', error: <message>, code }` without `records` or
  `skipped_lines`. The existing `degraded` filter then includes it. A damaged
  `attempts.jsonl` or `operations.jsonl` leaves its row array empty for the counts below.
  (intent: "lists the file with `source: 'fallback'`… counts it under `degraded`")
- **R5** `/api/health` answers 200 when any JSONL sidecar is damaged.
  (intent: "keeps answering 200 and names the damaged file")
- **R6** Per-line tolerance is unchanged: an unparseable line is skipped, logged and counted.
  (intent: "The existing per-line tolerance stays as it is")
- **R7** No write path changes: `appendLineSync`, `appendTranscript`, and the JSON readers
  are untouched. (intent constraints, rules 8 and 9)

## Design

One function changes shape and one loop changes its guard. Everything else inherits.

```
readJsonlDetailed(slug, name)
  try   text = readFileSync(path)
  catch err
        err.code === 'ENOENT'  → return { rows: [], skipped: 0 }
        otherwise              → console.error(full err); throw jsonlDamage(name, err)
  per-line parse as today
```

`jsonlDamage(name, err)` is a small local helper in `sidecar.mjs` that builds the R2 error.
It lives beside `readJsonlDetailed` because no other module throws it; nothing is added to
`atomic.mjs`.

`appendUnique` needs no edit: its replay read already runs before `appendLineSync`, so a
throw there stops the append (R3). The test pins it so a later reorder fails loudly.

`inspectSidecars`'s JSONL loop:

```
for name of JSONL_SIDECARS
  try   { rows, skipped } = readJsonlDetailed(slug, name)
  catch err with err.file → files.push({ file: name, source: 'fallback', error: err.message, code: err.code }); continue
  (any other error rethrows)
  if the file was ENOENT → continue          (readJsonlDetailed reports this; see below)
  as today
```

To tell "ENOENT" apart from "exists and empty", `readJsonlDetailed` returns
`{ rows, skipped, missing: true }` on ENOENT. Existing callers destructure `rows` and
`skipped` only, so the extra field changes nothing for them.

Routes need no change. A route that reads a damaged file throws R2's error, and the
top-level handler (`router.mjs:3185-3200`) answers `500 { error: 'attempts.jsonl is
unreadable (EACCES)' }` and logs the stack.

## Security and data

- No auth, guard, CORS or secret path changes. Rule 12's guard runs before any read.
- Response bodies carry the sidecar name and an errno code only (concern 3). Absolute
  paths stay in the server log.
- No file format, schema or `.learn/` change. JSONL files are only read here.
- `security-review` is not applied at spec time; it runs against the diff at VERIFY, as it
  did for readjson-damage and job-list-damage. No UX-copy skill applies: no UI changes, and
  the only new text is the error message fixed by R2.

## Acceptance checks

Each is a test that goes red before its fix, unless marked otherwise.

| Check | Proves |
|---|---|
| Directory at `attempts.jsonl`: `GET /api/health` → 200, `degraded` contains `attempts.jsonl`, its entry has `code: 'EISDIR'` and an `error` with no `/` in it | R4, R5, concern 3 |
| Same damage: a route that reads attempts (`GET /api/stats/<slug>` or the nearest existing attempts route) → 500, body `{ error: 'attempts.jsonl is unreadable (EISDIR)' }` | R2 |
| Same damage: `appendAttempt` with a `mutation_id` throws, and the directory at the path is still empty afterwards | R3 |
| Unsearchable cockpit directory (skipped as root): the health and route checks above, with `EACCES` | R1, R2, R4 |
| No `attempts.jsonl` at all: reads as `[]`, health leaves it out of `files` | R1, R4 (green before and after) |
| Existing torn-line tests in `sidecar.test.mjs` stay green, unchanged | R6 |
| `npm test` with `node_modules` absent: all pass, count rises | rule 5 |
| Live, on a `/tmp/learn` copy on port 4320: replace `attempts.jsonl` with a directory; `curl /api/health` → 200 naming it under `degraded` (manual) | R5 end to end |

## Open questions

- Intent's open question (500 on every route vs render empty): **answered.** James accepted
  the intent as proposed on 2026-11-12, so a damaged read answers 500 (R2).
- None raised here. The three flagged concerns were resolved by James on 2026-11-12.
