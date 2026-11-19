---
change: 2026-11-11-chapter-render-view
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [design:ux-copy, design:accessibility-review]
claude_config_sha: d0fbd0f
---
# Spec: a Checked chapters section in the Podcast view

## Flagged concerns

1. **Polling must not rebuild the list.**
   - Source: `design:accessibility-review` (WCAG 2.4.3, 3.2.2, 4.1.3).
   - Re-reading the list every 5 seconds and redrawing it would cause three problems:
     - it would cut off a recording someone is listening to;
     - it would close an open transcript;
     - it would throw away keyboard focus.

     A live region that announces every "Speaking turn 7 of 16" would also swamp a
     screen reader.
   - **Recommended:** rows are keyed by rendition id and updated in place. A poll that
     doesn't change a row's stage changes only its progress text. The `<audio>` element
     and an open `<details>` survive every poll. One polite live region for the section
     announces **stage changes only**. Progress shows as visible text outside it.
   - **Resolution:** James, 2026-11-11: update rows in place, keyed by id; announce stage changes only.
2. **The server's messages say "rendition", but the copy rules say "recording".**
   - Source: `design:ux-copy`, rule 1, one noun for one thing.
   - D5d1's library messages are already merged, and the view shows them as they are.
     For example: "Generation settings changed. Create a new rendition so provenance
     stays accurate."
   - **Recommended:** keep the library's wording here. Rewriting it means changing
     `podcastrender.mjs` and its tests for copy alone, and the meaning is clear. The
     section's own copy says "recording" everywhere. A later copy pass can align the
     library.
   - **Resolution:** James, 2026-11-11: keep the library's wording; the section's own copy says "recording".
3. **The Open Notebook error panel stops replacing the whole page.**
   - Source: intent, *working locally while Open Notebook is down*.
   - Today `showError` clears the root and draws "Open Notebook is not answering" in its
     place.
   - **Recommended:** the same panel and text render inside the Open Notebook slot only.
     Checked chapters loads separately below it. Nothing else about the Open Notebook
     cards changes. A test pins the split: Open Notebook failing still paints the
     section, and the section failing still paints the Open Notebook cards.
   - **Resolution:** James, 2026-11-11: the Open Notebook panel renders in its own slot, with the section below.
4. **`security-review` runs on the diff, not on this spec.**
   - Source: the spec skill's step 2. It reviews pending code, and there's none yet.
   - **Recommended:** run it on the branch diff before the PR, as in D5d2. *Security and
     data* below covers what it checks.
   - **Resolution:** James, 2026-11-11: run `security-review` on the branch diff before the PR.

## Requirements

Each traces to `intent.md`. A-numbers are the accessibility rules and C-numbers the copy
rules under *Design*.

- **R1. The list route.** `GET /api/podcast/renders?topic=` answers 200 with
  `{ renditions: listRenditions(topic) }`, newest first, `needs_repair` rows included.
  - A missing or unknown topic answers 400.
  - It makes no Open Notebook call.
  - D5d2's test that this path is a 404 changes on purpose.
- **R2. The section.** "Checked chapters" sits below the Open Notebook cards in the
  Podcast view. It has a labelled topic picker (A1) that drives both cards, defaulting to
  the first topic with a notebook mapped.
- **R3. The create card.**
  - It has labelled selects for the chapter source, the episode profile and the speaker
    profile.
    - Sources come from `/api/on/sources?topic=`.
    - Episode profiles come from `/api/on/podcast` and are limited to those
      `configuration_ready`, defaulting to `study-chapter`.
    - Speaker profiles come from `/api/on/speaker-profiles`, defaulting to the episode
      profile's `speaker_config`.
  - **Render chapter** posts through `requestJsonWithMutation` with the key
    `chapter:<topic>:<source>:<episode profile>:<speaker profile>`. One `mutation_id` is
    minted per input and reused until the request succeeds (rule 9).
  - While a request is in flight, the button is disabled.
  - The card's hint follows C8.
- **R4. The list card.** Keyed rows, newest first. Each row has:
  - the chapter title;
  - the stage label (C2), plus the server's progress text;
  - "Preferred" on the newest published recording of each source;
  - QC issues, and repetition times as `m:ss` (C9);
  - a `needs_repair` row that says so and offers nothing to act on.
  - An empty list shows C7.
- **R5. The player.** It appears once a row has checked audio. It's
  `<audio controls preload="none">` on the audio route, with no autoplay (A8). It is
  created once per rendition id and kept across polls (A2).
- **R6. The transcript.** A `<details>` labelled "Transcript and coverage plan". It loads
  from the read route when first opened, and again only after a failed load. It shows:
  - the plan's sections with their anchors;
  - anything excluded from the plan, with the reason;
  - each turn as "Speaker: dialogue".

  All of it is text nodes (rule 12). Markup in model output appears literally.
- **R7. Resume.** "Resume render" appears on an interrupted or `failed` row. It posts
  `{ topic_slug }` with no `mutation_id`. Afterwards, focus moves to the row's status
  line (A5), and the list re-reads at once.
- **R8. Publish.** It appears on `qc_passed` rows only.
  - It's gated by a labelled checkbox: "I listened to the full recording and checked its
    explanations and coverage" (C4).
  - "Publish recording" is disabled until the box is ticked, and it sends
    `full_listen_confirmed: true` only from that state.
  - Afterwards, focus moves to the row's status line (A5).
- **R9. Polling.**
  - While any row is `queued`, `transcript_ready` or `audio_ready` and not
    `interrupted`, the list re-reads every 5 seconds, using `abortableDelay` on the
    section's scope.
  - It stops when no row is active, when the topic changes, and when the view is left.
  - Only stage changes are announced (A3).
- **R10. Open Notebook down.**
  - The section still lists, plays, shows transcripts and publishes.
  - Create and resume are disabled. Each has C6's reason as visible text next to it,
    linked with `aria-describedby` (A4).
  - The Open Notebook panel renders in its own slot (concern 3).
- **R11. Errors.** A failed create, resume, publish or transcript load shows the
  server's message as text in that card or row (A7, C5). It never shows in an alert or
  only as a colour.

## Design

### Files

- **`app/web/js/views/chapterpodcast.mjs`** (new) exports what the tests drive:
  - `stageLabel(rendition)` gives C2's label, including "Interrupted — resume to
    continue";
  - `isActive(rendition)` says whether the poll should keep going;
  - `formatOffset(seconds)` gives `m:ss`;
  - `createChapterSection({ request, scope, delay, topics, onAnnounce })` returns
    `{ element, setOnAvailability(ok, reason), dispose }`. `request` and `delay` are
    injected, so tests drive it with the DOM recorder and fake timers;
  - `renderRow` and `updateRow` are internal, keyed by id.
- **`app/web/js/views/podcast.mjs`:**
  - `load()` keeps its `Promise.all` for the Open Notebook cards.
  - On failure it paints the existing panel into an `onSlot`, instead of `clear(root)`.
  - The root is painted once with `crumb`, `refresh`, `notice`, `onSlot` and
    `chapterSlot`.
  - `chapterSlot` holds `createChapterSection` under a child scope. It's told whether
    Open Notebook is available after each Open Notebook load.
- **`app/router.mjs`:** the `GET /api/podcast/renders` collection branch in
  `handlePodcastRenders`.
- **`app/web/css/app.css`:** at most a `.chapter-row` grid and a `.stage` label. No new
  colours: tokens only (A9).

### States

| Section state | Shows |
|---|---|
| Loading | "Loading checked chapters…" in the list card |
| Empty | C7 |
| Rows, none active | Rows. No poll. |
| Rows, some active | Rows. Polling. Stage changes announced. |
| Open Notebook down | Rows as above. Create and resume disabled with C6. The Open Notebook panel in its slot. |
| List route failed | The error as text in the list card, and a "Try again" button. The create card is unaffected. |

### Copy rules (from `design:ux-copy`)

- **C1. One noun.** The user-facing noun is "recording". "Rendition" stays in code and
  in server messages (concern 2).
- **C2. Stage labels:**

  | Stage | Label |
  |---|---|
  | `queued` | Queued |
  | `transcript_ready` | Voicing |
  | `audio_ready` | Checking audio |
  | `qc_passed` | Ready to review |
  | `published` | Published |
  | `needs_review` | Failed checks |
  | `failed` | Stopped |
  | `needs_repair` | Needs repair |

  An interrupted rendition reads "Interrupted — resume to continue".
- **C3. Buttons:** "Render chapter", "Resume render", "Publish recording". Also "Try
  again" for a failed list load.
- **C4. The publish gate:** "I listened to the full recording and checked its
  explanations and coverage". There's no extra dialog.
- **C5. Errors:** the server's message as it is, plus an action where one exists.
- **C6. Outage:** "Rendering needs Open Notebook, which isn't answering. Recordings below
  still play and can be published."
- **C7. Empty:** "No checked chapters for this topic yet. Choose a chapter above and
  render it."
- **C8. The create hint:** "Takes about 5 minutes. The transcript is checked before
  it's voiced, and the recording waits for your full listen before it's published. You
  can leave this view; the render keeps going."
- **C9. Times:** "Check 1:42, 3:05".

### Accessibility rules (from `design:accessibility-review`)

- **A1. Labels.** Every select and the checkbox has a `<label for>`. No icon-only
  controls.
- **A2. In-place updates.** Rows are keyed and updated in place. Audio, an open details
  element and focus survive every poll.
- **A3. One polite live region** for the section, announcing stage changes only.
- **A4. Visible reasons.** A disabled control's reason is visible text, linked with
  `aria-describedby`.
- **A5. Focus.** After resume or publish, focus goes to that row's status line
  (`tabindex="-1"`).
- **A6. Native elements only.** Keyboard use comes free.
- **A7. Errors are text** in place, never colour alone.
- **A8. No autoplay.**
- **A9. Existing tokens and focus rings.**

### Answers to the intent's open questions

- **The poll and the view's other timers.** The 5-second poll runs on the section's own
  child scope, separate from the Open Notebook job polls and from `refresh`. Clicking
  "Refresh podcast status" also re-reads the section, because the root `load()` calls
  the section's `reload()`. The poll keeps its own timer, so the two never stack: a
  reload cancels a pending poll delay and schedules a new one.
- **The error panel and the section.** They share the page as two slots (concern 3,
  and the states table above).

## Security and data

- **No new write path.** Create, resume and publish are D5d2's routes behind the guard.
  The new route is a GET of local manifests, with the topic checked by
  `assertKnownTopic`.
- **Model output is text.** Transcript dialogue, anchors and progress strings go into
  the page through `el()` and text nodes only, never `innerHTML`. A test plants
  `<img src=x onerror=…>` in a turn and asserts it appears as literal text.
- **Rule 7** isn't involved. **Rule 9:** create's id is minted once per input and reused
  until success. A test pins it.
- **The publish gate is client-side convenience.** The server still refuses anything
  but `full_listen_confirmed === true` on a `qc_passed`, unchanged candidate (D5d2).

## Acceptance checks

These seed `plan.md`'s Proof section.

- `npm test` with `node_modules` absent passes, none skipped.
- Route tests for the list (R1):
  - newest first;
  - a `needs_repair` row for a damaged manifest;
  - 400 for a missing or unknown topic;
  - the stub sees no Open Notebook request.
- Helper tests: `stageLabel` covers every stage plus interrupted; `isActive`;
  `formatOffset`.
- Section tests with the DOM recorder, an injected `request` and a fake `delay`:
  - a poll with an unchanged stage keeps the same `<audio>` and `<details>` element
    instances, and the open state (A2);
  - only stage changes reach `onAnnounce` (A3);
  - polling stops with no active rows, on a topic change, and on dispose (R9);
  - publish is disabled until the checkbox is ticked, and sends `true` only then (R8);
  - create reuses one `mutation_id` across a failed attempt and its retry (R3);
  - transcript markup appears as literal text (R6);
  - with Open Notebook unavailable, create and resume are disabled with the reason
    linked by `aria-describedby` (R10).
- A Podcast view test: Open Notebook failing still paints the section, and the section
  failing still paints the Open Notebook cards (concern 3).
- Driven live in the browser pane on a `/tmp/learn` copy, with screenshots in `plan.md`:
  - render fastbook 20 from the form, and watch the stages change with no refresh;
  - play and seek fastbook 01 while a poll runs, and confirm the audio doesn't stop;
  - open a transcript;
  - publish fastbook 01 via the checkbox, after James's full listen;
  - restart with `STUDYDECK_ON_BASE_URL` pointing at a dead port, and confirm the list
    plays and create is disabled with C6.
- `security-review` on the branch diff, then Codex until `NO_FINDINGS`.

## Open questions

- **Whether James has finished the full listen of fastbook 01.** Publishing it in the
  live drive waits on that. If he hasn't, the drive publishes nothing and records why.
  James answers.
