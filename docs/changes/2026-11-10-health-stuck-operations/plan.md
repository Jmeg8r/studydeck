---
change: 2026-11-10-health-stuck-operations
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: health says so when an operation is stuck

## Files that change

- `app/test/degradation.test.mjs`: the route-level cases through `GET /api/health`.
- `app/test/integrity.test.mjs`: the banner's lines for these conditions.
- `app/lib/sidecar.mjs`: `inspectSidecars` also lists the unresolved operations.
- `app/router.mjs`: the health handler's `degraded` predicate.
- `app/web/js/integrity.mjs`: `describe` gains the new lines and is exported for the test.

## Order of work

1. **Commit 1, tests only** (`test(health): ...`):
   - `degradation.test.mjs`, one test per condition, each writing one row into a topic's
     `cockpit/` sidecar and removing it in a `finally`:
     - an operation at `ambiguous` gives `status: 'degraded'`, and that topic's
       `operations.unresolved_list` holds its id, kind, stage, ts and label;
     - an attempt with `mastery_applied: false` gives `degraded`;
     - an attempt with `mastery_settlement.stage: 'ambiguous'` gives `degraded`;
     - control: the same operation at `complete` gives `ok`.
   - `integrity.test.mjs`: `describe` gives a line naming the operation's label and
     telling the learner to check Open Notebook before repeating it, and one line each for
     unapplied and ambiguous mastery; a topic with none gives no lines.
   Against `main`, the three `degraded` cases and the banner cases must fail, and the
   control must pass.
2. **Commit 2, the fix** (`fix(health): ...`):
   - `inspectSidecars` adds `unresolved_list` to `operations`:
     `{ operation_id, kind, stage, ts, label }`, where `label` is the first of
     `local_result.note_title`, `local_result.episode_name`, `local_result.title`, else
     the `operation_id`.
   - The health predicate adds `operations.unresolved > 0`,
     `attempts.mastery_unapplied > 0` and `attempts.mastery_ambiguous > 0`.
   - `integrity.mjs` exports `describe` and adds the lines.
   - Run the changed files, then `npm test` with no `node_modules`, then `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy with one `ambiguous` operation added to
   a topic's `operations.jsonl`: the banner shows it, at desktop width and at 390px.
4. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval. After the merge and a restart, read `/api/health`
   live and confirm it still says `ok` (today's real sidecars have no unresolved rows).

## Risks

- **An in-flight request reads as stuck.** An operation sits at `prepared` for the few
  seconds its request is out. A banner rendered in that window would warn about work that
  is about to complete. The banner is drawn on navigation, the window is short, and the
  next view clears it, so this is accepted rather than adding an age threshold.
- **The banner can be dismissed for the session**, as it can today. A stuck operation
  survives that and returns on the next session.
- **Live data stays quiet.** The real sidecars hold no unresolved rows today, so the live
  check proves only that `ok` is still `ok`. The `degraded` path is proved on the copy.

## Proof

- **Commit 1** (`e75d5d5`): against `main`, with no `node_modules`, 14 run and 4 fail,
  each for the stated reason. The three degradation cases get `ok` where `degraded` is
  expected; the two mastery cases pass their count assertions first, so the counts were
  already in the response and the route ignored them. `integrity.test.mjs` fails to
  import `describe`. The `complete` control passes.
- **Commit 2:** the five affected files (degradation, integrity, sidecar, attempts,
  settlement) 58 pass. `npm test` 563 pass, 0 fail, no `node_modules`. `npm run verify`
  finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy with one `ambiguous` `open_notebook_note` row appended to `ai-engineering`'s
  `operations.jsonl`, Open Notebook pointed at a dead port. `/api/health` answered
  `degraded`, with that row in `unresolved_list` and the other topics at 0. The banner
  showed its line on Today, Reading Room and Test Center at desktop width, and on
  Reading Room at 390px with no horizontal overflow. Nothing in either checkout changed.

## Deviations

- **The unapplied-mastery line does not promise a fix it cannot deliver.** The plan's
  wording was going to say resubmitting finishes it. The heal runs only when that same
  submission is replayed or re-finalized, and the browser loses its mutation id on a
  reload until the later "mutation ids survive a page reload" slice lands. The line says
  so: a retry before a reload finishes it, and after one nothing in the cockpit will.
- **The banner's heading and hint changed**, found by the browser check. "Stored study
  data is damaged" and "Run npm run verify for the full report" were wrong for an
  unconfirmed write, which is intact data with an open question and which verify does
  not report. They now read "Stored study data needs attention" and "Run npm run verify
  for the storage report", with the understatement caveat kept.
- **`mastery_unapplied` now means "owed and recoverable"**, after the Codex review
  (round 1, two P2s, both confirmed in the code). It counted every final attempt with
  `mastery_applied: false`, which includes a finished fact-check (it only makes cards and
  never settles), an essay confirmed with no concept (nothing to settle), and an
  ambiguous settlement (counted separately and never retried). Once health acted on the
  count, the first two would have made it `degraded` for good on ordinary use. A new
  `owesMastery` predicate in `sidecar.mjs` uses `settleMastery`'s own guard (a concept)
  and excludes fact-checks and ambiguous settlements. Nothing else reads the count.
- **The unapplied line gives no retry advice at all.** The earlier deviation's "a retry
  before a reload finishes it" was also wrong: a mastery failure still answers 2xx,
  `withMutationId` then drops the id, and a repeat records a new attempt. The line now
  says nothing in the cockpit finishes it yet and that repeating the quiz records a new
  attempt. Tests `cb5cc2e` (red: 19 run, 3 fail); fix: affected files 59 pass, `npm test`
  564 pass, no `node_modules`, `npm run verify` clean.
- **The browser check reused the scratch launcher** from the previous slice, pointed at
  this worktree, for the same reason: the server's port is fixed by the committed config.

## Options not taken

- **Port the predicate only**, as the snapshot did. Health would turn `degraded`, but the
  banner would have nothing to say, and `describe` returning no lines means no banner at
  all: the same invisibility as today.
- **An age threshold on `prepared`.** It would hide a real stuck row for that long, and
  no threshold fits both a note POST and a podcast generate.
