---
change: 2026-11-10-podcast-rendition-identity
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a podcast request settles only against its own rendition, and an unusable profile is refused before rendering

## Files that change

- **`app/lib/podcastbatch.mjs`**
  - `TAG_PATTERN` gains an optional rendition group: `` · sd-([0-9a-f]{8})(?:-r-([0-9a-f]{16}))?$ ``.
  - `episodeNameFor(topicSlug, sourceId, title, mutation = null)` appends
    `-r-<sha256(topic\nsource\nmutation)[0..16]>` when a mutation is given. With no
    mutation, names are byte-identical to today's.
  - New exports:
    - `sourceTag(name)`;
    - `hasRendition(name)`;
    - `matchRendition(episodes, name)`, which returns the single exact match on a
      rendition name, and otherwise `null`.
  - `displayEpisodeName` strips both parts.
  - `planRetry` gathers a source's owned rows by `sourceTag`, not by exact name.
- **`app/lib/podcastcatalog.mjs`**
  - `episodeNotebookIndex` indexes owners by source tag as well as by exact name, so a
    rendition-named episode that isn't in the operation ledger still maps to its notebook.
  - A tag that two notebooks share stays unattributed (`null`), which is today's rule.
- **`app/lib/opennotebook.mjs`**
  - New `podcastPreflight({ episodeProfile, speakerProfile })`, ported from the snapshot.
    It runs read-only GETs of episode profiles, speaker profiles and models, then
    `listVoices()` from `lib/tts.mjs`, then Ollama's `/api/tags` when a selected model is
    Ollama-backed.
  - It throws `OpenNotebookError`: `422` with every missing item listed, or `503` when
    Ollama is unreachable.
  - It returns the selected models. No caller stores them in this slice.
- **`app/lib/config.mjs`**
  - Adds a `STUDYDECK_TTS_BASE_URL` override for `config.tts.baseUrl`, mirroring the ON
    and Ollama seams, so the egress tests can point TTS at the stub.
- **`app/router.mjs`**
  - **Standalone route:** names the episode
    `episodeNameFor(topic, 'notebook:<id>', title, mutation)`. The caller's title is
    still validated as `episode_name`.
  - **`runStandalonePodcastOperation`:**
    - runs the preflight after the replay checks and before the `prepared` stage;
    - settles `prepared` and `ambiguous` operations with
      `matchRendition(listEpisodes(), local_result.episode_name)`.
  - **`runPodcastEpisodeOperation`:** settles with `matchRendition` too.
  - **Batch route:**
    - runs the preflight once, after the notebook and sources checks and before
      planning, deleting or rendering (dry runs included);
    - maps targets to rendition names after `planRetry` and the deletes;
    - `blockedNames` becomes `blockedTags`, keyed by `sourceTag`.
- **`app/test/fixtures/podcast-provider.mjs`** (new): the snapshot's read-only provider
  fixture (profiles, speakers, models, voices, tags), with an `incomplete` switch.
- **`app/test/podcastegress.test.mjs`**
  - The stub serves the fixture, and the TTS and Ollama seams point at it.
  - Two tests are ported:
    - *an older rendition cannot settle a new ambiguous render with the same title*;
    - *an incomplete selected profile is refused before generation*.
  - The existing job-status tests stay.
- **`app/test/batchegress.test.mjs`**: the stub serves the fixture, plus a batch
  rendition test. A dropped chapter render isn't settled by that chapter's earlier
  recording.
- **`app/test/podcastbatch.test.mjs`**:
  - unit tests for the rendition name, `sourceTag`, `matchRendition` (one match, none,
    two, a legacy name) and `displayEpisodeName`;
  - `planRetry` treats a rendition-named finished row as done.
- **`app/test/podcastcatalog.test.mjs`**: a rendition-named episode maps to its notebook
  by tag.

## Order of work

1. Commit this intent and plan as drafts. James accepts them in a separate commit.
2. **Red.** Write the new tests and fixture wiring. Run `npm test` and confirm they fail
   for the right reason:
   - the rendition test gets `202`, not `409`;
   - the profile test gets `202`, not `422`;
   - the naming units fail because the exports don't exist;
   - the `planRetry` rendition test re-targets a finished chapter.

   Commit the failing tests with the red run in the message (rules-loaded hook: Read
   both `.claude/rules/*.md` first).
3. **Green, naming:** `podcastbatch.mjs`, then `podcastcatalog.mjs`.
4. **Green, settling:** `matchRendition` in both operation runners, and the rendition
   names in both routes.
5. **Green, preflight:** `podcastPreflight` and the config seam, then the two route
   calls.
6. Run `npm test` with `node_modules` absent, and `npm run verify`.
7. Run the live probes in **Proof**, record them here, and open the PR.

## Risks

- **Mass re-render.** If `planRetry` kept matching by exact name, every chapter
  rendered under a rendition name would look missing, and a retry would re-render the
  notebook (about thirty minutes per chapter). The `planRetry` rendition test guards it.
- **Deleting the wrong row.** Deletion must still require the source tag. Today's
  legacy-row tests stay, and none is loosened.
- **Preflight false refusal.** A live profile could fail a check the stub passes.
  Probed on 2026-11-10 with read-only GETs against live ON, TTS and Ollama:
  - `study-chapter`, `study-deep-dive`, `study-overview` and `tech_discussion` pass;
  - `business_analysis` and `solo_expert` are refused (no outline or transcript model),
    which is correct.
- **Extra upstream calls.** Each generate now makes up to five GETs first. They're
  local services, and a slow one fails with the existing timeout rather than hanging.
- **Existing stubs lack the profile routes.** Every egress test that reaches a generate
  must serve the fixture, or it'll get a `503` or `422` it didn't expect. The change
  lists the two files and nothing else.

## Proof

- `npm test` passes with `node_modules` deleted, including the new red-then-green tests.
- `npm run verify` is clean.
- Live and read-only:
  - re-run the preflight probe against live ON, TTS and Ollama, and record the
    per-profile verdicts;
  - start the scratch server on port 4319 with `STUDYDECK_LEARN_ROOT=/tmp/learn` and
    `GET /api/on/podcast` to confirm existing episodes still show clean display names
    with the right notebooks.
- Live and mutating, only with James's go-ahead, because it renders a real episode:
  one standalone render with `study-chapter`. It should be named with a `-r-` rendition
  and play back. Otherwise this stays manual.

### Results, 2026-11-10

**Red** at `df29c3c`, against `main` `7ef47ff`, running the four touched files with no
`node_modules`: 39 tests, 33 pass, 6 fail. Each fails for the intended reason:
- the standalone retry got `202`, where `409` was expected;
- the incomplete profile got `202`, where `422` was expected;
- the batch re-render had `accepted: true`, where `false` was expected;
- `planRetry` targeted the chapter of a finished rendition again;
- a failed rendition wasn't marked deletable;
- `podcastrendition.test.mjs` failed to load because the exports were missing.

The control, another notebook's rendition, passed on `main` as it should.

**Green** at `f255b0f`:

| Check | Result |
|---|---|
| `npm test`, no `node_modules` | 615 tests, 615 pass (604 before, 11 new) |
| `npm run verify` | "No damage found" |
| Live preflight, the real `podcastPreflight` | `study-chapter`, `study-deep-dive`, `study-overview` and `tech_discussion` PASS. `business_analysis` and `solo_expert` get `422`, with outline and transcript models unset |
| `GET /api/on/podcast`, cockpit on `main` (4310) vs scratch server (4319) | 24 episodes on both, 0 differing `id`/`display_name`/`notebook_id` rows, 21 attributed to a notebook, no tag left in a display name |
| Batch dry run on fastai, `retry_only`, `study-chapter`, scratch server | `200`: 1 to generate, 0 to delete, 20 skipped, 20 legacy skips |
| The same dry run on the `main` cockpit | identical: 1, 0, 20, 20 |
| Batch dry run with `business_analysis`, scratch server | `422` before planning |

**Not run:** the mutating live render. It waits for James's go-ahead.

## Deviations

- **The preflight runs before the `started` operation is written, not just before
  `prepared`.** A refused request leaves nothing in the ledger. That assertion was added
  to the incomplete-profile test after the fix, so it wasn't test-first. Control: with
  the preflight moved below the ledger write, the assertion fails.
- **The catalog falls back to the chapter name; it doesn't index by tag.**
  `notebookForEpisode(index, name)` tries the exact name, then `chapterName(name)`, which
  is the name with the rendition stripped. Today's rule that an ambiguous name gets
  `null` still applies, and `podcastStatus` uses it for `notebook_id`.
- **`ollama.mjs` gains `listModelNames`.** It keeps the Ollama call in Ollama's client.
  It throws `503` rather than returning `[]`, so a service that's down isn't read as
  "nothing pulled".
- **The new catalog and naming tests live in a new `podcastrendition.test.mjs`.** On
  `main` it fails to load. That keeps the missing exports from taking the existing
  catalog and batch tests down with it. `podcastcatalog.test.mjs` is unchanged.
- **The preflight returns `{ models }` only.** There's no fingerprint or snapshot, since
  storing provenance is out of scope (D5).
- **Codex run 1 (at `f255b0f`): GATE PASS, two P2 findings, both fixed test-first.**
  - *Replay compatibility.* A request recorded before renditions has its plain title
    (standalone) or its chapter name (batch) in `local_result.episode_name` and in
    `input_hash`. Under the new names, its replay answered `409 different input`.
    - Both runners now check and replay such an operation under its recorded name.
    - A legacy name has no rendition, so it can still never settle an ambiguous request.
    - Red at `027d0a4`: legacy standalone `409`, legacy batch `accepted: false`, and a
      legacy request left in doubt refused for its input instead of its outcome.
    - Fixed in `60a2ebf`.
  - *Untagged Ollama models.* ON can register `qwen2.5`, which Ollama lists as
    `qwen2.5:latest`.
    - The preflight now compares both sides in tagged form.
    - The fixture now lists the pulled model as Ollama does, `fixture-language:latest`.
    - Red: `422 fixture-language not present in Ollama`.
  - Full suite after the fixes, no `node_modules`: 619 tests, 619 pass.
- **Codex run 2 (at `12fcf5d`): GATE PASS, one P2, fixed test-first.** The batch ran its
  preflight before the replay checks, so a lost-response retry of an accepted batch
  answered `503` whenever Speaches or Ollama was down. The standalone route already
  checks for a replay first.
  - The batch now skips the preflight only when nothing new would be sent: no deletes,
    and every target's child operation is recorded `complete`, `prepared` or
    `ambiguous`.
  - New work, and every dry run, is still checked first.
  - Red at `fef2191`: the replay got `503 Speaches voices → 500`. The control in the
    same test requires new work under that outage to get `503` with no mutating request.
  - Full suite: 620 tests, 620 pass. `npm run verify` is clean.

## Options not taken

- **Match the newest episode by `created` time.** Open Notebook's clock and ours
  disagree, and two renders can land within the same second. A name we choose is the
  only identity ON echoes back (see `podcastbatch.mjs`'s header).
- **Store a manifest of accepted episode ids.** A generate returns no episode id, so
  there is nothing to store until a match is made, and that match is what we're
  deciding.
- **Profile completeness only.** It would refuse the two stock profiles but miss a
  missing voice or an unpulled Ollama model, which also fail late in the worker. James
  chose the full preflight on 2026-11-10.
- **Port Recovery here.** It's a new surface, and its `settle` route touches mastery,
  so it's its own slice.
