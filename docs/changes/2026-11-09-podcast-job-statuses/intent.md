---
change: 2026-11-09-podcast-job-statuses
status: accepted
track: T1
risk: medium
risk_reason: Decides which Open Notebook episodes a retry run may delete and re-render, and when the Podcast view reports a render finished. Too narrow an active set deletes or duplicates a queued render; too wide a success set reports a render that never happened.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: one podcast job status table, built from what Open Notebook actually reports

## Problem

In James's words today: "start D", the next slice of porting PR #98's September snapshot:
unify the podcast job status sets.

The cockpit keeps two tables of "still running" job statuses, and they disagree:

- `app/lib/podcastjob.mjs` `ACTIVE`: `pending queued running started processing in_progress`.
  It decides `terminal` and `successful` for `GET /api/on/podcast/jobs/:id`, which both
  Podcast-view pollers use to stop polling and say "Finished" or "Render failed".
- `app/router.mjs` `PODCAST_RUNNING`: the same plus `submitted`. It decides which episodes
  a retry batch skips as still rendering and which it deletes as dead, and which rows the
  canary sweep may clean up.

Checking Open Notebook itself found that both tables miss the main case. ON's jobs are
`surreal_commands` commands, whose status enum (read from the installed package,
`surreal_commands/core/client.py`) is `new`, `running`, `completed`, `failed`, `canceled`.
`submitted` appears only in the generate route's own response
(`api/routers/podcasts.py`, `status="submitted"`), not as a job status. ON's
`get_command_status` answers `unknown` when it has no record of the job. So:

- **A queued job reads as finished.** A job the worker has not picked up yet is `new`.
  `normalizePodcastJob` says `terminal: true, successful: true`, so the view prints
  "Finished" for a render that has not started.
- **A retry can delete a queued render.** An episode at `new` is not "running" to
  `planRetry`, so a retry run deletes its row and fires the render again.
- **A canceled job reads as a success.** `canceled` with no `error_message` is
  `successful: true`. So is `unknown`.

## Outcome

- One status module owns both questions, and the router and the normalizer both use it.
  Nothing else keeps its own list.
- Active (keep polling; never delete or re-render): `new` and `running`, plus the
  spellings the code already accepts (`pending`, `queued`, `started`, `processing`,
  `in_progress`, `submitted`), which cost nothing and cover older ON releases.
- Success is `completed` only. Any other terminal status, `canceled` and `unknown`
  included, is a failure, with a message naming the status when ON gives no
  `error_message`.
- A retry run leaves a `new` episode alone: no delete, no second render.

## Out of scope

- The rest of the snapshot's D/C slices: the podcast ledger move, provider-qualified
  model refs, rendition names, local-video HEAD.
- The poll ceiling, poll interval, and anything the Podcast view displays beyond what
  `terminal`, `successful` and `error` already drive.
- The worker-health pre-flight, apart from the status set the canary sweep reads.
