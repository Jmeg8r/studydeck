# Project assessment and code review

**Date:** 2026-07-27  
**Reviewed revision:** `d8d3c9b` (`main`)  
**Scope:** the personal StudyDeck/cockpit system (`app/`, `.learn/`, `tasks/`,
`learnings/`) and a separate, lighter review of the upstream course examples
(`examples/`, `helper/`).  
**Constraint:** assessment only. No implementation files or learning data were changed.

## Executive assessment

This is a thoughtful, unusually well-documented personal prototype. Its strongest
qualities are the explicit sources of truth, separation of learn-anything state from
cockpit sidecars, defensive parsing of local-model output, server-side secret handling,
path-containment checks, honest degradation when external services fail, and the
operational notes around Open Notebook and TTS. The current checked-in learning data is
internally consistent.

The cockpit is not yet dependable enough to treat as an authoritative study workflow
without supervision. The largest gap is not visual polish or framework choice; it is
that the product's core promises are stronger than the recorded data and test suite can
support. Calendar time is currently treated as workflow completion, answers can reach
the browser before a fact-check attempt is committed, repeated debriefs can lose cards,
and the mutation layer is neither crash-safe nor idempotent.

**Overall judgment:** strong single-user prototype, good architecture direction, but
the data-integrity and workflow-integrity items below should be addressed before adding
more features or more external-service automation.

## What is working well

- `AGENTS.md`, `tasks/study-flow.md`, and `tasks/study-cockpit-plan.md` clearly state
  where truth lives and prevent cockpit data from leaking into learn-anything's schema.
- Quiz deck reads reject traversal and strip answer fields before the initial deck is
  served (`app/lib/learn.mjs`, `app/lib/grading.mjs`).
- Open Notebook credentials are loaded server-side and are not serialized to the
  browser (`app/lib/config.mjs`, `app/lib/opennotebook.mjs`).
- Static files, videos, and deck files use containment or allowlist checks rather than
  blindly concatenating request paths.
- `extractJson` refuses to invent grades or cards from malformed model output
  (`app/lib/ollama.mjs`).
- Attempt history and derived weakness totals currently reconcile: the checked-in
  fastai topic has 7 graded items, 3 misses, 3 cards, and 0 unqueued misses in both the
  raw sidecars and `/api/state`.
- The worker-health preflight is narrow, well explained, and well tested. It is a good
  example of turning a real operational failure into a deterministic guard.
- The server, home page, state endpoint, and deck-list endpoint all completed a
  read-only runtime smoke check successfully.

## Prioritized findings

### P1 — Fix before relying on the cockpit as the study system of record

#### F1. Calendar passage is incorrectly used as evidence that study stages are done

`timelineFor` labels every milestone before the current date as `done`
(`app/lib/schedule.mjs:172`), while `buildQueue` retains only the current calendar
milestone and near-future milestones (`app/lib/derive.mjs:141`). There is no route or UI
action to mark a stage complete. `schedule.json.step_overrides` is defined but unused,
and `writeSchedule` has no caller.

This means an unfinished day-7 quiz disappears when day 10 arrives, even though the
spec says order matters and a missed step must remain owed. The UI can therefore imply
progress that never occurred and silently advance past required retrieval work.

**Recommendation:** record explicit stage-completion events in a cockpit sidecar and
derive the queue from the first incomplete prerequisite. Treat scheduled dates as
"not before" dates, not completion evidence. Add start, pause/resume, complete, undo,
and reschedule controls. Keep this out of `state.json`.

#### F2. Stored fact-check answers are exposed before a run is submitted

Claim generation strips `truth` and `correction` from its immediate response, but
`GET /api/factcheck` returns `readFactChecks(topicSlug)` verbatim
(`app/server.mjs:587` and `app/lib/factcheck.mjs:87`). The frontend removes the answer
fields only after the full records have already arrived in the browser
(`app/web/js/views/factcheck.mjs:145`).

This breaks the same answer-secrecy rule the quiz flow carefully protects. Anyone
opening browser network tools can see every truth value before attempting the exercise.

**Recommendation:** create one server-side answer-stripping function for claim records
and use it on every pre-submit response, including list/read endpoints. Add a regression
test that recursively rejects `truth` and `correction` in the browser payload.

#### F3. Quiz answers can be revealed and the attempt can then be discarded

`POST /api/decks/:topic/:file/grade` is explicitly a write-free dry run
(`app/server.mjs:118`). The results screen reveals all answers and then offers separate
**Record attempt** and **Discard** actions (`app/web/js/views/testcenter.mjs:158`).

The learner can therefore reveal a failed pretest, discard it, and retake with prior
answer exposure. That makes the append-only attempt history incomplete and weakens the
pretest baseline the design is intended to protect.

**Recommendation:** create the attempt before revealing answers. One approach is a
server-issued attempt ID at deck start, followed by a single submit operation that
grades, records, and reveals atomically. Self-graded questions can remain pending on
that same attempt and be finalized later; abandoning the screen should not erase the
submitted auto-graded result.

#### F4. A second walk debrief on the same day can silently lose generated cards

Debrief card IDs are `card-debrief-<date>-<position>`
(`app/server.mjs:763`). Every debrief starts positions at 1. A second debrief on the
same day collides with the first one's IDs, causing the new drafts to be skipped even
though the Open Notebook note may have been saved successfully.

This affects a mandatory capture-back step and can lose exactly the misconceptions the
system is supposed to retain.

**Recommendation:** assign every debrief a UUID and derive card IDs from
`debrief_id + item_index`, or hash stable normalized card content. Return and persist a
submission ID so an actual retry is idempotent while a distinct same-day debrief remains
distinct.

#### F5. Mutation storage is not crash-safe, transactionally complete, or idempotent

JSON sidecars and `state.json` are written directly with `writeFileSync`
(`app/lib/sidecar.mjs:62`, `app/lib/mastery.mjs:89`). A process or machine failure
during truncate-and-write can leave a corrupt file. The render rollback protects one
validation failure, but it is not a filesystem transaction. Append endpoints also lack
request IDs, so a response lost after a successful append can cause a retry to record
the attempt, review, grade, or mastery change twice.

The documented single-writer convention also does not prevent a CLI session from
overwriting an in-app state update between read and write.

**Recommendation:** use atomic temp-file + flush + rename writes for JSON files; retain
the last known-good copy; add mutation IDs and deduplicate append-only records; add a
per-topic lock or optimistic revision check around `state.json` + render. Expose partial
commit/recovery status in a health endpoint.

#### F6. Tests cover a small fraction of the behavior carrying the most risk

The app has about 6,569 lines of runtime JavaScript and 226 lines of tests. All 16 tests
pass, but they exercise only the `.DS_Store` deck-scan regression and podcast
worker-health helpers. There is no automated coverage for grading, answer stripping,
schedule progression, card intervals, sidecar corruption, stats reconciliation,
mastery rollback, API routing, request limits, uploads, markdown safety, podcast retry
selection, or any browser workflow.

**Recommendation:** prioritize tests over new features. Start with table-driven unit
tests for schedule/cards/grading/stats, temporary-directory integration tests for every
mutation and rollback path, and a small browser suite for pretest secrecy, fact-check
secrecy, multi-topic selection, reading cleanup, and debrief retries. Inject filesystem
roots, clocks, model clients, and Open Notebook clients rather than touching real data.

### P2 — Address in the next reliability/usability pass

#### F7. Multi-topic support exists in state derivation but not in most work surfaces

The queue and flashcards interleave topics, but Reading, Mind Map, Fact-Check, Essay,
and Debrief all silently select `state.today.topic_slug` or the first configured topic
(`app/web/js/views/reading.mjs:166`, `mindmap.mjs:64`, `factcheck.mjs:118`,
`essay.mjs:13`, `debrief.mjs:10`). There is no global topic selector.

With two active topics, the secondary topic's source work, essays, map, fact-checks, and
debriefs are effectively inaccessible unless it happens to become the primary topic.

**Recommendation:** add a global, persisted topic selection and pass it explicitly to
every view. Keep "today's recommended topic" separate from "topic I am currently
working on."

#### F8. Loopback binding is useful but is not a complete browser security boundary

Mutating routes do not validate `Origin`, `Host`, or `Content-Type`, and there is no
CSRF token. Because `readJsonBody` accepts JSON bytes under any media type, a hostile
web page can issue a simple cross-origin `text/plain` POST that causes a side effect
even though it cannot read the response. The service can create notes and profiles,
change learning data, and start expensive local jobs. DNS rebinding is another reason
not to equate loopback with authenticated browser intent.

Uploaded SVG sketches add an active-content surface: SVG is accepted, stored, and
served as `image/svg+xml` on the app's own origin (`app/lib/mindmap.mjs:18`,
`app/server.mjs:886`). The server also omits basic browser hardening headers.

**Recommendation:** require an exact expected `Origin`/`Host` on mutations, require
`application/json`, and use a random boot-scoped CSRF token. Add CSP,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, and frame restrictions. Reject
SVG sketches or sanitize/rasterize them before same-origin serving.

#### F9. The advertised sketch size and the actual request limit contradict each other

The request body limit is 1,000,000 bytes (`app/server.mjs:42`), but sketch storage
advertises an 8 MiB decoded-image limit (`app/lib/mindmap.mjs:15`). Base64 increases
size by roughly one third, so the request layer rejects images larger than about
750 KiB before the 8 MiB validation can run. The browser performs no preflight size
check or compression.

**Recommendation:** either use a bounded binary/multipart upload route sized for the
documented limit, or intentionally reduce the limit and resize/compress in the browser.
Return a normal 413 response; currently destroying the request socket on overflow may
surface as a connection reset instead of usable JSON.

#### F10. Podcast retry identity is based on non-unique titles

Batch retry groups every Open Notebook episode globally by name and considers a chapter
done or in flight when any same-name episode matches (`app/server.mjs:396`). Two
notebooks with an identical chapter title can cause a missing episode to be skipped,
or a terminal row from the wrong notebook to be deleted. The comments acknowledge the
collision risk, but the "done" and "in flight" checks are also affected.

**Recommendation:** persist a cockpit batch manifest mapping
`topic_slug + source_id -> episode/job ID`, and use a unique generated episode name as
a fallback. Do not infer durable identity from a display title.

#### F11. Setup documentation and runtime metadata disagree with the repository

- `README.md` says Node 18+, while installed `node-llama-cpp` requires Node 20+.
- The README's run commands use paths such as `node intro/intro.js`, but the files are
  under numbered `examples/` directories.
- The main README does not explain that the repository also contains the private
  StudyDeck application or how to run it.
- `package.json` has no `engines`, `start`, cockpit admin, or validation scripts, and
  still has placeholder package metadata.
- The README's architecture progression stops at eight stages even though 15 examples
  are documented later.

**Recommendation:** document the two project lanes up front, set the supported Node
engine, correct commands, add `npm start` and focused validation/admin scripts, and
provide a short cockpit operations guide. Keep upstream-oriented course text clearly
separate from personal-system instructions.

#### F12. Corruption and malformed-input diagnostics are console-only or invisible

Malformed JSONL lines are skipped, corrupt JSON sidecars fall back to empty values
(`app/lib/sidecar.mjs:22`), and malformed decks disappear from listings
(`app/lib/learn.mjs:77`). The browser can consequently report "no cards" or omit a deck
when the real condition is corrupted data. Logging to a terminal is not enough for a
cockpit that is expected to reveal state accurately.

**Recommendation:** include non-secret diagnostics in `/api/state` or `/api/health`,
show a persistent warning banner, and provide a read-only validation command that checks
every state, sidecar, deck, cross-reference, and rendered map before a study session.

#### F13. The server blocks all requests during synchronous state mutation and render

Most filesystem work is synchronous, and mastery updates use `execFileSync` with a
30-second ceiling (`app/lib/mastery.mjs:114`). Because the server is a single Node event
loop, one slow render prevents health checks, static assets, and every other request
from being served during that interval.

**Recommendation:** serialize mutations through a small async per-topic queue, run the
renderer asynchronously, and keep read endpoints responsive. This can remain
dependency-free.

### P3 — Course-example and maintainability improvements

#### F14. The memory example treats every read failure as "no memory"

`MemoryManager.loadMemories` catches missing files, invalid JSON, and permission/I/O
errors identically and returns an empty store (`examples/08_simple-agent-with-memory/
memory-manager.js:12`). The next save can overwrite a damaged or temporarily unreadable
memory file, converting a diagnosable problem into data loss. Writes are also non-atomic.

**Recommendation:** only treat `ENOENT` as an empty store; surface parse and I/O errors,
preserve/rename corrupt input for recovery, validate the schema, and write atomically.
Add isolated tests for migration, duplicate updates, corruption, and concurrent saves.

#### F15. Course examples are syntax-checked but not behavior-tested or smoke-runnable

All JavaScript parsed successfully, but the test command excludes every example.
Examples hard-code model filenames and perform top-level model initialization, making
cheap tests difficult and cleanup dependent on the happy path. The OpenAI example also
hard-codes model choices throughout rather than accepting one configuration value.

**Recommendation:** extract pure planning, routing, parsing, memory, and tool functions
from model bootstrapping; add deterministic tests with fake model/tool adapters; wrap
resource ownership in `try/finally`; and add a `--smoke` or fixture mode that does not
load multi-gigabyte models. Keep changes to upstream course material separate from
personal cockpit work.

#### F16. External-client errors and media behavior could be more diagnosable

The request-path Open Notebook client drops upstream error bodies and assumes every
successful response is JSON (`app/lib/opennotebook.mjs:49`), while the admin client is
more defensive. Podcast audio is proxied without byte-range support even though local
video correctly implements it, limiting seek/resume behavior. Source and episode detail
routes also accept raw IDs without confirming they belong to a configured topic.

**Recommendation:** unify safe error parsing, handle 204/non-JSON success responses,
forward validated audio ranges, and scope browser-facing IDs to resources returned for
configured notebooks.

## Recommended implementation order

1. **Workflow integrity:** explicit stage completion, safe fact-check payloads,
   commit-before-reveal quiz attempts, and collision-free debrief IDs.
2. **Durability:** atomic writes, mutation IDs, state revision/locking, recovery
   diagnostics.
3. **Proof:** comprehensive unit/integration tests around every item above before
   adding features.
4. **Usability:** global topic selection and accurate start/pause/reschedule controls.
5. **Boundary hardening:** origin/content-type/CSRF checks, security headers, and safe
   image handling.
6. **Operations:** correct README/runtime metadata, validation commands, and podcast
   identity manifest.
7. **Course maintenance:** testable example seams and memory-example recovery behavior.

## Verification performed

- `npm test`: **16 passed, 0 failed**.
- `node --check` across all `.js`/`.mjs` files in `app/`, `examples/`, and `helper/`:
  **passed**.
- Read-only runtime smoke:
  - `GET /` → 200
  - `GET /api/state` → 200
  - `GET /api/decks` → 200
- Parsed both topic state files, the checked-in quiz deck, cockpit config, and all
  podcast profile snapshots as JSON: **valid**.
- Reconciled checked-in attempt/card totals against `/api/state`: **matched**.
- Confirmed `.env`, local models, generated videos, and `.DS_Store` files are ignored
  and not tracked.

## Verification limits

- No mutating API was exercised, to preserve the user's learning data and comply with
  the assessment-only constraint.
- Model-backed course examples, essay grading, fact-check generation, TTS, and podcast
  rendering were not run end to end.
- A current `npm audit` result could not be obtained because registry advisory access
  was unavailable in the review environment. Dependency vulnerability status is
  therefore unverified by this assessment.
- This was a focused code and runtime review, not measured line/branch coverage,
  penetration testing, accessibility testing, or load testing.

