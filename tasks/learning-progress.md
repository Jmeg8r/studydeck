# AI Agents From Scratch — Learning Progress

**Mode:** Deep mastery of the primitives (Socratic, all 15 in order, modify + break each).
**Started:** 2026-07-16
**Run command pattern:** `node examples/0X_<name>/<name>.js` (NOTE: README's `node intro/intro.js` paths are stale — files live under `examples/`).

> **Historical record — the `examples/` tree is no longer in this repo.** It was removed
> on 2026-07-27 when the repo was renamed to `studydeck`; the course was never modified
> here and was not part of this project's work. The paths below still describe how the
> material was studied at the time. To run any of it again, use
> [pguso/ai-agents-from-scratch](https://github.com/pguso/ai-agents-from-scratch) or check
> out this repo's `pre-studydeck-rename` tag. This log is left otherwise unedited.

## The 4-step loop (run on EVERY example)
1. Read `CONCEPT.md` first — form the mental model before code.
2. **Predict** the output out loud, THEN run the `.js`. Mind the gap.
3. Read `CODE.md` to close gaps.
4. **Break it on purpose** — change a prompt, delete a tool, shrink contextSize, feed hostile input. Watch how it fails.

## Progress

### Foundations — LLM mechanics (move briskly; not agents yet)
- [ ] 01_intro — model loading, context, inference pipeline  ← **CURRENT**
- [ ] 02_openai-intro — hosted models (OPTIONAL, needs API key)
- [ ] 03_translation — system prompts & specialization
- [ ] 04_think — reasoning & its limits
- [ ] 05_batch — parallelism / sequences
- [ ] 06_coding — streaming & response control

### 🔑 The heart — where agency begins (slow down here)
- [ ] 07_simple-agent — FUNCTION CALLING (text generation → agency)
- [ ] 08_simple-agent-with-memory — persistent state
- [ ] 09_react-agent — ReAct loop (foundation of every framework)

### Advanced reasoning + production patterns (go deep selectively)
- [ ] 10_aot-agent — Atom of Thought planning
- [ ] 11_error-handling — resilience, retries, fallbacks
- [ ] 12_tree-of-thought — beam search over branches
- [ ] 13_graph-of-thought — DAG merge of multi-source outputs
- [ ] 14_chain-of-thought — auditable stepwise decisions
- [ ] 15_tool-routing-embeddings — narrow the tool catalog per request

## Notes / aha moments / ASTGL beats
- (capture friction points and "oh THAT's what's happening" moments here as we go)
- README run-path bug (`node intro/intro.js` → `node examples/01_intro/intro.js`) — candidate doc-fix PR.
