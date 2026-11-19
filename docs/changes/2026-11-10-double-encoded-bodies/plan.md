---
change: 2026-11-10-double-encoded-bodies
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: Test Center and the Reading Room can save again

## Files that change

- `app/web/js/api.mjs`: `requestJson` throws a `TypeError` for a string `body`, before
  calling `fetch`.
- `app/web/js/views/testcenter.mjs`, `app/web/js/views/reading.mjs`: the four call sites
  pass the object, not `JSON.stringify(...)`, and drop the `content-type` header that
  `requestJson` already sets.
- `app/test/api.test.mjs`: the guard test.
- `app/test/browser-request-body-contract.test.mjs` (new, from the snapshot): a source
  scan that fails on any `body: JSON.stringify(` under `app/web/js/` outside `api.mjs`.

## Why two tests

The guard pins the boundary at run time: whatever a caller does, a string body never
reaches the server. But it fires only when a learner clicks, so on its own a regression
would still ship. The source scan fails in CI. The scan is a text match, so it can't see a
string built elsewhere and passed in; the guard covers that case.

## Order of work

1. **Commit 1, tests only** (`test(api): ...`). Against `main` both must fail: the guard
   test because `fetch` is called with a twice-encoded body, and the scan because it lists
   the four call sites. The red run goes in the commit message.
2. **Commit 2, the fix** (`fix(cockpit): ...`): the guard and the four call sites. Then
   `npm test` with no `node_modules`, and `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy, Open Notebook pointed at a dead port:
   - Test Center submit: one new line in `attempts.jsonl`, and the results screen shows.
   - Finalize, if the deck has self-checked items: the next revision is appended.
     Otherwise this is recorded as not exercised.
   - Reading Room scroll: `reading.json` gains the position.
   - Save highlight: a 503 naming Open Notebook instead of a 400, and no note written.
4. PR through `forge-pr create`, then `/gstack-codex review origin/main` posted verbatim,
   then the AI gate, then James's merge approval.

## Risks

- **A caller that sends a string on purpose.** None does today: the four above are every
  `body: JSON.stringify(` under `app/web/js/`. The guard makes a future one fail loudly.

## Proof

- **Commit 1** (`f1db56d`): against `main` (`99b780e`), with no `node_modules`, the api and
  contract tests run 7: 5 pass, 2 fail. The guard test fails with "Missing expected
  rejection". The scan lists `views/reading.mjs:79`, `views/reading.mjs:153`,
  `views/testcenter.mjs:186` and `views/testcenter.mjs:315`. The guard test carries a
  control: the same stub with an object body sends once.
- **Commit 2** (`978dcc0`): both pass. `npm test` 588 pass, 0 fail, no `node_modules`.
  `npm run verify` finds no damage.
- **Browser check**, 2026-11-10, the branch's router on port 4319 over a `/tmp/learn` copy:
  - **Test Center submit** (real UI, Retake, every question answered): `POST /api/attempts`
    sent an object body and was recorded. `attempts.jsonl` gained revision 0 of attempt
    `820b6e19…`, status `pending_self_grade`, and the results screen showed "Recorded".
  - **Finalize** (the deck has a self-check item, marked "I missed it"): revision 1,
    status `final`, then mastery `prepared` and `applied` once each.
  - **Reading position**: opening a source and scrolling sent `POST /api/reading` twice
    with object bodies, both 200. `reading.json` stored position 0.378 for that source.
  - **Save highlight**: the view handed `fetch` an object body (`topic_slug`, `title`,
    `content`, `mutation_id`). A stub answered 503, the popup showed it, and nothing
    reached Open Notebook.
  - Afterwards, `git status` on the real `.learn` was clean.

## Deviations

- **The Reading Room was checked against the real Open Notebook, read-only, with the
  highlight POST stubbed.** The plan pointed Open Notebook at a dead port for every step,
  but the Reading Room's source list and text come from Open Notebook, so with it down
  there is nothing to scroll or select. The router ran against the real Open Notebook for
  GETs only. The one write to it, Save highlight, was intercepted in the page and answered
  with a stubbed 503, so no note was created. That proves what the view sends, not that
  Open Notebook accepts it; the notes route's server side is covered by `noteegress.test.mjs`.
