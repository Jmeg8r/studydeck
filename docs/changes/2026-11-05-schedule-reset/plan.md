---
change: 2026-11-05-schedule-reset
track: T2
status: accepted
---

# Plan

1. Failing route tests in `app/test/routes.test.mjs`: reset reopens completed stages, clears
   overrides, and unpauses; a replay appends nothing; bad input is refused; history files are
   untouched. Add the route to the "mutation_id required" list. → verify: they fail against
   the current router (404).
2. `handleSchedule` `reset` branch in `app/router.mjs`. → verify: the new tests pass.
3. `buildTopic` exposes `notebook_id` (`app/lib/derive.mjs`). → verify: `npm test`.
4. Today view reset control (`app/web/js/views/today.mjs`). Rail shortcut
   (`app/web/js/main.mjs`, `app/web/css/app.css`). → verify: drive it on a `/tmp/learn` copy
   with `STUDYDECK_LEARN_ROOT`, and reconcile `schedule.json` and `stages.jsonl` by hand.
5. `npm test`, `npm run verify`. Commit only this change's hunks; the WIP stays in the
   working tree.

Risk: `router.mjs`, `main.mjs` and `app.css` also carry uncommitted WIP. Stage only this
change's hunks with `git apply --cached` built from a diff against the pre-edit snapshot.

## Deviations

- **The branch was rebuilt on `origin/main` before the PR.** Local `main` was 32 commits
  stale. The rail layout that R3 hangs off (`notebookSection`, `toolsHeading`) had already
  landed upstream in #102, so R3 ships in this PR as its own commit instead of waiting.
  R3 was verified live on a `.learn` copy: all four links resolve, and
  `/notebooks/notebook%3A…` returns 200 from ON 1.13.0.
