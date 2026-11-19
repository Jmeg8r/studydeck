---
change: 2026-11-11-chapter-render-view
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: a Checked chapters section in the Podcast view

## Files that change

- **`app/router.mjs`:** the `GET /api/podcast/renders?topic=` branch (R1).
- **`app/web/js/views/chapterpodcast.mjs`** (new):
  - `stageLabel`, `isActive` and `formatOffset`;
  - `createChapterSection({ request, scope, delay, topics, onAnnounce })`.
- **`app/web/js/views/podcast.mjs`:** the load split (concern 3). The Open Notebook panel
  moves into `onSlot`, and the section goes into `chapterSlot`, on a child of the view's
  scope.
- **`app/web/css/app.css`:** `.chapter-row` and `.stage` only, from existing tokens.
- **`app/test/fixtures/dom.mjs`:** small, additive changes the section's tests need.
  - `focus()` records `document.activeElement`.
  - `disabled`, `checked` and `open` stay plain properties, as now.
  - Changing `open` on a `<details>` dispatches `toggle`.
  - Nothing an existing test relies on changes.
- **Tests:**
  - `app/test/podcastrenderroutes.test.mjs`: the list route. Its "GET collection is a
    404" case changes on purpose.
  - `app/test/chapterpodcast.test.mjs` (new): the helpers and the section.
  - `app/test/podcast-lifetime.test.mjs`: cases for the load split. Its stub `fetch`
    learns the list route. Every existing case must stay green unchanged.

## Order of work

Each step goes red, then green, in separate commits. Each red commit records its run.

1. **The list route (R1).**
   - Red cases:
     - 200 with `{ renditions }`, newest first;
     - a `needs_repair` row for a damaged manifest;
     - 400 for a missing or unknown topic;
     - the stub logs no Open Notebook request;
     - the old 404 case is replaced, and the commit says so.
2. **The helpers (C2, C9, R9).**
   - Red cases:
     - `stageLabel` for every stage, plus interrupted;
     - `isActive` is true for queued, `transcript_ready` and `audio_ready` unless
       interrupted, and false otherwise;
     - `formatOffset(102)` gives `1:42`, and `0` gives `0:00`.
3. **Rows, and in-place updates (R4, R5, A2, A3).** This step comes first among the
   section's because it decides the shape of everything after it.
   - Red cases:
     - the list paints one row per rendition, newest first, with C7 when empty;
     - after a second list response where a row's stage is unchanged, the row's
       `<audio>` and `<details>` are the same instances, the open state is kept, and
       only the progress text differs;
     - a stage change reaches `onAnnounce` once, and a progress-only change never does;
     - a `needs_repair` row offers no actions.
4. **Polling (R9).**
   - Red cases, with a fake `delay`:
     - it polls while a row is active;
     - it stops when none is, on a topic change, and on `dispose`;
     - a manual reload cancels the pending delay and doesn't stack a second loop.
5. **Resume and publish (R7, R8, A5).**
   - Red cases:
     - publish is disabled until the checkbox is ticked, and sends exactly
       `{ topic_slug, full_listen_confirmed: true }`;
     - resume sends `{ topic_slug }` with no `mutation_id`;
     - after either, focus is on the row's status line and the list re-reads;
     - a refused request shows the server's message in the row.
6. **Create and the outage path (R3, R10, A4).**
   - Red cases:
     - one `mutation_id` across a failed attempt and its retry, then a new one after a
       success;
     - the button is disabled while in flight;
     - with Open Notebook unavailable, create and resume are disabled, C6 is visible
       text, and each control's `aria-describedby` points at it.
7. **The transcript (R6).**
   - Red cases:
     - loaded on first open only, and reloaded after a failed load;
     - a turn containing `<img src=x onerror=alert(1)>` appears as literal text;
     - plan sections and anything excluded are listed.
8. **The load split (concern 3).**
   - Red cases in `podcast-lifetime.test.mjs`:
     - Open Notebook failing still paints the section, with the panel in its slot;
     - the list route failing still paints the Open Notebook cards;
     - leaving the view aborts the section's requests too;
     - every existing lifetime case still passes.
9. **CSS, then drive it live.**
   - Start the server on the `/tmp/learn` copy at port 4320 (the same approach as D5d2).
   - Render fastbook 20 from the form, watching the stages change without a refresh.
   - Play and seek fastbook 01 while a poll runs.
   - Open a transcript.
   - Publish fastbook 01 only if James confirms his full listen; otherwise record that
     it was skipped.
   - Restart with `STUDYDECK_ON_BASE_URL` pointing at a dead port, and confirm the list
     plays and create is disabled with C6.
   - Take screenshots of the normal, running and Open-Notebook-down states.
   - Check the page with a keyboard: Tab through the section and confirm visible focus.
10. **Verify and ship.**
    - `npm test` with no `node_modules`.
    - `npm run verify`.
    - `security-review` on the branch diff.
    - Codex until `NO_FINDINGS`, then the PR, with every run posted.

## Deviations from the spec

- **Profiles are filtered on `transcript_model`, not `configuration_ready` (R3).** The
  spec took `configuration_ready` from September's `/api/on/podcast`, which `main` doesn't
  return. The live drive showed an empty select. `main`'s profiles carry
  `transcript_model`. The stock profiles have none, and the view's profiles card already
  flags them as "transcript model unset". Fixed test-first (`76695a2` red, `463ed53`
  green).
- **Profiles come from the Podcast view, not a second request.**
  `setOpenNotebook(available, { profiles, speakerProfiles, reason })` takes what the view's
  own Open Notebook load found. The section fetches only the topic's sources.
- **The Open Notebook panel keeps the refresh button.** Before, the panel replaced the
  whole page and had none. Now it sits in its own slot, so a retry no longer needs a view
  reload.
- **The section exists only when the view is given topics.** `main.mjs` passes
  `state.topics` and the current topic. Any other caller gets exactly the old view.
- **The recorder gained `focus()` only.** The tests dispatch `toggle` themselves rather
  than the fixture doing it.
- **Players are released on row removal and topic change too,** not only on leaving the
  view.
- **The plan's anchor shows the source's own markdown** (for example
  `` ```python [[chapter_conclusion]] ``). It's the chapter text the section was cut from,
  shown as text. It isn't restyled here.

## Risks

- **The DOM recorder isn't a browser.** It can show that element instances survive a
  poll, but not that audio keeps playing. Step 9's live drive checks that by playing
  through a poll.
- **The load split touches a view with fifteen lifetime tests.** They run unchanged as
  the regression check. Only the stub learns one new route.
- **The live render spends about 1 to 2 minutes of local model and voice time.** It's on
  the copy only.

## Proof

### Green, 2026-11-11

- **Tests:** `npm test` with `node_modules` absent passes 912 of 912, with none skipped.
  `npm run verify` is clean.
- **Test first:** each step's red commit records its run.
  - Cases that passed on arrival were kept as guards, and their commits say so:
    no poll when nothing is active, and no buttons on rows that can't act.
  - One gap was found while green: a refused publish left its button stuck disabled. It
    got a test that failed before the fix.
- **`security-review`** (a Sonnet subagent, read-only) found no vulnerabilities. It
  checked:
  - every DOM sink: text nodes only, and `setAttribute` for the audio `src`, `aria-label`
    and `data-id`, with no `innerHTML`;
  - the list route's guard and path checks;
  - whether the Open Notebook password could reach the page;
  - the publish gate.
- **Codex** (`gpt-6.1-sol`) ran three times:
  - **Run 1:** two P2s, fixed test-first (`ea42c58` red, `ca29566` green).
    - Re-appending rows on every poll detached them and dropped focus. Same element
      instances weren't enough.
    - A transcript read mid-render stayed cached.
  - **Run 2:** three P2s, fixed test-first (`534b3c0` red, `17b1253` green).
    - A status refresh reset the chosen chapter and speakers.
    - An older transcript read could replace a newer one, which run 1's fix didn't cover.
    - One failed poll stopped polling.
  - **Run 3:** `NO_FINDINGS` at `17b1253`.

### Live drive, 2026-11-11 (step 9)

This branch's server ran on a `/tmp/learn` copy at port 4320. The config copy was passed
with `STUDYDECK_CONFIG_PATH`. Screenshots are in `screens/`.

- **The section renders below the Open Notebook cards.** The topic defaults to the
  cockpit's current topic. After switching to fastai: 21 chapter sources, the profiles
  `study-chapter`, `study-deep-dive`, `study-overview` and `tech_discussion` with
  `study-chapter` the default, and the speakers `tech_experts`.
- **Render chapter from the form.** fastbook 20 ("Concluding Thoughts") with
  `tech_experts-mixed-v2` went from Queued, through Voicing ("Speaking turn 2 of 6" up
  to "6 of 6"), to Ready to review, with no manual refresh.
  - The live region announced "Voicing" and then "Ready to review".
  - The rendition: `render-673b6155fba933dbce9f7a98`, 1 section passing on its first
    try, 6 turns, 80.0 s at −16.9 LUFS and −1.7 dB true peak, no issues. It took 79.1 s
    from create.
- **Playback through the polls.** fastbook 01 played muted while fastbook 20 rendered.
  - Every 5-second sample found the same `<audio>` element, not paused.
  - During assembly, playback advanced only 2.1 s and then 1.3 s per 5 s: the media
    stalled while the same server process ran ffmpeg.
  - Afterwards it advanced 9.96 s in 10 s. So the element survives every poll, but
    playback can stutter while a render assembles on this machine. That's server load,
    not the view.
- **Transcript.** Opened on fastbook 20, it loaded once: the plan's section and 6 turns,
  as text. Publish stayed disabled behind its labelled checkbox.
- **Publish was skipped.** James hasn't confirmed his full listen of fastbook 01, and
  publishing without it would record a false review.
- **Open Notebook down.** The server was restarted with `STUDYDECK_ON_BASE_URL` pointing
  at a listener on 4399 that hangs up every connection: a socket of ours, so the bearer
  can't reach anyone else.
  - The Open Notebook panel showed in its own slot.
  - The section still listed both recordings, each with its player and Publish.
  - Render chapter was disabled, with `aria-describedby` pointing at C6 plus the address
    that failed.
  - fastbook 01 played 3.96 s in 4 s, with no media error.
- **Keyboard.** From the topic picker, Tab went to the source, the episode profile and
  the speaker profile, skipped the disabled Render chapter, then reached fastbook 20's
  player, which showed the browser's focus ring.
- **Your tree.** `git status` in James's checkout was clean afterwards.
