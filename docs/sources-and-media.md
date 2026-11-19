# Sources and media

These workflows shipped in Forgejo PR #102 on September 23, 2026. Open Notebook
stores source material and podcasts; StudyDeck connects it to the local study loop.

## Choose a notebook

Select a notebook in the rail to change the active topic. **+ New** creates an
Open Notebook notebook, maps it in `app/cockpit.config.json`, and creates an empty
`.learn/topics/<slug>/` directory. Add sources, then ask the learning agent to build
the curriculum. Notebook creation does not generate a knowledge map of the subject.

## Find and add sources

1. Open **Sources / Reading Room**, enter a topic or sentence, and start the internet search.
2. Watch the activity indicator and elapsed timer. Retrieval and local assessment
   can take several minutes. The timer is not a completion estimate or backend stage report.
3. Review recommendations, supporting excerpts, and caveats. Filter by source type
   to find websites, PDFs, videos, blogs, vendor documentation, or training material.
4. Choose **Use this source** to fill the add-source form, then **Add to notebook**
   to import it. Searching alone never imports anything.
5. Use **Refresh sources** after Open Notebook finishes processing the import.

You can also choose **+ Add source** and enter a link or paste text directly.
Search makes six targeted queries, deduplicates results, assesses up to 24 candidates,
and displays at most 12 recommendations. Assessment reads short text excerpts. It
neither reads an entire book nor watches a video. Review the shortlist yourself.

Partial retrieval failures report incomplete coverage. Invalid assessments are
excluded when valid assessments remain. If assessment fails entirely, fallback
results are labeled **preliminary**. A provider outage returns an error.

After one minute, the activity message explains that work is still pending. Leaving
this view stops the browser request, but bounded server work can continue. Repeating
the same query can reuse an in-flight search or a result cached for five minutes.
A different query is rejected while another search is running.

## Upload PDFs and other files

Choose **Upload a PDF or file in Open Notebook** in the add-source form. Log into
the local UI, normally `http://127.0.0.1:8502`, select the matching notebook, and
upload there. Return to StudyDeck and refresh the source list after processing.

In this installation, the login password is the value of `OPEN_NOTEBOOK_PASSWORD`
in `~/Projects/quorum/.env`, without surrounding quotes. StudyDeck reads it
server-side for API access; it does not automatically log the browser into Open
Notebook. Never put this password in committed app configuration.

Open Notebook's **Migrate to Database** notice concerns provider credentials, not
the login password or PDFs. Migration is separate from a software update and is not
required to use the upload link. Before migrating credentials, securely preserve
`OPEN_NOTEBOOK_ENCRYPTION_KEY` as part of the database recovery procedure. A database
backup cannot decrypt credentials without the same key.

## Browse podcasts

The Podcast page filters by notebook and sorts by completion date or title.
Completion dates come from completed generation jobs when available; missing dates
remain unknown. Episodes without a unique notebook match appear under **Unassigned**.
If some notebook sources are unavailable, the page reports incomplete matching.

## Prepare a Higgsfield storyboard

On **Videos**, select a notebook with sources and choose **Prepare storyboard**.
The local model prepares three to five scenes with narration, visual prompts, and
source references. This spends no Higgsfield credits and submits no cloud job.

Review the references and edit the handoff prompt before choosing **Copy prompt**
and **Open Higgsfield**. Edits in the page are not saved back to the prepared job;
keep your edited prompt before leaving or refreshing. Review the model, material
being sent, and price in Higgsfield before generating. StudyDeck does not submit
or retrieve Higgsfield generations automatically.

Save the downloaded MP4 in StudyDeck's `docs/` folder using the filename shown in
the handoff, such as `<topic-slug>-higgsfield-1.mp4`. Reopen Videos to load the updated
shelf. The notebook prefix groups the file. Use another suffix for additional videos.

## Generate a local video

Choose **Generate local video** for a narrated slide overview rendered on this Mac.
It uses the configured local language model, Speaches/Kokoro, `rsvg-convert`, and
FFmpeg/ffprobe. Progress appears on the page and the completed MP4 joins the shelf.
You can leave the page while the server works.

Both video paths use up to 20 ordered sources, at most 1,000 characters per source
and 18,000 characters total. They produce short orientation material, not a complete
lesson. Source-ID validation checks references, not the truth of generated claims.
Check important claims against the sources. Local videos do not yet have captions.
Failed or interrupted jobs report errors; start a new job after fixing the cause.

## Setup and storage

| Setting or service | Purpose |
|---|---|
| Firecrawl CLI and local API on `127.0.0.1:3002` | Search and extraction; see the [deployment guide](../ops/firecrawl/README.md) |
| `STUDYDECK_FIRECRAWL_BIN` | Optional absolute path to the Firecrawl executable |
| `STUDYDECK_SOURCE_SEARCH_MODEL` | Assessment model; defaults to `qwen2.5:7b-instruct` |
| `app/cockpit.config.json` | Notebook mappings and model/service endpoints; keep it secret-free |
| `STUDYDECK_VIDEO_DIR` | Optional replacement for the default `docs/` media directory |
| `STUDYDECK_VIDEO_VOICE` | Kokoro narration voice; defaults to `af_nova` |
| `STUDYDECK_RSVG_CONVERT`, `STUDYDECK_FFMPEG`, `STUDYDECK_FFPROBE` | Optional renderer executable paths |

Source assessment requires a loopback Ollama endpoint and has no cloud-model fallback.
Local crawling still contacts internet search engines and websites. CLI credentials
stay outside the browser. Provider services must be running for their features.

Generated MP4s, `docs/.video-renders/`, `docs/.higgsfield-prep/`, and
`ops/firecrawl/.env.local` stay local and ignored by Git. If you choose an alternative
media directory inside the repository, exclude it separately. Back up wanted media
and Open Notebook's database separately; pushing StudyDeck does not preserve them.

See [source-search implementation](../tasks/source-search-2026-09-23.md) and
[video-overview implementation](../tasks/video-overview-plan-2026-09-22.md) for details.
