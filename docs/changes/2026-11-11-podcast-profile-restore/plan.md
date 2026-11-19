---
change: 2026-11-11-podcast-profile-restore
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: profile restore checks everything before its first write, and names a model by provider as well as type and name

## Files that change

- **`app/podcast/on.mjs`.** `modelIndex` is ported from the snapshot's model logic. The
  snapshot's `onFetch` rewrite is not.
  - `idToRef` returns `{ provider, type, name }`.
  - `refToId(type, ref, provider?)` accepts a plain name or a portable object. It throws
    a 422 `OnError` when more than one registered model matches, and when an object's
    `type` disagrees with the requested type.
- **`app/podcast/restoreplan.mjs`** (new). It holds `planRestore(want, available,
  existingSpeakers, existingEpisodes)`, ported from the snapshot. It checks:
  - all inputs are arrays, and names are not duplicated;
  - every model in `models.json` is registered;
  - each speaker profile has a non-empty `name` and non-empty `speakers`, each with a
    string `name` and `voice_id`;
  - each episode's `speaker_config` names a speaker that is planned or already exists;
  - every model ref resolves.

  It returns the planned speakers and episodes with model ids already resolved, and it
  throws before returning anything if any check fails.
- **`app/podcast/restore.mjs`.** The work moves into an exported `runRestore(want, client,
  { dryRun, log })`.
  - It reads models, speakers and episodes, calls `planRestore`, and only then writes.
  - `client` is the set of `on.mjs` functions, passed in so a test can record calls.
  - The CLI keeps today's behaviour and output. It runs `main()` only when executed
    directly, so importing the module for a test starts nothing.
  - In a dry run, planning failures surface exactly as in a real run.
- **`app/podcast/export.mjs`.**
  - Portable refs are written as objects (`idToRef(id) ?? null`, without `.name`).
  - Each file is written with `writeFileAtomicSync`. `writeJsonAtomicSync` is not used,
    because it would leave `.bak` files in a committed directory.
  - Key order and formatting are unchanged.
- **`app/test/podcastprofiles.test.mjs`** (new). It tests the pure functions:
  - provider-aware identity, ambiguity refused, and a type mismatch refused;
  - `planRestore` refusing a missing speaker, a missing model, an episode model not in
    `models.json`, duplicate names, and a legacy name listed under two providers;
  - a valid plan resolving ids.
- **`app/test/restoreegress.test.mjs`** (new). A recorder of what `runRestore` sends:
  - with an invalid profile set it sends **no** `POST` or `PUT`, in a real run or a dry
    run;
  - the control: the same fixture made valid does send the writes.

## Order of work

1. **Red, committed first:** both test files, with the run output in the commit message
   and Proof.
   - The pure-function tests fail where `main` lacks the behaviour.
   - The recorder fails because `runRestore` doesn't exist yet. It sits in its own file, so
     a missing export kills only that file.
   - Also show the defect itself on `main`'s CLI, by running it against a stub server
     with a fixture profile directory. That run reaches the speaker writes before it
     throws on the episode.
2. `modelIndex` and `planRestore`.
3. `runRestore` and the CLI wrapper.
4. Export: object refs and the atomic write.
5. Verify, Codex, then the PR.

## Risks

- **Legacy JSON compatibility.** Today's committed profiles hold plain model names. Restore
  must resolve them exactly as before when the name is unique. The live dry run proves it:
  the same 5 speaker and 6 episode profiles planned, with the same models.
- **Export changes the committed JSON shape on its next run.** That's intended, and it
  produces a one-time diff to review. This slice doesn't run it.
- **A stricter plan refuses what `main` silently allowed.** For example, a speaker profile
  with an empty voice now stops the run. That's the point, and the error names the
  profile.
- **The CLI's entry-point guard.** If it were wrong, `node app/podcast/restore.mjs` would do
  nothing. Proof runs the real CLI with `--dry-run`.

## Proof

- `npm test` with `node_modules` absent: everything passes, and the new tests were red
  first.
- `npm run verify`: clean.
- The live, read-only CLI dry run: `node app/podcast/restore.mjs --dry-run` against the
  real Open Notebook. It must show the same plan as `main`'s dry run, recorded below. It
  sends only GETs; no apply run is made.
- `/gstack-codex review origin/main`, posted on the PR.

### Baseline, `main` at `eb2e95e`, 2026-11-11

- `node app/podcast/restore.mjs --dry-run` reported:
  - all 3 referenced models registered;
  - speaker updates: `business_panel`, `solo_expert`, `tech_experts`,
    `tech_experts-mixed`, `tech_experts-mixed-v2`;
  - episode updates: `business_analysis` and `solo_expert` (no model),
    `study-chapter`, `study-overview` and `tech_discussion` (`qwen2.5:7b-instruct`), and
    `study-deep-dive` (`qwen3-coder:30b`).
- Live models: 6, with no duplicate `type/name`.

### Red, on `main`'s code with the new tests, 2026-11-11

- `node --test app/test/podcastprofiles.test.mjs app/test/restoreegress.test.mjs`:
  20 tests, 1 pass, 19 fail.
  - The pass is the unique legacy plain name. That's the compatibility guard, and it's meant
    to stay green.
  - `modelIndex` returned `model:two` for an `ollama` request, and threw nothing for an
    ambiguous name or a mismatched type.
  - `planRestore` failed with `ERR_MODULE_NOT_FOUND`, and `runRestore` with "is not a
    function".
  - The import test caught `main()` running on import: it printed "Restoring podcast
    config to …".
- **A first draft of the import test was green on `main`.** It checked only the stub, and
  `main()`'s request arrived after the assertion. The test now also captures what the
  import prints, which happens synchronously.
- **`main`'s real CLI against a recording stub,** with a fixture profile directory: speaker
  `Ada`, episode `chapter` with an unregistered `transcript_llm`, and episode `broken` naming
  speaker `Nobody`.
  - `--dry-run` exited 0 and reported a clean plan.
  - The real run sent `PUT /api/speaker-profiles/speaker_profile%3Aada`, then
    `PUT /api/episode-profiles/episode_profile%3Ach` with `"transcript_llm":null`, and only
    then failed on `broken`.

### Green, after the fix, 2026-11-11

- Both new files: 20 of 20 pass.
- `npm test` with `node_modules` absent: 658 tests, 658 pass.
- `npm run verify`: "No damage found."
- **The same stub fixture on the fixed CLI:** `--dry-run` and the real run both exit 1
  with "episode profile chapter: model language/unregistered is not registered in ON".
  The stub received `GET`s only.
- **Export on a copy against a stub:** it wrote `{ name, provider, type }` refs and only
  the three JSON files, with no `.bak` or temp file. A restore dry run of that output
  planned both profiles, which shows a re-export round-trips.
- **The live, read-only `node app/podcast/restore.mjs --dry-run`:** identical to the
  baseline. It found all 3 models registered, the same 5 speaker updates, and the same 6
  episode updates with the same models. No apply run was made.

## Options not taken

- **Port `app/lib/restore.mjs` here.** It restores learner data from `.bak`. It belongs
  to Recovery, which touches mastery and is probably T2.
- **`writeJsonAtomicSync` for export.** It's the same format, but it would leave `.bak`
  files in `app/podcast/profiles/`. Git history is the backup for committed files.
- **Make export's output directory overridable, to test the atomic write end to end.**
  Running export in a test would need a stubbed Open Notebook and a temp directory, for
  a one-line change to the atomic writer the suite already covers.
