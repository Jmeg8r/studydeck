---
change: 2026-11-05-schedule-reset
track: T2
status: accepted
---

# Intent: reset a notebook's start date, and a shortcut to Open Notebook

## In James's words

> I want the ability to reset a notebook's start date without having to start over with a
> new notebook. I also want a shortcut added to 127.0.0.1:8502 where more media and other
> settings can be added or deleted etc.

## Why

- Today the only way to put a topic back at day 0 is to create a new notebook. That throws
  away the mapped Open Notebook notebook, its sources, and the topic's history. What James
  actually wants to redo is the 30-day **pipeline**, not the material.
- Sources, uploads, podcasts and model settings are managed in Open Notebook's own UI on
  :8502. The cockpit links there in one place only (the Reading Room upload link), so getting
  there means typing the URL.

## Decisions (James, 2026-11-05)

- A reset **restarts the pipeline**: it sets a new start date, clears per-stage reschedules,
  and reopens every completed stage by appending an `undo` event. The log stays append-only
  (hard rule 11). Attempts, cards, reviews and mastery are untouched.
- Branch on top of the uncommitted WIP and commit only this change's files.
- The Open Notebook 1.15.1 upgrade is out of scope here. Assessment only:
  `tasks/open-notebook-1.15.1-assessment-2026-11-05.md`.
