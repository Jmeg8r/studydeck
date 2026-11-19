---
change: 2026-11-11-chapter-audio-assembly
status: accepted
track: T1
risk: low
risk_reason: Adds new modules only, and no existing file changes. Nothing on main calls them until D5d. They spawn ffmpeg and ffprobe with argument arrays (no shell) in a directory the caller names, so a defect can only affect a render that does not exist yet.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: assemble a chapter's voiced clips into one checked audio file

Track: T1. One repo, no UI and no route, with risk low because every change is
additive and has no caller yet.

## Problem

This is slice D5c of the local chapter renderer, from PR #98's September snapshot
(`264547c`). D5a (the QC gates, PR #151) and D5b (the foundations, PR #152) are merged.

D5d voices each transcript turn as its own clip. Something then has to join those clips
in order, bring the result to one loudness, and check the file before anyone is asked to
listen to it. The check covers:

- a duration that doesn't match the clips;
- speech too fast or too slow for the word count;
- long silence;
- clipping;
- a looping section;
- a loudness off target.

September's `app/lib/podcastaudio.mjs` did this with ffmpeg and ffprobe. It had **no
tests of its own**. The renderer's tests replaced it with stubs, so its decisions (what
counts as silence, clipping, a loop or a loudness miss) were never checked against
anything. On `main` none of it exists.

## Proposed outcome

`app/lib/podcastaudio.mjs` exists on `main` with its decisions under test. It splits into
two layers.

- **Pure decisions, testable anywhere, including CI on Linux without ffmpeg:**
  - `parseLoudness(stderr)` reads ffmpeg's `loudnorm` JSON block, and refuses a missing
    or non-numeric one.
  - `analysePcm(pcm)` turns 4 kHz mono 16-bit PCM into a 100 ms RMS envelope, a
    clipping count and the longest silence.
  - `judgeAudio({ asset, signals, levels, expectedDuration, wordCount })` returns the
    issues and the pass/fail verdict.
  - The thresholds are September's:
    - duration within 1.5% (at least 2 s);
    - 70–260 words per minute;
    - silence over 5 s;
    - clipping over 0.1% of samples;
    - any repeated envelope (D5a's `repeatedEnvelope`);
    - integrated loudness within ±1.5 LU of −16, with true peak at most −1 dB.
- **Thin wrappers around the binaries:**
  - `audioTools()` checks that both tools run.
  - `probeAudio(file)` returns the duration, size and sha256.
  - `assembleAudio(dir, clips)` runs two-pass `loudnorm` to −16 LUFS, writes
    `candidate.mp3` via a temp file and rename, and returns the measurement.
  - `checkAudio(file, { expectedDuration, wordCount })` decodes, measures and judges.
  - Each wrapper takes an optional `run`, so a test can record the exact arguments
    sent to ffmpeg. This is the same pattern as the egress recorders: it pins what this
    app sends, not what ffmpeg returns.
- **One test drives the real ffmpeg.** It generates two short tone clips, assembles
  them, and checks that the result passes. It skips, saying why, when ffmpeg isn't
  installed. CI's Linux runners have none, so it runs on this Mac, and the Proof
  records that run.
- **A new `app/lib/executables.mjs`** finds each tool the way `videogeneration.mjs`
  already does: the environment variable (`STUDYDECK_FFMPEG`, `STUDYDECK_FFPROBE`),
  then `/opt/homebrew/bin`, then `/usr/local/bin`, then `PATH`. `videogeneration.mjs`
  is not changed. That keeps this slice additive. Moving the video code onto the shared
  helper is a separate cleanup.

## Affected users and systems

- None at runtime today. Nothing on `main` imports the new modules.
- D5d will be the caller. The exports and their return shapes are its contract.

## Constraints

- **Additive only.** No existing file changes. `git diff --numstat origin/main -- app/lib/`
  shows only new files.
- **Rule 5.** ffmpeg and ffprobe are operator tools, like Speaches and Ollama, not npm
  dependencies. The suite passes with `node_modules` absent and with no ffmpeg on the
  machine.
- **No shell.** Every spawn passes an argument array to `execFile`. Only names the
  module itself made (64-hex clip keys) reach the concat list. Anything else is
  refused before ffmpeg runs.
- **A passed check is technical, not a review.** As with D5a, it never stands in for a
  listen. The returned shape keeps the measurements, so D5d can show them.
- **Test first**, with a red commit before each behaviour's code.

## Out of scope

- Calling Speaches or Ollama, writing clips, the rendition manifest, routes and the
  view. Those are D5d and D5e.
- Changing `videogeneration.mjs` to use `executables.mjs`.
- Re-tuning September's thresholds. Doing that needs real renders, so it waits for
  D5d.

## Success signals

- `npm test` passes with `node_modules` absent. On a machine without ffmpeg, the
  real-ffmpeg test is reported as skipped, with its reason.
- Pure tests show each decision firing on synthetic input and staying quiet without it:
  - a malformed `loudnorm` block;
  - a silent stretch longer than 5 s;
  - clipped samples;
  - a looped envelope;
  - a duration mismatch;
  - implausible words per minute;
  - loudness and true peak off target.
- Recorder tests show the exact `ffmpeg` and `ffprobe` arguments for probe, both
  `loudnorm` passes and the decode. A clip key that isn't 64 hex characters is refused
  before anything runs.
- On this Mac, the real-ffmpeg test assembles two generated tone clips into
  `candidate.mp3`, which `checkAudio` passes. It leaves no `candidate.part.mp3` behind.
- `git diff --numstat origin/main -- app/lib/` lists only the new files.

## Open questions

None. The split into pure decisions and thin wrappers, the shared tool lookup, and the
local-only real-ffmpeg test follow the additive approach James chose for D5b. The plan
can still revisit any of them.
