---
change: 2026-11-08-roles-cost-and-health
track: T1
status: accepted
intent: ./intent.md
linear: pending
---

# Plan: role-session cache lifetime, cache-write price, health probe detail

Source: commits `31c2fef`, `f419a4d` and `b4877eb` from the 2026-10-11 Roles work,
rebuilt on current main as test-first then fix.

## Files that change

- `app/test/claudeegress.test.mjs`, `app/test/rolesessions.test.mjs` (tests first)
- `app/lib/claude.mjs` (health error detail)
- `app/lib/sessions.mjs` (`ttl: '1h'`)
- `app/lib/config.mjs`, `app/cockpit.config.json` (`cacheWrite: 8`)
- `.claude/rules/external-services.md` (what the live sessions confirmed)
- `learnings/2026-10-11-a-paid-conversation-fails-at-its-edges.md`

## Order of work

1. Commit the three new or changed tests alone.
   → verify: each fails against main's code (TTL assertion, price assertion, health detail).
2. Commit the health-probe fix.
   → verify: the health test passes.
3. Commit the TTL, price table and rules-file change.
   → verify: both session tests pass.
4. Commit the learnings note.
   → verify: `npm test` green with `node_modules` absent (hard rule 5).

## Risks

- `cockpit.config.json` and `config.mjs` both carry the price. The test reads the loaded
  config, so a mismatch between them shows up as a failure, not a silent wrong meter.
- Redaction: the health message echoes upstream text, which can contain the key. The test
  feeds the key back in the API's message and asserts it never reaches the response.

## Proof

- `npm test` output with the three tests named, before (fail) and after (pass).
- `rg -n "ttl: '1h'" app/lib/sessions.mjs` and the two `cacheWrite: 8` lines.

## Options not taken

- Keeping the five-minute cache and refreshing it with a keep-alive request: that spends
  money while the learner is idle, which is exactly what the session limit exists to stop.

## Deviations

- **Cache writes priced by reported lifetime (added after Codex review, P2).** One global
  one-hour price over-charged sessions saved before the change, which replay a five-minute
  policy. `estimateCostUsd` now prices `usage.cache_creation`'s five-minute part at
  `cacheWrite` and everything else at the one-hour `cacheWrite1h`. The price table is merged
  key by key so an older config cannot leave a price undefined. Test first: `8d5acf6`,
  fix `27031d0`.
- **`cacheWrite` keeps its five-minute meaning (Codex re-review, P2).** The first version
  of that fix redefined `cacheWrite` as the one-hour rate, so a legacy config's
  `cacheWrite: 5` was read as one hour and under-counted. The one-hour rate is now its own
  key, `cacheWrite1h`, and the intent's "cacheWrite is the one-hour rate" reads as
  "`cacheWrite1h`". `app/test/pricetable.test.mjs` starts from main's price table. Test
  first: `28b7c0d`.
