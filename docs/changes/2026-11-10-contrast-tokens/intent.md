---
change: 2026-11-10-contrast-tokens
status: accepted
track: T1
risk: low
risk_reason: Colour values and which token a text rule reads. No data, route or script logic changes. The failure mode is a visible one, a colour that looks wrong or loses its hierarchy, caught by the browser check in both themes.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: secondary text is readable in both themes

## Problem

In James's words today: "Yes, start it", the next slice of porting PR #98's September
snapshot (`264547c`): contrast tokens.

Measured on `main` with WCAG 2.x contrast, alpha composited over each field the cockpit
draws text on (`--bg`, `--bg-rail`, `--panel`, `--panel-hi`); 4.5:1 is the floor for body
text:

| Token | Dark theme | Light theme |
|---|---|---|
| `--dim` (secondary text, 40 rules) | 3.99 to 4.62, fails on 3 of 4 fields | 3.40 to 3.61, fails everywhere |
| `--faint` (chart axis and timeline labels) | 2.38 to 2.54, fails everywhere | 2.31 to 2.40, fails everywhere |
| `--accent-text` | passes | 3.91 to 4.77, fails on page and rail |
| `--coral` as text (errors, "owed", "offline", missed) | 3.93 to 5.22, fails on panels | 2.59 to 3.16, fails everywhere |
| `--teal` as text (ok, correct) | passes | 2.06 to 2.51, fails everywhere |

Two text uses the snapshot did not touch also fail: the rail's count badge (white on
coral, 3.16:1) and the timeline's "now" label (coral on cream, 2.81:1 in light).

The light theme is the worst: almost every secondary line, every error message and every
"correct" verdict is below the floor.

## Outcome

- The snapshot's token values: `--dim`, `--faint` and light `--accent-text` become solid
  colours that pass, and two text-only tokens, `--error-text` and `--success-text`, are
  added per theme. Measured: every text token passes 4.5:1 on every field in both themes
  (lowest 4.82, light `--dim` on the rail).
- Every rule that colours TEXT with `--coral` or `--teal` reads the text token instead.
  Fills, heat cells, wheel cells and decorative borders keep the brand hues.
- The badge and the timeline's "now" label pass too.
- A test computes the ratios from `tokens.css` itself, so a later token edit that drops
  below the floor fails `npm test`.

## Out of scope

- The Observatory, which is a fixed dark scene with its own colours.
- Non-text contrast (borders and focus rings against 3:1), and the snapshot's global
  focus-ring and reduced-motion CSS.
- Any other colour change in the snapshot's stylesheet.
