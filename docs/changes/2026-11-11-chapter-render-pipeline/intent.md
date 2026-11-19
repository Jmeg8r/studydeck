---
change: 2026-11-11-chapter-render-pipeline
status: accepted
track: T1
risk: low
risk_reason: Adds one new module and its tests, plus added lines in .gitignore. No existing code changes, and nothing on main calls the module until D5d2 adds the routes. It writes only under a rendition directory the caller names, through atomic.mjs.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the chapter render pipeline, as a module with no caller yet

Track: T1. One repo, no UI and no route. Risk is low because the change is additive and
nothing calls it yet. The routes come in D5d2, which is T2.

## Problem

This is slice D5d1 of the local chapter renderer, from PR #98's September snapshot
(`264547c`). Already merged:

- D5a: the transcript QC gates, PR #151;
- D5b: the foundations, PR #152;
- D5c: audio assembly and checks, PR #153.

Each of those does one step, and nothing joins them. Turning a chapter into a checked
recording takes a pipeline that:

1. reads the source;
2. writes the transcript section by section, rejecting a section that fails QC;
3. voices each turn as a clip;
4. assembles the clips and checks the result;
5. stops at a full listen before anything is published.

The pipeline has to survive a restart without redoing paid-for work or losing its
evidence. On `main` none of it exists.

September's `app/lib/podcastrender.mjs` did all of this. Only `renderRendition` could
take fakes. `prepareRendition`, `resumeRendition` and `publishRendition` reached Open
Notebook, Ollama and Speaches directly, so their refusals were never tested. It also
read its manifest with a validator argument that `main`'s `readJsonSafe` doesn't take.

## Proposed outcome

`app/lib/podcastrender.mjs` exists on `main`, with every decision under test.

- **A durable manifest per rendition** at
  `.learn/topics/<slug>/cockpit/audio/render-<24 hex>/manifest.json`. It is read and
  written only through D5b's `readJsonValidated` and `writeJsonValidated` (rule 8).
  - The rendition id is derived from the topic and the client's `mutation_id`. A replay
    with the same input returns the existing rendition. A replay with different input
    is refused with 409.
  - A manifest that fails validation is refused with 409, and its original and backup
    are kept.
- **The stages are September's:**
  - while working: `queued`, then `transcript_ready`, then `audio_ready`;
  - when done: `qc_passed`, `published`, `needs_review` or `failed`.
- **Section retries are counted in the manifest.** Each section gets three tries in
  total, across restarts. Each rejected response is kept as evidence, and a section
  that fails all three stops the render at `needs_review`.
- **Clips are content-addressed** by D5a's `clipKey`. A resume reuses a clip whose
  sha256 still matches and re-voices only a damaged or missing one.
- **One in-process queue renders one chapter at a time**, holding at most five. After
  a restart, an unfinished render shows as `interrupted` and waits for an explicit
  resume, which never starts by itself.
- **Resume refuses to continue with different settings.** If the model's digest, the
  prompt version or D5b's render fingerprint has changed, resume refuses. Mixing
  settings in one recording would make its provenance false.
- **Publish needs two things:** a `qc_passed` stage and an explicit confirmation of a
  full listen. The candidate's sha256 must also still match the one QC measured.
- **Every outside service is a parameter with a real default.** These are the Open
  Notebook reads, the preflight, Ollama, Speaches and the D5c audio tools. Tests swap
  in fakes and keep the real state machine.
- **Recorder tests pin what this app sends:**
  - Ollama's `/api/show`, `/api/tags` and `/api/chat`;
  - Speaches' `/v1/audio/speech`.

  They don't pin what those services return (`.claude/rules/testing.md`). The model's
  reply is parsed with `extractJson`, never `JSON.parse`.
- **`.gitignore`** ignores the audio by explicit path, with a comment: the MP3s and
  `concat.txt` under `cockpit/audio/`. Manifests stay committed, like other cockpit
  sidecars (James, 2026-11-11). A test asks git that a rendition's MP3s are ignored and
  its manifest isn't.

## Affected users and systems

- No runtime effect today: nothing on `main` imports the module.
- D5d2's routes will be the caller. The exports and `renderSummary`'s shape are its
  contract.
- When D5d2 calls it, the module reads from Open Notebook (GET only) and calls the local
  Ollama and Speaches. Nothing leaves the machine.

## Constraints

- **Additive only.** `git diff --numstat origin/main` shows new files and added
  `.gitignore` lines, with 0 deleted lines.
- **Rule 1.** Render data lives under `cockpit/`, never in `state.json`.
- **Rule 5.** The suite passes with `node_modules` absent and with Open Notebook,
  Ollama, Speaches and ffmpeg all unreachable.
- **Rule 8.** Every JSON write goes through `atomic.mjs`, and clips go through
  `writeFileAtomicSync`.
- **Main's preflight omits profile names**, because D5b's `renderShape` leaves them out.
  So the manifest records the requested episode and speaker profile names separately,
  for resume to re-run the preflight. This differs from September and is recorded in
  the plan.
- **QC passing is technical, not a review.** The thresholds stay September's. Re-tuning
  them waits for a real render in D5d2.
- **Test first**, with a red commit before each behaviour's code.

## Out of scope

- The routes, the `router.mjs` hook, guard tests, and whether resume and publish carry
  a `mutation_id`. Those are D5d2.
- A real render against the live services. That's D5d2, on a `/tmp/learn` copy and with
  your go-ahead.
- The library list that merges Open Notebook episodes, and the audio feedback sidecar.
- The view, which is D5e.
- Re-tuning September's thresholds.

## Success signals

- `npm test` passes with `node_modules` absent and no outside services running.
- State-machine tests with fakes cover these cases:
  - a clean run reaches `qc_passed`;
  - a section failing three times stops at `needs_review`, keeping each rejected
    response;
  - the retry count holds across a simulated restart;
  - resume reuses intact clips and re-voices a damaged one;
  - a speech failure ends `failed`, with the error recorded;
  - a manifest that fails validation is refused, and the files on disk are unchanged.
- Refusal tests cover these cases:
  - a source not in the topic's notebook;
  - a source over 150,000 characters;
  - a full queue;
  - a replayed `mutation_id` with different input;
  - resume after a digest, prompt or fingerprint change;
  - publish without `qc_passed`, without the confirmation, or after the candidate
    changed.
- Recorder tests show the exact requests sent to Ollama and Speaches.
- `git check-ignore` reports a rendition's clips and candidate as ignored and its
  manifest as not ignored.
- `git diff --numstat origin/main` lists only new files and `.gitignore` additions.

## Open questions

None for this slice. D5d2 settles whether resume and publish carry a `mutation_id`.
