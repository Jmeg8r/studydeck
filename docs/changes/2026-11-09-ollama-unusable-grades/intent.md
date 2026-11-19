---
change: 2026-11-09-ollama-unusable-grades
status: accepted
track: T1
risk: medium
risk_reason: Changes when a model grade is accepted. Too loose records an invented score in append-only history, which cannot be taken back (rule 7); too strict sends a usable grade to the pending path, which is recoverable.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a model reply with no usable score or cards is a failure, not a zero

## Problem

In James's words today: "Yes, start B1", the first slice of porting PR #98's September
snapshot (`264547c`) onto today's `main`.

`gradeEssay` (`app/lib/ollama.mjs`) accepts any reply that parses and has a string
`feedback`, then records `clampScore(parsed.score, max)`, which is
`Math.round(Number(value) || 0)`. So a reply with feedback but no `score`, or with
`score: null`, `"four"`, `{}`, records **0 out of max** as a real grade. That breaks the
rule the function states for itself ("never invent a grade from unparseable output"), and
`gemma4:31b-mlx` is known to omit fields its schema marks required
(`.claude/rules/external-services.md`). A zero in append-only attempt history cannot be
taken back, and it feeds mastery.

An empty or whitespace-only `feedback` is accepted the same way.

`cardsFromDebrief` drops cards without a usable front and back, by design
(`app/lib/debrief.mjs` keeps that check in one place). But when every card is dropped it
returns `[]`, and the debrief route records success with zero cards: the model failing
reads as "this debrief had nothing worth a card".

## Outcome

- A grade is recorded only when the reply carries a finite numeric `score` (a number, or
  a string that is exactly a number such as `"4"`) and non-empty `feedback`. Anything else
  takes the path an unparseable reply already takes: 502, the answer kept as a
  `grading_pending` attempt, no score.
- `0` stays a legitimate grade when the model actually says 0.
- Out-of-range scores keep being clamped, as today.
- A debrief whose drafted cards are all unusable is a card-drafting failure (the route's
  existing resumable `failed_known` path), not a success with zero cards. A reply with
  some usable cards keeps them, as today.

## Out of scope

- The snapshot's `fetchJson` transport refactor and its 502/503 remapping.
- Card count and length caps.
- Any change to what is sent to the model.
