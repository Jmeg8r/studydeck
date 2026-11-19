---
change: 2026-11-09-blank-podcast-job-error
status: accepted
track: T1
risk: low
risk_reason: Changes only the text of a failure message and the null-versus-empty shape of `error`. Which jobs count as finished, successful or retryable does not change.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a blank Open Notebook error message is no message

## Problem

In James's words today: "Yes, fix it here", after the live check of
`2026-11-09-podcast-job-statuses` (#131).

That check showed Open Notebook sending `error_message: ''` on a running job, not
leaving the field out. `normalizePodcastJob` fills in
`Open Notebook reported the job as <status>` only when the field is missing (`??`), so
a `failed` or `canceled` job carrying `''` reaches the Podcast view with `error: ''`.
The view then prints "Render failed: " with nothing after it. The unit and route tests
missed it because their stub leaves the field out.

Success is already right: a `completed` job with `''` counts as successful, because the
success check treats any falsy message as no error.

## Outcome

- An `error_message` that is empty or only whitespace is treated as missing.
- A terminal non-success with a blank message gets the fallback text naming its status.
- `error` is `null`, not `''`, for an active or successful job with a blank message.
- Nothing else about the lifecycle changes.

## Out of scope

- How the Podcast view words its failure line.
- D's live result, which this PR also records in D's own plan; that is documentation,
  not part of this change.
