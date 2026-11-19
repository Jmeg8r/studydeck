---
change: 2026-11-05-ai-review-gate
track: T3
status: accepted
---

# Plan

1. Copy the kit byte-identical. → verify: git blob hashes equal sovereign-forge's.
2. Workflow from project-template. → verify: YAML parses locally; `diff` against the
   template shows only header + standards; no `${{ }}` inside any `run:` block.
3. Reformat the hard rules. → verify: the kit's awk extracts 36 (was 24); rule 9 arrives
   whole; `AGENTS.md` is still a symlink.
4. `npm test`, `npm run verify`, the pre-push hooks. → verify: all green.
5. Codex adversarial review (T3), posted on the PR.
6. James sets `BROKER_TOKEN` and `AI_REVIEW_ENABLED=true`, then merges this PR in the UI.
7. Re-trigger #111 → verify: a `forgejo-actions` "Local AI review" comment at its head,
   and `forge-pr status 111` no longer BLOCKED for lack of a verdict.
