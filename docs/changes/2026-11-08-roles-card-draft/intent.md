---
change: 2026-11-08-roles-card-draft
status: accepted
track: T2
risk: medium
risk_reason: A card's answer side is what the learner rehearses. A wrong AI draft kept as written teaches the wrong answer, and an AI answer mistaken for the learner's own hides that it was never worked out.
author: james
accepted_by: james
linear: pending
source: conversation
---
# Intent: the local model can draft a session card's answer side

## Problem

In James's words today: "Ship card-draft".

The request itself came on 2026-10-13, after the first live Roles sessions. Its words were
not kept. The commit that built it (`a0aacdb`) records it as: "James asked for an AI draft
on seeing the blank back."

A card made from a closed Socratic or sparring session gets its front from the
counterpart's question. Under the accepted ai-roles spec (R14), James writes every back
by hand: "No model drafts it, so no answer is invented." With several stumbles to turn
into cards, a blank back for each one is enough friction that cards don't get made.

The work has sat on a local branch with no PR since 2026-10-13.

## Proposed outcome

- Each stumble picked for a card offers **Draft the answer with AI**. The draft comes from
  the local Ollama model, grounded in the topic's Open Notebook source excerpts.
- A draft arrives **locked and labelled**. **Edit the draft** unlocks it. Writing the back
  by hand still works and stays the default.
- Every card records **who wrote its back**, as `back_origin`: `learner`, `ai_draft` or
  `ai_draft_edited`. Editing an AI draft never turns it back into `learner`.
- ai-roles spec R14 is amended to say all this, not left contradicting the code.

## Affected users and systems

- James, in the Roles view's "make cards" panel.
- `app/lib/ollama.mjs`: a new `draftCardBack`.
- `app/lib/sessions.mjs`: a new `draftSessionCard`, and `back_origin` on created cards.
- `app/router.mjs`: a new `POST /api/roles/sessions/:id/card-draft`, and `back_origin`
  accepted on `/cards`.
- `cockpit/cards.json`: a new optional `back_origin` key on session cards.
- `docs/changes/2026-10-11-ai-roles/`: R14 is superseded.

## Constraints

- **No spending on a closed session.** The draft never calls the Claude API. A session's
  spending stops when it closes.
- **A draft is stored nowhere** until the learner creates the card. The draft route
  appends nothing, so it carries no `mutation_id` (rule 9: an id the server ignores would
  advertise a protection that isn't running).
- **Never invent an answer.** The model's reply goes through `extractJson`. An empty or
  unparseable reply is a 502. A down model is a 503 that names the local model.
- **Rule 7 / ai-roles R16.** No deck question, deck answer or fact-check `truth` goes into
  the draft request. Its inputs are the session's own turns and the source excerpts, and
  the excerpts are marked as data, never instructions.
- **Rule 1.** `back_origin` lives in the `cockpit/` card store, never in `state.json`.
- **Rule 5.** Zero runtime dependencies, loopback only. Rule 12's guard covers the new
  route without changes.

## Out of scope

- Drafting the front, or drafting cards from anything other than a closed Socratic or
  sparring session.
- Using the Claude API for drafts.
- Server-side proof of `back_origin`. The server keeps no record of drafts, so the value
  is the browser's claim. That is acceptable for a solo, loopback-only app.
- Showing `back_origin` in the Flashcards view.

## Success signals

- `npm test` passes with `node_modules` absent. It includes the six new
  `rolesessions` cases and the `nextBackOrigin` view test, and each new route test was
  seen failing before the code was added.
- `rolesessions.test.mjs` shows that a draft sends exactly one request to the local stub,
  zero to the Claude stub, and no planted secret.
- `npm run verify` and `snyk test` are clean.
- In a browser, against a copy of `.learn/` and a closed session, Draft → locked and
  labelled; Edit → unlocked; Create → the stored card's `back_origin` is
  `ai_draft_edited`. Screenshots in both themes.
- Forge CI, the AI-review gate and a Codex review all pass.

## Open questions

1. **A draft made with no sources.** When Open Notebook is down or the topic has no
   notebook, `excerptsFor` returns an empty list and the draft is made from the model's
   own knowledge. Nothing in the response or the view says so. Should the response carry
   whether it was grounded, and the label say "drafted without your sources"?
   Recommended: yes.
2. **A live browser check while the cockpit runs.** James's cockpit holds port 4310, and
   `app/server.mjs` has no port override. Proposed: a throwaway `node -e` that imports
   `handleRequest` from `app/router.mjs` and listens on a spare loopback port, with
   `STUDYDECK_LEARN_ROOT` pointing at a `/tmp` copy. Nothing in the repo changes, and the
   running cockpit is left alone.
