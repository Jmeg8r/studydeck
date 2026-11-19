---
change: 2026-11-09-blank-podcast-job-error
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a blank Open Notebook error message is no message

## Files that change

- `app/test/podcastegress.test.mjs`: blank-message cases through
  `GET /api/on/podcast/jobs/:id`.
- `app/lib/podcastjob.mjs`: `normalizePodcastJob` reads a blank message as missing.
- `docs/changes/2026-11-09-podcast-job-statuses/plan.md`: D's live result in its Proof.

## Order of work

1. **Commit 1, tests only** (`test(podcast): ...`), at the route boundary, with the stub
   serving `error_message: ''` the way the live run showed:
   - `failed` and `canceled` with `''`, and `failed` with `'   '`: `error` names the
     status.
   - `running` with `''`: `error` is `null`, and the job is still not terminal.
   - `completed` with `''`: `successful: true`, `error: null`.
   Against `main` the `failed`/`canceled` cases fail (`error` is `''`), as do the
   `running` and `completed` ones (`error` is `''`, not `null`).
2. **Commit 2, the fix** (`fix(podcast): ...`): trim the message once; empty becomes
   `null` before the success check and the fallback. Run the podcast test files, then
   `npm test` with no `node_modules`. Fill D's Proof with its live run in the same
   commit series (a `docs(plan): ...` commit).
3. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval. No live check: the path needs a job that fails with
   a blank message, which cannot be produced on demand.

## Risks

- **A message that is only whitespace now reads as no message.** That is the intent;
  whitespace carries nothing a reader could act on.

## Proof

- **Commit 1** (`67915e8`): against `main`, 11 run and 4 fail, each because `error` came
  back as the blank string itself (`''`, `'   '`) where the status text or `null` was
  expected.
- **Commit 2:** the four podcast test files, 36 pass; `npm test` 553 pass, 0 fail, no
  `node_modules`.
- Codex and gate verdicts still to come.

## Options not taken

- **Fix it in the view** by checking for an empty `error` there. Both pollers would need
  it, and the server boundary is where #131 put the job's meaning on purpose.
