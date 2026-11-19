---
change: 2026-11-12-jsonl-damage
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
accepted_by: james
linear: pending
---
# Plan: the JSONL readers report damage, not empty history

## Files that change

- **`app/lib/sidecar.mjs`** (spec R1–R4):
  - A private `jsonlDamage(name, err)` beside `readJsonlDetailed`. It builds
    `Error('<name> is unreadable (<code>)')` with `status: 500`, `code`, `file: name`, and
    `cause: err`. `<name>` is the cockpit-relative name the caller passed
    (`attempts.jsonl`, `transcripts/<id>.jsonl`), so no absolute path is in the message.
  - `readJsonlDetailed` drops `existsSync`, reads inside `try`, returns
    `{ rows: [], skipped: 0, missing: true }` on ENOENT, and on any other code logs the
    full error once (`console.error`, path included) and throws `jsonlDamage`.
  - `inspectSidecars`'s JSONL loop drops `existsSync`, catches an error that carries
    `file` and lists `{ file, source: 'fallback', error, code }`, rethrows anything else,
    and skips a result with `missing: true`.
  - `appendUnique`: no code change. One comment line says the replay read must stay
    before `appendLineSync` (rule 9, spec R3).
  - `existsSync` stays imported only if another use remains; otherwise the import goes.
- **`app/test/sidecar.test.mjs`**: unit tests for R1, R3 and R4 (below).
- **`app/test/jsonldamageroutes.test.mjs`** (new): the route checks through
  `handleRequest`, set up as `jobdamageroutes.test.mjs` is (env vars before the dynamic
  `router.mjs` import, an ephemeral `127.0.0.1` port, the temp root removed in `after`,
  ON pointed at a socket this file owns and hangs up on). It writes the minimal deck that
  `POST /api/attempts` needs, modelled on `routes.test.mjs`'s `route-fixture-quiz.json`.
- **This plan**: run results under `## Results`, and any departure under `## Deviations`.

## Order of work

Each red commit runs and fails before the commit that turns it green.

1. **Red, unit (`sidecar.test.mjs`):**
   - A directory at `attempts.jsonl`: `readAttempts` throws with `status: 500`,
     `code: 'EISDIR'`, message `attempts.jsonl is unreadable (EISDIR)` and no `/` in it.
     Today it throws the raw `EISDIR` error, so it fails on the message and status.
   - Same damage: `inspectSidecars` returns without throwing and lists `attempts.jsonl`
     in `degraded` with `code: 'EISDIR'`. Today it throws.
   - Same damage: `appendAttempt` with a `mutation_id` throws and the directory at the
     path is still empty. (Green today by luck of ordering; committed with the red set as
     the pin for R3.)
   - Unsearchable cockpit directory, skipped as root: `readAttempts` throws `EACCES`
     instead of returning `[]`, and `inspectSidecars` lists `attempts.jsonl` as degraded.
     Today both read as empty.
   - Control, green before and after: no `attempts.jsonl` reads as `[]` and is absent from
     `files`.
2. **Red, routes (`jsonldamageroutes.test.mjs`)**, directory at `attempts.jsonl` in one
   topic:
   - `GET /api/health` → 200, that topic's `degraded` includes `attempts.jsonl`.
   - `GET /api/state` → 200, the topic is listed under `unavailable_topics` with error
     `attempts.jsonl is unreadable (EISDIR)`, and the other topics still build. (`buildState`
     already isolates each topic; this pins the message reaching the browser.)
   - `POST /api/attempts` with a `mutation_id` → 500, body
     `{ error: 'attempts.jsonl is unreadable (EISDIR)' }`, and no line written.
3. **Green:** the `sidecar.mjs` change above. Full suite.
4. **VERIFY:** `npm test` with `node_modules` moved aside; the live probe; Codex review;
   `security-review` on the diff. Record each in `## Results`.

## Risks

- **The five ON `try` blocks in `router.mjs`** (`:283`, `:408`, `:474`, `:520`, `:1441`)
  can now catch a damage error from a sidecar read (spec concern 1, accepted). Before the
  green commit, read each and confirm the revision append in its `catch` throws on the
  same damage rather than recording a classification. List what was found in `## Results`.
- **A caller that relied on `existsSync`'s silence.** Every `read*` export now throws on
  damage. `buildState` catches per topic; other callers propagate to the top-level 500,
  as accepted. The full suite is the check that no caller depended on the old empty read.
- **Transcripts** use a nested name (`transcripts/<id>.jsonl`). A session id that was
  never written must still read as `[]` (ENOENT on the file, or on the `transcripts/`
  directory). Covered by the existing `rolesessions` tests staying green.

## Proof

- `npm test` → all pass, count up by the new cases; same with `node_modules` absent.
- `git log --oneline` shows each red commit before the green one.
- Live, against a copy:
  `rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/`, a copy
  of `app/cockpit.config.json` with `server.port: 4320` passed via
  `STUDYDECK_CONFIG_PATH`, `STUDYDECK_LEARN_ROOT=/tmp/learn node app/server.mjs`; replace
  `/tmp/learn/<slug>/cockpit/attempts.jsonl` with a directory;
  `curl -s localhost:4320/api/health` → 200 naming `attempts.jsonl` under `degraded`;
  `curl -s localhost:4320/api/state` → 200 with the topic under `unavailable_topics`.
- Codex review posted verbatim on the PR with PASS/FAIL; `forge-pr status` green.

## Options not taken

- **Empty rows plus a log line for read-only views.** Rejected by James at intent
  acceptance: an empty view is how this damage stayed hidden.
- **A shared JSONL reader in `atomic.mjs`.** Only `sidecar.mjs` reads JSONL; a helper
  there is the smaller change.
- **Catching damage in `appendUnique`** and returning a flag. It must stop the append, and
  a throw already does.

## Results

- **Red first.** `e21b05e` (unit): 3 of 5 new cases failed as predicted, with the raw
  `EISDIR` message, `inspectSidecars` throwing, and the unsearchable directory reading as
  empty (nothing thrown). The append pin and the never-written control passed, as planned.
  `20cb098` (routes): all 3 failed. `/api/health` answered 500, and `/api/state` and
  `POST /api/attempts` carried `EISDIR: illegal operation on a directory, read`.
- **Green.** `a7f5d2e`: `npm test` 945 pass, 0 fail, 0 skipped (937 before, plus 8). The
  repo has no `node_modules`, so this is also the rule 5 run. `npm run verify`: no damage.
- **The five ON `try` blocks** (`router.mjs` `:283`, `:408`, `:474`, `:520`, `:1441`). Each
  appends a `prepared` revision through `appendUnique` before its `try`, and every revise
  helper carries a `mutation_id`, so the replay read runs and throws on a damaged
  `operations.jsonl` before any Open Notebook call. Only a file damaged mid-request reaches
  a `catch`. There the revision append throws again and the request ends as a 500, with
  `prepared` as the last recorded stage, which recovery already treats as unconfirmed. No
  wrong classification can be written. No code change needed.
- **Live probe** (2026-11-12) on a `/tmp/learn` copy, port 4320 through `server.port` in a
  config copy, with `practical-deep-learning-fastai/cockpit/attempts.jsonl` replaced by a
  directory. `/api/health` → 200, `status: degraded`, that topic's `degraded` is
  `["attempts.jsonl"]` with `code: EISDIR` and the short message. `/api/state` → 200 with
  that topic under `unavailable_topics` and the other two topics built. The server log
  carried the full error with the path; no response did.
- **Pending:** Codex review and `security-review` on the PR.
