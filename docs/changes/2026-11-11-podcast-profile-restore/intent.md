---
change: 2026-11-11-podcast-profile-restore
status: accepted
track: T1
risk: medium
risk_reason: The profile restore CLI writes episode and speaker profiles to Open Notebook, which is external, global config used by every render. A wrong restore can leave profiles half-rewritten or clear a profile's LLM, and generation then fails until someone notices and repairs it by hand or from the committed JSON. The change is in one repo, runs only when a person invokes the CLI, and touches no learner data (state.json, mastery, attempts, sidecars). Pure-function tests and a recorder of what restore sends cover it, plus a read-only live dry run.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: profile restore checks everything before its first write, and names a model by provider as well as type and name

## Problem

This is slice D3 of porting PR #98's September snapshot (`264547c`, area D: podcasts).
The snapshot's fix is `app/podcast/restoreplan.mjs`, a provider-aware `modelIndex` in
`app/podcast/on.mjs`, and `app/test/podcastprofiles.test.mjs`.

`node app/podcast/restore.mjs` rebuilds Open Notebook's speaker and episode profiles from
`app/podcast/profiles/*.json`. On `main` it validates as it goes, not before:

1. **A bad episode is found only after the speakers were written.** Speaker profiles are
   created or updated first. Only then does the episode loop discover a `speaker_config`
   that doesn't exist, and throw. Open Notebook is left with new speakers and old episodes.
2. **An unknown episode model clears the profile's model.** The up-front check covers the
   models in `models.json` only. An `outline_llm` or `transcript_llm` that isn't listed
   there resolves to `null`, and `null` is sent. That unsets the model on a profile that
   had one, and generation then fails.
3. **A dry run hides both.** `--dry-run` skips the speaker check entirely
   (`!speakerId && !DRY_RUN`) and never resolves episode models. It reports a plan that
   the real run then can't carry out.
4. **A model is identified by type and name only.** `modelIndex` keys on `type/name`. If two
   providers register the same model name, the last one listed silently wins.

A read-only live check on 2026-11-11 shows that none of these fires today. Open Notebook has
6 models with no duplicate `type/name`, and the dry run is clean. They fire on a
hand-edited profile JSON, a renamed speaker, or a second provider with a same-named model.

Also, `app/podcast/export.mjs` writes the committed JSON with `writeFileSync`. A crash
mid-write truncates a tracked file (CLAUDE.md rule 8).

## Outcome

- **Plan first.** Restore builds a complete write plan before it sends anything. The plan
  checks every speaker reference, every model reference (with provider), and that names
  are unique. Any problem stops the run before the first `POST` or `PUT`, naming what's
  wrong.
- **The dry run runs the same planning,** so it fails exactly where the real run would.
- **Provider-aware model identity.** `modelIndex` matches a model by provider, type and name.
  - Export writes portable model refs as `{ provider, type, name }` objects.
  - Restore still accepts the legacy plain-name strings in today's committed JSON. It
    resolves a string through `models.json`, and refuses it as ambiguous if that name is
    listed under more than one provider.
- **Atomic export.** Export writes each JSON file with `writeFileAtomicSync`
  (temp-then-rename).

## Out of scope

- **The snapshot's `app/lib/restore.mjs`.** That restores `state.json` and sidecars from
  `.bak`, which is learner data. It belongs to the Recovery slice.
- **The snapshot's `profiles/*.json` hunks.** They're older than `main`. They would put
  `study-deep-dive` back on `gemma4:31b-mlx`, which was ruled out for podcasts, and clear
  `tech_discussion`'s models.
- **The snapshot's `onFetch` rewrite.** It depends on `app/lib/httpjson.mjs`, which only
  exists in the snapshot. It's a refactor, not a fix.
- **Re-exporting the committed profile JSON to the new object form.** That reads live
  Open Notebook and is James's call to run. Legacy strings keep working until then.
- **Registering models.** Restore still verifies models and never creates them.
