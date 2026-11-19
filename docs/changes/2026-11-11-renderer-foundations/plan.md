---
change: 2026-11-11-renderer-foundations
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the foundations the local chapter renderer stands on, added without touching what runs

## Files that change

- **`app/lib/atomic.mjs`.** Additions only:
  - `readJsonValidated(path, fallback, validate)`;
  - `writeJsonValidated(path, value, validate)`;
  - private helpers of their own.

  The existing `tryReadJson`, `retainBackup`, `readJsonSafe`, `writeJsonAtomicSync`,
  `writeFileAtomicWithBackupSync` and every other line stay byte-identical. Where the
  new functions need a validating parse or a validating backup, they get their own
  helpers. No existing helper gains a parameter.
- **`app/lib/httpjson.mjs`** (new): `fetchJson`, ported from `264547c` as written.
- **`app/lib/localmedia.mjs`.** `sendLocalMedia(req, res, { path, type, sha256 })`, an
  addition: one destructured name, plus a line that picks the ETag. The default stays
  size-and-mtime.
- **`app/lib/opennotebook.mjs`.** `podcastPreflight` keeps every check, message and
  status, and replaces only its final `return { models: selected }` with a return that
  also carries the render snapshot and its fingerprint. It gets a new private helper,
  `renderShape`.
- **New tests:**
  - `app/test/atomiccharacter.test.mjs`, the characterization tests;
  - `app/test/atomicvalidated.test.mjs`;
  - `app/test/httpjson.test.mjs`;
  - additions to `app/test/media.test.mjs`, or a new `localmediaetag.test.mjs` if
    `media.test.mjs` doesn't reach `sendLocalMedia` directly;
  - `app/test/preflightfingerprint.test.mjs`.

## What the fingerprint covers (intent open question 1)

Settled from the real shapes, read from Open Notebook with GETs only on 2026-11-11
(6 episode profiles and 5 speaker profiles; field names and types only).

| Source | In the fingerprint | Left out |
|---|---|---|
| Episode profile | `outline_llm`, `transcript_llm`, `language`, `default_briefing`, `num_segments`, `max_tokens` | `id`, `name`, `description`, `speaker_config`, `speaker_config_name` |
| Speaker profile | `voice_model`, and each speaker's `name`, `voice_id`, `personality`, `backstory` | `id`, `name`, `description` |
| Selected models | each model's `name`, `provider`, `type` | `id` |

- **An allowlist, not a denylist.** The live profiles carry no `created` or `updated`
  today. Picking fields means any bookkeeping field Open Notebook adds later is
  excluded without a code change.
- **The returned snapshot.** `episode_profile`, `speaker_profile` and `models` hold
  these same picked fields, so the fingerprint is computed from exactly what is
  returned.
- **Why profile names are left out.** A profile's own `name` is identity, not content,
  so renaming a profile does not block a resume. The speaker's `name` is kept: it is
  spoken in the dialogue.
- **Serialisation.** The fingerprint is the sha256 of the snapshot serialised with
  sorted keys, so key order in Open Notebook's response can't change it.

## Order of work

Each step is red, then green, in separate commits, except step 1, which must be green
from the start.

1. **Characterization, before anything else.** `atomiccharacter.test.mjs` pins today's
   `readJsonSafe` and `writeJsonAtomicSync`:
   - an intact primary;
   - a corrupt primary with a good backup, which reads as `backup`;
   - both files missing, which reads as `missing`;
   - a missing primary with a good backup, which reads as `backup`;
   - a missing primary with a bad backup, which reads as `missing` today;
   - a write that keeps the previous primary as `.bak`;
   - a write over a corrupt primary, which leaves the old `.bak`.

   It's committed green on unchanged `main`, and its commit says the tests pin current
   behaviour. To show it can fail, one assertion is temporarily inverted and run once
   before the commit.
2. **`readJsonValidated` and `writeJsonValidated`.** Red tests first: every intent case,
   including a missing primary with a bad backup reading as `fallback`, an invalid
   write refused with every file unchanged, and an invalid primary never kept as the
   backup. Then the additions. Step 1's file must pass unchanged.
3. **`fetchJson`.** Red tests against a local `node:http` server on `127.0.0.1`. No
   external service is used. They cover a body over `maxBytes`, by header and by
   stream; a timeout; an external abort; a non-object body; a non-2xx status kept as
   is; and a protocol failure reported as `502`. Then the port.
4. **The `sha256` ETag.** Red: with `sha256`, the ETag is that hash, and `If-None-Match`
   on it answers `304`. A control shows the default ETag is unchanged without it. Then
   the addition.
5. **The preflight snapshot.**
   - Red tests, driving `podcastPreflight` against a recording stub. This is the
     pattern `podcastegress` already uses, and it pins what this app computes, not
     what Open Notebook returns.
   - They check that the result carries `version`, the picked profile fields,
     `models`, `fingerprint` and `checked_at`.
   - They check that the fingerprint changes when `num_segments` or a speaker's
     `voice_id` changes.
   - They check that it stays the same when `id`, `description` or a profile `name`
     changes, or when an unknown field such as `created` is added.
   - They check that the existing refusals keep their messages and statuses.
   - Then the change.
6. **Verify and ship.**
   - Run `npm test` with no `node_modules`, and `npm run verify`.
   - Run the additive-only diff check, the grep for callers, and a read-only
     `/api/health` on the real tree.
   - Run Codex until it returns `NO_FINDINGS`.
   - Open the PR.

## Risks

- **An "additive" change that isn't.** This is the risk the slice exists to avoid. It's
  caught three ways:
  - the characterization file must stay green and unedited;
  - `git diff origin/main -- app/lib/atomic.mjs app/lib/localmedia.mjs` must show no
    `-` lines, apart from the one replaced line in `sendLocalMedia`'s destructuring and
    the ETag line;
  - the full suite must pass.

  Any other `-` line in those two files stops the slice.
- **The preflight return changing a caller.** Both callers ignore the value today, and
  step 6's grep checks that no other caller has appeared.
- **Stubs in step 5 drifting from Open Notebook's real shape.** The stub serves the
  field names read live on 2026-11-11. As `.claude/rules/testing.md` says, if Open
  Notebook changes its shape, these tests keep passing and the real route changes.
  `npm run verify:live` remains the instrument for that.

## Proof

- **Red runs:** in each red commit, and here.
- **Green:** `npm test` with `node_modules` absent; `npm run verify` clean.
- **Additive-only:** the two diffs above, with their `-` lines listed.
- **Callers:** a grep for the new names, showing only tests.
- **Live, read-only:** `/api/health` and `npm run verify` on the real tree, before and
  after. The working tree is unchanged, so the real cockpit only changes on merge.
- **Reviews:** Codex until it returns `NO_FINDINGS`, with every run posted on the PR.

### Green, 2026-11-11

- **Green:** `npm test` with `node_modules` absent, 791 of 791 at `325f24c`.
  `npm run verify` is clean on the worktree, and clean read-only on the real tree
  (`STUDYDECK_LEARN_ROOT` pointed at it).
- **Additive-only**, `git diff --numstat origin/main -- app/lib/`:

  | File | Added | Removed |
  |---|---|---|
  | `atomic.mjs` | 77 | 0 |
  | `httpjson.mjs` (new) | 43 | 0 |
  | `localmedia.mjs` | 4 | 2 |
  | `opennotebook.mjs` | 29 | 1 |

  The 3 removed lines are the ones the plan allows: `sendLocalMedia`'s signature and
  ETag line, and the old preflight return.
- **Characterization:** `atomiccharacter.test.mjs` is unchanged since `a0d446e` and
  green at every step.
- **Callers:**
  - The new atomic exports and `fetchJson` are used only by their tests.
  - The video route passes no `sha256`.
  - Both preflight callers ignore its return.
- **Live, read-only:** the real cockpit's `/api/health` was `ok` throughout. It runs
  `main`, so this branch reaches it only on merge.
- **Red runs:** one per step, in each red commit. Two tests passed for a reason other
  than the new code, and their commits say so:
  - the no-validator test passed only because the functions didn't exist yet;
  - the preflight refusal test passes by design, because it pins existing behaviour.
- **Codex:** three runs. Run 1 found one P2 (the array body), fixed test-first. Run 2
  was clean. James then dropped model ids from the fingerprint. Run 3 was clean at
  `325f24c`.

## Options not taken

- **Changing `readJsonSafe` and `writeJsonAtomicSync`** (September's design, and the
  first draft of this intent). It put every sidecar at risk. James chose additive only
  on 2026-11-11.
- **The missing-primary-with-bad-backup change for existing sidecars.** It's moved to
  its own slice after D5. James still wants it.
- **Fingerprinting the full profile objects.** That would let a profile rename or an
  added bookkeeping field block a resume. James chose the render-shaping fields on
  2026-11-11.
- **Moving `ollama`, `tts` or `onFetch` onto `fetchJson`.** It would change the error
  statuses that the contract and degradation tests pin.

## Deviations

- **`fetchJson` refuses an array body** (Codex run 1, P2). September's check was
  `typeof result === 'object'`, which an array passes. An array now gets the same `502`
  as any other non-object body. That is the only change to the ported module.
- **The fingerprint leaves out model ids** (James, 2026-11-11, after the build flagged
  it). The plan's table put the episode profile's `outline_llm` and `transcript_llm`
  and the speaker profile's `voice_model` in the fingerprint, but those fields hold
  Open Notebook model ids. The chosen models are pinned by `name`, `provider` and `type`,
  so the three id fields are dropped. Re-registering the same model doesn't block a
  resume, and switching to a different model still does. Pinned in
  `preflightfingerprint.test.mjs`.
