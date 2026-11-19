---
change: 2026-11-11-chapter-render-routes
status: accepted
track: T2
risk: medium
risk_reason: Adds HTTP routes that start local model and voice work and write render data under cockpit/audio/. No existing route changes, and the routes inherit the guard. The first real render runs only on a /tmp/learn copy.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: HTTP routes for the chapter renderer, and its first real render

Track: T2. One repo, new routes that write data, and a live run against local services.
Risk is medium. The routes are additive, but they are the first thing that makes
`podcastrender.mjs` do real, slow, disk-writing work.

## Problem

This is slice D5d2 of the local chapter renderer, from PR #98's September snapshot
(`264547c`). D5d1 (PR #154) put `app/lib/podcastrender.mjs` on `main`, with every
decision tested on fakes. Nothing calls it. So today:

- there's no way to start a render, see its progress, play the candidate, resume an
  interrupted one or publish it;
- no render has ever run against the real Ollama, Speaches and ffmpeg. The recorder
  tests pin what this app sends, not whether those services accept it. September's QC
  thresholds have never met a real voice.

September put these routes in `app/routes/podcast.mjs`, beside library and feedback
routes. `main`'s convention is a `handleX` function inside `app/router.mjs`.

## Proposed outcome

Five routes under `/api/podcast/renders`, handled by one function in `app/router.mjs`:

| Route | Does |
|---|---|
| `POST /api/podcast/renders` | Prepares a rendition and queues it. Takes `topic_slug`, `source_id`, `mutation_id`, `episode_profile`, `speaker_profile`. Answers 202 with the summary. |
| `GET /api/podcast/renders/:id?topic=` | The summary, the transcript and every transcript attempt. |
| `GET`/`HEAD /api/podcast/renders/:id/audio?topic=` | The candidate MP3, through `sendLocalMedia` as `audio/mpeg`, with the sha256 QC measured as its ETag. Range requests work, so the player can seek. |
| `POST /api/podcast/renders/:id/resume` | Re-queues an interrupted or failed rendition. |
| `POST /api/podcast/renders/:id/publish` | Publishes it. Needs `full_listen_confirmed: true`. |

- **The id is checked before anything is read.** It must be `render-` followed by 24
  hex characters, and `topic` must be a known topic.
- **Create carries a `mutation_id`.** The rendition id is derived from it, so a replay
  returns the same rendition (rule 9).
- **Resume and publish carry no `mutation_id`** (James, 2026-11-11). Both set a stage on
  an existing manifest, and a replay already changes nothing. Resume re-reads the
  manifest and returns a running or finished rendition as it is, and a second publish
  returns the published rendition unchanged. Rule 9 in `CLAUDE.md` gains them, beside
  `/api/schedule/start` and the recovery POSTs, with that reason.
- **Being down is our behaviour.** With Open Notebook unreachable, create answers 503
  naming Open Notebook, never a 500 or an empty success. With Ollama unreachable, create
  answers 503 naming Ollama.
- **The first real render** (James, 2026-11-11). One chapter is rendered through the
  routes on a `/tmp/learn` copy, with `STUDYDECK_LEARN_ROOT` set:
  - Open Notebook gets reads only: the source list, the source, the profiles and the
    preflight. Ollama, Speaches and ffmpeg are local.
  - The MP3s and manifest land in `/tmp/learn`. The real tree isn't touched.
  - The stage it reaches, the QC numbers and any failure are recorded in `plan.md`. You
    listen to the candidate.
  - If September's thresholds trip on the real voice, retuning them is a separate slice.

## Affected users and systems

- `app/router.mjs` gains the route function and one dispatch line.
- `CLAUDE.md` rule 9 gains one sentence. The AI review gate reads its standards from that
  file's bold bullets on `main`, so the change reaches the gate after merge.
- Nothing in the web UI calls the routes until D5e.
- On the live run: Open Notebook (GET only), the local Ollama, Speaches and ffmpeg, and
  disk under `/tmp/learn`.

## Constraints

- **Additive to behaviour.** No existing route changes. Apart from the dispatch line and
  the rule 9 sentence, the diff adds code.
- **Rule 5.** No dependencies. The suite passes with `node_modules` absent and every
  outside service unreachable.
- **Rule 7 is not touched.** Renders carry no deck questions or answers.
- **Rule 9.** Create keeps its `mutation_id`. Resume and publish are documented
  exceptions, each with a replay test.
- **Rule 12.** The routes inherit the guard because they sit inside `handleRequest`.
  Guard tests prove it for the three POSTs: a cross-origin `Origin`, a non-JSON
  `Content-Type` and a non-loopback `Host` are each refused, and no response carries an
  `Access-Control-Allow-*` header.
- **No mutating test or live run on the real tree.** The live render runs on a
  `/tmp/learn` copy. It needs no Open Notebook write.
- **Test first**, with a red commit before each behaviour's code.

## Out of scope

- `/api/podcast/library` goes with the view in D5e, where something uses it.
- `/api/podcast/feedback` and its audio-feedback sidecar get their own slice later
  (James, 2026-11-11).
- The view, which is D5e.
- Retuning September's QC thresholds, whatever the live render shows.
- Any change to `podcastrender.mjs`, unless a route test shows it's needed. If one does,
  it's recorded as a deviation.

## Success signals

- `npm test` passes with `node_modules` absent and no outside services running.
- Route tests, using D5d1's fakes and a temp learn root:
  - create answers 202. The same `mutation_id` with the same input returns the same id.
    With different input it answers 409.
  - read answers 404 for an unknown id and 400 for a malformed id or unknown topic.
  - audio serves the candidate with `content-type: audio/mpeg` and the QC sha256 as its
    ETag. A `Range` request answers 206. A rendition without a candidate answers 404.
  - resume and publish, each replayed, leave the manifest byte-identical after the
    second call.
  - publish without `full_listen_confirmed: true` is refused, and the manifest is
    unchanged.
- Guard tests: each POST is refused cross-origin, without a JSON content type, and with a
  non-loopback `Host`. No response carries an `Access-Control-Allow-*` header.
- Degradation tests: with Open Notebook unreachable, create answers 503 naming it, and
  the ON password appears in no response.
- The live render: one chapter on the `/tmp/learn` copy reaches a final stage. The stage
  is `qc_passed`, `needs_review` or `failed`, and each is a valid outcome to record.
  `plan.md` records the stage, the QC numbers and the duration. The candidate plays in a
  browser from the audio route.
- `git diff origin/main -- app/lib/podcastrender.mjs` is empty, or the change is
  recorded as a deviation.

## Open questions

- Whether a 503 from Ollama during the render itself, not at create, should end at
  `failed` or `interrupted`. D5d1 ends it at `failed` with the message, and resume can
  restart it. The spec will confirm this holds through the routes.
