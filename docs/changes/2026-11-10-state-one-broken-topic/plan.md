---
change: 2026-11-10-state-one-broken-topic
status: accepted
track: T1
accepted_by: james
intent: ./intent.md
linear: pending
---
# Plan: one unreadable topic no longer blanks the cockpit

## Files that change

- `app/test/degradation.test.mjs`: the route-level case, one topic's `state.json` damaged.
- `app/test/integrity.test.mjs` (new): the banner's text for unavailable topics.
- `app/lib/derive.mjs`: `buildState` builds each topic on its own.
- `app/web/js/integrity.mjs`: a banner for unavailable topics, and its pure text helper.
- `app/web/js/main.mjs`: shows that banner on every view.

## Order of work

1. **Commit 1, tests only** (`test(state): ...`):
   - `degradation.test.mjs`: overwrite the first configured topic's `state.json` with
     text that is not JSON, then `GET /api/state` and assert: 200; that topic's slug is
     absent from `topics`; every other configured topic is present; `unavailable_topics`
     holds exactly that slug with a non-empty `error`; `incomplete` is `true`. The test
     restores the file in a `finally`, then asserts the healthy case: `unavailable_topics`
     is `[]` and `incomplete` is `false`.
   - `integrity.test.mjs`: `unavailableTopicLines(state)` gives one line per unavailable
     topic, naming its slug and saying the totals leave it out; it gives `[]` for a
     healthy state and for a state from an older server with no `unavailable_topics`.
   Against `main`, the route case must fail with a 500 and the helper case must fail to
   import. The existing degradation tests must pass.
2. **Commit 2, the fix** (`fix(state): ...`):
   - `buildState` builds each topic inside its own `try`. A failure is logged with
     `console.error` (slug and error) and recorded in `unavailable_topics` as
     `{ slug, error }`. `incomplete` is `unavailable_topics.length > 0`. Totals, badges,
     queue, primary topic and `active_topics` come from the topics that were built, as
     the snapshot does.
   - `integrity.mjs` exports `unavailableTopicLines(state)` and
     `renderUnavailableTopics(host, state)`. The banner uses the existing
     `integrity-banner` styles and has no dismiss button: unlike a recovered backup, the
     condition is live on every load until the file is fixed.
   - `main.mjs` calls `renderUnavailableTopics(surface, state)` next to
     `renderIntegrityBanner`.
   - Run both test files, then `npm test` with no `node_modules`, then `npm run verify`.
3. **Browser check** against a `/tmp/learn` copy with one topic's `state.json` damaged
   (`STUDYDECK_LEARN_ROOT=/tmp/learn`, a spare port): the cockpit loads, the banner names
   the topic, the other two topics render, at desktop width and at 390px. This writes
   nothing to the repository.
4. PR through `forge-pr create`, `/gstack-codex review origin/main` posted verbatim, the
   AI gate, James's merge approval.

## Risks

- **The error text reaches the browser.** A `JSON.parse` message quotes a fragment of
  the file, and an `ENOENT` message holds the absolute path. `state.json` holds
  curriculum, not secrets, and the cockpit answers only loopback and James's tailnet
  identity (hard rule 12). The banner is the place that needs the cause, so it is sent.
- **Totals understate while a topic is out.** That is the reason the banner exists and
  says so in words, rather than letting smaller numbers pass for less work.
- **`/api/health` still says `ok`** while a topic is unavailable. Named in the intent as
  out of scope; the banner comes from `/api/state` itself, so it does not depend on health.

## Proof

- **Commit 1** (`1c5f28d`): against `main`, with no `node_modules`, 10 run and 2 fail,
  each for the stated reason. The route case gets 500 where 200 is expected, and the
  server logs the `SyntaxError` for the damaged file. `integrity.test.mjs` fails to import
  `unavailableTopicLines`. The 8 existing degradation tests pass.
- **Commit 2:** both files, 11 pass. `npm test` 556 pass, 0 fail, no `node_modules`.
  `npm run verify` finds no damage.
- **Browser check**, 2026-11-10: the worktree's router on port 4319 over a `/tmp/learn`
  copy with `ai-engineering/state.json` damaged, Open Notebook pointed at a dead port.
  `/api/state` answered 200 with the other two topics, `incomplete: true`, and
  `ai-engineering` in `unavailable_topics` with its `SyntaxError`; the server log named
  the slug with the stack. The banner showed on Today at desktop width, and on Test
  Center at 390px with no horizontal overflow. The other topics' views rendered. Nothing
  in either checkout changed.

## Deviations

- **A scratch launcher served the check**, not `node app/server.mjs`: the server takes its
  port from the committed config (4310, the live cockpit's), and nothing overrides it.
  The launcher imports the same `handleRequest` and lives in the session scratchpad.
- **The banners moved out of the view's container** after the Codex review (round 1, one
  P2). Seven views (`reading`, `podcast`, `mindmap`, `factcheck`, `testcenter`,
  `flashcards`, `roles`) call `clear(root)` on the surface they are handed, which removed
  a banner painted into it. `main.mjs` now renders both banners, the new one and the
  existing storage-integrity banner, into a `view-banners` container beside the surface,
  which no view is given. The storage banner had the same gap before this change; it is
  fixed here because it is the same line. Driven on the damaged copy: one banner on each
  of Reading Room, Podcast, Mind Map, Fact-Check, Test Center, Flashcards and Today, and
  Reading Room at 390px with no overflow. `npm test` 556 pass, no `node_modules`.
- **Every topic unavailable now has its own state** after the Codex review (round 2, one
  P2, a case the first draft had noted and not handled). With `topics: []`, Test Center,
  Practice Lab, Teachback and Roles dereference the working topic and throw, and `boot()`
  replaced the banner with the generic "/api/state failed" panel. `render()` now stops
  after the banners and shows "No topic could be loaded". The banner drops "The other
  topics are unaffected" when there are none. Driven with all three topics damaged: the
  banner lists all three on Test Center, Practice Lab, Teachback, Roles, Today,
  Flashcards, Reading Room and Stats, with no page errors. The hint wording change was
  checked as served, not re-driven.

## Options not taken

- **Port the snapshot as it is** (server fields only). Nothing in the browser read
  `unavailable_topics`, so a damaged topic would simply vanish from the cockpit: the
  quiet degradation F12 exists to stop.
- **Fail the whole response, but with a clearer error page.** The other topics are fine,
  and their study loop should keep working.
- **Return the broken topic as a placeholder in `topics`.** Every view would need to
  learn the placeholder shape, and any view that missed it would count it as an empty
  topic.
