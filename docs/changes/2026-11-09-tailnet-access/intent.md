---
change: 2026-11-09-tailnet-access
status: accepted
track: T3
risk: high
risk_reason: This changes who the cockpit answers. A boundary that admits the wrong caller lets them read the learning record and write attempts, grades and cards into it, and under hard rule 7 an unauthorized write is already the damage.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the cockpit answers James over his tailnet, and no one else

## Problem

In James's words today: "Yes, fix tailnet access", after a check showed the cockpit
cannot be reached from his other devices.

The pieces outside the repo are already in place:

- Tailscale Serve publishes `https://<machine>.<tailnet>.ts.net:4310`
  (tailnet only) and proxies it to `http://127.0.0.1:4310`.
- The LaunchAgent sets `STUDYDECK_TAILSCALE_ORIGIN` and `STUDYDECK_TAILSCALE_USER`.

Nothing on `main` reads either variable. `app/lib/guard.mjs` (hard rule 12) accepts only
a loopback `Host`, and Serve forwards the tailnet name as `Host`, so every request through
it is refused. Probed 2026-11-09: over the tailnet `/api/health` answers
`403 {"error":"this server answers only to a loopback Host"}`; on loopback it answers 200.

The code that would read those variables exists only in PR #98's unmerged September
snapshot (`264547c`, `app/lib/guard.mjs`), mixed into an 81-file change.

## What changes

- When both variables are set, the guard accepts one more `Host`: exactly the host of
  `STUDYDECK_TAILSCALE_ORIGIN`. A request carrying it must also carry
  `Tailscale-User-Login` equal to `STUDYDECK_TAILSCALE_USER`, on every method, GET
  included. On mutating requests its `Origin`, when sent, must equal that HTTPS origin.
- Loopback behaviour is unchanged, and the server still binds `127.0.0.1` only (hard
  rule 5). Binding is what keeps the identity header honest: only Serve, on this machine,
  can deliver a request carrying the tailnet `Host`.
- One variable without the other, or an origin that is not a bare `https://` origin,
  stops the server at boot. A half-configured boundary must not quietly fall back to
  loopback-only or widen to host-only trust.
- The boot summary says whether tailnet access is on and for which host, never the user.
- Hard rule 12 in `CLAUDE.md` is rewritten to state the second door and why it is safe,
  since the AI-review gate reads its standards from that file.

## Out of scope

- The rest of PR #98's snapshot.
- Links to Open Notebook's own UI (`http://127.0.0.1:8502` in `main.mjs` and
  `reading.mjs`) still point at loopback, so they will not open from another device.
- Changing the Tailscale Serve configuration or the LaunchAgent. Both stay James's to run.

## Done when

- Tests, committed before the fix and seen failing: the configured tailnet `Host` with the
  configured user is accepted; the same `Host` with a missing or different user, or a
  different tailnet `Host`, is refused with 403; a mutating request from the tailnet with
  a foreign `Origin` is refused; loopback behaviour is unchanged; half or malformed
  configuration fails at boot.
- `npm test` passes with no install; Codex, an adversarial review (T3) and the AI-review
  gate pass; James approves the merge.
- After James restarts the cockpit: over the tailnet `/api/health` answers 200, and a
  request with a forged `Tailscale-User-Login` for someone else is still answered as
  James or refused, never as the forged user.
