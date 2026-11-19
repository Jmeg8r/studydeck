# Study Flow — Memory-Based Learning Pipeline

**Status:** Draft v1 (for James's review)
**Date:** 2026-07-16
**Owner:** James Cruce
**Purpose:** Self-contained spec for the personal study system. A fresh Claude session
should be able to implement any phase from this document alone.

---

## What this is

A study pipeline of 14 named stages — James's original flow (steps 1–11, which
included both 4 and 4b) plus two added in design review (Step 0 pretest, Step 8b
build) — grounded in memory science, assembled from tools James already runs. One pass through the pipeline
takes one **topic** from first exposure to durable, teachable knowledge over ~30 days.

**WHY each principle is in the design:**

| Principle | Where it shows up |
|---|---|
| Pretesting effect (failing first improves encoding) | Step 0 |
| Priming / advance organizers (brief, structural pre-exposure) | Steps 2–3 |
| Dual coding (verbal + visual channels) | Steps 3, 4, 4b |
| Generation & verification beat re-reading | Steps 4 (draw-then-diff), 4b (fact-check) |
| Elaborative interrogation ("keep asking why") | Step 7 |
| Self-explanation | Step 8 |
| Production/transfer (procedural ≠ declarative memory) | Step 8b |
| Retrieval practice (highest-utility technique known) | Steps 0, 9, 10, 11 |
| Spaced repetition on expanding intervals | The schedule, not a step |
| Protégé effect / Feynman | Step 11 |
| Consolidation (sleep, exercise) | Schedule notes |

**Anti-goals:** No double-tracking. This system owns *curriculum + retention state*.
`learnings/` keeps owning solved-problem approaches; brain-capture keeps owning
session memory; SecondBrain/qmd keeps owning long-term reference.

---

## Decisions to confirm first (most likely to change the design)

1. **Where flashcards live long-term.** Start: learn-anything quiz decks + its
   review heuristic. Upgrade path: Anki export for true FSRS scheduling (Phase 2).
   → Affects exporter design; decide after ~2 weeks of real use.
2. **Voice surface for Step 7.** Now: claude.ai Project + mobile voice mode.
   Later: ElevenLabs conversational agent on Open Notebook's Ask API (Phase 2).
3. **Commit `.learn/` in this repo?** Recommended YES for studydeck
   (learning artifacts are first-class content here; also ASTGL raw material).
4. **Podcast episode profiles.** Two profiles must exist in Open Notebook:
   `study-overview` (~10 min, 2 speakers, structural) and `study-deep-dive`
   (30–45 min, walking-paced, assumes the deep read is done). Created in Phase 0.

---

## The pipeline

Legend: 🟢 = tool exists today · 🟡 = small glue/template work · 🔴 = Phase-2 build
Every step marked **ACTIVE** requires James to produce or verify something —
passive steps are deliberately in the minority.

> **Markers reconciled against what shipped, 2026-07-30.** They had gone stale, and that is
> not cosmetic: this is the most plan-shaped document in the repo, so a wrong marker
> produces a wrong plan. Two readings of "what's left" in one session were wrong because
> Step 8 still said 🟡 (essay grading shipped in cockpit M7) and Step 9 said 🟡→🔴 (the whole
> review loop shipped in M2). **A marker describes whether the TOOL exists — never whether
> James has done the step.** What is built lives in `tasks/implementation-notes.md`; whether
> a stage is *done* is derived by **folding the append-only events** in
> `cockpit/stages.jsonl` — latest event per stage wins, so an `undo` reopens one (hard rule
> 11, `lib/stages.mjs`). It is never read as a value straight off the file. If you change
> what the cockpit can do, fix the marker in the same PR.

### Step 0 — Pretest (ACTIVE) 🟢
Take a short diagnostic quiz on the topic *before any exposure*. Expect to fail;
that's the point (pretesting effect primes encoding).
**Tool:** learn-anything `/learn:quiz` on the freshly seeded topic (works even at
confidence 0). **Output:** baseline scores in `.learn/` state.

### Step 1 — Sources, curated by James (ACTIVE) 🟢
James selects all material — papers, docs, YouTube, lectures. Nothing auto-ingested.
**Tool:** StudyDeck Sources / Reading Room searches the internet and locally ranks
retrieved excerpts. Review recommendations and caveats, choose **Use this source**,
then **Add to notebook**. Links and pasted text can also be entered directly. Search
shows an activity indicator and elapsed time; it does not import results automatically.
Use Open Notebook per topic
(localhost:8502 UI / :5055 API) for PDFs and other file uploads.
Google Docs/Slides arrive via Drive MCP → ON. **Output:** populated notebook.

### Step 2 — Priming audio overview (passive, by design) 🟢
Short structural overview: the map, not the territory. Listen once.
**Tool:** ON podcast, `study-overview` episode profile. **Guardrail:** priming is ONE
brief pass. Do not loop it — familiarity here is not knowledge yet.

### Step 3 — Video overview with narrated slides (passive) 🟡
Optional second priming channel (visual). Skippable when time-constrained;
it's the most expensive priming artifact for the least marginal gain.
**Tool:** Videos → Generate local video uses local notebook excerpts, Gemma, Kokoro,
and FFmpeg for a short narrated slide overview. See
`tasks/video-overview-plan-2026-09-22.md` for the implemented limits and the
implemented Higgsfield storyboard handoff. **Prepare storyboard** creates a local,
editable prompt; James reviews and copies it to Higgsfield, then saves the downloaded
MP4 using the notebook filename shown in StudyDeck. Paid submission is still manual.
See [Sources and media](../docs/sources-and-media.md) for the user workflow.

### Step 5 — Deep study (ACTIVE) 🟢
Full reading of sources, lectures watched properly, annotations captured.
**Tool:** the sources themselves; annotations saved as ON notes.
**Schedule note:** deep-study sessions go in the evening — consolidation
happens during sleep.

### Step 4 — Mind map, retrieval-first (ACTIVE) 🟢
*Moved to after deep study (design-review change).* James sketches the concept
map **from memory first**, then Claude renders the "true" map from ON notes and
diffs the two. Gaps in James's sketch = tomorrow's study targets.
**Tool:** paper/excalidraw sketch → Claude mermaid-mindmap artifact + diff
commentary. **Output:** both maps saved to ON as notes.

### Step 4b — Infographic + fact-check (ACTIVE) 🟢
Claude generates an infographic of the material; James verifies every claim on
it against the sources. Deliberate: verification is the active ingredient.
**Rule:** any AI error found becomes (a) a corrected ON note and (b) a flashcard —
caught errors make the strongest cards.
**Tool:** canvas-design / artifact from ON notes.

### Step 6 — Deep-dive walking audio (passive + consolidation) 🟢
Long-form discussion podcast, listened to while walking ("Relaxed Learning mode" —
exercise aids consolidation; diffuse-mode processing).
**Tool:** ON podcast, `study-deep-dive` episode profile.

### Step 7 — Interactive voice Q&A (ACTIVE) 🔴→🟢 workaround
Meaningful spoken discussion with the material; James keeps asking "why"
(elaborative interrogation). Ideally same walk as Step 6 or the day after.
**Tool now:** claude.ai Project holding the topic's sources + mobile voice mode.
**Text alternative in the cockpit (added 2026-10-11):** Roles → Socratic questioner
(`#roles`) asks the "why" questions in writing, grounded in the topic's source excerpts, and
turns stumbles into cards you write yourself. It does not replace the spoken walk: voice
stays the step as designed, and the voice agent below stays gated. A session is activity
evidence only — it never completes this stage or changes mastery.
**Tool later (Phase 2):** ElevenLabs conversational agent wired to ON Ask API.
**Capture-back rule (mandatory):** end every session with "summarize what I got
wrong or fuzzy" → save the summary as an ON note → misconceptions become flashcards.

### Step 8 — Study guide + self-explanation (ACTIVE) 🟢 *(was 🟡 — corrected 2026-07-30)*
Generate a study-guide report: short-answer questions, essay questions, glossary
of key terms. James writes the answers; the **local model** grades them against a rubric
drawn from sources. Claude is the *fallback*, not the grader — when the local model is
unreachable the route returns 503 saying so, and grading moves to a Claude session.
(This line said "Claude grades essays" until 2026-07-30, which described the plan rather
than the shipped flow.)
**Tool:** ON Transformation (`study-guide` Jinja template — written in Phase 0) + the
cockpit's Test Center, which grades essays on the local model via `POST /api/grade`
(`app/web/js/views/essay.mjs`, shipped in cockpit M7). **Output:** graded answers recorded
as `essay` attempts in `cockpit/attempts.jsonl`, not as ON notes — a deviation from the
line above, and the attempt log is the authoritative one.
A cold local model degrades to 503 with "grade this in a Claude session", so the step is
never blocked.

### Step 8b — Build it (ACTIVE) 🟢 *(added in design review)*
The transfer step: implement the concept yourself, as a `/learn-practice` exercise.
Explaining ReAct and implementing ReAct are different memories; this flow trains both.
**Tool:** learn-anything practice mode.
**Cockpit handoff:** Practice Lab shows the exact `/learn-practice <concept>` invocation
for Project or Chat Mode, but does not run it or create files. It indexes the resulting
topic-owned artifacts and records learner-confirmed evidence (rubric, observable result,
reflection, next action, ownership, AI contribution and hint use) in its sidecar. Those
records inform resumption only: they never directly update mastery or complete a schedule
stage. A solution or answer-bearing hint remains locked until an explicit recorded reveal;
revealed or agent-generated work cannot be represented as independent near-transfer evidence.
**Schedule handoff:** on the study-guide day, Today keeps Test Center first and then exposes
Practice Lab (`#lab`) as the explicit Step 8b continuation; it never substitutes a generic
Start destination or treats the artifact record as a completed stage.

> *Amended 2026-07-27 (rename to `studydeck`).* This step originally said "the next
> numbered example in `ai-agents-from-scratch`", which assumed the example course that
> used to sit in this repo. That course has been removed, so the numbered-example target
> no longer exists. The transfer step itself is unchanged in intent — only its
> destination is now practice mode. If a per-topic scratch area for transfer work is
> wanted, that's an open design question, not something this rename decided.

### Step 9 — Flashcards on spaced repetition (ACTIVE) 🟢 *(was 🟡→🔴 — corrected 2026-07-30)*
Cards generated from: quiz misses, Q&A misconceptions, infographic errors,
glossary terms. Reviewed on the expanding-interval schedule below.
**Tool:** the cockpit's Flashcards view (`app/web/js/views/flashcards.mjs`, cockpit M2).
Cards auto-queue from quiz misses, walk debriefs and fact-check errors; the expanding
interval table below is implemented in `app/lib/cards.mjs`, with a miss resetting a
concept to +1d. Reviews append to `cockpit/reviews.jsonl`.
**Tool later (Phase 2, gated on proven need — see D3 below):** deck → Anki exporter for
FSRS-grade scheduling. That upgrade is still unbuilt and deliberately so; the marker above
describes the heuristic that exists, not the one that might replace it.

### Step 10 — Full quiz (ACTIVE) 🟢
Comprehensive graded quiz across the whole topic; updates mastery state.
**Tool:** `/learn:quiz` (persisted deck, re-practicable in dashboard).

### Step 11 — Present and teach (ACTIVE) 🟢
Slide deck generated → James presents it aloud, explaining everything, to a
person or to Claude-as-naive-audience (which asks follow-up questions).
Re-present on the spaced schedule — NOT repeatedly in one sitting (massed
practice produces fluency that decays).
**Terminal form:** an ASTGL article/video — teaching readers IS the Feynman step.
**Tool:** pptx/Canva skills; presentation notes → ON.
**Cockpit handoff:** Teachback (`#teachback`) records the intended audience, an inert
artifact reference, questions received or anticipated, gaps (or an explicit no-gap result),
reflection, resulting card/practice actions, learner ownership, AI contribution, and rubric
plus source/reference provenance. A presentation merely recorded as having happened is activity evidence. A
qualifying teach-back additionally needs a rubric predeclared before the explanation plus
an observable explanation/result and artifact/question support. Neither kind changes mastery
or completes a stage. Weak teach-backs name a specific source, criterion, concept, or
`/learn-practice` return path — never only “re-read” or “try again”.

---

## The schedule (the part that makes it memory-based)

One topic instance, expanding intervals. Slippage is fine; *order + spacing* matter,
exact days don't.

| Day | Steps |
|---|---|
| 0 | 0 pretest → 1 sources → 2 priming audio (→ 3 video, optional) |
| 1 | 5 deep study, session 1 (evening) |
| 2 | 5 deep study, session 2 → 4 mind map (sketch → diff) → 4b infographic fact-check |
| 3 | 6 walking deep-dive → 7 voice Q&A (first big retrieval) |
| 4–5 | 8 study guide + essays → 8b build |
| 7 | 9 flashcards session → 10 full quiz |
| 10 | 11 presentation v1 |
| 14 | 9 flashcard review → 11 re-present (from memory, slides as prompt only) |
| 30 | final flashcard review → 11 teach-for-real (ASTGL artifact) |

**Cockpit action order:** Today exposes one primary action with a reason, estimate, and
return path. Composite days retain their required continuation: day 4 Test Center → Practice
Lab; day 7 Flashcards → Test Center; day 14 Flashcards → Teachback; day 30 Flashcards →
Teachback. Day 10 opens Teachback directly rather than a passive Stats destination. These
handoffs are schedule instructions, not evidence that their action or stage occurred.

**Interleaving rule:** once ≥2 topics are in flight, flashcard/review sessions mix
topics rather than blocking one.

## Error routing (what happens on a miss)

- Quiz/flashcard miss → concept marked `needs_practice` in learn-anything →
  targeted `/learn:explain` re-study next day → interval resets short (1–2 days).
- Infographic fact-check catches an AI error → correct ON note + new flashcard.
- Voice Q&A stumble → capture-back note in ON + new flashcard.
- Essay grade weak → that section re-enters Step 5 (re-read), not just re-quiz.
- Hits → interval expands (next row of the schedule).

---

## Implementation plan

### Phase 0 — foundations (no new software)
1. Branch in this repo → `npx learn-anything-cli init --tools claude --context7` → commit
   `.learn/` scaffolding → verify: `/learn:topic "AI agent design patterns"`
   produces a knowledge map James would trust; pretest quiz runs.
2. Update Open Notebook v1.10.0 → v1.13.0 (glue targets current API) →
   verify: `curl localhost:5055/health` + version endpoint shows 1.13.x, existing
   notebooks intact.
3. Create ON `study-overview` + `study-deep-dive` podcast episode profiles →
   verify: one test episode each from a small notebook.
4. Write the `study-guide` transformation (Jinja) in ON → verify: run on a test
   source; output has short-answer, essay, glossary sections.
5. Document the Step-7 voice protocol (claude.ai Project setup + capture-back
   prompt) as a checklist in this file → verify: one real walk session round-trips
   a misconception into an ON note.

### Phase 1 — the glue skill — **SUPERSEDED 2026-07-30, never built**

> **`/study-pack` was superseded by the study cockpit and will not be built.** The cockpit
> (`app/`, shipped M0–M7 in PR #4 and extended since) does everything item 6 below listed
> except one thing: seeding a learn-anything topic from an Open Notebook notebook. That
> half has no substitute, and it stays **manual** — new topics are created with
> `/learn:topic` by hand.
>
> **Why manual is the decision rather than the fallback:** two topics have been seeded that
> way with no friction, so the need an automated seeder would answer is unproven. That is
> the same test Phase 2 below applies to itself. If a third topic makes it tedious, build
> the seeding half only (`tasks/roadmap-2026-07-30.md` §1/D2, option b) — not the rest of
> item 6, which would duplicate shipped cockpit code.
>
> **What happened to the two API findings** recorded under *Phase 0 — execution log* as
> things "Phase 1 must do". They did not have the same fate, and the difference matters:
> - **Bearer auth on ON data endpoints — carried over.** `app/lib/opennotebook.mjs` sends
>   `Authorization: Bearer` on every call (three sites), because the cockpit inherited the
>   requests `/study-pack` would have made.
> - **`POST /api/chat/context` — dropped, not carried.** Nothing in `app/` calls it
>   (verified 2026-07-30: no match for `chat/context` anywhere under `app/`). It existed to
>   seed ON's chat from a notebook, which is the one capability that died with this item and
>   which the cockpit never replaced. If a future seeder is built per option (b), this is
>   the endpoint it needs, and the note upstream removed `POST /api/notebooks/{id}/context`
>   still applies.

6. ~~`/study-pack <notebook>` skill in `~/.claude/skills/study-pack/`:
   ON REST API → seed/update learn-anything topic → generate quiz deck →
   mind-map artifact → trigger podcast profiles. One command = NotebookLM's
   one-click, plus progress state NotebookLM doesn't have.~~
   *(Historical — kept so the supersession above has something to point at.)*

### Phase 2 — earned upgrades (build only when the need is proven in use)

> **Confirmed 2026-07-30 (roadmap D3): these stay gated, and the gate is being made
> observable.** Scheduling them would contradict the rule that has kept this repo from
> accumulating half-built features — the cockpit shipped M0–M7 without one.
>
> The problem was never the rule, it was that "proven in use" had no instrument. Item 7's
> own trigger — "if the review heuristic's ceiling is hit after ~2 weeks" — has been sitting
> unmeasured since 2026-07-16, so the gate could only ever open on a hunch. Roadmap §5 D-c
> adds a lapse-rate readout to the Stats view: a number that would actually tell you the
> heuristic is failing. Until it moves, Phase 2 stays shut on evidence rather than on mood.
>
> Items 8 and 9 have no equivalent instrument and do not need one — they are convenience
> upgrades to steps that work today via manual invocation and the claude.ai workaround.
> They open when James is tired of the manual path, which is a judgment he can make without
> a metric.

7. Anki/FSRS exporter (if the review heuristic's ceiling is hit after ~2 weeks).
8. Automated Higgsfield submission and result retrieval. Local storyboard preparation,
   editable handoff, and filename-based manual import are implemented; paid generation
   still happens outside StudyDeck.
9. ElevenLabs voice agent on ON Ask API (replaces the claude.ai workaround).

---

## Appendix A — Step-7 voice protocol (claude.ai Project + mobile voice)

Setup, once per topic:
1. Create a claude.ai Project named `Study: <topic>`.
2. Upload the topic's key sources (or the ON study-guide + session notes — smaller,
   already distilled).
3. Set project instructions:
   > You are my study discussion partner. I have read the material. Ask me probing
   > "why" questions, challenge my explanations, and correct me immediately when I'm
   > wrong — accuracy first. Keep answers short and conversational; this is a spoken
   > discussion while I walk.

Per walk:
1. Listen to the `study-deep-dive` episode (Step 6), then open the project in the
   mobile app → voice mode.
2. Discuss; keep asking "why" until the chain bottoms out.
3. **Capture-back (mandatory, end of walk):** say —
   > "Summarize this discussion: list every point I got wrong, fuzzy, or asked to
   > have re-explained, as bullet points."
4. At the desk: paste that summary into the topic's ON notebook as a note titled
   `Walk debrief YYYY-MM-DD`; misconceptions become flashcards (error-routing rule).

Verify (James, first real walk): one misconception round-trips walk → note → flashcard.

---

## Phase 0 — execution log (2026-07-16)

Executed by Claude on branch `feat/study-flow-phase-0`.

| Item | Result |
|---|---|
| learn-anything init (`--tools claude --context7`) | ✅ 6 skills + 6 commands generated (v1.6.1) |
| Topic + knowledge map | ✅ `ai-agent-design-patterns`: 6 domains / 25 concepts, schema-validated; examples 04 and 07–15 referenced as details where they map to design-pattern concepts (01–03, 05–06 are onboarding/basics — intentionally unmapped). **Judged 2026-07-30 — see the Phase 0 gate note below. This topic is NOT the one that passed.** |
| Open Notebook v1.10.0 → v1.13.0 | ✅ Backup at `~/Projects/quorum/backups/pre-v1.13-20260716-2155.tar.gz`; migrations 17–22 clean; both ATAL notebooks intact |
| Episode profiles | ✅ `study-overview` (4 segments, priming briefing) + `study-deep-dive` (8 segments, walking briefing), both on `tech_experts` speakers + local gemma4 |
| study_guide transformation | ✅ Created + verified on example-10 CONCEPT.md via local gemma4 — all 3 sections, strong "why/how" questions |
| Voice protocol | ✅ Documented (Appendix A); real-walk verify pending James |

**Deviations & findings:**
- ON v1.13 API now requires `Authorization: Bearer $OPEN_NOTEBOOK_PASSWORD` on data
  endpoints (was open on v1.10 for /api/config). `/study-pack` (Phase 1) must send it.
- `POST /api/notebooks/{id}/context` was removed upstream; Phase 1 must use
  `POST /api/chat/context`.
- **Action (James):** ON model registry has no TTS model, so podcast *audio* can't
  render in-app yet — add ElevenLabs (or other TTS) key in ON Settings → Providers.
  Same visit: the three ATAL episode profiles lost their legacy model strings in
  migration 22 (expected) — re-pick outline/transcript models once in the profile form.
- Test episodes for the two new profiles deferred until TTS is configured (cost + the
  blocker above).

## Phase 0 gate — knowledge-map quality (judged 2026-07-30)

The gate everything downstream rests on. It had read "Awaiting James's quality judgment"
since 2026-07-16, which meant every layer built since — mastery, scheduling, quizzing,
podcasts — sat on an assumption nobody had signed.

**`practical-deep-learning-fastai` — PASSES (James, 2026-07-30).** 24 concepts across 6
domains, mapping faithfully onto the fastai book's own chapter structure. The gate is
closed for this topic and the pipeline may be trusted on it.

**`ai-agent-design-patterns` — STILL UNJUDGED.** Deliberately not carried over: James
answered for the fastai map, and one map passing is not evidence about another. Two things
a future judgment should weigh, from the review that prompted this:

- The map is structurally sound and current (25 concepts / 6 domains, covering the agent
  loop, tools + MCP, the reasoning-pattern family, memory + RAG, multi-agent, and
  robustness). Two arguable gaps for a 2026 curriculum: **prompt injection is not a
  first-class concept** — only partly covered by "Guardrails & Input Validation" — and
  there is no **cost/latency budgeting**.
- More decisive: **its Open Notebook notebook is empty.** `npm run verify:live` reports
  "the notebook returned no sources". So Step 1 (sources, curated by James) has never been
  done for this topic, and the curriculum has never been checked against any material.
  Judging the map before it has sources would be judging a plan, not a curriculum.

Practical consequence: **run the pipeline on fastai.** The agent-patterns topic needs
Step 1 before its map can be assessed at all.

## Open questions

- ~~Does the `/learn:topic` knowledge map meet the quality bar?~~ **PARTLY ANSWERED
  2026-07-30 — see "Phase 0 gate" below. Answered for `practical-deep-learning-fastai`
  only; `ai-agent-design-patterns` is still unjudged.**
- ON API stability: podcasts + transformations via REST — confirm endpoints
  against v1.13 docs before writing `/study-pack` (roadmap shows platform churn:
  SurrealDB v3, possible Celery move).
- Presentation audience: human (preferred when available) vs Claude-as-audience —
  does Claude-as-audience feel real enough to trigger the protégé effect?
