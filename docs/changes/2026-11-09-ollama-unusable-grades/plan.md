---
change: 2026-11-09-ollama-unusable-grades
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a model reply with no usable score or cards is a failure, not a zero

## Files that change

- `app/test/gradeegress.test.mjs`: cases through `POST /api/grade`.
- `app/test/debriefegress.test.mjs`: one case through the debrief route.
- `app/lib/ollama.mjs`: `gradeEssay` and `cardsFromDebrief`.

## Order of work

1. **Commit 1, tests only** (`test(grade): ...`). At the route boundary, not the function
   (CLAUDE.md: a test of what a function returns is not a test of what its caller does):
   - For each reply `{feedback}` with `score` missing, `null`, `"four"`, `{}`, `[]`, `NaN`
     (sent as the string `"NaN"`), and for `{score: 4, feedback: "  "}`: `POST /api/grade`
     answers 502, appends a `grading_pending` attempt, and that attempt has no `score`.
   - Controls: `{score: 0, feedback}` records 0, and `{score: "4", feedback}` records 4.
   - Debrief: a reply whose cards all lack a usable front or back gives the route's
     `failed_known` / `debrief_card_draft_failed` outcome and writes no cards; the existing
     happy-path test stays the control.
   Against `main` the missing-score, null, non-numeric and blank-feedback cases must fail
   (they record 0) and the all-blank-cards case must fail (it records success); the
   controls must pass.
2. **Commit 2, the fix** (`fix(ollama): ...`). A `usableScore(value)` helper returns a
   finite number or `null` (numbers as-is; strings only if they are exactly a decimal
   number); `gradeEssay` throws the existing `OllamaError(…, 502)` when it is `null` or
   `feedback` is blank, then clamps as before. `cardsFromDebrief` keeps its filter and
   throws the same 502 when nothing survives it. Run the two egress files, then
   `npm test` with no `node_modules`.
3. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI-review gate, James's merge approval. Nothing to restart-verify beyond a normal
   restart: the paths need a misbehaving model to observe.

## Decisions

- **Numeric strings are accepted.** `"4"` is not an invented grade, and refusing it would
  send real grades to the pending path for a formatting quirk. `"4/5"`, `"four"` and `""`
  are refused.
- **Partial card sets are kept.** `debrief.mjs` relies on `cardsFromDebrief` dropping bad
  drafts and says the check lives in one place; the snapshot's refuse-the-whole-set rule
  would discard good cards for one bad one. Only the all-unusable case changes.

## Options not taken

- **Port the snapshot hunk as is.** It also moves `chat` onto `fetchJson` (area B's
  `httpjson.mjs`, not on `main`) and refuses whole card sets.
- **Default a missing score to a pending status inside `gradeEssay`.** The route already
  turns a thrown 502 into a pending attempt; a second path would duplicate it.

## Proof

- **Commit 1** (`ecc77a4`): against `main` the unusable-score case failed
  (`missing: answered 201`, a recorded grade) and the all-blank-cards case failed (recorded
  as success); the zero and `"4"` controls passed.
- **Commit 2** (`bbea297`): the two egress files 25 pass; `npm test` 533 pass, 0 fail, no
  `node_modules`.
- Codex verdict comment, gate verdict, `forge-pr status` SAFE.

## Deviations

- **Control status corrected before commit 1.** The first draft of the controls expected
  `200`; a recorded grade answers `201`, as the existing happy-path test asserts. Fixed in
  the test before it was committed; the code was not changed to fit.
- **An empty `cards` list is now a failure too.** Covered by the intent's "every card is
  dropped" case; the route already refuses an empty debrief before calling the model, so a
  non-empty debrief that yields no cards is the model failing.
- **`clampScore` no longer calls `Number()`**: it now receives the already-validated score.
- **Codex round 1 found a duplicate-note path; fixed here** (`ba116b1` red, then the fix).
  `finishDebriefCards` recorded any card failure as `failed_known`, overwriting an
  `ambiguous` note outcome, and `runDebrief` only refuses to re-post for `prepared` and
  `ambiguous`, so the retry posted the note again. Pre-existing for a model error, but this
  change added a second trigger (no usable card), so it belongs here. The catch now keeps
  `ambiguous`; one more file changes: `app/router.mjs`. Suite: 534 pass, 0 fail.
