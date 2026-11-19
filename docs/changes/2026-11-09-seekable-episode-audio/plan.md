---
change: 2026-11-09-seekable-episode-audio
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: podcast episodes play to the end and can be seeked, on any device

## Files that change

- `app/test/media.test.mjs` (new): A1 to A8.
- `app/lib/media.mjs` (new): `fetchMedia`, ported from snapshot `264547c` with concern 2's
  narrower header list and concern 4's quiet disconnect.
- `app/lib/opennotebook.mjs`: `episodeAudio(id, { method, headers, signal })` calls
  `fetchMedia`; the 15 s `AbortSignal.timeout` on the body goes.
- `app/router.mjs`: the audio route accepts `GET` and `HEAD`, ties an `AbortController`
  to the response's `close`, and writes the upstream status and forwarded headers.

## Order of work

1. **Commit 1, tests only** (`test(media): ...`). A1 to A8 against `main`. Expected red:
   A1 (200, no range), A2 and A3 (no `fetchMedia`), A4 (304/416 become errors), A5 (HEAD
   is not routed), A6 (headers), A7 (the stream error is logged). A8 must already pass.
2. **Commit 2, the fix** (`fix(podcast): ...`): `media.mjs`, then `opennotebook.mjs`,
   then the route. Run `node --test app/test/media.test.mjs app/test/degradation.test.mjs`,
   then `npm test`.
3. PR, `/gstack-codex review origin/main` posted verbatim, the AI-review gate, James's
   merge approval.
4. Live (after James fast-forwards and restarts): L1 to L3 with `curl`, L4 in the in-app
   browser at 390 px, then James does L5 on his iPhone.

## Risks

- **`Readable.from` over an async generator** must stop reading when the response is
  destroyed, or a closed tab keeps pulling the episode. A7 pins it.
- **Browsers send `Range: bytes=0-` on first play.** That is a 206 for the whole file;
  players handle it, and A1's pattern covers the general case.
- **`res.writeHead(status, headers)` merges with the security headers** set by
  `setHeader` before routing; A6 asserts they survive a `206`.

## Options not taken

- **Buffer the episode in memory and slice ranges locally.** Correct but holds up to
  tens of MB per request, and duplicates what Open Notebook already does correctly.
- **Raise the timeout instead of splitting it.** Any total deadline cuts off a slow
  enough client; the cut-off is the bug.
- **Redirect the browser to Open Notebook.** The bearer password would have to reach
  the browser (rule 6).

## Proof

- **Before any code:** live probes on 2026-11-09. Open Notebook answered `bytes=0-99` and
  `bytes=-100` with 206 and a correct `content-range`, `bytes=999999999-` with 416
  `bytes */6930433`, and `HEAD` with 405. Through the cockpit, a 200 KB/s download of the
  same 6,930,433-byte episode stopped at 4,521,412 bytes (`curl` exit 18; `stderr.log`:
  `TimeoutError`), and `Range: bytes=0-99` got 200 with `accept-ranges: none`.
- **Commit 1** (`05562a5`): against `main`, A1 to A6 failed for the expected reasons (200
  for a range; no `media.mjs`; the 304 lost its `etag`; HEAD 404; `gzip, deflate`
  forwarded). A7 and A8 passed.
- **Commit 2** (`2d0b7c3`): `media.test.mjs` 8 pass; `npm test` 542 pass, 0 fail, no
  `node_modules`.
- **Review:** Codex (`gpt-6.1-sol`, effort high) over `96c6fc7..bb33af0`, 8 files and 10
  hunks: `NO_FINDINGS`, GATE: PASS. The local AI gate: PASS, no findings. `forge-pr merge`
  merged it as `107051a`.
- **Live run**, 2026-11-09, after a restart at 18:55 (pid 31093), against the same
  6,930,433-byte episode (`episode:zdf60jyqkymusr7frjwh`):
  - **L1:** a 200 KB/s download got 200 and all 6,930,433 bytes in 34 s, past the old
    15 s deadline. `curl` exit 0, nothing on stderr.
  - **L2:** `Range: bytes=0-99` got 206, `content-range: bytes 0-99/6930433`,
    `content-length: 100`. The 100 bytes match the first 100 of L1.
  - **L3:** `HEAD` got 200, `content-length: 6930433`, `content-type: audio/mpeg`,
    `accept-ranges: bytes`.
  - **L4:** in the in-app browser at 390px, a seek to 75% of the first Podcast episode drew
    206 responses. The player buffered `0–12.5 s` and `323.5–433.1 s` and played from
    327 s with no media error. The superseded range requests show `ERR_ABORTED`: the
    player cancels them when it seeks.
  - **L5:** James, on his iPhone over the tailnet: a scrub to about 75% played from there
    to the end.
  - `stderr.log` gained nothing after the restart. Its one stream `TimeoutError` dates
    from the 15:40 pre-fix probe, and the `getcwd` count stayed at 10.

## Deviations

- **A7 already passed on `main`.** The old route also closed the upstream request when the
  client left and logged nothing; the plan expected it red. It stays as a guard on the new
  code path, which replaced that one.
- **`accept-encoding: identity` is set only when no `Range` is forwarded.** `fetch`
  appends it to any request carrying `Range` itself (Fetch standard), so setting it too
  sent `identity, identity`. Found by A6; R5's intent is unchanged.
- **A3's test closed the stub's connections between its two halves**, which broke the
  connection `fetch` reused for the second half (`fetch failed`). The line was removed;
  the code under test did not change for it.
- **Two files beyond the plan:** `app/router.mjs` loses its now-unused `Readable` import,
  and `.claude/rules/testing.md` lists `media.test.mjs` among the recorders.
