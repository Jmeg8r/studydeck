---
change: 2026-11-10-local-video-validators
status: accepted
track: T1
risk: low
risk_reason: One read-only route that serves git-ignored tutorial videos from docs/. No write path, no sidecar, no state.json and no external service. The path resolver, its two containment gates and the security headers are unchanged. The failure mode is visible, a video that won't play or seek, and it is caught by route tests over a temporary shelf and by a live probe.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: local videos answer HEAD and revalidate instead of re-downloading

## Problem

This is slice C2 of porting PR #98's September snapshot (`264547c`, area C: media streaming).
C1 (#130) left it out of scope: "local video (`/media/videos/`), which already supports
ranges (its `HEAD` and validators are a later slice)".

Measured on the live cockpit on 2026-11-10 against `study-flow-tutorial.mp4` (46,318,202
bytes), using read-only GET and HEAD requests:

- **`HEAD` answers 404 JSON.** The route matches `GET` only, so `HEAD` falls through to the
  static handler. A player or proxy that probes with `HEAD` concludes the video doesn't exist.
- **No validators.** The response has no `ETag` and no `Last-Modified`. `If-None-Match: *`
  and an `If-Modified-Since` in the future both get `200` and the whole 46MB again. Every
  reopen of a tutorial, including on James's iPhone over the tailnet, re-downloads it.
- **`If-Range` is ignored.** `If-Range: "nope"` with `Range: bytes=0-99` gets a `206` slice.
  If the file changes between two requests (a re-render under the same name), a resuming
  player splices bytes from two different files. The rule is a full `200` whenever the
  validator doesn't match.

Ranges themselves already work: `bytes=0-99` gets `206` with a correct `content-range`.

## Outcome

- `HEAD /media/videos/<name>` answers `200` with the same headers as `GET`, and no body.
- `GET` and `HEAD` carry a strong `ETag` (size and mtime, as the snapshot built it) and a
  `Last-Modified`.
- A matching `If-None-Match` (including `*` and the `W/` form), or with no `If-None-Match` an
  `If-Modified-Since` at or after the file's mtime, gets `304` with no body.
- `If-Range` honours the `Range` only when it equals the current `ETag` or `Last-Modified`.
  Otherwise the answer is a full `200`.
- Today's range answers are unchanged: prefix, open-ended and suffix ranges give `206`, and an
  unsatisfiable range gives `416` with `bytes */<size>`.
- The resolver (name allowlist and realpath containment) and the security headers are untouched.

## Out of scope

- The snapshot's `sha256` ETag option, which only serves locally rendered podcast audio
  (slice D5).
- Multi-range requests (`bytes=0-1,5-6`). They get `416` today and keep it. Browsers don't
  send them for media, and answering them needs a `multipart/byteranges` body.
- The Open Notebook audio proxy, which C1 already did.
