---
change: 2026-11-09-tailnet-access
status: accepted
track: T3
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [spec]
claude_config_sha: d0fbd0f
---
# Spec: the cockpit answers James over his tailnet, and no one else

## Flagged concerns

1. **Policy not yet applied: `security-review` and `gstack-cso`.** Both review code on a
   branch; at spec time there is no code. Source: /spec step 2. Recommended resolution:
   apply them to the implementation, alongside the T3 adversarial review, before the PR is
   opened, and record the result in plan.md's Proof. *James's resolution: apply both to the implementation before the PR, with the adversarial review; results go in plan.md's Proof.*
2. **Serve's handling of a client-supplied `Tailscale-User-Login` is taken from Tailscale's
   documentation, not observed here.** The design trusts that header only on requests
   carrying the tailnet `Host`, which only Serve on this machine can deliver (R6). If Serve
   passed a client's own copy through, anyone on the tailnet could claim to be James.
   Source: T3 risk floor. Recommended resolution: live acceptance check A7 sends a forged
   value through Serve and must not be answered as the forged user; the change is not
   called done without it. *James's resolution: A7 is a hard condition. The change is not done until a forged login is shown not to be admitted.*
3. **The exact `Host` Serve forwards is inferred, not observed.** The 2026-11-09 probe
   shows it is not loopback, not its exact text. R2 compares against the origin's host
   *with* its port (`<machine>.<tailnet>.ts.net:4310`), which is what a browser
   sends for a non-default port and what the snapshot assumed. If Serve forwards it without
   the port, the live check A6 answers 403 and the comparison is widened then, under its
   own test, rather than accepting both forms on a guess. Source: T3. *James's resolution: compare with the port included; widen only if A6 shows Serve drops it, as its own tested change.*
4. **Requests from the Mac itself through the tailnet name** may arrive with no identity
   header, depending on how Serve treats its own node. They would then be refused, which
   is safe; loopback still works locally. Recorded so a 403 from this machine during the
   live check is not misread. Source: design. *James's resolution: accepted. Refusing an unidentified request is the safe outcome; on this Mac, use 127.0.0.1.*

## Requirements

- **R1** Tailnet access is configured by `STUDYDECK_TAILSCALE_ORIGIN` and
  `STUDYDECK_TAILSCALE_USER`, read once at boot from the environment, never from the
  committed config. *(intent: What changes, bullet 1; rule 6)*
- **R2** With both set, a request whose `Host` equals the origin's host (case-insensitive,
  port included) is admitted to the remaining checks; any other non-loopback `Host` is
  refused 403 as today. *(intent bullet 1)*
- **R3** A request admitted by R2 must carry `Tailscale-User-Login` exactly equal to
  `STUDYDECK_TAILSCALE_USER`, on every method including GET and HEAD; otherwise 403. The
  refusal does not reveal the expected user. *(intent bullet 1)*
- **R4** On a mutating request admitted by R2, `Origin`, when present, must equal the
  configured origin exactly (`https://…:4310`); otherwise 403. Content-type rules are
  unchanged. *(intent bullet 1)*
- **R5** Loopback requests behave exactly as on `main`, with or without the variables
  set, and a loopback request never needs or reads `Tailscale-User-Login`. *(intent
  bullet 2)*
- **R6** The server still binds `127.0.0.1` only. *(intent bullet 2; rule 5)*
- **R7** Exactly one variable set, or an origin that is not `https:` with no path, query,
  fragment or credentials, makes config loading throw, so the server does not start.
  Neither set means tailnet access is off and the guard is as on `main`. *(intent
  bullet 3)*
- **R8** The boot summary reports `tailnet: off` or `tailnet: <host>`, never the user.
  *(intent bullet 4)*
- **R9** No response gains an `Access-Control-Allow-*` header. *(rule 12)*
- **R10** Hard rule 12 in `CLAUDE.md` states the second door, its two conditions and why
  the bind makes the header trustworthy. *(intent bullet 5)*

## Design

- **`app/lib/config.mjs`**: a pure exported `parseTailnet(env)` returns `null` (neither
  set), throws (R7), or returns `{ origin, host, user }` with `host` lowercased from
  `new URL(origin).host`. `load()` stores its result as `config.tailnet`.
  `configSummary()` adds `tailnet: config.tailnet?.host ?? 'off'`.
- **`app/lib/guard.mjs`**: `assertBrowserBoundary(req)` reads `config.tailnet` at call
  time, not into a module constant, so tests can set it the way they set `learnRoot`:
  - `loopback` = today's check; `tailnet` = `config.tailnet` set and
    `host.toLowerCase() === config.tailnet.host`;
  - neither: 403 as today;
  - `tailnet`: require the user header (R3), then for mutating methods compare `Origin`
    with `config.tailnet.origin` instead of `http://${host}` (R4).
  This differs from the snapshot's version, which read the environment into a module
  constant at import, so its tests could not vary it.
- **`app/server.mjs`**: unchanged apart from printing the new summary field.
- **`CLAUDE.md`**: rule 12 rewritten (R10).
- No browser code changes: the page already uses relative URLs. The Open Notebook UI links
  stay loopback (intent: Out of scope).

## Security and data

- **Trust chain:** the header is believed only because R2's `Host` can be delivered only by
  Serve, which listens on the tailnet and proxies to loopback (R6). A local process can
  already reach loopback directly, so the header gives it nothing new.
- **Browser attacks:** a foreign page cannot set `Tailscale-User-Login` or a JSON body
  without a preflight, and no response answers one (R9). DNS rebinding needs an attacker's
  own name in `Host`, which matches neither door.
- **Secrets:** the user login is not a credential but is still kept out of logs and
  responses (R3, R8). No new secret is introduced.
- **Data:** no change to what is read or written once a request is admitted.

## Acceptance checks

- **A1** `node --test app/test/guard.test.mjs`: tailnet `Host` + right user → admitted
  (GET 200 on `/api/health`, POST reaches the route's 400); wrong or missing user → 403;
  other `.ts.net` host → 403; tailnet POST with foreign `Origin` → 403; tailnet POST with
  the configured `Origin` → admitted. *(R2–R4)*
- **A2** Same file, `config.tailnet = null`: every existing loopback case unchanged, and a
  loopback request carrying a stray `Tailscale-User-Login` behaves as without it. *(R5)*
- **A3** `parseTailnet` unit cases: neither → null; one → throws; `http://`, a path, a
  query, credentials → throws; valid → host lowercased with port. A child `node` process
  importing `config.mjs` with one variable set exits non-zero. *(R7)*
- **A4** No `Access-Control-Allow-*` on tailnet responses, asserted. *(R9)*
- **A5** `npm test` passes with no `node_modules`. *(rule 5)*
- **A6** After James restarts the cockpit: `curl` from another tailnet device, or from this
  Mac if Serve adds its identity, to `https://<machine>.<tailnet>.ts.net:4310/api/health`
  answers 200, and the boot log shows `tailnet: <machine>.<tailnet>.ts.net:4310`.
  *(R2, R8)*
- **A7** The same request with `-H 'Tailscale-User-Login: someone-else@example.com'` is
  answered as James (Serve replaced it) or refused 403, and never admitted on the forged
  value. *(R3; flagged concern 2)*

## Open questions

- The intent carried none.
- Whether Serve forwards the port in `Host` (flagged concern 3) and identifies requests
  from its own node (concern 4): answered by A6 and A7, live, after the restart.
