# Podcast config — version-controlled Open Notebook profiles

The working podcast setup (episode profiles, speaker profiles, and the models they wire
to) lives in Open Notebook's SurrealDB, **not** in this repo. A rebuilt or drifted ON
therefore can't reproduce a render. This directory is the reproducible snapshot: the
config exported to JSON, plus scripts to dump it and re-apply it.

## Layout

```
app/podcast/
  on.mjs                       admin ON client (bearer resolved server-side, never printed)
  export.mjs                   ON  → profiles/*.json
  restore.mjs                  profiles/*.json → ON   (supports --dry-run)
  profiles/
    episode-profiles.json      all episode profiles, model refs by name
    speaker-profiles.json      all speaker profiles, voices + voice_model by name
    models.json                the models the profiles reference (must be registered in ON)
```

## Why model refs are stored by name, not id

SurrealDB record ids (`model:r59kjwf00i4clh658tl6`, `speaker_profile:x9vc…`) are
**instance-specific and drift across rebuilds** — the same `qwen2.5:7b-instruct` had a
different id before this snapshot was taken. So the export resolves every id out to its
portable identity:

- **Models** → `{ provider, type, name }`, e.g. `{ ollama, language, qwen2.5:7b-instruct }`.
  Provider is part of the identity because two providers can register the same name.
  Restore still reads the older plain-name strings, through `models.json`, and refuses
  one that `models.json` lists under two providers.
- **An episode profile's speaker** → the speaker profile's **name** (`tech_experts`).

`restore.mjs` resolves those back to whatever ids the target ON assigns. Never hand-edit a
record id into these files — it won't survive a rebuild.

## Usage

Both scripts read the ON base URL and bearer from the same place the cockpit does
(`app/cockpit.config.json` → `~/Projects/quorum/.env`). No secret is ever written here.

```bash
# Snapshot the current ON config into profiles/*.json (run after editing any profile in ON)
node app/podcast/export.mjs

# Preview what a restore would change — touches nothing
node app/podcast/restore.mjs --dry-run

# Re-apply the snapshot to ON (idempotent: existing profiles are updated, not duplicated)
node app/podcast/restore.mjs
```

`profiles/*.json` is the source of truth the repo keeps; ON's SurrealDB is the live copy.
After changing a profile in ON, re-run `export.mjs` and commit the diff.

## Models are verified, not created

Restore **checks** that every referenced model in `models.json` is registered in the
target ON and stops with a named list if any is missing — it does not create them. It
checks every speaker and model reference in every profile before its first write, and
`--dry-run` runs the same check, so a bad profile set changes nothing in ON.
Registering an `ollama` / `openai_compatible` model needs provider credentials and is
environment-specific. Register missing models first (ON Models page, or
`POST /api/models/sync/<provider>`), then re-run restore. The three models this config
needs:

| type | provider | name | role |
|---|---|---|---|
| language | ollama | `qwen2.5:7b-instruct` | `study-overview` outline + transcript (fast, non-reasoning) |
| language | ollama | `gemma4:31b-mlx` | `study-deep-dive` outline + transcript |
| text_to_speech | openai_compatible | `speaches-ai/Kokoro-82M-v1.0-ONNX` | all speaker voices |

Reasoning models (e.g. `qwen3.6:35b-a3b`) **cannot** drive the outline node — they return
an empty `response` with everything in a `thinking` field, and podcast-creator's LangChain
chain fails to parse it. See the top-level `CLAUDE.md` "External services" notes.

## Manual recreate (fallback, no scripts)

Each entry in `profiles/*.json` maps directly to an ON API body:

- Speaker profile → `POST /api/speaker-profiles` with `{name, description, speakers, voice_model}`
  (`voice_model` = the registered TTS model's id).
- Episode profile → `POST /api/episode-profiles` with `{name, description, speaker_config,
  default_briefing, num_segments, language, outline_llm, transcript_llm}` (`speaker_config`
  = the speaker profile's id; the `*_llm` fields = the registered language model's id).

Route asymmetry to remember: both profile types are **GET by name, PUT by id**. Create is
on the collection route. Voices must be Kokoro-native ids (`af_nova`, `am_adam` …), not
OpenAI names.
