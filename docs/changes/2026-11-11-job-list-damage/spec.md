---
change: 2026-11-11-job-list-damage
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [security-review]
claude_config_sha: 58442fe
---
# Spec: one damaged job file stops blocking the video and Higgsfield job lists

## Flagged concerns

**F1. How `list()` tells damage apart from other errors.** Source: intent, *Constraints*
("only the damage error is turned into a marker"). There are three ways to do it:

- (a) `list()` catches every error from `get()`. This is rejected: a programming fault
  would show up as "damaged".
- (b) `list()` catches errors whose `status` is 500. This is fragile: any later 500 from
  `get()` would also become a marker.
- (c) Split the read out of `get()`. A private `read(id)` returns `null`, a job, or a
  damage result. `get()` throws when it gets damage. `list()` turns damage into a marker.
  Nothing is caught.

Recommended: (c). It makes damage a value instead of an exception, and every other error
still propagates. *Resolution:* James chose (c), 2026-11-11.

**F2. A replay whose `mutation_id` is inside the damaged file starts a second job.**
Source: CLAUDE.md rule 9 (append dedupe). This is a known gap that James accepted in the
intent (2026-11-11). It costs one extra local render or storyboard. Nothing is billed,
nothing leaves the machine, and nothing is appended to `.learn/`. Recommended: accept it,
and name it in the code comment and the PR. *Resolution:* James accepted it, 2026-11-11.

**F3. #157 merged while this intent was in draft (merge `df184a4`).** The branch is
rebased onto it. On the merged reader, `readJsonSafe` never throws on I/O. Every damage
case returns `source: 'fallback'`: a corrupt primary with no good `.bak`, a missing
primary beside a bad `.bak`, an unreadable job directory, and a non-file at the path. So
one damage branch covers all four triggers. The intent's Problem section still says "once
#157 lands". It is accepted, so it stays as written, and this note records the change.
Recommended: no action. *Resolution:* James chose to leave the intent as written, 2026-11-11.

**Policy not applied: `design:ux-copy` and `design:accessibility-review`.** Neither
applies, because no view changes (intent, *Proposed outcome*). This is recorded so the
omission is visible, not silent.

## Requirements

- **R1.** `list()` in both services returns a job whose file reads as damage as
  `{ id, status: 'damaged', error }`. `error` is exactly the message `get()` throws for
  that service: `Video job state is damaged` or `Higgsfield storyboard state is damaged`.
  (intent: *Proposed outcome*, bullet 1)
- **R2.** `list()` keeps every readable job, with the same fields and values as today,
  sorted newest `created_at` first. Damaged markers come after all dated jobs, ordered by
  `id`, so the order is deterministic. (intent: bullets 1–2)
- **R3.** `get(id)` for a damaged job still throws its 500 error, unchanged. The detail
  routes `/api/videos/jobs/:id` and `/api/videos/higgsfield/:id` still answer 500.
  (intent: bullet 3)
- **R4.** `start()` returns a readable job whose `mutation_id` matches (replay, 202). It
  still answers 409 when that `mutation_id` was used for a different notebook. It never
  matches a damaged marker. With no readable match, it starts a new job, even if damaged
  entries exist. (intent: bullet 4)
- **R5.** No error other than the damage result becomes a marker. Anything else `get()`
  or the read throws still propagates from `list()`. (intent: *Constraints*)
- **R6.** Routes and views do not change. `GET /api/videos/jobs` keeps its `notebooks`
  key. (intent: bullet 5, *Out of scope*)

## Design

The same change goes into each service, inside its `create*Service` closure.

```
read(id) → null                      bad id, or file missing
         → { damaged: true }         readJsonSafe source === 'fallback'
         → { job }                   the stored value, with the restart rewrite applied

get(id)  = read(id); damaged → throw <existing message>, 500; else job or null
list()   = entries → read → damaged ? { id, status: 'damaged', error: <message> } : job
           sort: dated jobs by created_at desc, then markers by id
start()  = list().find(job => job.status !== 'damaged' && job.mutation_id === mutationId)
```

- The damage message moves into one constant per module, so `get()` and the marker can't
  drift apart.
- The restart rewrite (`running` with no active render becomes `completed` or `failed`)
  stays inside `read`, so `get` and `list` keep applying it the same way.
- In `start()`, the `status !== 'damaged'` guard is defensive. A marker carries no
  `mutation_id`, so it can't match anyway. The guard says so explicitly and costs nothing.
- `update` and the completion writes call `get(id)` on the job being rendered. If that
  file becomes damaged mid-render, they throw as they do today. That is out of scope.
- No new imports. Rule 5 holds.

Views: `videos.mjs` and `higgsfield.mjs` choose jobs by `status` (`running`,
`completed`, `prepared`, `failed`) and by `topic_slug`. A marker matches none of them, so
it is never selected. No view code changes. The existing view tests stay as they are.

## Security and data

- Applied the `security-review` lens. This adds no new input. The `id` in a marker is a
  directory or file name that has already passed `get`'s `^[a-f0-9-]{36}$` test, so the
  marker can't carry a path or arbitrary text. The marker exposes no file contents and no
  path, only the fixed message.
- No write path is added (rule 8), and nothing in `.learn/` is touched (rules 1, 3).
- Rule 12: the routes and their guard are unchanged. No CORS header is added.
- Rule 9: replay dedupe still covers every readable job. F2 records the one gap.
- The full `security-review` runs again on the finished diff, before the PR.

## Acceptance checks

Each check runs against a temporary directory, never the real `docs/`.

- **A1 (R1, R2)** Unit, both services: one healthy job file plus one damaged file
  (invalid JSON, no `.bak`). `list()` returns the healthy job first, then
  `{ id, status: 'damaged', error }` with the exact message.
- **A2 (R2)** Unit: two healthy jobs and two damaged files. Dated jobs come newest first,
  then markers sorted by `id`.
- **A3 (R3)** Unit and route: `get(damagedId)` throws with status 500, and
  `GET /api/videos/jobs/<damagedId>` and `GET /api/videos/higgsfield/<damagedId>` answer
  500.
- **A4 (R4)** Unit: `start()` with the healthy job's `mutation_id` returns that job, and no
  render or prepare runs. A different notebook gives 409. A fresh `mutation_id` starts a
  new job.
- **A5 (R1, R4, R6)** Route test, `STUDYDECK_VIDEO_DIR` set to a temp dir: GET
  `/api/videos/jobs` and GET `/api/videos/higgsfield` answer 200 and include the marker.
  POST `/api/videos/generate` and `/api/videos/higgsfield/prepare` with the healthy job's
  `mutation_id` answer 202 with that job's id. With a fresh `mutation_id` they answer 202
  with a new id.
- **A6 (R5)** Unit: a read that throws some other error (not damage) still propagates
  from `list()`. This is driven through an injected fault: for the video service, the
  directory scan meets an entry whose stat throws. If no seam exists without new
  production code, this check becomes a code-review item in plan.md and is noted as one.
- **A7** All of A1–A5 are committed failing first (a red commit), then made to pass.
- **A8** Live, on port 4320, with `STUDYDECK_LEARN_ROOT=/tmp/learn` and
  `STUDYDECK_VIDEO_DIR=/tmp/studydeck-videos`: with one corrupt job file in each job
  directory, `curl` of both list routes answers 200 and shows the marker.
- **A9** `npm test` passes with `node_modules` absent.

## Open questions

- None carried from the intent; it had none.
- None raised here: James resolved F1–F3 on 2026-11-11.
