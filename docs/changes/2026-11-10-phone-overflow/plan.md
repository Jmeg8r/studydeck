---
change: 2026-11-10-phone-overflow
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: the Observatory fits a phone

## Files that change

- `app/test/mobile-layout-contract.test.mjs` (new). It keeps the snapshot's file name and
  its balanced-block reader, but its assertions are about the Observatory, not the rail.
- `app/web/css/app.css`: one `@media (max-width: 760px)` block after the Observatory
  rules.

## Order of work

1. **Commit 1, test only** (`test(mobile): ...`). Inside `@media (max-width: 760px)`:
   - `.observatory` sets a smaller padding;
   - `.obs-head` has `flex-wrap: wrap`;
   - `.obs-field` has `min-width: 0`;
   - `.obs-field svg` has `max-width: 100%` and `height: auto`.

   It collects every miss before failing, so one missing rule doesn't hide the others.
   Against `main` it must fail because the block doesn't exist. The red run goes in the
   commit message.
2. **Commit 2, the fix** (`fix(mobile): ...`): the snapshot's 760px block, minus the
   rules for `.obs-stage`, `.obs-legend` and `.obs-detail`. Those panels are already
   `display: none` under 1100px, so those rules have no effect until the concept-picker
   slice shows them again. The wheel's SVG has a `viewBox`, so `max-width: 100%` with
   `height: auto` scales it in proportion.

   Then run the test file, `npm test` with no `node_modules`, and `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy at 390x844 and 320x568, in both themes
   (the Observatory is always dark, but the launcher on Today is not):
   - the dialog's `scrollWidth` equals its `clientWidth`;
   - no element in the dialog reaches past the viewport;
   - the hub label still sits inside the wheel's centre;
   - the header wraps cleanly.

   At 1280x800 the Observatory must measure the same as on `main`.
4. PR through `forge-pr create`, then `/gstack-codex review origin/main` posted verbatim,
   then the AI gate, then James's merge approval.

## Risks

- **The hub label overlaps the inner ring.** `.obs-hub` is a fixed 190px wide and sits on
  top of the wheel. A wheel shrunk from 360px to about 350px (390 minus 2x16 padding)
  barely changes the centre hole, but at 320px the browser check looks at it
  specifically. If it overlaps, the hub's size goes in the same media block. That would
  be a recorded deviation, not a silent addition.
- **The test reads CSS as text.** It proves the rules exist, not that the browser draws
  them as intended. The snapshot's test said the same. The browser check is the proof
  that matters.

## Proof

- **Commit 1** (`8dfaf49`): against `main` (`7dcbdf9`), with no `node_modules`,
  `mobile-layout-contract.test.mjs` fails with `@media (max-width: 760px) block is missing
  from app.css`. 0 pass, 1 fail.
- **Commit 2** (`5af9b64`): `mobile-layout-contract.test.mjs` 1 pass. `npm test` 575 pass,
  0 fail, no `node_modules`. `npm run verify` finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy, Open Notebook pointed at a dead port. Before/after numbers come from the same page,
  measured with the 760px rule in place and again with it deleted from the live stylesheet.

  | Viewport | Dialog client/scroll width | Wheel | Hub label offset from wheel centre |
  |---|---|---|---|
  | 390x844, rule deleted (as `main`) | 390 / 394 | 360px | 0, 0 |
  | 390x844, with the fix | 390 / 390 | 358px | 0, 0 |
  | 320x568, with the fix | 320 / 320 | 288px | 0, 0 |

  No element in the dialog reaches past the viewport at 390 or 320. The header wraps to
  the title on one line and each counter on one line. At 1280x800 the dialog, header,
  stage, wheel (650px), hub, legend and detail measure identically with and without the
  rule. The light theme at 390x844: page and dialog both 390 wide.

## Deviations

- **The hub label still overlaps the innermost ring on a phone, and this slice leaves it.**
  The plan's fallback was to size the hub down in the same block. Measured, that cannot
  work: the centre hole starts 51px from the centre at 390 and 41px at 320, and the
  "of 49 touched" caption's far corner sits 63px out. Even at 7.5px with tighter tracking,
  too small to read, it reaches 42px at 320. The overlap is not new: with the rule deleted,
  `main` measures the same 51px ring and 63px corner at 390, because the wheel sits at its
  360px floor there. James chose to record it and ship the overflow fix as is. Moving the
  caption out of the hole on phones goes with the wheel accessibility slice, which reworks
  the hub area.

## Options not taken

- **Port the snapshot's 600px rail block and its test as they are.** `main` replaced that
  layout after the snapshot, and the measurement shows the replacement fits. Porting it
  would rework working navigation to satisfy a test written for an older shell.
- **Fix it in `wheelSize()` by dropping the 360px floor on narrow screens.** That works,
  but it puts a padding value in JavaScript that CSS already owns. Scaling the SVG in CSS
  keeps the phone layout in one media block, the way the shell's other breakpoints are
  written.
