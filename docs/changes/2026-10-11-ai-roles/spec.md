---
change: 2026-10-11-ai-roles
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [claude-api, design:ux-copy, design:accessibility-review]
claude_config_sha: ceba624
---
# Spec: the four missing AI learning roles

## Flagged concerns

Each concern names its source, a recommended resolution and James's decision.

### F1. The pinned model: guidance and intent disagree

- **Concern.** The intent says the model is chosen by a small trial per role. The
  `claude-api` guidance in force says to use `claude-opus-5-5` unless James names
  another model, and not to downgrade for cost on his behalf.
- **Source.** `claude-api` skill, "Current Models"; intent open question 1.
- **Recommended.** Default `claude-opus-5-5`, set in `cockpit.config.json` under
  `claude.model` so it is one line to change. The trial tunes **effort**, not the model:
  start the three conversational roles at `low` and the Diagnostician at `medium`.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F2. Opus 5.5 always thinks, which fixes how transcripts are stored

- **Concern.** On `claude-opus-5-5` thinking cannot be turned off, and each assistant
  turn comes back with thinking blocks bound to the exact conversation that produced
  them: same system prompt, same earlier messages, byte for byte. Replaying a block
  after any earlier edit is a 400 on accounts created on or after 2026-08-31. Two
  consequences the intent did not anticipate:
  1. A transcript must store each assistant turn's `content` array verbatim, opaque
     blocks included, and replay it unchanged. Storing only the visible text is not
     enough to continue a session.
  2. A session's system prompt is frozen when the session starts. Excerpts, miss
     history and the interview summary are read once, at start. Revising a summary
     mid-session affects the next session, not the current one.
- **Source.** `claude-api` skill, `shared/model-migration.md`, "Migrating to Claude
  Opus 5.5", breaking changes 1 and 3.
- **Recommended.** Accept both consequences. They also make every turn after the first
  a prompt-cache hit on the frozen prefix, which lowers cost.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F3. Refusals, and a beta header the account may not have

- **Concern.** Opus 5.5 can decline a request (HTTP 200, `stop_reason: "refusal"`).
  The guidance is to send `fallbacks: "default"` with the beta header
  `server-side-fallback-2026-07-01`. A beta header that is not enabled for the
  organisation returns a 400. Whether James's account has it is unverified.
- **Source.** `claude-api` skill; `shared/error-codes.md`, 400 causes.
- **Recommended.** Send the fallback parameter and header. If the API answers 400
  naming the `anthropic-beta` header, retry that request once without them and note in
  the session record that fallbacks are off. A refusal that survives is shown as a
  turn that could not be answered; the session stays open and nothing is recorded as
  a stumble.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F4. Where transcripts live "outside git"

- **Concern.** The intent says transcripts stay on the machine and out of git. Two
  readings: inside the topic's `cockpit/` directory under an ignore rule, or outside
  the repository. `.gitignore` names each ignored path explicitly, and one wrong
  pattern would commit full conversations to both remotes.
- **Source.** intent constraint "Only summaries and findings are committed";
  `CLAUDE.md` repo conventions.
- **Recommended.** `cockpit/transcripts/<session_id>.jsonl`, ignored by an explicit
  `.learn/**/cockpit/transcripts/` rule with a comment saying why. In-tree keeps the
  `STUDYDECK_LEARN_ROOT` copy-and-drive verification working. A test runs
  `git check-ignore` on a transcript path and fails if it is not ignored.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F5. Which stored answers the Diagnostician may send

- **Concern.** Rule 7 says an answer is revealed only in exchange for a recorded
  attempt. A diagnosis is far more useful if Claude sees the question, what James
  answered and the correct answer. Sending a correct answer for a question he has not
  attempted would be a side door.
- **Source.** `CLAUDE.md` hard rule 7.
- **Recommended.** The Diagnostician may send the question, James's response and the
  correct answer **only for items in a final recorded attempt**, where rule 7 has
  already been satisfied. The three conversational roles never receive deck questions
  or answers at all. Both halves are asserted in recorder tests.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F6. A miss whose deck has changed since the attempt

- **Concern.** An attempt records the ids of missed questions and a hash of the deck
  as it was (`retrieval_evidence.assessment_version`), not the question text. If the
  deck file has been edited since, today's text may not be what he was asked.
- **Source.** `app/lib/evidence.mjs`, `retrievalEvidenceForQuiz`; Codex consult.
- **Recommended.** Include a miss only when the current deck hashes to the recorded
  `assessment_version`. Otherwise leave it out and report the count as "left out:
  deck changed since the attempt". Attempts recorded before the hash existed are left
  out for the same reason.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F7. The limit numbers

- **Concern.** The intent requires per-session turn, input, output and spending limits
  and leaves the numbers open. A spending limit needs prices, and prices change.
- **Source.** intent open question 2.
- **Recommended.** Constants in one module, with these starting values:

  | Limit | Value |
  |---|---|
  | Turns per session | 30 |
  | Characters per learner reply | 4,000 |
  | Source excerpts | the existing `collectSources` bound (1,000 per source, 18,000 total) |
  | Misses sent to a diagnosis | 40, newest first |
  | `max_tokens` per conversational turn | 8,000 (thinking counts toward it) |
  | `max_tokens` for a diagnosis | 16,000 |
  | Spending per session | $2.00 |

  Spend is computed from the `usage` block of each response and a price table in
  `cockpit.config.json` (`claude.pricePerMTok`, not a secret). The session record
  stores token counts as well as the dollar figure, so a stale price table produces a
  wrong estimate that can be recomputed, not a lost fact. At the limit, the session
  accepts no further turn and can still be closed.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F8. Sparring timer semantics

- **Concern.** The intent asks when the timer starts and what expiry does, given that
  model latency and a backgrounded tab both distort it. A time limit with no way to
  extend it also fails WCAG 2.2.1.
- **Source.** intent open question 3; `design:accessibility-review`, "time limits
  without extension options".
- **Recommended.** The timer is set by James per session and can be off. It starts
  when the counterpart's reply has rendered, so model latency is never counted. Expiry
  does not submit, clear or lock anything: the composer stays editable, the turn is
  marked "over time", and he sends when ready. Elapsed time and whether the tab was
  hidden during the turn are reported by the browser and stored as self-reported.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F9. Which environment variable holds the key

- **Concern.** `ANTHROPIC_API_KEY` is the conventional name and is already exported in
  many shells. Reading it would let the cockpit start spending on a key James set for
  something else, without him choosing to.
- **Source.** intent constraint "The key comes from an environment variable";
  `CLAUDE.md` hard rule 6.
- **Recommended.** Read only `STUDYDECK_ANTHROPIC_API_KEY`. Unset means the roles are
  off and say so. `STUDYDECK_CLAUDE_BASE_URL` is the test seam, matching the existing
  `STUDYDECK_ON_BASE_URL` and `STUDYDECK_OLLAMA_BASE_URL`.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F10. Policy not applied: `security-review`, `gstack-cso`

- **Concern.** Both review code or a diff. There is none yet, so neither was applied
  to this spec. The security requirements below come from the repository's own hard
  rules and the Codex consult.
- **Source.** `/spec` step 2.
- **Recommended.** Accept the spec without them and run `security-review` on the
  branch diff during VERIFY, before the Codex gate.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

### F11. No streaming in the first version

- **Concern.** The `claude-api` guidance prefers streaming for long outputs. Parsing a
  server-sent event stream by hand is the largest piece of code a no-SDK client would
  own, and a conversational turn here is short.
- **Source.** `claude-api` skill, "Defaults".
- **Recommended.** Non-streaming requests with a 120-second timeout. The surface shows
  a waiting state for the whole turn. Revisit if turns feel slow in the trial.
- **Resolution.** Accepted as recommended (James, 2026-10-11).

## Requirements

Each traces to the intent section named in brackets.

**Client and configuration**

- **R1.** `app/lib/claude.mjs` calls `POST {baseUrl}/v1/messages` with Node's built-in
  `fetch`, sending `x-api-key`, `anthropic-version: 2023-06-01` and
  `content-type: application/json`. No package is added. [Constraints: raw fetch]
- **R2.** The key is read once at boot from `STUDYDECK_ANTHROPIC_API_KEY`. It appears
  in no response body, response header or log line. `configSummary()` reports
  `loaded` or `MISSING`, never the value. [Constraints: rule 6]
- **R3.** Model, effort per role and the price table come from `cockpit.config.json`
  under `claude`; that file stays secret-free. [Constraints: rule 6]
- **R4.** The client retries 429, 500 and 529 at most twice with backoff, honouring
  `retry-after`. It does not retry 400, 401, 402, 403, 404 or 413. Every failure
  becomes a `ClaudeError` whose message names the Claude API and never includes
  request headers. [Constraints: being DOWN]
- **R5.** The client reads a response by block `type`: text from `text` blocks,
  `stop_reason` before content, `usage` for accounting. A response that is not the
  expected shape is a 502, never a guessed reply. [Constraints: never trusted JSON]

**Sessions (Interviewer, Socratic questioner, Sparring partner)**

- **R6.** A session has a role, a topic, an optional concept, a frozen system prompt
  and an ordered list of turns. Starting one reads excerpts, miss history and the
  topic's confirmed interview summary once. [Proposed outcome 1-3; F2]
- **R7.** The interview starts on a topic with no concepts and no sources. [Constraints]
- **R8.** Each learner turn carries a `mutation_id` and the index of the turn it
  answers. The server persists the learner turn before calling Claude and the
  assistant turn after. [Constraints: rules 8, 9]
- **R9.** A replayed turn whose assistant reply is already stored returns the stored
  reply and makes no API call. A replayed turn whose reply is not stored makes the
  call it still owes. A second, different reply to an already-answered turn index is
  refused with 409. [Constraints: not paying twice]
- **R10.** Reloading the page mid-session restores the conversation from the
  transcript and continues from the last stored turn. [Success signals]
- **R11.** A session stops accepting turns at the turn limit or the spending limit and
  says which. It can still be closed. [Constraints: limits; F7]
- **R12.** Closing a session appends one outcome record to the committed sidecar: role,
  topic, concept, turn count, token usage, estimated spend, and for an interview the
  confirmed summary. It needs no provider. [Proposed outcome; Constraints: 503 scope]
- **R13.** An interview summary is drafted by Claude at close, shown to James, and
  stored only when he confirms it. He can revise it later; a revision appends. The
  latest confirmed summary feeds the system prompt of later sessions on that topic.
  It changes nothing in `state.json`. [Proposed outcome]
- **R14.** From a closed Socratic or sparring session James selects stumbles, and each
  becomes a flashcard in the local card store with the session id as provenance. The
  front is prefilled from the counterpart's question; James writes the back. ~~No model
  drafts it, so no answer is invented.~~ Open Notebook is not written to.
  [Proposed outcome; Constraints] *(Amended at planning, 2026-10-11: was "through the
  local card drafting", which would have had the local model supply the answer.)*
  *(Amended 2026-11-08 by `docs/changes/2026-11-08-roles-card-draft/`, James's decision
  of 2026-10-13: the local model may draft the back on request. The draft arrives locked
  and labelled, says whether sources grounded it, and the card records `back_origin`.
  Writing it by hand is still the default.)*
- **R15.** Sparring takes a counterpart description and an optional per-answer timer
  with the semantics in F8. [Proposed outcome 3]
- **R16.** No session request contains a deck question, a deck answer, or a fact-check
  `truth` or `correction`. [Constraints: rule 7; F5]
- **R17.** A session changes no mastery value and appends no stage event.
  [Constraints: precedent]

**Diagnostician**

- **R18.** One request builds evidence from folded, final attempts for the topic,
  applies F5 and F6, and sends at most the configured number of misses. With no
  eligible misses it answers without calling Claude and says why. [Proposed outcome 4]
- **R19.** The reply is parsed defensively. Each finding must cite attempt ids and
  question ids that were in the request; a finding citing anything else is dropped,
  and the response reports how many were dropped. Unparseable output is a 502 and
  records nothing. [Constraints]
- **R20.** Several misses of one question count as one piece of support. A finding
  resting on a single question is labelled as such. [Codex consult]
- **R21.** A diagnosis is stored as a set of hypotheses, each `open`, `accepted` or
  `rejected` by James through an appended event. "Not enough evidence" and "no shared
  pattern" are stored results. [Proposed outcome]

**Service boundary**

- **R22.** With the key unset or the API unreachable, starting a session, sending a
  turn, drafting a summary and requesting a diagnosis answer 503 naming the Claude
  API, and the learner's typed text is still in the composer. Listing sessions,
  reading one, closing one, confirming or revising a summary and deciding on a
  hypothesis keep working. [Constraints: being DOWN]
- **R23.** Every new route passes through `assertBrowserBoundary`, and no response
  carries an `Access-Control-Allow-*` header. [Constraints: rule 12]
- **R24.** Transcripts are ignored by git; outcome, summary and diagnosis records are
  not. [Constraints: only summaries and findings are committed; F4]

**Surface**

- **R25.** One new view, "Roles", in the Command Rail: pick a role, see past sessions
  for the topic, run a session, request and review a diagnosis. It follows the
  approved variant-C shell and existing tokens in both themes. [Affected systems]
- **R26.** The conversation log is a labelled region that announces new turns to
  assistive technology; every control has a visible label and a visible focus state;
  everything works from the keyboard; contrast meets 4.5:1 for text and 3:1 for
  controls; status banners identify the error in text, not colour alone.
  [`design:accessibility-review`]
- **R27.** Copy follows what-happened, why, how-to-fix for errors, verb-first specific
  buttons, and one term per thing: "session", "turn", "role", "hypothesis".
  [`design:ux-copy`]
- **R28.** Before the first session on a machine, and reachable afterwards, the view
  states what is sent to Anthropic and what is not. [Affected systems: new egress]

**Documentation**

- **R29.** `CLAUDE.md` gains the Claude API under external services and the transcript
  rule under repo conventions; `.claude/rules/testing.md` lists the new recorder
  files and what stays manual; `tasks/study-flow.md` Step 7 and
  `tasks/roadmap-2026-07-30.md` D3 note that text questioning exists and voice stays
  gated. [Affected systems]

## Design

### Components

| File | Role |
|---|---|
| `app/lib/claude.mjs` | The Messages API client: request, retry, error mapping, usage. Mirrors `ollama.mjs`. |
| `app/lib/roles.mjs` | Role definitions: system prompt builders, effort, what context each role may receive. Pure. |
| `app/lib/sessions.mjs` | Session lifecycle, turn ordering, replay rules, limits, spend accounting. |
| `app/lib/diagnosis.mjs` | Evidence selection (F5, F6), request building, finding validation. Pure apart from the client call. |
| `app/lib/sidecar.mjs` | New readers and appenders for `sessions.jsonl`, `diagnoses.jsonl` and transcripts. |
| `app/lib/config.mjs` | The key, the base-URL seam, the `claude` block. |
| `app/router.mjs` | New routes, delegating to the modules above. |
| `app/web/js/views/roles.mjs` | The view. |
| `app/web/js/main.mjs`, `app/web/css/app.css` | One nav entry; chat styles from existing tokens. |

### Storage

Per topic, under `cockpit/`:

- `sessions.jsonl` — committed, append-only. Events: `session_started`,
  `session_closed`, `summary_confirmed`, `summary_revised`, `cards_created`. Folded to
  the latest state per `session_id`, as attempts are.
- `diagnoses.jsonl` — committed, append-only. Events: `diagnosis_recorded`,
  `hypothesis_decided`.
- `transcripts/<session_id>.jsonl` — ignored by git. First line: the frozen system
  prompt and request parameters. Then one line per turn:
  `{ index, role, content, mutation_id?, usage?, timing? }`, where an assistant
  `content` is the API's array stored verbatim.

All writes go through `atomic.mjs` and the existing append helper.

### Routes

| Method and path | Needs Claude | Purpose |
|---|---|---|
| `GET /api/roles/health` | no | `{ configured, reachable, model }`; answers 200 either way |
| `GET /api/roles/sessions?topic=` | no | folded sessions for a topic |
| `GET /api/roles/sessions/:id` | no | one session with its visible turns |
| `POST /api/roles/sessions` | yes | start; returns the opening assistant turn |
| `POST /api/roles/sessions/:id/turns` | yes | send a learner turn; returns the reply |
| `POST /api/roles/sessions/:id/summary` | yes | draft an interview summary |
| `POST /api/roles/sessions/:id/close` | no | close, with an optional confirmed summary |
| `POST /api/roles/sessions/:id/cards` | no | create cards from selected stumbles |
| `POST /api/roles/summaries` | no | revise a topic's interview summary |
| `POST /api/roles/diagnoses` | yes, unless no eligible misses | request a diagnosis |
| `POST /api/roles/diagnoses/:id/decisions` | no | accept or reject a hypothesis |

A session response sends the browser only visible text per turn; thinking blocks and
the system prompt stay on the server.

### A turn, in order

1. Validate role, topic, turn index, reply length and limits. Reject without a call.
2. Look up the `mutation_id` in the transcript. Stored reply → return it (R9).
3. Append the learner turn if it is not already there.
4. Build the request: the frozen system prompt with a cache breakpoint, then the
   stored turns unchanged.
5. Call Claude. On failure, return 503 or 502; the learner turn stays stored, so a
   retry resumes at step 2 and owes exactly one call.
6. Append the assistant turn verbatim with its `usage`. Return its visible text.

Two concurrent requests with the same `mutation_id` share one run through the existing
`shareInFlight`. Requests with different ids for the same session are serialised by a
per-session in-process queue, so the second one sees the first one's stored turn at
step 1 and is refused with 409. `shareInFlight` alone would not do this: it would hand
the second caller the first caller's result.

### Role prompts

Each builder returns a system prompt from: a fixed role instruction, the topic name,
the confirmed interview summary if any, bounded excerpts if any, and for Socratic and
sparring the concept and a list of concept names James has missed (names only, never
questions). Fixed instructions, in substance:

- **Interviewer.** Ask one question at a time about goal, current level, how he will
  be tested and by when. Do not teach. Stop when those are known.
- **Socratic questioner.** Ask, never give the answer. Follow up on what the reply
  exposes. If he asks for the answer, ask a narrower question.
- **Sparring partner.** Play the described counterpart. Push back on vague answers and
  ask for specifics. Stay in role until told the round is over.
- **Diagnostician.** Find misunderstandings that several misses share. Cite the
  attempt and question ids supporting each. Say "not enough evidence" or "no shared
  pattern" when that is the truth.

Supplied source text is marked as untrusted evidence, never instructions, as
`sourcesearch.mjs` already does.

### View states

Role picker → (first use: egress notice) → session setup → conversation → close.

- **Conversation.** Log, composer, turns-and-spend meter, timer when sparring, End
  session. Waiting: composer disabled, "Waiting for a reply…". Over time: a text
  marker on the turn, composer still enabled.
- **Unavailable.** Banner: what happened, why, what to do. Composer text retained.
- **Limit reached.** Banner naming the limit; End session remains.
- **Refusal.** The turn shows "This turn could not be answered." The session continues.
- **Close.** Interview: draft summary, editable, "Confirm summary". Socratic and
  sparring: list of his turns to tick as stumbles, "Create N cards".
- **Diagnosis.** Evidence counts (used, left out and why), then hypotheses with their
  supporting attempts and Accept / Reject.
- **Empty.** "No sessions yet for this topic. Pick a role to start one."

## Security and data

- **Secret.** One new secret, `STUDYDECK_ANTHROPIC_API_KEY`, read at boot, held on the
  config object, sent only in the `x-api-key` header to the configured base URL. The
  agent building this never reads or prints its value; James sets it.
- **Logging.** `router.mjs` logs the thrown error object on a 5xx. `ClaudeError` holds
  a message and a status only, so nothing carrying headers can reach that log.
- **Egress.** Exactly the inputs the intent lists. Each is assembled in `roles.mjs` or
  `diagnosis.mjs`, so "what leaves" is readable in two files.
- **Prompt injection.** Notebook excerpts are untrusted. The roles have no tools and
  no write path, so the worst case is a misleading question. Card creation is a
  separate, explicit action by James.
- **Personal data.** Interview answers and transcripts may be personal. Transcripts
  stay local (F4). Confirmed summaries are committed and go to both remotes; the
  confirm step says so.
- **Input validation.** Role, topic slug, concept slug, session id (UUID), turn index,
  reply length and timer values are validated before any file or network access.
  Session ids are never used to build a path without that check.
- **Browser boundary.** Unchanged: loopback `Host`, same-origin `Origin`, JSON content
  type, no CORS headers. The browser never calls Anthropic; CSP `connect-src 'self'`
  already forbids it.
- **Retention.** Whether Anthropic retains request content depends on the account's
  data-retention setting, which this change does not configure.

## Acceptance checks

| # | Check | Proves |
|---|---|---|
| A1 | `npm test` with `node_modules` absent, Node 22 and 24: all pass, count above the 381 baseline | R1, rule 5 |
| A2 | `claudeegress.test.mjs`: recorder sees `x-api-key`, `anthropic-version`, the configured model; no retry on 400/401; at most two on 429/529 | R1, R3, R4 |
| A3 | Fake key set; drive success, 401, 500 and a closed port; assert the key string is in no response body, no response header and no captured `console` output | R2 |
| A4 | Closed port: each "needs Claude" route → 503 naming the Claude API; each other route still answers; `/api/state` → 200 | R22 |
| A5 | Session recorder test: a replayed turn with a stored reply produces zero outbound requests; a control without the replay produces one | R9 |
| A6 | Two concurrent different replies to one turn index: one 200, one 409, one outbound request | R9 |
| A7 | Stub fails after the learner turn is stored; retry with the same `mutation_id` produces exactly one outbound request and one learner turn in the transcript | R8, R9 |
| A8 | For each conversational role, the outbound request body contains no deck question text, no deck answer and no fact-check truth from a fixture that has all three | R16 |
| A9 | Diagnosis recorder test: only final-attempt items are sent; an item whose deck hash differs is absent and counted as left out; with no eligible misses the recorder sees no request | R18, F5, F6 |
| A10 | Stub returns a finding citing an attempt id that was not sent: it is dropped and counted; stub returns prose: 502 and `diagnoses.jsonl` unchanged | R19 |
| A11 | After a session in a fixture root: `git check-ignore` matches the transcript path and does not match `sessions.jsonl` | R24 |
| A12 | A full session leaves `state.json` byte-identical and `stages.jsonl` unchanged | R17 |
| A13 | Turn limit and spend limit each stop a further turn with a message naming the limit; close still succeeds | R11 |
| A14 | `guard.test.mjs` extended to the new routes: cross-origin refused, no CORS header on any response | R23 |
| A15 | Browser, against a copy of `.learn/` and the live API: one session per role of at least three turns; reload after turn two continues from turn two | R6, R10 |
| A16 | Browser: interview on a newly created empty topic runs and its confirmed summary appears in the next session's stored system prompt | R7, R13 |
| A17 | Browser: sparring with a 30-second timer; let it expire; the composer is still editable and the turn is marked over time | R15, F8 |
| A18 | Browser: tick two stumbles, create cards; both appear in Flashcards with session provenance; the Open Notebook recorder sees no write | R14 |
| A19 | Keyboard-only pass through a full session; VoiceOver announces a new turn; contrast measured for chat text and controls in both themes | R26 |
| A20 | Screenshots of each view state in both themes beside `variant-C.html` | R25 |
| A21 | James's acceptance script against the live API, per role: did the questioning follow up on his reply, and was an answer handed over | behaviour; no test can |

A15 to A21 need the real key and are run by James or with him present.

## Open questions

1. **Does the account accept the fallback beta header?** Answered at first live call;
   F3 covers both outcomes. — James's account, observed during A15.
2. **Is omitting thinking blocks from replayed turns permitted on Opus 5.5 for a
   conversation with no tools?** The spec assumes not and stores them verbatim, which
   is safe either way. — Not needed unless transcript size becomes a problem.
3. **Does the video show a visual design worth following?** Carried from the intent.
   The walkthrough job never completed; the surface follows variant C. — James, by
   watching it, if he wants more than the shell.
4. **How is this split into pull requests?** The review gate has a diff size cap. A
   likely split is client and config, then sessions, then diagnosis, then the view,
   merged bottom-up. — Decided in plan.md, after reading the gate's current cap.
5. **Linear.** No project exists for this repository; `linear:` stays pending. — James.
