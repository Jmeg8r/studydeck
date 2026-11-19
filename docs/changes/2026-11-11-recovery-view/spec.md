---
change: 2026-11-11-recovery-view
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [design:ux-copy, design:accessibility-review]
claude_config_sha: d0fbd0f
---
# Spec: a Recovery view that finishes what the cockpit already knows is unfinished

## Flagged concerns

1. **Rule 9 says "every APPEND-ing request carries a `mutation_id`". Neither Recovery POST
   does.**
   - Source: CLAUDE.md rule 9, which the AI gate reads as its standard.
   - Settle is idempotent by construction. Once an attempt is applied it is no longer owed,
     and `healUnappliedMastery` already refuses to apply twice.
   - Reconcile appends through the existing `revise*Operation` helpers. They derive the
     revision's id server-side, as every operation revision on `main` already does
     (`<origin>:note:<revision>:<stage>`), and `appendOperation` dedupes on it.
   - A client id would be accepted and ignored. Rule 9 itself warns against that: an id the
     server ignores "would advertise a protection that isn't running".
   - **Recommended:** no client id. Add one sentence to rule 9 naming the Recovery routes
     as replay-safe by derived identity, beside the existing `/schedule` set-route
     exception.
   - **Resolution:** James, 2026-11-11: derived id, no client id. Amend rule 9 in CLAUDE.md in this PR.
2. **Matching "exactly one" makes the shared note reconcilers stricter.**
   - Source: intent, *Proposed outcome*.
   - `reconcileNoteOperation` and `reconcileMindmapNoteOperation` use `.find`, which takes
     the first note whose title matches. The title carries a unique `[StudyDeck <id>]`
     marker. So two matches mean a duplicate already exists, and marking it done would hide
     it.
   - **Recommended:** change both helpers to exactly-one. The note and mind-map routes
     replay through them too, so their behaviour changes in the same safe direction: a
     duplicate now stays ambiguous.
   - **Resolution:** James, 2026-11-11: exactly one everywhere. Tighten both shared helpers, red test first.
3. **Unfinished attempts can't count toward the "matches `/api/health`" rule.**
   - Source: intent, *Constraints* and *Proposed outcome*.
   - An attempt still awaiting a self-grade is normal, in-progress state. `sidecar.mjs`
     deliberately doesn't count it, because doing so put "a permanent false alarm on
     health".
   - **Recommended:** list such attempts in a separate **In progress** section with a
     resume link, outside the counts. The consistency check covers **Needs action** only.
   - **Resolution:** James, 2026-11-11: a separate In progress section, outside the counts.
4. **The snapshot's `/api/recovery` leaks answers.**
   - Source: CLAUDE.md rule 7.
   - It returned whole attempt records. Those carry `factcheck_proposal` truths and
     corrections, graded `results` and raw `responses`, including on attempts still
     pending a self-grade.
   - **Recommended, and adopted in the design below:** every item is an explicit allowlist
     projection, and a recorder plants answers and asserts their absence.
   - **Resolution:** James, 2026-11-11: accepted. Allowlist projection, with a planted-answer recorder.
5. **Policy not applied: `security-review`.**
   - Source: the spec skill's step 2.
   - That skill reviews pending code changes, and this spec has none yet.
   - **Recommended:** run it on the branch diff before the PR, alongside Codex. *Security
     and data* below covers what it would check.
   - **Resolution:** James, 2026-11-11: accepted. Run security-review on the branch diff before the PR.
6. **Target size (2.5.5).**
   - Source: `design:accessibility-review`, which lists it under AA. In WCAG 2.1 it is AAA.
   - The app's `.btn` is about 31 px tall everywhere.
   - **Recommended:** use the existing `.btn` for consistency, and don't restyle buttons
     app-wide in this slice.
   - **Resolution:** James, 2026-11-11: accepted. Keep the existing .btn size.

## Requirements

Each requirement traces to `intent.md`.

- **R1. List what needs action** (intent: *Problem*). `GET /api/recovery` returns, per
  topic:
  - **needs action:**
    - attempts that owe mastery (`owesMastery`);
    - final fact-checks that owe cards (new `owesFactcheckCards`);
    - unresolved operations (`prepared` or `ambiguous`, the stages `inspectSidecars`
      counts);
  - **blocked:** attempts whose settlement is `ambiguous`, shown read-only;
  - **in progress:** non-final attempts.

  One topic failing to read never hides the others.
- **R2. The counts match health** (intent: *Constraints*). Each topic's `needs_action`
  counts equal `/api/health`'s `mastery_unapplied`, the new `factcheck_cards_owed` and
  `operations.unresolved` for the same tree.
- **R3. Settle owed mastery** (intent: *Proposed outcome*). `POST /api/recovery/settle`
  with `{topic_slug, attempt_id}`:
  - on an attempt that owes mastery, applies it once through `healUnappliedMastery`;
  - on a final fact-check that owes cards, creates them once through
    `completeFactcheckCards`;
  - on anything else, answers 409 with what it is and writes nothing;
  - a replay answers 200 `already_done` and writes nothing.
- **R4. Reconcile reads only** (intent: *Proposed outcome*). `POST /api/recovery/reconcile`
  with `{topic_slug, operation_id}`:
  - sends only GETs to Open Notebook;
  - on exactly one match, appends one `complete` revision through the kind's existing
    revise helper;
  - on zero matches or several, answers 200 `still_unknown` and appends nothing;
  - never creates, posts or deletes.
- **R5. Matching rule per kind:**
  - **note and mind-map note:** exactly one note in the topic's notebook whose title equals
    `local_result.note_title`;
  - **`podcast_episode` and `podcast_standalone`:** `matchRendition` on
    `local_result.episode_name`. It accepts only tagged rendition names and exactly one
    match;
  - **`podcast_delete`:** the episode id is absent from a successful episode list;
  - **any other kind** (`debrief`, `summary_*`): 409 "can't be checked from Recovery",
    appends nothing.
- **R6. No answers** (rule 7). No Recovery response contains `responses`, `results`,
  `factcheck_proposal`, `factcheck_adjudication`, a truth, a correction or a deck answer.
- **R7. Degradation:**
  - with Open Notebook unreachable, reconcile answers 503 naming Open Notebook and appends
    nothing;
  - `/api/recovery` and settle keep working;
  - the Open Notebook password appears in no response.
- **R8. The guard:** both POSTs go through `guard.mjs`'s mutating-request checks, and no
  `Access-Control-Allow-*` header is added.
- **R9. A view.** A **Recovery** nav item at `#recovery` renders R1 with an action per item
  (R3, R4). The health banner links to it whenever it reports anything Recovery can act on.
- **R10. Accessible:** WCAG 2.1 AA for the view (see *Design → UI*).

## Design

### Server

- **`app/lib/sidecar.mjs`.** Add `owesFactcheckCards(attempt)`. It's true for a final
  `factcheck` attempt that has `factcheck_proposal` and `factcheck_adjudication` but whose
  `factcheck_cards.status` isn't `complete`. `inspectSidecars` counts it as
  `attempts.factcheck_cards_owed`, and `/api/health`'s `degraded` test includes it.
- **`app/lib/recovery.mjs`** (new, pure over the sidecar reads). `recoveryList(topics)`
  returns `{ topics: [{ topic_slug, error?, counts, needs_action, blocked, in_progress }] }`.
  Each item is built by an allowlist projection:
  - **attempt:** `{ type, attempt_id, kind, status, ts, concept_slug, concept_title, score,
    max }`;
  - **operation:** `{ type, operation_id, kind, stage, ts, label, checkable }`, where
    `label` is the note title or episode name, and `checkable` is whether R5 has a rule
    for the kind.
- **`app/router.mjs`:**
  - `reconcileOperation(topicSlug, operation)` dispatches by kind to the existing
    helpers. It returns `{ outcome: 'confirmed' | 'still_unknown', item }`. The two note
    reconcilers become exactly-one (concern 2), and the podcast branch lifts the inline
    match at `runPodcastEpisodeOperation` into a shared function, so both paths use one
    rule.
  - **Routes**, next to `/api/state`:
    - `GET /api/recovery`;
    - `POST /api/recovery/reconcile`: `assertKnownTopic` and `assertIdentifier`. 404 for
      an unknown operation; 409 for an uncheckable kind or a stage that isn't
      `prepared`/`ambiguous`; 200 otherwise;
    - `POST /api/recovery/settle`: the same validation. 409 for an attempt that is
      neither owed nor already done; 200 `{ outcome: 'applied' | 'already_done', item }`.
  - Responses carry projected items only (R6).

### UI (`app/web/js/views/recovery.mjs`)

- **Structure:**
  - `h1` "Recovery", then one `h2` per topic with anything to show.
  - Each section ("Needs action", "Can't be finished here", "In progress") is an `h3`
    over a `ul` of cards.
  - Raw identifiers sit in a `<details>`.
- **Copy** (`design:ux-copy`: verb-first, specific, what happened + why + what to do):

  | Element | Copy |
  |---|---|
  | Intro | "Work the cockpit started but couldn't finish. Nothing here repeats an action: checking Open Notebook only reads it." |
  | Owed mastery | "<concept> · <kind> from <date> · scored <score>/<max>. Mastery was never updated, so confidence is lower than this result." Button: **Apply to mastery** |
  | Owed cards | "Fact-check from <date>. Its corrective cards were never created." Button: **Create the missing cards** |
  | Unconfirmed write | "Open Notebook <note / episode / delete> "<label>" from <date> never confirmed." Button: **Look for it in Open Notebook** |
  | Uncheckable write | "The cockpit can't check this kind of write. Look in Open Notebook for "<label>" before doing it again." |
  | Ambiguous mastery | "Mastery may or may not have been updated. It won't be applied automatically, so a confidence bump can't count twice." |
  | In progress | "Started <date>, not finished." Link: **Resume in Test Center** or **Resume in Fact-Check** |
  | Confirmed | "Found it in Open Notebook and marked it done." |
  | Still unknown | "Not found in Open Notebook, or found more than once. Nothing was changed. Check Open Notebook yourself before doing this again." |
  | Applied / created | "Mastery updated." / "Cards created." |
  | Already done | "This was already finished. Nothing was changed." |
  | 503 | "Open Notebook isn't reachable, so nothing was checked. Start it and try again." |
  | Empty | "Nothing to recover. Every graded attempt has updated mastery, and every Open Notebook write is confirmed." |

- **Accessibility** (`design:accessibility-review`):
  - **Structure (1.3.1):** headings and lists as above.
  - **Names (4.1.2):** each button has `aria-describedby` pointing at its card's text,
    because several "Apply to mastery" buttons are otherwise indistinguishable to a
    screen reader.
  - **While a request runs:** the button is disabled, gets `aria-busy="true"`, and its
    label reads "Working…".
  - **Status:** results go to one persistent `role="status"` region, outside the
    re-rendered list.
  - **Focus (2.4.3):** the snapshot cleared the whole view after an action and lost focus.
    Here, after the list re-renders, focus moves to the status region (`tabindex="-1"`).
  - **Errors (3.3.1):** messages name the cause and the next step, per the copy table.
  - **Keyboard and focus:** only native buttons, links and `details`, so keyboard access
    (2.1.1) and visible focus (2.4.7) come from the existing styles.
  - **Contrast:** colour comes from the existing tokens, so 1.4.3 and 1.4.11 hold in light
    and dark.
- **Lifecycle:** `createViewScope`, as in D4. Leaving the view aborts its requests, and a
  late response doesn't render.
- **Banner** (`integrity.mjs`):
  - The owed-mastery line drops "Nothing in the cockpit finishes it yet" and gets an
    **Open Recovery** link.
  - Unresolved-operation lines and a new owed-cards line get the same link.

## Security and data

- **Input:** `topic_slug` must be a configured topic, and the ids pass `assertIdentifier`.
  Lookups go by exact id in that topic's own sidecars, with no paths built from input.
- **Writes:** only through existing writers: `appendOperation`, `appendAttempt`,
  settlement under `withTopicLock`, and `writeJsonAtomicSync` for cards. `state.json` is
  written only by the existing settlement, followed by render (rules 3 and 8).
- **Egress:** reconcile sends only GETs, to `listNotes` and `listEpisodes`. Nothing leaves
  the machine except calls to Open Notebook. No Claude API call is made.
- **Secrets:** none are read or added. The Open Notebook password stays server-side, which
  R7's test asserts.
- **Browser boundary:** both POSTs pass `guard.mjs` (loopback `Host`, JSON content type,
  same `Origin`) and send no CORS header.
- **Logging:** errors are logged with route and status only. No answer or record body goes
  into a log.

## Acceptance checks

- **R1, R2 and R6:** `app/test/recovery.test.mjs`.
  - A fixture topic with one item of every kind gets the right section each.
  - Its counts equal `inspectSidecars`.
  - Planted answers are asserted absent from the serialized body.
- **R3:** route test on a fixture copy.
  - The settle POST raises the concept's confidence once, and `mastery_unapplied` drops by
    one.
  - The same POST again answers `already_done` and changes no byte of `state.json`.
  - The fact-check variant creates the cards once.
  - A pending attempt and an ambiguous one answer 409, and nothing changes.
- **R4 and R5:** `app/test/recoveryegress.test.mjs`, an Open Notebook recorder.
  - Exactly one match appends one `complete` revision and sends GETs only.
  - Zero or two matches append nothing; this is the case where a write would be harmful.
  - A control fixture with exactly one match requires the append.
  - A podcast delete with the episode gone appends; with it present, nothing.
  - Uncheckable kinds answer 409 with nothing sent.
  - Concern 2's change gets its own red test: two same-title notes leave the note route's
    operation ambiguous.
- **R7:** `degradation.test.mjs`. Reconcile with Open Notebook down is 503 naming Open
  Notebook, with nothing appended. `/api/recovery` is 200, and the password appears in no
  response body or header.
- **R8:** `guard.test.mjs`. Both POSTs are refused cross-origin and with a non-JSON content
  type, and carry no CORS header.
- **R9 and R10, on a `/tmp/learn` copy with the scratch server:**
  - **Screenshots, light and dark:** one item of each kind, the empty state, and the
    banner link.
  - **Keyboard only:** Tab reaches every action. After an action, focus is on the status
    message.
  - **Text check:** `read_page` shows the headings, list structure and button
    descriptions.
  - **Live check:** "Apply to mastery" on the copy is reconciled by hand against
    `state.json` and `attempts.jsonl`.
- **Whole suite:** `npm test` with `node_modules` absent, and `npm run verify` clean.

## Open questions

The three from the intent:

1. **Client-minted vs derived mutation id.** Answered from the code: derived, per
   `main`'s existing operation revisions. Its rule 9 wording is concern 1, for James.
2. **Whether fact-check cards count.** Answered: yes, with a new health counter
   (R1, R2). `completeFactcheckCards` is idempotent (`source_ref` dedupe plus an in-flight
   share), so listing it is safe.
3. **Whether `matchRendition` is strict enough.** Answered: yes. It refuses untagged
   chapter names and anything other than exactly one match. A legacy episode stays
   `still_unknown`, which is the safe answer.

None new.
