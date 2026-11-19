---
change: 2026-11-11-chapter-render-routes
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: []
claude_config_sha: d0fbd0f
---
# Spec: HTTP routes for the chapter renderer, and its first real render

## Flagged concerns

1. **Ollama being down doesn't produce "503 naming Ollama".**
   - Source: intent, *Proposed outcome* ("With Ollama unreachable, create answers 503
     naming Ollama").
   - `prepareRendition` reaches Ollama through `modelRuntime`, which calls `fetchJson`
     (`app/lib/httpjson.mjs`). A refused connection there becomes status 502 with
     fetch's own message, such as `fetch failed`. Nothing in it names Ollama.
     Open Notebook already does this right: `OpenNotebookError` is a 503 that reads
     `Open Notebook unreachable at <url> (...)`.
   - The intent also says `podcastrender.mjs` doesn't change unless a route test shows it
     must. This is that case.
   - **Recommended:** in `modelRuntime`, give a network failure from either Ollama call
     (an error that has no HTTP status from Ollama) status 503 and the message
     `Ollama unreachable at <baseUrl> (<reason>)`. A real HTTP error from Ollama keeps
     its status. It's a small lib change, recorded as a deviation, with a red test
     first.
   - **Resolution:** James, 2026-11-11: fix in `modelRuntime`, red test first, recorded as a deviation.
2. **Resuming twice after a failure re-runs the render.**
   - Source: intent, *Proposed outcome* and *Success signals* ("resume and publish, each
     replayed, leave the manifest byte-identical").
   - `resumeRendition` returns the rendition untouched only while it is queued or
     running, or once it is `qc_passed` or `published`. A failed rendition is resumable
     by design. So if the first resume ends at `failed` before a replayed one arrives,
     the replay re-queues it. That's one more attempt at local model and voice time.
     It's bounded, since each section's tries are counted in the manifest. It isn't a
     duplicate record, and it is what a second resume asks for.
   - Publish has no such case. A second publish of a `published` rendition returns it
     unchanged.
   - **Recommended:** keep no `mutation_id`, but state the claim precisely, in the tests
     and in rule 9. A replayed resume changes nothing while the rendition is queued,
     running or finished. After a failure, a replay is a fresh resume. The tests replay
     in those three states and show the manifest byte-identical. One more test shows
     that a resume after `failed` re-queues it, so the behaviour is pinned, not hidden.
   - **Resolution:** James, 2026-11-11: no `mutation_id`; state the claim precisely in the tests and rule 9, and pin the resume-after-`failed` re-queue.
3. **A missing candidate MP3 is a 500.**
   - Source: the D5d1 decision to git-ignore render audio. The MP3s exist only on the
     machine that rendered them, and a fresh clone has the manifest without the audio.
   - `sendLocalMedia` calls `statSync`, which throws `ENOENT`, and that becomes 500.
     Publish's `probeAudio` fails the same way.
   - **Recommended:** both routes check that `candidate.mp3` exists first. A missing file
     answers 404 on the audio route and 409 on publish, both with
     `Candidate audio is not on this machine; re-render to listen`. The manifest is
     unchanged. These are route checks, with no lib change.
   - **Resolution:** James, 2026-11-11: existence checks in the route, 404 on audio and 409 on publish.
4. **Policy skills: two not applied, and one deferred.**
   - Source: the spec skill's step 2.
   - **`design:ux-copy` and `design:accessibility-review`** have no surface here. The
     routes add no UI, and almost every message they return comes from D5d1's library,
     which is already merged. The new strings are limited to the 404s and validation
     400s. D5e, the view, is where these skills apply and where the messages get
     reviewed.
   - **`security-review`** reviews pending code, and there's none yet.
   - **Recommended:** run `security-review` on the branch diff before the PR, beside
     Codex. *Security and data* below covers what it checks. Apply the design skills in
     D5e.
   - **Resolution:** James, 2026-11-11: run `security-review` on the branch diff before the PR; apply the design skills in D5e.

## Requirements

Each traces to `intent.md`.

- **R1. Create.** `POST /api/podcast/renders` takes `topic_slug`, `source_id`,
  `mutation_id`, `episode_profile` and `speaker_profile`. It answers 202 with
  `{ rendition: <summary> }`.
  - The same `mutation_id` with the same input returns the same id.
  - With different input, it answers 409.
  - Malformed fields answer 400. *(Outcome table; rule 9.)*
- **R2. Read.** `GET /api/podcast/renders/:id?topic=` answers 200 with
  `{ rendition, transcript, transcript_attempts }`.
  - An unknown id answers 404.
  - A malformed id or unknown topic answers 400.
  - A damaged manifest answers 409 and leaves both files. *(Outcome table.)*
- **R3. Audio.** `GET` and `HEAD /api/podcast/renders/:id/audio?topic=` serve
  `candidate.mp3` as `audio/mpeg`.
  - The ETag is `"<audio_qc.asset.sha256>"`.
  - `Range` requests answer 206.
  - A rendition without QC'd audio, or without the file on disk, answers 404 (concern
    3). *(Outcome table.)*
- **R4. Resume.** `POST /api/podcast/renders/:id/resume` takes `{ topic_slug }` and
  answers 200 with `{ rendition }`. It carries no `mutation_id`.
  - Replayed while the rendition is queued, running or finished, the manifest stays
    byte-identical.
  - After `failed`, it re-queues (concern 2). *(Rule 9 decision.)*
- **R5. Publish.** `POST /api/podcast/renders/:id/publish` takes
  `{ topic_slug, full_listen_confirmed }` and answers 200 with `{ rendition }`. It
  carries no `mutation_id`.
  - It's refused with 409, leaving the manifest unchanged, unless
    `full_listen_confirmed === true`, the stage is `qc_passed`, and the candidate is
    present and unchanged.
  - A replay of a published rendition leaves it byte-identical. *(Outcome table.)*
- **R6. Unknown paths.** Any other method or path under `/api/podcast/renders` answers
  404 naming the route group. It never falls through to the 501 catch-all.
- **R7. Guard.** Each POST is refused if:
  - it's cross-origin;
  - its `Content-Type` isn't JSON;
  - its `Host` isn't loopback.

  No response carries an `Access-Control-Allow-*` header. *(Rule 12.)*
- **R8. Degradation.**
  - With Open Notebook unreachable, create answers 503 and the message names Open
    Notebook.
  - With Ollama unreachable, create answers 503 and the message names Ollama
    (concern 1).
  - No response contains the Open Notebook password. *(Being down is our behaviour.)*
- **R9. Rule 9 in `CLAUDE.md`** names resume and publish as routes that carry no
  `mutation_id`, with concern 2's precise claim. *(Intent, Affected systems.)*
- **R10. The first real render.** One chapter is rendered through the routes, on a
  `/tmp/learn` copy, to a final stage.
  - `plan.md` records the stage, the QC numbers, the duration and any failure.
  - The candidate plays from R3 in a browser.
  - Thresholds aren't retuned. *(Intent, live render.)*

## Design

- **Where:** `handlePodcastRenders(req, res, url)` inside `app/router.mjs`, following
  `handleRoles`, `handleFactcheck` and `handleMindmap`. It's dispatched by one line in
  `handleRequest`, before the `/api/` 501 catch-all:
  `if (url.pathname.startsWith('/api/podcast/renders')) return await handlePodcastRenders(...)`.
  No new module and no second handler.
- **Matching:** the collection is matched exactly at `/api/podcast/renders`. Each item
  is matched by
  `^/api/podcast/renders/(render-[a-f0-9]{24})(?:/(audio|resume|publish))?$`. A
  malformed id never reaches the filesystem, and `renditionDir` refuses one anyway.
- **Topic:** GETs take it from `?topic=`, as Roles and Diagnoses do. POSTs take
  `topic_slug` from the body. Both go through `assertKnownTopic`.
- **Validation:**
  - `source_id` and `mutation_id` use `assertIdentifier`, with `mutation_id` at a
    maximum of 120 characters;
  - the profile names use `assertString`, with a maximum of 200 characters;
  - `full_listen_confirmed` is passed through as given, and the library requires
    `=== true`.
- **Errors:** library errors carry `status`, and the top-level catch in `handleRequest`
  sends `{ error: err.message }` with that status. The route adds no catch of its own,
  apart from concern 3's two existence checks.
- **The queue lives in the server process.** A restart leaves an unfinished render
  `interrupted: true` in its summary until someone posts resume. Nothing resumes by
  itself.
- **The answer to the intent's open question:** a render that loses Ollama midway ends
  `failed`, with the message recorded (`renderRendition`'s catch). `failed` is
  resumable. This comes from reading `podcastrender.mjs`, and an R4 test pins it.
- **Tests:**
  - **Route tests** go in `app/test/podcastrenderroutes.test.mjs`. They call
    `handleRequest` directly, with a temp learn root. The library's real adapters are
    replaced with fakes, through a test-only seam (decided in the plan), so nothing
    real is reached.
  - **Guard cases** extend `app/test/guard.test.mjs`. **Degradation cases** extend
    `app/test/degradation.test.mjs`, using its unreachable `STUDYDECK_ON_BASE_URL` and
    an unreachable Ollama base URL.

## Security and data

- **Network boundary:** unchanged. The routes are inside `handleRequest`, so they
  inherit rule 12's loopback `Host` check, the JSON `Content-Type` and same-origin
  `Origin` requirements, and the security headers. Tests assert this (R7).
- **Rule 7:** a rendition holds no deck questions or answers. The read route returns the
  transcript and every attempt's model response. That's the learner's own generated
  material, with no grading secret in it.
- **Paths:** the id is matched by regex before use. The topic is checked against the
  known list. No other request value reaches a path.
- **Secrets:** the Open Notebook password stays server-side, and R8 asserts it's absent
  from every response. Ollama and Speaches take no credentials.
- **Data written:** only under `.learn/topics/<slug>/cockpit/audio/render-*/`, through
  `atomic.mjs` (rule 8). Nothing goes into `state.json` (rule 1).
- **The live run** writes only under `/tmp/learn`. Open Notebook gets GETs only.
- **Cost and abuse:** local only. The queue is capped (six held), and the guard keeps
  other tabs from starting renders.

## Acceptance checks

These seed `plan.md`'s Proof section.

- `npm test` with `node_modules` absent: every test passes, none skipped.
- `node --test app/test/podcastrenderroutes.test.mjs` covers R1 to R6, including:
  - byte-identical manifests after replayed resume (queued, running, finished) and
    publish;
  - the resume-after-`failed` re-queue;
  - 206 on a `Range` request;
  - 404 and 409 on a missing candidate.
- `node --test app/test/guard.test.mjs app/test/degradation.test.mjs` covers R7 and R8.
- `grep -n "resume\|publish" CLAUDE.md` shows the rule 9 sentence (R9).
- `git diff origin/main --stat` shows `router.mjs`, `CLAUDE.md`, tests and docs. It
  shows `podcastrender.mjs` only if concern 1 is accepted, and then as a recorded
  deviation.
- The live render (R10), on `/tmp/learn`:
  - `curl` create, then poll read until a final stage;
  - record the stage, the QC values, the clip count and the wall time;
  - load the audio route in the browser pane and play it;
  - check that `git -C <repo> status` is clean, which shows the real tree untouched.
- `security-review` on the branch diff, and Codex until `NO_FINDINGS`.

## Open questions

- None carried from the intent. The intent's question about losing Ollama midway is
  answered under *Design*.
- Which chapter to render live: James picks one when the run is ready.
