---
change: 2026-11-10-podcast-rendition-identity
status: accepted
track: T1
risk: medium
risk_reason: Podcast generation only, inside one repo. Nothing touches state.json, mastery, attempts or the learn sidecars. A mistake costs render time rather than learning data. A wrong preflight refuses a render that would have worked, and a wrong retry plan re-renders chapters at about thirty minutes each. A wrong match settles a request against the wrong recording, and the tag check that guards deletion is touched too. Each failure is visible in the Podcast view and is covered by stubbed egress tests plus a read-only live probe of the preflight.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a podcast request settles only against its own rendition, and an unusable profile is refused before rendering

## Problem

This is slice D2 of porting PR #98's September snapshot (`264547c`, area D: podcasts).

**An older recording can settle a newer request.** When a generate call's response is
lost (a 5xx, a timeout), the operation ledger records the request as `ambiguous`. A
retry with the same `mutation_id` then looks for the episode in Open Notebook to learn
whether the render was accepted. It matches by name alone:

- the standalone route (`runStandalonePodcastOperation` in `app/router.mjs`) uses the
  caller's plain title;
- the chapter batch (`runPodcastEpisodeOperation`) uses `episodeNameFor(topic, source,
  title)`, which is the same for every render of that chapter.

So an earlier recording with the same name answers the question. The retry marks the
new request `complete` against the old episode, and the render that was lost is never
noticed. The snapshot's test reproduces it: render `rendition-old`, drop `rendition-new`
before Open Notebook accepts it, retry `rendition-new`. `main` answers `202 replayed`.
The truth is that nothing is known about the new render.

**An unusable profile is sent anyway.** `main` checks nothing before calling
`POST /api/podcasts/generate`. A profile with no outline or transcript model is accepted
as a job and fails later in the worker, or never runs. A read-only probe of the live
service on 2026-11-10 found two such profiles, the stock `business_analysis` and
`solo_expert`, both with no LLMs set. The four study profiles are complete.

## Outcome

- Every render gets a per-request **rendition** name:
  `<title> · sd-<topic+source digest>-r-<16 hex of topic, source and mutation>`.
  Standalone renders use `notebook:<id>` as the source.
- A `prepared` or `ambiguous` operation settles only when exactly one episode carries its
  exact rendition name. A legacy or untagged name, or two matches, never settles. The
  retry answers `409` ("inspect recovery") and sends no second `POST`.
- The batch retry planner groups episodes by **source tag**, ignoring the rendition. A
  re-render's new name doesn't make a finished chapter look missing. Legacy title skips
  and tag-only deletion keep their current rules.
- Display names strip the rendition as well as the source tag. The notebook index still
  attributes a tagged episode to its notebook.
- Before any render or delete, both the standalone and batch routes run a read-only
  **preflight**. It checks:
  - the episode profile exists;
  - its outline and transcript models are registered language models;
  - the speaker profile has speakers;
  - its voice model is the configured TTS model;
  - every voice id exists in the local TTS service;
  - every Ollama-backed model is present in Ollama.

  Failure answers `422` naming what's missing, or `503` when Ollama is unreachable, and
  sends no generate. A batch dry run is preflighted too, since it sends only GETs.

## Out of scope

- **Recovery**, meaning `GET /api/recovery`, `POST /api/recovery/reconcile` and
  `POST /api/recovery/settle`. `main` has none of it, and the snapshot's third D2 test
  depends on it. It becomes its own slice, decided on 2026-11-10.
- Storing the preflight snapshot (`generation` and `configuration`) on the operation.
  That provenance serves the local renderer (D5).
- Renaming episodes that already exist. Old names keep displaying and keep their
  legacy-skip treatment.
- The podcast view's lifetime (D4), and profile export and restore (D3).
