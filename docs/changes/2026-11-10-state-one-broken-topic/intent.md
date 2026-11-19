---
change: 2026-11-10-state-one-broken-topic
status: accepted
track: T1
risk: medium
risk_reason: Changes what GET /api/state returns, the read every cockpit view starts from. A topic that is skipped without being announced would read as a smaller curriculum and lower totals, which is the quiet data loss the integrity banner exists to prevent.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: one unreadable topic no longer blanks the cockpit

## Problem

In James's words today: "Yes, start B", the next slice of porting PR #98's September
snapshot (`264547c`): one broken topic no longer blanks `/api/state`.

`buildState` in `app/lib/derive.mjs` builds every configured topic with
`config.topics.map(buildTopic)`, and nothing catches a throw from one of them.
`buildTopic` starts with `readTopicState`, an unguarded `JSON.parse` of the topic's
`state.json`. So one damaged or missing `state.json`, or any other throw while building
one topic, fails the whole `GET /api/state` with a 500. The browser then shows "Cockpit
could not load its state" in place of every view, for every topic, including the topics
that are fine.

This has bitten once already. A comment in `app/lib/learn.mjs` records a `.DS_Store` file
that turned `/api/state` into a 500 the same way. That fix removed one cause and left the
shape that turns any per-topic failure into a total one.

## Outcome

- One topic that cannot be built does not stop the others. `GET /api/state` answers 200
  with every topic that could be built.
- The response names what is missing: `unavailable_topics` lists each skipped topic's
  slug and the error, and `incomplete` is `true` when that list is not empty. With every
  topic healthy, the list is empty and `incomplete` is `false`.
- The cockpit says so on every view, above the numbers. A banner names each unavailable
  topic and warns that totals and badges leave it out. A skipped topic must never read
  as a topic that does not exist.
- The server logs each skipped topic with its slug and error, so the cause is in the log
  as it is today.

## Out of scope

- `/api/health` and `npm run verify` reporting an unreadable `state.json`. Health reads
  the sidecars and decks, not `state.json`; the next slice ("health shows stuck
  operations") changes the same handler.
- Routes that write to a topic (quiz, attempts, stages). A write to a broken topic still
  fails, as it should.
- Repairing or restoring a damaged `state.json`.
