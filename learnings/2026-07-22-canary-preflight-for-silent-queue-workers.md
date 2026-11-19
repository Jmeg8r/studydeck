# Guarding a batch against a silently-deaf queue worker: canary pre-flight

**2026-07-22 · StudyDeck cockpit podcast batch · PR #13 (feat/batch-worker-preflight)**

Sequel to `2026-07-19-silent-queue-hang-vs-slow-render.md`: that note found the
discriminator by hand; this one wires it into the code path so the trap can't cost a
third session.

## The problem, in one line

A 20-chapter batch fired at a worker whose LIVE-query subscription is dead writes 20
jobs stuck at `running` forever — and the API's happy 202s give no hint.

## The approach

1. **Don't invent a probe job — make the first real job the canary.** Fire batch items
   one at a time until the API accepts one, then STOP and verify that single job before
   committing the rest. Healthy path costs ~2s; nothing is rendered twice; no synthetic
   junk lands in the data.
2. **Verify with the signal the worker itself emits**, already pinned by the earlier
   diagnosis: its log prints a pickup line within ~1s of a healthy accept. Poll
   `docker logs` for `<pickup marker> <job name>` on a short budget (12s here).
3. **Return a trichotomy, not a boolean.** `seen` → commit the rest. `timeout` (log
   readable, line absent) → the trap; fail the batch with the exact operator fix in the
   error string. `unavailable` (log unreadable at all) → proceed exactly as before the
   guard existed, plus a warning — *can't check* must not be treated as *broken*, or the
   guard blocks every legitimate setup that lacks docker.
4. **Clean up what the failed canary left behind, scoped hard.** A worker restart does
   not drain jobs queued while it was deaf, so delete the canary's row — but only a row
   matching name + still-running + no output + created since fire time (minus 60s clock
   slack). Missing/unparseable timestamp ⇒ leave it. Under-deleting is recoverable in
   the UI; wrong-deleting destroys a real render.
5. **Make the subtle parts pure and test those.** The docker read is injected; verdict
   transitions and the delete filter are plain functions — all 14 tests run with no
   docker and no live service.

## The judgment calls

- **Relative `--since 120s`, never an RFC3339 stamp** — docker resolves relative windows
  against its own daemon clock, so Docker Desktop VM drift (routine on macOS after
  sleep) can't push the window off the lines being searched.
- **Same-name pickup lines from ≤2 min ago can false-positive the match — accepted.**
  Every such line still proves the worker consumed a command moments ago, and the trap
  is a listener dead since start. Exact job correlation isn't in the log; don't build it.
- **No end-to-end stale test.** Fabricating a dead worker means pausing the live
  container mid-use. Tested the parts instead (live probe → real `timeout` verdict
  against the real container with an absent name) and said so in the PR.
- **Single-job path left unguarded** — one stuck row is cheap to spot; twenty are not.
  Guard where the failure scales.

## The reusable rule

**When a queue's API can accept work its worker will never see, never fan out blind:
promote the first real job to canary, confirm pickup via a signal the worker emits
(not the status field that lies), and distinguish "worker dead" from "can't check" —
block on the first, warn on the second.**
