---
change: 2026-11-05-schedule-reset
track: T2
status: accepted
---

# Spec: schedule reset and Open Notebook shortcut

## R1: `POST /api/schedule/reset`

Body: `{ topic_slug, mutation_id, started? }`. `started` defaults to today and must be a
real `YYYY-MM-DD` date (same round-trip check as `/start`).

Effects, in this order:
1. For every milestone the stage fold currently reports `complete`, append
   `{ action: 'undo', milestone_key, note: 'schedule reset', mutation_id: '<id>:<key>' }`.
2. Write `schedule.json` as `{ ...existing, started, paused: false, step_overrides: {} }`.
3. Append a marker `{ action: 'reset', mutation_id: '<id>', started, reopened }`. It names no
   milestone, so the stage fold ignores it. A replay that finds the marker returns the
   current state and writes nothing, so progress recorded after the reset survives a late
   retry (Codex review of #111).

Returns `200 { schedule, reopened: [keys], stages: [...] }`.

**Why it carries a `mutation_id` when `/start` doesn't:** step 1 APPENDS (rule 9). Each
per-stage id is derived from the request id, so a replayed request finds every undo already
on disk and appends nothing. Step 2 is a set, so a replay rewrites the identical file. A
replay is therefore a no-op, and the response still lists the same stages as reopened only on
the first call. A second, distinct reset with nothing complete reopens nothing.

Refuses: an unknown topic (400), a missing `mutation_id` (400), an invalid date (400). A
topic that was never started may be reset; that is equivalent to starting it.

Never touches: `attempts.jsonl`, `reviews`, cards, `state.json`, or the ON notebook.

## R2: the Today view's "Reset start date" control

Each started topic in "Topics on the clock" gets a **Reset…** button. Clicking it shows an
inline date field (default today), a short statement of what reset does ("Reopens N
completed stages and clears reschedules. Quiz history and mastery are kept."), and
Confirm / Cancel buttons. Confirm mints one `mutation_id` per open dialog and reuses it on
retry.

## R3: Open Notebook shortcut in the rail

A rail section **Open Notebook ↗** with links that open in a new tab:
- **This notebook** → `http://127.0.0.1:8502/notebooks/<notebook_id>` for the working
  topic (falls back to `/notebooks`)
- **Sources** → `/sources`, **Podcasts** → `/podcasts`, **Settings** → `/settings`

`buildTopic` exposes the topic's `notebook_id`, which is already in the committed config,
so this is not a secret. The links use `rel="noopener noreferrer"`. No CORS header and no
new server route.

## Concerns flagged

- Reopening stages is visible in the stage log as `undo` events with the note `schedule
  reset`, which keeps it auditable. It is not reversible with one click. The confirmation
  step is the guard.
- The ON UI paths were checked against 1.13.0 (`/notebooks`, `/notebooks/<id>`, `/sources`,
  `/podcasts`, `/settings` all return 200). The 1.15 redesign renamed "API Keys" to
  "Models", so re-check these paths after the upgrade.
