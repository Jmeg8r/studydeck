---
change: 2026-11-10-phone-overflow
status: accepted
track: T1
risk: low
risk_reason: CSS for the Observatory at phone width only, inside a media query that desktop never reaches. No data, route or script logic changes. The failure mode is visible, a wheel drawn too small or a header that wraps badly, caught by the browser check.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the Observatory fits a phone

## Problem

The next slice of porting PR #98's September snapshot (`264547c`): phone overflow fixes.
The Observatory slice (#137) left the Observatory's phone layout to this one.

Measured on `main` (`7dcbdf9`) at 390x844 against a `/tmp/learn` copy: no view of the
shell scrolls sideways. All 12 rail views (Today through Videos) and a Test Center retake
have a document `scrollWidth` of 390, and no element reaches past the right edge. The
only overflow is in the Observatory:

- `wheelSize()` never goes below 360px, and the dialog has 34px of side padding. That
  leaves a 322px stage, so the wheel runs 38px past it and the dialog scrolls sideways
  (`scrollWidth` 394 on a 390px viewport). This happens at any width under 428px.
- The header's two small-caps counters squeeze into narrow columns, one word per line.

Most of the snapshot's phone CSS no longer applies. Its `@media (max-width: 600px)` block
shrinks the side rail to 76px. On 2026-09-23 (`4ee2e27`), after the snapshot, `main`
changed its phone layout to put the rail on top of the page instead, and the measurement
above shows that layout doesn't overflow. The snapshot's test pins the 76px rail, so it
would fail against `main`'s layout, which works.

## Outcome

- At phone width (760px and under, the snapshot's breakpoint for this) the Observatory's
  wheel shrinks to fit the dialog. The dialog doesn't scroll sideways at 390px or 320px.
- The header wraps cleanly instead of breaking the counters into one-word columns.
- The dialog uses less side padding on a phone, so the wheel gets the width.
- A test reads `app.css` and fails if those phone rules are removed.

## Out of scope

- The snapshot's 76px side rail and its test, since `main`'s top rail already fits.
- The snapshot's `@media (max-width: 700px)` block, which shows the concept detail panel
  on a phone. That goes with the concept picker in the wheel accessibility slice.
- The global `:focus-visible` ring, `prefers-reduced-motion` CSS and non-text contrast,
  as in every slice so far.
- `wheelSize()`'s desktop sizing.
