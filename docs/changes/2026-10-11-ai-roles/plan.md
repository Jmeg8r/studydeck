---
change: 2026-10-11-ai-roles
status: accepted
track: T2
intent: ./intent.md
linear: pending
---
# Plan: the four missing AI learning roles

## Context

James asked to bring the design and logic of <https://youtu.be/FSXHk4hMrY8> into
StudyDeck. The video names ten roles an AI can play in learning. Five already exist in
the cockpit; this change adds the four that do not: Interviewer, Socratic questioner,
Sparring partner (multi-turn conversations) and Diagnostician (one-shot analysis of
recorded misses). They run on the Claude API, called with Node's built-in `fetch` so
the app keeps zero runtime dependencies.

Inputs, both accepted and committed on `feat/ai-roles` (worktree
`.claude/worktrees/ai-roles`, based on forge `main` at `5cf79e8`, baseline 381 tests):

- `docs/changes/2026-10-11-ai-roles/intent.md`
- `docs/changes/2026-10-11-ai-roles/spec.md` (R1-R29, F1-F11 resolved, A1-A21)

Approved by James on 2026-10-11 and committed before any code.

## Files that change

New:

| File | Contents |
|---|---|
| `app/lib/claude.mjs` | `ClaudeError`, `health()`, `createMessage()`: headers, 120 s timeout, retry on 429/500/529 (max 2, honours `retry-after`), fallback-header downgrade (F3), response read by block type, `usage` returned |
| `app/lib/roles.mjs` | Pure. Role table, system-prompt builders, effort per role, `ROLE_LIMITS` constants (F7) |
| `app/lib/sessions.mjs` | Start, turn, summary draft, close, cards; replay rules (R9); per-session queue; spend accounting |
| `app/lib/diagnosis.mjs` | Evidence selection (final attempts, deck-hash match), request building, finding validation, dedupe by question |
| `app/web/js/views/roles.mjs` | The Roles view and its states |
| `app/test/claudeegress.test.mjs`, `rolesessions.test.mjs`, `diagnosisegress.test.mjs`, `roles.test.mjs` | Recorder and unit tests |
| `docs/changes/2026-10-11-ai-roles/plan.md`, `acceptance-script.md` | This plan; James's behavioural script (A21) |

Changed:

| File | Change |
|---|---|
| `app/lib/config.mjs` | `claude` block: key from `STUDYDECK_ANTHROPIC_API_KEY`, `STUDYDECK_CLAUDE_BASE_URL` seam; `configSummary()` reports `claudeKey: loaded/MISSING` |
| `app/cockpit.config.json` | `claude: { baseUrl, model: "claude-opus-5-5", effort: {...}, pricePerMTok: {...} }` — no secret |
| `app/lib/sidecar.mjs` | `sessions.jsonl`, `diagnoses.jsonl` readers/appenders via the existing `appendUnique`; transcript read/append under `cockpit/transcripts/` |
| `app/router.mjs` | Eleven `/api/roles/*` routes delegating to the modules above |
| `app/web/js/main.mjs`, `app/web/css/app.css` | One `VIEWS` entry; chat styles from existing tokens |
| `.gitignore` | `.learn/**/cockpit/transcripts/` with a comment |
| `app/test/guard.test.mjs`, `degradation.test.mjs` | Extended to the new routes |
| `CLAUDE.md`, `.claude/rules/external-services.md`, `.claude/rules/testing.md`, `tasks/study-flow.md`, `tasks/roadmap-2026-07-30.md`, `README.md` | Per spec R29 |

Reused, not rewritten:

- `collectSources` (`app/lib/videogeneration.mjs:101`) for bounded excerpts. It throws
  when a notebook has no sources; sessions catch that and proceed without excerpts, and
  the session record says so (R7).
- `extractJson` (`app/lib/ollama.mjs:28`) for the diagnosis reply.
- `appendUnique` (`app/lib/sidecar.mjs:110`), `writeJsonAtomicSync` (`app/lib/atomic.mjs`),
  `shareInFlight` (`app/lib/inflight.mjs`), `assertBrowserBoundary` (`app/lib/guard.mjs`).
- `readAttempts` / `isFinalAttempt` (`app/lib/sidecar.mjs:164`), `readDeck`
  (`app/lib/learn.mjs:241`), and the hash recipe in `retrievalEvidenceForQuiz`
  (`app/lib/evidence.mjs:41`).
- Card shape and mutation-keyed dedupe from `handleCards` (`app/router.mjs:1057`).
- `requestJsonWithMutation` (`app/web/js/api.mjs`), `el`/`clear` (`app/web/js/dom.mjs`).
- The recorder harness from `app/test/gradeegress.test.mjs` (stub server, env set
  before a dynamic `import`, assertion that config points at the stub).

## Order of work

Four pull requests on the forge, opened bottom-up, each with tests written first.
Per-file diffs stay far below the review gate's 100,000-byte cap
(`sovereign-forge/bin/review-pr.sh:435`); the split is for reviewability.

1. **PR 1 — client and configuration** (`feat/ai-roles`)
   → verify: A1, A2, A3, A4 for `/api/roles/health`.
   - Commit `plan.md`.
   - Tests first: `claudeegress.test.mjs` (headers, model, no retry on 400/401, at
     most two on 429/529, fallback downgrade, key in no body/header/log).
   - `config.mjs`, `cockpit.config.json`, `claude.mjs`, `GET /api/roles/health`,
     `.gitignore` rule plus the `git check-ignore` test (A11).
2. **PR 2 — sessions** (`feat/ai-roles-sessions`)
   → verify: A5, A6, A7, A8, A12, A13, A14.
   - Tests first: `roles.test.mjs` (prompt builders contain no deck text),
     `rolesessions.test.mjs` (replay, concurrency, resume, limits, 503 scope).
   - `roles.mjs`, `sessions.mjs`, sidecar additions, session routes.
3. **PR 3 — Diagnostician** (`feat/ai-roles-diagnosis`)
   → verify: A9, A10.
   - Tests first: `diagnosisegress.test.mjs`.
   - `diagnosis.mjs`, sidecar additions, diagnosis routes.
4. **PR 4 — the Roles view and documentation** (`feat/ai-roles-view`)
   → verify: A15-A21 with James and the real key; screenshots in both themes.
   - `roles.mjs` view, nav entry, CSS, egress notice, docs, `acceptance-script.md`.

Each PR: `npm test` on Node 22 and 24 with `node_modules` absent, `npm run verify`,
`security-review` on the diff (F10), Codex review posted verbatim as a PR comment,
then James's merge. Later branches are rebased onto `main` after each merge, and no
base branch is deleted before the PR above it is retargeted.

## Decisions made while planning

- **Session cards: James writes the back.** `handleCards` needs a front and a back.
  The spec's R14 said "local card drafting", which would mean the local model
  inventing the correct answer from a stumble. Instead the card front is prefilled
  from the counterpart's question and James types the back. No model call, nothing
  fabricated, and it is the production step the video argues for. `spec.md` R14 is
  amended in the same commit, under a `## Deviations` note in `plan.md`.
- **Excerpts are optional.** With Open Notebook down or a notebook empty, a session
  still starts, without excerpts. Only Claude being down blocks a conversational turn.
- **Transcripts are JSONL appended through the existing atomic append**, one file per
  session, first line the frozen system prompt and request parameters.

## Risks

| Risk | Mitigation |
|---|---|
| The key leaks into a log or response | `ClaudeError` carries message and status only; A3 captures `console` and asserts absence on four paths |
| A transcript gets committed | Explicit ignore rule plus a test that runs `git check-ignore`; `git diff --cached --name-only` checked before every commit |
| A retried turn is billed twice | Learner turn stored before the call; replay returns the stored reply; A5-A7 count outbound requests with a control |
| Thinking-block replay returns 400 | Assistant `content` stored and replayed verbatim; system prompt frozen per session (F2); first seen live in A15 |
| The fallback beta header is not enabled | One retry without it (F3), covered by a stub that answers 400 on the header |
| Recorder tests pass while the real API shape differs | Stated in each test header, as the repo's rule requires; A15 is the live check |
| Model output cites evidence that was not sent | Findings validated against the request; uncited findings dropped and counted (A10) |
| Stack rebase churn across four PRs | Open bottom-up, one at a time; rebase with `--onto` after each merge |
| The main checkout's uncommitted work conflicts later | This work is isolated in its own worktree off forge `main`; the dirty tree is James's to reconcile |

## Proof

- `npm test` → all pass, count above 381, on Node 22 and 24 with no `node_modules`.
- `npm run verify` → clean.
- Closed-port run: each generating route → 503 naming the Claude API; `/api/state` → 200.
- Outbound-request counts: replay 0 (control 1); concurrent different replies 1 call,
  one 409; retry after failure 1 call.
- `git check-ignore -v .learn/topics/<slug>/cockpit/transcripts/x.jsonl` → matches;
  the same for `sessions.jsonl` → no match.
- After a session, `state.json` byte-identical and `stages.jsonl` unchanged.
- Live, against a copy of `.learn/` (`STUDYDECK_LEARN_ROOT`), driven in the browser:
  one session per role of three or more turns, reload after turn two, an interview on
  an empty topic, a sparring timer expiry, two cards created, one diagnosis.
- Screenshots of every view state in both themes beside `variant-C.html`.
- James's `acceptance-script.md` results for each role.

Live checks need `STUDYDECK_ANTHROPIC_API_KEY` set by James in the shell that starts
the server. The agent never reads or prints its value.

## Options not taken

- **Official SDK** — retires the zero-dependency guarantee and the no-install CI.
- **Streaming** — a hand-written event-stream parser for turns that are short (F11).
- **Local model for the conversational roles** — James chose Claude after the timing.
- **Routing session cards through `/api/debrief`** — it writes a note to Open Notebook.
- **One large pull request** — reviewable only in theory.
- **Storing transcripts outside the repository** — breaks the copy-and-drive
  verification that `STUDYDECK_LEARN_ROOT` gives.

## Deviations

- **Spec R14 (2026-10-11, at planning).** Session cards are not drafted by the local
  model. The card front is prefilled from the counterpart's question and James writes
  the back. `spec.md` R14 was amended in the same commit as this plan.
- **Spec design, "A turn, in order" (2026-10-11, PR 2).** The per-session queue exists to
  stop a duplicate request paying for a second call while the first is still waiting on
  the model. The spec credited it with refusing a different reply to the same turn; that
  case is already refused without it, because the learner turn is written before the
  first await. A mutation check showed the difference, and `rolesessions.test.mjs` now
  pins both cases.
- **Order of work, PR 2 (2026-10-11).** `roles.mjs` and `sessions.mjs` were written before
  their tests, not after. Each guard was then checked by breaking it: with the queue
  disabled one test fails, and the first concurrency test written did not fail, which is
  how the gap above was found.
- **PR 2, after four Codex review rounds (2026-10-11).** The spec's session design was
  incomplete in ways the reviews found one at a time, all about a session's edges:
  closing now queues behind an in-flight turn; nothing is bought for a closed session;
  summary drafts count toward the spending limit; a billed response with no text is
  recorded as a `charge` line in the transcript; and a session reports its `pending`
  turn. A twelfth route, `POST /api/roles/sessions/:id/resume`, finishes any waiting
  turn (opening, turn or summary) and replaces fixing each kind separately. The review
  loop was stopped at four rounds; a fifth was not run.
- **Spec R14 again, after the live run (2026-10-13, James's decision).** A card's answer
  side can now be drafted by AI. James asked for it on seeing the blank back. The draft
  comes from the local model, not Claude, so nothing is spent on a closed session. It
  arrives locked, an Edit button unlocks it, and the card stores `back_origin`
  (`learner`, `ai_draft` or `ai_draft_edited`). Writing it by hand still works and is
  still the default. Shipped as its own change: `docs/changes/2026-11-08-roles-card-draft/`.
- **PR 4, proof (2026-10-11).** A15 to A21 need the live API and James, so none has been
  run. In its place the view was driven in a browser against a local stand-in for the
  API on a copy of the study data: one Socratic session, an outage, a reload and resume,
  one card, one diagnosis, both themes. The Interviewer, the Sparring timer, a
  keyboard-only pass, a screen reader and measured contrast were not driven; they are
  steps in `acceptance-script.md`. That run also showed the real data has no eligible
  miss for a diagnosis yet (3 misses, all recorded before deck fingerprints existed).
- **PR 1 (2026-10-11).** The Codex review found a key leak through a transport error and
  an unbounded body read; both were fixed with tests before the PR was opened. The
  client's `/api/roles/health` also reports `authorized`, which the spec did not list.
