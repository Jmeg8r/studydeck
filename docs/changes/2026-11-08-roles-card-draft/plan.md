---
change: 2026-11-08-roles-card-draft
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: the local model can draft a session card's answer side

The feature was built on 2026-10-13 as `a0aacdb` and rebased onto `main` as `77c3140`, then rebuilt from `origin/main` as planned below.
This plan rebuilds the branch so history reads artifacts → failing tests → code, and adds
R7, R11 and R12, which the original commit lacked or got partly wrong.

## Files that change

| File | Change |
|---|---|
| `app/lib/ollama.mjs` | `draftCardBack` (from `77c3140`, unchanged) |
| `app/lib/sessions.mjs` | `BACK_ORIGINS`, `cardSource`, `draftSessionCard` (from `77c3140`), plus `grounded` / `ungrounded_reason` mapped from `excerptsFor`'s `status` (new, R7) |
| `app/router.mjs` | the `card-draft` route before `mutationId`; `back_origin` on `/cards` (from `77c3140`) |
| `app/web/js/views/roles.mjs` | `nextBackOrigin`, the draft tools strip (from `77c3140`), plus the per-reason notes in spec's Design table (new) |
| `app/web/css/app.css` | `.roles-card-tools`, `.roles-ai-note`, `.q-input.locked` (from `77c3140`) |
| `app/test/rolesessions.test.mjs` | six draft / origin tests (from `77c3140`) plus A5's grounded test (new) |
| `app/test/rolesview.test.mjs` | `nextBackOrigin` test (from `77c3140`) |
| `README.md` | Roles paragraph (from `77c3140`), mentioning drafts made without sources (new) |
| `docs/changes/2026-10-11-ai-roles/spec.md` | R14 amendment (new, R11) |
| `docs/changes/2026-10-11-ai-roles/plan.md` | the R14 Deviations bullet only. `77c3140`'s second bullet, about the health and cache fixes, is dropped: that work belongs to `2026-11-08-roles-cost-and-health` |

## Order of work

1. Build a fresh branch at `origin/main`. Carry over the intent draft and accept commits,
   then the spec draft, spec accept and this plan. → verify: `git log --oneline` lists
   them in that order, with no code.
2. **Tests commit** (`test(roles): …`). Apply only `77c3140`'s `app/test/` hunks with
   `git show 77c3140 -- app/test | git apply -3`, never `git checkout <c> -- file`
   (lessons: that silently reverted `main` work once). Add A5. → verify: `npm test`
   fails, and the failures are exactly the new cases plus the `rolesview` import of
   `nextBackOrigin`.
3. **Feature commit** (`feat(roles): …`). Apply the rest of `77c3140` the same way,
   minus the dropped plan bullet, then add R7 in `sessions.mjs` and the view's notes. →
   verify: `npm test` passes. Each applied file's `--numstat` matches `77c3140`'s, give
   or take the new lines.
4. **Docs commit** (`docs(roles): …`). Covers the R14 amendment, the ai-roles Deviations
   bullet, and the README sentence. → verify: A11's grep.
5. VERIFY (Proof below). Then push, open a forge PR, run Codex, post its verdict
   verbatim, and wait for CI and the gate.

## Risks

- **Rebuilding from a commit could undo newer `main` changes.** Mitigation: apply hunks
  with `apply -3` and compare numstats, never copy whole files.
- **The tests commit fails on purpose.** Lefthook runs tests at pre-push only, and CI runs
  on the PR head, so nothing blocks it. Don't push between steps 2 and 3.
- **A live draft takes up to a minute on the local model.** The view already says so.
  A10 may need patience, not a fix.
- **A10 writes a card.** It runs against `/tmp/learn` only (CLAUDE.md: drive mutations
  against a copy).

## Proof

- `npm test`, with `node_modules` confirmed absent (`ls node_modules` errors): all pass,
  including A1–A7.
- On the tests-only commit: `npm test` shows the new cases failing (A8). The output goes
  in the PR body.
- `npm run verify` is clean; `snyk test` shows 0 issues.
- A10:

  ```
  rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/
  STUDYDECK_LEARN_ROOT=/tmp/learn node -e "import('./app/router.mjs').then(({handleRequest}) => require('node:http').createServer(handleRequest).listen(4399, '127.0.0.1'))"
  ```

  Drive the Roles view at `127.0.0.1:4399` on a closed session whose transcript exists
  on this machine. Read `back_origin` back from `/tmp/learn/<topic>/cockpit/cards.json`,
  and take screenshots in both themes. If no closed session with a transcript exists,
  say so and record A10 as not run.
- A11: `grep -n "Amended 2026-11-08" docs/changes/2026-10-11-ai-roles/spec.md` and
  `grep -n "roles-card-draft" docs/changes/2026-10-11-ai-roles/plan.md` each print a
  line.

## Options not taken

- **Keep `77c3140` as one commit and add docs on top.** Rejected: the failing test has to
  be committed before the code, and the branch has never been pushed, so rebuilding it
  costs nothing.
- **A 503 when ON is down.** Rejected per spec Flagged concern 2: that would block a
  labelled draft that does not need ON.
- **Draft with the Claude API.** Rejected: a closed session spends nothing (intent
  Constraints).
- **Record drafts server-side so `back_origin` can be checked.** Out of scope per intent:
  it would store a draft that may never become a card.

## Deviations

- **Step 2: a missing control.** On the tests-only commit, `77c3140`'s "a draft is not a
  card" test passed against the unfixed code. It checked that nothing was stored but
  never that the draft succeeded, so a 404 also passed it. It now asserts the draft's
  200 first (testing.md: every nothing-was-stored assertion carries a control). After
  that, all 8 new cases fail on the tests-only commit and the 490 existing ones pass.
- **Step 3: a second test commit.** The plan had one tests commit. The view's
  per-reason note became a pure function, `draftNote`, and its test went in a commit of
  its own just before the feature, seen failing on the missing export. The feature hunks
  from `77c3140` applied with numstats identical to the original (ollama 32/0, sessions
  32/0, router 14/2, css 4/0, roles view 63/4) before R7 was added.
- **Step 5 (A10): two problems the live run found.** On the real local model with the
  real excerpts, the first draft hit the 5-minute timeout, and its error said "Grade this
  in a Claude session instead". That was `chat()`'s grading fallback, appended to every
  failure.
  - The error is fixed: `chat()` takes a `hint`, and a draft passes "Write the answer
    yourself, or try again."
  - The time is fixed by sending `think: false` for drafts only. Each setup was timed
    once on `gemma4:31b-mlx` with 18 excerpts (4,300 prompt tokens), model idle:
    129.8 s with thinking (2,478 output tokens), 17.8 s without (43 tokens).
    `qwen3-coder:30b` took 6.5 s but drifted from the source, so the configured model
    stays.
  - Both fixes landed test-first.
- **After Codex round 1 on PR 119 (P2 and P3, gate PASS, both fixed).**
  - **P2:** the draft ignored an edited Front and could pair a new question with an
    answer to the old one. The request now carries `front`, the server drafts against
    it, and a blank one falls back to the transcript question.
  - **P3:** `collectSources` refuses an empty notebook with a plain 400, which
    `excerptsFor` reported as `unavailable`. It now counts it as 0 sources and keeps
    `unavailable` for an `OpenNotebookError` or a failed fetch. This also corrects the
    `excerpts` value a new session's header records for an empty notebook. Both fixes
    landed test-first.
  - A test added afterwards for the blank-Front fallback failed at the route even with
    the fallback in place. `assertString` defaults to `min: 1`, so the router refused a
    cleared Front with a 400 before `draftSessionCard` ran. The route now allows
    `min: 0`.
- **After Codex round 2 (one P2, gate PASS, fixed).** Both fields stayed editable while a
  draft was in flight, so a Front edited mid-draft got an answer to the old question.
  The Front, the Back and Edit the draft are now held read-only for the request. The
  Front is released when it returns, and on failure the Back goes back to its prior
  lock state. There is no DOM in the suite, so this was checked live on port 4399:
  - during the draft: Front and Back read-only, Edit and Draft disabled
  - after it: Front editable, Back locked with the draft, Edit focused

  The failure path was not driven live: that needed the local model stopped.
- **After Codex round 3 (P2 and P3, gate PASS, both fixed).**
  - **P2:** Create cards could save a row whose replacement draft was still pending. A
    row now carries `drafting`, and Create refuses with "Wait for the AI draft to finish
    before creating cards." The button's own disabled state is left alone, because
    Create already toggles it while it submits.
  - **P3:** a cleared Front stayed blank after a draft. It is now filled from the
    `result.front` the server answered against.

  Checked live, with no DOM in the suite. A mid-draft Create showed the message and
  saved no card. After the draft, the cleared Front held the transcript question and
  the Back held the draft. That draft took about 50 s; the model had just reloaded.
