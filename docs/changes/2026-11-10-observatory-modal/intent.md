---
change: 2026-11-10-observatory-modal
status: accepted
track: T1
risk: low
risk_reason: Browser-only change to one overlay. No server route, sidecar or state.json write is touched. The failure modes are an overlay that will not close or leaves focus lost, both visible on first use.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the Observatory is a real modal dialog

## Problem

In James's words today: "Yes, start it", the next slice of porting PR #98's September
snapshot (`264547c`): the Observatory as a modal dialog.

The Observatory (`app/web/js/views/observatory.mjs`, opened from the wheel on Today) is a
full-screen `div` appended to `body`. It looks modal but is not:

- **Tab leaves it.** Keyboard focus walks into the rail and the Today view hidden beneath
  it, onto controls the learner cannot see.
- **Nothing names it.** A screen reader gets no dialog role and no title, and the close
  button is announced as "✕".
- **Focus is dropped.** Opening it leaves focus on the wheel button underneath; closing it
  leaves focus wherever it was, not back on the button that opened it.
- **Back does not close it.** The browser Back button changes the hash route, the view
  beneath re-renders, and the Observatory stays on top of it.

## Outcome

- It opens as a `<dialog>` with `showModal()`, so the page beneath is inert and Tab stays
  inside it. It is labelled by its masthead, and the close button has an accessible name.
- Opening it moves focus to the close button; closing it by any route returns focus to the
  control that opened it.
- It closes on Escape, the close button, a click on the backdrop, and a hash change.
- It looks the same as today at desktop width.

## Out of scope

- A keyboard-operable way to inspect a concept (the snapshot's concept picker, and focus
  on wheel cells): the "wheel accessibility" slice.
- Phone-width layout of the Observatory: the "phone overflow fixes" slice.
- Contrast tokens, and the snapshot's global focus-ring and reduced-motion CSS.
