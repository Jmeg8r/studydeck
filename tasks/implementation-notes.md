# StudyDeck cockpit — implementation notes

Running log for the build described in `tasks/study-cockpit-plan.md`.
Decisions worth remembering, and every deviation from the approved plan.

---

## M0 — server + `/api/state` + shell (2026-07-18/19)

Shipped: zero-dependency Node server, the merged state endpoint, and the Command
Rail shell (rail, Today hero, schedule strip, queue, mastery wheel, theme toggle).

### Layout

```text
app/
  cockpit.config.json   ports · topic list + wheel ring order · ollama model · ON base URL
  server.mjs            entrypoint — binds the socket, boot banner, nothing else
  router.mjs            every route: http, static, /api/state, /api/health (was server.mjs)
  lib/
    config.mjs          boot-time config + ON password (server-side only)
    learn.mjs           READ-ONLY access to learn-anything's state.json and decks
    sidecar.mjs         cockpit/ sidecar read+write (schedule, attempts, cards, reviews)
    schedule.mjs        the spec's milestone table + day-N math
    derive.mjs          assembles the whole /api/state payload
  web/
    css/tokens.css      twin-theme tokens (variant D graft)
    css/app.css         Command Rail shell (variant C)
    js/{main,wheel,timeline,svg,dom}.mjs · js/views/{today,placeholder}.mjs
```

### Decisions

- **Everything on screen is derived per request.** No computed value is written to
  disk, so the numbers can't drift from `state.json` + the sidecars. Cost is a few
  file reads per request; at loopback scale that's free.
- **`?date=YYYY-MM-DD` override on `/api/state`.** Lets the schedule math be
  exercised across all 30 days without touching the system clock. Read-only.
- **Primary topic = the most overdue active topic**, tie-broken by earliest start.
  Interleaving is a real spec rule, so the hero can't just hard-code one topic.
  Paused topics are never candidates.
- **Theme toggle re-renders the SVG.** Wheel and timeline read CSS tokens at draw
  time and write them into `fill`/`stroke` attributes; CSS alone can't restyle
  attributes already written. Cheap to redraw, so no need for a fancier scheme.
- **Wheel ring order comes from config** (`ring: inner | outer`), which reproduces
  the approved comp exactly: inner = agent-design-patterns (25), outer = fastai (24).
- **DOM built with `document.createElement`, never `innerHTML`,** for anything
  carrying state-derived text. Icons are the one exception — those are static markup.

### Deviations from the plan

1. **Added a day-4 milestone (`GUIDE`) to the schedule strip.** The comp's tick set
   was `[0,1,2,3,7,10,14,30]`, but `study-flow.md`'s table has study guide + essays +
   build on days 4–5. The strip follows the spec; the comp was illustrative.
2. **Dropped the "pipeline complete" hero state.** First pass showed
   "Pipeline complete" once `dayN > 30`, which contradicted the queue still marking
   that milestone late. Nothing in M0 tracks whether a milestone was actually *done* —
   only that its day passed — so completion was an unearned claim. The last milestone
   now stays owed, with lateness shown honestly. Revisit once M1 records attempts.
3. **`ai-agent-design-patterns` seeded as `paused: true`.** Its curriculum exists
   (25 concepts, 2026-07-16) but no pretest was ever taken, so its 30-day clock has
   not started. Marking it active would have invented progress. Flip `paused` and set
   `started` when it actually begins.
4. **Backfilled the real pretest into `attempts.jsonl`.** The 4/7 fastbook baseline
   and its three misses (`q3` validation sets, `q5` overfitting, `q7` fine_tune) are
   recorded in commit `4aca993` but existed nowhere machine-readable. Entered as one
   attempt row with the provenance in `notes`. Real data, not seed fiction.
5. **Rail badges show only derivable counts.** The comp's "ch.1" and "3" were mock
   numbers; the rail shows the real deck count (1) and card count (0 → no badge).
6. **Authored `CLAUDE.md` rather than restoring it.** The plan referenced a queued
   "gstack routing rules → CLAUDE.md" commit, but that content was not on disk
   (checked auto-memory, qmd, the SecondBrain vault, and `~/.gstack`). The repo had
   no CLAUDE.md at all. Written fresh from what the repo actually needs — **worth a
   review pass**, since it may not match what was originally intended.
7. **Observatory click-through deferred to M3**, per the plan's slice table. The
   wheel widget is deliberately not clickable in M0 rather than shipping a dead
   affordance; `wheel.mjs` computes radii so the full-screen variant grafts on later.

### Verification performed

| Check | Result |
|---|---|
| 49 concepts render, statuses reconcile | 24 + 25 = 49; 1 needs_practice / 48 unexplored, sums match `state.json` |
| Amber cell is the right concept | tooltip: fast.ai · Getting Started · **Your First Model** — needs practice |
| Day-N from `schedule.json` | day 0 on 07-18; **clock rolled to 07-19 mid-session and the UI advanced live** to day 1, `prime`→`study`, d0→done |
| Schedule math across the pipeline | d0/1/2/4/7/10/14/30 all resolve to the right milestone; mid-interval (d5→guide, +1 late) and past-end (d33→3d late, d74→44d late) correct |
| Path traversal | `/../../.env`, `/..%2f..%2f.env`, `/css/../../.env`, `/etc/passwd` → all 404, none escape `app/web` |
| Secret containment | `/api/state` payload greps clean for password/bearer; `/api/health` reports `loaded`, never the value |
| Upstream not broken | `render.mjs` validates **both** topics clean; `knowledge-map.md` byte-identical after render — the `cockpit/` subdir does not disturb learn-anything |
| Zero dependencies | every `app/` import is `node:` builtin or relative |
| Corrupt sidecar line | HTTP 200, bad line skipped + logged with file:line, good line kept |
| Missing sidecars entirely | HTTP 200, honest "No topic is on the clock" empty state |
| Console | no errors, dark + light themes both render |

**Not fixed (pre-existing, out of scope):** `npm audit` reports 7 vulnerabilities in
the repo's existing dependency tree (`axios`, `cmake-js`, `follow-redirects`,
`form-data`, `node-llama-cpp`, `simple-git`, `tar`) — all from `node-llama-cpp`/
`openai`, none introduced by `app/`, which adds no packages.

---

## M1 — Test Center (2026-07-19)

Shipped: answer-free deck serving, server-side grading, attempt recording that applies
learn-anything's update table and re-renders, and the score chart against the pretest
baseline.

New: `lib/grading.mjs` (strip + grade), `lib/mastery.mjs` (update table + render),
`web/js/views/testcenter.mjs`, `web/js/chart.mjs`.

| Route | Does |
|---|---|
| `GET /api/decks` | deck metadata across topics |
| `GET /api/decks/:topic/:file` | the deck **with every answer field stripped** |
| `POST /api/decks/:topic/:file/grade` | grades + reveals; a dry run that writes nothing |
| `POST /api/attempts` | re-grades server-side, appends the attempt, applies the update table, re-renders |

### Decisions

- **The client never computes or supplies a score.** It posts raw responses; the server
  grades. `POST /api/attempts` deliberately re-grades rather than trusting the earlier
  `/grade` call, so a forged payload cannot inflate mastery (verified: a claimed 99/99
  was recorded as 1/7).
- **Grading rules copied from the quiz skill verbatim** so in-app and Claude-session
  attempts agree: `exact` strict equality with `multi_select` compared as unordered
  sets, `accepted` normalized by trim+lowercase, `ai_only` not auto-graded.
- **Strong/Partial/Weak bands pinned to ratios** — 0.85 and 0.5. The skill states these
  as judgement calls ("almost all correct"); an app has to be deterministic. The deltas,
  the 1.0 cap, and the status transitions are the skill's, unchanged.
- **`attempts.jsonl` is appended before the state update.** If the state write fails and
  rolls back, the attempt survives on disk rather than vanishing.
- **State writes roll back on validation failure.** If render.mjs rejects the result the
  original file is restored, so state.json and knowledge-map.md can never disagree.
- **render.mjs is pinned to `.claude/skills/`, never resolved by a bare `find`.** A
  detached worktree under `.claude/worktrees/` carries a second copy at a different
  commit, and `find . -print -quit` hits that one first.

### Deviations from the plan

8. **`ai_only` items are self-checked, not AI-graded.** The plan routes them to the
   grader, but live ollama grading is M7 — and learn-anything's own quiz skill specifies
   `ai_only` as "no auto-grade; **self-check on re-practice**". So the reference answer
   is revealed after submit and the learner marks it. Which items were self-marked is
   recorded on the attempt (`self_graded`) and surfaced in the chart tooltip, so a
   self-marked score is never mistaken for a machine-graded one. M7 can supersede this.
9. **Auto-queuing cards from misses deferred to M2.** The plan's route table has
   `POST /api/attempts` creating cards, but the card model belongs to M2, which can
   derive them from `attempts.jsonl` retroactively — the misses are already recorded.
   Building half a card model now would have meant redoing it.
10. **Client errors log one line, not a stack.** A rejected URL is not a server fault;
    stack traces are reserved for genuine 5xx so the log doesn't cry wolf.
11. **The study-guide/essay toggle stub was not built.** The plan lists it for M1, but
    every essay path depends on the M7 grader, so a toggle now would be a control that
    does nothing. Deferred rather than shipped as a dead affordance.

### Verification performed

Bands were exercised across all three: **strong** and **weak** via the API, **partial**
through the browser UI end to end.

| Check | Result |
|---|---|
| Answers absent pre-submit | payload carries only `id, type, gradeable, prompt, options`; no `answer` key, no accepted variants, no explanations — audited on the raw bytes the browser received |
| Grader agrees with the manual flow | independently reproduced the recorded pretest: **4/7, misses q3/q5/q7**, matching commit `4aca993` |
| multi_select order independence | correct options submitted scrambled → still correct |
| `accepted` normalization | `"  OVER-FITTING  "` → matched the accepted variant |
| state.json diff | exactly the 4 fields the table touches; byte-identical formatting (2-space + trailing newline) |
| Strong band | +0.12 confidence, practice +1, `needs_practice` → `in_progress` |
| Confidence cap (upstream bug #121) | primed to 0.95, strong pass → capped at exactly **1.0**, not 1.07; render.mjs accepted it; → `mastered` |
| Weak band | status → `needs_practice` with confidence and practice_count **untouched**, per the table |
| Partial band (via UI) | 5/7 → confidence 0.05 → 0.1, practice 1 → 2 |
| Score forgery | client claiming `99/99` recorded as `1/7` — server re-grades |
| Deck param traversal | `../../../../state.json`, `..%2f..%2f`, `....//`, `/etc/passwd` → all 400/404, no content |
| Malformed body / missing fields | 400, no write |
| render.mjs after in-app write | validates clean |
| Console | no errors |

**All verification writes were reverted.** Driving the flow end to end necessarily wrote
attempts and mutated `state.json`; those were test events, not real study sessions, so
leaving them would have corrupted the learning record and the day-7 baseline comparison.
`.learn/` is back to exactly one attempt row — the genuine pretest.

---

## M2 — Flashcards (2026-07-19)

Shipped: cards auto-queued from quiz misses, the review session, expanding-interval due
logic with error routing, and the weak-cards-only filter.

New: `lib/cards.mjs`, `web/js/views/flashcards.mjs`. Routes: `POST /api/cards`,
`POST /api/cards/sync`, `POST /api/reviews`.

### The interval model (the part with real subtlety)

Two different mechanisms decide when a card is due, and conflating them was the trap:

- **A card's FIRST due date comes from the topic schedule**, not from its creation date.
  The spec puts flashcard sessions on days 7, 14 and 30, so a card made from a day-0
  pretest miss is first due on **day 7** — not the morning after. This is what the plan's
  "3 pretest-miss cards appear due day 7" is describing.
- **After the first review, per-card expanding intervals take over**: `[1, 3, 7, 14, 30]`,
  indexed by consecutive-hit streak and clamped at the top. A miss resets the streak to 0,
  which lands on the 1-day rung — the spec's error-routing rule, "miss resets the next
  review to +1d". Rung 0 is reachable *only* by a miss.

Everything about *when* is derived from `reviews.jsonl` on each request. `cards.json`
stores only content (front, back, source, created). No due date is ever written to disk,
so there is no schedule that can go stale.

### Decisions

- **Card creation is never a side effect of a read.** `GET /api/state` reports
  `unqueued_misses`; the Flashcards view offers a "Queue cards from misses" button that
  POSTs to `/api/cards/sync`. New attempts auto-queue through the same function, so
  `POST /api/attempts` now closes the error-routing loop the plan describes.
- **Sync is idempotent via `source_ref`** (`<deck-file>:<question-id>`), so it is safe to
  re-run on every attempt and as a historical backfill. Verified: a second run creates 0.
- **A card's `created` is the date of the miss, not of the backfill run** — the card's
  schedule should follow the mistake, not when the feature happened to ship.
- **The rail badge counts what's due today**, not the total card count. A badge showing 3
  when nothing is actionable trains you to ignore it.
- **The answer is not in the DOM until you ask for it.** Retrieval practice only works if
  recall is actually attempted, so the back is appended on reveal rather than hidden with
  CSS — verified by asserting the answer text is absent from the rendered view pre-reveal.

### Deviations from the plan

12. **`syncCardsFromAttempts` is exposed as an explicit endpoint**, not purely automatic.
    The plan has `POST /api/attempts` auto-queueing, which it now does — but the pretest
    misses predate the card model, so a user-triggered backfill was needed too. Making it
    a POST rather than lazily creating cards during a GET keeps reads free of side effects.

### Verification performed

| Check | Result |
|---|---|
| Cards from real misses | 3 created from the pretest — q3 validation sets, q5 overfitting, q7 fine_tune, exactly the three the pretest commit named |
| **First due = day 7** | all three due `2026-07-25`, which is day 7 from the `2026-07-18` start |
| **Miss → +1d** | miss on day 7 → interval 1, due the next day, streak 0 |
| Hit ladder | streak 1→5 produced 3, 7, 14, 30, 30 — expands and clamps |
| Miss after a long streak | drops straight back to rung 0 (1 day), not one rung down |
| **Weak filter** | with 1 of 3 cards missed, filter shows exactly that one; with no reviews it shows none and says so |
| Idempotency | second `/api/cards/sync` created 0 cards |
| Answer hidden pre-reveal | `.card-back` absent from DOM and answer text absent from the rendered view until "Show answer" |
| Full session via UI | 3 cards reviewed (1 miss, 2 hits) → intervals correctly diverged 1d vs 3d |
| Badge | counts due-now only; 0 when everything is scheduled ahead |
| Input validation | unknown card/topic → 404, bad `result` → 400, blank front/back → 400, no writes |
| Upstream intact | render.mjs clean on both topics; no learn-anything file touched |

**What was reverted, and what was kept.** The review log and the temporarily-shifted
`schedule.json` (used to make cards due today for the UI test) were reverted — those were
fabricated study events and a test fixture. **`cards.json` was kept**: those three cards
derive from misses that genuinely happened and are recorded in `attempts.jsonl`, so they
are the feature working correctly, not invented history. They are waiting, due day 7.

---

## M3 — Stats and the Observatory (2026-07-19)

Shipped: attempt history, the weakness heatmap by domain, and the full-screen
Observatory (the variant-A graft) reachable by clicking the Today wheel.

New: `lib/stats.mjs`, `web/js/views/stats.mjs`, `web/js/views/observatory.mjs`;
`wheel.mjs` gained an `observatory` variant.

### Decisions

- **Untested is not clean.** The single most important call in this slice. A concept
  you have never been quizzed on is *unmeasured*, not passed — so `stats.mjs` carries
  three evidence states (`untested` / `clean` / `weak`) and `miss_rate` is `null`
  rather than `0` when there is no data. In the heatmap untested cells are hatched,
  deliberately off the good/bad colour axis: with 23 of 24 concepts untested, painting
  them green would make the map a flattering lie.
- **A reconciliation panel is part of the UI, not just the test.** The same totals are
  summed two independent ways — straight from the attempt log, and through the
  per-concept weakness map — and displayed side by side. If they ever diverge the panel
  says MISMATCH rather than silently showing one of them.
- **The Observatory stays dark in both themes.** It is the night-sky field from variant
  A; a light-mode planetarium was never designed and would look like a bug. Its neutral
  arc colours are therefore fixed cream-on-navy instead of reading theme tokens, which
  would render invisible there.
- **Domain labels run along their arc and truncate to fit it.** Horizontal labels
  collided tangentially, and long names on the inner ring (shorter arc per domain) ran
  into their neighbours. Labels are now rotated to their sector and clipped with an
  ellipsis when the arc is too short — the full name stays in the cell tooltip and the
  detail panel, so nothing is lost.

### Fixed along the way

- **Page scrolled sideways** at narrow widths. Two causes: `main` is a flex item, which
  defaults to `min-width: auto` and so refused to shrink below its content; and the
  heatmap row had a fixed 168px label that forced the row wider than the viewport.
  Fixed with `min-width: 0` on `main`, a shrinkable label, and wrapping rows. Verified
  zero horizontal overflow across all six reachable views at 529px.

### Verification performed

| Check | Result |
|---|---|
| **Reconciliation, real data** | hand-count of `attempts.jsonl` (1 attempt, 7 asked, 4 correct, 3 missed) equals both derived paths exactly |
| **Reconciliation, stressed** | with 4 attempts across 3 concepts in 3 domains: 25 asked / 16 correct / 9 missed — hand-count, log path and weakness map all agree |
| Evidence partition | `untested + weak + clean == concepts` holds (23 + 1 + 0 = 24) |
| Untested ≠ clean | domains with no attempts report `miss_rate: null` and render "no data", never 0% |
| Heatmap shape | 12 domain rows, cell counts match state.json exactly (4+4+7+3+3+4 and 3+4+7+4+4+2) |
| Observatory | opens from the Today wheel and from Stats; guide rings, degree scale, hub (`1 of 49 touched`), legend, Esc/backdrop/✕ all close |
| Cell inspection | clicking the amber cell reports Getting Started → Your First Model with its real evidence and card count |
| Label fitting | long names truncate with `…`; no collisions on either ring |
| Horizontal overflow | none, across all views |
| Console / server log | clean |
| Zero deps · upstream | still `node:` builtins only; render.mjs clean on both topics, no drift |

**Stress-test attempts were reverted.** Three synthetic attempts were appended to
exercise the aggregation at scale, then removed — `attempts.jsonl` is back to the single
genuine pretest row.

---

## M4 — Reading Room (2026-07-19)

Shipped: the Open Notebook proxy, source reading with a zero-dependency markdown
renderer, reading-position persistence, and highlights that round-trip into ON notes.

New: `lib/opennotebook.mjs`, `web/js/markdown.mjs`, `web/js/views/reading.mjs`,
`reading.json` sidecar. Routes: `GET /api/on/health`, `GET /api/on/sources`,
`GET /api/on/sources/:id`, `POST /api/on/notes`, `POST /api/reading`.

### ON API, verified live (not taken from notes)

The plan flags ON API churn as a risk and the memory entry warned some endpoints take
form fields rather than JSON, so every endpoint was probed against the running
v1.13.0 instance before any code was written:

| Endpoint | Finding |
|---|---|
| `GET /api/config` | `{version, latestVersion, hasUpdate, dbStatus}` — used for the version check |
| `GET /api/sources?notebook_id=` | 20 fastbook chapters; **omits `full_text`** |
| `GET /api/sources/:id` | includes `full_text` (ch.1 = 31,165 chars) |
| `POST /api/notes` | **accepts JSON** (the form-field caveat applies to `/api/sources`, not notes) |
| `GET /api/notes?notebook_id=` | **omits `content`** — same pattern as sources |
| `/api/episode_profiles`, `/api/podcasts` | **404** — these are not the paths the memory entry implies. M5 will have to rediscover them. |

Sources come back unordered, so `listSources` sorts on the leading chapter number.

### Decisions

- **One module owns every ON call.** The plan's mitigation for API churn, taken
  literally: `lib/opennotebook.mjs` is the only file that knows ON's URL shapes, and the
  only place the bearer is attached. The browser never holds a credential.
- **`/api/state` does not touch ON.** Reading positions come from the sidecar; the state
  endpoint stays fast and keeps working when ON is down. ON status is fetched separately
  and only decorates the footer.
- **A version mismatch is surfaced, not swallowed.** `expectedVersion` in the config is
  compared on the major.minor prefix; a drift shows `ON: 1.13.0 ⚠` in the rail with an
  explanatory tooltip pointing at the proxy module.
- **Markdown is rendered in-house.** Escape HTML first, lift code fences and inline spans
  out before inline rules run, restore last. That ordering is what makes the result safe
  to assign with `innerHTML`. Links are restricted to `http(s)`, relative and anchor
  targets — `javascript:` and `data:` degrade to plain text.
- **Position writes are debounced (700ms)** — a write per scroll event would hammer the
  disk for no benefit — and clamped to 0..1 server-side.

### Bugs found and fixed while building

- **Blockquotes never rendered.** HTML is escaped before block parsing, so a leading `>`
  is already `&gt;` by the time the blockquote rule runs; matching a literal `>` silently
  never fired. Now matches the escaped form.
- **Parenthesised URLs were truncated.** The link pattern stopped at the first `)`, which
  breaks real URLs like `.../Foo_(bar)`. Now allows one level of balanced parens.

### Deviations from the plan

13. **`reading.json` is a new sidecar** not in the plan's original file list. Reading
    position is cockpit-owned state with nowhere else to live; it follows the same rules
    as the others (beside learn-anything's files, never inside them).

### Verification performed

| Check | Result |
|---|---|
| **fastbook ch.1 renders** | 10 headings, 57 paragraphs, 2 code blocks, 3 lists — counts match the source exactly (verified inline-code 0 is genuine, not a renderer miss) |
| **Highlight round-trips** | selection → `POST /api/on/notes` → note created in the real notebook, confirmed by querying ON **directly**: title + 584 chars of blockquote and attribution |
| Reading position | persisted to `reading.json` with source id, ratio and title; restored on reopen |
| Bearer containment | no `authorization`/`bearer`/`password` string in any proxied response |
| **ON down** | pointed at a dead port: `/api/state` and the shell still 200; ON routes return 503 with a plain reason; UI shows "Open Notebook is not answering" and `ON: OFFLINE`. The real ON instance was never stopped — ATAL depends on it. |
| **Version mismatch** | forced `expectedVersion: 1.14` → `mismatch: true` surfaced rather than ignored |
| Markdown safety | `<script>`, `<img onerror>`, `javascript:` and `data:` links all inert; 0 live `<script>` tags in the rendered chapter |
| Input validation | blank note title/content, unknown topic, non-numeric position → 400; unknown source → 404 |
| Position clamping | 9.9 → 1, −4 → 0 |
| Zero deps · upstream | still `node:` builtins only; render.mjs clean on both topics |
| Console | no errors |

**Test artifacts removed.** The probe note, the highlight note created during the
round-trip test, and the scroll-test `reading.json` were all deleted — ON's notebook is
back to 0 notes and `.learn/` is clean. James has not actually read chapter 1 yet, and
the cockpit should not claim he has.

---

## M5 — Podcast and Video shelf (2026-07-19)

Shipped: podcast state from ON (profiles, episodes, TTS readiness) with an honest
blocked-audio empty state, and a local video shelf with Range-aware streaming.

New: `lib/videos.mjs`, `web/js/views/podcast.mjs`, `web/js/views/videos.mjs`.
Routes: `GET /api/on/podcast`, `GET /api/on/episodes/:id/audio`, `GET /api/videos`,
`GET /media/videos/:file`.

### The 404s from M4, resolved

M4 found `/api/episode_profiles` and `/api/podcasts` both 404. Rather than guess, I read
ON's own `/openapi.json` (79 paths). The real routes use **hyphens**:

| Assumed (404) | Actual |
|---|---|
| `/api/episode_profiles` | `/api/episode-profiles` |
| `/api/podcasts` | `/api/podcasts/episodes` |
| — | `/api/podcasts/episodes/{id}/audio`, `/api/podcasts/generate` |

The underscore form is the *profile name* convention (`study-overview` is a name, not a
path). Worth remembering the next time a note records an ON endpoint.

### Findings

- **TTS is genuinely absent.** `GET /api/models?type=text_to_speech` returns 0; only
  `language` (gemma4) and `embedding` (nomic) are registered. Audio cannot be rendered,
  exactly as the plan anticipated — so the view says so precisely, naming the model type
  and the settings path, rather than offering a button that would fail.
- **The two study profiles are healthy; the three stock ones are not.** `study-overview`
  and `study-deep-dive` both have their transcript model set; `business_analysis`,
  `solo_expert` and `tech_discussion` have it unset — the migration-22 damage recorded in
  the memory entry, confirmed. The view flags "transcript model unset" per profile so it
  surfaces now rather than at generate time.

### Decisions

- **Range support is mandatory, not a nicety.** These files are 33-46MB; without a 206
  response the browser can play from the start but cannot seek. Implemented with
  open-ended range handling and 416 for malformed or past-EOF requests.
- **The video resolver never concatenates request input into a path.** The requested name
  is matched against an actual directory listing, behind an extension allowlist, with a
  final identity check on the resolved path. A traversal attempt simply matches nothing.
- **Episode audio is piped through the server**, so the ON bearer stays server-side even
  for media bytes.
- **An empty shelf is a normal state.** `docs/*.mp4` is gitignored, so a fresh clone has
  no videos; the empty state explains that rather than implying breakage.

### Verification performed

| Check | Result |
|---|---|
| **Tutorial video plays** | 1280×720, 169s, `readyState` 4, decoding and advancing, no error |
| **Seeking works** | seek to 150s in the 44MB file landed at 150.0 and kept playing — proves Range end-to-end |
| Range at HTTP level | 206 with correct `content-range` and exactly 1024 bytes for a 1KB slice; open-ended → 206; past-EOF and malformed → 416 |
| **Podcast profiles listed** | 5 profiles; the 2 study ones tagged, the 3 stock ones correctly flagged as missing a transcript model |
| **Empty state honest** | names the missing `text_to_speech` model type and the exact ON settings path; no dead generate button |
| Path containment | `../.env`, `..%2f.env`, `../../etc/passwd`, `../CLAUDE.md`, `<file>/../../.env` → all 404 |
| Bearer containment | no credential string in any proxied response |
| **Independent degradation** | with ON at a dead port: `/api/on/podcast` → 503 while `/api/videos` and video playback stay 200. The local shelf does not depend on ON. |
| Zero deps · upstream | `node:` builtins only (added `node:stream`); render.mjs clean on both topics |
| Console | no errors |

No test artifacts were created in this slice — nothing was written to ON or `.learn/`.

---

## M6 — Mind Map studio and Fact-Check (2026-07-19)

Shipped: fact-check runs on model-generated claims with cards minted from wrong marks,
and a retrieval-first mind map studio that diffs recall against the real concept map.

New: `lib/factcheck.mjs`, `lib/mindmap.mjs`, `web/js/views/factcheck.mjs`,
`web/js/views/mindmap.mjs`, `factchecks.json` + `mindmaps.json` sidecars.

### Decisions

- **Claims are served without their truth values**, exactly like answer-free quiz decks.
  Verification is the active ingredient; if the DOM carried the answer it would be a
  reading exercise.
- **The parser never guesses a truth value.** A line that doesn't clearly start
  `TRUE |` or `FALSE |` is dropped and counted as skipped rather than assumed. If nothing
  parses, generation fails loudly instead of inventing an exercise.
- **Generation is slow and treated as such.** Measured on gemma4:31b-mlx via ON:
  ~60s for a few hundred characters, 53s for a 6,000-char excerpt. So input is capped at
  6,000 chars (the UI says when it truncated), results are persisted, and re-runs are
  instant. The ON client got a separate 7-minute budget for generation calls; the normal
  15s timeout would have failed every one.
- **The app does not pretend to read your sketch.** There is no vision model here, so the
  mind map diff is self-marked: you tick what you actually recalled and the app computes
  the gaps against `state.json`. Parsing the image was never on the table, and faking it
  would have been the dishonest option; ticking your own recall is also better retrieval
  practice.
- **A mind-map note failing to save does not lose the run.** The run is written to disk
  first, and a note error is reported rather than swallowed or retried into oblivion.

### Bug found by the M3 reconciliation panel

Fact-check attempts carry no `concept_slug` — a run covers a whole chapter, not one
concept — and `stats.mjs` was skipping attempts without one. The result: the attempt log
counted 23 questions while the weakness map counted 7. **The reconciliation panel built in
M3 caught this immediately**, which is the entire reason it exists in the UI rather than
as a one-off test.

Fixed by counting unattributed work explicitly rather than either dropping it or
attributing it to an arbitrary concept. `totals.asked`/`missed` stay per-concept (what the
heatmap draws); `totals.asked_all`/`missed_all` are the grand totals that must match a
hand-count. The Stats panel names the difference in plain language rather than folding it
in quietly.

### Deviations from the plan

14. **A new ON transformation, `fact_check_claims`, was created** (id
    `transformation:broyognrast5vzu5v0r3`, on gemma4). The plan says claims come from the
    `study_guide` transformation, but that one emits short-answer questions, essay prompts
    and a glossary — no verifiable claims, and nothing labelled true/false. A dedicated
    transformation follows the pattern Phase 0 established for `study_guide`. **This is an
    additive change to James's ON instance**; it is deletable and does not affect anything
    else. Verified only one copy exists.
15. **Sketches are stored under `cockpit/sketches/`** and served from `/media/sketches/`.
    Not in the plan's sidecar list, and unlike the other sidecars these are binary photos.

### Verification performed

| Check | Result |
|---|---|
| **Fact-check run creates cards from wrong marks** | 8 claims from fastbook ch.1; 2 marked deliberately wrong → exactly **2 cards** created, fronted with the claim and backed with the truth, the correction, and what you thought |
| Idempotency | identical re-run created 0 further cards |
| Truth containment | no `truth`/`correction` field in the generate response or in the DOM before scoring |
| Attempt recording | `kind=factcheck`, misses `["c1","c2"]`, flows into Stats |
| Claim quality | gemma4 followed the format exactly — 5 true / 3 false, subtle inversions (higher vs lower learning rate, included vs held out), 0 unparseable lines |
| Parser robustness | messy bullets/numbering still parse; prose and `MAYBE \|` lines parse to **zero** claims rather than guesses |
| Mind map | true map = 24 concepts across 6 domains, matching state.json; a 5-of-24 recall run computed 19 gaps and wrote the diff to ON as a note |
| Sketch handling | non-data-URL → 400; unsupported MIME → 400; >8MB → 413; `/media/sketches/../../.env` → 404 |
| Input validation | unknown topic → 400, unknown route → 404, run without generated claims → 404 |
| Reconciliation | back to 1:1 after the fix, with unattributed work counted and labelled |
| Zero deps · upstream | `node:` builtins only; render.mjs clean on both topics |

**All test artifacts reverted:** the generated claim set, both fact-check runs, the two
cards they minted, the mind-map run, the sketches directory, and the ON diff note. `.learn/`
is back to 1 attempt / 3 real pretest cards and the notebook to 0 notes. The
`fact_check_claims` transformation was **kept** — it is reusable infrastructure, not test
debris.

---

## M7 — Essay grading and the walk debrief (2026-07-19)

Shipped: written answers graded against a rubric on the local model, and a capture-back
box that turns a walk debrief into an ON note plus cards. **This completes M0–M7.**

New: `lib/ollama.mjs`, `web/js/views/essay.mjs` (in Test Center),
`web/js/views/debrief.mjs` (in Flashcards). Routes: `POST /api/grade`,
`POST /api/debrief`, `GET /api/grader/health`.

### Decisions

- **Grading talks to ollama directly, not through ON.** Measured: ~10s direct versus
  ~53s for comparable work through ON's transformation path. Same model, much less
  overhead.
- **The model's output is treated as prose that probably contains JSON.** gemma4 ignores
  ollama's `format` schema — it wraps output in ``` fences and drops fields the schema
  marked required. So `extractJson` strips fences, falls back to the outermost brace
  pair, and returns null rather than guessing. A grade is never invented from
  unparseable output; the call fails with the Claude-session fallback instead.
- **Scores are clamped server-side.** A model returning 9/5 must not corrupt the record.
- **The debrief note is saved first and independently of card generation.** Capture-back
  is mandatory in the spec, so losing the text because the model was cold would be the
  worst possible failure. Note and cards succeed or fail separately and are reported
  separately.
- **Mastery only moves when work is attributable to a concept.** An essay with no
  concept selected records an attempt but does not touch `state.json`.

### The bug this slice surfaced in M3/M6 code

An essay has no per-item miss list, so it records `misses: []`. The weakness map was
computing missed as `misses.length` — which meant **a 0/5 essay contributed 5 asked and
0 missed, classifying that concept CLEAN**. That is the same unearned-pass trap the
"untested vs clean" distinction exists to prevent, arriving by a different door.

Fixed by defining shortfall as `max - score` everywhere instead of miss-list length. For
quizzes and fact-checks the two are identical (`correct + missed === asked`, verified in
M1), so this is strictly more accurate rather than a competing convention. Verified: a
0/5 essay on `data-ethics` now classifies `weak`, and reconciliation still holds.

### Verification performed

| Check | Result |
|---|---|
| **Grader discriminates** | a correct, well-argued answer scored **5/5**; a wrong answer ("it makes training faster and uses less memory") scored **0/5**, with feedback naming exactly what was missing. Not a rubber stamp. |
| **Graded essay lands in attempts.jsonl** | `kind=essay` with the model's feedback in `notes`; mastery moved `needs_practice → in_progress`, confidence 0.05 → 0.17 |
| Unattributed essay | no `concept_slug` → attempt recorded, `state.json` untouched |
| **Debrief → note + cards** | 3 bullets produced an ON note plus **3 cards**, each turning a stated confusion into a real question (validation vs test set, what `fine_tune` freezes, why a pretrained body helps) |
| **Model down** | `/api/grade` → 503 carrying "Grade this in a Claude session instead"; `/api/debrief` still **saved the note** and reported `cards_error` separately; `/api/state` unaffected |
| JSON extraction | fenced, bare-fenced, plain, prose-wrapped and nested-brace payloads all parse; prose-only and truncated JSON correctly return null |
| Score clamping | out-of-range scores clamped to `0..max` |
| Input validation | unknown topic, blank question/rubric/answer, blank debrief text → 400 |
| Reconciliation | holds with quiz + essay + fact-check attempts mixed |
| Zero deps · upstream | `node:` builtins only; render.mjs clean on both topics |

**All test artifacts reverted:** two graded essays, the failed-essay bug probe, two
debrief runs, the cards they created, and three ON notes. `.learn/` is back to 1 attempt
/ 3 real pretest cards with `your-first-model` at its original
`needs_practice / 0.05 / 1`; the notebook is at 0 notes.

---

## Status after M7

All eight slices in the plan's build table (M0–M7) are implemented, verified and
committed on `feat/study-cockpit`. **Nothing has been pushed and no PR has been opened.**

Not built, per the plan's "Explicitly not building": auth/multi-user, cloud deploy, a
mobile app, FSRS scheduling (Phase 2 Anki export), replacing learn-anything's CLI
dashboard, and presentation mode (Phase 2, after M7).

Known external blocker, unchanged: Open Notebook still has no `text_to_speech` model, so
podcast audio cannot render. M5 ships the honest empty state for it.

> **Superseded 2026-07-19** — a TTS model is now registered (local Speaches/Kokoro) and
> the cockpit can generate episodes. See *Podcast generation* at the end of this file.

### Run it

```bash
node app/server.mjs        # → http://127.0.0.1:4310
```

---

## Podcast generation — per-speaker voice choice (2026-07-19)

Branch `feat/podcast-generate`, two commits, **pushed to origin, no PR opened**:

| Commit | |
|---|---|
| `b2d0bf0` | the generate path + voice pickers (6 files, +430) |
| `a573845` | poll ceiling 20 → 60 min, message derived from the constant |

**PAUSED before the end-to-end render was proven.** Everything else is verified; see below.

### Why voices are not a generate parameter

`POST /api/podcasts/generate` takes `episode_profile`, `speaker_profile`, `episode_name`
(+ optional `content`, `notebook_id`, `briefing_suffix`). Voices live *inside* a speaker
profile, which generate references **by name**. So choosing a voice at generation time
means managing speaker profiles — it cannot be a passthrough.

Chosen model (James, 2026-07-19): when the picked voices differ from the base profile, the
form requires a name and creates a **new reusable** profile, which then appears in the
dropdown next time. Existing profiles are never mutated — a silent rewrite would change
the voices of every future episode using them.

### Two bugs found by rendering, not by reading schemas

1. **`voice_model` was unset on every speaker profile**, including the three ON shipped.
   It is *optional* in `SpeakerProfileCreate` but **required at render** — ON accepts the
   profile and fails minutes later with "has no voice model configured", far from the
   cause. `createSpeakerProfile` now resolves it via `ttsModelId()`; all four existing
   profiles were backfilled to `model:v0cp54vz1lxe3xagzu3c`.
2. **Two profiles carried OpenAI voice names Kokoro rejects** — `solo_expert` (`nova`) and
   `business_panel` (`echo`/`shimmer`/`ash`). Remapped to `af_nova` and
   `am_echo`/`af_sky`/`am_onyx`. See CLAUDE.md for the partial-aliasing trap.

### ON-side state that is NOT in git

The four repaired speaker profiles live in SurrealDB, not this repo. They survived the
crash (volume-backed) but are **not reproducible from a checkout** — if ON's data is ever
reset, both fixes above need reapplying.

### Verified by driving it

Routes + validation (bad input 400/409, never 500) · 54 voices listed from Speaches,
grouped by language · voice rows rebuild on profile switch · "Save voices as" appears on
change and hides on revert · the unnamed-profile guard blocks generation · profile
creation, and the new profile appearing in the dropdown · job polling and error surfacing
— *proven by a real ON failure reaching the UI intact* (bug 1 above).

**Not verified: a completed episode.** No episode has ever rendered to audio.

### The crash, and what it means for the re-run

The first real render ran ~40 min stuck at `generate_outline_node`, then the Mac Studio
died with "out of application memory". Contributing load: ~85GB of resident ollama models
(`gemma4:31b-mlx` **and** `qwen3-coder:30b`), the Docker VM, ON + SurrealDB + Speaches +
5 firecrawl + 2 viceroy + clawrag, and gemma4 actively generating. Compressed memory hit
106GB while swap stayed at 6.9MB — on macOS that is *not* headroom, it means compression
is the only relief valve in play, and OOM is the end of that road. Read compressed, not
swap.

So the render was never "inexplicably slow" — it was running on a machine sliding into
exhaustion. Preconditions for the re-run, none of them code changes:

1. Start Docker Desktop (Speaches is `restart: unless-stopped`, ON comes back with it)
2. `ollama stop qwen3-coder:30b` — frees ~43GB
3. Point `study-overview`'s `outline_llm`/`transcript_llm` at something smaller than a
   31B. **This is the actual fix**; the 60-minute ceiling only stops the UI from lying.

Then: Podcast view → speaker profile `tech_experts-mixed` → notebook
`practical-deep-learning-fastai` → Generate → confirm the audio element plays.

### Cleanup owed

The `Cockpit smoke test` episode is stuck `running` in ON, orphaned by the crash. Its job
is dead. `DELETE /api/podcasts/episodes/{id}` once ON is back.

> **Corrected 2026-07-19 (later session)** — the smoke test was *not* hung and the render
> was not stalled by memory. Both diagnoses were wrong. See *First completed episode* below.

### Deliberately not built

Episode deletion/retry from the cockpit (ON routes exist), multi-notebook selection, and
voice preview-on-hover (needs per-change audio streaming — its own slice).

---

## First completed episode — and the bug that was never the model (2026-07-19)

**An episode rendered end to end and played in the cockpit.** `fastai overview — qwen7b`,
5m16s, 5,057,558 bytes, MP3 64kbps/44.1kHz stereo, ~4 minutes wall clock. Verified by
driving the audio element (`readyState: 4`, `paused: false`, playhead advancing) — not by
reading a status field.

### Root cause: a stale SurrealDB LIVE query, not memory and not model speed

ON's `surreal_commands` worker subscribes to new commands through a **LIVE query
established once at worker start** (`worker.py:142`). That subscription was stale. The API
accepted `Generate`, wrote the episode, and queued the command; the worker never saw it.

The signature is nasty because nothing looks broken:

| Signal | Reading |
|---|---|
| Episode / job status | `running` — forever |
| `progress` | `null` |
| `error_message` | `""` |
| ON log lines for the run | **none at all** |

**The decisive check is the log, not the status.** A healthy generate prints
`commands.podcast_commands:generate_podcast_command:75 - Starting podcast generation for
episode: <name>` within ~1s of the click. If that line is absent, the worker never picked
the job up — no amount of waiting will change it. `docker restart quorum-open_notebook-1`
re-establishes the listener; the next Generate logged in seconds.

Stale-queued commands are **not** recovered by the restart. The worker only consumes new
commands, so anything queued while the subscription was dead stays `running` permanently.

### Two prior diagnoses this overturns

1. **The smoke test was not hung.** It generated a valid 4-segment outline in 34 min
   (16:08:53 → 16:43:19 UTC) and was mid-`transcript segment 1/4` when the machine died.
   A genuine crash casualty.
2. **The 40-minute "stall" was real work.** The dense 31B is simply slow at outline
   generation. Slow, not stuck.

Two different failures that are **indistinguishable from the UI** — both show `running`
forever — which is exactly why one got blamed for the other. Memory exhaustion was a
consequence of a long render on a loaded machine, not the cause of anything.

### Model choice is load-bearing, and `format`-ignoring is not the only trap

Outline generation asks for structured JSON, and that parse happens **inside
podcast-creator's LangChain chain** — ON's dependency. `extractJson` in `app/lib/ollama.mjs`
cannot help; it is not in this path. The model has to emit parseable output at the source.

| Model | Outline result |
|---|---|
| `qwen2.5:7b-instruct` | ✅ completed; fence-wrapped JSON, which LangChain strips |
| `gemma4:31b-mlx` | ✅ valid outline, but **34 min** for that node alone |
| `qwen3.6:35b-a3b` | ❌ fails in 52s — `Invalid json output:` with nothing after the colon |

**Reasoning models cannot be used here.** `qwen3.6:35b-a3b` returns an *empty* `response`
with all content in a separate `thinking` field, so LangChain receives nothing to parse.
Verified directly against `/api/generate`, not inferred from the failure. Check a candidate
model this way before wiring it into a profile — it costs one curl and saves a render.

### ON-side state that is NOT in git (extends the earlier list)

Two language models registered, and `study-overview` repointed at the 7B:

| | |
|---|---|
| `model:w7cw5nhtog6b2z1k9ybn` | `qwen2.5:7b-instruct` — current `outline_llm`/`transcript_llm` |
| `model:dtwvkooc50wb7320akjq` | `qwen3.6:35b-a3b` — registered, **unusable** (see above) |

`study-overview` (`episode_profile:fgkr8weabfg5uos3xadi`) now points at the 7B. Episode
profiles are asymmetric the same way speaker profiles are: **GET by name, PUT by id**,
stripping `id`/`created`/`updated`/`speaker_config_name` from the body.

### Open

- **Quality unjudged.** The 7B renders fast but is a 7B; nobody has listened to the 5m16s
  yet. `gemma4:31b-mlx` is the proven-quality fallback at ~10× the render time. There is
  now a baseline to compare against, which is new.
- **Three episodes permanently stuck**: `Cockpit smoke test` and `fastai overview — first
  render` (`running`), `fastai overview — moe render` (`failed`). Need
  `DELETE /api/podcasts/episodes/{id}`. *(Cleared 2026-07-20 — see below.)*
- **The 60-min poll ceiling is untested** — this run took 4 minutes. It becomes live risk
  again on gemma4. The better fix is surfacing the current node name in the UI: the log
  has it (`podcast_creator.nodes:...`), the poll response does not, which is what made a
  silent hang and a slow render look the same.

---

## Context fix, voice fix, loudness fix — the pipeline goes end to end (2026-07-20)

Model testing per `tasks/podcast-model-test-plan.md`; Phase 0 outcome recorded there.
Headlines: the scope failure was ON truncating every prompt to **8192 tokens** (esperanto
default, reachable only via a model→credential link that didn't exist); gemma4 is
**disqualified as `transcript_llm`** (ollama runner crashes mid-generation); the 7B at
32K renders a good episode in ~3.5 min. James judged 7B-at-32K prose **good** by listening.

### Voice replacement: am_adam → am_fenrir (James, by audition, 2026-07-20)

`am_adam` too flat for dialogue. Audition pattern that worked, ~10 s of wall clock:
render one real transcript line through Speaches directly
(`POST localhost:8969/v1/audio/speech`) in 7 candidate voices, pick by ear. This is the
deferred "voice preview" feature done manually — the backend is trivially fast; only the
UI streaming plumbing was ever expensive. New profile `tech_experts-mixed-v2`
(af_nova + am_fenrir), created not mutated, per the M-slice design.

### Loudness: Kokoro voices are wildly unmatched and ON doesn't care

James flagged fenrir "a little louder." Measured (ebur128, per clip, speaker mapped from
the render log's "audio clip NNNN for <name>" lines): **af_nova −27.2 LUFS,
am_fenrir −19.2** — 8 LU, perceptually ~2× volume, on top of the whole file sitting well
under the −16 LUFS podcast standard. `combine_audio_node` is straight concatenation
(clip-sum vs final duration differs by ~60 ms/gap of encoder padding — no normalization,
no gaps).

Fix (applied to `fastai overview — fenrir`, original kept as `.mp3.orig` beside it):
per-clip `loudnorm=I=-16:TP=-1.5:LRA=11` → concat → 128k re-encode → replace episode MP3.
Verified after: −17.2 vs −16.9 (0.3 LU), −17.5 integrated. **Per-episode and manual** —
every future render inherits the imbalance because it's inherent to the voices. Durable
candidates: a post-render leveling hook in the cockpit poll path (it already sees
`completed`), or a standalone script. Undecided.

### ON-side state NOT in git (this session's additions)

| | |
|---|---|
| `credential:lzty9rlughb6aod8xvro` | ollama credential, `num_ctx: 32768`, base_url preserved |
| `model:r59kjwf00i4clh658tl6` | `qwen2.5:7b-instruct` **linked to the credential** (old unlinked record deleted — the link cannot be added in place; delete + recreate is the only API path) |
| `speaker_profile:bpdp28uwrlnalsihx7iz` | `tech_experts-mixed-v2` (af_nova + am_fenrir) |
| `model:dtwvkooc50wb7320akjq` | `qwen3.6:35b-a3b` — registered but unusable (reasoning) |
| gemma4's model record | still **unlinked** → still loads at 8192 if used |
| episodes | zombie ledger cleared; remaining: `fastai overview — qwen7b` (8K baseline), `model-test — qwen7b-32k-real` (32K), `fastai overview — fenrir` (leveled) |

### Machine-level gotcha (outside this repo)

Two litellm daemons (ClaudeClaw's and llm-gateway's) health-check `qwen3-coder:30b` into
ollama — 47 GB @ 256K ctx, every few minutes, indefinitely. It sabotaged one "clean"
benchmark here and will sabotage the next one; fix belongs in those repos.

---

## Per-chapter podcast batch (feat/podcast-per-chapter, 2026-07-21)

**Goal.** The whole notebook rendered as one ~6-min `study-overview` skims 20 fastbook
chapters instead of covering them. A podcast is a *generated discussion*, not a reading —
length/coverage are bounded by `num_segments` and the model's context, so "cover 20
chapters in one episode" fights the context window. The right shape is one focused,
in-context episode **per chapter**.

**Mechanism.** ON's `POST /api/podcasts/generate` accepts a `content` blob *alongside*
`notebook_id`. Passing a single source's `full_text` as `content` (and no notebook_id)
scopes an episode to that chapter without needing 20 separate notebooks. `readSource()`
already returns `.text` from `full_text`; ch.1 is ~7.8k tokens — comfortably inside
qwen2.5:7b's 32k window with the outline.

**What shipped.**
- `study-chapter` episode profile (qwen2.5:7b-instruct, `num_segments: 6`, single-chapter
  briefing) — added to `app/podcast/profiles/episode-profiles.json`, registered via
  `restore.mjs`. Fast model chosen deliberately: `study-deep-dive`'s gemma4:31b runs ~34
  min/outline → untenable ×20.
- `generatePodcast()` gained a `content` param (opennotebook.mjs).
- `POST /api/on/podcast/generate-batch {topic_slug, episode_profile, speaker_profile}` —
  lists the topic's notebook sources, fires one content-scoped generate per source
  concurrently with per-source try/catch, returns a job id per chapter. Fire-all-and-poll
  (ON's worker renders serially regardless).
- Podcast view: "Generate per-chapter batch" card (defaults to `study-chapter`) + a live
  per-chapter status grid reusing the job poll.

**Verified.** ch.1 rendered end to end: `completed`, 7.8 MB MP3, **8.1 min** for one
chapter (vs 6 min for the whole book before). UI driven in-browser: batch card renders,
`study-chapter` defaulted, topic dropdown lists both mapped notebooks, validation branches
(400s + empty-notebook guard) fire without starting renders.

### Deviations / gotchas hit
- **Stale-worker trap, again.** The first ch.1 submit sat at `running`/`progress:null`
  with no `Starting podcast generation` log line — the documented stale SurrealDB LIVE
  query. `docker restart quorum-open_notebook-1` fixed it; the stuck row does NOT drain on
  restart and was deleted via `DELETE /api/podcasts/episodes/{id}`. **A 20-chapter batch
  makes this failure mode 20× more likely to bite** — if the worker is stale when the
  batch fires, all 20 rows stick. Worth a pre-flight worker-health check before the batch
  in a follow-up (fire one, confirm it leaves the queue, then fire the rest).
- **Pre-existing bug, not ours:** `.DS_Store` inside `.learn/.../quizzes/` crashes
  `/api/state` 500 — `listDecks` (learn.mjs) scandirs it as a directory → ENOTDIR. Cleared
  the stray files to unblock; the real fix (skip non-directories/dotfiles) is flagged
  separately.
- Batch uses the speaker profile's voices as-is — no per-speaker voice override like the
  single-episode card. Intentional scope cut.

### Retry-only follow-up (same branch)

Dogfooding the 20-chapter run exposed the gap the plan predicted: 4 chapters failed on
the transcript-JSON glitch and re-clicking "Generate all chapters" would have re-run all
20 (16 duplicates). Added a **"Retry failed / missing"** button:
- `generate-batch` accepts `retry_only: true` → generate only sources without a completed
  (audio) episode, matched by name; delete any stale FAILED row for a target first so
  duplicates don't accumulate. Returns `skipped` count + a "nothing to retry" message when
  all have audio.
- New ON client helpers `listEpisodes()` / `deleteEpisode()` (delete uses a raw fetch —
  DELETE can answer with an empty body that onFetch's `res.json()` would choke on).
- Verified: skip-all path returns `skipped: 20`, fires nothing; target selection picks
  exactly a simulated-missing chapter; `deleteEpisode` bad-id throws a clean 404; both
  buttons present in the live DOM.

## Batch worker-health pre-flight (feat/batch-worker-preflight, 2026-07-22)

The follow-up the last section called for. Guards the batch against the stale
SurrealDB LIVE-query trap (CLAUDE.md "External services"): ON accepts every generate
while its worker's subscription is dead, so a 20-chapter batch would write 20 rows
stuck at `running` forever.

### Design

- **The batch's first accepted chapter IS the canary** — no wasted render, no synthetic
  probe job. `generate-batch` fires targets one at a time until ON accepts one, probes
  the worker log for the pickup line (the ~1s discriminator pinned in CLAUDE.md), and
  only then commits the remaining chapters concurrently as before.
- New `lib/workerhealth.mjs`: `probeWorkerPickup()` polls `docker logs --since 120s
  <container>` (12s budget, 1.5s polls) for `Starting podcast generation for episode:
  <name>`. Three verdicts: `seen` (commit the rest), `timeout` (stale → 503 with the
  restart command), `unavailable` (docker unreadable → proceed exactly as pre-probe,
  with a UI warning — an unprobeable setup is not a stale one).
- `--since` uses a RELATIVE window, not an RFC3339 stamp, so Docker Desktop VM clock
  drift (routine on macOS after sleep) can't push the window off the log lines.
- On `timeout` the canary row is deleted (restart does NOT drain dead-listener jobs);
  scoping lives in pure `stuckCanaryRows()`: same name + running + no audio + created
  within fire-time minus 60s slack. Missing/unparseable `created` ⇒ leave the row —
  under-deleting is recoverable in ON, wrong-deleting is not.
- Container name in `cockpit.config.json` → `openNotebook.workerContainer`
  (`quorum-open_notebook-1`); missing key degrades to `unavailable`, never blocks.

### Deviations / scope cuts

- Single-episode Generate has no pre-flight — its followJob poll already narrates, and
  the trap's cost scales with batch size. Follow-up if it bites.
- No end-to-end test of the stale path against a genuinely dead worker: fabricating one
  means pausing the live quorum container. The 503 branch is exercised down to its
  parts (probe timeout live against the real container with an absent episode name;
  row-scoping + verdict transitions in 16 unit tests).
- `npm test` 16/16; live: server boots on the branch, Podcast view renders against
  live ON (23 episodes) with clean console, probe module run live → `timeout` in 13.0s
  on the real container, `unavailable` on a bogus name.

## Crash-safe, idempotent mutation storage (fix/mutation-durability, 2026-07-28)

Assessment findings **F5** (mutations not crash-safe / transactionally complete /
idempotent) and **F4** (a second same-day walk debrief silently loses its cards).
`tasks/project-assessment-2026-07-27.md` has the full statement of both.

### Design

- **`lib/atomic.mjs`** — temp-file + fsync + rename for every JSON write, so a reader
  never observes a partial file. `writeJsonAtomicSync` also retains `<name>.bak`, and
  only ever backs up a file that still PARSES: copying a corrupt primary over the backup
  is how a backup scheme turns one bad file into two. `readJsonSafe` returns the source
  it used (`primary`/`backup`/`fallback`/`missing`) instead of silently degrading to an
  empty object, which is what made corruption invisible before. `appendLineSync` heals a
  missing trailing newline first, so a torn append cannot fuse its fragment to the next
  record and lose that one too.
- **Mutation ids.** Every mutating route accepts `mutation_id`; appends dedupe on it and
  return the record that landed, flagged `duplicate: true`, with a 200 rather than a 201.
  Fact-check runs and essay grades check for the replay BEFORE doing the work — scoring
  mints cards and essay grading burns ~15s of local model time, and neither should happen
  twice for one submission. Manual cards are now keyed by mutation id rather than
  `Date.now()`, which is why a retried create used to mint a second card.
- **Attempt revisions.** Attempts carry `attempt_id` + `revision`; `readAttempts` folds
  the log to the newest revision per attempt (and drops replayed mutation ids), so
  `derive.mjs`, `stats.mjs` and `cards.mjs` need no changes and cannot disagree with each
  other. `readAttemptsRaw` keeps the unfolded log for diagnostics. Records predating both
  fields pass through one-for-one — pinned by a test using the exact shape of the attempt
  already checked into this repo.
- **`lib/lock.mjs`** — per-topic in-process promise chain (the real serializer) plus an
  advisory `cockpit/state.lock` (catches a second cockpit process, and leaves evidence
  when one dies mid-mutation; stale after 60s). Wraps `state.json` write + render so they
  cannot interleave.
- **F4** — debrief identity is per SUBMISSION, not per day: `card-debrief-<date>-<first 8
  of debrief uuid>-<n>`, with `source_ref: debrief:<full uuid>:<n>`. Card building moved
  to pure `lib/debrief.mjs` so the collision is testable without booting the server. A
  `debriefs.jsonl` ledger records what each submission produced, so a retry replays the
  recorded outcome — including a PARTIAL one (note saved, cards failed) — instead of
  creating a second ON note.
- **`/api/health`** now reports storage integrity per topic: read source per sidecar,
  degraded files, unparseable JSONL lines, stale temp files, lock state, raw-vs-folded
  attempt counts. `status` flips to `degraded`. A terminal log line nobody is watching is
  not a diagnostic for a browser UI.
- **`STUDYDECK_LEARN_ROOT`** — so mutation paths can be driven end to end against a copy
  of the learning data.

### Deviations / scope cuts

- **`renderTopic` had a hardcoded `./.learn/topics/<slug>`**, found only because the new
  override made state.json and the knowledge map render in two different trees. Fixed to
  use `topicDir()`. Not in the plan; it was a latent bug the plan's own verification step
  exposed.
- **No `.bak` for `state.json`.** The in-memory rollback already covers the failure a
  backup would, and dropping cockpit scaffolding into learn-anything's own directory
  would break hard rule 1.
- **No live debrief run.** The first debrief of a submission writes a real note into the
  real Open Notebook — indistinguishable from genuine study data. The replay branch was
  driven live (returns in 11ms, no ON or model call); card-id collision and the ledger
  are covered by unit tests instead. **Tracked follow-up:** the create path (ON note +
  ledger write + card persistence) needs either a route-level test with an injected ON
  client, or one supervised live run against a scratch notebook. Not release-blocking for
  a solo user who can see the result in the UI, but it is the one path in this PR whose
  happy case has never executed.
- **No route-level HTTP tests.** They need `server.mjs`'s handler extracted for injection;
  that is F6 work. Route behavior was verified by driving the live server instead.
- Recovery is honest about its limit: `.bak` is **one write behind**, so the write that
  crashed is still lost. What it buys is that corruption never silently reads as "no data".

### Verification

`npm test` 47/47 with `node_modules` absent. Live against a copy of `.learn/topics`:
health integrity clean, then degraded after a hand-truncated `cards.json` + a torn
`attempts.jsonl` line (`/api/state` kept serving 3 cards from the backup instead of
blanking); attempt POST replayed with the same `mutation_id` → 201 then 200, one line on
file; a strong-band attempt moved `state.json` once (needs_practice → in_progress, 0.05 →
0.17) and re-rendered the map in the SAME tree; review and manual-card replays → 201 then
200; the real `.learn/` stayed untouched throughout (`git status` clean).

## Answer secrecy and commit-before-reveal (fix/answer-secrecy, 2026-07-28)

Assessment findings **F2** (stored fact-check answers exposed before a run is submitted)
and **F3** (quiz answers can be revealed and the attempt then discarded). Builds directly
on the mutation-id plumbing from `fix/mutation-durability`.

### Design

- **F2** — one server-side stripper, `stripClaimAnswers` in `lib/factcheck.mjs`, mirroring
  `stripAnswers` in `lib/grading.mjs`. Applied to BOTH pre-submit responses:
  `GET /api/factcheck` (which returned stored records verbatim) and the generate reply.
  The client-side map that used to discard the fields on render is gone — discarding a
  payload that already crossed the wire is not secrecy, and leaving it there implies a
  protection that does not exist. Only the scored `/run` response reveals.
- **F3** — the write-free `POST /api/decks/:topic/:file/grade` route is DELETED. Submitting
  posts to `/api/attempts`, which grades, appends revision 0, and returns the reveal in
  the same response. The results screen has no Discard: the attempt is already history.
- **Self-checked items** stay `pending_self_grade` on that attempt.
  `POST /api/attempts/:id/finalize` re-grades the STORED responses plus the submitted
  self-grades, appends revision 1 under the same `attempt_id`, and applies mastery. The
  attempt record now carries `responses` so finalization cannot be steered by a second
  client payload.
- **Mastery timing.** Applied once, on the completed attempt — at submit when nothing is
  pending, at finalize otherwise. Applying at both points would double the confidence
  gain; applying once keeps the state.json diff identical to the manual `/learn:quiz`
  flow, which is the property `mastery.mjs` exists to preserve. Abandoning the screen
  leaves a recorded attempt with no mastery movement, counted in `/api/health` as
  `pending_self_grade`.

### Deviations / scope cuts

- **Score label corrected mid-verification.** Driving the finished UI showed
  `1 / 7 auto-graded` after finalization — the count included the self-marked item,
  because `correct !== null` is true for both once marked. The attempt record kept the
  distinction (`self_graded`) but the screen threw it away, which is precisely the
  "UI implies more than the data supports" failure this whole pass is about. Now renders
  `2 / 7 · 6 auto-graded, 1 self-marked`. Found only by clicking through it.
- **No route-level HTTP tests** (still F6 — needs `server.mjs`'s handler extracted for
  injection). `app/test/attempts.test.mjs` pins the storage-and-grading seam the routes
  are built from; route behavior was verified by driving the live server and the real UI.

### Verification

`npm test` 67/67 with `node_modules` absent. Live against a copy of `.learn/topics`:
`POST /grade` → **405** (route gone); `GET` deck still answer-free (0 hits for
`answer`/`explanation`/`accepted_answers`); `GET /api/factcheck` → 0 hits for
`truth`/`correction` against a seeded set holding both. Full lifecycle: submit → 201 with
`status: pending_self_grade`, `mastery_applied: false`, all 7 answers revealed in the same
response; **server killed and restarted** → attempt still there, `pending_self_grade: 1`
in `/api/health`; finalize → revision 1, `4/7`, mastery `partial 0.05 → 0.1`, state.json
md5 changed; replayed finalize → 200 and state.json md5 **unchanged** (mastery applied
exactly once). Raw log 3 records → 2 distinct attempts in `/api/state`, weakness totals
14 asked / 6 missed reconciling by hand against both. Driven in the browser: submit
records and reveals in one step, the guard blocks finalizing an unmarked item, the mastery
block appears after finalization, no Discard button anywhere, clean console.

**Review follow-up (PR #19):** the replay branch of `POST /api/attempts` returned results
graded from the RETRIED request's responses, not the stored ones. A retry carrying a
different payload under the same mutation id would have shown revealed answers that
contradicted the `score`/`max` on the attempt returned beside them. Now re-derived from
`attempt.responses`, matching what finalize already did. Verified live: replaying with
deliberately different answers returns the first attempt's reveal unchanged.

**Review follow-up 2 (PR #19), the more serious one:** `mastery_applied` was stamped on
the attempt AT APPEND TIME, before the update it described had run. A failed render — or
the topic lock held by another process — left an attempt permanently marked done with no
mastery behind it, and every retry returned a successful-looking replay, so the confidence
bump was lost silently and nothing could ever find it. The flag now means "it happened":
attempts append with `mastery_applied: false`, and `settleMastery` writes a follow-up
record at the SAME revision (so `foldAttempts` treats it as the newer view of one attempt,
not a new one) once `applyAttemptToState` returns. That makes retrying safe, which makes
healing possible: `healUnappliedMastery` finishes an owed update on replay, and
`/api/health` reports `mastery_unapplied` so a partial commit is findable.

Caught during live verification: the first version of the heal never fired, because
`handleFinalizeAttempt`'s `already_final` early return sat above it and short-circuited
the retry. The unit tests passed throughout — they exercised the heal helper, not the
route guarding it. Found only by driving the sequence: hold the lock, submit, finalize
(mastery blocked, `mastery_unapplied: 1`), release, retry. Verified end to end with a
strong-band answer set: confidence `0.05 → 0.17` on the healing retry, unchanged across
two further retries, attempts.jsonl stable at 4 records.

**Review follow-up 3 (PR #19):** the settlement sequence was only covered by tests that
hand-appended the `mastery_applied: true` follow-up themselves — so the wiring
(applyAttemptToState → follow-up append → heal exactly once) could regress while the suite
stayed green. That is precisely how the broken first heal passed 70 tests. Extracted to
pure `lib/settlement.mjs` taking the mastery function as a parameter, mirroring what
`lib/inflight.mjs` did for the same reason, and driven in `app/test/settlement.test.mjs`
with a fake that fails on demand and counts its calls: applied only after success, no
follow-up on failure, healed on replay, healed exactly once across three replays, never
healed for a pending attempt, and the re-grade reuses the recorded self-grades rather than
guessing. Re-verified live after the refactor — blocked by a foreign lock, then three
retries: confidence 0.05 → 0.17 once, `mastery_unapplied` 1 → 0, 4 records / 2 attempts.

**Review follow-up 4 (PR #19):** `healUnappliedMastery` was a check-then-act — it read
`mastery_applied`, then applied. Two overlapping replays (a double click, a second tab)
both saw the update as owed and both applied it, doubling the confidence bump. The topic
lock inside `applyAttemptToState` does NOT close this: it serialises the two writes rather
than preventing the second, and it cannot be taken around the check because it is not
reentrant (the in-process chain would deadlock on itself and the file lock would 409).
Collapsed with `shareInFlight` keyed `topic:attempt` — the same helper the debrief route
uses for the same reason. In-process only, which matches the exposure: `app/` binds
127.0.0.1:4310 so a second cockpit cannot start beside it, and the CLI never settles
mastery. The regression test was confirmed to FAIL against the unguarded version before
being kept (9 pass / 1 fail without the guard, 10 pass with it).

## Stage completion instead of calendar passage (fix/stage-completion, 2026-07-28)

Assessment finding **F1**, the last of the big workflow-integrity gaps: calendar passage
was used as evidence that study stages were done. `timelineFor` painted every milestone
left of today `done`; `buildQueue` kept only the current calendar milestone and near-future
ones, so an unfinished day-7 quiz silently vanished when day 10 arrived. `study-flow.md`
says the opposite — *"Slippage is fine; order + spacing matter, exact days don't"* — and a
date model cannot express that, because dates are all it has.

### Design

- **`cockpit/stages.jsonl`** — append-only completion/undo events, folded on read, reusing
  the mutation-id dedupe from #18. **Undo is an event, not a deletion**, so a stage marked
  done in error leaves a trace rather than a hole in the log.
- **`lib/stages.mjs`** (pure) — `foldStageEvents` (latest event per stage wins),
  `stageStatesFor` returning `done` / `now` / `owed` / `ahead` plus `owed_days`, and
  `firstIncomplete`. A date makes a stage AVAILABLE; only an event makes it DONE.
- **`positionFor` / `timelineFor`** now take stage states. `current` is the first
  *incomplete* stage whose date has arrived — not the last one the calendar passed — so
  falling behind moves nothing forward on its own.
- **`buildQueue`** never drops an owed stage. Owed rows sort ahead of upcoming ones,
  oldest first, and a blocked row says what it is waiting behind (`after WALK`) so "not
  now" cannot read as "not needed".
- **Observed activity** (`activitySince`) is shown beside a stage — "1 graded attempt, 2
  card reviews since this became due" — and consulted for nothing. Inferring completion
  from partial evidence is the same failure as inferring it from the date, so the module
  deliberately stops at showing it.
- **Routes:** `POST /api/schedule/stage|start|pause`, all carrying `mutation_id`.
  `writeSchedule` finally has a caller. Nothing here touches `state.json`, so no lock.
- **UI:** hero shows the owed stage with **Mark done**; a Completed card offers **Undo**;
  queue rows carry `owed Nd` pills; start/pause per topic.

### Deviations / scope cuts

- **The schedule strip had the same bug in picture form.** Its amber progress line ran to
  today's date, drawing elapsed time as covered ground. It now runs to the last *completed*
  stage, with a dashed coral run from there to today — elapsed but unearned. Not in the
  plan; found while wiring the new states in.
- **A finished pipeline is now sayable.** With everything marked done the hero used to fall
  through to "Start the topic". The old code had no completion state *on purpose* (nothing
  tracked whether a milestone was done); recorded completions make it expressible, so it
  says `pipeline complete`. Caught by driving the all-done case live.
- **Owed pills were amber while the strip said coral** for the same fact. Added
  `.pill.owed` so both readings agree: amber is "where you are", coral is "you still owe
  this".
- **`playIcon` moved off `innerHTML`** to DOM construction — a security hook flagged the
  pre-existing line as my edit carried it through, and building two nodes is cheaper than
  arguing with it.
- **Pause does not shift dates.** A long pause leaves stages owed on resume, which is
  honest but blunt; `step_overrides` stays unused and is the natural home for the
  reschedule follow-up.
- **Existing topics start with everything owed** — no stage events exist, and seeding
  completions from the calendar would be exactly the lie this fixes.

### Verification

`npm test` 96/96 with `node_modules` absent (16 new in `stages.test.mjs`). Live against a
copy: at `?date=2026-08-20` (day 33) the un-done day-7 quiz is still queued at `owed 26d`
instead of having vanished — the finding's exact symptom, gone. Marked four stages done in
order (leader advanced each time), replayed one mutation id (200, still 4 lines on file),
undid one (5 lines — the undo is a record), started and paused the second topic and watched
it enter and leave the queue, and confirmed 400s for an unknown milestone, a bogus action
and a malformed date. Browser: hero, Mark done, Undo, coral owed pills, timeline split
amber/dashed-coral, clean console. Real `.learn/` untouched throughout.

**Review follow-up (PR #20):** six findings, five fixed and one declined.

Fixed: `readMindMaps`/`readDebriefs` were called inside the per-milestone map, so
`/api/state` did nine file reads per topic and could observe nine different snapshots
inside one render — hoisted beside `attempts`/`reviews`/`cards`. Start-date validation was
shape-only, so `2026-02-31` passed the regex, made `dateForDay` return null for every
milestone, and left the topic looking "not running" with `schedule.started` set; it now
round-trips the parse. **The first version of that fix had the same class of bug** —
`new Date('2026-13-01T00:00:00Z').toISOString()` throws RangeError, so an invalid month
turned a 400 into a 500; caught by testing the fix rather than the original. The strip
tooltip said "owed 0d" where the pills said "due today". `observedLine` appended an "s" to
the whole phrase, producing "2 card queueds".

Also fixed, and the one that mattered: the stage `mutation_id` was minted **inside** the
click handler, so every click got a fresh id and a retry after a lost response would have
appended a second event — while the comment above it claimed the id was reused. A comment
asserting an invariant the code does not enforce is worse than no comment. Now minted once
per (stage, action) and held until that request succeeds. Verified by monkey-patching
`fetch` in the live page to fail the first call: both requests carried the same id and
`stages.jsonl` holds one event.

Declined: adding `mutation_id` to start/pause. Those set a value rather than appending a
record, so a replay writes the identical file; carrying an id the server ignores would
advertise a protection that is not running. Tightened hard rule 9 in CLAUDE.md to say
"append-ing request" so the rule states its actual scope instead of implying these routes
are non-compliant.

## Route-level HTTP tests (test/route-level-http, 2026-07-28)

Assessment finding **F6**, the last open P1. Every route claim in #18, #19 and #20 rested
on manual `curl` runs, and each of those PRs said so explicitly rather than implying
coverage. This closes the gap for the routes that do not depend on an external service.

### Design

- **`app/server.mjs` split in two.** Importing it used to call `server.listen()` on 4310 as
  a side effect, so nothing could reach a route without a live cockpit — that, not test
  laziness, is why route tests did not exist. `git mv server.mjs router.mjs`, which now
  exports `handleRequest`; the new `server.mjs` is 15 lines that own the socket and the
  boot banner. `npm start` is unchanged. Pure move otherwise — no handler was rewritten.
- **Real HTTP, not a mock req/res.** The tests attach the *same* handler the browser talks
  to onto their own server on port 0. The invariants worth pinning — answers withheld
  until an attempt is on disk, a replay that appends nothing, a body ceiling enforced
  mid-stream — live in status codes, headers and stream handling that a fake response
  object cannot observe. There is no test-only routing path to drift.
- **Fixture, not a copy of `.learn/`.** `STUDYDECK_LEARN_ROOT` points at a temp tree with a
  synthetic concept starting at confidence 0, so a test can assert an exact confidence
  after a band (`0.05` partial, `+0.12` strong). Copying the real topics would have made
  every assertion depend on how much studying happened that week.
- **`process.env` is set before a dynamic `import()`.** `config.mjs` resolves the learn
  root once, at import time, into a `const`; a static import is hoisted above the
  assignment and would snapshot the real `.learn/` — every mutation in the file would then
  land on personal study data. This is the one non-obvious line in the suite.
- Mastery is NOT stubbed: the tests run the real `applyAttemptToState`, including
  `render.mjs` on the fixture tree. Slower (~70ms per applying attempt) and worth it —
  the state.json write, the render, and the rollback path are the parts most worth having
  exercised.

### Deviations / scope cuts

- **`/api/on/*`, `/api/tts/*`, `/api/grade`, `/api/debrief` and the mindmap note routes are
  not covered.** They call Open Notebook or ollama; testing them means either hitting live
  services or asserting against a stub of an API this repo does not control. The file's
  header says so rather than leaving the omission to be inferred from what is absent.
- **A 413 never reached the client — found here, fixed in review.** `readJsonBody` rejected
  and called `req.destroy()` in the same tick, tearing the socket down before the error
  response could flush: five runs, five `ECONNRESET`s. The refusal itself was sound
  (nothing written, 413 logged), so this was a reporting defect, not a data one — but a
  caller cannot tell "too large" from "the network dropped". Deferred in the first push as
  scope creep; CodeRabbit flagged the same line independently, so it landed here instead.
  The stream is now PAUSED on overflow and drained on the response's `finish` event —
  pausing without that drain leaks the connection, and draining before it reproduces the
  original reset. Five runs, five 413s, and the test asserts the status rather than
  tolerating either outcome.
- The two `%2F`-encoded traversal probes confirm the static handler normalizes the escape
  out and lands inside `app/web` (404), rather than reaching the 403 containment branch —
  the assertion is "does not serve repo files", which is the property that matters.

### Verification

`npm test` 118/118 with `node_modules` absent (21 new in `routes.test.mjs`); 97 before.
The real `.learn/` is untouched — `git status .learn/` clean after the run, and the suite
never resolves a path outside its temp fixture. `node app/server.mjs` still boots against
a copy and serves `/api/state` (200) and `/` (200) with the banner intact.

**Review follow-up (PR #21):** six findings, all six applied.

The one that mattered was the 413 above — CodeRabbit reached the same line independently
and rated it the only non-trivial finding, which is a fair read: a deferred defect in a PR
whose whole subject is "the routes are now actually tested" is the wrong thing to defer.

Two were tests that passed for the wrong reason. `/media/sketches/<topic>/../../state.json`
never reached the sketch guard at all — `fetch` normalizes the literal `../../` out before
sending, so the server saw `/media/state.json` and 404'd on the route, not the name check.
Verified by echoing `req.url` from a bare server: the plain form arrives collapsed, the
`%2F` form arrives intact. A green assertion proving nothing is worse than a missing one,
because it also stops anyone from writing the real one. The leak probe's `raw.includes('two')`
had the mirror-image flaw waiting — any payload containing "network" would have failed it
for no reason; now `\btwo\b`.

Also fixed: the teardown called `server.close()` without `closeAllConnections()`, and
undici pools keep-alive sockets — the runner would idle until `keepAliveTimeout` and a late
pooled request could reach a deleted fixture. `readJsonBody`'s executor parameter shadowed
node:path's `resolve`. And `server.mjs` had no `error` handler, so the routine mistake of
starting a second cockpit printed a stack trace instead of `EADDRINUSE`.

Declined: opening a GitHub issue to track the 413. It is fixed in this PR, so there is
nothing left to track — and this file, not the issue tracker, is where this repo has
tracked follow-ups (see the debrief create-path note above).

**Deferred out of PR #21 — four review findings in code this PR only relocated.**
*(All three code items closed in PR #22, below. Kept as written for the record.)* None was
introduced here; all predate the split. Fixing them inside a testing PR would have shipped
robustness changes on reasoning rather than evidence, so they get their own branch and
their own tests.

- **Unhandled `error` on piped read streams (crash).** `sendStatic`, the sketch route and
  both `sendVideo` paths call `createReadStream(...).pipe(res)` with no error listener. A
  file vanishing mid-stream emits `'error'` with nothing listening, which takes the process
  down. A shared `pipeFile` helper covers all four. `decodeURIComponent` in the same
  function throws `URIError` on a malformed escape, surfacing as a 500 where a 400 is
  correct.
- **Committed headers before a stream can fail.** `/api/on/episodes/:id/audio` calls
  `writeHead` before `Readable.fromWeb(audio.body)`; a null body or mid-stream failure then
  reaches the top-level catch, which calls `sendJson` on an already-committed response —
  `ERR_HTTP_HEADERS_SENT`, and the client hangs. Validate the body and attach the listener
  before writing the head.
- **Factcheck and essay attempts omit `attempt_id` and `revision`.** Quiz attempts carry
  both; these two do not, so `findAttempt` cannot resolve them and `foldAttempts` handles
  them through its legacy-Symbol branch. Harmless today because neither is finalizable, but
  it is rule 9 unenforced in two of the three append paths.
- **Declined: switching the factcheck/essay replay lookups to `readAttempts`.** Cited
  against rule 9, but the rule was narrower than the code. `foldAttempts` drops superseded
  revisions, so a folded lookup would miss revision 0's `mutation_id` and let a replay
  append a duplicate — exactly what the id prevents. `sidecar.mjs` already documented raw
  as "diagnostics and replay checks"; rule 9 now says the same, with the reason. Same
  resolution shape as the start/pause `mutation_id` decision in #20: when a correct
  implementation trips a rule, check which one is wrong before changing code.

## Stream failures and attempt identity (fix/stream-error-handling, 2026-07-28)

The three code findings deferred out of #21. None was introduced by that PR; the split
just put them all in one file where a reviewer could see them at once.

### Design

- **`app/lib/stream.mjs`** — `pipeStream(res, stream, label)` and `pipeFile`. `.pipe()`
  does not forward errors, and an unlistened `'error'` on a stream is an *unhandled event*:
  a file vanishing mid-download, an EIO on the drive holding `docs/`, or ON dropping an
  audio connection each ended the whole cockpit for one bad request. Four call sites
  (`sendStatic`, sketches, both `sendVideo` paths) plus the ON audio pipe now go through it.
- **Destroy, don't end.** Once the head is written there is no status left to send, so a
  mid-stream failure destroys the response. The client gets a truncated body, which is
  true. Ending normally would hand over a silently short file and call it success.
- **`res.destroy()` with no argument — found by testing the fix.** The first version passed
  the error through (`res.destroy(err)`), which is what the review suggested and what looks
  natural. A generic Writable re-emits that as its own `'error'` event, which is another
  unlistened event — the exact crash the helper exists to prevent, moved one stream
  downstream. It surfaced as the `pipeFile`-ENOENT test killing the runner instead of
  failing. The cause is already logged; the argument bought nothing.
- **The reverse direction too.** `res.on('close') → stream.destroy()`: a client closing the
  tab during a 46MB video otherwise leaves the read stream open with nothing draining it.
- **`safeDecode`** wraps all seven `decodeURIComponent` sites. A malformed escape threw
  `URIError`, which the top-level catch reported as a 500 with a stack trace — the server
  claiming its own fault, and log noise, for a plainly bad request. Now a 400 and one line.
- **Episode audio validates before committing headers.** `writeHead` ran before
  `Readable.fromWeb(audio.body)`, so a null body reached the catch, which called `sendJson`
  on an already-committed response — `ERR_HTTP_HEADERS_SENT`, and a client hanging on a
  response that would never end. A missing body is now a 502 while a status can still be sent.
- **Factcheck and essay attempts carry `attempt_id` + `revision`.** Rule 9 was enforced in
  one of three append paths; the other two folded through `foldAttempts`' legacy-Symbol
  branch and were invisible to `findAttempt`.

### Deviations / scope cuts

- **The stream-failure path is covered by unit tests, not a live run.** Forcing a real
  mid-transfer ENOENT means winning a race against `existsSync`; driving the helper
  directly is deterministic and tests the same listener. The live run covered the happy
  paths and the abort path instead, and this note says which is which rather than implying
  the crash itself was reproduced against the server.
- No test for the ON audio 502 — reaching it needs Open Notebook to return a bodiless
  response, which is the external-service boundary #21 drew and this PR keeps.

### Verification

`npm test` 127/127 with `node_modules` absent (5 new in `stream.test.mjs`, 4 new route
tests; 118 before). Live against a copy: 46MB video streamed whole (`200`, 46,318,202
bytes), `Range: bytes=0-1023` → `206`/1024, suffix `bytes=-500` → `206`/500, index and
`app.css` served, `/%E0%A4%A` → `400` with a single log line and no stack trace, and the
server still answered `/api/health` after a client aborted a video mid-stream. Real
`.learn/` untouched.

**Review follow-up (PR #22):** two findings — one applied, one declined for this PR but it
uncovered a real gap.

Applied: the fact-check replay test created its first run in the preceding test, so alone
or under `--test-name-pattern` it received a 201 where it asserted a 200. Now self-contained
with its own mutation id. Same class as the `../../` traversal in #21 — a test whose green
depended on something other than what it claimed to check.

Declined here: rejecting a request that omits `mutation_id` with a 400. The finding is
directionally right — an append without a client-minted id cannot be deduplicated, exactly
as rule 9 says — but the server is the wrong end to fix first. **Three views do not send
one today**: `flashcards.mjs:58` (`/api/reviews`), `factcheck.mjs:64`
(`/api/factcheck/run`), `mindmap.mjs:141` (`/api/mindmap/run`), plus `/api/cards/sync`.
Enforcing at the server would 400 all four immediately. The real defect is on the client
side and is worse than the review implied: a double-clicked "I got it" or a retry after a
lost response **can log the same review twice**, and a card's rung is its consecutive-hit
streak — so the interval silently lengthens on work that happened once. Rule 9 is written
as though the client already mints ids everywhere; in three views it does not.

**Tracked follow-up (next):** mint the id once per action in those views, the way
`today.mjs:258` and `testcenter.mjs:160` already do, and only then tighten the server to
reject appends that arrive without one — client first, or the tightening is an outage.

**Review follow-up (PR #24):** 14 findings, all on vendored upstream `learn-anything` code
and all declined for that PR — it only made git aware of `.agents/`, whose files are
byte-identical to the already-tracked `.claude/skills/` copies. Patching there would fork
upstream AND create the drift the same PR documents, while leaving the executed copy alone.

**One is real and worth fixing eventually — verified, not assumed.** `checkFields`
(`utils.mjs:86-88`) returns early on a null entry without recording an error, and the caller
then dereferences it, so a `state.json` with `"domains":[null]` crashes `validateStateV1`
with a TypeError where it should have returned a validation error. Reproduced directly:

```text
node .claude/skills/learn-anything-quiz/scripts/render.mjs <dir-with-null-domain>
TypeError: Cannot read properties of null (reading 'concepts') at validateStateV1
```

It is **contained**, and the containment is the P1 work paying off: a render crash is a
non-zero exit, `execFileSync` throws, `renderTopic` returns `{ok:false}`,
`applyAttemptToState` restores the original bytes and throws, and `applyMastery` reports
`{error, attempt_recorded:true}` instead of 500-ing. `mastery.mjs:113`'s
`flatMap((d) => d.concepts)` would throw one layer earlier and land in the same handler.
Reaching either needs a hand-corrupted `state.json`; nothing in the cockpit writes one.

If the fix is taken it must land in **both** `.claude/skills/` and `.agents/skills/` —
precedent is upstream bugs #121–#125 with two patched locally in `7cc4068`. The remaining
findings (path traversal via an unvalidated `domain.slug`, same-day session filename
collisions, the CLI skill writing an answer-bearing deck before the quiz) are upstream
design. The cockpit already solved the answer-exposure one on its own side in #19.

## Client-minted mutation ids, and the server refusing appends without one (fix/client-mutation-ids, 2026-07-28)

The follow-up recorded during PR #22's review. Rule 9 was written as though the client
already minted ids everywhere; three views did not, so `appendUnique` ran on those paths and
deduplicated nothing — dedupe that reads as present in the route code and is inert in fact.

### Design

- **`app/web/js/mutation.mjs`** — `withMutationId(key, send)`. The id is minted once per
  intent, **kept across a rejection** (that is the case a retry must be deduplicated
  against) and **dropped on success** (or the next genuine click is swallowed as a replay).
  A helper rather than a fourth hand-rolled copy: the invariant is small, easy to get
  backwards, and was already got backwards once — #20's review caught the stage id being
  minted inside the click handler while the comment above it claimed reuse.
- **Keys name the intent, not the request.** `review:<card>:<hit|miss>` — sharing one id
  across both verdicts would make the second a swallowed replay of the first.
- **The server now REFUSES an append with no id** (400) instead of minting one. The
  fallback read as tolerant and was worse than no protection: every request became unique by
  construction. A route cannot distinguish "no id" from "a client that never retries", so
  the only way the guarantee is real is to refuse what cannot be protected. Nine append
  routes require it; `/api/schedule/start`, `/pause`, `/api/reading` and the card suspend
  toggle still take none (they SET), and `/api/cards/sync` is idempotent by `source_ref`.

### Found while doing it

- **`/api/mindmap/run` had no replay protection at all**, and the client id would have been
  silently ignored — precisely the "id the server ignores advertises a protection that isn't
  running" failure rule 9 warns about, nearly shipped by me. `recordRun` now dedupes on the
  id, and the route returns before pushing a note: a retry used to append a second run AND
  create a second Open Notebook note, so one recall session appeared twice in the record.
- **A failed review left the session stuck.** `flashcards.mjs` disabled both buttons on
  click and never re-enabled them in the catch, so the only way out of a failed review was a
  page reload — which discards the in-memory id. A stable retry id is theatre if the retry
  can never be issued. Found by driving the UI, not by reading the diff: the simulated
  failure produced no second request at all.

### Deviations / scope cuts

- **`today.mjs` and `testcenter.mjs` were left on their hand-rolled copies.** They work and
  are correct; migrating them to the helper is a refactor of working code with no automated
  UI coverage, so it is a separate change. The duplication is real and worth closing next.
- **Only the flashcards path was driven live.** The fact-check view needs a stored claim set
  (none exists in the copy without a local-model generate run) and the mind-map view writes
  a real Open Notebook note. Both client edits are the same three-line shape as the verified
  one, and both routes' dedupe is covered by route tests — but the browser path for those
  two was not exercised, and this note says so rather than implying it was.

### Verification

`npm test` 136/136 with `node_modules` absent (5 new in `mutation.test.mjs`, 4 new route
tests; 127 before). Live, driving the real UI against a copy: reviewed a card (201, one
record carrying a client-minted id), then monkey-patched `fetch` to let the write land and
throw afterwards — the error surfaced, **the buttons re-enabled**, the retry carried the
SAME id (`aa3aca08…`, captured both times), the server answered 201 then **200**, and
`reviews.jsonl` holds exactly **one** row for that id. Real `.learn/` untouched.

**Review follow-up (PR #25):** one finding, applied — and it was the same bug one layer
down from the one this PR fixed.

`saveSketch` ran in the route BEFORE `recordRun` checked the mutation id, and the sketch
filename is timestamped, so every retried mind-map run wrote a fresh file of up to 8MB that
no run ever referenced. Exactly the repeated-expensive-side-effect this PR exists to stop
for the Open Notebook note — missed because **my replay test passed `sketch: null`** and so
never exercised the path. The raw data URL is now handed to `recordRun`, which writes it
only after establishing the run is new.

The replacement test was checked against the bug rather than assumed to cover it: with the
save moved back before the duplicate check it fails ("a replay must not write another"), and
passes with the fix. A test written for a bug that is already fixed should be run against
the unfixed code once, or it is only evidence that the code does what it currently does.

## One mutation-id implementation, not four (refactor/mutation-id-helper, 2026-07-28)

The cleanup left open by #25. `withMutationId` existed but only three views used it; the
other three kept hand-rolled copies of the same invariant. Duplicating a subtle rule is how
the stage-id bug happened in the first place (#20's review: minted inside the click handler
while the comment above claimed reuse).

### Design

- **`today.mjs`** dropped its `retryIds` Map — the helper is that Map, module-scoped.
- **`testcenter.mjs`** dropped two `const mutationId = crypto.randomUUID()` minted at render
  time, one for submit and one for finalize.
- **`debrief.mjs`** dropped a `let mutationId` that re-minted on success. That was already
  the helper's semantics written out by hand: keep on failure, replace after a successful
  save so "Save another" is a new mutation.
- `crypto.randomUUID` now appears in exactly one file under `app/web/js/`.

### Not a wash — the closure consts were weaker than they looked

A `const` minted inside a render function dies with that render. Submit a quiz, lose the
response, navigate away and back, submit again: the re-rendered form minted a NEW id and
recorded a **second attempt** for one submission. The helper's ids are module-scoped and
outlive the re-render, so that retry is recognised. Same for `today.mjs`, whose Map was
local to `renderToday`.

This is the flashcards finding from #25 in a different costume: there, the retry was
unreachable because the buttons never re-enabled; here, the retry was reachable but carried
an id that had been thrown away. Both make a stable id decorative.

### Deviations / scope cuts

- **`debrief.mjs`'s ok-check moved INSIDE the helper callback.** It builds its request with
  a bare `fetch` and threw after inspecting `res.ok`; leaving that outside would have
  resolved the callback on a failed response, cleared the id, and let the retry write a
  second debrief and a second Open Notebook note. Checked that the other two views' `api()`
  and `post()` wrappers already throw on non-ok — they do, so their calls needed no change.
  Worth stating because it is the one way to use this helper wrongly.

### Verification

`npm test` 137/137 with `node_modules` absent (no new tests: the invariant is already
covered by `mutation.test.mjs`, and this change is about who implements it).

Both migrated paths driven in the real UI against a copy, with `fetch` patched to let the
write land and then throw:
- **Stage mark-done** (`today.mjs`): retry carried the same id (`69e57707…`), server 201
  then **200**, `stages.jsonl` holds **one** event.
- **Quiz submit** (`testcenter.mjs`): failed, then Cancel → Retake → submit on a
  **re-rendered** form. Same id (`4f60dcb0…`), server 201 then **200**, one record on file —
  the case the old per-render const could not have handled.

Real `.learn/` untouched.

## Vendored validator crash, patched in all ten copies (fix/vendored-validator-null, 2026-07-28)

The one real finding from PR #24's review, now fixed. `checkFields` in learn-anything's
`utils.mjs` returned silently when an entry was null — recording **no** error — after which
the caller dereferenced it. Validation crashed with a TypeError where it should have
reported invalid input:

```text
node .claude/skills/learn-anything-quiz/scripts/render.mjs <dir-with-null-domain>
TypeError: Cannot read properties of null (reading 'concepts') at validateStateV1
```

This is not third-party code the app sits beside: `mastery.mjs` shells out to `render.mjs`
on **every** mastery update, so the validator runs inside the write path.

### Design

- `checkFields` now records `Expected a non-null object` and returns `false`; both callers
  (`validateStateV1`'s domain loop, `validateQuizDeck`'s question loop) `continue` on it.
  Recording an error alone was not enough — the crash was in the caller's next line.
- **All ten copies patched**, five skills × `.claude/` + `.agents/`. They were byte-identical
  before and are byte-identical after.
- Same input now exits 1 with `.domains[0]: Expected a non-null object`.

### The patch is fragile, and the test is what makes that safe

Rule 1: `learn-anything-cli update` overwrites these generated files. This patch is one
upgrade away from vanishing, and it would vanish **silently**, restoring a crash inside the
mastery write path. `app/test/vendored-validators.test.mjs` therefore asserts three things:
the null cases are reported rather than thrown, valid input still validates clean (a false
positive here would block every mastery update, since render failure triggers rollback), and
**all ten copies are identical and still contain the `LOCAL PATCH (studydeck)` marker**.

Verified against the bug rather than assumed: reverting one copy to the upstream shape fails
four of the five tests, including the drift guard. "Valid input validates clean" correctly
keeps passing — it is the no-false-positive check, not a bug check.

### Deviations / scope cuts

- **Not reported upstream yet.** Filing on someone else's tracker is James's call to make,
  not mine to make on his behalf; precedent is bugs #121–#125 with two patched locally in
  `7cc4068`. The fix above is written so it can be lifted straight into an upstream issue.
- **The other PR #24 findings stay declined**: `domain.slug` path traversal (no untrusted
  input path — `state.json` is authored by the user's own tools), same-day session filename
  collisions, and the CLI skill writing an answer-bearing deck before the quiz. All are
  upstream design, and the cockpit already solved the answer-exposure one on its own side
  in #19.

### Verification

`npm test` 142/142 with `node_modules` absent (5 new; 137 before). `render.mjs` on a
hand-built null-domain `state.json` now exits 1 with a readable validation error instead of
a stack trace.

---

## F7 — the working topic (`fix/global-topic-selection`)

Assessment finding F7. Five views each did

```js
state.topics.find((t) => t.slug === state.today.topic_slug) ?? state.topics[0]
```

— Reading, Mind Map, Fact-Check, Essay and Debrief. With two topics configured, the second
one's sources, concept map, claims, essays and debriefs were reachable only on the mornings
the schedule happened to nominate it. Not hidden behind a setting: **unreachable**.

### The distinction the fix is built on

`state.today.topic_slug` is what the SCHEDULE recommends today. The working topic is what
YOU chose to open. Reading the first as if it were the second *is* the bug — the
recommendation is an input to the default, never the answer. `web/js/topic.mjs` owns that
distinction and nothing else.

### Decisions (James, this session)

- **Scope: the five single-topic views only.** Today, Flashcards and Test Center keep
  interleaving across topics. Interleaving is the spaced-repetition design — mixing topics
  is what makes retrieval harder and the memory stick — so a global filter would have
  quietly switched off the thing the schedule is built around. Their nested Essay and
  Debrief panels still need a topic, so it reaches them through their parents.
- **Placement: the rail footer**, beside the day counter, which is already the topic-status
  area. Visible from every view, no vertical space in the main column, no change to the
  approved comp's layout.

### Shape

Resolution order in `workingTopic(state)`, each step earning its place: an explicit choice
**if that topic still exists** (a stored slug outlives the topic it names, and a stale one
must not strand every view); else today's recommendation, so a first run opens where the
schedule points; else the first configured topic.

Resolved **once** in `render()` and handed down, rather than each view re-deriving it. Five
copies of one fallback was the finding; five copies of one lookup is the same bug waiting to
diverge again. The Observatory is the one exception — it is opened imperatively from Today
and Stats, both cross-topic views that deliberately receive no topic to forward, so it calls
`workingTopic` itself.

Not server state: nothing in `.learn/` or `cockpit/` changes when you switch, so persisting
it through a route would mean a mutation, a sidecar and a lock for something that belongs
beside the theme. localStorage, same key prefix, same lifetime.

Today's topic is **labelled** (`· today`) rather than silently pre-selected, so the
schedule's opinion stays visible after you steer away from it. Without the mark there is no
way to read "this is what I chose" apart from "this is what the app decided".

### Two bugs found by driving it, neither visible in the diff

1. **`Day null`.** The rail's day counter now follows the working topic — it sits directly
   above the picker, and a footer reading "Day 10" while the control beneath names a topic on
   day 3 is a readout contradicting itself. But `position.dayN` is null until a topic is
   started, and the picker can select one that never was. The old lookup only ever resolved
   the topic the schedule had nominated, which is started by construction, so `Day ${dayN}`
   was *always* a number. The first paused topic printed "Day null". `schedulePosition()`
   now says `Not started` / `Paused` / `Day N`, and the Observatory shares it.

2. **The picker blew the rail apart.** A `<select>` is as wide as its longest option, and
   `.foot .lines` is a flex item — which defaults to `min-width: auto` and so refuses to
   shrink below its content. The rail widened and the theme toggle was pushed into the main
   column. **This CSS file already documents the identical trap for `main`**, eight lines up.
   Fixed with `min-width: 0` plus a `.foot-row`, giving the picker the rail's full width;
   sharing the row with the toggle left it ~90px, truncating every topic name to a stub.

### Verification

Browser-driven throughout — this change is entirely client-side, so `npm test` (155/155,
unchanged) proves only that nothing server-side regressed.

| Checked | Result |
|---|---|
| Switch topic | crumb, Mind Map, Reading Room, Fact-Check (`/api/factcheck?topic=ai-agent-design-patterns`) and Essay's concept list all follow |
| Persistence | survives a full reload |
| Stale stored slug | falls back to today's recommendation, no error panel |
| Unstarted topic | `Not started · 1/2 topics`, no `Day null` |
| Debrief panel | renders inside Flashcards with the topic threaded through |
| Console | zero messages across every view |

### Deviations / scope cuts

- **The Podcast view keeps its own topic dropdown.** It targets a batch generation job — a
  form field, not "what am I studying" — so folding it into the global selection would
  conflate two different questions. Left alone deliberately.
- **Long topic names still truncate in the 212px rail.** Native select truncation; the
  `title` carries what the schedule recommends and what the control governs, so nothing
  truncation hides is unrecoverable.
- **Stats and Today are untouched** — both are cross-topic by design.

### Follow-up: the stale-response race (CodeRabbit on #29)

CodeRabbit flagged a real one, and it is squarely this PR's subject rather than a bystander:
async views `clear(root)` and repaint **unconditionally** after their await. That was safe
when a view could only be replaced by navigating — nobody navigates mid-load on a local
server. The picker broke the assumption.

**Reproduced before fixing**, by delaying only the FIRST `/api/on/sources` request so the
stale response is the one still in flight:

| | |
|---|---|
| after the switch paints | `Reading Room — AI Agent Design Patterns` |
| after the stale response lands | `Reading Room — Practical Deep Learning (fast.ai)` |
| picker still says | `ai-agent-design-patterns` |

The control and the content disagreeing is the worst available failure for a study system —
you would read one topic's sources believing they were the other's.

**Fixed at one point rather than a dozen.** Each render paints into a fresh
`.view-surface` inside `#main`; `clear(main)` has already detached the previous surface, so
a stale continuation clears and repaints a node that is no longer in the document. The
alternative CodeRabbit offered — a generation guard after every await in every async view —
is a check that must be remembered at each site and fails silently wherever it is forgotten.
Safe because `main` is not a flex or grid container and no selector targets its direct
children, both checked before writing it.

Re-ran the identical reproduction: picker and content now agree, and `#main` holds exactly
one surface. All nine views repainted with zero error panels and zero console messages.

**Known tension, accepted:** on the Today view the hero can read "Day 10 of 30" (the
schedule's nominated topic) while the rail footer reads "Not started" (the working topic).
They describe different topics on purpose, and the footer sits directly above the picker
naming its subject. The alternative — a footer following the nomination — puts it in direct
contradiction with the control beneath it, which is worse.

---

## F8 — the browser request boundary (`fix/browser-request-boundary`)

Assessment finding F8, the highest-severity item left after the P1 pass. The claim being
fixed is narrow and worth stating precisely: **binding `127.0.0.1` stops other machines, and
nothing else.** It does not stop another tab in the same browser, which shares the loopback
interface with the cockpit and needs no permission to send it a request.

### What was actually exploitable

`readJsonBody` parsed any bytes as JSON regardless of `Content-Type`, and no route read
`Origin` or `Host`. So a page on any site could issue a form-shaped cross-origin POST — no
preflight, no consent — to all 19 mutating routes. It could not read the reply, and did not
need to: rule 7 makes `attempts.jsonl` the system of record, so a forged attempt poisons the
mastery figure every later scheduling decision reads from. Reading was reachable too, by
rebinding a hostname to 127.0.0.1 after page load.

Second surface: SVG sketches were stored and served back as `image/svg+xml` from the app's
own origin. SVG carries script, so that is same-origin code execution by upload.

### The shape of the fix

`app/lib/guard.mjs`, called once at the top of `handleRequest`:

| Check | Applies to | Refusal |
|---|---|---|
| `Host` hostname is a loopback literal | every request, reads included | 403 |
| `Origin`, when present, equals `http://<Host>` | mutating methods | 403 |
| `Content-Type` is `application/json` | mutating methods | 415 |

Loopback **literals**, at any port — not the configured port. A rebinding attack has to put
an attacker-controlled *name* in `Host`; that is the mechanism. Pinning the port instead
would have made the test suite (ephemeral port) prove something the browser never does.

**No CSRF token, deliberately.** `application/json` is not CORS-safelisted, so a
cross-origin request carrying it is forced through a preflight, and this server emits no
`Access-Control-Allow-*` on any response — so no preflight can succeed and the real request
is never sent. A token would guard a gate nothing can pass, and it cannot help against the
one caller that gets past all of this (another local process, which can read the token out
of the page). It would cost state threaded through 19 routes and every `fetch`, and would
break the curl-driven verification this repo runs on. The reasoning is load-bearing rather
than decorative, so `guard.test.mjs` asserts no response carries a CORS grant — if that ever
becomes false, the argument for omitting the token is gone and the test says so.

Security headers go on with `res.setHeader` **before routing**, not merged into each of the
seven `writeHead` sites. Seven call sites that must each remember a constant is seven
chances to ship a response without one; this way the error path and every future route
inherit them. `script-src 'self'` is the directive that matters — `reading.mjs` assigns
rendered Open Notebook markdown to `innerHTML`, so a source document is a live injection
sink, and blocking inline script is what makes a hostile one inert. `style-src` keeps
`'unsafe-inline'`: the view layer sets `style` attributes in 27 places. That is an honest
weakening and the narrow one — it permits CSS, not execution.

SVG is removed rather than sanitized. Sanitizing it properly needs a parser and rule 5
forbids dependencies, so the surface goes instead. No SVG sketch had ever been written, so
nothing on disk was orphaned.

### The bug this uncovered — a real one, found by testing the fix

Every guard refusal reached the client as an intermittent `ECONNRESET` instead of the 403
explaining it. PR #21 had added `res.on('finish', () => req.destroy())` to discard a body
that `readJsonBody` **paused** mid-stream after a 413. The guard rejects *before* any body is
read, so `readableEnded` is false there too and the same line fired — and an RST discards
whatever the peer has not yet read, including the response already on the wire.

It presented as a race: one cross-origin test passed while an identical one failed. That is
also how a user would have met it — a refusal that sometimes reads as "the cockpit is down"
instead of "you are being blocked, and here is why". The two cases want opposite handling,
so the error now carries `oversized`: destroy only that one, drain (`req.resume()`) every
other, which costs one pass over a body already bounded by `MAX_BODY_BYTES` and leaves the
connection usable.

Worth recording as a pattern: this is the second time in this repo (after `res.destroy()`
re-emitting an error in #22) that **testing the fix, not the original defect, is what
surfaced the bug**.

### Verification

- `npm test` 155/155 with `node_modules` absent — 13 new, 142 before. The existing 413 test
  still passes, which is what proves the `oversized` split did not regress #21's drain.
- Every browser POST site was audited before shipping: all ten already send
  `content-type: application/json`, so no client change was needed. That was the one way
  this change could have silently broken a feature.
- Live against a copy (`STUDYDECK_LEARN_ROOT=/tmp/learn`): cross-origin `text/plain` POST
  403, cross-origin JSON POST 403, rebound `Host` 403, all five security headers present on
  the shell, and a legitimate same-origin write landing on disk.
- Driven in a real browser: shell, Mind Map and Flashcards all render, and a flashcard
  review round-tripped with its `mutation_id`. **Zero console messages** — no CSP violation,
  which was the live risk a curl run could not have ruled out.

### Deviations / scope cuts

- **CSRF token dropped from the stated scope**, with reasoning above. Flagged before
  implementing rather than after.
- **`.svg` stays in the `MIME` table** for repo assets under `web/`. Developer-authored files
  and uploads are different trust domains; only the upload path is closed.
- **F9's advertised-vs-actual sketch size contradiction is still open** (1 MB request cap vs
  a documented 8 MiB limit). It fails cleanly since #21 fixed the 413, so it is cosmetic —
  but removing SVG did not touch it.

---

## The 413 flake — a refusal thrown away by its own teardown (`fix/oversized-body-teardown`)

Found by looping `npm test` during branch cleanup, not by a report. The 413 body-ceiling
test failed 1 run in ~12 on `main` and 0 in 30 at `0fabe9d` (pre-#28).

### Root cause

`req.destroy()` sends a TCP RST, and an RST discards whatever the peer has not yet read —
**including a response already written**. Doing it inside `res.on('finish')` looks safe and
is not: `finish` means "handed to the socket", never "the client read it". The client is
also still uploading, so it takes an EPIPE on the write side at the same moment.

Measured with a standalone probe: **17 of 200 refusals never reached the client** (14 EPIPE,
3 ECONNRESET). That is precisely the failure #21 set out to remove, so its comment claiming
the ordering "is the only ordering that gets both" was wrong.

**#28 did not introduce it.** The 413 path is logically identical before and after — every
response merely carries five more headers now, which shifted a latent race into view. The
same root cause is documented in #28 for the guard path, where the fix was already to drain.

### The fix, and the bug hiding behind it

Drain there too, and the branch collapses: every refusal discards its body, and a body that
fits **within `MAX_DISCARD_BYTES`** lets the connection close normally. Past the cap
`discardBody` still destroys — that is the deliberate exception, and the 12 MB test permits
a transport failure there for exactly that reason. Discarding is not buffering (bytes are
dropped as they arrive), so the cap bounds patience, not memory.

That immediately exposed a **second** bug the destroy had concealed: `readJsonBody`'s `data`
listener stays attached after it rejects, and re-`pause()`d on every later chunk. So
`discardBody`'s single `resume()` survived exactly one chunk and the request deadlocked.
Invisible before, because a drain cannot be seen to stall on a socket that was already torn
down. A `refused` flag stops that listener participating once it has refused.

Result: 200/200 then 600/600 refusals read by the client, against 183/200 before — all with
bodies inside the cap.

### A claim I got wrong, and how it was caught

The first write-up said the deadlock "stalled a 200-request probe on its **first** request".
That was not measured — it was inferred from grepping a probe log for `413` and finding
none, in a run where I had discarded stderr. The server's log line goes to stderr, so the
grep proved nothing at all.

Re-measured by reintroducing the deadlock: **roughly 1 request in 40 stalls**, and the 413
is logged every time, so the server looks healthy from its own log. The original probe hung
because it had no per-request deadline, so the first stall — whenever it came — blocked it
forever. Same failure mode as the test-count error earlier the same day: a specific,
plausible number that was never actually observed.

### Three things the tests got wrong first, and how

Both are recorded because the *method* was the lesson, not the outcome.

1. **The repeat count was guessed, then measured, then measured again.** I sized the loop at
   25 iterations from the probe's 8.5% and wrote "catches ~89 times in 100" into the code.
   Run against the unfixed router it caught the bug **5 times in 15**. In-suite requests
   reuse a warm keep-alive socket, so the real per-request rate here is under 1%, not 8.5%.
   At 200 iterations it catches 8 in 10 — so the shipped comment says 80%, measured, and 25
   would have shipped a guard that misses two regressions in three.

2. **The settle test made the suite 4× slower while reporting 24ms.** Its `Promise.race`
   timer was never cleared, and a pending timer keeps Node's event loop alive — so the file
   sat idle for the full 10s after the race resolved. Suite went 2.5s → 11.6s. The per-test
   duration reads 24ms either way; only wall-clock against CPU (13%) showed it. `.unref()`
   fixes it; suite is 4.2s, of which ~1.7s is the new guard.

### Verification

- 157 tests, 12 consecutive clean suite runs with `node_modules` absent.
- The new repeat test **verified against the bug**, not assumed: copied into a worktree at
  unmodified `main` and caught it 8 runs in 10. An earlier attempt to verify by hand-editing
  the router was discarded — it left the `refused` flag in place, so it was not the old
  behaviour and proved nothing.

3. **Both guards hung the runner instead of failing it.** Reintroducing the deadlock to
   check the tests actually catch it made `node --test` run past five minutes with no
   verdict: `fetch` waits forever by default, so one stalled request blocks CI. A guard that
   hangs is strictly worse than one that fails — you cannot read a hang. With
   `AbortSignal.timeout(5_000)` on each request, the same experiment now **fails both tests
   in ~6s**, which is how the catch rate above was measured at all.

4. **The settle test was watching the wrong side.** It used `fetch`, which resolves as soon
   as response HEADERS arrive — so the 413 alone satisfied it while the upload was still
   draining, and the upload side is exactly where the hang lives. Rewritten on `node:http`
   as `postUntilBothSidesFinish`, resolving only once the request stream has closed AND the
   response has ended. (CodeRabbit on #30.)

5. **The settle test crashed on the teardown it exists to observe.** Past
   `MAX_DISCARD_BYTES` the server destroys the socket while 12 MB is still being written.
   Once the `ClientRequest` has emitted `close`, Node reports that write failure on the
   **socket**, where an unlistened `'error'` throws — so the test died with an uncaught
   `write ECONNRESET` on about 2 runs in 8. A no-op socket error handler fixes it; the
   outcome is already captured by the request-level handlers.

   **This was committed and pushed with a message claiming "8 consecutive clean runs".**
   The loop that produced that number reported `2 / 8` failures and I wrote the sentence
   anyway. Corrected in the following commit and on the PR. Third instance in one day of
   the same failure — a verification sentence written from intent rather than from the
   output sitting directly above it.

---

## F12 — corruption said out loud (`fix/corruption-diagnostics`)

Assessment finding F12. Every corruption path in this app degrades **quietly into less
data**, and that is the whole problem: a corrupt sidecar falls back to empty, a torn JSONL
line is skipped, a malformed deck used to vanish from its own list. Each surfaces to the
user as *fewer cards*, which is indistinguishable from having done less work. The natural
reading of a damaged file is "I have no cards yet", so the real condition is never suspected.

### What was already done, and what was not

`/api/health` has reported sidecar integrity since #18 — degraded files, unparseable JSONL
lines, stale temp files. **Nothing in the browser ever read it.** A grep of `app/web/js/`
returned zero references to `/api/health`, `integrity` or `degraded`, so in practice the
diagnostics were curl-only and the corruption stayed invisible. Diagnostics nobody is
looking at are not diagnostics.

Two gaps besides: decks are in `.learn/`, not the cockpit sidecar, so `inspectSidecars`
could not see them at all — a corrupt deck was the one corruption with **no report
anywhere** — and there was no way to check before a session without starting the server.

Not broken, and left alone: a corrupt `state.json` throws out of `readTopicState` and 500s
`/api/state`, so the UI shows its error panel. That is loud already. F12 is about silence.

### Decisions (James, this session)

- **Persistent banner on every view**, not a rail indicator. "No cards" is misleading on any
  screen, not just Today, and a quiet marker is the same failure mode the finding is about.
- **A corrupt deck is shown in Test Center**, marked and unopenable — not filtered out with
  a note elsewhere. The place you would notice it missing is the place that must say so.

### Shape

| Piece | Behaviour |
|---|---|
| `listDecks` | lists an unreadable deck with `unreadable: <parse error>` and `question_count: null` — null, not 0, because nothing is known about its contents and 0 renders as a real empty deck |
| `readDeck` | 422 with the parse error, distinct from 404 for absent. Unguarded this was a 500, which reads as the cockpit being broken rather than one file being corrupt |
| `/api/health` | adds `unreadable_decks` per topic, and counts them toward `degraded` |
| `web/js/integrity.mjs` | fetches health, prepends a banner naming each damaged file in the user's terms. Failure is silent — a diagnostic that breaks the cockpit when its own endpoint is unreachable is worse than none |
| Test Center | unreadable decks listed with no Start button; heading counts usable and damaged separately |
| Badge | counts usable decks only — an unreadable one cannot be taken, so counting it sends you to Test Center for work that is not there |
| `npm run verify` | read-only pre-session check, exit 0 clean / 1 damaged. Writes nothing: a repair tool that runs automatically is how one bad file becomes a bad backup too |

Banner copy names the file **and what it means** — "attempts.jsonl recovered from backup —
the last write before the crash is gone" is actionable in a way "status: degraded" is not.
It is prepended rather than appended, because it is a caveat about the numbers below it, and
dismissal is `sessionStorage` so a reload after a repair re-checks.

### Verification

Driven against a deliberately damaged copy of the real tree — all four conditions at once:
a truncated deck, a torn line appended to `attempts.jsonl`, a stale `.tmp` file, and a
`cards.json` replaced with garbage so it falls back to its `.bak`.

| Checked | Result |
|---|---|
| `npm run verify` on the damaged copy | all four reported, exit 1, nothing modified |
| `npm run verify` on a clean copy | "No damage found", exit 0 |
| Banner | all four named, above the numbers, on every view |
| Test Center | `Decks · 0 · 1 unreadable`, the row names the file and its parse error, no Start button |
| `GET /api/decks/:topic/:file` | 422 with the parse error |
| Dismiss | banner gone, stays gone across views for the session |
| Clean tree | **no banner on any view**, heading reads `Decks · 1`, zero console messages |

The false-positive check matters as much as the positive one: a banner that cries wolf on a
healthy tree gets dismissed reflexively, and then it is decoration.

160 tests, **0 failures in 8 consecutive runs**, `node_modules` absent.

### Deviations / scope cuts

- **A missing `cockpit/` directory is reported as fact, not damage.** It is normal for a
  topic you have not studied yet, and calling an empty tree corrupt trains you to ignore the
  output.
- **`verify` does not repair.** Read-only on purpose; see above.
- **The banner does not poll.** It checks once per render, so damage occurring mid-session
  shows on the next view change rather than instantly. Polling for a condition that only
  changes when something is already wrong is not worth a timer.

### Follow-up: two review findings on #31

Both were real, and the second was a promise made in a comment that the code never kept.

1. **`readDeck` turned a vanished deck into a corrupt one.** `existsSync` then `readFileSync`
   leaves a window: remove the file between them and `ENOENT` was caught by the corruption
   branch, reporting 422 "unreadable" for a file that was simply gone. Now it reads
   directly and treats `ENOENT` as "not in this concept directory", continuing the scan so
   the loop's own 404 stands. 422 is reserved for a file that is present and unparseable.

2. **`verify` documented exit code 2 and could never produce it.** The header said "0 clean,
   1 damaged, 2 could not check", but nothing tracked check failures — a filesystem error
   from `inspectSidecars` or `listDecks` threw, node exited 1, and **"I could not look" was
   reported as "I looked and found damage"**. That is the worse of the two mistakes a
   checker can make, because you act on it. Each check is now wrapped, failures counted
   separately, and an incomplete run exits 2 *even when damage was also found* — "some
   checks did not run" changes what the rest of the output is worth. A `state.json` I/O
   error counts as unchecked; a parse error, or a missing file for a configured topic,
   counts as damage.

`app/test/verify.test.mjs` pins the contract: exit 0 on a clean tree, 1 with a corrupt deck,
2 when a topic directory is a file (ENOTDIR — deterministic, unlike a `chmod`-based trigger
which does nothing when the suite runs as root), plus an assertion that the tree is
byte-identical afterwards, since read-only is the whole basis for pointing this at real
study data without copying it first.

The fixture builds a `state.json` for **every configured topic**, not just one — verify walks
the config rather than the directory, so a single-topic fixture would report the others as
damaged and the exit code would have been right for the wrong reason.

164 tests, 0 failures in 6 consecutive runs, `node_modules` absent.

### Follow-up 2: two more findings on #31, and a distinction that was missing everywhere

1. **The read-only test compared filenames, not bytes.** It would have passed a run that
   rewrote `state.json`, a deck's contents, or a nested sidecar while leaving every name
   intact — precisely the damage "read-only" is meant to rule out — and the notes claimed
   "byte-identical" on the strength of it. Now a recursive sha256 snapshot of every file
   before and after, so the claim and the check are the same thing.

2. **`listDecks` called every failure a parse error.** An `EACCES`, `EIO` or `EISDIR`
   arrived as `unreadable: "cannot be parsed"`, which is a **false diagnosis** — and it fed
   `verify` exit 1 ("damage found") when the honest answer was exit 2 ("I could not check").
   The same conflation I had just fixed one level up in `verify`, still present in the layer
   underneath. Deck entries now carry `unreadable_kind: 'parse' | 'io'`, `verify` counts
   them as damage and unchecked respectively, and the banner words them differently because
   they need different actions: repair the file, versus look at the disk or permissions.
   A deck that vanishes between the directory scan and the read (`ENOENT`) is now skipped
   entirely — a race, not damage.

**Deviation from the review's suggested fix, deliberately.** CodeRabbit proposed rethrowing
non-parse I/O errors out of `listDecks`. That would be correct in isolation and wrong here:
`listDecks` feeds `buildTopic` → `buildState` → `/api/state`, so one unreadable permission
bit would 500 the state route and blank the entire cockpit. Loud is the goal; a total outage
for a single bad file is not. The distinction travels as data instead, and every consumer
honours it.

Both new behaviours are pinned deterministically rather than with `chmod`, which does
nothing when the suite runs as root: a directory where a deck file should be yields `EISDIR`
from `readFileSync`, and a topic directory that is a file yields `ENOTDIR` for `state.json`.
End-to-end, an I/O-unreadable deck now produces `COULD NOT BE READ` and exit 2.

165 tests, 0 failures in 6 consecutive runs, `node_modules` absent.

## F10 live confirmation — the first real legacy `retry_only` batch (2026-07-29)

The one thing `app/test/podcastbatch.test.mjs` cannot prove: that `planRetry`'s legacy
branch reads the *live* notebook the way it reads a fixture. Firing a batch to find out is
a ~30-minute render per wrong target, so the plan was recomputed **out of process first**,
against the same live data the route would fetch, and only then was the route allowed to
act on it.

**Dry run (scratchpad script importing `listSources`/`listEpisodes`/`planRetry` directly):**

| topic | sources | targets | deletable | legacy skips |
|---|---|---|---|---|
| `ai-agent-design-patterns` | 0 | 0 | 0 | 0 |
| `practical-deep-learning-fastai` | 20 | **0** | **0** | **20** |

23 episodes in ON, **0 tagged / 23 legacy** — every row predates F10, which is exactly the
population the legacy branch exists for. Derived name for ch.1:
`fastbook 01 — Your Deep Learning Journey · sd-7aaa814b`.

**Real call** — `POST /api/on/podcast/generate-batch` with
`{topic_slug: practical-deep-learning-fastai, episode_profile: study-chapter,
speaker_profile: tech_experts, retry_only: true}`, server on a copied learn root:

```text
count: 0, skipped: 20, legacy_skips: [20 entries, each 1 episode id],
episodes: [], message: "every chapter already has audio or is still rendering —
nothing to retry"
```

Identical to the prediction, per source id. Side effects checked rather than assumed:
episodes 23 → 23, all 23 still `audio_available`, no `could not delete stale episode`
warning in the server log, and no `Starting podcast generation` line in
`docker logs --since 3m quorum-open_notebook-1` — nothing was deleted and nothing was
rendered.

So the asymmetry holds live: 20 chapters that only a **bare title** can match were
reported as skipped instead of silently regenerated, and no untagged row was deleted even
though `planRetry` had every one of them in hand.

**Caveat, stated rather than buried.** The dry run duplicates `PODCAST_RUNNING` — it is
module-private in `router.mjs`, so that one constant is a copy of the route rather than the
route itself. It could not have changed this result (nothing was mid-render; all 23 rows
carry audio), but a future dry run against a batch in flight would want it exported.
*(Closed by the next section: `dry_run: true` makes the preview go through the route, so
there is no copy left to drift.)*

The tagged path itself is still unproven end to end: no episode in ON carries an `sd-` tag
yet, so a **retry that actually regenerates** — targets non-empty, a stale tagged row
deleted first — will not be observed until the next real generation runs. What is proven
is the branch that protects the 20 already-rendered chapters from being redone.

## `dry_run` on generate-batch (`feat/generate-batch-dry-run`, 2026-07-29)

The follow-up the section above asks for. The live retry was checked by a scratchpad file
that imported `planRetry` and **re-declared `PODCAST_RUNNING`**, because that set is
module-private in `router.mjs`. So the thing consulted before a half-hour-per-target action
was a *copy* of the decision. `dry_run: true` removes the copy: preview and real run reach
`planRetry` through the same call, with the same constants and the same live data.

### Shape

`POST /api/on/podcast/generate-batch` with `dry_run: true` answers **200** with what the
same request without the flag would do. Composes with `retry_only` and works without it.

- **The early return sits above the first statement that is not read-only** — every line
  below it either deletes an episode or starts a render. That placement is the whole
  guarantee, so the delete loop moved out of the `retry_only` block to keep the ordering
  visible in one place rather than nested inside a branch (`deletable` is `[]` for a full
  batch, so the loop is a no-op there).
- **Validation happens first and identically**, so a preview that answers 200 also tells you
  the real request would not 400. Verified live: a missing `episode_profile` still 400s
  under `dry_run`, as does an unmapped topic.
- **Every count is named in the future tense** — `would_generate`, `would_delete`,
  `would_delete_episodes` — and the body carries **no `count` and no `episodes`**. The real
  batch answers 202 with exactly those two. A client reading the wrong field gets
  `undefined` rather than a plausible "0 fired, all done" while 20 renders are owed.
- **`preflight: { status: 'not_run' }`** rather than an omitted key. A pre-flight is a canary
  *render*, so a preview cannot have one, and an absent key reads as a probe that passed.
- `would_delete_episodes` carries id, name and status per row: it is the destructive half,
  and the point of a preview is to be able to disagree with it before it happens.

### Verification

`dryRunReport` is pure, so the decidable half is unit-tested — 4 new tests, 199 total, 0
failures. Checked that they bite: adding a `count` key to the report fails the
no-run-shaped-keys test, exactly the one that exists to catch it.

Driven live against the real notebook, server on a copied learn root:

| request | result |
|---|---|
| `retry_only` + `dry_run` | 200, `would_generate: 0`, `would_delete: 0`, `skipped: 20`, 20 legacy skips, no `count`/`episodes` |
| `dry_run` alone (full batch) | 200, `would_generate: 20`, `would_delete: 0`, first target `… · sd-7aaa814b` |
| `dry_run`, no `episode_profile` | 400 `episode_profile is required` |
| `dry_run`, unmapped topic | 400 `no notebook mapped for this topic` |

Row 1 reproduces the numbers the scratchpad script and the real run both produced — now
through the route's own constants, which is the entire point. Side effects after all four:
episodes 23 → 23, all still `audio_available`, no warning in the server log, 0
`Starting podcast generation` lines in the worker log.

### Deviations / scope cuts

- **No UI.** This is verification tooling for a `curl` before a real batch; the Podcast
  view's two buttons are unchanged. A "Preview" button next to "Retry failed / missing" is
  the obvious next step if previewing becomes routine rather than pre-flight.
- **`PODCAST_RUNNING` still not exported**, deliberately. With the flag there is no second
  caller needing it, and exporting it would re-open the option of computing the decision
  outside the route — the thing this replaces.
### Follow-up: the ordering guarantee IS testable (CodeRabbit on #39)

The scope cut above claimed the route's ordering could not be tested without stubbing ON's
response shapes. That conflated two different things, and the review was right to push.

The convention forbids asserting **what ON returns**. `app/test/batchegress.test.mjs`
asserts **what this app sends**: a recorder wearing ON's URLs, and every assertion is over
the request list. Being *unreachable* is ours in `degradation.test.mjs`; what we put on the
wire is ours in the same way.

- The fixture is the dangerous case, not a convenient one: one source, and an episode under
  the tagged name for that topic+source with no audio and `job_status: failed`. So the
  source is a retry target **and** the row is deletable — a dry run has something to destroy
  if the ordering is ever wrong.
- **The control test is the load-bearing half.** "No DELETE was sent" passes trivially if the
  request 400'd early or the fixture had nothing to delete, so the same fixture runs *without*
  the flag and must send both a DELETE and a generate. That is what makes the dry run's
  silence mean something.
- Checked that it bites: moving the early return below the delete loop fails
  "a dry run with a deletable target sends no DELETE and no generate", and only that test.
- `config.openNotebook.workerContainer` is cleared in the test, so the pre-flight takes its
  documented `unavailable` branch immediately. Otherwise the control run spends 12s failing
  to find a stub episode name locally and returns instantly on CI — duration and code path
  depending on whether Docker is installed, which is the environment-dependent test this
  repo keeps refusing to write.
- Still not covered, and unchanged: if ON's `/api/sources` shape drifts, the stub keeps
  feeding sources, this file keeps passing, and the real route 400s on an empty notebook
  before it reaches any of this. That stays on the manual list. The file header says so.

202 tests, 0 failures.

---

## A1 + A2 — the debrief create path finally executes (2026-07-30)

First item of `tasks/roadmap-2026-07-30.md` §6, on branch `feat/debrief-egress-test`.

`POST /api/debrief`'s create path was the one route in this repo whose happy case had
**never executed under test** — tracked as a follow-up since PR #21. Its replay branch was
driven live, `buildDebriefCards` is unit-tested, and everything in between (push a note,
draft cards, write them, append the ledger) had only ever run in James's hands. It writes a
note indistinguishable from real study data, which is exactly why nobody wanted to run it
again to check.

D1 (roadmap §1) unblocked it: PR #40 established that asserting what this app **sends** is
not asserting what a service **returns**, and that ruling now extends to ollama.

### A1 — `STUDYDECK_OLLAMA_BASE_URL`

Eleven lines in `lib/config.mjs`, mirroring `STUDYDECK_ON_BASE_URL` exactly. `chat()` reads
`config.ollama` at call time, so nothing else needed changing.

### A2 — `app/test/debriefegress.test.mjs`, 5 tests

Two recorders, one wearing ON's URLs and one wearing ollama's. The ollama stub serves a
**fence-wrapped** completion with leading commentary, because that is what the local model
actually does — a stub returning clean JSON would quietly stop exercising `extractJson`,
which is the parser the route depends on.

**The dangerous case here is concurrency, not a malformed body.** `runDebrief` is two awaits
long and writes its deduplicating ledger row LAST, so for ~15s a second request finds no
record of the first. The button is disabled; a reload or a second tab is not. `shareInFlight`
closes that window and nothing proved it did.

### Checked that they bite — three mutations, and one of them mattered more than expected

| Mutation | Result |
|---|---|
| `shareInFlight` bypassed | only "two concurrent submissions send exactly ONE note" fails |
| ledger replay lookup removed | both replay tests fail, nothing else |
| **ollama seam disabled** | two tests fail — **and one passes by hitting the real model** |

That third row is the finding. With the seam removed, "a failed note is recorded as a partial
outcome" still **passed**, in 19.9s instead of 26ms, because it reached the live ollama on
this machine and got usable cards back. A test that silently talks to a real service is the
precise false green this file exists to prevent, and on any laptop with the model running
nothing else here would have caught it. So the file now asserts both base URLs point at their
recorders before any test runs — not belt-and-braces, but the only thing standing between
this suite and an accidental live-model dependency.

(No real Open Notebook note was created at any point: `STUDYDECK_ON_BASE_URL` pointed at the
stub through every run, including the bite checks. Only ollama leaked, and only for reads.)

### Deviations / scope cuts

- **The partial-failure test covers ON failing, not ollama failing.** The card-draft failure
  path (`cards_error` on the ledger) is reachable — the stub could 500 — but the assertion
  that matters there is about `extractJson` refusing to invent cards, which `ollama.mjs`
  already owns. Not worth a fourth stub state.
- **Still not covered, unchanged:** if ON changes the shape of a created note, this file
  keeps passing and the real route breaks. The stubs must serve *something* to get the route
  as far as the code under test; no assertion rests on any of it. That gap stays on the
  manual list and the file header says so.

207 tests, 0 failures.

---

## A3 + A4 + A5 — the last two model-backed routes (2026-07-30)

Second item of `tasks/roadmap-2026-07-30.md` §6, on `feat/grade-mindmap-egress`, stacked on
the A1+A2 branch because the grade test needs its config seam.

### A3 — `gradeegress.test.mjs`, 7 tests

The two cases worth the file are the ones where the model misbehaves, because that code
carried comments and no tests:

- `clampScore` exists because "a model returning 9/5 must not corrupt the record". Nothing
  checked that it does. Both directions are now pinned — a `Math.min` alone would pass the
  high case and record a negative score.
- `gradeEssay` throws rather than guessing when the response will not parse. The half that
  matters is **not** the 502: it is that no attempt is appended. A fabricated score in
  append-only history cannot be retracted, and every derived stat reads it forever.

### A4 — `mindmapegress.test.mjs`, 5 tests

`routes.test.mjs` covers this route only with `save_note: false`, which left both claims the
route makes about the note untested: a replay must not create a second note, and a failed
push must not lose the run. The first is the one that bit before — a retried run used to
append a second run *and* create a second note, so one recall session appeared twice in the
study record. The guard was added; with notes disabled there was no note to count.

**Why a new file rather than extending `routes.test.mjs`:** that file points at no stub, so
a `save_note: true` test there would write a real note into the real notebook. The recorder
has to live somewhere that owns one.

### Checked that they bite

| Mutation | Result |
|---|---|
| `clampScore` → `Math.round` only | only "a score above the maximum is clamped" fails |
| unparseable response falls back to an invented grade | only "records NOTHING" fails |
| mindmap replay early-return removed | only "a replay pushes NO second note" fails |

### A5 — and a claim in the roadmap that was itself wrong

`CLAUDE.md`'s manual-verification bullet and `routes.test.mjs`'s header both described a gap
that no longer exists. The header also still carried the reasoning #40 disproved — that
exercising these routes meant asserting against a stub of an API we do not control. Both now
say what is actually left *and* what the recorder files do not buy: a stub still has to serve
something, so an upstream shape change leaves them green while the real route breaks.

**Correction recorded against the roadmap itself.** Row A3's verify column claimed the 503
fallback "already passes in `degradation.test.mjs` — assert they agree". It does not:
that file never covered `/api/grade`, only Open Notebook. So the 503 path was uncovered too.
It is covered now, via a stub that errors. Genuinely *unreachable* (connection refused)
remains exercised only for ON — the config is resolved once at import, so one file cannot
hold both a live recorder and a dead address.

219 tests, 0 failures.

---

## A6 — the gap a test cannot close now has an instrument (2026-07-30)

Last row of `tasks/roadmap-2026-07-30.md` §2, on `feat/on-contract-probe`.

`batchegress.test.mjs` has said it plainly since #40: if ON's `/api/sources` shape drifts,
every stub in the suite keeps feeding well-formed sources, every test keeps passing, and the
real route 400s on what looks like an empty notebook. The suite cannot catch that without
pinning a stub of an API this repo does not control — the thing the convention forbids, for
the good reason that ON's routes have already churned twice.

The roadmap offered two options: build a live pre-flight, or accept the gap and say so in one
place instead of three. **Did the first.**

### Why this is not a violation of the "no ON stubs" rule

It inverts the rule rather than breaking it. The suite must pass with Open Notebook switched
off, so it can never assert ON's shape. This is a **diagnostic whose entire success condition
is noticing that upstream changed** — the same inversion that makes `/api/on/health` answer
`200 { reachable: false }` instead of a 503, because reporting the outage *is* what that
route is for. The probe is deliberately kept out of `app/test/`, and both `oncontract.mjs`
and `batchegress.test.mjs` now say why moving it in would be wrong.

### Shape

- `app/lib/oncontract.mjs` — `inspectSourcesPayload` (pure) + `probeSources` (injected
  fetcher). Pure so the drift logic is unit-testable; the payloads in
  `oncontract.test.mjs` are **inputs to our checker**, not claims about ON, so they cannot
  go stale when ON changes.
- `fetchSourcesRaw` in `opennotebook.mjs` — the unmapped payload, for this probe only.
  Every other caller wants `listSources`; the mapping is what insulates the app from shape
  changes, so bypassing it elsewhere would reintroduce the coupling it removes. The probe
  needs the raw form precisely because it is looking *for* the change.
- `npm run verify:live` — opt-in. `npm run verify` stays local, offline and instant; a
  default that needed ON running would report an outage as an integrity failure.

### The design decision worth recording: `indeterminate`

An empty `/api/sources` list is **both** what a genuinely empty notebook returns and what
drift looks like from the outside. Reporting it as "ok" would mean a clean run could mean
"I looked and there was nothing to look at" — the exact failure `verify.mjs` already has a
third exit code for. So empty and unreachable both classify as `indeterminate` → exit 2,
never as clean. That branch was not hypothetical: it fired on the first real run.

### Driven against the real notebook

| run | result |
|---|---|
| `npm run verify` (offline) | 2 topics ok, **exit 0** |
| `npm run verify:live` | `practical-deep-learning-fastai` → ok, id and title present on every source; `ai-agent-design-patterns` → COULD NOT CHECK (notebook is empty), **exit 2** |
| `fetchSourcesRaw` forced to return a source with no `id` | SHAPE DRIFTED, names the field and the consequence, **exit 1** |

All three exit codes observed, not inferred. The `fastai` row is the first time anything in
this repo has verified Open Notebook's live response shape.

228 tests, 0 failures.

---

## C2 + C3 — the spec now describes what shipped (2026-07-30)

Third item of `tasks/roadmap-2026-07-30.md` §6, on `docs/spec-reconcile`.

### C2 — two stale markers, and why they were not cosmetic

`study-flow.md` is the most plan-shaped document in this repo, so a wrong marker produces a
wrong plan. It did, twice in one session, while assembling the roadmap itself:

| Step | Said | Reality |
|---|---|---|
| 8 — Study guide + self-explanation | 🟡 small glue work | essay grading shipped in cockpit **M7** (`views/essay.mjs` → `POST /api/grade`) |
| 9 — Flashcards on spaced repetition | 🟡→🔴 Phase-2 build | the whole review loop shipped in cockpit **M2** (`views/flashcards.mjs`, `lib/cards.mjs`) |

Both corrected, and both now name the file that implements them so the next drift is
visible. Step 8 also records a deviation from its own spec line: graded answers land as
`essay` attempts in `cockpit/attempts.jsonl`, **not** as ON notes, and the attempt log is
the authoritative one.

Claims checked against the code rather than recalled, because that is the failure being
fixed: `INTERVALS = [1, 3, 7, 14, 30]` with a miss resetting to rung 0 (`cards.mjs:17,117`),
and the three card sources really are `quiz-miss`, `walk` and `factcheck`.

**The legend now carries the rule that prevents recurrence:** a marker describes whether the
TOOL exists, never whether James has done the step — that lives only in `stages.jsonl`
(hard rule 11) — and a PR changing what the cockpit can do fixes the marker in the same PR.

### C3 — Phase 2 stays gated, and now has an instrument

D3 accepted as recommended. The recommendation needed one distinction it did not draw:

- **Item 7 (Anki/FSRS)** has a stated trigger — "if the review heuristic's ceiling is hit
  after ~2 weeks" — that has been sitting **unmeasured since 2026-07-16**. The gate could
  only ever open on a hunch. Roadmap D-c adds the lapse-rate readout that gives it a number.
- **Items 8 and 9** are convenience upgrades to steps that already work (manual invocation,
  the claude.ai voice workaround). They need no metric: they open when James is tired of the
  manual path, which is a judgment, not a measurement.

**The gate needed a contract, not just a chart** (review finding on #46, and it was right).
A readout with no threshold is the same hunch with better graphics, and a threshold chosen
after seeing the number is not a threshold at all. `roadmap-2026-07-30.md` §5 now specifies
all of it: lapse rate = lapsed ÷ mature reviews, where *mature* means the interval before
that review was ≥ 7 days (rungs 1d and 3d are still learning the card, so counting them
measures the material rather than the scheduler); denominator is reviews not cards; 14-day
rolling window; **minimum 30 mature reviews** or the rate is not reported at all; threshold
> 20% on two consecutive weekly readings. `reviews.jsonl` decides, the Stats view only
renders.

Two decisions in there are worth their own sentence. The **sample minimum** exists because
1 miss in 3 is 33% and means nothing — a gate three reviews can trip is worse than no gate.
And below that minimum the honest reading is "not enough evidence yet", a **third outcome**
that must not render as a green 0%; that is the same `indeterminate`-versus-`ok` distinction
`lib/oncontract.mjs` turns on, arrived at independently on the same day.

228 tests, 0 failures (docs-only change; the suite is a regression check, not evidence).

---

## B1 — reschedule: step_overrides finally does something (2026-07-30)

`tasks/roadmap-2026-07-30.md` §3 B1, on `feat/reschedule`. `step_overrides` had sat in
`DEFAULT_SCHEDULE` since the schedule shipped, read by nothing.

### The hazard was not the date arithmetic

Two of them, and only one was in the roadmap.

**Known: a reschedule must never become evidence.** Hard rule 11 says a stage is complete
only when an event says so, and "move this stage to next week" is the most natural-looking
way to accidentally tidy one away. The route returns the resulting stage states precisely so
a caller can see that nothing completed, and the UI copy says "Nothing is marked done — only
the dates move."

**Unknown until the code was written: an override can reorder the pipeline.** The table's
dates are monotonic by construction, and `stageStatesFor`'s "first reachable incomplete stage
is NOW" rule silently depends on that. Push `map` a week out while `walk` keeps its old date
and `walk` becomes reachable first — the cockpit would send you walking about material you
have not mapped. Nothing in the module said it relied on monotonicity; it just did.

Fixed by clamping each stage to no earlier than the one before it, so an override can move
*when* but never *what order*. The spec is explicit that order is the property that matters
("order + spacing matter, exact days don't"), so order is exactly what a reschedule must not
be able to buy. Stages dragged by the clamp report `rescheduled: true` with their original
`scheduled_date` intact — a moved date is shown as moved, never as the plan.

### Re-anchoring is the case that motivated it

Per-stage overrides are the mechanism; the actual complaint was "come back from a fortnight
away and every stage is owed at once". `reanchorOverrides` moves every **incomplete** stage
forward from a given date, preserving the spec's spacing. Completed stages are left alone —
rewriting history to tidy a schedule is how a study record stops being evidence.

### Verification — driven live against a COPY

`STUDYDECK_LEARN_ROOT=/tmp/learn`, schedule forced to `started: 2026-07-01` so the topic was
four weeks behind:

| | result |
|---|---|
| before | **8 stages owed**, `prime` NOW — the pile-up the feature exists for |
| `POST /api/schedule/reschedule {from: "2026-07-30"}` | **owed_count 8 → 1**; spacing preserved exactly (+0,+1,+2,+3,+4,+7,+10,+14,+30); every stage `rescheduled: true` with its original date still reported; **`complete: false` on all nine** |
| `stages.jsonl` afterwards | **does not exist** — a reschedule wrote no completion event |
| `{milestone_key: "map", date: "2026-09-15"}` | `walk`, `guide`, `quiz` dragged to 2026-09-15; dates monotonic — the clamp holds live, not just in unit tests |

Real `.learn/` confirmed untouched afterwards.

### Checked that the tests bite

| Mutation | Result |
|---|---|
| clamp removed | only "an override CANNOT reorder the pipeline" and the dragged-stage test fail |
| reschedule made to append a completion event | all three route-level reschedule tests fail |

### Deviations / scope cuts

- **The UI exposes re-anchoring only**, on the hero when more than one stage is owed. The
  per-stage override is a route capability without a control: moving one stage is a rarer,
  fiddlier action that wants a date picker, and shipping a half-considered one would be a
  dead affordance of the kind M1's essay toggle was rightly cut for.
- **`/api/schedule/reschedule` carries no `mutation_id`**, like `start` and `pause` and for
  rule 9's reason: it SETS a value, so a replay rewrites the identical file.
- **409 when the topic is not running.** Storing dates for a paused topic would be silently
  inert, and a control that appears to work and does nothing is worse than a refusal.

243 tests, 0 failures.

---

## B2 — preview as a mode, not two more buttons (2026-07-30)

`tasks/roadmap-2026-07-30.md` §3 B2, on `feat/batch-preview`. `dry_run` shipped in #39 with
no UI; this makes it reachable without `curl`.

### Why a checkbox and not a Preview button

The thing worth previewing is "what would **this** button do", and there are two buttons. A
Preview-generate plus a Preview-retry alongside the originals is four controls doing two
things. So preview is a mode that both buttons run through.

**The obvious objection is a mode you forget you are in — and the risk is asymmetric.**
Believing you generated when you previewed is recoverable: click again. Believing you
previewed when you generated is a half-hour render, and on the retry path it is deleted
episodes. So the mitigation points one way: the button labels change with the checkbox
("Preview: retry failed / missing"), the primary styling drops, and the result panel opens
with `PREVIEW — nothing was sent.`

### The guard that is load-bearing

A dry-run response carries **no `episodes` key at all** — confirmed live, not assumed. The
existing handler's next branch is `(!result.episodes || result.episodes.length === 0) &&
result.message`, so without an early return a preview would either report itself as
"nothing to do" or iterate `undefined`. The check reads `result.dry_run`, the **server's**
flag, rather than the checkbox: if the two ever disagree, the response is the one that
describes what actually happened.

### Rendering leads with the destructive half

`would_delete_episodes` comes first, under "this is the irreversible half". Generating
something unwanted costs render time; deleting an episode you meant to keep does not come
back, and being able to disagree with that list is the entire point of a preview.

### Verification — driven in the browser

| | result |
|---|---|
| checkbox off | labels read "Generate all chapters" / "Retry failed / missing" |
| checkbox on | labels become "Preview: …", primary styling drops |
| real preview click | one `POST /api/on/podcast/generate-batch` → 200; `PREVIEW — nothing was sent. Would generate 0 chapters, skip 20 already done, 20 untagged legacy episode(s) left alone.` — matching the `curl` numbers exactly |
| empty case | "Nothing to do — every chapter this run would touch already has audio." |
| destructive branch | the live notebook has nothing deletable, so this was exercised with a **stubbed response**: renders "Would DELETE 1 episode first — this is the irreversible half" above the generate list |

Server ran on a copy (`STUDYDECK_LEARN_ROOT=/tmp/learn`); real `.learn/` confirmed untouched.

### Deviations / scope cuts

- **No automated test for the rendering.** `app/web/` has no DOM in the test environment
  (zero dependencies, no jsdom) and adding one would argue against hard rule 5. What the
  route sends is already pinned by `batchegress.test.mjs`; what the view draws is verified
  by driving it, which is this repo's stated convention for cockpit changes.
- **The destructive branch was not seen against real data**, only a stubbed response. Said
  plainly because "verified in the browser" would otherwise overstate it.

255 tests, 0 failures (unchanged — this is view code).

---

## D-c — the FSRS gate becomes measurable (2026-07-30)

`tasks/roadmap-2026-07-30.md` §5 D-c, on `feat/lapse-rate`. Implements the contract written
in that file *before* the data existed — a threshold chosen after seeing the number is not
a threshold.

`app/lib/lapse.mjs` (pure), surfaced per topic on `/api/state`, rendered by a Stats card.

### The measurement is narrower than "how often do I miss cards", on purpose

Missing a card at its 1-day or 3-day rung says something about **the material**. Missing one
that had survived to a ≥7-day interval says something about **the scheduler** — which is the
only thing FSRS would replace. So only mature reviews count, and a card's first review never
does: that is exposure, not retention.

### Two subtleties that would each have made the number lie

- **The window bounds what is COUNTED, not what decides maturity.** A card's rung comes from
  reviews that may predate the 14-day window entirely. Filtering to the window *before*
  computing maturity would make every card look young, drop the mature reviews to near zero,
  and report a failing scheduler as a healthy one. Pinned by its own test.
- **`insufficient` is a third outcome, not a degraded pass.** Below 30 mature reviews the
  rate is not shown at all. A green 0% on four reviews is the same lie as `verify:live`
  calling an empty notebook clean — "I looked and there was nothing to look at", presented
  as a result. This is the second time that exact distinction has been the load-bearing
  design decision in one day.

### Verification — driven end to end, all three states

| state | how | result |
|---|---|---|
| `insufficient` | real data | `Not enough evidence yet · 0/30`, with "30 more to go … deliberately blank rather than showing a percentage that would be noise" |
| `ceiling` | 40 cards seeded into a COPY with two hits then a third review, 12 of them misses | `/api/state` → `{"status":"ceiling","rate":0.3,"mature_reviews":40,"lapses":12}`; Stats renders "Ceiling reached — the heuristic is losing mature cards · 30%" plus the two-consecutive-readings rule |
| `holding` | unit test at exactly 20% | does NOT trip — the contract says `> 20%`, and a boundary that drifts by one review is how a written threshold stops being one |

Seeded against `STUDYDECK_LEARN_ROOT=/tmp/learn`; real `.learn/` confirmed untouched.

### Deviations / scope cuts

- **`lapseRate` takes reviews only, not cards.** It was written as `(cards, reviews, …)` and
  the body never used `cards` — maturity is decided entirely by a card's own review history.
  Removed rather than left, since a parameter implies a dependency that does not exist.
- **No weekly-reading history.** The contract's decision rule is "two consecutive weekly
  readings above the threshold", and nothing stores past readings — the card states the rule
  and James applies it. Storing a weekly series is its own slice and is not needed until the
  first reading actually crosses.

267 tests, 0 failures.

---

## M4.6 — Practice evidence, teach-back, and ordered stage handoffs (2026-08-14)

Shipped the behavior needed before the real fast.ai pilot; this is not the pilot itself.

### Durable evidence boundaries

- Practice Lab remains an external concept-specific handoff (for example,
  `/learn-practice fastai-learning-method`). It indexes existing
  artifacts, records learner-confirmed evidence in `cockpit/practice.jsonl`, and never
  creates exercise files, executes a command, writes `state.json`, or marks a stage done.
  Answer-bearing artifacts remain unavailable until an explicit committed reveal event.
- Teachback is a new focused surface and `cockpit/teachbacks.jsonl` ledger. Each append is
  replay-safe by `mutation_id` and records audience, inert artifact reference, questions,
  gaps or explicit no-gap result, reflection, resulting action, ownership, AI contribution,
  and rubric/source-reference provenance. It does not create cards, mutate mastery, or append a stage event.
- A qualifying teach-back is deliberately narrower than a recorded presentation: its rubric
  must have been predeclared, it needs an observable explanation/result, a question, artifact
  support, and learner-owned material. Otherwise it remains honest activity history and
  requires a typed, concrete return target: `source:<id>`, `criterion:<detail>`,
  `concept:<known-concept>`, or `/learn-practice <known-concept>`.

### Today contract

`MILESTONES` now carries explicit `primary_action` and optional ordered
`secondary_action` metadata: concrete view id, learner label, estimated duration, why now,
and return path. Today renders that contract directly. In particular:

| day | primary | required continuation |
|---:|---|---|
| 4 | Test Center essays | Practice Lab build handoff |
| 7 | Flashcards | full quiz in Test Center |
| 10 | Teachback | — |
| 14 | Flashcards | re-present in Teachback |
| 30 | final Flashcards | teach-for-real in Teachback |

The former `#practice` hash remains an alias; the functional route and schedule destination
are now `#lab`. Observed practice and teach-back counts appear beside stages only. They do
not influence `stages.jsonl` folding, stage state, or mastery.

### Verification

- Failure-first tests established the missing action metadata, absent teach-back route, and
  absent replay-safe sidecar exports before implementation.
- Focused route, sidecar, schedule, stage, and evidence tests pass, including a replay,
  generic-remediation rejection, no state mutation, and no stage-event append.
- `npm test`: **358 passing**. `npm run verify` and the gitleaks/binary/large-file
  self-checks also pass.
- Drove the append path against a disposable copied learning root: first qualifying
  Teachback append, 200 replay with no second line, state payload carrying the last record,
  byte-identical `state.json`, and no `stages.jsonl` creation. The copied root was removed.
- Started the local server and loaded the shell plus `main.mjs`; it exposes `#lab` and
  `#teachback`. Full visual acceptance remains correctly deferred to M5 after the real pilot.
