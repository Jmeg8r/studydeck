# StudyDeck — Study Cockpit Implementation Plan

> **Status: APPROVED and IMPLEMENTED (M0–M7), 2026-07-19.**
> This file is kept as the record of what was *approved* — it is deliberately not
> rewritten to match what shipped. For what actually got built, where it diverged, and
> why, read **`tasks/implementation-notes.md`**, which numbers every deviation. Where
> the two disagree, the notes are authoritative. The build order below ("M0+M1 = first
> PR") was superseded: all eight slices shipped together in one PR.

**Status:** Draft for James's approval *(historical — see the banner above)*
**Date:** 2026-07-18
**Decisions already locked (via design review):** local app in this repo · Command Rail
design (variant C) with Observatory full-wheel view (A graft) + twin-theme tokens
(D graft) · local gemma grading · sidecar data files, never learn-anything's schema.
**Design artifacts:** `~/.gstack/projects/Jmeg8r-studydeck/designs/study-cockpit-20260718/`
(variant-C.html = shell reference; approved.json)

Ordered by likelihood of change: data model first, mechanical last.

---

## 1. Data model (review this hardest — everything else hangs off it)

**Rule zero:** learn-anything's files (`state.json`, `knowledge-map.md`, quiz decks)
keep their exact upstream schema — their validators reject unknown fields, and
`learn-anything-cli update` must never break us. All cockpit data lives beside them:

```text
.learn/topics/<topic-slug>/cockpit/
  schedule.json     # {"version":1,"started":"2026-07-18","step_overrides":{},"paused":false}
  attempts.jsonl    # append-only, one per graded event:
                    # {"ts","kind":"quiz|flashcard|essay|factcheck","concept_slug",
                    #  "deck_file?","score","max","misses":["item-id"...],"notes?"}
  cards.json        # flashcards: [{"id","front","back","concept_slug",
                    #  "source":"quiz-miss|walk|factcheck|glossary","created","suspended?"}]
  reviews.jsonl     # {"ts","card_id","result":"hit|miss"}
```

- **Derived, never stored:** Today's action, due cards, intervals, weakness index,
  score history. Computed server-side from sidecars + state.json + the spec's
  schedule table (`tasks/study-flow.md`). One source of truth per fact.
- **Interval logic v1:** the spec's expanding table (1→3→7→14→30) with error-routing
  (miss resets a concept's next review to +1d). Explicitly NOT FSRS — that stays
  Phase 2 (Anki exporter) per the spec.
- **state.json writes:** in-app quiz completion applies the same update table the
  skills use (confidence cap 1.0, practice_count, status transitions) then runs
  render.mjs. Single-writer convention: don't run an in-app quiz and a Claude-session
  quiz simultaneously (solo user; documented, not enforced).
- **Committed to git:** yes — sidecars are learning artifacts, same policy as `.learn/`.
- `app/cockpit.config.json` (committed, no secrets): ports, topic list, ollama model,
  ON base URL. ON password is read server-side from `~/Projects/quorum/.env` at boot.

## 2. Server contract (`app/server.mjs` — Node 20+, zero dependencies)

Zero-dep matches this repo's from-scratch ethos; everything below is stdlib http.
Binds 127.0.0.1 only. No auth, no cloud, no telemetry.

| Route | Does |
|---|---|
| `GET /api/state` | merged: topics + concepts + sidecars + derived (today, due, stats) |
| `POST /api/attempts` | append attempts.jsonl; apply state-update table + render.mjs; auto-queue cards from misses |
| `POST /api/cards` · `POST /api/reviews` | card create (manual or from miss/debrief) · review log |
| `GET /api/decks` · `GET /api/decks/:file` | list decks · deck **without answers** |
| `POST /api/decks/:file/grade` | server grades exact/accepted (answers never reach the browser pre-submit — pretest-safe); ai_only items routed to grader |
| `POST /api/grade` | essay/error-correction → local ollama gemma with rubric prompt → {score, feedback}; 503 + "grade in a Claude session" fallback when ollama is down |
| `GET /api/on/*` proxy | podcasts list/audio stream, sources (reading), notes CRUD, Ask — bearer added server-side |
| `POST /api/debrief` | walk capture-back text → ON note + cards (error-routing rule) |
| `GET /` static | serves `app/web/` |

## 3. Frontend (`app/web/` — vanilla ES modules, no build step)

No React/Vite/toolchain: hackable single files, instant reload, matches repo ethos,
and the comps already prove the SVG patterns. Design system from the comps:

- `tokens.css` — variant-D twin-theme tokens (`.light`/`.dark` on `<html>`, toggle
  persisted); Command Rail palette (slate `#232732`, amber `#F0A840`, coral, teal).
- Shell = variant C: left rail (9 items + badges), crumb, Today hero + START,
  schedule strip, queue, wheel widget.
- `wheel.mjs` — the shared radial component (from comps); compact widget in shell;
  **click → full-screen Observatory view** (variant-A drama: navy field, guide rings,
  degree ticks) — the A graft.
- Views (one ESM file each): today, podcast, reading, mindmap, factcheck, flashcards,
  testcenter, stats, videos.

## 4. Build order — vertical slices, each independently usable

| # | Slice | Verify |
|---|---|---|
| M0 | Server + `/api/state` + shell (rail, Today, schedule strip, wheel widget, theme toggle) | open localhost, real state renders: 49 concepts, amber cell, Day-N correct from schedule.json |
| M1 | Test Center: deck runner (server-graded), attempts recorded, score chart w/ pretest baseline; study-guide/essay toggle stub | retake Your-First-Model deck in-app → attempts.jsonl row; state.json diff identical to manual flow; render.mjs passes; answers absent from network payload pre-submit |
| M2 | Flashcards: auto-queue from misses, review session, due/interval logic, **weak-cards-only filter** | 3 pretest-miss cards appear due day 7; miss → resets to +1d; filter shows only miss-rate>0 |
| M3 | Stats: attempts history, weakness heatmap by domain, full-screen Observatory wheel | numbers reconcile 1:1 with attempts.jsonl by hand-count |
| M4 | Reading Room: ON source markdown, reading position, highlights → ON notes | fastbook ch.1 renders; highlight round-trips to ON note via proxy |
| M5 | Podcast player (ON proxy; "configure TTS" empty state until key added) + Video shelf (docs/*.mp4) | tutorial video plays; podcast list shows profiles; empty-state honest |
| M6 | Mind Map studio (sketch upload + generated map + diff notes→ON) & Fact-Check mode (claims from study_guide transformation → mark ✓/✗ → reveal → misses→cards) | one fact-check run creates cards from wrong marks |
| M7 | Essay grading live (ollama rubric), walk-debrief capture box | graded essay lands in attempts.jsonl with feedback; debrief → ON note + cards |

M0+M1 = first PR (usable core). M2+M3 second. M4-M7 third. CodeRabbit triage each.

## 5. Process

- Branch `feat/study-cockpit` → the queued **gstack routing rules → CLAUDE.md** commit
  rides on this branch first.
- Implementation in a **fresh session** per the handoff rule, carrying: this plan,
  `tasks/study-flow.md`, variant-C.html + approved.json, and the memory entries.
- `implementation-notes.md` in `tasks/` during build (decisions + Deviations).
- Verify before each PR: the table above + `/learn:status` still works (no upstream
  breakage) + snyk/npm audit shows no NEW findings (the app adds zero dependencies —
  that's the point). **Not the same as a clean repo audit:** the pre-existing
  `node-llama-cpp`/`openai` tree carries vulnerabilities (35 per GitHub's Dependabot at
  time of writing). "The app adds nothing" and "the repository is clean" are different
  claims and the verification must not conflate them.

## 6. Risks & mitigations

- **ON API churn** (SurrealDB v3 on roadmap): all ON calls behind the one proxy
  module; version-check `/api/config` at boot and surface mismatch in UI footer.
- **Concurrent state.json writers** (app + Claude session): single-writer convention
  + attempts.jsonl is append-only so nothing is ever lost; render.mjs validates after
  every write.
- **Ollama down / model cold:** grade endpoints degrade to "queue for Claude session"
  instead of failing the quiz flow.
- **Podcast audio still blocked** — M5 ships with an honest empty state either way.
  Verified 2026-07-19: the blocker is that Open Notebook has **no `text_to_speech` model
  registered** (`GET /api/models?type=text_to_speech` returns 0). Adding a provider key
  alone does not clear it; a TTS model must then be registered against that provider.

## 7. Explicitly not building

Auth/multi-user (127.0.0.1 only) · cloud/deploy · mobile app (responsive is enough)
· FSRS scheduling (Phase 2 Anki export) · replacing learn-anything's CLI dashboard
(it keeps working untouched) · presentation mode (Phase 2, after M7).
