---
change: 2026-11-11-chapter-render-view
status: accepted
track: T2
risk: medium
risk_reason: User-facing view work in the busiest view, plus one new read route. The view's load changes so Open Notebook being down no longer blanks the local section. It adds no write path beyond D5d2's routes.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a Checked chapters section in the Podcast view

Track: T2. One repo. It changes the user interface and adds one read-only route. Risk is
medium: the Podcast view is the largest view, and its load changes.

## Problem

This is slice D5e, the last of the local chapter renderer, from PR #98's September
snapshot (`264547c`). D5d2 (PR #155) put five routes on `main`, and the first real
render reached `qc_passed`. But only `curl` can reach them:

- there's no screen to pick a chapter, start a render or watch it progress;
- nothing lists the renditions a topic already has. D5d2 has no list route, and the
  Podcast view shows only Open Notebook's episodes;
- the candidate can be played only by pasting the audio URL. Publishing takes a
  hand-written POST, so the full-listen confirmation is a JSON field, not a decision
  made on screen;
- when Open Notebook is down, the whole Podcast view becomes an error panel. Local
  recordings that need nothing from Open Notebook become unreachable with it.

September added `chapterpodcast.mjs` and merged renditions into the Rendered episodes
list through `/api/podcast/library`. On `main`, the library route was left to this slice.

## Proposed outcome

A **Checked chapters** section in the Podcast view, below the existing Open Notebook
cards, built from the view's existing card, row and button patterns (James, 2026-11-11).

- **One topic picker** at the top of the section drives both the form and the list
  (James). It defaults to the first topic with a notebook mapped.
- **A create card.** It has three selects: the chapter source (that topic's Open
  Notebook sources), the episode profile and the speaker profile. One button starts the
  render.
  - It posts to `POST /api/podcast/renders` through `requestJsonWithMutation`. The
    `mutation_id` is minted once and reused until the request succeeds (rule 9), so a
    double click or a retry after a lost response can't start a second render.
  - September's explanation stays on the card: the transcript is checked before
    speech, and a new recording stays a review candidate until it's heard and published.
- **A list card** with one row per rendition in the topic, newest first. Each row has:
  - the chapter, the stage and the progress text;
  - QC issues and repetition times, when there are any;
  - a player once checked audio exists, using the audio route, which supports seeking;
  - a "Transcript and coverage plan" disclosure, loaded from the read route when it's
    first opened;
  - **Resume** for an interrupted or failed rendition;
  - **Publish** on a `qc_passed` rendition. It stays disabled until a checkbox is
    ticked: "I listened to the full recording and checked its explanations and
    coverage". It sends `full_listen_confirmed: true` only from that checkbox;
  - a "preferred" mark on the newest published rendition of each source;
  - a `needs_repair` row for a damaged manifest, saying so without breaking the list.
- **Progress polls itself** (James). While any rendition in the list is queued or
  running, the list re-reads every 5 seconds. It stops once none is, and stops when you
  leave the view. Progress changes are announced politely, once per change.
- **It keeps working locally while Open Notebook is down** (James). The section loads
  separately from the Open Notebook cards:
  - the list, player, transcript and publish still work;
  - create and resume need Open Notebook (sources and the preflight), so they're
    disabled with a reason that names Open Notebook;
  - the Open Notebook part of the view shows its own error without blanking the
    section.
- **One new read route:** `GET /api/podcast/renders?topic=` returns
  `listRenditions(topic)`, which is local only. D5d2's test asserting that this path is
  a 404 is updated deliberately. Damaged manifests come back as `needs_repair` rows, as
  `listRenditions` already does.

## Affected users and systems

- `app/web/js/views/podcast.mjs`: its load is split in two, and it gains the section.
- A new `app/web/js/views/chapterpodcast.mjs`, after September's. This is because
  `podcast.mjs` is already 891 lines.
- `app/router.mjs`: the list route, inside `handlePodcastRenders`.
- `app/web/css/app.css`: only what the existing classes don't cover.
- Tests for the route, the list rendering, polling, publish gating and the outage path.

## Constraints

- **Rule 5.** Vanilla ES modules, no build step, no dependencies.
- **Rule 7 isn't touched.** Renditions carry no deck answers.
- **Rule 9.** Create keeps its `mutation_id`, minted once and reused until it succeeds.
  Resume and publish carry none, per D5d2.
- **Rule 12.** The page's own requests keep passing the guard. `script-src 'self'` means
  no inline script or handlers.
- **Transcript text is model output, so it's rendered as text, never as HTML.** It goes
  through `el()` and `textContent`, never `innerHTML`.
- **Additive to behaviour.** The Open Notebook cards (generate, batch, profiles,
  episodes) keep working as they do now, apart from the load split, which is tested.
- **Accessibility.** Every control is labelled, the progress region is polite, and
  publish's gate is a real checkbox with its own label.
- **Verify by driving it.** Mutation paths are checked against a `/tmp/learn` copy,
  never the real tree. That includes the publish of the fastbook 01 candidate rendered
  in D5d2, after James's full listen.
- **Test first**, with a red commit before each behaviour's code.

## Out of scope

- Merging renditions into the Rendered episodes list, and September's
  `/api/podcast/library`.
- `/api/podcast/feedback` and the audio-feedback sidecar.
- Deleting or renaming a rendition.
- Retuning QC thresholds.
- Batch rendering of several chapters.
- Changes to the Open Notebook cards, apart from the load split.

## Success signals

- `npm test` passes with `node_modules` absent and no outside services running.
- Route tests for `GET /api/podcast/renders?topic=`:
  - 200 with the topic's renditions, newest first;
  - a `needs_repair` row for a damaged manifest;
  - 400 for an unknown or missing topic;
  - no Open Notebook call made.
- View tests, using the repo's DOM fixture:
  - publish stays disabled until the checkbox is ticked, and only then sends
    `full_listen_confirmed: true`;
  - polling starts while a rendition is active and stops when none is, and when the
    view is left;
  - create mints one `mutation_id` and reuses it on retry;
  - transcript text containing markup appears as literal text.
- A degradation test: with Open Notebook unreachable, the list route answers 200, and
  the section's create button is disabled with a reason that names Open Notebook.
- Driven live in the browser pane, against the `/tmp/learn` copy:
  - start fastbook 20 (a short chapter) from the form and watch it reach a final stage
    with no manual refresh;
  - play and seek the candidate;
  - open the transcript;
  - publish fastbook 01's existing candidate through the checkbox;
  - stop Open Notebook's reachability by pointing `STUDYDECK_ON_BASE_URL` at a dead
    port, and confirm the list still plays.
- Screenshots of the section in its normal, running and Open-Notebook-down states go in
  `plan.md`.

## Open questions

- The poll interval is 5 seconds. The spec confirms that doesn't collide with the view's
  existing refresh button or the job polls already in it.
- How the existing `showError` panel and the new independent section share the page.
  The spec draws the states.
