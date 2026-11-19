---
change: 2026-11-11-chapter-audio-assembly
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: assemble a chapter's voiced clips into one checked audio file

## Files that change

All are new. No existing file changes.

- **`app/lib/executables.mjs`** exports `resolveTool(envName, name)`. It uses the same
  lookup order as `videogeneration.mjs`'s private `tool()`: the environment variable,
  then `/opt/homebrew/bin`, then `/usr/local/bin`, then the bare name on `PATH`.
- **`app/lib/podcastaudio.mjs`** is September's module, reshaped into two layers:
  - **Pure:** `parseLoudness`, `analysePcm` and `judgeAudio`, plus the exported
    thresholds.
  - **Wrappers:** `audioTools`, `probeAudio`, `assembleAudio` and `checkAudio`. Each
    takes a final `{ run }` option, which defaults to `execFile`.
  - September's numbers and ffmpeg arguments carry over unchanged. Any change from
    September is recorded under Deviations.
- **`app/test/podcastaudio.test.mjs`** holds the pure tests and the recorder tests.
- **`app/test/podcastaudioffmpeg.test.mjs`** holds the real-ffmpeg test. It skips when
  `resolveTool` finds no runnable ffmpeg or ffprobe.

## Order of work

Each step goes red, then green, in separate commits.

1. **`resolveTool`.**
   - Red: the env var wins when set. A Homebrew or `/usr/local` path is used only when
     it exists. Otherwise the bare name is returned. The test uses temp files and a
     changed environment, never the machine's real tools.
   - Green: the module.
2. **The pure decisions.**
   - Red cases:
     - `parseLoudness`: the last JSON block in real-shaped stderr is read; a missing or
       non-numeric block is refused.
     - `analysePcm`: a synthetic buffer with a 6 s silence, a run of full-scale
       samples, and a repeated 20 s pattern 60 s apart. Each signal is measured, and a
       clean buffer reports none.
     - `judgeAudio`: every issue fires at its threshold and stays quiet just inside it.
   - Green: the pure layer, from September's `checkAudio` and `loudness` bodies.
3. **The wrappers, recorded.**
   - Red: a recording `run` that returns canned stdout and stderr. It shows:
     - the exact argument lists for `probeAudio`, both `assembleAudio` passes,
       `checkAudio`'s decode and measure, and `audioTools`;
     - the `concat.txt` that `assembleAudio` writes;
     - that a non-hex clip key, or an empty clip list, is refused with no `run` call;
     - that a failing second pass leaves no `candidate.part.mp3` and no
       `candidate.mp3`.
   - The canned output is input to get the code past ffmpeg. It is not a claim about
     ffmpeg's output. The file header says so, per `.claude/rules/testing.md`.
   - Green: the wrappers.
4. **Real ffmpeg, local only.**
   - The test generates two 2-second sine clips with ffmpeg, under 64-hex names.
   - It assembles them, checks them, and expects a pass with a duration of about 4 s.
   - It expects `candidate.mp3` to exist and `candidate.part.mp3` not to.
   - It skips when the tools are absent, giving the reason.
   - This tests existing behaviour once step 3 is green, so it may be green on arrival.
     If so, its commit says so, and shows it can fail by breaking the loudness target
     once and reverting.
5. **Verify and ship.**
   - `npm test` with no `node_modules`.
   - `npm run verify`.
   - The additive-only `numstat`.
   - A grep showing nothing imports the new modules outside their tests.
   - The real-ffmpeg test run locally, not skipped.
   - Codex until `NO_FINDINGS`.
   - The PR, with every run posted.

## Risks

- **Thresholds tested only against synthetic signals.** A real voice could trip the
  silence or clipping check. The intent leaves re-tuning to D5d, where real renders
  exist. The tests pin the thresholds as numbers, so a later change is deliberate.
- **The real-ffmpeg test never runs in CI.** That's accepted. CI pins the decisions and
  the arguments, and the local run proves the binaries agree. If ffmpeg changes its
  `loudnorm` output, CI won't notice. The local test and D5d's live drive will.
- **`maxBuffer`.** A 30-minute chapter decodes to about 14.4 MB of 4 kHz PCM, inside
  September's 24 MB limit. The 30-minute cap in `checkAudio` keeps it there.

## Proof

- **Red runs:** in each red commit, and here.
- **Green:** `npm test` with `node_modules` absent, and `npm run verify` clean.
- **Additive-only:** `git diff --numstat origin/main -- app/lib/` lists only the two new
  files.
- **Local ffmpeg:** the real-ffmpeg test passes here, with its output recorded.
- **Reviews:** Codex until `NO_FINDINGS`, with every run posted on the PR.

### Green, 2026-11-11

- **Green.** `npm test` with `node_modules` absent passes 813 of 813 at `505d890`, with
  none skipped on this Mac. `npm run verify` is clean.
- **Additive only.** `git diff --numstat origin/main -- app/` lists six new files and no
  changed ones:
  - `executables.mjs`, 16 lines;
  - `podcastaudio.mjs`, 151 lines;
  - four test files.
- **Importers.** Outside the tests, the only importer is `podcastaudio.mjs` importing
  `executables.mjs`. Nothing on `main` calls either module.
- **Local ffmpeg.** `podcastaudioffmpeg.test.mjs` passes here. Two generated tones
  assemble into about 4 s at -16 LUFS ±1.5, the file passes `checkAudio`, and no
  `candidate.part.mp3` is left behind.
  - With the loudness target moved to -30, it fails.
  - With `STUDYDECK_FFMPEG` pointed at a file that can't run, it is skipped.
- **Red runs.** Each red commit records its run.
  - The real-ffmpeg test was green on arrival, as the plan expected, and was shown able
    to fail.
  - One fixture was corrected in `1eda400`: a clipped run sat in a trailing window under
    100 ms, which is never measured.
- **Codex.** Run 1 returned `NO_FINDINGS` at `505d890`.

## Options not taken

- **Porting the module as one block with no tests**, as September had it. The checks
  would stay unverified.
- **A Linux CI install of ffmpeg.** CI deliberately has no install step (CLAUDE.md), and
  the workflow fails if a dependency appears.
- **Moving `videogeneration.mjs` onto `resolveTool`.** That would change running code.
  It's a separate cleanup.

## Deviations

- **The wrapper recorder tests live in `podcastaudiowrappers.test.mjs`**, not in
  `podcastaudio.test.mjs`. That way a missing wrapper export fails only that file.
  The pure tests keep their own file.
- **`audioTools` checks the two tools one after the other.** September ran them in
  parallel. Running them in order gives the recorder a fixed order to pin, and costs
  about 50 ms.
- **The clip-key check is null-safe** (`c?.key ?? ''`). A missing clip entry is refused
  as an invalid manifest. September would have thrown a `TypeError` instead.
- Every argument list, threshold and output name is otherwise September's.
