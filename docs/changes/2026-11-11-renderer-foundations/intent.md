---
change: 2026-11-11-renderer-foundations
status: accepted
track: T1
risk: low
risk_reason: Additive only. No existing function's behaviour changes. readJsonSafe and writeJsonAtomicSync, which every sidecar uses, are left exactly as they are, and characterization tests pin that. The new code is a validated JSON reader and writer, fetchJson, an optional ETag argument and extra preflight return fields. Nothing on main calls any of it until D5d, so a defect here can't reach study data.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the foundations the local chapter renderer stands on, added without touching what runs

Track: T1. One repo, no UI and no route, with risk low because every change is
additive. James asked on 2026-11-11 for the lowest-risk shape of this slice.

## Problem

This is slice D5b of the local chapter renderer, from PR #98's September snapshot
(`264547c`). D5a (the QC gates, PR #151) is merged. D5c (audio) and D5d (the pipeline)
need four things `main` doesn't have.

1. **A validated JSON reader and writer.** D5d stores each rendition in a manifest. The
   manifest must be checked on read and refused on write when it's malformed, and a
   malformed copy must never become its backup.
2. **A bounded JSON fetch.** D5d's Ollama calls need a size cap, a timeout, and a `502`
   for protocol failures, so that a POST that may have committed is never mistaken for a
   clean rejection.
3. **A content-hash ETag for local media.** A rendered chapter is replaced in place when
   it's re-rendered, so a size-and-mtime ETag can match two different files.
4. **A record of what the preflight checked.** D5d stores which profiles and models a
   rendition was made with, and refuses to resume when they change.

September got the first one by changing `readJsonSafe` and `writeJsonAtomicSync`
themselves. Rule 8 routes every JSON write in the app through those two functions, so
changing them puts every sidecar at risk to serve one new file.

The first draft of this intent did the same. James asked for the safer shape on
2026-11-11, and this draft replaces it.

## Proposed outcome

- **Two new exports in `app/lib/atomic.mjs`, beside the existing ones:**
  - **`readJsonValidated(path, fallback, validate)`** reads like `readJsonSafe`, with
    two differences. A primary or backup that parses but fails `validate` counts as
    unusable. A missing primary beside an unusable backup reads as `fallback` with an
    error, not as `missing`.
  - **`writeJsonValidated(path, value, validate)`** refuses a value that fails
    `validate` before anything is written. It keeps the current primary as `.bak` only
    when that primary parses and validates. Then it writes temp-then-rename, as
    `writeJsonAtomicSync` does.

  `validate` returns a list of errors, as `validateSidecar` does. Both functions reuse
  the module's existing private helpers without modifying them.
- **`readJsonSafe`, `writeJsonAtomicSync`, `writeFileAtomicWithBackupSync` and every
  other existing export are unchanged.**
- **`app/lib/httpjson.mjs`** (new) exports `fetchJson(url, { timeout, maxBytes, ...init })`.
  - It caps the response size and times out.
  - It honours an external `AbortSignal`.
  - It refuses a body that isn't a JSON object, and reports protocol failures as `502`.
- **`sendLocalMedia(req, res, { path, type, sha256 })`**: with `sha256` given, that is
  the strong ETag. Without it, the existing size-and-mtime ETag and every other
  behaviour are unchanged.
- **`podcastPreflight`** runs every check it runs today, in the same order, with the
  same errors and statuses. It keeps `main`'s `:latest` handling for Ollama names. It
  now also returns:
  - `{ version, episode_profile, speaker_profile, models }`;
  - a `fingerprint` of the fields in that snapshot that shape a render;
  - `checked_at`.

  The fingerprint covers only the fields that shape a render: the models selected and
  the profile settings that change what is generated or voiced. It leaves out Open
  Notebook's bookkeeping, such as `id`, `created` and `updated`, so an unrelated
  profile edit can't block a resume in D5d. This is James's decision of 2026-11-11.

  Both current callers ignore the return value.

## Affected users and systems

- **None at runtime today.** Nothing on `main` calls the new functions or reads the new
  preflight fields. The one existing caller of `sendLocalMedia`, the video route,
  passes no `sha256`.
- **D5c and D5d will be the callers.** The names and shapes here are their contract.

## Constraints

- **Additive only.**
  - `git diff origin/main -- app/lib/atomic.mjs app/lib/localmedia.mjs` shows added
    lines and no removed or modified ones.
  - `podcastPreflight`'s diff only adds to the value it returns.
  - The plan's Proof shows all of these.
- **Characterization first.** Before the new code exists, commit tests that pin today's
  `readJsonSafe` and `writeJsonAtomicSync` case by case. They pass before the change
  and after it. If one ever needs editing, that's a sign the change wasn't additive,
  and the slice stops.
- **Rule 8.** The new writer is temp-then-rename and keeps the last good copy, like the
  old one. The validator can only refuse a write or decline to keep a backup. It never
  weakens either guarantee.
- **Rule 5.** Node stdlib only. `fetchJson` uses the global `fetch`.
- **Test first** for each new behaviour, with a red commit before its code.

## Out of scope

- **Changing `readJsonSafe`'s handling of a missing primary beside a bad backup**
  (today it reads as `missing`). James chose to report it as damage, but it's a
  health-reporting change the renderer doesn't need. It becomes its own small slice
  after D5, with its own red test and its own review of `/api/health` and
  `npm run verify`. Only the new `readJsonValidated` reports it in this slice.
- **Moving `ollama.mjs`, `tts.mjs` or `onFetch` onto `fetchJson`.** It would change
  error statuses the Open Notebook contract and degradation tests pin.
- **Any caller of the new code, and the rendition manifest and its validator.** Those
  are D5c and D5d.
- **`podcastoperations.mjs` and the `routes/` extraction.** Separate refactors.

## Success signals

- `npm test` passes with `node_modules` absent, and `npm run verify` is clean.
- **Characterization tests** for `readJsonSafe` and `writeJsonAtomicSync` are green on
  `main` before the change and unchanged after it. They cover:
  - an intact primary;
  - a corrupt primary with a good backup;
  - both files missing;
  - a missing primary with a good backup;
  - a missing primary with a bad backup, which reads as `missing` today;
  - a write that keeps the previous primary as `.bak`;
  - a write over a corrupt primary, which leaves the old `.bak`.
- **New tests show:**
  - each `readJsonValidated` case, including a missing primary with a bad backup
    reading as `fallback`;
  - `writeJsonValidated` refusing an invalid value with no file changed, and never
    keeping an invalid primary as the backup;
  - `fetchJson`'s size cap, timeout, abort, non-object refusal and `502`;
  - the `sha256` ETag answering `304` to `If-None-Match`, alongside the unchanged
    default;
  - the preflight fingerprint changing when a render-shaping field changes, and staying
    stable when only a bookkeeping field (`created`, `updated`, `id`) changes.
- `git diff origin/main` for `atomic.mjs` and `localmedia.mjs` shows only `+` lines.
- `grep` shows no caller of the new exports outside their tests.

## Open questions

1. The exact list of render-shaping fields. The plan settles it from the real shape of
   an episode profile and a speaker profile, read from Open Notebook with GETs only.
