---
change: 2026-11-09-seekable-episode-audio
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [spec]
---
# Spec: podcast episodes play to the end and can be seeked, on any device

## Flagged concerns

1. **The tests need a stub that serves audio bytes on Open Notebook's URL.** The testing
   rules forbid asserting what Open Notebook returns. Recommended resolution: the stub is a
   recorder that serves adversarial bytes (a known pattern, ranges it computes itself);
   every assertion is over what the cockpit SENT upstream (forwarded and withheld
   headers) and what it RETURNED to the browser (status, headers, exact bytes). No
   assertion depends on Open Notebook's real header names beyond the standard HTTP ones. *James's resolution: accepted as recommended.*
2. **Which upstream headers reach the browser.** The snapshot also forwarded
   `cache-control` and `content-disposition`. Recommended resolution: forward only
   `content-type`, `content-length`, `content-range`, `accept-ranges`, `etag` and
   `last-modified`, which is all a player needs; drop the other two. *James's resolution: accepted as recommended.*
3. **The idle deadline.** With no total deadline, a stalled Open Notebook could hold a
   connection open forever. Recommended resolution: 15 s to receive response headers, then
   30 s with no bytes from Open Notebook aborts. The idle clock runs only while waiting on
   Open Notebook, never while a slow client is applying backpressure. *James's resolution: accepted as recommended.*
4. **A client closing mid-stream is normal for seeking** (every seek abandons a request).
   Recommended resolution: a client disconnect aborts the upstream fetch and logs nothing;
   only a failure on the Open Notebook side is logged. *James's resolution: accepted as recommended.*

## Requirements

- **R1 Range.** The cockpit forwards `range` and `if-range` to Open Notebook and passes
  `206` through with its `content-range`, `content-length` and the exact bytes.
- **R2 No total deadline.** A client reading slowly receives the whole body. Response
  headers must arrive within 15 s; after that, only 30 s without upstream bytes aborts.
- **R3 Statuses.** `200`, `206`, `304` and `416` pass through with the forwarded headers.
  Any other upstream status becomes an error with that status, as today, and no upstream
  body reaches the browser.
- **R4 HEAD.** `HEAD` is answered even though Open Notebook returns `405` for it: the
  cockpit probes with a `bytes=0-0` GET and answers `200` with the full length from
  `content-range`, and no body.
- **R5 Request headers.** Upstream receives only `range`, `if-range`, `if-none-match`,
  `if-modified-since`, the bearer password and `accept-encoding: identity` (a range of a
  compressed body is meaningless). The browser's cookies and other headers are not sent.
- **R6 Response headers.** Only the headers in concern 2 are forwarded. The cockpit's
  security headers (hard rule 12) are on every response, including `206`, `304` and
  `416`.
- **R7 Disconnect.** A client disconnect aborts the upstream request and logs nothing.
- **R8 Down.** With Open Notebook unreachable the route answers `503` naming it, and the
  password appears in no response.

## Acceptance checks

Tests (recorder stub on an ephemeral port, the real `handleRequest`):

- **A1** `Range: bytes=2-5` → 206, `content-range: bytes 2-5/N`, exactly those 4 bytes,
  and the stub saw `range: bytes=2-5`. (R1)
- **A2** `fetchMedia` with a 50 ms header deadline and a stub that trickles the body over
  300 ms delivers every byte. (R2)
- **A3** A stub that never sends headers fails within the header deadline; one that stops
  mid-body fails after the idle deadline. (R2)
- **A4** Upstream 304 and 416 pass through with their headers; upstream 500 with an HTML
  body yields an error status and none of that body. (R3)
- **A5** `HEAD` against a stub answering 405 → 200, `content-length: N`, empty body; the
  stub saw a GET with `range: bytes=0-0`. (R4)
- **A6** A request carrying `cookie`, `x-custom` and `accept-encoding: gzip` reaches the
  stub without the first two and with `accept-encoding: identity`; a stub response with
  `set-cookie`, `cache-control` and `content-disposition` reaches the browser without
  them; the security headers are present. (R5, R6)
- **A7** Destroying the client socket mid-body closes the upstream connection and writes
  nothing to `console.error`. (R7)
- **A8** With the ON base URL pointing at a closed port, the route answers 503 naming
  Open Notebook, with no password in the response. (R8)
- **A9** `npm test` passes with `node_modules` absent.

Live, after James fast-forwards and restarts (episode of 6,930,433 bytes):

- **L1** `curl --limit-rate 200k` receives all 6,930,433 bytes, `curl` exit 0, nothing in
  `stderr.log`.
- **L2** `Range: bytes=0-99` → 206, `content-range: bytes 0-99/6930433`, 100 bytes.
- **L3** `HEAD` → 200, `content-length: 6930433`.
- **L4** Visual: in the in-app browser at 390 px wide, the Podcast view plays an episode,
  a seek near the end starts playback there, and the network log shows a 206.
- **L5** James plays and seeks an episode on his iPhone over the tailnet.
