---
change: 2026-11-08-roles-cost-and-health
track: T1
status: accepted
risk: medium
risk_reason: Changes what a role session pays per turn and what the spending meter charges for it. A wrong price under-reports spend against the session limit; a wrong TTL re-buys the system prompt.
---

# Intent: role sessions cache for an hour, and the health probe says why it failed

## In James's words

> Open a PR for the roles cache fix and learnings note? — Yes, open it

## Why

These fixes came out of the first live Roles sessions on 2026-10-11 and have sat on
local branches with no PR since.

- **Cache lifetime.** A learner who thinks before answering paused longer than five
  minutes on 8 of 13 turns. Each such pause let the five-minute cache expire, so the next
  turn re-bought the whole system prompt at the cache-write price. In the Socratic session
  that was five of six replies.
- **Spending meter.** A one-hour cache write costs 2x input, not 1.25x. If the TTL moves
  and the price table does not, the meter under-reports the first turn of every session.
- **Health probe.** The first live probe got a 400 and reported only "returned 400". The
  API's message said the key was not scoped to a workspace. A bare status cannot tell a
  bad key from a bad model name from a malformed request.

## What done looks like

- A session's system prompt is sent with `cache_control: { type: 'ephemeral', ttl: '1h' }`.
- `pricePerMTok.cacheWrite` is the one-hour rate (2x input) in both `config.mjs` and
  `cockpit.config.json`, and a test ties it to `input` so the two cannot drift apart.
- `/api/roles/health` includes the API's own error message with the key redacted, and
  the key appears nowhere in the response.
- `.claude/rules/external-services.md` records what the live sessions confirmed.
- The approach note `learnings/2026-10-11-a-paid-conversation-fails-at-its-edges.md`
  is on main.

## Out of scope

- The card-draft feature on `feat/roles-card-draft` (its own PR).
- Any change to the spending limit itself or to `advance` in `app/lib/sessions.mjs`.
