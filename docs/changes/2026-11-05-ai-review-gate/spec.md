---
change: 2026-11-05-ai-review-gate
track: T3
status: accepted
---

# Spec

## R1: kit
`bin/review-pr.sh` and `bin/blast-radius.py`, copied from sovereign-forge `origin/main` @
`4e4d947`. Their git blobs (`0935d37aa347…`, `0506457d6506…`) are the ones
`bin/check-gate-kit.sh` reports as current.

## R2: workflow
`.github/workflows/ai-review.yml` is `project-template`'s current workflow. Only the header
and the standards range differ (checked with `diff` against the template):
- `pull_request_target`; runs only when `server_url` is the forge, `base_ref == 'main'` and
  `vars.AI_REVIEW_ENABLED == 'true'`.
- `runs-on: arm64` (the single-slot review lane), `timeout-minutes: 70`.
- Gate scripts materialised from `origin/main` into `$RUNNER_TEMP`, failing closed if absent.
- Checkout pinned to an action SHA. Event values reach `run:` only through `env:`.
- It lives in `.github/workflows`, because adding `.forgejo/workflows` would silently stop
  `test.yml` and `secret-scan.yml` running.

## R3: standards
`STANDARDS_BEGIN='^## Hard rules'`, `STANDARDS_END='^## NEVERMATCH$'`. The extractor only
takes `- **` lines, so the 12 hard rules move from `N. **…**` to `- **N. …**`. Their numbers
stay in the text, so the "rule 9" / "hard rule 11" references across the code still resolve.
Measured with the kit's own awk: 24 standards before (all 12 hard rules missing), 36 after.

## Concerns flagged

- **Standards come from `main`.** The reformat only takes effect once this PR merges, so the
  first gated PR is the first one judged against all 36.
- **The bootstrap PR is unreviewed by the gate.** It gets a Codex adversarial review
  instead (posted on the PR), plus James's manual merge.
- **A total request budget, not per-standard truncation, bounds what the reviewer sees.**
  At 12,752 bytes these are the longest standards in the fleet that I measured, so watch
  the first verdicts for "context degraded" notes.
- **Codex challenge (gpt-6.1-sol, 2026-11-05): 1 P1, 2 P2. All confirmed in the code, and
  none is introduced by this branch.** The kit is byte-identical and the workflow matches
  the template, so all 25 existing consumers have the same exposure.
  - *P1: the verdict author `forgejo-actions` is shared with every workflow's token*, so a
    compromised action anywhere in the repo could post a forged PASS. **Mitigated here:**
    `test.yml`'s two mutable `@v7` tags are now SHA-pinned, so every action in this repo is
    pinned and `test.yml` installs nothing else (rule 5). **Root cause is upstream:**
    `forge-pr` trusts the comment author rather than evidence the ai-review job wrote it
    (for example, its commit status at the same head).
  - *P2: `review-pr.sh` compares `"$VERDICT" = "pass"` case-sensitively*, so a broker that
    returned `PASS` would skip every coverage check and still render a PASS. Upstream only:
    the kit is never edited here.
  - *P2: if `main`'s CLAUDE.md is unreadable or empty, `review-pr.sh` falls back to the
    PR's copy*, the standards the PR itself controls. Upstream only, same reason.
- **#111 and #112 were cut before this lands.** Per sovereign-forge, the gate that reviews
  a PR is the one on `main` for `pull_request_target`, so they get gated once rebased or
  re-triggered after this merges.
