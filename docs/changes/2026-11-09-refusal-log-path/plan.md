---
change: 2026-11-09-refusal-log-path
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a refused request's log line names its path again

## Files that change

- `app/test/guard.test.mjs`: one test that captures `console.warn`.
- `app/router.mjs`: the catch in `handleRequest` works out the path it logs.

## Order of work

1. **Commit 1, test only** (`test(guard): ...`). Capture `console.warn` while sending a
   rebound-Host `GET /api/state` (refused, 403) and a malformed target `GET http://[/`
   from loopback (400). Assert the first warning names `/api/state` and the second names
   `(unparsed)`. Against `main` the first assertion must fail (`(unparsed)` is logged)
   and the second must pass.
2. **Commit 2, the fix** (`fix(router): ...`). In the catch, when `url` was never set,
   parse `req.url` again inside a `try` purely for the log, falling back to `(unparsed)`.
   The handler's flow and every response stay as they are; only the log text changes.
   Run the guard tests, then `npm test` with no `node_modules`.
3. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI-review gate, James's merge approval. Then James fast-forwards and restarts, and a
   refused request is checked in `stderr.log`.

## Why log `pathname` and nothing else

`URL` strips tab, CR and LF from a path and percent-encodes the other control characters
(checked: `/a\rb\x1bc d` becomes `/ab%1Bc%20d`), so a hostile target cannot forge a second
log line, and `pathname` leaves out the query string, which can carry data
(`/api/state?date=`). That is the same field the line logged before #124.

## Options not taken

- **Parse before the guard again, inside the `try`.** Restores the log too, but puts
  parsing ahead of the boundary check once more; #124 moved it on purpose.
- **Log the raw `req.url`.** Includes the query string and whatever bytes a caller sent.

## Proof

- **Commit 1** (`fa114c1`): failed against `main` on its first assertion, as described:
  `actual: '[server] GET (unparsed) → 403: this server answers only to a loopback Host'`.
- **Commit 2** (`3026b8a`): guard tests 24 pass; `npm test` 530 pass, 0 fail, no
  `node_modules`.
- **PR #126:** Codex `NO_FINDINGS`, GATE: PASS (comment 30622; the prompt held 5 hunks
  over 4 files and no binary stubs). AI-review gate PASS with 0 findings (run 163). CI green
  on Node 22 and 24. `forge-pr status` SAFE. Merged as `d2d6e3d` with James's approval.
- **Live run, 2026-11-09, after James fast-forwarded and restarted** (node started
  14:44:38): `curl -H 'Host: rebind.example' 'http://127.0.0.1:4310/api/state?date=2026-01-01'`
  → 403, and `stderr.log` logged
  `[server] GET /api/state → 403: this server answers only to a loopback Host`: the path
  is back and the query string is not in the line. `/api/health` answered 200 on loopback
  and over the tailnet.

## Deviations
