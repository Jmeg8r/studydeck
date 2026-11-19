---
change: 2026-11-10-wheel-accessibility
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: the Observatory works without a mouse, and on a phone

James accepted both recommendations on 2026-11-10: the picker only, and
stacking under 1100px.

## Files that change

- `app/web/js/views/observatory.mjs`:
  - the `onSelect` body becomes a named `selectConcept`, shared by the wheel and the picker;
  - a labelled `<select>` goes in the legend;
  - `aria-live="polite"` goes on the detail panel;
  - `role="img"` and a summary `aria-label` go on the SVG;
  - the hint text no longer says only "Click".
- `app/web/css/app.css`, Observatory rules only:
  - dim and body text colours;
  - a `:focus-visible` ring for `.obs-close` and the picker;
  - the 1100px block stacks the stage instead of hiding the panels;
  - the 760px block takes the hub out of the hole.
- `app/test/observatory.test.mjs`: picker and live-region tests, using its existing minimal DOM.
- `app/test/mobile-layout-contract.test.mjs`: the hub and stacking rules join its rule list.

## Order of work

1. **Commit 1, tests only** (`test(observatory): ...`).
   - The picker is a `<select>` with a `<label for>`. It has one option per concept plus a
     blank first option. Choosing an option renders that concept's name and evidence in the
     detail panel, the same output as calling the wheel's `onSelect` with that concept.
   - The detail panel has `aria-live="polite"`.
   - The SVG has `role="img"` and an `aria-label`.
   - In `mobile-layout-contract.test.mjs`:
     - inside `@media (max-width: 1100px)`, `.obs-stage` has `flex-direction: column`, and
       no rule sets `.obs-legend` or `.obs-detail` to `display: none`;
     - inside `@media (max-width: 760px)`, `.obs-hub` has `position: static`.

   All of this must fail against `main`. The red run goes in the commit message and Proof.
2. **Commit 2, the fix** (`fix(observatory): ...`), described under Files that change.
   - Port the picker from the snapshot. Its options are built from the same
     `state.topics → domains → concepts` walk the wheel draws, so the two can't disagree.
   - On phones the hub becomes a static flex row above the wheel (`.obs-field` becomes
     `flex-direction: column`), with no transform and an auto width.

   Then run the two test files, `npm test` with no `node_modules`, and `npm run verify`.
3. **Commit 3, contrast** (`fix(observatory): ...`).
   - `.obs-row.dim`, `.obs-p.untested` and `.obs-d` become `#abb8cc`, and `.obs-p` becomes
     `#bcc7d7`.
   - It is kept apart from commit 2 so a colour change can be reverted on its own.
   - A contrast pin is not worth a parser. The ratios go in Proof, computed from the hex values.
4. **Browser check** against a `/tmp/learn` copy, on the worktree's router on port 4319,
   with Open Notebook at a dead port:
   - at 390x844 and 320x640, the hub's text box doesn't reach the inner ring radius. This is
     the same `getPointAtLength` measurement used for the intent;
   - no sideways scroll;
   - the picker is visible and fills the detail;
   - at 900x800, the panels are stacked and visible;
   - at 1280x800, the layout is unchanged from `main` apart from the picker in the legend;
   - with the keyboard: Tab reaches the close button and then the picker, and choosing an
     option updates the detail.
5. PR through `forge-pr create`. Then `/gstack-codex review origin/main`, posted verbatim
   with a GATE line. Then the AI gate, triaged. Then James's merge approval.

## Risks

- **The browser pane can't prove a screen reader's announcement.** The pane runs no
  assistive technology. `aria-live` is pinned by a unit test, and the announcement itself is
  unverified. Proof will say so.
- **The dialog's `close` event does not fire in the hidden browser pane.** That is true even
  for a bare test `<dialog>`, like `requestAnimationFrame`. Close and focus-return are already
  pinned by `observatory.test.mjs`, and the browser check won't use them as evidence.
- **A long picker.** 49 options now, and more topics will come. A native `<select>` scrolls,
  and each option label leads with its topic. Grouping options by topic with `<optgroup>` is
  a cheap follow-up if it gets unwieldy, but it isn't in this slice.
- **Stacking at 761–1100px changes a tablet layout that works today**, though without
  inspection. The browser check measures 900px specifically.

## Proof

- **Commit 1** (`1b43d3c`): against `main` (`488d420`), with no `node_modules`, the two test
  files run 10 tests: 6 pass, 4 fail. The failures are the 1100px stack, the phone hub, the
  picker ("the Observatory has a concept picker") and the live region (`aria-live` is null).
- **Commit 2** (`4ad7a8b`): 10 pass. `npm test` 592 pass, 0 fail, no `node_modules`.
  `npm run verify` finds no damage. The picker test's control holds: every concept cell the
  real `renderWheel` draws into the stub is clickable (3 of 3). The set of detail panels from
  the cells equals the set from the picker.
- **Commit 3** (`23e9627`), contrast, computed from the hex values with the WCAG luminance
  formula, on `#101b2d` / `#16233a`:

  | Text | Before | After |
  |---|---|---|
  | dim rows, untested note, hub caption | `#f2e5c455`: 2.64 / 2.40 | `#abb8cc`: 8.60 / 7.83 |
  | body text (`.obs-p`) | `#f2e5c48c`: 4.98 / 4.54 | `#bcc7d7`: 10.10 / 9.20 |

- **Commits 4–7** are the two deviations below, each test first:
  - `b4ef1f4` is red, 2 pass and 1 fail; `b077894` is green.
  - `8d4ede2` is red, 9 pass and 2 fail; `7492a9d` is green.
  - At `7492a9d`, the two files run 11 pass. `npm test` 593 pass, 0 fail, with no
    `node_modules`. `npm run verify` finds no damage.
- **Browser check**, 2026-11-10, at `7492a9d`. The worktree's router ran on port 4319 over a
  `/tmp/learn` copy, with Open Notebook at a dead port. The ring is the closest any concept
  path comes to the centre, sampled with `getPointAtLength`. The caption is the farthest
  corner of its text box.

  | Viewport | Wheel | Inner ring | Hub | Hub clear | Dialog client/scroll | Legend |
  |---|---|---|---|---|---|---|
  | 320x640 | 288 | 40.6 | above wheel | yes | 320 / 320 | below |
  | 390x844 | 358 | 50.5 | above wheel | yes | 390 / 390 | below |
  | 800x800 | 380 | 53.6 | above wheel | yes | 770 / 770 | below |
  | 900x800 | 480 | 67.7 | in hole, caption 62.9 | yes | 870 / 870 | below |
  | 1280x560 | 410 | 57.9 | above wheel | yes | 1265 / 1265 | beside |
  | 1280x800 | 650 | 91.7 | in hole, caption 62.9 | yes | 1265 / 1265 | beside |

  The picker is visible at every size. When stacked, the order is wheel, then legend, then
  detail. The computed colours are `rgb(171, 184, 204)` for the caption and dim rows, and
  `rgb(188, 199, 215)` for body text. The SVG reads `role="img"`, "Mastery wheel:
  49 concepts across 3 topics". No wheel cell has a `tabindex`.
- **Keyboard**, at 320x640 with real key presses: the dialog opens with focus on the close
  button. One Tab moves focus to `#observatory-concept`, with a 3px `rgb(240, 168, 64)`
  outline. Down selects "AI Agent Design Patterns / Agent Foundations / The Agent Loop ·
  unexplored", and the detail shows that concept and "Never quizzed". Typing a letter did not
  move the selection. That is the pane's typed input, which arrives as inserted text, not
  key events, so type-to-select is untested here.
- **Not verified:** what a screen reader actually announces from the live region. The pane runs
  no assistive technology, so only the `aria-live="polite"` attribute is pinned.

## Options not taken

- **The snapshot's 49 focusable cells** (intent, decision 1). It costs 49 tab stops for the
  same capability the picker already gives.
- **A roving tabindex with arrow keys around the ring.** That is one tab stop and
  spatial, but it adds a keyboard model that is only worth having if people navigate the
  wheel itself. It is a candidate for later, not part of a port.
- **Shrinking the hub to fit the hole on phones.** Slice A measured that this can't work: the
  text would have to drop below a readable size at 320.

## Deviations

- **The stacked order needed a rule.** In DOM order the legend comes first, so the first
  browser check at 390x844 put the wheel 492px down, below the mastery key and the picker.
  `.obs-field { order: -1; }` in the 1100px block now gives wheel, legend, detail, as the
  intent says. It is pinned in `mobile-layout-contract.test.mjs` (`b4ef1f4`, `b077894`).
- **The hub's move follows the wheel's size, not the 760px breakpoint.** The intent and plan
  put the hub rule in the phone media block. Measured at 900x800, then at 800x800 and
  1280x560, the caption also overlapped the ring outside phone width: 53.6px at 800x800 and
  57.9px in a short laptop window, against the caption's 62.9px. `main` draws the same wheel
  sizes there, so this was never a phone problem. The ring starts at about 14.1% of the
  wheel's size, so the caption clears it from about 446px. `observatory.mjs` now marks the
  field `compact` when `wheelSize()` is under `HUB_FITS_FROM` (460, which leaves a margin).
  The hub rules hang off `.obs-field.compact` at the top level. The 760px block keeps only
  the overflow rules from #140. The contract test's phone-hub assertion became
  `a compact wheel moves the hub out of the hole`, plus a unit test across four window sizes
  (`8d4ede2`, `7492a9d`).
- **One plan detail was dropped.** The plan said the 760px block would give `.obs-field`
  `flex-direction: column`. That now lives on `.obs-field.compact`, the only case that needs it.
