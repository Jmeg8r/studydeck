---
change: 2026-11-10-mutation-ids-survive-reload
status: accepted
track: T1
risk: medium
risk_reason: Changes when the browser reuses a mutation_id, which is what makes every append idempotent (rule 9). Reusing an id too eagerly makes the server's first-wins dedupe swallow a genuinely new submission and return an older result; reusing it too rarely records duplicates. No server, route or stored-data change.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a retry after a reload keeps its mutation id

## Problem

The next slice of porting PR #98's September snapshot (`264547c`): mutation ids survive a
page reload.

`app/web/js/mutation.mjs` keeps the id for each unfinished intent in an in-memory `Map`.
Rule 9 says the client mints an id once and reuses it until the request succeeds. That
holds while the page is open, but a reload empties the `Map`. A learner whose response
was lost, who then reloads and repeats the action, sends a fresh id, and the server
records the action a second time. Where that costs the most:

- a podcast or batch generation started twice (`podcast:…`), which is minutes of local
  model and TTS time;
- a reading highlight or added source written to Open Notebook twice;
- an essay graded twice, and a debrief or mind-map run twice;
- a Test Center submission recorded as two attempts.

The roles view already survives a reload a different way: the server hands back the
pending turn's `mutation_id` (`pendingTurn` in `app/lib/sessions.mjs`). This slice leaves
that path alone.

## The catch in the snapshot's version

The snapshot stores each id in `sessionStorage` under its intent key. But many keys name
the action, not its content. `attempt:<topic>:<deck>` is the same key for every take of a
deck, and the server's dedupe is first-wins (`appendUnique`, `app/lib/sidecar.mjs`).

Suppose the first submission landed and only the response was lost. After a reload the
learner retakes the deck with different answers. The restored id goes out, and the
server returns the first attempt's results as if they graded the new answers. The new
answers are silently dropped. Today that same retake records correctly.

The snapshot covered this by storing the whole request and refusing a different payload
until the learner resolves it in a new Recovery view. That view, and the response
validation that came with it, are a larger change than this slice.

## Outcome

A retry after a reload reuses the original id only when it sends the same request. A
different request after a reload is a new intent and gets a new id. Nothing else about
when ids are minted, reused or cleared changes.

## Out of scope

- The snapshot's Recovery view, the stored request payloads it replays, and the "needs
  attention" lines it added to the integrity banner.
- The snapshot's response-shape validation in `requestJson`.
- The roles view's server-side `pendingTurn` recovery.
- Keeping ids across tabs or browser restarts. `sessionStorage` is per tab by design: a
  second tab is a second learner action.
