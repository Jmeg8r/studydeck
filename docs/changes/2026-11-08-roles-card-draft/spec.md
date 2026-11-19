---
change: 2026-11-08-roles-card-draft
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [design:ux-copy, design:accessibility-review]
claude_config_sha: d0fbd0f
---
# Spec: the local model can draft a session card's answer side

## Flagged concerns

1. **This reverses an accepted requirement.** ai-roles spec R14 says the learner writes
   the back: "No model drafts it, so no answer is invented." The code on this branch
   drafts it.
   *Source:* `docs/changes/2026-10-11-ai-roles/spec.md` R14; Ironclad (an accepted
   artifact is the contract).
   *Recommended:* amend R14 in place with a dated note that points here (R11 below), and
   keep the original sentence struck through so the history stays readable.
   *Resolution:* accepted as recommended (James, 2026-11-08).

2. **A draft without sources is a 200, not a 503.** CLAUDE.md says a route that *needs*
   Open Notebook (ON) answers 503 naming it, never a 200 that reads as "this notebook is
   empty". The draft route uses ON for grounding but does not need it: the local model
   can still answer, and writing the back by hand is always open.
   *Source:* CLAUDE.md, "Being DOWN is our behaviour".
   *Recommended:* answer 200 with `grounded: false` and the reason (R7). The view labels
   the draft as made without your sources. This answers intent open question 1. It keeps
   the outage visible, which is the rule's real point, without blocking a draft that is
   labelled.
   *Resolution:* accepted as recommended (James, 2026-11-08).

3. **`back_origin` is the browser's claim.** The server stores no draft, so it cannot
   check that a card claimed as `learner` was not drafted.
   *Source:* intent, Out of scope.
   *Resolution:* accepted with the intent (2cfb642). Recorded here so the spec says what
   the value does and does not prove.

4. **The locked draft's dashed amber border is 2.0:1 against the light-theme panel**
   (`#f0a840` on `#fffdf8`). WCAG 1.4.11 asks 3:1 for a component's state. In the dark
   theme it is 6.5:1.
   *Source:* design:accessibility-review.
   *Recommended:* leave the colour. The border is not the only cue. The textarea is
   `readOnly`, which a screen reader announces. The `role="status"` note says "AI draft",
   and an Edit the draft button appears. Record it as known.
   *Resolution:* accepted as recommended (James, 2026-11-08).

5. **Policy not applied: `security-review` / `gstack-cso`.** This change touches no auth,
   no secrets and no data boundary. The new route sits behind rule 12's guard, which
   covers every route, and `rolesessions.test.mjs` asserts that no planted secret reaches
   the local model. The Codex review before merge is the security read.
   *Source:* /spec step 2.
   *Resolution:* accepted as recommended (James, 2026-11-08).

## Requirements

- **R1.** Each stumble picked for a card offers **Draft the answer with AI**. It calls
  `POST /api/roles/sessions/:id/card-draft` with `{ topic_slug, turn_index }`. The reply
  is `{ turn_index, front, back, origin: "ai_draft", grounded, ungrounded_reason }`.
  [intent: Proposed outcome 1]
- **R2.** The draft comes from the local Ollama model. The Claude API gets no request.
  [intent: Constraints, no spending]
- **R3.** A draft writes nothing: no card, no session event, no file.
  [intent: Constraints, stored nowhere]
- **R4.** An empty, unparseable or wrong-key reply is a 502 whose message mentions the
  draft. A local model that is down or erroring is a 503 that names the local model.
  [intent: Constraints, never invent]
- **R5.** A draft is only for a learner turn of a closed Socratic or sparring session.
  An open session is a 409. A counterpart turn, a missing turn or another role is a 400.
  None of these reach the model. [ai-roles R14]
- **R6.** The model gets the counterpart question the turn answered, the learner's turn,
  and the topic's source excerpts, with the excerpts marked as untrusted data. It never
  gets a deck question, a deck answer, a fact-check `truth` or `correction`, or a secret.
  [intent: Constraints, rule 7 / ai-roles R16]
- **R7.** `grounded` is true only when at least one source excerpt went into the request.
  Otherwise `ungrounded_reason` is one of these:
  - `no_notebook`: the topic maps to no notebook
  - `unreachable`: ON failed
  - `no_sources`: the notebook returned none

  When `grounded` is true, `ungrounded_reason` is `null`. [intent: Open question 1;
  Flagged concern 2]
- **R8.** A draft arrives in the back field **locked** (`readOnly`, visibly distinct) and
  **labelled** in a `role="status"` note. **Edit the draft** unlocks it and takes focus.
  Writing by hand needs no extra step. [intent: Proposed outcome 2]
- **R9.** `POST .../cards` accepts an optional `back_origin` from `learner`, `ai_draft`
  and `ai_draft_edited`. Any other value is a 400, and an absent one is stored as
  `learner`. The view sends:
  - `ai_draft` after a draft
  - `ai_draft_edited` after any edit to a draft
  - `learner` only when no draft was taken

  Only a fresh draft resets the value. [intent: Proposed outcome 3]
- **R10.** `back_origin` is stored on the card in `cockpit/cards.json`, never in
  `state.json`. [rule 1]
- **R11.** ai-roles spec R14 carries a dated amendment that points to this change. The
  ai-roles plan's Deviations list records it. [intent: Proposed outcome 4]
- **R12.** README's Roles section says drafts come from the local model, arrive locked,
  and are recorded on the card. [CLAUDE.md, README-driven development]

## Design

**Server**
- `ollama.mjs` `draftCardBack({ question, said, excerpts })`:
  - It makes one `chat` call with a system prompt that asks for `{"back": "..."}`.
  - It parses the reply with `extractJson`.
  - A missing or blank `back` throws `OllamaError(502)`.
  - Transport failures already map to a 503 inside `chat`.
- `sessions.mjs`:
  - `cardSource()` holds the closed-session / learner-turn checks shared with
    `createSessionCards`.
  - `draftSessionCard()` finds the nearest earlier non-refusal assistant turn as the
    front, calls `excerptsFor`, and maps its `status` to R7's fields:
    `'none'` → `no_notebook`, `'unavailable'` → `unreachable`, `0` → `no_sources`.
  - `BACK_ORIGINS` is the frozen enum.
- `router.mjs`:
  - `card-draft` is handled *before* `mutationId(body)`, because it appends nothing
    (rule 9).
  - `/cards` allows a fourth key and validates `back_origin` against `BACK_ORIGINS`.

**View** (`roles.mjs`, `app.css`)
- `nextBackOrigin(current, event)` is a pure function, unit-tested.
- Each card row gets a tools strip with three parts:
  - **Draft the answer with AI**. After a draft it reads **Draft again**. When the
    learner has typed text it reads **Replace my answer with an AI draft**.
  - **Edit the draft**, hidden until a draft is locked.
  - A `role="status"` note.
- The note's states (copy reviewed with design:ux-copy):

| State | Note text |
|---|---|
| Drafting | Drafting with the local model… this can take up to a minute. |
| Drafted, grounded | AI draft from the local model, using your sources. Check it before you keep it. |
| Drafted, `no_notebook` | AI draft made without your sources: this topic has no notebook. Check it carefully before you keep it. |
| Drafted, `unreachable` | AI draft made without your sources: Open Notebook didn't answer. Check it carefully before you keep it. |
| Drafted, `no_sources` | AI draft made without your sources: the notebook has none yet. Check it carefully before you keep it. |
| Edited | AI draft, edited by you. |
| Failed | No draft. *(the server's message, which says to write it yourself or try again)* |

- The UX copy review changed one thing: the original grounded note ("Check it against
  your sources") assumed sources that may not have been used, so each state now says
  what was actually used.
- A response that lands after the panel is gone is dropped (`panel.isConnected`).
- The draft button is disabled while a request is in flight.

## Security and data

- **No new secret, and no new outbound host.** Ollama is already used by grade and
  debrief.
- **Input validation:**
  - `turn_index` is an integer from 1 to 10 000.
  - `back_origin` is checked against the enum.
  - A card allows at most 4 keys.
  - Front and back are each at most 8 000 characters, unchanged.
- **The excerpts** are ON source text the user imported, put in the prompt as labelled
  untrusted data. A prompt injection in a source can at worst produce a bad draft, which
  is locked, labelled and never saved without a click.
- **Rule 12's guard** (loopback `Host`, JSON content type, same-origin `Origin`) applies
  to the new POST with no change.
- **Nothing is logged** beyond what the router already logs.

## Acceptance checks

| # | Check | Proves |
|---|---|---|
| A1 | `rolesessions`: a draft sends 1 request to the local stub at `/api/chat` and 0 to the Claude stub; the body contains the question, the stumble and the source text, and no planted secret | R1, R2, R6 |
| A2 | `rolesessions`: after a draft, `cards.json` and the session events are byte-identical | R3 |
| A3 | `rolesessions`: three garbled replies → 502 matching /draft/; the stub returning 500 → 503 matching /local model/i, and a hand-written card then succeeds as `learner` | R4, R9 |
| A4 | `rolesessions`: open session 409; counterpart turn, turn 99 and an interview 400; local stub saw 0 requests | R5 |
| A5 | `rolesessions`: ON stub down → draft 200, `grounded: false`, `ungrounded_reason: "unreachable"`; ON up → `grounded: true`, `ungrounded_reason: null` | R7 |
| A6 | `rolesessions`: `back_origin: "made_up"` → 400; `ai_draft_edited` stored on the card in `cards.json` | R9, R10 |
| A7 | `rolesview`: the `nextBackOrigin` table, including "more edits do not launder it" | R9 |
| A8 | Each of A1–A7 seen failing on the test-only commit, before the feature commit | Ironclad test-first |
| A9 | `npm test` with `node_modules` absent; `npm run verify`; `snyk test` | rule 5, VERIFY |
| A10 | Browser on a `/tmp` copy, real local model, closed session: Draft → locked, note shown; Edit → focus in field; Create → stored `back_origin: "ai_draft_edited"`. Screenshots in both themes | R8, R9 |
| A11 | `grep` shows R14's amendment and the ai-roles plan's Deviations entry | R11, R12 |

## Open questions

1. *Intent Q1, a draft made with no sources:* answered by R7 and Flagged concern 2,
   resolved with concern 2 (accepted as recommended).
2. *Intent Q2, a live browser check while the cockpit runs:* answered by A10. A
   throwaway `node -e` serves `handleRequest` on a spare loopback port with
   `STUDYDECK_LEARN_ROOT=/tmp/learn`. The running cockpit is not touched.
