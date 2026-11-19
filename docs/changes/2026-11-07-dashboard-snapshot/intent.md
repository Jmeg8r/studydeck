---
change: 2026-11-07-dashboard-snapshot
track: T1
status: accepted
risk: low
risk_reason: Read-only export. It writes only to its own output folder and never touches .learn/.
---

# Intent: a one-command snapshot for the StudyDeck progress dashboard

## In James's words

> Taking into account how StudyDeck works, create a Dashboard that will be super useful.
> … Yes, add the script.

## Why

- The StudyDeck progress dashboard (a claude.ai Dashboard artifact) reads six JSON files:
  topics, stages, concepts, attempts, activity and reading. No connector can reach the
  local `.learn/` tree, so those files are a snapshot that has to be rebuilt by hand.
- The first snapshot came from a throwaway Python script that re-implemented the stage
  rules. It disagreed with `app/lib/stages.mjs`: it gave paused topics dates and ignored
  the clamp that stops a rescheduled stage overtaking an earlier one. A second copy of
  hard rule 11 is a copy that drifts.

## What done looks like

- `npm run dashboard:snapshot` writes the six files to `.dashboard-snapshot/`
  (git-ignored), built through the cockpit's own readers: `stageStatesFor` for stages,
  `readAttempts` (folded) for attempts.
- Read-only on `.learn/`; honours `STUDYDECK_LEARN_ROOT`; no deck question, answer, card
  face or miss id is written (hard rule 7).
- Tests pin the stage states for a paused and a running topic, the attempt fold, and the
  absence of deck content.

## Out of scope

- Uploading the files to the dashboard. That stays a manual replace in the dashboard's
  Sources panel, or a request to Claude.
- A live HTTP route on the cockpit server.
