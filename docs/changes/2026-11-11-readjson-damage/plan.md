---
change: 2026-11-11-readjson-damage
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
accepted_by: james
linear: pending
---
# Plan: readJsonSafe reports damage, not "missing"

## Files that change

- **`app/lib/atomic.mjs`:** `readJsonSafe`'s body becomes one call to `readJsonValidated`
  with `ACCEPT_ANY`. The `:145-149` separation note and the `readJsonSafe` doc comment are
  rewritten (spec concern 3). No write-path function changes (R8).
- **`app/lib/sidecar.mjs`:** `inspectSidecars`'s JSON loop drops its `existsSync` pre-filter
  and skips on `source === 'missing'` instead (R6).
- **`app/test/atomiccharacter.test.mjs`:** the `:47` assertion flips, and the header is
  rewritten (concern 3). It gains the ENOTDIR, EACCES and EISDIR cases (A2 to A4).
- **`app/test/sidecar.test.mjs`:** gains A7.
- **`app/test/videogeneration.test.mjs`** and **`app/test/higgsfield.test.mjs`:** each
  gains A8, with its null control.

`atomicvalidated.test.mjs`, `videogeneration.mjs`, `higgsfield.mjs` and `restore.mjs` do
not change.

## Order of work

Each behaviour gets a red commit that records the failing run, then a green commit. A
case that passes on arrival is kept only as a guard, and its commit says so.

1. **Red: the characterization flip (A1).** Rename and rewrite
   `atomiccharacter.test.mjs:47` to expect `fallback` with
   `/^primary missing; backup unusable:/`. Rewrite the file header: renderer-foundations
   pinned this case on purpose, and readjson-damage moves it on purpose (James,
   2026-11-11). Run it and record 1 failing. Commit `test(atomic): ... red`.
2. **Red: unreadable primaries (A2, A3).**
   - A2: create `<dir>/notadir` as a regular file and read `<dir>/notadir/data.json`.
     Expect `fallback` with `code: 'ENOTDIR'`.
   - A3: put `data.json` in a subdirectory, `chmod 000` the subdirectory, read, then
     restore `0o700` in `finally`. Use `{ skip: process.getuid?.() === 0 && 'root ignores
     directory permissions' }`. Expect `fallback` with `code: 'EACCES'`.
   - A4 (guard): a directory at the path beside a good `.bak` gives `backup`. This passes
     today, and the commit says it is a guard.
   - Record A2 and A3 as failing. Commit.
3. **Red: the callers' boundary (A7, A8).** These pin what the cockpit reports, not what
   the function returns.
   - A7: in `sidecar.test.mjs`, write cards twice so a `.bak` exists, remove `cards.json`,
     and write `{` to `cards.json.bak`. Expect `inspectSidecars(SLUG).degraded` to contain
     `cards.json`.
   - A8: in each of `videogeneration.test.mjs` and `higgsfield.test.mjs`, write `{` to a
     job's `.bak` with no primary (`<workDir>/<uuid>/job.json.bak` and `<dir>/<uuid>.json.bak`).
     Expect `get(uuid)` to throw with `status: 500`. The control is a second uuid with
     neither file, where `get` returns `null`.
   - All three fail against `origin/main`'s reader, because it returns `missing`, then
     `null`, then not degraded. Record the run. Commit.
4. **Green: the shared core (R1 to R5).** `readJsonSafe` calls `readJsonValidated` with
   `ACCEPT_ANY`. Rewrite the two comments. Run the atomic, sidecar, video and Higgsfield
   files: A1 to A4, A7 and A8 pass, and every existing case is unchanged. `git diff` must
   not list `atomicvalidated.test.mjs`. Commit `fix(atomic): ...` with the run.
5. **Red, then green: the pre-filter (R6, A7b).** A7 can't reach the pre-filter, because a
   `.bak` makes `existsSync` true. The case that does is a cockpit directory that can't be
   stat'd: write `cards.json`, `chmod 000` the topic's `cockpit/`, and expect `cards.json`
   in `degraded`. Restore `0o700` in `finally`, and skip under root. After step 4 it's
   still red, because the reader would report EACCES but the pre-filter skips the file
   first. Drop the pre-filter and record green. Two commits.
6. **Full suite.** `rm -rf node_modules`, `npm test`. Record the count, which must be 912
   plus the new cases, with 0 failing.
7. **Live probe (A11).** Copy `.learn/topics/.` to `/tmp/learn`. Start the cockpit with
   `STUDYDECK_LEARN_ROOT=/tmp/learn` and a config copy on port 4320. Remove one topic's
   `cards.json` and write `{` to its `.bak`. `curl -s localhost:4320/api/health` must list
   `cards.json` in that topic's `degraded`. Restore the `.bak`, curl again, and it should
   clear. Stop the server. Record both responses' relevant fields in Proof.
8. **Gates.** `security-review` (a Sonnet subagent, read-only, on `git diff origin/main`).
   Codex until `NO_FINDINGS`. Open the PR with `forge-pr create`, and post each Codex run
   verbatim with `GATE: PASS` or `GATE: FAIL`. Wait for CI and James's "Merge and clean".

## Deviations from the spec

- **One extra acceptance case, for R6.** The spec's A7 (missing primary, corrupt `.bak`)
  goes green from the reader change alone, because the old pre-filter already admitted any
  file with a `.bak`. A7 doesn't pin R6. Step 5's unreadable cockpit directory does: it is
  the only case where `existsSync` says no to both copies while the files may exist. That
  case is added here as A7b.
- **inspectSidecars on an unreadable directory may throw before it reaches the JSON loop.**
  Step 5 finds out. If `readJsonlDetailed` or the temp-file scan throws on EACCES, that
  is recorded here and handled in the narrowest way that keeps the JSON report: the
  JSONL readers themselves stay out of scope.

## Risks

- **Permission tests on CI.** The forge runner may run as root, which skips A3 and A7b.
  A2 (ENOTDIR) is the root-proof case that guarantees the reader change is still
  exercised there. The CI log is checked for the skip notice so a skip isn't mistaken
  for a pass.
- **A `chmod 000` left behind breaks the temp cleanup.** Every such test restores the
  mode in `finally`, before the `after` hook's `rmSync`.
- **One damaged job blocks the video and Higgsfield lists (security review, low).** Each
  `list()` maps `get` over every entry, and each `start()` calls `list()` first, so one
  job whose `get` throws makes the list route and every new job answer 500. `main` already
  did this for a corrupt primary. This slice adds three more triggers: a missing file
  beside a bad `.bak`, an unreadable job directory, and a non-file at the path. Each one
  needs manual damage on this machine. James (2026-11-11) chose a follow-up slice, in
  which `list()` flags a damaged entry and keeps going.
- **The message text is now part of the contract.** A1 matches only the
  `primary missing; backup unusable:` prefix, not the OS's wording after it.

## Proof

### Red, then green, 2026-11-11

| Step | Commit | Run |
|---|---|---|
| 1 red (A1) | `0e0915b` | atomiccharacter 9 tests, 1 fail: source `missing`, expected `fallback` |
| 2 red (A2, A3, A4 guard) | `c3d1c06` | atomiccharacter 12 tests, 3 fail: ENOTDIR and EACCES both read `missing`. The guard passed on arrival. |
| 3 red (A7, A8) | `60908e7` | sidecar 14/1 fail (`degraded` was `[]`), video 4/1 and Higgsfield 3/1 (missing expected exception) |
| 4 green (R1 to R5) | `f6c27df` | atomiccharacter 12/12, atomic 11/11, atomicvalidated 9/9 (file unchanged), sidecar 14/14, video 4/4, Higgsfield 3/3, restore 15/15 |
| 5 red (A7b) | `d536c87` | sidecar 15/1 fail: `degraded` was `[]` with the reader already fixed |
| 5 green (R6) | `89305c6` | sidecar 15/15, attempts 12/12, atomiccharacter 12/12, atomic 11/11, restore 15/15 |

The plan's possible blocker didn't occur. With `cockpit/` at mode 000, the temp-file and
JSONL scans didn't throw, so `inspectSidecars` reached the JSON loop unchanged.

### Full suite, 2026-11-11

`node_modules` absent (`ls: node_modules: No such file or directory`), then `npm test`:
**tests 919, pass 919, fail 0, skipped 0** (912 on `main`, plus 7 new cases; A1 rewrites an
existing case). On this macOS run, nothing ran as root, so A3 and A7b executed rather
than skipped.

### Live probe (A11), 2026-11-11

The cockpit was served from this branch on 127.0.0.1:4320, with
`STUDYDECK_LEARN_ROOT=/tmp/learn` (a fresh copy of `.learn/topics/.`) and a config copy
whose `server.port` is 4320. Results from `practical-deep-learning-fastai` in
`GET /api/health`:

- Before: `degraded: []`, and `cards.json` is `source: primary`.
- After removing `cards.json` and writing `{` to `cards.json.bak`: `degraded: ["cards.json"]`,
  `source: fallback`, `error: "primary missing; backup unusable: Expected property name or
  '}' in JSON at position 1 (line 1 column 2)"`.
- After restoring both files: `degraded: []`, and `cards.json` is `source: primary` again.

The server was stopped afterwards, and the real `.learn` tree and James's 4310 cockpit
weren't touched. The first start attempt set a top-level `port` by mistake, so the server
tried 4310, found it in use, and exited without binding.
