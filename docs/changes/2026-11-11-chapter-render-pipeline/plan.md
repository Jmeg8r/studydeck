---
change: 2026-11-11-chapter-render-pipeline
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the chapter render pipeline, as a module with no caller yet

## Files that change

All the code files are new. The only existing file that changes is `.gitignore`, and
only by added lines.

- **`app/lib/podcastrender.mjs`** is September's module, ported onto `main`'s
  foundations. It exports:
  - `renditionDir`, `readRendition`, `listRenditions` and `renderSummary`;
  - `prepareRendition(input, deps)`, `renderRendition(manifest, deps)`,
    `resumeRendition(topic, id, deps)` and `publishRendition(topic, id, reviewed, deps)`;
  - `idle()`, which resolves when the queue has drained. Tests use it, and so will
    D5d2's route tests.

  `deps` is optional, and each field defaults to the real adapter:
  - Open Notebook: `notebookForTopic`, `listSources`, `readSource`, `podcastPreflight`;
  - D5c's tools: `audioTools`, `probeAudio`, `assembleAudio`, `checkAudio`;
  - `fetchJson` for Ollama, and `fetch` for Speaches.

  September's prompt, numbers, stages and messages carry over unchanged. Any change from
  September is recorded under Deviations.
- **`app/test/podcastrender.test.mjs`** holds the state machine and refusal tests,
  using fakes and a temp learn root.
- **`app/test/podcastrenderegress.test.mjs`** holds the recorder tests for the requests
  sent to Ollama and Speaches.
- **`app/test/audioignore.test.mjs`** asks git which render paths are ignored, in the
  same pattern as `transcriptignore.test.mjs`.
- **`.gitignore`** gains `.learn/**/cockpit/audio/**/*.mp3` and
  `.learn/**/cockpit/audio/**/concat.txt`, with a comment saying why.

## Order of work

Each step goes red, then green, in separate commits.

1. **The ignore rule.**
   - Red: a rendition's clip, `candidate.mp3`, `candidate.part.mp3` and `concat.txt`
     are ignored. Its `manifest.json` and `manifest.json.bak` are not. As a control,
     `attempts.jsonl` beside them is not ignored either.
   - Green: the `.gitignore` lines.
2. **The manifest.**
   - Red cases:
     - `renditionDir` refuses an id that isn't `render-` followed by 24 hex characters.
     - `readRendition` returns `null` when the manifest is missing.
     - It refuses with 409 when the transcript digest doesn't match, the shape is
       invalid, or the read came from the backup. The bytes on disk are unchanged
       afterwards.
     - `listRenditions` returns `[]` for a missing folder. It shows a damaged manifest
       as a `needs_repair` row rather than throwing. Among published renditions of the
       same source, only the newest is marked preferred.
   - Green: the manifest layer, on D5b's `readJsonValidated` and `writeJsonValidated`.
3. **Prepare.**
   - Red refusals:
     - the source isn't in the topic's notebook;
     - the source is over 150,000 characters;
     - the queue already holds six;
     - the model isn't from Ollama, or its context window is below 4,096;
     - there's no installed model digest.
   - Red replays:
     - the same `mutation_id` with the same input returns the existing rendition, and
       creates no second folder;
     - with different input, it's refused with 409;
     - two calls at the same time share one preparation.
   - Red manifest contents: the manifest records the requested profile names in
     `input`.
   - Green: `prepareRendition`, `modelRuntime` and the queue.
4. **The render state machine, with fakes.**
   - Red cases:
     - A clean run ends at `qc_passed`, with the transcript digest, clips in order,
       the normalization result and the audio QC recorded.
     - A section that fails three times ends at `needs_review`, and each rejected
       response is kept.
     - The retry count holds across a restart: the test re-runs a manifest that
       already has two failed tries, and only one more is made.
     - A resume reuses a clip whose sha256 still matches. It re-voices only a clip
       whose file is damaged.
     - A thrown speech error ends at `failed`, with the message recorded.
     - Two clips with the same sha256 end at `failed`.
     - Failed audio QC ends at `needs_review`.
   - Green: `renderRendition`, `generateSegment` and `synthesize`.
5. **Resume and publish.**
   - Red cases for resume:
     - a missing rendition gives 404;
     - `needs_review` gives 409;
     - a changed model digest, prompt version or fingerprint each gives 409;
     - a running or finished rendition returns as it is, without queueing again;
     - an `interrupted` rendition is queued again;
     - resume calls the preflight with the profile names stored in `input`.
   - Red cases for publish:
     - it's refused unless the stage is `qc_passed` and `reviewed === true`;
     - it's refused when the candidate's sha256 no longer matches the one QC measured;
     - publishing twice returns the published rendition unchanged.
   - Green: both functions.
6. **Egress recorders.**
   - Red cases for the exact requests sent:
     - Ollama `/api/show` and `/api/tags`, with the model name;
     - Ollama `/api/chat`: model, `num_ctx`, `num_predict`, `temperature`, `format`,
       and the speakers and passages in the user message;
     - Speaches `/v1/audio/speech`: model, input, voice, `mp3`, speed 1.
   - Red parsing cases:
     - a chat reply wrapped in a code fence is parsed through `extractJson`;
     - an unparseable reply counts as a failed try. Nothing is made up in its place.
   - Some of these may be green on arrival after step 4. If so, the commit says so and
     shows the test can fail with a temporary mutation that is then reverted.
7. **Verify and ship.**
   - `npm test` with no `node_modules`.
   - `npm run verify`.
   - The `numstat` shows new files and `.gitignore` additions, with 0 deleted lines.
   - A grep shows nothing outside the tests imports `podcastrender.mjs`.
   - Codex until `NO_FINDINGS`.
   - The PR, with every run posted.

## Deviations from September

- **Every outside service is injectable through `deps`**, not just in
  `renderRendition`. That way the refusals in prepare, resume and publish are tested.
- **The manifest goes through `readJsonValidated` and `writeJsonValidated`.**
  September passed a validator to `readJsonSafe` and `writeJsonAtomicSync`, which on
  `main` take none. As in September, a backup or fallback read is refused rather than
  served.
- **The manifest records `input: { source_id, episode_profile, speaker_profile }`.**
  D5b's `renderShape` omits profile names, so resume can't take them from
  `configuration` the way September did.
- **`idle()` is exported**, so tests await the queue instead of sleeping.

## Deviations from this plan

- **Step 1: the manifest's `.bak` is ignored, not kept.** The plan said
  `manifest.json.bak` would not be ignored. But `.gitignore:20` already ignores
  `.learn/**/*.bak`, so no backup under `.learn/` is ever committed. The first red run
  failed the control on that path. The test now checks `manifest.json` and
  `attempts.jsonl` as the not-ignored control, and its comment says why.

## Risks

- **The in-process queue is gone after a restart.** That's intended: an unfinished render
  shows as `interrupted` until it is explicitly resumed. Nothing calls this module in
  D5d1, so the risk becomes real only in D5d2.
- **The fakes encode assumptions about Ollama and Speaches.** The recorders pin only
  what this app sends. Whether the real services accept it is shown by D5d2's live
  render, not here.
- **The thresholds are still September's.** A real voice may trip them, and D5d2's live
  render is where that shows up.

## Proof

### Green, 2026-11-11

- **Tests:** `npm test` with `node_modules` absent passes 850 of 850, with none skipped.
  `npm run verify` finds no damage.
- **Additive only:** `git diff --numstat origin/main` shows 1,442 lines added and 0
  deleted, across new files and `.gitignore` additions.
- **No caller:** `grep -rl podcastrender.mjs app` finds it only under `app/test/`.
- **Test first:** each step's red commit records its run.
  - Step 1's first control assertion was wrong, and was corrected before it was
    pushed (Deviations from this plan).
  - Steps 3 and 4 share one green commit.
  - The step 6 recorders were green on arrival. Three temporary mutations made all
    three fail, and were then reverted.
- **Codex** (`gpt-6.1-sol`) ran three times:
  - **Run 1:** three P2 findings, all fixed test-first (`59ef6d2` red, `770db6c` green).
    They covered an untagged model name's digest lookup, a reply whose turns aren't
    objects, and evidence dropped on the whole-transcript rejection path.
  - **Run 2:** one P2, a stale resume saving over a manifest that had moved on (`0b0cd77`
    red, `33b867b` green). The first test written for it passed against the unfixed
    code, so it was dropped, and the commit says why.
  - **Run 3:** `NO_FINDINGS` at `33b867b`.
- **Not verified here:** a real render against Ollama, Speaches and ffmpeg. That's
  D5d2's live run, on a `/tmp/learn` copy, with James's go-ahead.
- **Steps 3 and 4 share one green commit.** The queue that `prepareRendition` fills runs
  `renderRendition`, so prepare couldn't go green without the state machine. Both red
  commits landed first: `fc34ff1` for prepare and `f2da86f` for the state machine. A
  single green commit then made all 20 tests pass.
