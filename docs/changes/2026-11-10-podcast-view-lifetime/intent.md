---
change: 2026-11-10-podcast-view-lifetime
status: accepted
track: T1
risk: low
risk_reason: Browser-side Podcast view only, inside one repo. No server route, state.json, mastery, attempts or sidecar changes. The worst failure is a player that loses its place, or an extra status request after leaving the view. Both are visible in the Podcast view, and DOM-recorder tests cover both.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: refreshing the Podcast view keeps the player, and leaving it releases everything it started

## Problem

This is slice D4 of porting PR #98's September snapshot (`264547c`, area D: podcasts).
The snapshot's test is `app/test/podcast-lifetime.test.mjs`, and its fix lives in
`createViewScope` (`app/web/js/lifecycle.mjs`) and `renderPodcast`
(`app/web/js/views/podcast.mjs`).

On `main`, `renderPodcast` reloads itself by calling itself:

```js
const reload = () => { if (!signal.aborted) renderPodcast(root); };
```

`reload` runs when a standalone render or a batch job finishes. That causes three
defects:

1. **A reload's work outlives the view.** The nested call returns a new cleanup, and
   nothing keeps it. `main.mjs` still holds the first render's cleanup, so leaving the
   view aborts the first render only. The second render's requests and job polls go on
   against a detached surface. A poll runs every 3 s for up to an hour
   (`POLL_MS`, `POLL_CEILING_MS`). The first render is never aborted by a reload either,
   so its card polls keep running beside the new ones, and they can call `reload()`
   again.
2. **A finished render cuts off whatever you're listening to.** A reload clears the
   whole view and rebuilds every episode row. If an episode is playing, its `<audio>`
   is removed, which pauses it, and the replacement starts at 0:00.
3. **Leaving the view doesn't release the player.** The detached `<audio>` keeps its
   `src`. The audio route proxies the stream from Open Notebook and stops the upstream
   fetch only when the client closes, so a buffered element can hold that connection
   open.

## Outcome

- The Podcast view owns one scope (`createViewScope`). Every request, poll and player
  it starts is tied to that scope, and so is every request or poll started by a
  reload. Leaving the view disposes all of it, exactly once. A second cleanup call
  does nothing.
- A reload refreshes the status-driven cards in place. It keeps each episode's existing
  `<audio>` element, by episode id, so playback and position survive. An episode that
  is new to the list gets a new row.
- A **Refresh podcast status** button runs the same reload. Today the only way to see
  new episodes is to navigate away and back.
- Leaving the view pauses each player, removes its `src` and calls `load()`, which
  releases the media resource and its connection.
- **Position memory (cut at acceptance if unwanted):** a player's position is saved to
  `localStorage` under `studydeck.audio.<episode id>.<ETag>` and restored on the next
  visit.
  - The ETag comes from a `HEAD` on the audio route, sent on the first `play` rather
    than on load. That way, opening the view doesn't send one request to Open Notebook
    for each of the 24 episodes.
  - If Open Notebook sends no ETag, nothing is saved. A re-rendered episode then never
    resumes at a position from the old audio.

## Out of scope

- The snapshot's `/api/podcast/library` route, its 5-second library polling, the
  chapter podcast card, rendition actions and issue reporting. Those are separate
  features, not lifetime fixes.
- The Reading view's lifetime (`reading-lifetime.test.mjs` in the snapshot).
- Any server change. The audio route already answers `HEAD`.
- D3 (profile export and restore), Recovery, and D5 (the local renderer).
