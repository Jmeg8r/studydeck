# A paid conversation fails at its edges

**Date:** 2026-10-11
**Context:** StudyDeck cockpit — the Roles view (Interviewer, Socratic questioner, Sparring
partner, Diagnostician) on the Claude API. Change `2026-10-11-ai-roles`, PRs #105 to #108.

## The problem

Add multi-turn conversations with a paid API to a local app whose every earlier model call
was one-shot, without ever billing a turn twice, losing a reply, or leaving a session stuck.

## The approach

1. **Decide the write order before writing any code.** The learner's turn is stored before
   the model is called, and the reply is stored before it is returned. A retry then finds
   the turn on disk and knows exactly what it owes: the stored reply (no call) or the one
   call that never landed. A `mutation_id` alone does not do this. It deduplicates a
   *record*; it does nothing about a *charge*.
2. **Put the one money check where every call passes through it.** A single `advance`
   function makes every model call and checks the spending limit first. A limit checked only
   where new turns arrive is bypassed by every other path that calls the model.
3. **Count outbound requests, with a control.** For a paid API "how many requests went out"
   is the assertion that matters. Every "nothing was sent" test sits beside one that
   requires a send, or the silence also passes for a request that never reached the client.
4. **Break each guard on purpose.** With the per-session queue disabled the concurrency test
   still passed. Two *different* replies were already refused, because the first turn is
   written before the first `await`. The queue's real job was stopping a *duplicate* request
   from paying twice, and no test covered that until this check exposed it.
5. **Treat a hang as a failing test.** The unbounded-body-read bug showed up as a test run
   that never finished. That is a legitimate "watch it fail first", and it is why the fix
   reads the response body inside the same deadline as the headers.
6. **Drive the UI against a stand-in, and say what that proves.** A local stub returning
   placeholder text, on a copy of the data, showed the plumbing and reconciled the cost
   meter by hand. It shows nothing about how the model behaves, and the PR said so.

## The judgment calls

- **No SDK.** `fetch` only, to keep zero runtime dependencies and a CI with no install step.
  The price was owning retry and error mapping, and one bug an SDK would have hidden: Node's
  `fetch` quotes a rejected header *value* in its error text, so a key with a stray newline
  was echoed to the browser. Fixed by shape-checking the key and reporting transport
  failures by error code only.
- **Fix the class on the second finding, not the third.** Review found "a waiting turn
  cannot be resumed", then "a waiting *opening* cannot be resumed". The second was answered
  with one resume route that finishes any waiting turn, not another per-kind patch.
- **Stop the review loop at four rounds.** Every finding was real, but they were arriving
  one at a time at a shrinking rate. The gate on the PR was left to be the next look.
- **No model drafts a flashcard's answer.** The spec said "local card drafting"; that would
  have had a model invent the correct answer from a stumble. The learner writes the back.
- **Leave a miss out when its question text cannot be trusted.** Attempts store the ids of
  missed questions and a deck hash, not the text. A miss is used only while the deck still
  matches. On real data that made *every* existing miss ineligible, which was reported, not
  worked around.

## What it cost to find

Six real defects surfaced in review, none in the main turn path. All were at a session's
edges: closing while a turn was in flight, retrying after close, a summary draft bypassing
the limit, a billed reply with no text, and the two resume gaps. The spec had described the
happy path and the double-billing case and left the edges unstated, so review found them
one by one.

## The transferable rule

**For anything stateful that costs money, list the edges before the happy path** (start
fails, close races, retry after close, reload mid-flight, a response that is billed but
unusable) **and for each ask two questions: what is on disk now, and what does a retry
buy?** Then prove each answer by counting outbound calls with a guard deliberately broken.

Corollary: **when review finds the same shape twice, the first fix was instance-shaped.**
Replace it with one mechanism that covers the class.

## See also

- `docs/changes/2026-10-11-ai-roles/` — intent, spec, plan (with its Deviations) and the
  live acceptance script, which had not been run when this was written.
- `app/lib/sessions.mjs` — the write order, the queue and `advance`.
- `learnings/2026-07-28-responses-that-outrun-the-disk.md` — the same disk-versus-response
  discipline for one-shot writes.
