# The untestable seam

**Problem:** the routes carrying every data-integrity promise had zero automated tests, and
three PRs in a row had shipped saying "verified by curl" instead.

**Where:** studydeck, PR #21 (`82332ee`, the split and the route suite) and PR #22
(`3cb6270`, the stream fixes it turned up). Parent of both: `532af7e`.

## The approach

1. **Ask why the tests don't exist before writing any.** The answer was not discipline:
   importing `app/server.mjs` called `server.listen()` on port 4310 as a *side effect of the
   import*, so no test could reach a route without a live cockpit already running. The
   missing tests were a symptom; the module-load side effect was the cause.
2. **Move the socket, not the logic.** `git mv server.mjs router.mjs`, export the handler,
   leave a 15-line entrypoint that owns the socket. Diff against the original: a header
   comment, an `export const`, and the removed `listen` block. Nothing was rewritten, so
   nothing could silently change behaviour while the tests were being written.
3. **Drive the real handler over a real socket** — `createServer(handleRequest).listen(0)`
   and `fetch` — not a mock `req`/`res`. Status codes, header commitment and mid-stream
   teardown are where these bugs live, and a fake response object cannot observe any of them.
4. **Point the data layer at a synthetic fixture, and set the env var before a dynamic
   `import()`.** The config module resolves its root once at import time into a `const`;
   a static import is hoisted above any assignment, so it would have snapshotted the real
   learning data and every mutation test would have written into it.
5. **Let the new tests fail, then check whether each failure is the code or the assertion.**
   Three were my wrong guesses about payload shape. One — the 413 — was a real defect.

## The judgment calls

- **The fixture is synthetic, not a copy of real data.** A copy would have made every
  assertion depend on how much studying happened that week.
- **Mastery was NOT stubbed.** The tests run the real state write and the real render
  subprocess. Slower, and it covers the paths where a bug is silent corruption.
- **External-service routes were left uncovered, and the file header says so.** An omission
  a reader has to infer from what is absent reads as coverage that exists.
- **Two robustness fixes were deferred to a second PR**, and the reasons were written down
  rather than implied. A testing PR that also rewrites error handling proves neither.

## What the tests found that review had not

- **A 413 the client never received.** The body-limit check rejected and called
  `req.destroy()` in the same tick, tearing the socket down before the error response could
  flush. Measured: five runs, five `ECONNRESET`s. The refusal was sound; only its *report*
  was wrong, which is why three rounds of manual curl verification never noticed.
- **Two tests that passed for the wrong reason.** `fetch` normalizes a literal `../../` out
  of a URL before sending, so the traversal test's request arrived already collapsed and
  never touched the guard it claimed to test. The answer-leak probe, as first written,
  had the mirror-image flaw waiting: `raw.includes('two')` matches the substring in
  "ne**two**rk", so an unrelated word would have failed it. Now `/\btwo\b/i`.
- **An unhandled-`'error'` crash class** — `.pipe()` does not forward errors, and an
  unlistened `'error'` on a stream ends the process. Invisible in a diff, invisible in any
  request that succeeds.
- **The obvious fix for it reproduced the bug one stream downstream.** `res.destroy(err)`
  makes a generic `Writable` re-emit that error as its own unlistened event. It surfaced
  not as a failing assertion but as the test *terminating the runner*.

## The reusable rule

**When something is untested, find the structural reason before you find the discipline
reason — the thing blocking the test is usually the design flaw worth fixing.** And once
the tests exist, treat every green assertion as a claim to verify: check that the request
you think you sent is the request the server received, because a test that passes for the
wrong reason is worse than a missing one — it also stops anyone from writing the real one.
