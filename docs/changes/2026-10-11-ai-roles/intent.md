---
change: 2026-10-11-ai-roles
status: accepted
track: T2
author: james
accepted_by: james
linear: pending
source: conversation
---
# Intent: the four missing AI learning roles

## Problem

James, 2026-10-11: "Use the design and logic from this video to update the Studydeck
app." The video is <https://youtu.be/FSXHk4hMrY8>.

The video's argument is that learning comes from production (recalling, predicting,
explaining, doing) and that an AI can play ten roles in support of it, nine of them on
the production side. Compared against what the cockpit does today:

| Role | Today |
|---|---|
| Mapmaker, Examiner, Checker, Listener, Clerk | Built (curriculum, Test Center, Practice Lab, Teachback and Mind Map, debrief to cards) |
| Explainer | `/learn:explain` in an agent session |
| Interviewer | Missing. A new notebook starts as an empty topic; nothing asks what the goal, level or test conditions are. |
| Socratic questioner | Missing in the app. Step 7 is a manual session in claude.ai voice mode with a pasted capture-back. |
| Diagnostician | Missing. Confident misses become per-item misconception candidates, but nothing looks for the misunderstanding several misses share. |
| Sparring partner | Missing. Nothing simulates a timed, adversarial exchange. |

So four of the ten roles cannot be done inside StudyDeck. Three of them need a
back-and-forth conversation, and the app has no conversational surface: every model
call it makes today is one-shot.

## Proposed outcome

From the cockpit, on any topic, James can:

1. **Be interviewed** before studying: the app asks about goal, current level and how
   he will be tested, one question at a time, and ends with a written summary he
   confirms.
2. **Be questioned Socratically** on a concept: the app asks, never hands over the
   answer, and follows up on what his reply exposes.
3. **Spar**: a role-played counterpart (interviewer, examiner, sceptical colleague)
   pushes back on his answers, with a per-answer timer he sets.
4. **Get a diagnosis**: one request reads his recorded misses for a topic and returns
   the misunderstandings they appear to share, each tied to the misses that support it.

Every session ends in something recorded. James can pick stumbles from a session and
turn them into flashcards; those cards carry the session as their provenance. A
confirmed interview summary is stored, can be revised, and is fed into later role
prompts for that topic. It never changes the curriculum or mastery by itself.

A diagnosis is a set of hypotheses, in the same sense the cockpit already treats a
confident miss as a misconception *candidate*. Each one can be rejected, and "not
enough evidence" and "no shared pattern" are valid results.

## Affected users and systems

- James, the only user.
- `app/` server and browser code; a new `cockpit/` sidecar file per topic.
- **Anthropic's Claude API** — a new external service. The app has been local-only.
- Open Notebook, read-only, as the source of excerpts.
- `CLAUDE.md` (a new external-service entry and the rule changes below),
  `tasks/study-flow.md` Step 7 marker, `tasks/roadmap-2026-07-30.md` D3.

## Constraints

Decided by James in this session:

- **All four roles are in scope.**
- **The multi-turn roles run on the Claude API**, not the local model. One Socratic turn
  was timed on each local model before the choice: `gemma4:31b-mlx` 32 s wall,
  `qwen2.5:7b-instruct` 4 s of which 3.3 s was load. One sample each; not a benchmark.
- **Raw `fetch` against `POST /v1/messages`, no SDK.** Hard rule 5 stands: zero runtime
  dependencies, and `npm test` passes with `node_modules` absent.
- **What may be sent to Anthropic:** bounded notebook source excerpts; the topic's miss
  history; and the session's own content, meaning James's replies, his interview
  answers, a confirmed interview summary and the earlier turns of that session. Nothing
  else. The whole request is bounded, not only the excerpts.
- **All four roles run on Claude**, the Diagnostician included.
- **The key comes from an environment variable** read at boot.
- **Only summaries and findings are committed.** Confirmed interview summaries, session
  outcomes and diagnosis findings live in the committed `cockpit/` sidecar. Full
  conversation transcripts are kept on the machine so a session survives a refresh or
  a restart, and are kept out of git.
- **Each session has turn, input and output limits and a spending limit.** No monthly
  accounting.

From the repository's hard rules:

- Rule 6: the API key is read server-side at boot, is never committed, never appears in
  a response or a log line, and never reaches the browser. James supplies it; the agent
  does not handle its value.
- Rule 7, in two parts that are tested differently. Enforceable: the app never puts a
  stored deck answer or a fact-check truth into a request or a response for a role.
  Behavioural: the Socratic role is instructed not to hand over answers, which a prompt
  can ask for and a test cannot prove.
- Rules 8 and 9: session records are written atomically, and every appending request
  carries a `mutation_id`. Deduplicating a record is not the same as not paying twice:
  a retried turn must not make a second API call, and two replies to the same turn must
  not both be accepted.
- Open Notebook is read-only for this change. Session cards reuse the local card
  drafting and storage, not `/api/debrief`, which writes a note to Open Notebook.
- Rule 12: the new routes sit behind `guard.mjs`, and no response carries a CORS header.
- `.learn/` keeps learn-anything's schema; session data lives in `cockpit/`.
- Precedent from Practice Lab and Teachback: a session is activity evidence. It does
  not change mastery and does not complete a schedule stage.
- "Being DOWN is our behaviour": with the API unreachable or the key absent, a route
  that needs Claude to generate something answers 503 naming the service, and what
  James typed is kept. Reading a saved session, confirming or revising a summary and
  closing a session need no provider and keep working, as does the rest of the cockpit.
  Tests assert what the app sends, using a recorder stub; none asserts what Claude
  returns.
- A model response is never parsed as trusted JSON, and a diagnosis is never invented
  from output that cannot be parsed. Every attempt a finding cites is checked against
  what was actually sent; a finding citing anything else is dropped.
- A diagnosis uses folded, final attempts only. An attempt recorded today holds the ids
  of missed questions, not their text, so a miss whose question can no longer be
  recovered faithfully is left out rather than guessed at.
- The interview has to work on a topic that has no concepts and no sources yet.

## Out of scope

- Voice input or output for any role.
- Changing the five roles that already exist.
- Reorganising navigation or the Today view around the ten roles.
- Anki or FSRS export, and the other Phase 2 items that stay gated.
- Moving essay grading or card drafting off the local model.
- The video's two rules that have no role: "redo it without help" after an explanation,
  and an Examiner that gets harder until a miss and then reports a level. Each needs
  its own learning and assessment policy; a later change.
- Roadmap D3's voice agent. A text conversation does not replace the walking and voice
  workflow, so that item stays judgment-gated.

## Success signals

- `npm test` passes on Node 22 and 24 with `node_modules` absent, including new tests.
- A recorder-stub test for each role shows the outbound request carries the system
  prompt for that role, the bounded excerpts and no field holding a deck answer.
- A test asserts the API key appears in no response body, no response header and no
  server log line, on the success path and on the error path.
- With the API base URL pointed at a closed port and a fake key set, each generating
  route returns 503 naming the Claude API, a saved session can still be read, and
  `/api/state` still returns 200.
- Tests cover a malformed model response, a timeout, a replayed turn and two concurrent
  replies to one turn. In the replay case the recorder sees one outbound request.
- Driven against a copy of `.learn/` (`STUDYDECK_LEARN_ROOT`), in the browser: an
  interview, a Socratic session and a sparring round each run at least three turns; the
  page is reloaded after turn two and the session continues from turn two.
- After those sessions, `git status` in the copy shows the summary and outcome records
  and no transcript file.
- A diagnosis for a topic with recorded misses lists each finding with the attempt ids
  that support it, and every id is one that was sent; for a topic with no misses it
  says so and the recorder sees no request.
- A short written acceptance script, run by James against the live API, records for
  each role whether the questioning followed up on his reply and whether an answer was
  handed over. This is the only check on behaviour; the tests above cannot make it.
- Screenshots of the chat surface in both themes, compared against the approved
  variant-C shell.

## Open questions

1. Which Claude model is pinned, and at what effort? To be chosen by a small trial per
   role, not from the two local timings above, which say nothing about Claude.
2. What are the numbers for the per-session turn, input, output and spending limits?
3. When does a sparring timer start and what happens when it runs out, given that the
   model's own reply time and a backgrounded tab both distort it?
4. The visual walkthrough of the video never finished rendering. The chat surface
   follows the approved variant-C shell; alignment with anything shown in the video is
   unverified.
5. No Linear project exists for this repository. `linear:` stays pending and no project
   is created to fill the field.
