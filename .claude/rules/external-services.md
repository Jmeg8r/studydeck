---
paths:
  - "app/**"
  - "ops/**"
---

# External services — full notes

Moved out of `CLAUDE.md` (which keeps a one-line summary of each under *External services*).
Claude Code loads this file when it works under `app/` or `ops/`; any other agent should read
it before touching Open Notebook (ON), ollama, or TTS code.

None of these is discoverable from the code, and each produced a wrong conclusion before
being pinned down.

- **The local model ignores ollama's `format` JSON schema.** `gemma4:31b-mlx` wraps its
  output in ``` fences and omits fields the schema marked `required`, even when a schema is
  supplied. **Never `JSON.parse` a model response directly.** Strip fences, fall back to the
  outermost `{...}` pair, and return null rather than guessing — `extractJson` in
  `app/lib/ollama.mjs` is the working implementation. A grade or a card set must never be
  invented from unparseable output; fail with the "do it in an interactive agent session"
  fallback instead.

- **Open Notebook's list endpoints omit the bodies.** `GET /api/sources` returns no
  `full_text`; `GET /api/notes` returns no `content`. Both need the detail route
  (`/api/sources/:id`, `/api/notes/:id`). This looks exactly like data loss: a highlight saved
  correctly appears to have empty content in the list response, which nearly got "fixed" as a
  bug that did not exist.

- **Podcast routes use hyphens**, and the underscore forms 404: `/api/episode-profiles`,
  `/api/podcasts/episodes`, `/api/podcasts/episodes/:id/audio`. Fixed route segments use
  hyphens (`episode-profiles`); a profile *name* is an exact identifier and keeps its own
  separator when used in a URL (`tech_experts`, `study-overview`). When an ON path is uncertain, read
  `localhost:5055/openapi.json` — it lists the installed routes — rather than guessing from
  notes.

- **A `text_to_speech` model unblocks podcast *playback*, not *generation*.** A local
  Speaches/Kokoro model is registered (TTS bullet below), so `tts_ready` is true and the
  Podcast view's blocked banner is gone. Generation is a separate path: `feat/podcast-generate`
  (2026-07-19) wraps `POST /api/podcasts/generate` and the job poll, the view has a Generate
  button, and an episode has
  rendered end to end and played. The `tts_ready` gate itself is trustworthy:
  `GET /api/models?type=text_to_speech` really filters (a bogus `type=` also returns `[]`, so
  it isn't an ignored param). Second, quieter gate: Migration 22 left
  `transcript_llm`/`outline_llm` unset on the stock profiles (`business_analysis`,
  `solo_expert`), so those would fail at generate time regardless (`tech_discussion` has since
  been given `qwen2.5:7b-instruct`). The
  study profiles (`study-overview`, `study-deep-dive`, `study-chapter`) set both, per
  `app/podcast/profiles/episode-profiles.json`.

- **A podcast job stuck at `running` usually means the worker never saw it.** ON's
  `surreal_commands` worker subscribes to new commands via a **SurrealDB LIVE query set up
  once at worker start**. If that subscription goes stale, the API still accepts the request
  and writes the episode row — the job then sits at `running` with `progress: null` and an
  empty `error_message`, forever. This is indistinguishable from a slow render in the UI, and
  it burned two sessions being misdiagnosed as memory exhaustion. **Discriminate with the log,
  not the status:** a healthy generate prints `commands.podcast_commands:generate_podcast_
  command:<line> - Starting podcast generation for episode: <name>` within ~1s of the click
  (the line number moves between releases: 75 on 1.13, 130 on 1.15.1, so grep the message). No
  line ⇒ never started; waiting will not help. Fix: `docker restart quorum-open_notebook-1`.
  The restart does **not** drain commands queued while the listener was dead — those rows
  stay `running` permanently and need `DELETE /api/podcasts/episodes/{id}`.

- **Outline generation needs a non-reasoning model.** The outline node parses structured JSON
  **inside podcast-creator's LangChain chain** — a dependency of ON, so `extractJson` in
  `app/lib/ollama.mjs` is not in that path and cannot defend it. Reasoning models fail hard:
  `qwen3.6:35b-a3b` returns an *empty* `response` with everything in a separate `thinking`
  field, producing `Invalid json output:` with nothing after the colon. Vet a candidate with
  one curl before wiring it into a profile — `curl localhost:11434/api/generate -d
  '{"model":"<m>","prompt":"Return ONLY valid JSON: {\"a\":1}","stream":false}' | jq
  '{response, thinking}'`; empty `response` ⇒ unusable. Known-good: `qwen2.5:7b-instruct`
  (fast, fence-wrapped JSON, which LangChain strips) and `qwen3-coder:30b` (clean JSON, no
  thinking channel, ~109 tok/s; drives `study-deep-dive` since 2026-11-05). Episode profiles
  are asymmetric like speaker profiles: **GET by name, PUT by id**, stripping
  `id`/`created`/`updated`/`speaker_config_name`. A model registered through `POST
  /api/models` gets `credential: null` unless you pass the one the other Ollama models use,
  and there is no PUT: delete and recreate.

- **Since ON 1.15 every model call has a time limit, and a slow model is now a broken one.**
  `ESPERANTO_LLM_TIMEOUT` defaults to 180 s (before 1.15, Ollama calls waited forever).
  `~/Projects/quorum/docker-compose.yml` sets 420; going past 600 does not help, because the
  web UI abandons a request at 10 minutes. That ruled out `gemma4:31b-mlx` for podcasts: its
  outline node alone took ~34 min. Vet a candidate's speed as well as its JSON before wiring
  it into a profile. Upgrade notes: `tasks/open-notebook-1.15.1-assessment-2026-11-05.md`.

- **TTS is local, and Kokoro rejects OpenAI voice names.** Speaches serves
  `speaches-ai/Kokoro-82M-v1.0-ONNX`; compose lives at `~/Projects/speaches/docker-compose.yml`,
  joined to the `quorum_default` network so ON reaches it at `http://speaches:8000/v1` with
  nothing published beyond `127.0.0.1:8969`. **Voices must be Kokoro-native ids** (`af_nova`,
  `af_bella`, `am_adam` …); OpenAI names mostly 404 the request with a `422`. The trap is that
  aliasing is *partial* — `alloy` silently resolves to `af_alloy` and returns valid audio while
  `nova` errors, so testing one voice can "prove" a config that breaks on the other. Test every
  voice a speaker profile actually references. Full list:
  `GET localhost:8969/v1/audio/voices?model_id=<model>`.
  Second Kokoro trap: **voices differ wildly in inherent loudness and ON never normalizes** —
  measured `af_nova` at −27.2 LUFS vs `am_fenrir` at −19.2 (8 LU ≈ twice as loud), straight
  concatenation in `combine_audio_node`. Leveling is post-render: per-clip
  `ffmpeg loudnorm=I=-16:TP=-1.5:LRA=11` over `clips/` (speaker per clip comes from the
  render log's "audio clip NNNN for <name>" lines), concat, re-encode 128k, replace the
  episode MP3 (bind mount: `~/Projects/quorum/notebook_data/podcasts/episodes/<uuid>/`).
  Recipe + measurements: `tasks/implementation-notes.md`. Also: `ffmpeg` inside a
  `while read` loop needs `-nostdin` or it eats the loop's stdin.

- **The Claude API (Roles view) behaves unlike the local model in four ways that matter.**
  `app/lib/claude.mjs` calls `POST /v1/messages` with Node's own `fetch`; there is no SDK, so
  retry and error mapping live there. (1) On `claude-opus-5-5` **thinking cannot be turned
  off** — send no `thinking` field, control depth with `output_config.effort` — and each
  reply carries thinking blocks **bound to the exact conversation prefix**. Replay stored
  assistant `content` byte for byte and never change a session's system prompt, or a later
  turn is a 400. (2) Thinking counts toward `max_tokens`, so a reply can come back **billed
  and with no text**; `sessions.mjs` records that as a `charge` line so the spending limit
  still sees it. (3) A safety decline is **HTTP 200 with `stop_reason: "refusal"`**, not an
  error; read `stop_reason` before `content`. Fallbacks are requested with a beta header, and
  an account without that beta gets a 400 naming the header — the client drops it once per
  process. (4) Node's `fetch` **quotes a rejected header value in its error message**, so a
  key with a stray newline would be echoed: the key is shape-checked first and a transport
  failure is reported by error code only. The key comes from `STUDYDECK_ANTHROPIC_API_KEY`
  and from nowhere else. Point 4 was reported as reproduced by the Codex review of PR #105.
  **What the first live sessions showed (2026-10-11, two sessions, 13 replies):** replaying
  stored content with its thinking blocks was accepted on every turn; the fallback beta
  header was accepted on James's account; the system prompt was read from cache. **Still
  only from Anthropic's published guidance, never observed here:** a 400 after an edited
  prefix, a billed reply with no text, and a refusal.
  Two more things that run found. **A key must be scoped to a workspace:** an
  organization-wide key gets a 400 asking for an `anthropic-workspace-id` header, which
  this client does not send — create the key under a workspace. And **the cache lifetime
  is set to one hour on purpose:** with the five-minute default, a learner who thinks
  before answering missed the cache on 8 of those 13 replies, each miss re-buying the
  whole prompt. The meter prices each cache write by the lifetime the API's
  `usage.cache_creation` reports for it: `pricePerMTok.cacheWrite` (five minutes, 1.25x
  input) or `cacheWrite1h` (2x input), with any total the API does not break down charged
  at the one-hour rate so the limit is never under-counted. `cacheWrite` kept its old
  meaning on purpose: a config file written before the change still says what it means,
  and the missing `cacheWrite1h` falls back to the built-in rate. That matters because a
  session saved before the change replays its five-minute policy. The one-hour setting
  and the `cache_creation` breakdown are both from published guidance and have not yet
  been observed live; if the breakdown is absent, every write is charged at one hour.
  See `docs/changes/2026-10-11-ai-roles/acceptance-script.md`.

- **ON's speaker-profile routes are asymmetric.** `GET /api/speaker-profiles/{x}` resolves by
  **name** (`tech_experts`); passing the real `speaker_profile:xxx` id 404s. `PUT` wants the
  **id** and rejects the name. So an edit is: GET by name → strip `id`/`created`/`updated` →
  PUT by id. Whether a provider is reachable at all is worth checking the same way — ON exposes
  a full modality matrix at `GET /api/providers`, which is how "can this run locally?" gets
  answered without guessing (`ollama` is language+embedding only and can never do TTS;
  `openai_compatible` covers all four modalities).
