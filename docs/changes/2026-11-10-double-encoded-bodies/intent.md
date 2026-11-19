---
change: 2026-11-10-double-encoded-bodies
status: accepted
track: T1
risk: low
risk_reason: Four browser call sites change from always failing with 400 to sending the body the server already expects; the server, routes and stored data are unchanged. The one shared-code change makes requestJson refuse a string body, which no remaining caller sends.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: Test Center and the Reading Room can save again

## Problem

Found during the browser check for PR #141. Since `5ba3371` (2026-08-13, "share browser
request handling"), four browser requests send their body encoded twice:

- Test Center: **Submit and record** (`POST /api/attempts`);
- Test Center: **Finalize** after self-grading (`POST /api/attempts/:id/finalize`);
- Reading Room: **Save highlight** (`POST /api/on/notes`);
- Reading Room: the scroll-position save (`POST /api/reading`).

That commit replaced each view's local `api()` helper, which passed its options straight
to `fetch`, with `requestJson`. `requestJson` runs `JSON.stringify` on the body itself,
but these four call sites still pass a body they have already stringified. The server
receives a JSON *string*, not an object, and answers 400 "request body must be an object".

Observed on 2026-11-10 against a `/tmp/learn` copy: a Test Center submission returned
exactly that 400 and wrote nothing. So since 2026-08-13 no quiz attempt could be recorded,
no self-graded attempt could be finalized, no highlight could be saved, and reading
position was never stored. The position failure only reaches `console.error`.

Nothing caught it. `api.test.mjs` tests `requestJson` with object bodies only, and no test
looks at what these views send.

## Outcome

The four requests send an object body, and the server records them. `requestJson` refuses
a string body with a clear error before anything is sent, so the next call site written
this way fails the first time it runs instead of reaching the server as a 400.

## Out of scope

- Server-side leniency (parsing a JSON string body). The server's rule is right; the
  client is wrong.
- Recovering lost work. Nothing was written, so there is nothing to repair; the learner
  would have seen the error each time.
- The snapshot's other `requestJson` changes (response-shape validation, `keepalive`).
