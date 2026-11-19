---
change: 2026-11-11-chapter-render-routes
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: HTTP routes for the chapter renderer, and its first real render

## Files that change

- **`app/router.mjs`** gains `handlePodcastRenders(req, res, url)` and one dispatch line
  in `handleRequest`, before the `/api/` 501 catch-all. Nothing else in it changes.
- **`app/lib/podcastrender.mjs`** changes in one place: `modelRuntime` names Ollama when
  it can't reach it (spec concern 1, a recorded deviation).
- **`CLAUDE.md`** rule 9 gains one sentence about resume and publish (R9).
- **`app/test/podcastrenderroutes.test.mjs`** is new. It holds the route tests, R1 to
  R6.
- **`app/test/guard.test.mjs`** and **`app/test/degradation.test.mjs`** gain cases for R7
  and R8.

## How the route tests reach no real service

No test hook goes into production code. The tests use the seams that already exist,
the way `preflightfingerprint.test.mjs` does:

- **One local stub server** stands in for three services, through
  `STUDYDECK_ON_BASE_URL`, `STUDYDECK_OLLAMA_BASE_URL` and `STUDYDECK_TTS_BASE_URL`:
  - Open Notebook: `podcastProviderFixture` serves the profiles and models, and the
    test adds the notebook's source list and source detail;
  - Ollama: `/api/show`, `/api/tags` and `/api/chat`;
  - Speaches: `/v1/audio/speech`.

  These are inputs that get a request through, never assertions about those services'
  contracts (`.claude/rules/testing.md`).
- **A fake `ffprobe`** is set with `STUDYDECK_FFPROBE`. It's a small executable Node
  script in the temp root that prints a valid probe for any file, and only publish
  probes. CI has no ffmpeg (`podcastaudioffmpeg.test.mjs`), so no route test runs a
  render through assembly.
- **Renditions in a stage past rendering** are planted, not rendered. That means
  `qc_passed`, `published`, `failed` and an interrupted `queued`. Each is a manifest
  plus a `candidate.mp3`, written through `writeJsonValidated` as D5d1's tests do.
- **Renders in the background** after create or resume are left to fail at speech: the
  stub's `/v1/audio/speech` answers 500. A test that needs a render held running makes
  `/api/chat` wait on a promise the test releases. Each test awaits `idle()` before it
  checks the result.

## Order of work

Each step goes red, then green, in separate commits. Each red commit records its run.

1. **Ollama is named when it's down** (concern 1, R8).
   - Red: with `fetchJson` reaching a closed port, `prepareRendition` rejects with
     status 503 and a message beginning `Ollama unreachable at`. A real HTTP error from
     Ollama, such as a 404 from `/api/show`, keeps its own status. Both go through the
     real `fetchJson`, against a stub and a closed port, so the boundary that changes
     is the one tested.
   - Green: `modelRuntime` wraps its two calls. An error with no HTTP response becomes
     503 `Ollama unreachable at <baseUrl> (<reason>)`, where no HTTP response means a
     network failure or a timeout. Any other error is rethrown unchanged.
2. **The route group and create** (R1, R6).
   - Red cases:
     - 202 with a summary;
     - the same `mutation_id` with the same input gives the same id;
     - with different input, 409;
     - each malformed field gives 400;
     - an unknown topic gives 400;
     - `GET /api/podcast/renders` and `DELETE` on an item give 404 naming the route
       group, not the 501 catch-all.
   - Green: `handlePodcastRenders`, the dispatch line, and create.
3. **Read** (R2).
   - Red cases:
     - 200 with `rendition`, `transcript` and `transcript_attempts`;
     - an unknown id gives 404;
     - a malformed id gives 400, before any read;
     - an unknown `topic` gives 400;
     - a damaged manifest gives 409, and both files are byte-identical afterwards.
4. **Audio** (R3, concern 3).
   - Red cases:
     - GET gives 200, `audio/mpeg`, the ETag `"<qc sha256>"` and the file's bytes;
     - HEAD gives the same headers and no body;
     - `Range: bytes=0-9` gives 206 with 10 bytes;
     - a rendition without `audio_qc` gives 404;
     - a QC'd rendition whose `candidate.mp3` is gone gives 404 with
       `Candidate audio is not on this machine; re-render to listen`.
5. **Resume** (R4, concern 2).
   - Red cases:
     - a replay while the rendition is running (`/api/chat` held), then after
       `qc_passed`, then after `published`: the manifest is byte-identical after the
       replay;
     - an interrupted `queued` rendition is queued again;
     - a `failed` one is queued again too, which pins the behaviour;
     - `needs_review` gives 409, and an unknown id gives 404.
6. **Publish** (R5, concern 3).
   - Red cases:
     - with `full_listen_confirmed: true` on a `qc_passed` rendition, 200 and
       `published`;
     - a replay leaves the manifest byte-identical;
     - a missing or non-`true` confirmation gives 409, with the manifest unchanged;
     - a changed candidate gives 409;
     - a missing candidate gives 409 with the not-on-this-machine message, the manifest
       unchanged, and `ffprobe` never run.
7. **Guard and degradation** (R7, R8).
   - Guard red cases, for each of the three POSTs:
     - a cross-origin `Origin` is refused;
     - a non-JSON `Content-Type` is refused;
     - a `Host` that isn't loopback is refused;
     - and no response anywhere carries `Access-Control-Allow-*`.
   - Degradation red cases:
     - with Open Notebook unreachable, create gives 503 naming Open Notebook;
     - with Ollama unreachable, 503 naming Ollama;
     - the Open Notebook password is in neither response.
   - Some may be green on arrival, because the guard already wraps every route. If so,
     the commit says so and shows each test can fail, using a temporary mutation that
     is then reverted.
8. **Rule 9** (R9). One sentence in `CLAUDE.md`, beside the recovery POSTs:
   - resume and publish carry no `mutation_id`;
   - a replayed resume changes nothing while the rendition is queued, running or
     finished, and after `failed` it's a fresh resume;
   - a replayed publish returns the published rendition unchanged.
9. **Verify and ship.**
   - `npm test` with no `node_modules`.
   - `npm run verify`.
   - `security-review` on the branch diff.
   - Codex until `NO_FINDINGS`, then the PR, with every run posted.
10. **The first real render** (R10). This needs your go-ahead and your choice of
    chapter.
    - Copy the tree: `rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/`.
    - Start `STUDYDECK_LEARN_ROOT=/tmp/learn node app/server.mjs` from this worktree.
    - `curl` create, then poll read until the rendition reaches a final stage.
    - Record the stage, the QC values, the clip count, the wall time and any failure
      under Proof.
    - Play the audio route in the browser pane.
    - Confirm `git status` in your checkout is clean.
    - If it's before the PR merges, the outcome goes in the PR as a comment. If it
      reveals a route bug, that's a red test and a fix on this branch.

## Deviations from the spec

- **The item pattern takes any one path segment.** The spec's design named
  `render-[a-f0-9]{24}` as the item pattern. With that pattern, a malformed id would fall
  through to the group 404, but R2 asks for a 400. So the router captures any single
  segment, and `readRendition`'s own id check answers 400 before anything is read.
  Unmatched actions still get the group 404 (step 3).
- **Create reaches Ollama through the preflight first.** `podcastPreflight` checks
  Ollama's tags, and it already answers 503 `Generation unavailable: Ollama unreachable
  at ...`. So create named Ollama even before step 1. Step 1's change is what covers
  resume, which checks the model before it runs the preflight. Both are pinned in
  step 7, and the create case matches the message wherever it appears in the error.
- **Step 7 is one commit.** It added no production code, and every case was green on
  arrival. The commit records three temporary mutations, each reverted, that turn those
  cases red.

## Risks

- **The stub server is the test's view of three services.** If Open Notebook's source
  routes or Ollama's envelope change, these tests keep passing and the live render
  breaks. Step 10 is what notices, as the testing rules intend.
- **The held-running resume test depends on timing in one process.** It waits on a
  promise the test releases, never on a sleep, so it can't pass by luck.
- **Thresholds.** If the live render ends `needs_review` on QC, that's a recorded result
  and a separate slice, not a failure of this one.

## Proof

### Green, 2026-11-11

- **Tests:** `npm test` with `node_modules` absent passes 880 of 880, with none skipped.
  `npm run verify` finds no damage.
- **Diff:** `git diff --numstat origin/main` shows 1,185 lines added and 4 changed. The
  four are one line each in `CLAUDE.md` and `degradation.test.mjs` (an import), and two
  in `podcastrender.mjs`, where the two Ollama calls now go through `askOllama`.
- **Test first:** each step's red commit records its run.
  - Step 1's HTTP-error case and step 4's no-checked-audio case first passed for the
    wrong reason. The first is intended as a guard. The second now asserts its own
    message.
  - Step 7's mutations, all reverted:
    - running the render routes before `assertBrowserBoundary` fails the guard case;
    - undoing `askOllama`'s mapping fails the resume outage case;
    - making create swallow errors fails both create outage cases.
- **`security-review`** (a Sonnet subagent, read-only) found no vulnerabilities. It
  checked path traversal through the id and the topic, the fixed audio path, the
  guard's coverage, the new 503 messages, the `execFile` argument array to `ffprobe`, and
  the publish gate.
- **Codex** (`gpt-6.1-sol`): run 1 returned `NO_FINDINGS` at `02b2b5f`.

### The first real render, 2026-11-11 (step 10)

James's go-ahead covered fastbook 01, "Your Deep Learning Journey"
(`source:av8m2exksmxjsjoup6hi`, 31,165 characters), with profiles `study-chapter` and
`tech_experts-mixed-v2`.

- **Setup:**
  - learn root: a `/tmp/learn` copy;
  - port: 4320, from a scratchpad copy of `cockpit.config.json` passed with
    `STUDYDECK_CONFIG_PATH`, because the real cockpit holds 4310;
  - Open Notebook got reads only.
- **Create** answered 202 in 0.46 s, giving `render-a8cc8b99e34cd6438150fd69`.
- **Outcome:** `qc_passed`, 4 min 33 s after create.
  - The transcript took 172.6 s and speech took 75.0 s. `last_run_ms` was 272,612.
- **Model:** `qwen2.5:7b-instruct` at digest `845dbda0…`, with a 32,768-token capacity and
  16,384 used. The prompt was `chapter-dialogue-v5`.
- **Transcript:**
  - 3 sections, each passing on its first try, so 3 attempts and 0 rejected;
  - 16 turns and 705 words, against a 780-word budget.
- **Audio:**
  - 16 clips, 275.7 s, 4,412,204 bytes;
  - 153.9 words a minute;
  - integrated loudness −17.14 LUFS, true peak −1.7 dB, longest silence 0.7 s;
  - no issues and no repetitions.
  - Loudnorm measured an input of −21.94 LUFS at +3.40 dBTP, and the target was −16 LUFS
    at −1.5 dBTP.
- **The audio route:**
  - HEAD gave 200, `audio/mpeg`, `accept-ranges: bytes`, and the ETag equal to QC's
    sha256 `cf28f37c…`;
  - a 1,000-byte Range gave 206;
  - in the browser pane it played, seeked to 200 s, and reported a duration of 275.67 s,
    with no media error.
- **Your tree:** `git status` in your checkout was clean afterwards.
- **Not done:** James's full listen. Publish waits for it, and the candidate stays on
  the copy.
- **Thresholds:** September's QC thresholds passed this voice, so none tripped. That's
  one chapter, not evidence that they're tuned right.
