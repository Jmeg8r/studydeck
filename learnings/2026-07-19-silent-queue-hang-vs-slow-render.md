# A job stuck at `running` forever: stale LIVE query, not a slow model

**2026-07-19 · Open Notebook podcast generation · ai-agents-from-scratch**

## The problem

The cockpit's podcast render sat at `running` with `progress: null` and an empty
`error_message`. A prior session had diagnosed the same symptom as memory exhaustion (the
Mac Studio had genuinely OOM'd during an earlier attempt) and written up preconditions —
free RAM, unload big models, use a smaller LLM. None of them were the fix.

## What it actually was

ON's `surreal_commands` worker subscribes to new commands through a **SurrealDB LIVE query
established once at worker start**. The subscription was stale. The API accepted the
request, wrote the episode row, and queued the command — and the worker never saw it.
`docker restart` re-established the listener and the next attempt ran immediately.

## The generalizable lesson

**When a queued job reports `running` with no progress and no error, prove the worker
picked it up before theorizing about why it's slow.** Those are different failures with
identical UI, and they invite completely different (expensive) fixes.

The cheap discriminator is the worker's own log:

```bash
docker logs --tail 20 <container> | grep "Starting .* for"   # appears within ~1s if picked up
```

Absent line ⇒ never started. Present line ⇒ genuinely working, go measure phases.

Corollaries that cost real time here:

- **A resource metric moving is not evidence your job is doing work.** I watched free
  memory drop 97GB → 0.1GB and reported "real work ran 20:19–20:43." The logs showed the
  render never started; the churn was an unrelated model loading. Correlation with a
  plausible story is not causation — confirm with a log line the job itself emits.
- **A crash in the history poisons the next diagnosis.** The earlier OOM was real, so
  "memory" was the available explanation and it fit the symptom. It was still wrong. A
  previous root cause is a hypothesis, not a prior.
- **Restarting the consumer does not drain what was queued while it was deaf.** Those rows
  stay `running` forever and need explicit deletion. Stale-queue debris accumulates and
  then looks like fresh failures later.

## Second lesson: reasoning models silently break strict JSON parsers

Swapping in `qwen3.6:35b-a3b` for speed failed in 52s with
`Invalid json output:` — nothing after the colon. It's a reasoning model: the entire
answer goes to a separate `thinking` field and `response` comes back **empty**.

```bash
curl -s localhost:11434/api/generate \
  -d '{"model":"<m>","prompt":"Return ONLY valid JSON: {\"a\":1}","stream":false}' \
  | jq '{response, thinking}'
```

Non-empty `response` ⇒ usable. Empty `response` + populated `thinking` ⇒ it will fail any
strict parser. One curl, before wiring it into a profile.

This repo already knows local models ignore `format` schemas and defends with `extractJson`
in `app/lib/ollama.mjs` — but that defense only covers paths *we* call. This parse happened
inside podcast-creator's LangChain chain, a dependency of ON. **Know whether the fragile
parse is in code you control**; if it isn't, the model choice is the only lever.

## Outcome

First completed episode in the project's history: 5m16s, valid MP3, ~4 min wall clock on
`qwen2.5:7b-instruct`. Verified by playing it in the browser (`readyState: 4`, playhead
advancing), not by reading a status field — the same status field that had been lying for
two sessions.
