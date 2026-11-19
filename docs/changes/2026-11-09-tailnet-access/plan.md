---
change: 2026-11-09-tailnet-access
status: accepted
track: T3
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: the cockpit answers James over his tailnet, and no one else

## Files that change

- `app/test/guard.test.mjs`: tailnet cases (A1, A2, A4).
- `app/test/config.test.mjs` (new, or the existing config tests if present):
  `parseTailnet` cases and the child-process boot check (A3).
- `app/lib/config.mjs`: `parseTailnet(env)`, `config.tailnet`, the summary field.
- `app/lib/guard.mjs`: the second door, read from `config.tailnet` at call time.
- `app/server.mjs`: only if the summary line is printed field by field.
- `CLAUDE.md`: hard rule 12.

## Order of work

1. **Commit 1, tests only** (`test(guard): ...`). Write A1 to A4 against `main`'s code and
   record the run: every case that needs the tailnet door must fail (403 or a missing
   `parseTailnet` export), and every loopback case must pass.
2. **Commit 2, the fix** (`feat(guard): ...`): `config.mjs`, then `guard.mjs`, then the
   summary. Run `node --test app/test/guard.test.mjs app/test/config*.test.mjs`, then
   `npm test`.
3. **Commit 3, rule 12** (`docs(claude): ...`). Separate, so the gate's standards change
   is reviewable on its own.
4. **Code-stage policy** (spec concern 1): run `/security-review` on the branch, and the
   T3 adversarial review (`/doubt-driven-development` or a pstack panel) on the diff with
   the spec as the claim under test. Each finding is fixed under a test or answered here.
5. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI-review gate, James's merge approval.
6. **Live** (after James fast-forwards and restarts): A6, then A7. A7 is a hard condition
   (spec concern 2). If A6 answers 403 for the `Host` form, stop and open the widening as
   its own change (concern 3).

## Risks

- **Config throws at import.** Every test imports `config.mjs`; a test environment that
  happens to export one of the two variables would fail the whole suite. Tests that need
  the door set `config.tailnet` directly, and the boot check runs in a child process with
  an explicit environment.
- **The LaunchAgent sets both variables already**, so the first restart after the merge
  turns the door on. If its origin value is malformed the cockpit will not start; the
  stderr log then says why (R7) and the cockpit comes back as before once the value is
  fixed or removed. Check the shape before the restart, without printing it.
- **Node's `http` lowercases header names**, so `req.headers['tailscale-user-login']` is
  the right key regardless of how Serve spells it.

## Proof

- **Commit 1** (`2474956`): 9 tailnet cases failed against `main`, every loopback case
  passed.
- **Commit 2** (`5473514`): the guard and config tests, 28 pass; `npm test` 527 pass, 0 fail,
  no `node_modules`.
- **`/security-review`** (fresh Sonnet reviewer): no finding at confidence 8 or above. It
  checked absolute-form targets, Host quirks, duplicate headers, CSRF, other tailnet users,
  loopback regression and data exposure.
- **T3 adversarial review** (fresh Sonnet reviewer, `spec.md` as the claim under test): no
  blockers. It mutation-checked the tests: a port-less Host match, a case-sensitive Host
  match, a GET-exempt user check and an `http://` Origin each fail at least one test.
  Findings and resolutions:
  1. *Should-fix, reproduced.* `handleRequest` parsed `req.url` before its `try`, so
     `GET http://[/` was an unhandled rejection reached ahead of the guard. It predates this
     change, but the tailnet now reaches it (Serve's proxy may reject such targets first;
     not confirmed). **Fixed** under a test (`f7966ad` red, `2e60a6c` green): the target is
     parsed after the guard and answers 400.
  2. *Should-fix, reproduced.* `parseTailnet` accepted a loopback origin, which would make
     the local page need the tailnet header (fails closed, breaks R5). **Fixed** under a
     test: boot refuses it. `LOOPBACK_HOSTNAMES` moved to `config.mjs` so both modules read
     one list.
  3. *Note.* A bare trailing `?` or `#` in the origin passes, because `URL` reports both as
     empty. It normalises to the same origin; **left as is**.
  4. *Note.* The user comparison is case-sensitive and fails closed. Deliberate (pinned by
     the uppercase case); the deploy check below compares the configured value with what
     Serve sends.
  5. *Note.* Funnel would reach the same Host. **Checked** on 2026-11-09:
     `tailscale funnel status` lists `:4310` as tailnet only. A7 is run with that state.
  6. *Note.* No test pins the `127.0.0.1` bind (R6) or the boot print line. The bind is
     unchanged and comes from the committed config; **left as is**, recorded here.
  7. *Note.* Upgrade, duplicate `Tailscale-User-Login` (joined as `a, a`, refused) and
     `CONNECT` probes were clean.
  - After the fixes: guard and config tests 30 pass; `npm test` 529 pass, 0 fail, no
    `node_modules`.
- **PR #124:** Codex `NO_FINDINGS`, GATE: PASS (comment 30602; the prompt held 18 hunks
  over 10 files and no binary stubs). AI-review gate PASS with 0 findings (run 153). CI green
  on Node 22 and 24. `forge-pr status` SAFE. Merged as `aae4d0e` with James's approval.
- **Before the restart:** the LaunchAgent's two values pass `parseTailnet`, and its user
  equals the node owner's Tailscale login exactly, case included. Neither value was printed.
- **Live run, 2026-11-09, after James fast-forwarded and restarted** (`T` is
  `https://<machine>.<tailnet>.ts.net:4310`):
  - Boot log: `tailnet: <machine>.<tailnet>.ts.net:4310`.
  - Loopback: `curl http://127.0.0.1:4310/api/health` → 200 (R5).
  - **A6:** `curl $T/api/health` → 200, body `{"status":"ok",...,"tailnet":"<machine>.<tailnet>.ts.net:4310",...}`.
    Before the change the same request answered 403 `this server answers only to a loopback Host`.
    Serve kept the port in `Host`, so concern 3's widening is not needed.
  - **A7:** `curl -H 'Tailscale-User-Login: someone-else@example.com' $T/api/health` → 200.
    A forged `POST $T/api/reading` with that header, the tailnet `Origin` and JSON → 400
    `a known topic_slug is required`, i.e. admitted to routing.
  - **A7 control:** the same forged header sent straight to `127.0.0.1:4310` with the
    tailnet `Host` → 403 `this tailnet user is not allowed`. The guard refuses that user
    whenever the value reaches it, so the 200 above means Serve replaced the forged header
    with James's own login: answered as James, never admitted as the forged user. A7 holds.
  - `tailscale funnel status` lists `:4310` as tailnet only.

## Options not taken

- **Cherry-pick the snapshot's `guard.mjs`.** It reads the environment into a module
  constant at import, which its own tests could not vary; and it would bring `#98`'s
  unrelated `config.mjs` TTS override with it.
- **Bind to the Tailscale interface instead of loopback.** Removes Serve from the path,
  but then any tailnet device reaches the port directly and can forge the identity header
  (Tailscale's own warning for header-based identity).
- **Accept the tailnet `Host` without the user check.** Would admit every device and user
  on the tailnet, including shared nodes.

## Deviations

- **One test case replaced (commit 2).** Commit 1's user-refusal test included
  `Tailscale-User-Login: <user> ` with a trailing space as a near miss. HTTP strips
  surrounding whitespace from header values before Node sees them, so that request carried
  the right user and was correctly admitted. The case is replaced with
  `<user>.evil.example`, a real near miss; the guard was not changed to make it pass.
