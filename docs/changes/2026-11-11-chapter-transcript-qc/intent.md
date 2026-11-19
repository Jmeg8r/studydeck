---
change: 2026-11-11-chapter-transcript-qc
status: accepted
track: T1
risk: low
risk_reason: Adds a pure library, app/lib/podcastquality.mjs, with no caller yet. No route, view, write path or external service reaches it until a later slice wires it in, so a defect here cannot reach study data or a learner. Its later callers depend on its verdicts, which is why each gate is tested here first.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the transcript planning and QC gates for the local chapter renderer

Track: T1. Behaviour changes inside one repo, with no UI, no route and no
new public surface.

## Problem

This is slice D5a of the local chapter renderer, from PR #98's September snapshot
(`264547c`). James confirmed on 2026-11-11 that he still wants local rendering, and
chose to split it into five slices:

- **D5a:** transcript planning and QC (this slice);
- **D5b:** foundations;
- **D5c:** ffmpeg assembly and audio QC;
- **D5d:** the pipeline and routes;
- **D5e:** the view.

The September renderer let StudyDeck check a chapter podcast before anyone listened to
it. The chapter is planned into bounded sections. The model's transcript has to quote
the source to stand. Repetition and empty turns are refused before any speech is
synthesized, and a looping audio envelope is flagged after assembly.

Open Notebook's own generate job does none of this. A podcast that repeats itself or
wanders from the source is only found by listening to all of it. None of the
renderer exists on `main`. These gates are the base the later slices build on, and
they are pure functions, so they can be ported and tested before anything calls them.

## Proposed outcome

`app/lib/podcastquality.mjs` exists on `main`, with tests. It has no I/O and no caller.

- **`planChapter(text, { contextTokens })`** splits a source into at most 12
  sections that together cover the text exactly.
  - Each section fits the model's context.
  - It prefers to break at a line or a word.
  - It excludes a trailing Questionnaire, Review Questions, Further Research or
    References section, and records that it did.
  - It refuses a context under 4096 tokens, and refuses a source too big for 12
    sections. It never truncates silently.
- **`checkGrounding(turns, source)`** passes a turn only when its `source_quote` is at
  least six words long and appears in the section, with whitespace and markdown
  normalised.
- **`checkTranscript(turns, speakers)`** refuses:
  - an unknown speaker;
  - empty dialogue;
  - a turn over 2400 characters;
  - a repeated 24-word passage;
  - a word count outside its bounds.

  It also warns, without refusing, when several turns in a section add little new
  vocabulary.
- **`repeatedEnvelope(envelope)`** flags near-identical 20-second windows of a 100 ms
  RMS envelope, at least 60 seconds apart.
- **Supporting exports:**
  - `sourcePassages`, which makes citable passages;
  - `words`;
  - `digest` and `clipKey`, for cache identity;
  - `PROMPT_VERSION`.

## Affected users and systems

- None at runtime. A new library file and a new test file.
- Later slices D5c and D5d import it. Its export names and return shapes are the
  contract they will rely on.

## Constraints

- **Rule 5.** Node standard library only (`node:crypto`). `npm test` passes with
  `node_modules` absent.
- **Pure functions.** No filesystem, network, clock or randomness, so every verdict is
  reproducible from its inputs.
- **The QC verdict is technical, not a judgment of accuracy.** The module header
  says so, and nothing here may claim more: publishing still needs a listen.
- **Test first.** Each behaviour gets a red commit before its code. The September
  tests are the starting point, and any gap they leave gets a test before code
  depends on it.

## Out of scope

- Calling Ollama, Speaches or ffmpeg, and any prompt text. Those are D5c and D5d.
- Storing renditions, manifests or clips; routes; and the view.
- Changing `app/lib/mastery.mjs`'s `digest`. It hashes strings for settlements, and
  this module's `digest` also hashes objects. They stay separate. Open question 1 asks
  whether to share one.

## Success signals

- `npm test` passes with `node_modules` absent, including a new
  `app/test/podcastquality.test.mjs`.
- That file covers every exported function. Each September test is carried over. Each
  gap below gets a test: a red commit first, then green.
  - `sourcePassages` has no test today.
  - `checkTranscript` given a turn with no `dialogue` counts the word `undefined` toward
    novelty. This was found by reading `words(turn.dialogue?.toLowerCase())`, and needs
    confirming by a test.
  - The 12-section ceiling and its refusal message have no test.
- `grep -rn podcastquality app/` shows the test as the only importer. Nothing on `main`
  calls it yet.

## Open questions

1. Should `digest` be shared with `mastery.mjs`'s exported `digest`? They agree on
   strings, but this one also serialises objects. The recommendation is to keep them
   separate, because settlements must hash bytes exactly. This goes to the plan.
2. Should the dated literal `PROMPT_VERSION = 'chapter-dialogue-v5'` move with the
   prompt into D5d? It is a cache-identity input, and D5d owns the prompt. The
   recommendation is to keep it here, where the cache key lives, and let D5d bump it.
