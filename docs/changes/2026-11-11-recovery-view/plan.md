---
change: 2026-11-11-recovery-view
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: a Recovery view that finishes what the cockpit already knows is unfinished

## Files that change

- **`app/lib/sidecar.mjs`:** `owesFactcheckCards`, and an
  `attempts.factcheck_cards_owed` counter in `inspectSidecars` (spec R1, R2).
- **`app/lib/recovery.mjs`** (new): `recoveryList`, plus the allowlist projections for
  attempts and operations (R1, R6).
- **`app/router.mjs`:**
  - `reconcileNoteOperation` and `reconcileMindmapNoteOperation` become exactly-one
    (concern 2).
  - The inline podcast match in `runPodcastEpisodeOperation` lifts into a shared function.
  - New `reconcileOperation`.
  - Three routes: `GET /api/recovery`, `POST /api/recovery/reconcile` and
    `POST /api/recovery/settle` (R3 to R5, R7, R8).
  - `/api/health`'s `degraded` test counts owed cards.
- **`app/web/js/views/recovery.mjs`** (new): the view, with the copy and accessibility
  rules from the spec (R9, R10).
- **`app/web/js/main.mjs`:** the nav item and route for `#recovery`.
- **`app/web/js/integrity.mjs`:** the banner lines and the **Open Recovery** link.
- **`app/web/css/app.css`:** only the styles the view needs that the existing classes
  lack.
- **`CLAUDE.md`:** one sentence in rule 9 (concern 1).
- **New tests:** `app/test/recovery.test.mjs`, `app/test/recoveryegress.test.mjs` and
  `app/test/recoverysettle.test.mjs`.
- **Extended tests:** `app/test/noteegress.test.mjs`, `app/test/mindmapegress.test.mjs`,
  `app/test/degradation.test.mjs` and `app/test/guard.test.mjs`.

## Order of work

The decisions most likely to change come first, and the mechanical work last. Each step
is red, then green, in separate commits.

1. **Exactly-one note matching (concern 2).**
   - Red: two same-title notes leave the note route's operation and the mind-map route's
     operation ambiguous. Today they complete.
   - Then tighten both helpers.
   - This one goes first because it changes existing routes' behaviour.
2. **The list and its counts (R1, R2, R6).**
   - Red: `recovery.test.mjs`. A fixture topic has one item of every kind, including
     planted answers; its counts must equal `inspectSidecars`; and the answers must be
     absent from the output.
   - Then `owesFactcheckCards`, the counter, and `recovery.mjs`.
3. **Settle (R3).**
   - Red: `recoverysettle.test.mjs`, through `handleRequest` on a fixture root.
     - Owed mastery is applied once, and a replay returns `already_done` with `state.json`
       unchanged byte for byte.
     - Owed cards are created once.
     - A pending attempt and an ambiguous one return 409 and write nothing.
   - Then the route.
4. **Reconcile (R4, R5).**
   - Red: `recoveryegress.test.mjs`, an Open Notebook recorder.
     - Exactly one match appends one `complete` revision and sends GETs only.
     - Zero or two matches append nothing, each with a control that requires the append.
     - A podcast delete appends when the episode is gone, and not when it's present.
     - An uncheckable kind returns 409 and sends nothing.
   - Then `reconcileOperation` and the route.
5. **Degradation and the guard (R7, R8).**
   - Add to `degradation.test.mjs`: Open Notebook down gives 503 naming it, appends
     nothing, and leaks no password, while `/api/recovery` still answers 200.
   - Add to `guard.test.mjs`: both POSTs are refused cross-origin and with a non-JSON
     content type, and carry no CORS header.
   - These are written red where a route doesn't exist yet. Once it exists they confirm
     the existing guard covers it.
6. **The view, nav and banner (R9, R10).** Browser JavaScript has no unit harness here, so
   this step is verified by driving it (*Proof*). Any helper with logic (formatting a
   label, picking the copy) goes in a module a node test can import.
7. **`CLAUDE.md` rule 9.**
8. **Verify, then ship:** `npm test`, `npm run verify`, a live check on `/tmp/learn`,
   `security-review` on the diff, Codex until `NO_FINDINGS`, then the PR.

## Risks

- **Settle writes `state.json`.** It goes only through `healUnappliedMastery` under
  `withTopicLock`, and the existing `settlement.test.mjs` cases still pass unchanged.
  Live checks use only a `/tmp/learn` copy, never the real tree.
- **Exactly-one changes two existing routes.** Step 1's red test pins the new behaviour.
  The existing `noteegress` and `mindmapegress` cases must still pass unchanged.
- **Lifting the podcast match** must not change batch replay. The existing
  `batchegress` and podcast tests must pass unchanged.
- **The new health counter** must not raise a false alarm on today's tree. The live
  `/api/health` on a copy must show `factcheck_cards_owed` as 0, or name a real owed
  fact-check.
- **The view re-renders after each action.** Focus handling is checked by hand with the
  keyboard, since no test covers it.
- **The `CLAUDE.md` edit changes the AI gate's standard on `main` after merge.** The
  sentence is narrow: it names the routes and why.

## Proof

- **Red runs**, recorded with each red commit and here.
- **Green:** `npm test` with `node_modules` absent, and `npm run verify` clean.
- **Live, on a `/tmp/learn` copy** with the scratch server (`127.0.0.1:4319`):
  - `/api/recovery` against `/api/health`: the counts are equal.
  - One "Apply to mastery" on a planted owed attempt, reconciled by hand against
    `state.json` and `attempts.jsonl`, then repeated to show `already_done`.
  - Screenshots in light and dark: one item of each kind, the empty state, and the
    banner link.
  - Keyboard-only pass and a `read_page` structure check.
- **Read-only against the real Open Notebook:** `GET /api/recovery` on the real tree.
  Nothing is reconciled live unless James asks.
- **Reviews:** `security-review` on the diff, then `/gstack-codex review origin/main`,
  with every run posted on the PR.

### Green and live, 2026-11-11

- **Green:** `npm test` with `node_modules` absent, 708 of 708 at `4a08e5b`.
  `npm run verify`: no damage found.
- **Live, scratch server on `127.0.0.1:4319`, `/tmp/learn` copy:**
  - `/api/recovery` counts equal `/api/health` in all three topics.
  - Keyboard Enter on **Apply to mastery** moved `the-agent-loop` confidence from 0 to
    0.05, once, and focus landed on the status line. A replayed POST answered
    `already_done`; `state.json` and `attempts.jsonl` stayed byte-identical.
  - **Create the missing cards** made exactly one card.
  - **Look for it in Open Notebook** read the real note list (GET only), answered
    `still_unknown`, and appended nothing.
  - Light and dark themes checked; the empty state shows on a clean copy, with no banner.
  - After the Codex fixes, on a fresh copy with one owed quiz, one pending quiz and one
    pending essay appended: the quiz line says it can't be reopened and has no link; the
    essay has **Resume in Test Center**. Clicking **Apply to mastery** and changing the
    hash in the same tick ran settle (0 to 81 ms), then `/api/state` (82 to 88 ms), then
    the Stats render (from 89 ms). The banner cleared. No console errors.
  - On a `/tmp/learn-broken` copy with every `state.json` unreadable: before the fix,
    `#recovery` showed only "No topic could be loaded"; after it, Recovery renders under
    the banner, and `#today` still shows the guard.
- **Read-only against the real tree:** `recoveryList` shows 0 owed in all three topics.
- **`security-review`:** no findings at MEDIUM or HIGH. Posted on the PR.
- **Codex:** five runs against `origin/main`. Runs 1 to 4 found seven P2s, each fixed
  test-first except the topic-guard move, which `main.mjs` booting on import keeps out of
  node, so it was driven live red then green. Run 5: `NO_FINDINGS`. Every run is posted on
  the PR.

## Options not taken

- **Porting the snapshot's `recovery.mjs` as-is.** It counted operations at any stage
  short of `complete`, which disagrees with health. It also returned whole attempt
  records, which leaks answers under rule 7.
- **A client-minted `mutation_id`.** The server would ignore it (concern 1).
- **Reconcile logic in `lib/recovery.mjs`.** The revise helpers it needs are private to
  the router. Moving them all is a refactor this slice doesn't need.
- **Rendition cards and saved-request retry cards.** They depend on D5 and on a client
  intent store, neither of which is on `main`.

## Deviations

- **Reconcile of a `complete` operation answers 200 `already_done`, not 409.** The spec's
  route list gave 409 for any stage other than `prepared` or `ambiguous`. But a
  confirmed reconcile is then replayed against a `complete` operation, and the spec's R3
  already answers a settle replay with `already_done`. Answering 409 would make a
  double-click look like a failure. Other stages (`started`, `failed_known`,
  `external_created`) still get 409. Pinned in `recoveryegress.test.mjs`.
- **A saved quiz gets no resume link.** The spec gave In progress items **Resume in
  Test Center** or **Resume in Fact-Check**. Codex run 1 found Test Center cannot reach a
  saved quiz: Finalize appears only on the results screen right after a submit, and the
  deck buttons start a fresh runner. A quiz item gets no link, and its line says Test
  Center can't reopen a saved quiz yet. James chose this on 2026-11-11; a real quiz resume
  flow is a later slice. Fact-Check keeps its link (Pending adjudications), and an essay
  keeps **Resume in Test Center**, whose essay panel lists pending essays (Codex run 3
  caught the first fix dropping it). Pinned in `recoverycopy.test.mjs`.
- **Navigation waits for a Recovery write, at most 5 s.** Not in the plan's file list.
  Codex runs 1 to 4 found that a settle left other views on stale state, that leaving the
  view could hide a write from the refresh, and that the first fix for that could redraw
  over a quiz in progress. Recovery's POST now outlives its view, the shared state and
  banners refresh after it, and `app/web/js/writegate.mjs` holds the next render until
  that finishes; only the latest navigation renders. Recovery is also drawn before the
  all-topics-failed guard. Recorded here after the fact, not in the commits that made
  them. Pinned in `recoveryrefresh.test.mjs` and `writegate.test.mjs`.
