---
change: 2026-11-10-podcast-view-lifetime
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: refreshing the Podcast view keeps the player, and leaving it releases everything it started

## Files that change

- **`app/web/js/lifecycle.mjs`**: add `createViewScope()`, ported from the snapshot as
  is. It returns:
  - one `AbortController`'s `signal`;
  - `own(cleanup)`, which runs the cleanup at once if the scope is already disposed and
    returns an un-own function;
  - an idempotent `dispose()`.
- **`app/web/js/views/podcast.mjs`**:
  - `renderPodcast` creates one view scope and returns `() => scope.dispose()`.
  - `reload()` no longer calls `renderPodcast`. It disposes the previous *generation*,
    which is a child scope owned by the view scope, and creates a new one. It then
    fetches the three status requests on the new generation's signal and repaints only
    the status-driven cards: the TTS-blocked, generate, batch and profiles cards.
  - The episode list keeps a `Map` from episode id to row. A reload reuses each
    existing row and its `<audio>`, adds rows for new episodes, and removes rows for
    episodes that are gone. A removed row is disposed like any other player.
  - Each `<audio>` registers `scope.own(...)`, which saves the position, pauses, removes
    `src` and calls `load()`.
  - A **Refresh podcast status** button calls `reload()`.
  - Position memory: a lazy `HEAD` on the first `play` reads the `ETag`. The key is
    `studydeck.audio.<id>.<etag>`, saved on `pause`, every 10 s of `timeupdate`, and on
    dispose. The position is restored on `loadedmetadata` when it is greater than 0 and
    more than 2 s before the end. With no ETag, nothing is read or written. Every
    `localStorage` call is wrapped in `try/catch`.
- **`app/test/fixtures/dom.mjs`** (new): the snapshot's DOM recorder, extended only as
  far as `el()` and `renderPodcast` need.
- **`app/test/podcast-lifetime.test.mjs`** (new): the snapshot's test, adapted to
  `main`'s routes (`/api/on/podcast` carries the episodes; there is no
  `/api/podcast/library`).
- **`app/test/viewscope.test.mjs`** (new): the `createViewScope` cases. They go in their
  own file, not `lifecycle.test.mjs`, so that the red run, where the export is missing,
  doesn't kill the existing delay tests.

## Order of work

1. **Red, committed first:** `viewscope.test.mjs` and `podcast-lifetime.test.mjs`
   with the DOM fixture. The run output goes in the commit message and in Proof. The
   tests:
   - (a) a refresh keeps the same `<audio>` element and its `currentTime`, with no
     `pause` and no `load`;
   - (b) cleanup pauses and unloads each player once, and a second cleanup is a no-op;
   - (c) after a refresh and then cleanup, every `signal` handed to `fetch` is aborted.
     This is the orphaned-reload leak;
   - (d) with an ETag, the position is saved under `studydeck.audio.<id>.<etag>`. With no
     ETag, nothing is written;
   - (e) the `createViewScope` cases: `own` after `dispose` runs at once, `dispose` is
     idempotent, and un-own works.
2. `createViewScope` in `lifecycle.mjs`, which turns (e) green.
3. The `renderPodcast` restructure: scope, generations and the reload in place. This
   turns (a) to (c) green.
4. Position memory, which turns (d) green.
5. Verify, Codex, then the PR.

## Risks

- **DOM-recorder fidelity.** The fixture isn't a browser. HTML says removing a playing
  element pauses it, and the fixture doesn't model that. The tests pin what *our* code
  does (calls `pause` or `load`, keeps the element). Real playback is checked by hand in
  the browser.
- **Reusing a row while the status changes.** An episode whose `audio_available` flips
  from false to true must gain a player on reload. The row is rebuilt when that flag
  changes. A row is reused only when it already has a player.
- **A `HEAD` per first play.** It's one request per episode played, and it goes through
  the existing proxied route, which answers `HEAD`. If it fails, that episode simply has
  no position memory.
- **`main.mjs` is unchanged.** It already stores the cleanup that `renderPodcast`
  returns.

## Proof

- `npm test` with `node_modules` absent: every test passes, and the new ones were red
  first.
- `npm run verify`: clean.
- A browser check against the scratch server (`/tmp/learn` copy, `127.0.0.1:4319`):
  1. Play an episode, click **Refresh podcast status**, and confirm playback continues
     without a restart.
  2. Navigate to Today, and confirm in the network panel that no further
     `/api/on/podcast*` requests appear.
  3. Come back and confirm the position is restored, if Open Notebook sends an ETag.
     Record whether it does.
- `/gstack-codex review origin/main`, posted on the PR.

### Results, 2026-11-10

- **Red first (`b800145`, against `main` at `b6d88d3`):** 8 tests, 2 pass, 6 fail, and
  `viewscope.test.mjs` failed at load (no `createViewScope` export). The two that passed
  are guards (no `HEAD` before play, nothing saved without an ETag). The played-episode
  test is the control for the second one.
- **`npm test` with no `node_modules`:** tests 630, pass 630, fail 0. **`npm run verify`:**
  no damage found.
- **Browser, scratch server on `127.0.0.1:4319` with `/tmp/learn`.** The probe episode
  was `episode:zdf60jyqkymusr7frjwh`, played muted because of autoplay policy.
  - Playing, then **Refresh podcast status**: the same element stayed in the
    document, `paused` stayed false, and `currentTime` went from 4.10 to 6.59. All 24
    players were still present.
  - Leaving for Today: the player was paused, `src` null, `networkState` 0
    (NETWORK_EMPTY). There were no `/api/on/podcast*` requests after leaving. The only
    `/api/on/` resource entries were the released audio stream closing and Today's own
    `/api/on/health`.
  - Open Notebook does send an ETag (`HEAD` returned 200 with a quoted hash). The
    position was saved as `studydeck.audio.episode:zdf60jyqkymusr7frjwh."1d92…19fa"` =
    27.24. On return and play it resumed at 27.24, reading 30.14 after about 3 s.
  - The test keys were removed from the browser afterwards.
- **Seen, not fixed:** the episodes card renders one text node `null`, as the fixture
  predicted (see Deviations).
- **Browser re-check after Codex converged (code at `dbe3a76` plus the `no-store` fix).** A
  first attempt reused a tab that had loaded the page before fixes 2 to 4: `navigate` only
  changed the hash, so the old script was still running. The checks below are from a full
  reload, with the script confirmed to contain the new code.
  - Restoring found a real defect that no reviewer had caught. At the start of playback a
    cacheable `HEAD` waits on Chrome's HTTP-cache lock for the audio URL. Racing play on
    fresh episodes, a plain `HEAD` took over 8 s (20.07 s in one run), while `cache:
    'no-store'` took 42 ms. Over curl the `HEAD` takes about 30 ms. With `no-store`, a
    saved 120 s resumed at 121.4 s within 1.5 s of play.
  - Refresh mid-play: the same element, still playing, went from 122.9 s to 125.4 s.
    Leaving: paused, `src` null, `networkState` 0, and 0 `/api/on/podcast*` requests
    after leaving. Test keys were removed after leaving.

## Options not taken

- **Port the snapshot's `/api/podcast/library` route and 5 s polling.** That's a new
  feature with a server route, not a lifetime fix. It's out of scope in the intent.
- **Key position memory on `asset_sha256`,** as the snapshot does when present.
  `main`'s episode payload has no such field, and adding one is a server change.
- **Send a `HEAD` for every episode on load,** as the snapshot does when the version is
  unknown. That's 24 Open Notebook requests per visit, for players most visits never
  touch.

- **Update the forms' option lists in place on a refresh,** as Codex run 1 suggested,
  rather than rebuilding idle forms. That would keep typed input and an earlier preview
  report, but it needs an update path inside both `generateCard` and `batchCard`. That's
  a refactor of the forms, not of the view's lifetime, so it's left for a follow-up.

## Deviations

- **A refresh leaves a busy form alone.** The plan had every reload repaint every
  status-driven card. The forms own the job polls, so repainting one mid-render would
  abort a poll the learner is watching (the job keeps running in Open Notebook, but its
  progress line goes dead).
  - The first cut rebuilt the forms only when `tts_ready` changed. Codex run 1 (P2)
    showed that this left stale profile and voice lists, so a speaker profile created by
    Generate wasn't offered after its own job's refresh.
  - Now each form calls `busy.start()` and `busy.end()` around an operation. A refresh
    rebuilds the forms unless one is busy and `tts_ready` is unchanged, in which case it
    leaves them alone.
  - The fix for run 1 also re-applied a deferred refresh on the last `busy.end()`. Codex
    run 4 (P2) showed that this erased the outcome the operation had just shown: a batch
    preview's deletion report, with **Preview only** reset to unchecked. Nothing
    re-applies a deferred refresh now. A finished render already refreshes by itself,
    and its fetch lands after its form is idle, so its new profiles still arrive. A
    failed render or a preview keeps its outcome on screen until the next refresh.
  - A refresh that finds the forms idle still rebuilds them, which clears typed input
    and an earlier preview report. `main`'s full reload did the same; updating the
    forms' option lists in place is noted under Options not taken.
  - Requests for a refresh run on their own child scope, which the next refresh
    disposes.
- **A failed refresh keeps the painted view.** On `main` any failure replaced the view
  with the error panel. After the first paint, a failed refresh now shows a line above
  the forms instead, so the players aren't torn down by a transient Open Notebook error.
  The error panel is still shown when the first load fails.
- **The DOM fixture turns a non-node `append` argument into text,** as a browser does.
  Under it, `main`'s episodes card was seen appending `null` (`matchingNote` when no
  notebook match is incomplete), which a browser renders as the text "null". Not fixed
  in this slice; see the PR.
- **Restore is decided from where playback started, not from when the ETag arrives.** The
  plan restored "when the position is greater than 0" once the version was known, and the
  first cut checked `currentTime` at that moment. Codex run 2 (P2) showed that a `HEAD`
  slower than 2 s let playback pass the threshold, so the saved position was skipped and
  then overwritten. The player now records whether playback started at the top, and
  restores only if it did and no `seeking` happened before the version came back. A
  deliberate seek is kept.
- **Saving waits while a restore is owed.** Codex run 3 (P2) showed that when the ETag
  arrives before the audio metadata, the restore is deferred to `loadedmetadata` but
  saving is already live, so a pause or leaving the view wrote 0 over the remembered
  position. A deferred restore now sets `restoreOwed`, and `save()` writes nothing until
  the restore lands or the learner's own `seeking` supersedes it.
- **The version `HEAD` is sent with `cache: 'no-store'`.** This was found in the
  browser re-check, as recorded under Proof. A cacheable `HEAD` at the start of playback
  queued behind the stream's cache entry for up to 20 s, so the resume landed long after
  playback began.
