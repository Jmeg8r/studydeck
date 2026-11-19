---
change: 2026-11-10-contrast-tokens
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: secondary text is readable in both themes

## Files that change

- `app/test/contrast.test.mjs` (new): reads `tokens.css` and `app.css` as text.
- `app/web/css/tokens.css`: the snapshot's values, plus `--error-text` and `--success-text`.
- `app/web/css/app.css`: text rules move from `--coral`/`--teal` to the text tokens; the
  badge's text colour.
- `app/web/js/timeline.mjs`: the "now" label's text reads `--error-text`.

## Order of work

1. **Commit 1, tests only** (`test(contrast): ...`):
   - parse the `html.dark` and `html.light` blocks of `tokens.css`; for each text token
     (`--txt`, `--dim`, `--faint`, `--accent-text`, `--error-text`, `--success-text`) over
     each field (`--bg`, `--bg-rail`, `--panel`, `--panel-hi`), alpha composited, assert
     at least 4.5:1, with the pair and ratio in the message;
   - no `color:` declaration in `app.css` reads `--coral` or `--teal` (borders and
     backgrounds may);
   - the `.nav-item .badge` rule's text passes 4.5:1 over its background.
   Against `main`, all three must fail.
2. **Commit 2, the fix** (`fix(contrast): ...`): the snapshot's token values; replace the
   text uses (`.error-panel h2`, `.new-notebook-status.error`, `.on-status.ok/.offline`,
   `.integrity-banner strong`, `.pill.owed`, `.ws b.t`, `.q-error`, `.verdict.correct/.missed`,
   `.source-add-status.error`, `.roles-clock.over`); a border that sits beside its own
   text (`.pill.owed`, `.verdict.*`) follows the text token so they match, as in the
   snapshot. Badge text becomes `--on-accent` (5.22:1, keeping the coral fill). The
   timeline "now" label's text fill reads `--error-text`; its dot keeps coral.
   Run the file, `npm test` with no `node_modules`, `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy, both themes: Today, Test Center, the
   rail, a graded verdict, the stats chart and timeline. Look for anything that reads
   wrong, especially `--dim` and `--faint` now being solid colours.
4. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval.

## Risks

- **The dim/faint hierarchy flattens.** With the snapshot's values, light `--faint`
  (`#626269`) is darker than light `--dim` (`#64646a`), and dark `--faint` is only a
  little lighter than `--dim`. `--faint` is used only for chart axis and timeline labels,
  so the browser check looks at those specifically. Passing the floor wins over the old
  hierarchy; if the result reads badly, size or weight carries the hierarchy, not
  sub-floor colour.
- **Solid `--dim` on tinted surfaces.** The old value was translucent, so it took a hint
  of whatever it sat on. A solid grey may look slightly off on `--accent-wash`. Visual
  only; the browser check looks.
- **The test reads CSS as text.** It handles this file's format (one declaration per
  token, hex values or `var()` of another token), not CSS in general.

## Proof

- **Commit 1** (`bd83f3f`): against `main`, with no `node_modules`, 5 run and 5 fail, each
  with the measured pairs: dark `--dim` 3.99 to 4.41 on three fields and `--faint` 2.38 to
  2.54 everywhere; light `--dim` 3.40 to 3.61 and `--faint` 2.31 to 2.40 everywhere,
  `--accent-text` 4.23 on the page and 3.91 on the rail; `--error-text` and
  `--success-text` not defined; the badge 3.16:1 in both themes; 12 `color:` declarations
  reading coral or teal.
- **Commit 2** (`c6893d0`): `contrast.test.mjs` 5 pass. `npm test` 574 pass, 0 fail, no
  `node_modules`. `npm run verify` finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy, Open Notebook pointed at a dead port, 1280x800. A script walked every visible text
  node on Today, Stats and Test Center (Observatory and SVG excluded), composited its
  colour over the backgrounds actually beneath it, and listed anything under 4.5:1 (3:1
  for large text). Dark: none on any view. Light: one, the selected notebook's meta line
  at 4.48:1 (see Deviations). After the fix, light: none on any view. SVG text fills were
  the tokens the test measures (`--error-text`, `--dim`, `--faint`). Screenshots of Today
  in both themes: the owed pill and the timeline's now labels in the text shade, the
  timeline dot still coral, timeline labels legible.
- **Commit 4** (light `--dim` `#5e5e64`): `contrast.test.mjs` 5 pass. `npm test` 574 pass,
  0 fail, no `node_modules`. The browser scan above, rerun in light: none.

## Deviations

- **The test also measures text on `--accent-wash`**, found by the browser scan. The
  selected rail notebook, hot pills and learner turns draw text on the translucent amber
  wash, which the four base fields did not cover, so the test passed while light `--dim`
  sat at 4.48:1 there. The test now composites the wash over each field (commit 3,
  `b03d44c`, red with exactly that one pair).
- **Light `--dim` is `#5e5e64`, not the snapshot's `#64646a`.** It passes on the wash
  (4.91:1 over the rail) and is darker than light `--faint` (`#626269`), so in the light
  theme `--dim` again reads stronger than `--faint`, which the snapshot's values had
  reversed. The dark theme keeps the snapshot's values.
- **The badge and the timeline's now labels are beyond the snapshot**, as the intent said.

## Options not taken

- **Keep translucent `--dim`/`--faint` and raise the alpha.** A translucent colour's ratio
  depends on what it sits over, so one value cannot be checked once; solid values can.
- **Darken `--coral` and `--teal` themselves.** They are brand hues used for fills, heat
  cells and the wheel; text-only tokens leave those untouched, as `--accent-text` already
  does for amber.
