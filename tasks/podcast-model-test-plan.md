# Podcast model testing plan

Goal: pick the default `outline_llm`/`transcript_llm` for the study podcast profiles.
The 7B proved the *pipeline*; it failed the *brief* (deep-dive drift, math error,
repetition, duplicated turn). This plan decides what replaces it — including models not
yet downloaded — without burning hours on renders that a 30-second screen would reject.

Two questions, deliberately separated:

- **Q1 — scope:** is the deep-dive drift pipeline-determined (ON's content assembly /
  context truncation) or model-dependent (7B fixation)? Answered by a control run, not
  by opinion.
- **Q2 — prose:** among models that respect scope, which writes the best dialogue at an
  acceptable render time?

Fixed for every run (only the model changes): notebook
`practical-deep-learning-fastai` (all 20 fastbook chapters) · episode profile
`study-overview` (4 segments, same briefing) · speaker profile `tech_experts-mixed` ·
episode name `model-test — <model>`.

Known from code (2026-07-20): the cockpit sends **only `notebook_id`** — content
assembly is ON-side. If Q1 lands on "pipeline," the lever is the generate route's
optional `content` param: the cockpit can assemble source text itself. That's a code
change; park it until Q1 is answered.

---

## Phase 0 — control run + instrumentation (~1 h, runs unattended)

> **Findings, 2026-07-20 — HISTORICAL, recorded mid-run** (`model-test — gemma4-31b`,
> `command:13ypr63pxbuklkd6xdf5`, started 11:57 EDT; that run was later killed at 1h50m
> and Phase 0 is **complete** — current status lives in *Phase 0 outcome* below):
>
> - Worker pickup verified in ~1 s (the LIVE-query discriminator check passes).
> - **Q1 answered by instrumentation alone: pipeline.** `ollama ps` mid-render shows ON
>   loads the model with **CONTEXT = 8192**. The source: esperanto (ON's provider
>   library) defaults `num_ctx` to 8192, and ON's credentials list is empty — nothing
>   ever overrode it. Every render to date fed the model a prompt truncated to 8K tokens
>   against a 20-chapter notebook. The 7B never "fixated"; it wrote about the only text
>   it received.
> - **The fix is config, not models:** `POST /api/credentials` with
>   `{name, provider: "ollama", num_ctx: <N>, base_url}` — the API's own description
>   reads "Context window size (Ollama only; defaults to 8192)". Include `base_url`
>   (`http://host.docker.internal:11434`) so the credential doesn't break connectivity
>   that currently comes from env.
> - **Revised sequence:** control finishes at 8192 (clean "before") → create the
>   credential at `num_ctx: 32768` → **re-render the 7B (~4 min) as the decisive scope
>   experiment**. If its outline widens to a real map, scope is closed and the download
>   ladder shrinks to a Q2 (prose-quality) question only.
> - Deviation from the written plan: Phase 1 screens are NOT running during the control
>   — loading other models would contend for GPU and corrupt the clean timing baseline.
>   Screens run after.

1. Render on `gemma4:31b-mlx` (the only model with a proven *valid* outline).
   - Repoint `study-overview` (GET by name → strip → PUT by id), confirm the
     `Resolved models` log line names gemma4 before trusting the run.
   - The 60-min poll ceiling may lie on this run; watch
     `docker logs -f quorum-open_notebook-1 | grep podcast_creator` — the log is truth,
     the status field is not.
2. During the render, capture what context the model actually got:
   - `ollama ps` mid-render → the CONTEXT column for the loaded instance.
   - Compare `outline.json` scope against the 7B's — **if gemma4's outline is already
     gradient-descent-only, the narrowing happened before any model saw it** (Q1 =
     pipeline) and no download below fixes scope.
3. Verdict gates everything: Q1 = pipeline → do content-assembly work first, model
   testing continues only for Q2. Q1 = model → scope becomes a rubric line item.

## Phase 1 — screening gate (minutes per model, no render)

Every candidate — on-disk or downloaded — passes this before earning a render:

```bash
# To a file, NOT a shell variable — zsh's echo interprets \n escapes inside the
# JSON envelope and corrupts it (validated the hard way, 2026-07-21).
curl -s localhost:11434/api/generate \
  -d '{"model":"<m>","prompt":"Return ONLY valid JSON: {\"a\":1}","stream":false}' \
  -o /tmp/gate.json
jq '{response: (.response|.[0:80]), thinking: (.thinking|type)}' /tmp/gate.json  # inspect
# The gate: strip optional ``` fence lines, then the remainder must parse as JSON.
jq -r '.response' /tmp/gate.json \
  | sed -e 's/^```json$//' -e 's/^```$//' \
  | jq -e . >/dev/null && echo PASS || echo REJECT
```

(Validated against live output: fenced-valid → PASS; malformed non-JSON → REJECT; empty
response → REJECT, so the parse gate subsumes the reasoning-class check — the `thinking`
inspection line remains for diagnosing *why* a model failed.)

- Empty `response` + populated `thinking` → **reject** (reasoning-class; LangChain gets
  nothing — the qwen3.6:35b-a3b failure). Record and move on.
- Non-empty but **malformed** `response` (doesn't parse after fence-stripping) →
  **reject** too — it would pass a naive "is it non-empty" screen and then fail at the
  outline node, wasting a render.
- Fenced JSON is fine (LangChain strips fences — both survivors did this); that's why
  the fences come off before the `jq -e` check, not counted against the model.
- While loaded, time a ~500-token generation for a tokens/sec figure; it predicts render
  wall clock better than parameter count (MoE vs dense).
- One candidate loaded at a time; `ollama stop` the rest and confirm with `ollama ps`
  before each measurement (the qwen3-coder self-reload burned us once already).

## Candidate roster

### Already on disk

| Model | Size | Status / expectation |
|---|---|---|
| `qwen2.5:7b-instruct` | 4.7 GB | baseline — completed, failed brief |
| `gemma4:31b-mlx` | 20 GB | control — valid outline, ~34 min outline node |
| `qwen3.6:35b-a3b` | 23 GB | rejected (reasoning) — but see experiment below |
| `gpt-oss:120b` | 65 GB | screen it — reasoning-style; if `response` is non-empty it's a heavyweight candidate |
| `deepseek-r1:70b` | 42 GB | expect reject (reasoning) — run the 30-s screen anyway to record it |
| `qwen3:235b-thinking` | 142 GB | exclude by class without loading; not worth a 142 GB load to confirm |
| `qwen3-coder:30b` / `-next` | 18/84 GB | exclude by rationale (code models, prose task); optional curiosity screen |
| `astgl-voice:7b-v1.5` | 5.4 GB | wildcard — James-voice fine-tune, `transcript_llm` only, Phase 3 |

**Experiment (15 min, high payoff): un-think qwen3.6:35b-a3b.** MoE ~3B-active is the
ideal speed/quality shape and it's already on disk. Try `"think": false` in the screen
curl; if ollama honors it, build a Modelfile derivative with thinking disabled and screen
*that* — ON can't send per-request options, but it can call a derived model by name. If
the derivative passes the gate, it jumps to the front of Phase 2.

### To download (verify exact tags against the ollama library first — tags churn, same
rule as ON's openapi; sizes are quantized-download estimates)

Priority order — each answers a distinct question:

| Model | ~Size | Why this one |
|---|---|---|
| `qwen2.5:14b-instruct` | 9 GB | same family as the baseline — is the failure just parameter count? Cheapest info per GB |
| `qwen2.5:32b-instruct` | 20 GB | the family's quality ceiling at gemma4's footprint but (likely) faster |
| `mistral-small` (24B class) | 15 GB | strong instruction-following non-reasoning line; different family = different failure modes |
| smaller gemma (12B class, whatever tag is current) | 8 GB | gemma produced the only valid *scoped* outline family — does that survive shrinking? |
| `llama3.3:70b` (or current llama equivalent) | 40 GB | dense heavyweight anchor — **only if** nothing above beats gemma4; slow, ceiling-risk |

Stop downloading the moment something clears the decision bar; the list is a ladder, not
a shopping cart.

## Phase 2 — uniform renders

For each screen survivor: one render, same fixed inputs, model as both `outline_llm` and
`transcript_llm`. From the logs, record per-node wall clock (outline node, transcript
node, audio). Grade the transcript (rubric below) — reading `transcript.json` in the
episode dir, no listening required to score.

## Phase 3 — mixed configs

The two LLM slots are independent and want different skills: **outline** = scope +
structure + strict JSON; **transcript** = prose. Take the best outline scorer × best
prose scorer and render the cross (e.g. gemma4 outline + qwen2.5:32b transcript —
outline is one slow node, transcript is four). `astgl-voice` auditions here as
transcript-only if its screen passes.

## Rubric (score 0–2 per item, per transcript)

Derived from the observed 7B failures — these are regression checks, not aspirations:

1. **Map, not territory** — breadth: how many of the book's domains named vs one topic
   deep-dived (Q1 permitting)
2. **Closing questions present** (the briefing requires them; 7B ended on a tip)
3. **Factual accuracy** — spot-check every mathy claim (the "gradient points to −x" class)
4. **Turn integrity** — no consecutive same-speaker turns, no restarted segments
5. **No re-introduction** — each concept introduced once (7B introduced SGD twice)
6. **Dialogue naturalness** — subjective, admit it
7. **Outline fidelity** — transcript segments match `outline.json`

Operational, per run: total wall clock · outline-node minutes · parse failures ·
`Resolved models` line confirmed. Grading happens in a Claude session for a consistent
judge; scores and episode dir UUIDs get appended to the results table below.

## Decision bar

Default = highest rubric total among models rendering in **≤ ~15 min**; ties go to the
smaller model. `gemma4:31b-mlx` is a fallback for **outline duty only** (Phase 3 mixed
configs) — it is disqualified as `transcript_llm` per the Phase 0 outcome, and even
outline duty carries the ~35-min node cost. Reasoning-class models are permanently
excluded (documented, with the screen output as evidence).

## Budget & guardrails

- Disk: ≤ ~92 GB of downloads if the whole ladder runs (9 + 20 + 15 + 8 + 40); likely
  far less — the ladder stops at the first model to clear the decision bar.
- Time: Phase 0 ~1 h unattended; screens are minutes; each Phase 2 render 5–90 min by
  model class.
- Memory: one candidate resident at a time; check `ollama ps` before every render.
- Long runs (gemma4, llama-70b, gpt-oss): the 60-min UI ceiling will misreport — watch
  the container log, and treat this as another argument for surfacing the node name in
  the poll response.

## Phase 0 outcome (2026-07-20) — complete

**Q1 = pipeline, mechanism found, fixed, and verified.** ON's podcast path
(`open_notebook/podcasts/models.py::_resolve_model_config`) reads `num_ctx` ONLY via the
model record's `credential` link — provider-level defaults are never consulted. No link
existed, so esperanto's 8192 default applied to every render ever made. Fix chain, each
step verified: created `credential:lzty9rlughb6aod8xvro` (`num_ctx: 32768`, base_url
preserved) → **models cannot be re-linked in place** (no PUT; `register-models` dedupes
without linking) → deleted + recreated the 7B record with the credential
(`model:r59kjwf00i4clh658tl6`) → repointed `study-overview` → ollama loaded the model at
**CONTEXT=32768** and the render completed.

**Scope tracks context, confirmed by A/B on the same model.** 8K outline: one section of
ch4. 32K outline: intro → real-world applications → gradient descent → best practices
(~ch1–4 territory). Still not a 20-chapter map — the full book exceeds any practical
context. A true full-book priming episode needs **content selection** (per-source
insights/summaries via the generate route's `content` param), not more context. That is
its own slice, out of scope for model testing.

**Model quality still matters at equal starvation:** gemma4's 8K outline (recovered from
logs before the kill) spanned ch1→ch4 where the 7B's stayed inside one section.

**gemma4:31b-mlx is disqualified as `transcript_llm` — with a caveat.** The control
*started* clean but was contended from minute 4 (qwen3-coder:30b, 47 GB, reloaded by the
litellm health checks below), so the numbers carry that asterisk: outline node ~35 min
(matches the equally-contended 2026-07-19 baseline), then transcript segments repeatedly
crashed ollama's per-model runner (`Post http://127.0.0.1:<port>/v1/completions: EOF`,
status 500) into ~30-min retry loops; killed at 1h50m on segment 2/5. The crashes may be
GPU-memory-pressure-induced rather than inherent — a contention-free rerun (litellm
health checks disabled) would be needed to make the disqualification unconditional. As a
practical matter it stands anyway: this machine runs those daemons, so contended is the
operating condition gemma4 would actually face. Outline-only duty in a mixed config
remains possible but expensive.

**Contention ghost identified:** two litellm daemons (ClaudeClaw's and llm-gateway's)
health-check `qwen3-coder:30b` into memory — 47 GB @ 256K ctx, reloaded every few
minutes, all day. No render benchmark on this machine is clean until those are configured
not to (fix lives in those repos, not here).

**32K 7B quality snapshot** (episode `31dff141…`, 3.5 min wall clock): 37 turns; SGD
introduced once (was twice at 8K); no overt math-error class hits; **2
consecutive-speaker violations; closing-questions requirement still unmet** — both runs
end on a wrap-up, not the briefing's "questions to hold in mind." Brief-adherence is
partly a briefing-strength problem, not only a model problem.

**Stuck-episode ledger — cleared 2026-07-20.** All five zombie/mislabeled rows deleted
via `DELETE /api/podcasts/episodes/{id}`. Remaining episodes are the two legitimate
artifacts: `fastai overview — qwen7b` (the 8K baseline) and `model-test — qwen7b-32k-real`
(the 32K result).

## Results

| Date | Model(s) o/t | Episode dir | ctx | Wall clock | Notes |
|---|---|---|---|---|---|
| 2026-07-19 | qwen2.5:7b both | `ab164f9a…` | 8K | ~4 min | baseline; failed brief (math error, 2× SGD intro, dup turn, narrow scope) |
| 2026-07-20 | gemma4:31b both | `3f9f5545…` (empty — killed) | 8K | killed @1h50m | outline 35 min; runner crashes in transcript; disqualified for transcript (run contended — see caveat) |
| 2026-07-20 | qwen2.5:7b both | (mislabeled `qwen7b-32k`) | 8K | ~4 min | accidental 8K repro before link fix |
| 2026-07-20 | qwen2.5:7b both | `31dff141…` | **32K** | 3.5 min | scope widened to ~ch1–4; SGD 1×; 2 dup turns; no closing questions |
