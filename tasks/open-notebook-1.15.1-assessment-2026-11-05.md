# Open Notebook upgrade assessment: 1.13.0 → 1.15.1

Assessed 2026-11-05. Sources: `GET /api/config` on the running instance (reports
`version 1.13.0`, `latestVersion 1.15.1`), the GitHub release notes for v1.14.0, v1.15.0 and
v1.15.1, and a check of what StudyDeck actually calls and configures.

Running: `lfnovo/open_notebook:v1-latest` (container `quorum-open_notebook-1`), pulled at 1.13.0.
StudyDeck pins `openNotebook.expectedVersion: "1.13"` in `app/cockpit.config.json`.

## Verdict

**Upgrade, but change one setting first.** 1.15.1 is a security release that includes the
1.14 and 1.15 fixes, and several of those fixes address podcast failures StudyDeck has hit.
One behaviour change will break the `study-deep-dive` podcast unless you act on it: the new
180-second model timeout.

## Changes that affect StudyDeck directly

| Change | Version | Impact here | Action |
|---|---|---|---|
| **Model calls time out after 180 s by default** (`ESPERANTO_LLM_TIMEOUT`). Before this, Ollama calls had no time limit. The web UI gives up after 10 min, so values above 600 s don't help. | 1.15.0 | **Breaking.** `study-deep-dive` runs its outline and transcript on `gemma4:31b-mlx`, and the outline step alone took about 34 min. It will time out even at the 600 s ceiling. `study-overview` and `study-chapter` use `qwen2.5:7b-instruct`, which is fast enough. | Set `ESPERANTO_LLM_TIMEOUT=420` on the API and worker in `~/Projects/quorum`. Move `study-deep-dive` to `qwen2.5:7b-instruct`, or to another non-reasoning model that finishes within the limit. |
| Podcast outlines and transcripts now default to **8192 output tokens** (previously 3000 / 5000) | 1.15.0 | Longer generations on local models make the timeout more likely. | Set **Max output tokens** on the study profiles if episodes start timing out. |
| Podcasts fall back to plain JSON when a model rejects schema output, and the prompt no longer contains a copyable skeleton | 1.15.0 | Helps directly: the outline JSON parse failures in CLAUDE.md happen in this same code path. | None. Re-test the "non-reasoning model" rule afterwards. Reasoning models still return an empty `response`. |
| ~400 ms pause between speaker turns; combining clips no longer clips the end of a turn | 1.15.0 | Podcasts should sound better. **There is still no loudness normalization**, so the per-clip `loudnorm` step is still needed. | None. |
| Clear failure hints for wrong speaker names, unsupported voices and truncated output | 1.15.0 | Faster diagnosis of the Kokoro voice-name problem. | None. |
| The seeded, unconfigured speaker profiles no longer fail every podcast | 1.15.0 | Removes one class of generate-time failure. | None. |
| The episode profile `language` setting is now honoured | 1.15.0 | Neutral (English). | None. |
| The worker no longer stalls when a source is deleted mid-processing; failed sources fail once with a reason instead of retrying 15 times | 1.15.0 | Fewer stuck jobs. **Unrelated** to the stale LIVE-query problem in CLAUDE.md, so keep the `docker restart` fix. | None. |
| A database failure loading a single record now returns **500, not 404** | 1.15.0 | StudyDeck has no code that treats an ON 404 as "missing", so it already surfaces 500s as service errors. | Run `npm run verify:live` after the upgrade. |
| Sources that used to "complete" with empty content now **fail** | 1.15.0 | The Add-to-notebook / source search flow shows a failed source instead of an empty one. This is an improvement. | None. |
| `POST /api/commands/jobs` removed (now returns 405) | 1.15.1 | **No impact.** StudyDeck never calls it (grep confirmed). The podcast job poll uses `GET /api/commands/jobs/{id}`, which is unchanged. | None. |
| Uploads-directory and URL checks enforced in the worker; content-core 2.2.1 refuses link-local and metadata addresses on every redirect hop | 1.15.1 | Loopback and private addresses (Ollama, Speaches at `speaches:8000`) are explicitly still allowed. | None. |
| Credential encryption moves to PBKDF2 (`pbkdf2v1:`) through an opt-in `POST /api/credentials/migrate-encryption` | 1.15.0 | Old keys keep working. **Rolling back below 1.15 after migrating needs a database backup.** | Back up `notebook_data` / SurrealDB before upgrading, and again before migrating. |
| `OPEN_NOTEBOOK_WORKER_MAX_TASKS` (default 5) | 1.14.0 | On a single Mac running local models, 1–2 avoids parallel ingestion competing with podcast renders. | Optional. |
| DNS-pinned outbound provider calls; private, `localhost` and Docker hostnames still supported | 1.14.0 | No impact on `ollama` or `openai_compatible` → `speaches`. | None. |
| Per-transformation model selection now takes effect | 1.14.0 | Transformations may now run on a model other than the default. | Check transformation settings. |

## Other additions (no StudyDeck impact)

- "Quiet Green" UI redesign at :8502. Settings → "API Keys" is now **Manage → Models**.
- New providers: Cohere, PPQ, Novita, oMLX (first-class), OpenRouter TTS/STT,
  `anthropic_compatible`, SiliconFlow, Z.ai, MiniMax TTS.
- Docling formula and vision enrichment toggles (opt-in). `.odt` / `.ods` / `.odp` / `.htm` uploads.
- YouTube transcripts through a proxy or cookies file (`CCORE_YOUTUBE_PROXY`, `CCORE_YOUTUBE_COOKIES_FILE`).
- Ask answers are no longer cut off at 2000 tokens. An empty model reply is now an error. Source chat streaming fixes.
- Full docs rewrite, including an environment-variable reference.

## Upgrade checklist

1. Back up `~/Projects/quorum/notebook_data` and the SurrealDB volume.
2. Add `ESPERANTO_LLM_TIMEOUT=420` to the ON service environment.
3. `docker compose pull open_notebook && docker compose up -d open_notebook` in `~/Projects/quorum`.
4. Confirm `GET /api/config` reports `1.15.1`. Update `expectedVersion` in
   `app/cockpit.config.json` to `"1.15"`, otherwise the cockpit's health check reports a version mismatch.
5. `npm run verify:live` (exit 0 = no contract drift).
6. Move `study-deep-dive` off `gemma4:31b-mlx` (GET by name, PUT by id), then generate one
   short episode end to end and watch for `Starting podcast generation` in the log.
7. Run the credential encryption migration later, once a backup is confirmed.
