# When "rename this project" is really "this project's identity is wrong"

**2026-07-27 · studydeck (was `ai-agents-from-scratch`) · PR #16**

## The problem, in one line

A repo named after an example course it had been seeded with had quietly become an
unrelated product, and "rename it" could have meant anything from editing a title to
re-homing the whole project.

## The approach

1. **Measure the divergence before proposing a scope.** Four cheap commands decided
   everything: `git rev-list --count upstream/main..HEAD` (51), `git diff --name-only
   upstream/main..HEAD | awk -F/ '{print $1}' | sort | uniq -c` (zero course files
   touched), a grep proving `app/` never references `examples/`, and a check that the
   npm deps served only the course. That turned a vague naming complaint into a
   provable claim: the name described nothing in the tree.

   Two caveats a re-runner needs. Those counts describe **`HEAD`, and `HEAD` was `main`**
   (`git branch --show-current`) — run from a feature branch the number differs, and the
   command alone doesn't establish which branch the commits sat on. And the commands are
   **no longer runnable as written**: dropping the `upstream` remote deleted the ref they
   compare against. Today's equivalent is
   `git rev-list --count 656ad9f..pre-studydeck-rename` (still 51), where `656ad9f` is
   the last upstream commit and the tag is `main` at rename time. Worth noting that the
   act of acting on the evidence destroyed the ability to reproduce it — when a
   migration removes a remote, capture the numbers against a tag or SHA before you cut
   it loose.
2. **Separate the label from the identity, and say which one is broken.** The name was
   wrong *because* a self-contained product was living inside someone else's course.
   Renaming alone would have left the course in the root — the confusion survives.
3. **Ask only the questions whose answers change the work.** Three: how far to go, what
   to call it, which path-keyed stores to migrate. Everything else was inferable.
4. **Re-verify the premises of your own recommendation.** The argument for a fresh repo
   leaned on escaping a fork banner. `gh repo view --json isFork` returned `false` — it
   had been cloned, never forked. The benefit didn't exist, so the recommendation
   flipped to renaming in place, which also preserves PRs, review threads, and a URL
   redirect that makes stale references *follow* you instead of silently resolving to a
   frozen copy.
5. **Sequence by blast radius, cheapest reversal first.** Remove the stale worktree and
   tag a rollback point → resolve the open PR that owned a file being rewritten → rename
   on GitHub → strip and rewrite behind a PR → **rename the local directory last**, so
   the shell never loses its cwd mid-run.
6. **Treat path-keyed stores outside the repo as part of the blast radius.** A directory
   rename orphans anything keyed by absolute path, and it fails *silently*: the
   auto-memory directory (`~/.claude/projects/-Users-...-<name>/memory/`) and two
   separate gstack keys. Nothing errors — the next session just starts amnesiac. A bare
   `ls | head` had also hidden the second gstack key; only `ls -d *pattern*` found it.
7. **Verify by driving, not by reading the diff.** Tests from the new path, real server
   boot, `/api/state` returning both topic trees, sidecar data intact, videos present.

## The judgment calls

- **Kept `models/` (1.7 GB) and `.env`** though both were course-only and git-ignored. A
  rename has no business destroying a large download or a credential file; flagged them
  instead and let the human decide. *(See the postscript — the "credential" wasn't one.)*
- **Left the session transcripts under the old path slug**, including the running
  session's own. Moving a file that's being written to is how you lose it, and an
  archive that renames itself starts lying about where the work happened.
- **No history rewrite.** The course's commits remain in the log. Severing them would
  have bought cosmetics at the cost of every existing SHA.
- **Merged the open PR first rather than rebasing over it.** It touched exactly the file
  being rewritten; landing it first preserved the work and avoided inventing a conflict.
- **Didn't commit `.agents/`, didn't edit a dated audit doc in another repo.** Both are
  adjacent, neither is a rename.
- **Refuted a review-bot finding instead of complying.** CodeRabbit reported `.DS_Store`
  missing from `.gitignore`; it was on line 14 and `git check-ignore -v` proved it
  active. Its sibling finding (a missing `engines` field) was real and was implemented.
  Verify each one — a confident bot is still a hypothesis.

## What the rename incidentally exposed

Three latent defects, none of them naming problems:

1. **`main` was never actually protected**, though `CLAUDE.md` said "Never commit to
   `main` — it's protected" and the Ironclad workflow assumed it. `gh api
   repos/<o>/<r>/rulesets` returned `[]` and `gh api
   repos/<o>/<r>/branches/main/protection` returned `404 Branch not protected`. Every
   commit `main` had accumulated to that point landed on an honor system. Fixed by
   creating the `protect-main` ruleset; `gh api repos/<o>/<r>/rules/branches/main` now
   returns `["deletion","non_fast_forward","pull_request"]`.
2. **The `CLAUDE.md` truth table cited a path that does not exist** —
   `app/../cockpit/attempts.jsonl`. The real location is
   `.learn/topics/<slug>/cockpit/attempts.jsonl` (`find . -name attempts.jsonl`).
3. **`tasks/study-flow.md` Step 8b, marked ACTIVE**, instructed you to implement each
   concept as "the next numbered example in `ai-agents-from-scratch`" — a target being
   deleted in the same change. Amended to practice mode, with the amendment flagged
   inline rather than silently redesigned. Both versions:
   `git show pre-studydeck-rename:tasks/study-flow.md | grep -A4 '^### Step 8b'` against
   `grep -A3 '^### Step 8b' tasks/study-flow.md`.

Touching every reference to a name is a full read of the documentation, which is why
renames surface rot that nothing else does. Note the shape all three share: a document
asserting a property that was never true, or stopped being true, with nothing checking
it. Prose cannot fail a test.

## The reusable rule

**Before renaming anything, prove what actually depends on the name — inside the tree
with greps for real references, and outside it in the path-keyed stores that break
silently rather than loudly. Every inherited claim about the setup, including one you
made five minutes ago, is a hypothesis until a command confirms it.**

## Postscript: the rule caught its own author

This note originally described `.env` as holding "a live API key," and that claim reached
a PR body and three summaries. A review bot challenged it, and checking the **value**
rather than the **key name** showed `OPENAI_API_KEY=your_api_key_here` — 17 characters,
byte-identical to the placeholder in the `.env.example` that had just been deleted. No
credential existed. Nothing needed rotating.

The inference came from the variable's name, and redacting the value before reading it
is what kept the mistake alive: masking output protects secrets from the transcript, but
it also hides whether there *is* a secret.

The safe check is a **positive match against something known-inert**, not a guess at what
a key looks like. Here that was decisive: the value was byte-identical to the placeholder
in the repo's own `.env.example` (`[ "$V" = "your_api_key_here" ]`), and
`git log --all --full-history -- .env` confirmed the file was never tracked. Both compare
against a known quantity and neither prints the value.

Resist the temptation to invert this into a shape rule. Length and prefix are a **triage
hint at most** — OpenAI alone ships `sk-proj-`, `sk-svcacct-`, and `sk-admin-` formats of
differing length, and other providers share none of it, so "doesn't look like a key" is
not evidence of anything. Anything that isn't a positive placeholder match is sensitive
until a provider control says otherwise, and that check belongs to the human who owns the
account, not to a shape heuristic in a note.

**Corollary to the rule above: `KEY_NAME=` is not evidence of a key, and redaction is a
transcript-safety measure rather than an inspection — but the fix is to prove a value is
inert, never to infer from shape that it's harmless.**
