---
paths:
  - "app/test/**"
  - "app/lib/oncontract.mjs"
  - "app/verify.mjs"
---

# Testing against services we don't control — full notes

Moved out of `CLAUDE.md`, which keeps the core rule under *Being DOWN is our behaviour; being
UP is theirs*. Claude Code loads this file when it works on tests, `app/lib/oncontract.mjs`,
or `app/verify.mjs`; any other agent should read it before writing or changing a test that
touches Open Notebook (ON) or ollama.

## The one carve-out to "no test asserts ON's response shape"

Stated here because the rule as written is absolute and a reviewer was right to flag the
collision: `app/test/oncontract.test.mjs` contains literal source-shaped payloads. It is
testing the **drift checker**, and they are *inputs to a pure function*, the way a string is
an input to a parser — nothing there calls ON, and nothing there goes stale when ON changes.
Apply the rule's own test before allowing another exception: **would an upstream change make
this file fail?** For a response fixture the answer is yes, and it is forbidden. For
`oncontract.test.mjs` the answer is no — the checker still has to classify a changed payload
as drifted, which is precisely what it asserts. The knowledge of ON's current contract lives
in `lib/oncontract.mjs`'s `FIELDS` table, deliberately in `lib/` and not in a test, because
that is the thing `npm run verify:live` exists to re-check against reality.

## The rule forbids asserting what THEY return, not what WE send

A distinction that got conflated once and cost a real gap. A stub wearing ON's URLs whose
assertions are all over the *outbound request list* tests this repo's own behaviour, and
outlives an upstream shape change the way a response fixture cannot. That is why
`app/test/batchegress.test.mjs` can pin the guarantee behind `generate-batch`'s
`dry_run: true` — that a preview sends no DELETE and no generate — without pinning a single
ON payload. Two rules travel with it:

- **The fixture is the dangerous case:** its episode is deletable and its source is a retry
  target, so a preview has something to destroy if the early return ever moves below the
  mutating code.
- **Every "nothing was sent" assertion carries a control** that runs the same fixture
  *without* the flag and requires the DELETE and the generate — otherwise the silence also
  passes for a request that never reached the mutating code at all. That control earned
  itself immediately: on its first run the stub was matching raw pathnames while the client
  percent-encodes ON ids (they contain a colon), so the source-detail GET 404'd and the
  supposedly real run answered 202 having generated nothing.

What this still cannot catch, and the file header says so: the stub has to *serve* something
source-shaped to get the route as far as the code under test, so if ON's `/api/sources`
drifts, these tests keep passing while the real route 400s on an empty notebook first.

## `npm run verify:live` is the instrument for that gap

It probes the live shape (`lib/oncontract.mjs`). It is opt-in and separate from
`npm run verify` because everything else in that check is local, offline and instant, and a
default that needs ON running would report an outage as an integrity failure. It reads
`drifted` or `degraded` (a field that went missing but that nothing throws on) → exit 1,
`unreachable or empty notebook` → exit 2, which wins over 1 when both occur because an
incomplete run is worth less than its findings: an empty list is *both* what a
genuinely empty notebook returns and what drift looks like from outside, so it is reported as
indeterminate and never as clean. This inverts the "no ON stubs" rule rather than breaking
it — a diagnostic whose success condition IS noticing that upstream changed, exactly like
`/api/on/health` answering 200 with `reachable: false`. **Keep it out of the test suite; the
suite must pass with ON down.**

## The Claude API follows the same rule

`claudeegress`, `rolesessions` and `diagnosisegress` are recorders: they assert what this app
SENDS to the Claude API, how many times, and what it WRITES — never the shape of a reply.
Two things are specific to them. A paid API makes "how many requests" the assertion that
matters, so replay, retry and concurrency cases count outbound requests, each with a control
that requires a send. And the fixtures plant what must never be sent — a deck answer, a
fact-check truth, the answer to a question never attempted — then assert its absence from the
raw request body. As with the others, a stub must serve something message-shaped to get a
route to the code under test; if the Messages API envelope moves, these keep passing and the
real call breaks.

## Still on manual verification

The list is now short: `/api/on/*` routes that no `app/test/*egress.test.mjs` recorder drives
(recorders cover generate-batch's pre-commit half, `podcast/generate`, `notes`,
`speaker-profiles` and `source-search` — what this app SENDS, not what ON returns — and
`media.test.mjs` drives `episodes/:id/audio`: ranges, HEAD, deadlines, which headers cross),
`/api/tts/*`, and the half of `/api/on/podcast/generate-batch` that actually renders. What
the batch does *before* it commits to anything is covered; what comes back from a real
render is not.

**Every Roles route against the real Claude API** is also manual: nothing in the suite calls
it. The checks are written down in `docs/changes/2026-10-11-ai-roles/acceptance-script.md`,
including the only check on whether a role *behaves* as instructed, which no test can make.

`/api/grade`, `/api/debrief` and the mind-map note push came OFF this list once the recorder
technique was extended to ollama — their success paths are driven in `gradeegress`,
`debriefegress` and `mindmapegress`. Note precisely what that does and does not buy: those
files pin **what this app sends and writes**, so they survive an upstream shape change, but a
stub must still *serve* something to get a route as far as the code under test. If ON changes
the shape of a created note, or ollama's chat envelope moves, they keep passing and the real
route breaks. Every one of those files says so in its own header — **extend the pattern, don't
quietly widen the claim.**
