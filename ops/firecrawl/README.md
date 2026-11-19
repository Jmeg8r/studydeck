# Local Firecrawl for StudyDeck

This overlay runs the existing Firecrawl checkout without editing its Compose file.
It publishes only `127.0.0.1:3002` and sets `unless-stopped` restart policies.
Firecrawl's existing `.env` and CLI credentials remain authoritative. No hosted
Firecrawl account or cloud model is configured by this overlay.

Start or rebuild:

```sh
docker compose \
  --project-directory "$HOME/Projects/firecrawl" \
  -f "$HOME/Projects/firecrawl/docker-compose.yaml" \
  -f "$HOME/Projects/studydeck/ops/firecrawl/compose.override.yaml" \
  up -d --build --wait --wait-timeout 180
```

Inspect services:

```sh
docker compose \
  --project-directory "$HOME/Projects/firecrawl" \
  -f "$HOME/Projects/firecrawl/docker-compose.yaml" \
  -f "$HOME/Projects/studydeck/ops/firecrawl/compose.override.yaml" \
  ps
```

Docker Desktop must be running. Restart policies recover containers when Docker
starts, unless they were explicitly stopped. They do not start Docker Desktop.
The base checkout at restoration time is commit
`66605d35f7ae38d8bdb74a13db5294b2bcb8d7e4`.

## Search backend

The overlay includes SearXNG on the private Docker network, with Google, Bing, and
Brave engines. Firecrawl reaches it at `http://searxng:8080`; no SearXNG port is
published. This avoids depending solely on Firecrawl's DuckDuckGo fallback, which
blocked repeated queries during live verification. Individual engines and source
sites can still rate-limit or refuse extraction.

The SearXNG image is pinned by digest. Its configuration follows the official
[settings documentation](https://docs.searxng.org/admin/settings/settings.html).
The generated `SEARXNG_SECRET` is in `.env.local`, excluded by the adjacent
`.gitignore` and readable only by the owner. Preserve this file when restarting.
On a fresh checkout, generate it before the startup command:

```sh
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path.home() / 'Projects/studydeck/ops/firecrawl/.env.local'
if not p.exists():
    p.write_text('SEARXNG_SECRET=' + secrets.token_hex(32) + '\n')
    p.chmod(0o600)
PY
```

## Restoration acceptance

Verified on 2026-09-22 EDT:

- All six services running, with `unless-stopped` restart policies.
- Firecrawl API bound to `127.0.0.1:3002`; SearXNG is private to Docker.
- Real search and page extraction succeeded through the installed Firecrawl CLI.
- The live StudyDeck Sources screen displayed 12 assessed recommendations from
  24 candidates across all six source categories. Two unassessed candidates were
  excluded with a visible warning.
- 381 StudyDeck tests passed; the learning-data integrity check found no damage.

Searches can take a few minutes because they retrieve page text and assess
candidates locally. An individual engine or source may still block requests;
StudyDeck reports incomplete coverage instead of concealing it.

## StudyDeck connection

The installed Firecrawl CLI must point to this local API. The overlay does not
change CLI credentials. StudyDeck finds `firecrawl` beside its Node executable or
on PATH; set `STUDYDECK_FIRECRAWL_BIN` to an absolute path when needed. Source
assessment uses local Ollama and defaults to `qwen2.5:7b-instruct`, independently
of the model selected for video scripts.

The Sources screen displays an activity indicator and elapsed timer during search.
The timer does not report a measured completion percentage. Read the
[Sources and media guide](../../docs/sources-and-media.md) for importing results
and the [implementation notes](../../tasks/source-search-2026-09-23.md) for
timeouts, cache behavior, and preliminary-result handling.
