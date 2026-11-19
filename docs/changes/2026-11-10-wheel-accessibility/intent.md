---
change: 2026-11-10-wheel-accessibility
status: accepted
track: T1
risk: low
risk_reason: Observatory view code and CSS only. The Observatory reads the state the page already loaded and writes nothing, so no route, sidecar or state.json path is touched. The failure mode is visible, a picker that selects the wrong concept or a layout that stacks badly, and it is caught by the unit tests and the browser check.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the Observatory works without a mouse, and on a phone

## Problem

This is the next slice of porting PR #98's September snapshot (`264547c`): wheel accessibility.
The phone overflow slice (#140) also left this slice a known defect to resolve.

Measured on `main` (`488d420`) against a `/tmp/learn` copy:

- **Only a pointer can inspect a concept.** The wheel's 49 concept cells are SVG paths with a
  click listener and no `tabindex`, role or accessible name beyond a `<title>` tooltip. A
  keyboard or screen-reader user can open the Observatory and close it, but cannot inspect a
  single concept. `main` already has the dialog half of the snapshot's work (a modal
  `<dialog>` named by its masthead, a labelled close button, focus returned to the launcher),
  pinned by `observatory.test.mjs`.
- **Below 1100px, inspecting shows nothing at all.** `@media (max-width: 1100px)` hides the
  legend and the detail panel. Clicking a cell on a tablet or phone fills a panel that
  isn't displayed.
- **The hub caption overlaps the innermost ring on a phone.** "of 49 touched" reaches 62.9px
  from the wheel's centre. The ring starts at 50.5px at 390x844 and 38.5px at 320x640. At
  1280x800 the ring starts at 91.7px, so desktop is clear. This is the deviation recorded
  in `docs/changes/2026-11-10-phone-overflow/plan.md`.
- **The dim Observatory text fails contrast.** `#f2e5c455` (the legend's dim rows, the
  "untested" note, and the hub caption) is 2.64:1 on `#101b2d` and 2.40:1 on `#16233a`.
  WCAG AA asks for 4.5:1.

## Outcome

- A labelled **concept picker** (a native `<select>`, "Inspect a concept") lists every concept
  as topic / domain / concept · status. Choosing one fills the detail panel exactly as a
  click on its cell does. The detail panel is `aria-live="polite"`, so a screen reader
  announces the result.
- **Under 1100px the stage stacks** (wheel, then legend with the picker, then detail) instead of
  hiding the legend and detail. Inspecting works at every width.
- **At 760px and under, the hub leaves the hole.** The touched count and its caption sit on one
  line above the wheel, so nothing overlaps a ring at 390 or 320.
- **The dim Observatory text** uses the snapshot's `#abb8cc` (8.60:1) and body text uses
  `#bcc7d7` (10.10:1). The hub caption gets the same dim colour.
- **The close button and the picker show a visible focus ring** against the dark sky.

## Decisions for James

1. **One tab stop for the picker, or 49 for the cells as well?** The snapshot does both: it
   makes every cell `role="button"` with `tabindex="0"` and Enter/Space, and it adds the
   picker. **Recommended: the picker only.** It satisfies the keyboard requirement, and it
   doesn't put 49 tab stops between the close button and the detail panel. The cells stay
   pointer targets, and the SVG gets `role="img"` with a summary label, so a screen reader
   hears one sentence instead of 49 unlabelled shapes.
2. **Stack under 1100px, or only under 700px as the snapshot does?** The snapshot shows the
   panels again only at 700px and under, so from 701px to 1100px its picker is hidden too.
   **Recommended: stack under 1100px**, the breakpoint `main` already uses to hide the panels.

## Out of scope

- The global `:focus-visible` ring and the `prefers-reduced-motion` block. They are app-wide,
  not part of the wheel, and every slice so far has left them out.
- The snapshot's colour changes outside the Observatory (`.heat-cell.weak-high` and others).
- The snapshot's podcast CSS, which goes with slices D and C.
- `wheelSize()`, and the wheel's drawing in `wheel.mjs` (unless decision 1 goes the
  snapshot's way).
