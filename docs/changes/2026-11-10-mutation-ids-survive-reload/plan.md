---
change: 2026-11-10-mutation-ids-survive-reload
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: a retry after a reload keeps its mutation id

## Decision for James: what binds a restored id to its request

The intent says why the snapshot's version can't be ported alone: a restored id under a
content-free key like `attempt:<topic>:<deck>` makes first-wins dedupe swallow a new
retake. Three ways to close that:

1. **Bind the id to a fingerprint of the request (recommended).** Each saved entry holds
   the key, the id, and a SHA-256 of the request body without `mutation_id`. A later call
   under the same key reuses the id only if the fingerprint matches; otherwise it mints a
   new one. The answers themselves are never written to storage, only their hash.
2. **Port the snapshot whole.** Store the full request, refuse a different payload, and
   add the Recovery view to resolve it. Learner answers sit in `sessionStorage`, and the
   slice grows by a new view and its tests.
3. **Store ids as the snapshot does, without a check.** Smallest change, but it brings
   the swallowed-retake failure described in the intent.

James chose option 1 on 2026-11-10. The rest of this plan implements it.

## Files that change

- `app/web/js/mutation.mjs`: `sessionStorage` persistence and the fingerprint check.
- `app/web/js/api.mjs`: `requestJsonWithMutation` passes its body as the fingerprint
  source. That covers its 14 callers with no change to them.
- The 16 views that call `withMutationId` directly, each passing the object it sends as
  `payload`. A call without a payload is not saved and keeps today's in-memory behaviour,
  so the views can be wired one at a time and an unwired one is no worse than now.
- `app/test/mutation.test.mjs`: new tests.

## Design

- `withMutationId(key, send, { payload } = {})`. The signature only grows, so existing
  calls keep working.
- The fingerprint is a SHA-256 of the canonical JSON of `payload` (sorted keys,
  `mutation_id` removed), from `crypto.subtle`, which exists in browsers and in Node.
  The check-and-set on the map runs synchronously after that one `await`. Two concurrent
  calls under one key therefore still share an id, as the existing test requires.
- Storage key `studydeck.pending-intents.v1`, value `{ version: 1, intents: [{ key, id,
  fp, created }] }`, capped at the 50 newest entries. An entry is deleted on success, and
  `resetMutationId` deletes it too.
- If `sessionStorage` is missing, unreadable or full, the helper behaves as it does today
  (memory only) and calls `console.warn` once. That is a degradation to today's
  behaviour, not a silent loss of protection we have now.

## Order of work

1. **Commit 1, tests only** (`test(mutation): ...`). With a `Map`-backed `sessionStorage`
   stub and the module imported twice under different query strings, to simulate a
   reload:
   - a failed intent's id is reused after a reload when the payload is the same;
   - after a reload, a different payload under the same key gets a new id (the
     swallowed-retake case);
   - success removes the saved entry;
   - `resetMutationId` removes the saved entry;
   - storage that throws on write still yields a working id in memory.

   Run against `main`, the first test must fail. The red run goes in the commit message.
2. **Commit 2, the helper and `api.mjs`** (`fix(mutation): ...`). The existing mutation
   and api tests stay green.
3. **Commit 3, the views** (`fix(views): ...`): pass `payload` at the 16 direct call
   sites. Then run `npm test` with no `node_modules`, and `npm run verify`.
4. **Browser check** against a `/tmp/learn` copy:
   - Block `/api/attempts` after the server has written (DevTools offline, toggled
     between request and response), reload, and resubmit the same answers. Expect one
     attempt in `attempts.jsonl` and the original results returned.
   - Repeat with different answers after the reload. Expect a second attempt holding the
     new answers.
   - Run one Open Notebook-backed action (a reading highlight) with ON pointed at a dead
     port. Expect the 503 to keep the entry and a reload to keep the id. No live note is
     written.
5. PR through `forge-pr create`, then `/gstack-codex review origin/main` posted verbatim,
   then the AI gate, then James's merge approval.

## Risks

- **A view whose payload includes something that changes on every render**, such as a
  timestamp, never matches after a reload. It falls back to today's behaviour; it is not
  harmful. The browser check and a read of each call site's payload catch these.
- **The fingerprint makes `withMutationId` async before it calls `send`.** Callers
  already `await` it, and the concurrency test pins the shared-id behaviour.

## Proof

- **Commit 1** (`2be962c`): against `main` (`d629c5f`), with no `node_modules`,
  `mutation.test.mjs` runs 14 tests: 9 pass, 5 fail. The five failures are the reload
  reuse, the in-page changed-request case, save/remove, fingerprint-only storage, and the
  storage-failure warning.
- **Commit 2** (`4e1d3c9`): mutation and api tests 19 pass. `npm test` 582 pass, 0 fail.
- **Commit 3** (`ca39804`, see Deviations): red against `4e1d3c9`'s helper, 15 tests with
  1 fail (a content-bearing key stored as text). Green: 20 pass.
- **Commit 4** (`4622da1`): all 16 direct call sites pass a payload. `npm test` 583 pass,
  0 fail, no `node_modules`. `npm run verify` finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy, Open Notebook pointed at a dead port. A `fetch` wrapper let each request reach the
  server and then threw, to stand in for a lost response.
  - Flashcards, "I got it" on one card: the server answered 201 under `e30dfd44…`, and the
    page showed the error. `sessionStorage` held one entry of hashes only (`kh`, `id`,
    `fp`, `created`).
  - After a real reload, the identical review through the page's own module instance went
    out under `e30dfd44…` again. The server answered with `duplicate: true`,
    `reviews.jsonl` still had 1 line, and the entry was cleared.
  - After another reload, a changed request under the saved Test Center key
    (`attempt:practical-deep-learning-fastai:…`) got a new id (`4f863fd6…`, not the saved
    `b129f7b0…`) and replaced the saved entry.
  - The real tree was checked afterwards: `git status` on `.learn` clean, its
    `attempts.jsonl` unchanged since Aug 14.
- **Codex review** at `b167bb4`: GATE PASS with two P2 findings, posted to the PR. Both were
  fixed test first. `b063d8d` is red against `b167bb4` (17 tests, 2 fail). The fix makes
  them pass, and a new test checks the synchronous `sha256` against `crypto.subtle` on nine
  inputs, including padding boundaries, multi-block input and non-ASCII. `npm test`: 586
  pass, 0 fail.

## Deviations

- **Storage holds a hash of the intent key, not the key** (commit 3). Wiring the views
  showed two keys that carry content: `reading-highlight:…:<selected passage>` and
  `source-add:…:<whole request JSON>`. Saving keys as text would have put pasted source
  text in `sessionStorage`, against the plan's "only the hash is stored". Saved entries are
  now matched back to their key by hash when the key is asked for again.
- **SHA-256 is computed synchronously in `mutation.mjs`, not with `crypto.subtle`**
  (Codex finding 1). The plan relied on one `await` before a synchronous check-and-set.
  Codex showed the gap: a second call still hashing when the first call's request
  succeeds finds no id and mints a new one. Hashing synchronously reserves the id before
  anything yields, as the helper did before this change. That also removes the plan's
  second risk.
- **`resetMutationId` clears an id saved before a reload** (Codex finding 2). Without
  this, an edit followed by an undo after a reload replayed the earlier submission.
- **The fingerprint check applies within one page too, not only after a reload.** The
  plan's design states the rule without that limit; the intent's outcome described only
  the reload. Within a page, a changed request under a content-free key was already the
  same swallowed-retake failure (Test Center has no reset on edit), so one rule covers both.
- **A missing `sessionStorage` is silent; only a throwing one warns.** The plan said
  "missing, unreadable or full" all warn once. A missing global only happens outside a
  browser (the node test runner), where a warning on every import would be noise.
- **The browser check used Flashcards, not Test Center, and skipped the Open Notebook
  case.** On `main`, Test Center's submit and finalize and the Reading Room's highlight and
  position saves pass an already-stringified body to `requestJson`, which stringifies it
  again. The server answers 400 "request body must be an object". This dates from
  `5ba3371` (2026-08-13) and matches the real Practical Deep Learning `attempts.jsonl`, last
  written Aug 14. It is out of scope here and reported separately. Test Center's ids are
  still wired and unit-tested; the Open Notebook failure path is covered by the unit test
  that a failure keeps the entry.
