---
change: 2026-11-10-local-video-validators
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: local videos answer HEAD and revalidate instead of re-downloading

## Files that change

- `app/lib/localmedia.mjs` (new): `sendLocalMedia(req, res, { path, type })`, the snapshot's
  helper minus its `sha256` option. It handles validators, conditional requests, `If-Range`,
  ranges and `HEAD` for a file on disk.
- `app/router.mjs`:
  - the `/media/videos/` route matches `GET` and `HEAD`;
  - the route calls `sendLocalMedia`;
  - `sendVideo` is deleted, since its range parsing moves into the helper unchanged in
    behaviour.
- `app/test/localmedia.test.mjs` (new): the route tests. They set `STUDYDECK_VIDEO_DIR` to a
  temporary shelf before importing the router, so no real video is needed and none is touched.

## Order of work

1. **Commit 1, tests only** (`test(media): ...`), driving `handleRequest` against a temporary
   shelf holding a small fixture file with a known byte pattern.
   - **Kept green as controls, so the refactor can't regress them:**
     - full `GET` is `200` with `accept-ranges: bytes`;
     - `bytes=0-99`, `bytes=100-` and `bytes=-100` give `206` with exactly those bytes and a
       correct `content-range`;
     - a past-the-end range gives `416` with `bytes */<size>`;
     - a multi-range request still gives `416`;
     - a name outside the shelf is still `404`.
   - **Red against `main`:**
     - `HEAD` is `200` with the `GET` headers and an empty body;
     - `GET` carries `etag` and `last-modified`;
     - a matching `If-None-Match`, `*`, and `W/` give `304` with no body;
     - a non-matching `If-None-Match` gives `200`;
     - `If-Modified-Since` at or after mtime gives `304`, but not when an `If-None-Match` is
       also present and doesn't match;
     - `If-Range` with a stale `ETag` gives a full `200`, while with the current `ETag` or
       `Last-Modified` it gives `206`;
     - the `304` and `HEAD` responses still carry `x-content-type-options`.

   The red run goes in the commit message and Proof.
2. **Commit 2, the fix** (`fix(media): ...`): `localmedia.mjs`, plus the route change and the
   removal of `sendVideo`. Then run the test file, `npm test` with no `node_modules`, and
   `npm run verify`.
3. **Live probe** on the worktree's router at port 4319, with `STUDYDECK_VIDEO_DIR` pointed at
   the main checkout's `docs/`. The route is read-only; no `.learn` data is involved, and
   `/tmp/learn` is used anyway. Repeat the seven measurements from the intent: `HEAD`, `GET`
   headers, `Range`, `If-None-Match: *`, a future `If-Modified-Since`, a stale `If-Range`,
   and multi-range.

   Then load a video in the browser pane, check it plays, seek to the middle, and record the
   requests the player sends.
4. PR through `forge-pr create`. Then `/gstack-codex review origin/main`, posted verbatim with a
   GATE line. Then the AI gate, triaged. Then James's merge approval. After merging, James
   restarts the cockpit (`launchctl kickstart`), because this is server code.

## Risks

- **A strong ETag from size and mtime is not a content hash.** A file rewritten within the
  same millisecond at the same size would keep its ETag. The shelf holds hand-placed tutorial
  recordings, so that's acceptable, and the snapshot made the same choice. A content hash would
  mean reading 46MB per request, or keeping a cache.
- **`If-Modified-Since` at one-second resolution.** HTTP dates drop milliseconds, so the
  comparison floors the mtime to the second, as the snapshot does. Otherwise a fresh file
  would never revalidate.
- **The browser pane can't prove Safari's behaviour on iOS.** The probe covers the HTTP
  contract; actual iPhone playback over the tailnet stays a manual check for James.

## Proof

- **Commit 1** (`13fc62f`): against `main` (`db893d7`), with no `node_modules`,
  `localmedia.test.mjs` runs 10 tests: 4 pass (the controls) and 6 fail. The failures are
  `HEAD` (404), no ETag, no 304 for `If-None-Match` or `If-Modified-Since`, a `206` for a
  stale `If-Range`, and the security headers on `HEAD` and `304`.
- **Commit 2** (`3c3e05d`): `localmedia.test.mjs` 10 pass. `npm test` 603 pass, 0 fail, no
  `node_modules`. `npm run verify` finds no damage.
- **Live probe**, 2026-11-10: the worktree's router on port 4319, with
  `STUDYDECK_VIDEO_DIR` set to the main checkout's `docs/` and `STUDYDECK_LEARN_ROOT` set to a
  `/tmp/learn` copy. The file is `study-flow-tutorial.mp4` (46,318,202 bytes), and every
  request was read-only.

  | Request | Before (live cockpit) | After (port 4319) |
  |---|---|---|
  | `HEAD` | 404 JSON | 200, `video/mp4`, ETag, length 46318202, 0 body bytes |
  | `GET` validators | none | `etag: "2c2c27a-19f71f0e8a2"`, `last-modified: Fri, 17 Jul 2026 21:17:21 GMT` |
  | `If-None-Match: *` | 200, 46318202 bytes | 304, 0 bytes |
  | `If-None-Match: <current>` | n/a | 304, 0 bytes |
  | `If-Modified-Since` in the future | 200, 46318202 bytes | 304, 0 bytes |
  | `If-Modified-Since` equal to `Last-Modified` | n/a | 304, 0 bytes |
  | stale `If-Range` + `bytes=0-99` | 206, 100 bytes | 200, 46318202 bytes |
  | current `If-Range` + `bytes=0-99` | n/a | 206, 100 bytes |
  | `Range: bytes=0-99` | 206, `bytes 0-99/46318202` | 206, `bytes 0-99/46318202` |
  | multi-range | 416 | 416 |
  | `..%2Fpackage.json` | not measured | 404 |

  `x-content-type-options: nosniff` is present on `GET` and `HEAD`.
- **Browser seek**, in the built-in browser (Chromium) on port 4319: a muted `<video>` loaded
  metadata (duration 168.6 s), seeked to 84.3 s, and reached `readyState` 4 with 75–93.7 s
  buffered and no media error. The player sent three range requests, all answered `206`.
  Chromium aborted two of them as part of seeking, and the server log recorded nothing for
  those aborts.
- **Not verified:** playback on the iPhone over the tailnet (Safari), which stays a manual
  check for James after the merge and restart.

## Deviations

- **`cache-control: private, max-age=0, must-revalidate` on every answer.** The intent didn't
  name it. Without it, a browser may cache heuristically from `Last-Modified` and skip
  revalidating, so a replaced tutorial could keep playing from cache. That would undo the
  point of the validators. The snapshot sent the same header.
- **A `416` now carries `content-length: 0`.** `sendVideo` sent only `content-range`. Without
  a length the client waits for the connection to close to find the end of the empty body.
  The status and `content-range` are unchanged, as the controls require.
- **Codex found a regression the controls missed (PR #144, P2), fixed test first.** The move
  into `parseRange` gave suffix ranges an early return that skipped the bounds check
  `sendVideo` applied to every range. `bytes=-0`, or any suffix range on an empty file, wrote
  a `206` and then threw `ERR_OUT_OF_RANGE` in the read stream, after the headers were sent.
  - **Red** (`bfd9591`): with a 5 s test timeout, 10 pass and 1 cancelled. The server logged
    `RangeError [ERR_OUT_OF_RANGE] … Received 1000`.
  - **Green** (`44d637f`): one bounds check now covers both forms. `localmedia.test.mjs` runs
    11 pass, and `npm test` 604 pass, 0 fail, with no `node_modules`. `npm run verify` finds
    no damage.
  - **Lesson:** the controls pinned only the ranges that worked, not the edge cases the old
    code rejected. A refactor's controls need the rejections too.

## Options not taken

- **Port the snapshot's full `routes/podcast.mjs` and media split.** That is a relocation of
  code `main` already runs. This slice takes only the helper the video route needs.
- **Answer multi-range with `200` (ignore the `Range`).** It's allowed, but it changes
  behaviour no client here relies on, and it isn't what the slice is for.
