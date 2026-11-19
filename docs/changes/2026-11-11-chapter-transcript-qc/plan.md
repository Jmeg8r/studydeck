---
change: 2026-11-11-chapter-transcript-qc
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the transcript planning and QC gates for the local chapter renderer

## Files that change

- **`app/lib/podcastquality.mjs`** (new). Ported from `264547c`: `planChapter`,
  `checkGrounding`, `sourcePassages`, `checkTranscript`, `repeatedEnvelope`, `words`,
  `digest`, `clipKey` and `PROMPT_VERSION`. The module gets the repo's `WHAT:`/`WHY:`
  header. The September header line about technical QC stays, because the intent
  needs it as a constraint.
- **`app/test/podcastquality.test.mjs`** (new). The six September tests, plus one per
  gap the intent names.

## Order of work

Each step is red, then green, in separate commits.

1. **The September contract.**
   - Red: carry over the six September tests unchanged. They import
     `../lib/podcastquality.mjs`, which does not exist yet, so the file fails to load.
   - Green: port the module as written.

   This step comes first because later slices depend on these export names and
   return shapes.
2. **The gaps.**
   - **Undefined dialogue.** A turn with no `dialogue` beside turns that have it.
     If the intent's reading is right, `words(undefined?.toLowerCase())` yields
     `['undefined']`, and that word enters the novelty vocabulary. This needs a red
     test first, then the fix: no dialogue contributes no words.
   - **`sourcePassages`.** Passages cover the text exactly. They break at a newline when
     one falls past 600 characters. A tail under 160 characters joins the previous
     passage.
   - **The 12-section ceiling.** A source that needs more sections than that is refused
     with its message, and is never truncated.

   The last two test existing behaviour, so they are likely to be green on arrival.
   Their commits will say so, and each will be shown able to fail by temporarily
   breaking the code it pins, run once and reverted before the commit.
3. **Verify and ship.**
   - `npm test` with no `node_modules`, and `npm run verify`.
   - `grep` to confirm the test is the only importer.
   - Codex until `NO_FINDINGS`.
   - Then the PR, with every Codex run posted.

   There's no live check, because nothing runs this code until D5d. T1 needs no spec
   and no adversarial panel.

## Risks

- **Getting the contract wrong** would cost D5c and D5d later. Step 1 ports the export
  names and return shapes as they were. Any change from September is recorded under
  Deviations, so D5c and D5d can check against it.
- **Fixing a "bug" that is intended.** The undefined-dialogue case already fails the
  transcript (empty dialogue is an issue), so the fix only changes the warning count.
  The test pins the issue and the warning separately.

## Proof

- **Red runs:** in each red commit, and here.
- **Green:** `npm test` with `node_modules` absent, and `npm run verify` clean.
- **Reviews:** Codex until `NO_FINDINGS`, every run posted on the PR.

### Green, 2026-11-11

- **Green:** `npm test` with `node_modules` absent, 760 of 760 at `116d3d0`.
  `npm run verify`: no damage found.
- **Importers:** `grep -rln podcastquality app/` lists only
  `app/test/podcastquality.test.mjs`. Nothing on `main` calls the module yet.
- **Red runs:** one per step and per Codex finding, in each red commit.
  - Two tests passed on arrival, and their commits say so: `sourcePassages`, and the
    12-section ceiling. Each was shown able to fail by temporarily breaking the code
    it pins.
  - One red commit's claim was wrong: `6eecc17` passed on arrival. `e5cb4fa`
    corrects its fixture and says so.
- **Codex:** four runs. Runs 1 to 3 found four P2s, each fixed test-first. Run 4
  returned `NO_FINDINGS` at `116d3d0`.
- **No live check:** nothing runs this code until D5d.

## Options not taken

- **Sharing `digest` with `mastery.mjs`** (intent open question 1). Settlements hash
  exact bytes, and this `digest` also serialises objects with `JSON.stringify`.
  Merging them would put one function on two contracts. They stay separate.
- **Moving `PROMPT_VERSION` to D5d** (intent open question 2). It is an input to the
  cache key, and the cache key lives here. D5d bumps it whenever the prompt changes.
- **Porting `podcastaudio.mjs` here.** It spawns ffmpeg, so it is D5c's.

## Deviations

- **`checkTranscript` changes from September in one place.** A turn with no `dialogue`
  no longer adds the word `undefined` to its section's novelty vocabulary. Its
  `passed` and `issues` are unchanged, and the empty-dialogue issue still fails the
  transcript. Only `warnings` can differ, and only when a dialogue-less turn sits among
  low-novelty turns. Pinned in `podcastquality.test.mjs`. Every other export is ported
  as written.
- **Both gates fail closed on malformed model output** (Codex run 1, two P2s).
  - `checkTranscript` skips, in its vocabulary pass, any turn whose `dialogue` is not a
    string. In September it threw on a `null` turn or on numeric dialogue. Its issues
    are unchanged, so such a transcript still fails. This guard also covers the
    dialogue-less case above, so the earlier `?? ''` was folded into it.
  - `checkGrounding` checks that its input is an array before checking emptiness. In
    September a string passed with no issues.

  Pinned in `podcastquality.test.mjs`.
- **`planChapter` ignores headings inside fenced code** (Codex run 2, P2). The
  end-of-chapter heading search now walks line by line and skips lines inside a
  ``` or ~~~ fence. In September a `## References` line in a markdown example excluded
  everything after it. The first real heading outside a fence still ends the chapter.
  Pinned with a control in `podcastquality.test.mjs`.

  Codex run 3 then found that a fence must close as CommonMark says it does: same
  character, at least as long as the opener, nothing after the fence on that line. A
  four-backtick example holding a three-backtick block now stays open. The first test
  for this (6eecc17) passed on arrival because its fixture missed the case; e5cb4fa
  corrects it, and says so.
