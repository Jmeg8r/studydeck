# Plan: rename `ai-agents-from-scratch` → `studydeck`

**Date:** 2026-07-27
**Status:** EXECUTED — but by a different mechanic than planned. See below.

> **What actually happened.** The plan below assumed `Jmeg8r/ai-agents-from-scratch` was
> a GitHub fork, and argued for a fresh repo partly to escape the fork banner. It was
> **not** a fork (`isFork: false` — cloned and pushed, never forked), so that benefit
> didn't exist. With James deferring the call, the repo was **renamed in place** instead:
>
> - `Jmeg8r/ai-agents-from-scratch` → `Jmeg8r/studydeck`, keeping all 15 PRs, their
>   CodeRabbit review threads, and the full 51-commit history. GitHub redirects the old
>   URL, so stale clones and links keep resolving.
> - **Phases 1.1, 1.4, and 4.2 were dropped** (no repo to create, no history to re-push,
>   no archive to make). Phase 1.5 became *adding* protection rather than re-creating it.
> - Two things surfaced during execution that the plan didn't anticipate: **PR #15 was
>   open** against `CLAUDE.md` (merged first, as `566cf44`), and **`main` was never
>   actually protected** despite CLAUDE.md claiming it was — no rulesets, no classic
>   protection. A `protect-main` ruleset now exists.
>
> The end state is the one this plan describes. Only the route differs.

---

## Why a rename alone isn't enough

The name is wrong because the repo's *identity* is wrong. Evidence gathered
2026-07-27 at `d8d3c9b`:

| Finding | Evidence |
|---|---|
| The course is inert | 51 commits / 97 files ahead of `upstream`, **zero** touch `examples/`, `helper/`, `diagrams/`, or `README.md` |
| No code coupling | Nothing in `app/` imports or reads `examples/`; only 2 prose mentions in `tasks/*.md` |
| Deps belong to the course | `node-llama-cpp`, `openai`, `dotenv` are used only by `examples/`; `app/` has zero runtime deps by design |
| Already multi-topic | `.learn/topics/` holds 2 topics; the **active** one is `practical-deep-learning-fastai` |
| Upstream is static | No upstream commits since 2026-05-31; fully merged |

Renaming in place would leave GitHub's "forked from pguso/ai-agents-from-scratch"
banner, pguso's README, and an unused course in the root — the confusion survives
the rename.

## Target end state

```
~/Projects/studydeck                     github.com/Jmeg8r/studydeck (private, not a fork)
├── app/         .learn/   .agents/      ├── README.md    (StudyDeck — yours)
├── .claude/     tasks/    learnings/    ├── CLAUDE.md    (rewritten)
├── docs/        (tutorial videos)       ├── AGENTS.md    (rewritten)
└── package.json (name: studydeck,       └── LICENSE.md
                 no runtime deps)
```

Removed: `examples/`, `helper/`, `diagrams/`, `models/`, `logs/`, `DOWNLOAD.md`,
`PROMPTING.md`, `CONTRIBUTING.md`, `.env.example`, the `upstream` remote, and all
three npm dependencies.

Kept: full 51-commit history, `docs/*.mp4` (your tutorials, referenced by
`tasks/study-flow-video-manifest.json`), all `.learn/` learning data including the
`ai-agent-design-patterns` topic.

---

## Phase 0 — Safety net (do first, verify before touching anything)

0.1 Confirm the stale worktree is disposable, then remove it.
    → verify: `git log --oneline main..4d6fbeb` is empty (**already confirmed empty**)
      and `git status --porcelain` in the worktree is clean (**already confirmed clean**).
      Re-run both immediately before `git worktree remove` — per the shared-checkout
      lesson, another session may have pushed to it since.

0.2 Tag the current state as a rollback point: `git tag pre-studydeck-rename`.
    → verify: `git tag -l pre-studydeck-rename` returns the tag at `d8d3c9b`.

0.3 Confirm `Jmeg8r/ai-agents-from-scratch` is the push target for the archive and
    that the old repo will be left fully intact.
    → verify: `gh repo view Jmeg8r/ai-agents-from-scratch --json name,isPrivate,isFork`.

**Nothing is deleted in this phase.** Phases 1–3 are reversible via the tag; Phase 4
onward touches GitHub.

---

## Phase 1 — Create the new remote and repoint local

1.1 Create the new repo: `gh repo create Jmeg8r/studydeck --private`.
    Created empty — **not** via `gh repo fork`, so no fork relationship exists.
    → verify: `gh repo view Jmeg8r/studydeck --json isFork` returns `false`.

1.2 Rename the local directory `~/Projects/ai-agents-from-scratch` → `~/Projects/studydeck`.
    → verify: `git -C ~/Projects/studydeck status` works and `git worktree list` shows
      the new path.

1.3 Remove the `upstream` remote; repoint `origin` to `Jmeg8r/studydeck`.
    → verify: `git remote -v` shows exactly one remote, pointing at `studydeck`.

1.4 Push `main` as-is to establish history on the new remote.
    → verify: `gh repo view Jmeg8r/studydeck` shows 51+ commits; `git log` on GitHub
      matches local `d8d3c9b`.

1.5 Enable branch protection on the new `main` (require PR; require conversation
    resolution — matching your existing ruleset).
    → verify: a direct `git push origin main` is rejected.

> **Note:** the new repo has no CI (the current repo has no `.github/workflows` at
> all). "CI must pass" in the Ironclad SHIP phase is currently vacuous here. Flagging
> it as a separate follow-up, not part of this change.

---

## Phase 2 — Strip the course (branch `chore/rename-to-studydeck`)

Ordered so the highest-judgment changes come first.

2.1 `git rm -r` the course: `examples/`, `helper/`, `diagrams/`, `DOWNLOAD.md`,
    `PROMPTING.md`, `CONTRIBUTING.md`, `.env.example`.
    → verify: `npm test` still passes (it only targets `app/**/*.test.mjs`);
      `node --check` clean across remaining `app/**/*.mjs`.

2.2 Drop all three npm dependencies from `package.json`, set `"name": "studydeck"`,
    add a real `description`. Regenerate `package-lock.json`.
    → verify: `npm test` passes with `node_modules` deleted entirely — proving the
      zero-dependency claim in CLAUDE.md rule 6 is now literally true.
    → **side benefit:** removing `node-llama-cpp` eliminates the dependency surface
      behind the 44 Dependabot alerts cleared in `3d2e190`.

2.3 Delete the untracked/ignored course leftovers: `models/Qwen3-1.7B-Q8_0.gguf`,
    `logs/`, and the now-unused `.env`.
    → verify: show file sizes before deleting; confirm `.env` holds only
      `OPENAI_API_KEY` (course-only) and no ON credentials.

2.4 Prune course-specific `.gitignore` entries (`node-llama-docs`, `ui`, `frontend*`,
    `VIDEO_SCRIPT.md`), keep `docs/*.mp4`, `.env`, `node_modules`, `.DS_Store`.
    → verify: `git status` shows no newly-untracked noise; `docs/*.mp4` still ignored.

---

## Phase 3 — Rewrite the docs (same branch)

3.1 **`README.md`** — replace pguso's entirely. New content: what StudyDeck is (a
    personal deep-dive study system — point it at a topic, it builds the curriculum,
    quizzes you, and renders podcasts), how to run it (`node app/server.mjs` →
    `127.0.0.1:4310`), the `.learn/` + `cockpit/` data model, and the external
    dependencies (Open Notebook, ollama, Speaches/Kokoro).
    → verify: no remaining mention of pguso, agentsfromscratch.com, or `examples/`.

3.2 **`CLAUDE.md`** — the current file's framing ("Two things live in this repo:
    pguso's example course and James's personal study system") becomes false. Rewrite:
    - Drop hard rule 1 entirely (no `upstream`, no fork hazard).
    - Renumber remaining rules; keep 2–8 (they're all still correct and load-bearing).
    - Keep the entire *External services* section verbatim — that's the expensive,
      hard-won knowledge and none of it changes.
    - Update the gstack design-comps path (Phase 5).
    - Update the repo-conventions block: `origin` is now the only remote.
    → verify: read it end-to-end; every factual claim still checks out against disk.

3.3 **`AGENTS.md`** — currently a near-duplicate of `CLAUDE.md`. Apply the same
    rewrite. **Decision needed from you:** it's untracked right now, so this is the
    moment to either commit it or make it a symlink to `CLAUDE.md` rather than
    maintaining two copies that have already drifted.

3.4 `tasks/learning-progress.md` — its two `examples/` references now point at
    material that has left the repo. Add a one-line note that the course lives at
    `Jmeg8r/ai-agents-from-scratch` (archived) and `pguso/ai-agents-from-scratch`.
    **Do not rewrite the log itself** — it's a historical record of what you studied.

3.5 `LICENSE.md` — currently pguso's, covering his course. Since the course is gone
    and the remaining code is 100% yours, this needs to change. **Decision needed:**
    replace with your own, or drop it (it's a private personal repo).

---

## Phase 4 — Ship

4.1 Open the PR against the new repo's `main`, merge after review.
    → verify: `git branch --show-current` checked immediately before every commit and
      push (shared-checkout lesson); post-merge `git diff main origin/main` is empty.

4.2 Archive the old repo: rename `Jmeg8r/ai-agents-from-scratch` →
    `Jmeg8r/ai-agents-from-scratch-archive`, set it to archived/read-only, and add a
    README line pointing at `studydeck`.
    → verify: old repo is read-only; new repo unaffected.
    → **This is the one hard-to-reverse, outward-facing step. I'll confirm with you
      immediately before running it.**

---

## Phase 5 — Path-keyed external stores (all three approved)

These break silently on a directory rename — nothing errors, things just go missing.

5.1 **Auto-memory** — `~/.claude/projects/-Users-jamescruce-Projects-ai-agents-from-scratch/memory/`
    holds 5 files (`MEMORY.md`, `ai-agents-repo-remotes.md`, `study-flow-infrastructure.md`,
    2 feedback entries). It's keyed by directory path; after the rename the next session
    starts with **no memory of this project**.
    - Move the directory to the `-Users-jamescruce-Projects-studydeck` slug.
    - Rewrite `ai-agents-repo-remotes.md` — every fact in it (origin, upstream,
      never-publish-`.learn/`, `gh` defaults to upstream) is now obsolete or wrong.
    - Update the `MEMORY.md` index line to match.
    → verify: read the moved `MEMORY.md`; confirm the new path resolves.

5.2 **gstack design comps** — move
    `~/.gstack/projects/Jmeg8r-ai-agents-from-scratch/` → `Jmeg8r-studydeck/`
    (holds `designs/study-cockpit-20260718/variant-C.html` + `approved.json`).
    → verify: the path named in the rewritten CLAUDE.md exists on disk.

5.3 **Session logs** — `~/.claude/session-logs/archive/-Users-jamescruce-Projects-ai-agents-from-scratch/`
    (10 historical sessions). These are immutable historical records keyed to the path
    as it was. **Recommend leaving them** — rewriting history to match a current name
    makes the archive lie about where the work happened. New sessions will log to the
    new slug automatically.

---

## What this deliberately does not do

- **Does not touch `.learn/` data.** Both topics, all sessions, quizzes, and
  `attempts.jsonl` carry over untouched. No `state.json` writes, so no `render.mjs`
  run is needed.
- **Does not address the P1 findings** in `tasks/project-assessment-2026-07-27.md`
  (calendar-time-as-completion, answer leakage, non-idempotent mutations). Those are
  real and unchanged by this rename — separate work.
- **Does not set up CI.** Noted as a gap in 1.5.

## Known losses, accepted

- The `examples/` source material behind the `ai-agent-design-patterns` topic leaves
  the working tree. The topic's *learning data* is unaffected. Material is recoverable
  from the archived repo, the `pre-studydeck-rename` tag, or `pguso/ai-agents-from-scratch`
  (public).
- Git history retains the upstream commits — the course's past is still in the log,
  it just isn't in the tree. Removing it would require history rewriting, which I'd
  advise against.
