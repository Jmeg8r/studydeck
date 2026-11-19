---
change: 2026-11-09-refusal-log-path
status: accepted
track: T1
risk: low
risk_reason: Changes one log line in the handler's catch. The answer each request gets, and the guard's decisions, stay exactly as they are.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a refused request's log line names its path again

## Problem

In James's words today: "Yes, fix the log", after this was noticed in `stderr.log`
following the tailnet-access merge (#124):

```
[server] GET (unparsed) → 403: this tailnet user is not allowed
```

Before #124 a refusal logged its path, for example `GET /api/health → 403`. #124 moved
the request-target parse after `assertBrowserBoundary`, so that a target that is not a
URL could not become an unhandled rejection ahead of the guard. A side effect: a request
the guard refuses never gets a parsed URL, so the catch logs `(unparsed)`. The refusal is
correct; the log just no longer says what was asked for, which is the first thing you need
when reading who is knocking on the tailnet door.

## Outcome

- A request the guard refuses logs its path, as it did before #124.
- A target that is not a URL still answers 400 (or 403 if the guard refuses it first) and
  logs `(unparsed)`; nothing in the logging path can throw.
- Every response is unchanged: status, body and headers.

## Out of scope

- What the guard admits or refuses.
- Logging anything beyond the path (query strings, headers, the tailnet user).
- Any other log line.
