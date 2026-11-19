---
change: 2026-11-11-job-list-damage
status: accepted
track: T2
risk: low
risk_reason: A damaged video or Higgsfield job file is manual damage to local, git-ignored render state. Today it takes down both job lists and both start routes with a 500. The fix lets the lists and starts run past it. The one new exposure is a replay whose mutation_id sits inside the damaged file: it starts a second local render or storyboard instead of returning the first. That costs local compute only. Nothing is billed, nothing leaves the machine, and no state.json or attempt write is involved.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: one damaged job file stops blocking the video and Higgsfield job lists

## Problem

This came from the security review of PR #157 (fix/readjson-damage). The review rated it
low, and James chose to fix it as its own slice rather than widen #157.

`list()` in `app/lib/videogeneration.mjs` and `app/lib/higgsfield.mjs` maps `get(id)` over
every job with no per-entry handling. `get` throws a 500 "state is damaged" when
`readJsonSafe` returns `source: 'fallback'`. Each `start()` calls `list()` first, to look
for a `mutation_id` replay. So one damaged job file makes all four routes answer 500:

- GET `/api/videos/jobs`
- GET `/api/videos/higgsfield`
- POST `/api/videos/generate`
- POST `/api/videos/higgsfield/prepare`

On `main` a corrupt primary with no readable `.bak` triggers it. Once #157 lands, three
more kinds of manual damage do too: a missing job file beside a bad `.bak`, an unreadable
job directory, and a non-file at the job path.

The cost: one bad file hides every finished video and storyboard, and no new one can be
started until someone finds and repairs the file by hand.

## Proposed outcome

- `list()` returns a damaged job as `{ id, status: 'damaged', error }`. `error` is the
  message `get` already throws (`Video job state is damaged` or
  `Higgsfield storyboard state is damaged`). It keeps listing the other jobs.
- Damaged markers sort after the dated jobs, because they have no `created_at`.
- `get(id)` for the damaged job still answers 500, unchanged.
- `start()` still finds and returns a replay among the healthy jobs, and still refuses a
  reused `mutation_id` with a different notebook (409). It starts a new job when no
  healthy job matches, even if a damaged one exists.
- No UI change. The Videos and Higgsfield views ignore an entry with no `topic_slug` and
  an unknown status, so the marker is invisible to them and harmless.

## Affected users and systems

- James, in the Videos and Higgsfield views of the cockpit.
- `app/lib/videogeneration.mjs`, `app/lib/higgsfield.mjs`, and their tests. The routes in
  `app/router.mjs` pass `list()` through unchanged.

## Constraints

- Rule 5: no dependency, Node stdlib only.
- Rule 8: no new write path. This change only reads.
- Rule 9: replay protection keeps working for every job whose file can be read.
- Only the damage error is turned into a marker. Any other error from `get` still
  propagates, so a programming fault is not hidden as "damaged".
- The change must work on `main` today and after #157 merges, whichever lands first.

## Out of scope

- Repairing, quarantining or deleting a damaged file.
- Any view change, including a notice about damaged entries.
- Changes to `readJsonSafe` or `atomic.mjs` (that is #157).
- Other sidecars whose list readers may share the pattern.

## Success signals

- `npm test` passes, with new tests that were committed red first. They pin, for each
  service, with one damaged job file beside one healthy job:
  - GET of the list route answers 200, with the healthy job and the
    `{ id, status: 'damaged', error }` marker.
  - GET of the damaged job's detail route still answers 500.
  - The start POST with the healthy job's `mutation_id` returns that job (replay).
  - The start POST with a new `mutation_id` answers 202 with a new job.
- A live check on port 4320 with `STUDYDECK_LEARN_ROOT=/tmp/learn` and
  `STUDYDECK_VIDEO_DIR=/tmp/studydeck-videos` (so no real job file is touched): with one
  corrupt job file in each job directory beside one healthy one, `curl` of both list
  routes answers 200 and shows the healthy job and the marker.

## Open questions

- None. James chose the marker shape, no UI change, and starting fresh when the replay
  match may be in the damaged file (2026-11-11).
