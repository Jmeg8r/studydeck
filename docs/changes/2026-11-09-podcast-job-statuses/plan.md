---
change: 2026-11-09-podcast-job-statuses
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: one podcast job status table, built from what Open Notebook actually reports

## Files that change

- `app/test/podcastegress.test.mjs`: job-poll cases through `GET /api/on/podcast/jobs/:id`.
- `app/test/batchegress.test.mjs`: a retry case with the episode at `new`.
- `app/test/podcastjob.test.mjs`: the unit cases follow the new rules.
- `app/test/podcastbatch.test.mjs`: imports the shared predicate instead of its own copy.
- `app/lib/podcastjob.mjs`: the one status table and the normalizer.
- `app/router.mjs`: drops `PODCAST_RUNNING` and uses the shared table.

## Order of work

1. **Commit 1, tests only** (`test(podcast): ...`), at the route boundary:
   - `podcastegress`: the stub gains `GET /api/podcasts/jobs/:id`, answering with a status
     the test sets. Through the cockpit route:
     - `new` gives `terminal: false`;
     - `canceled` and `unknown`, with no `error_message`, give `terminal: true`,
       `successful: false` and a non-empty `error` naming the status;
     - controls: `completed` gives `successful: true`; `failed` with a message passes
       that message through.
   - `batchegress`: the stub's episode status becomes a variable. With it at `new`, a real
     (not dry) `retry_only` run sends no `DELETE` and no generate. The existing
     `failed` control already proves the same fixture deletes and generates.
   Against `main`, the `new`, `canceled` and `unknown` cases must fail and the controls
   must pass.
2. **Commit 2, the fix** (`fix(podcast): ...`). `podcastjob.mjs` exports
   `ACTIVE_JOB_STATUSES` and `isActiveJobStatus(status)` (lower-cased, as both callers do
   today). `normalizePodcastJob` sets `successful` only for `completed`, and fills `error`
   with `Open Notebook reported the job as <status>` when a terminal non-success has none.
   `retryable` becomes `terminal && !successful`. The router imports the predicate for
   `planRetry` and the set for `stuckCanaryRows`, and `PODCAST_RUNNING` goes. Update
   `podcastjob.test.mjs` and point `podcastbatch.test.mjs` at the shared predicate. Run
   the four files, then `npm test` with no `node_modules`.
3. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval. After the merge and a restart, one live check:
   generate a short episode and watch the poll report `new`, then `running`, before
   "Finished".

## Risks

- **`unknown` could be transient** if ON ever answered it before the job record existed.
  `submit_command` writes the record before the generate route returns, so a poll should
  not see it; if it did, the view would show a failure for a render that is still going.
  The render itself is unaffected, and the episode list still shows it.
- **The canary sweep now also matches `new`.** A canary still queued after a failed
  pre-flight gets cleaned up as well as one stuck at `running`. That is what the sweep is
  for; its other guards (same name, no audio, created since the batch fired) are
  unchanged.
- **A job that stays `new` polls until the ceiling** instead of reporting "Finished" at
  once. That is the correct outcome: the view's ceiling message already says the render
  continues in Open Notebook.

## Proof

- **Commit 1** (`a335742`): against `main`, 13 run and 4 fail, each for the stated
  reason: `new` reads as `terminal: true`; `canceled` and `unknown` read as
  `successful: true`; the retry run sends `DELETE` for the queued episode and then
  `POST /api/podcasts/generate`. The `completed`/`failed` control and the existing batch
  tests pass.
- **Commit 2:** the four files plus `workerhealth.test.mjs`, 46 pass; `npm test` 549 pass,
  0 fail, no `node_modules`; `npm run verify` finds no damage.
- **Review:** Codex (`gpt-6.1-sol`, effort high) over `1d929d3..5ed2e2b`, 8 files and 18
  hunks: `NO_FINDINGS`, GATE: PASS. The local AI gate: PASS, 45 of 45 examined, no
  findings. `forge-pr merge` merged it as `aa1459c`.
- **Live check**, 2026-11-09, after a restart at 19:48 (pid 97353): one `study-overview`
  generate on the `ai-engineering` notebook (job `command:ioee3fy30khripceqtgw`), polled
  through the cockpit. It read `new` at 19:49:05 and `running` at 19:49:07, both
  `terminal: false`; then `completed` at 19:52:20 with `successful: true`,
  `retryable: false`. Before this change the 19:49:05 poll would have read as finished.
  The episode (`episode:8a4lgynk9f8sgx8idvqd`) has audio.
- **Found by the live check:** ON sends `error_message: ''`, not an absent field, which
  the fallback text did not cover. Fixed in `2026-11-09-blank-podcast-job-error`.

## Options not taken

- **Only add `new` and unify.** `canceled` and `unknown` would still read as success.
  James chose the wider fix.
- **Drop the legacy spellings** and keep only ON's five statuses. No ON release on this
  machine uses them, but keeping them costs nothing and removing them buys nothing.

## Deviations

- **`completed` with an `error_message` is still a failure.** The plan said success is
  `completed` only; the old code also refused a success that carried an error, and
  dropping that would have made a reported failure read as a success. Kept, and pinned in
  `podcastjob.test.mjs`.
- **`podcastjob.test.mjs` gained an `isActiveJobStatus` case** (case-insensitive, and
  `null`/`undefined` are not active), since the router now calls it directly.
