---
change: 2026-11-05-ai-review-gate
track: T3
status: accepted
---

# Intent: put studydeck behind the sovereign-forge AI review gate

## In James's words

> Add the gate first

This was his answer when `forge-pr merge 111` refused to merge.

## Why

`forge-pr merge` fails closed without a verdict comment from the gate (`forgejo-actions`,
"Local AI review") at the PR head. studydeck never had the gate: its only workflows are
`test.yml` and `secret-scan.yml`. So no PR here can merge through `forge-pr`, and #102–#109
were merged by hand. `bin/check-gate-kit.sh` lists 25 consumers, and studydeck is not one.

## Constraints that shape it

- **Bootstrap is manual by design.** Under `pull_request_target` the workflow runs from
  `main`, so the PR that introduces it has nothing to run. James merges it in the web UI.
- **Credentials are James's.** He sets the `BROKER_TOKEN` repo secret and the
  `AI_REVIEW_ENABLED=true` variable (the kill switch). Claude does not handle the token.
- **The kit is byte-identical to sovereign-forge.** It is copied, never edited here.
