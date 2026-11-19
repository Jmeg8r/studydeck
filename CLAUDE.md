# CLAUDE.md — studydeck

**StudyDeck** is James's personal deep-dive study system: point it at a topic and it
builds a curriculum, tracks mastery, quizzes you, and renders podcasts from the
material. It is **topic-agnostic by design** — `.learn/topics/` currently holds
`ai-agent-design-patterns`, `practical-deep-learning-fastai`, and `ai-engineering`; new topics are
expected. Nothing here is specific to any one subject.

> Renamed from `ai-agents-from-scratch` on 2026-07-27. That name came from an example
> course this repo was originally seeded with; the course was removed and the name no
> longer described anything here. If you find a stale reference, fix it.

## Where truth lives

| Question | Authoritative source | Not authoritative |
|---|---|---|
| What's in the curriculum | `.learn/topics/<slug>/state.json` | the knowledge-map markdown (it's *rendered* from state) |
| Study pipeline design | `tasks/study-flow.md` | anything reconstructed from memory |
| Cockpit design/scope | `tasks/study-cockpit-plan.md` | this file |
| Graded attempt history | `.learn/topics/<slug>/cockpit/attempts.jsonl` (append-only) | derived stats in the UI |
| Whether a study stage is done | `.learn/topics/<slug>/cockpit/stages.jsonl` (append-only) | the calendar — a passed date means available, not finished |
| ON endpoint shapes | `localhost:5055/openapi.json`, or a live `curl` | prior sessions' notes (the API churns — see *External services*) |
| What a model returned | the raw response text, parsed defensively | the schema you asked it for (it may ignore it) |
| A role session's outcome | `.learn/topics/<slug>/cockpit/sessions.jsonl`, `diagnoses.jsonl` (append-only) | `cockpit/transcripts/` — git-ignored, this machine only |

## Hard rules

- **1. `.learn/` keeps learn-anything's schema, exactly.** Its validators reject unknown
   fields and `learn-anything-cli update` overwrites generated files. Cockpit data goes
   in the `cockpit/` sidecar directory beside it — never as new keys in `state.json`.
- **2. `.learn/` is hidden — use `ls`, never a bare glob.** Tools that glob `*` silently miss it.
- **3. After any `state.json` write, run learn-anything's `render.mjs`** so the knowledge map
   and the file stay consistent. A write that skips render leaves the repo in a split state.
- **4. Single writer on `state.json`.** Don't run an in-app quiz and a `/learn:quiz` session at
   the same time. Convention, not enforced — solo user.
- **5. `app/` has zero runtime dependencies** and binds `127.0.0.1` only. Node stdlib on the
   server, vanilla ES modules in the browser, no build step. That's the point, not an
   oversight — a PR adding a framework needs to argue for itself. This is verifiable, not
   aspirational: `npm test` passes with `node_modules` deleted entirely.
- **6. Secrets are read server-side at boot, never committed and never sent to the browser.**
   The ON password comes from `~/Projects/quorum/.env`. `app/cockpit.config.json` is
   committed and must stay secret-free.
- **7. Answers are revealed only in exchange for a RECORDED attempt.** Decks are served
   answer-free, grading is server-side, and `POST /api/attempts` writes the attempt before
   it returns the results. There is deliberately no write-free grade route and no discard
   action — an attempt you could see and then throw away makes every later retake
   meaningless. The same rule covers fact-check claims: every pre-submit response goes
   through `stripClaimAnswers`, so `truth`/`correction` never cross the wire early.
   Self-checked (`ai_only`) items stay `pending_self_grade` on the recorded attempt and
   are finalised by `POST /api/attempts/:id/finalize`, which appends the next revision and
   applies mastery **once** — applying it at both points would double the confidence gain.
- **8. Every JSON write goes through `app/lib/atomic.mjs`.** `writeFileSync` truncates before
   it writes; a crash in between leaves a corrupt file, and the sidecar reader degrades a
   corrupt file to an empty fallback — so the damage surfaces as "no cards", not as an
   error. `writeJsonAtomicSync` writes temp-then-rename and retains `<name>.bak`.
   Recovery gives you the **last known-good copy, one write behind** — that is the
   guarantee, not zero data loss.
- **9. Every APPEND-ing request carries a `mutation_id`, and the client mints it once and
   reuses it until that request succeeds.** Appends are deduplicated by it, so a response
   lost after a successful write cannot record the attempt/review/grade/debrief/stage
   event twice. Routes that merely *set* a value (`/api/schedule/start`, `/pause`) carry
   none on purpose — a replay rewrites the identical file, and an id the server ignores
   would advertise a protection that isn't running. Recovery's two POSTs
   (`/api/recovery/settle`, `/reconcile`) carry none for the same reason: they finish a
   record that already exists, settle by re-reading whether it is still owed, and
   reconcile by appending through the operation's own revise helper, whose `mutation_id`
   is derived from the operation and its revision — so a replay finds nothing owed or
   dedupes. A chapter render's resume and publish
   (`/api/podcast/renders/:id/resume`, `/publish`) carry none either: they set a stage on
   a rendition that create's `mutation_id` already named. A replayed publish returns the
   published rendition unchanged, and a replayed resume changes nothing while the
   rendition is queued, running or finished — after `failed` a replay is a fresh resume,
   by design, and `podcastrenderroutes.test.mjs` pins all of it. Attempts additionally carry
   `attempt_id` + `revision`: history is append-only, and `readAttempts` folds to the
   newest revision per attempt. Read history through `readAttempts` — never
   `readAttemptsRaw`, which is for diagnostics and for **replay checks**. That exception is
   load-bearing, not a loophole: folding drops superseded revisions, so a replay check
   against folded history would fail to find revision 0's `mutation_id` and append a
   duplicate — the precise failure the id exists to prevent. Anything deriving stats,
   weakness or counts uses the folded read.
- **10. `state.json` + render run under `withTopicLock`** (`app/lib/lock.mjs`). It is
    advisory: a `/learn:quiz` CLI session does not take it, so rule 4's single-writer
    convention is still what actually protects you — the lock closes the in-app race and
    makes a foreign write visible.
- **11. A scheduled date is a NOT-BEFORE date, never evidence.** A study stage is complete
    only when a `cockpit/stages.jsonl` event says so; `lib/stages.mjs` folds those events
    and nothing infers completion from the calendar, from elapsed time, or from recorded
    activity. An unfinished stage stays owed however many days pass over it, and the queue
    never drops one. Observed activity is shown beside a stage to inform your click and is
    consulted for nothing else — inferring completion from partial evidence is the same
    failure as inferring it from the date.
- **12. Loopback keeps other machines out; `app/lib/guard.mjs` keeps other TABS out.** Rule 5's
    `127.0.0.1` bind is a network boundary, not an identity — any page in the same browser
    could otherwise POST here, and under rule 7 an unauthorized *write* is already the
    damage. Every request needs a loopback `Host` (a NAME means DNS, which for a 127.0.0.1
    service means a rebind); every mutating request needs `Content-Type: application/json`
    and, when it sends one, an `Origin` equal to its own `Host`. **The one exception is the
    tailnet door:** with `STUDYDECK_TAILSCALE_ORIGIN` and `STUDYDECK_TAILSCALE_USER` both set,
    the exact `Host` of that HTTPS origin is admitted too, but only with
    `Tailscale-User-Login` equal to that user on every method, and with that origin as
    `Origin` on mutating requests. The header is believable only because of the
    `127.0.0.1` bind: a tailnet `Host` can arrive only through Tailscale Serve on this
    machine, which sets it. Bind anywhere else and the header is forgeable; one variable
    without the other stops boot. There is deliberately **no
    CSRF token, because no response ever carries an `Access-Control-Allow-*` header** — JSON
    forces a preflight cross-origin, and an unanswerable preflight is the entire defence.
    Emit one CORS header anywhere and that reasoning collapses silently, which is why
    `app/test/guard.test.mjs` asserts their absence rather than trusting it. Security headers
    are set with `res.setHeader` at the top of `handleRequest`, before routing, so a route
    added later inherits them without knowing they exist; `script-src 'self'` is the
    load-bearing directive, because the reading view puts rendered Open Notebook markdown
    through `innerHTML`. Sketch uploads are raster-only — SVG is a script-carrying document
    and was being served back from this app's own origin.

## External services — gotchas that cost real time

None is discoverable from the code; each produced a wrong conclusion before being pinned
down. Full notes, commands and measurements: `.claude/rules/external-services.md` (Claude Code
loads it under `app/` and `ops/`; other agents, read it before touching ON, ollama or TTS code).

- **The local model ignores ollama's `format` schema. Never `JSON.parse` a model response
  directly** — use `extractJson` (`app/lib/ollama.mjs`); never invent a grade or card set from
  unparseable output.
- **ON's list endpoints omit bodies** (`full_text`, `content`); use the detail routes.
- **Podcast routes use hyphens**; underscore forms 404. Unsure of an ON path? Read
  `localhost:5055/openapi.json`, not notes.
- **A TTS model unblocks podcast playback, not generation**; stock profiles lack LLMs.
- **A podcast job stuck at `running`: check the worker log, not the status.**
- **Outline generation needs a non-reasoning model**; vet a candidate with one curl first.
- **Kokoro needs native voice ids and never normalizes loudness**; test every voice a profile uses.
- **ON speaker/episode profiles: GET by name, PUT by id.**
- **The Claude API is the only thing that leaves the machine** (Roles view, `app/lib/claude.mjs`).
  The model always thinks and its thinking blocks are bound to the conversation: store and
  replay assistant `content` verbatim, never edit a session's system prompt. A billed reply can
  carry no text. Key: `STUDYDECK_ANTHROPIC_API_KEY` only.

## Repo conventions

- **Forgejo is primary.** `origin` points to the private `jfcadm/studydeck` repository
  on the local Forgejo server. `github` points to `Jmeg8r/studydeck` as a separate
  mirror remote. Pushes to one do not imply that the other is synchronized. Verify
  live branch protection and CI on the target forge before merging. The old
  `ai-agents-from-scratch` name is historical. Merge with `forge-pr merge`, which refuses
  without the AI review gate's verdict (`.github/workflows/ai-review.yml`, sovereign-forge
  kit in `bin/`, never edited here). The gate reads its standards from this file's bold
  bullets on `main`, from `## Hard rules` to the end.
- **Branches:** `feat/`, `fix/`, `docs/`, `chore/`. `main` changes go through a PR. Read the
  current Forgejo protection and check results rather than assuming the historical GitHub
  ruleset applies.
- **Stacked PRs: merge BOTTOM-UP, and retarget the stack to `main` BEFORE deleting a base
  branch** (learned on GitHub, 2026-07-30):
  - Deleting a base branch auto-closes every PR targeting it, and a closed PR can't be
    retargeted or reopened while its base is missing — it's unrecoverable; open a fresh one.
    Retarget downstream PRs *first*, then merge-and-delete.
  - Squash-merging the TOP of a stack carries every commit beneath it into `main`; merging
    the lower PR afterwards *reverts* the work above it (once 480 lines). Close it as
    subsumed, and check `git diff main origin/<branch>` before believing either outcome.
  - A strict required-checks policy leaves the rest of the stack "behind": after each merge,
    rebase each remaining branch (`git rebase --onto origin/main <old-base> <branch>`) and push
    with `--force-with-lease`. That cost is why stacks stay short.
- **Fix a bug by writing the failing test FIRST and watching it fail.** On 2026-07-30 a real
  fix shipped with a test that stayed green against the *unfixed* code. **A test of what a
  function RETURNS is not a test of what its CALLER does with it** — pin the boundary that broke.
- **CI** (`.github/workflows/test.yml`; the forge's Actions runs it on PRs) tests Linux on
  Node 22 and 24 **with no install step**: rule 5 is *proved* by `npm test` passing with
  `node_modules` absent, so never add `npm ci`; the workflow fails if `node_modules` or a
  declared dependency appears. Make a required check the aggregate **`ci`**, never a matrix
  job by name (renaming one leaves it pending forever). Node 20 can't work: the suite needs
  `--test` glob expansion (21+) and `fs.globSync` (22+).
- **Being DOWN is our behaviour; being UP is theirs.** No test asserts the shape of an Open
  Notebook or ollama response — that pins a stub of an API this repo doesn't control, and
  ON's routes have churned twice. What
  `app/test/degradation.test.mjs` pins is the cockpit with them unreachable: a route that needs
  ON (`/api/on/sources`, `/api/on/podcast`) returns **503 naming the service**, never a 200
  with an empty list (which reads as "this notebook is empty"); `/api/on/health` answers
  **200 with `reachable: false`** (reporting the outage is its success); `/api/state` keeps
  serving; the ON password appears in no response, headers and error paths included.
  `STUDYDECK_ON_BASE_URL`/`STUDYDECK_ON_PASSWORD` exist for that test. The suite must pass
  with ON down. The `oncontract.test.mjs` carve-out, the "what WE send" stubs,
  `npm run verify:live`, and the **still-on-manual-verification** list are in
  `.claude/rules/testing.md` — read it before changing a test that touches ON or ollama,
  `app/lib/oncontract.mjs`, or `app/verify.mjs`.
- **`.learn/` and `cockpit/` sidecars are committed** — learning artifacts and ASTGL raw
  material, not scratch state. **One exception: `cockpit/transcripts/`** holds role-session
  conversations and is git-ignored; `app/test/transcriptignore.test.mjs` asks git that it
  stays so. Session outcomes, confirmed summaries and diagnosis findings ARE committed.
- **A role session spends money, so its writes are ordered:** the learner's turn is stored
  before the model is called and the reply before it is returned. Do not reorder them, and
  do not add a model call that skips `advance` in `app/lib/sessions.mjs` — that is where the
  spending limit is checked. No role is ever given a deck question or answer (rule 7); only
  the Diagnostician sends one, and only for a miss in a final attempt.
- **`.gitignore` names each ignored path explicitly** (with a comment saying why). Add new
  untracked paths the same way; the old blanket course patterns (`ui`, `frontend*`, `*.txt`)
  are gone on purpose.
- **`docs/` holds tutorial screen recordings** (ignored by git, tracked by
  `tasks/study-flow-video-manifest.json`, served by the cockpit) beside the committed
  `sources-and-media.md`, `changes/` and `diagrams/`. Don't assume the recordings are absent
  because git says so. The architecture map's source is `docs/diagrams/studydeck.architecture.json`;
  edit that, never the generated HTML or SVG.
- **Approved cockpit design comps** live outside the repo, at
  `~/.gstack/projects/Jmeg8r-studydeck/designs/study-cockpit-20260718/`
  (`variant-C.html` is the shell reference; `approved.json` records the pick).
- **Routes live in `app/router.mjs`; `app/server.mjs` only binds the socket**, so tests import
  every route without a server on port 4310. Don't collapse it or add a second test handler.
- **`.agents/skills/` mirrors `.claude/skills/` and is NOT what the app runs** — the
  tool-neutral copy (the same 18 files byte for byte, plus six `source-command-learn-*` shims).
  `mastery.mjs` resolves `render.mjs` from `.claude/skills/` by explicit path, never a scan.
  **Patch a script in both, or the copy you edited is the one nothing executes.**
- **`AGENTS.md` is a symlink to this file.** Edit `CLAUDE.md`; never replace the symlink
  with a copy. Keep guidance tool-neutral so it reads correctly for any agent.
- **Verify a cockpit change by driving it:** start the server, load the page, reconcile the
  numbers against the underlying JSON by hand. **Drive mutation paths against a COPY**, never
  the real tree (unearned attempts and confidence bumps corrupt it):
  `rm -rf /tmp/learn && mkdir -p /tmp/learn && cp -R .learn/topics/. /tmp/learn/` then
  `STUDYDECK_LEARN_ROOT=/tmp/learn node app/server.mjs`. Copy the CONTENTS (`topics/.`): the
  override expects topic directories directly beneath the root. It does NOT cover Open
  Notebook — a live debrief or mind-map run still writes a real note. To run the copy beside
  the real cockpit, pass a copy of `app/cockpit.config.json` through `STUDYDECK_CONFIG_PATH`
  with the port changed at **`server.port`**. A top-level `port` key is ignored and the copy
  tries 4310.

## Sources and media workflows

User-facing instructions: `docs/sources-and-media.md`. Source search uses
`app/lib/sourcesearch.mjs` and the Firecrawl CLI (deployment: `ops/firecrawl/README.md`).
Search is read-only; only the explicit Add to notebook operation imports a recommendation.
Assessments use local Ollama and retrieved excerpts — a result is not evidence that the whole
document or video was reviewed. The elapsed search timer is browser activity feedback, not
backend stage progress.
Notebook creation writes a mapped Open Notebook notebook, an empty topic, and app
configuration. PDF/file uploads still use Open Notebook's own UI and login.
Provider-credential migration is separate from that login password.
Video generation and Higgsfield storyboard preparation run locally from bounded source
excerpts. Higgsfield generation and MP4 import are manual. Keep generated media,
`docs/.video-renders/`, `docs/.higgsfield-prep/`, and Firecrawl's `.env.local` out of Git.
A Git push does not back up those files or Open Notebook's database.
