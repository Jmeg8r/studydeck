---
change: 2026-11-09-seekable-episode-audio
status: accepted
track: T2
risk: medium
risk_reason: Changes the only route that streams podcast audio to the browser, now also reached from James's iPhone over the tailnet. A mistake shows as audio that will not play or seek, or as an upstream header or error body reaching the browser.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: podcast episodes play to the end and can be seeked, on any device

## Problem

In James's words today: "Yes, start C1", the second slice of porting PR #98's September
snapshot (`264547c`, area C: media streaming).

`GET /api/on/episodes/:id/audio` proxies Open Notebook's episode audio. Measured on the
live cockpit on 2026-11-09 against a 6,930,433-byte episode:

1. **It cuts slow downloads off after 15 seconds.** `episodeAudio`
   (`app/lib/opennotebook.mjs`) passes `AbortSignal.timeout(15_000)` to `fetch`, meaning it
   as a connection timeout; it also aborts the body. Throttled to 200 KB/s, the download
   stopped at 4,521,412 bytes (`curl` exit 18) and `stderr.log` recorded
   `[stream] episode … failed after headers were sent … TimeoutError`. Unthrottled, it
   completes in 0.08 s, which is why this went unnoticed on the desktop.
2. **It cannot seek.** A `Range: bytes=0-99` request is answered `200` with the whole
   file and `accept-ranges: none`. Players on iOS Safari depend on range requests to seek
   and to resume, so a cut-off download cannot be recovered either.

Open Notebook itself supports ranges fully (probed read-only the same day): `206` with a
correct `content-range` for `bytes=0-99` and the suffix form `bytes=-100`, `416` with
`bytes */6930433` past the end, `accept-ranges: bytes`, `ETag` and `Last-Modified`.
`HEAD` returns `405`. The cockpit throws all of this away.

## Outcome

- An episode streams to the end however slowly the client reads it.
- Range, conditional and `HEAD` requests work through the cockpit as they do against
  Open Notebook, so the player can seek and resume, including on James's iPhone.
- Nothing from Open Notebook reaches the browser beyond the audio and its media headers;
  the password stays server-side, and the cockpit's security headers stay on every
  response.
- With Open Notebook down, the route still answers 503 naming the service.

## Out of scope

- Local video (`/media/videos/`), which already supports ranges (its `HEAD` and
  validators are a later slice).
- The snapshot's `opennotebook.mjs` move to `fetchJson`, its episode-list route and the
  local chapter renderer.
