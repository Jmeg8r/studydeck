# Internet source search

For user instructions, see [Sources and media](../docs/sources-and-media.md).

The Reading Room / Sources screen now accepts a topic or sentence and discovers
websites, PDFs, YouTube videos, blogs, vendor documentation, and training material.
Search results are separate from notebook sources. Use this source fills the existing
add-source form; Add to notebook is still the action that imports material.

## Selection

The server makes six targeted Firecrawl searches with five results each and at most
two requests in flight. It requests page markdown, normalizes links, removes duplicate
URLs, drops results without topic terms, and assesses up to 24 candidates locally, one at a time.
The assessment considers relevance, evidence of authority, educational usefulness,
and currency. Recommendations must reference supplied candidate IDs and include a
verbatim supporting excerpt. Invented URLs, missing IDs, duplicate IDs, or fabricated
quotes invalidate that candidate assessment. Candidates that cannot be assessed are
excluded with a visible warning; valid recommendations remain available. At most 12 recommendations are displayed, with
at most two per hostname, or four for YouTube.

This is a bounded shortlist, not a guarantee of the best material on the entire web.
The model reads excerpts of up to 2,000 characters, not whole books or videos.
Video judgments use retrieved text; they do not imply that the video was watched.
Each result distinguishes page text from search descriptions. Classification is
heuristic and can have multiple types. Missing source categories are not invented.

If assessment fails, results are explicitly labeled preliminary, not vetted. Partial
search failures report incomplete coverage. A provider outage returns an error.
Same-query results are cached in process for five minutes, with ten entries maximum.
A different search while one is running returns 429. Search is read-only, so it does
not use mutation IDs; importing reuses the existing source-creation mutation flow.

## Runtime

- Firecrawl CLI must be installed and its configured API must be reachable. The app
  uses a CLI alongside the Node executable when available, or PATH otherwise.
  `STUDYDECK_FIRECRAWL_BIN` may supply an absolute executable path.
- The CLI owns its credentials. They never enter the browser or app configuration.
- `STUDYDECK_SOURCE_SEARCH_MODEL` defaults to the installed local
  `qwen2.5:7b-instruct`. Assessment uses the configured Ollama endpoint and requires a
  loopback hostname. There is no cloud-model fallback.
- Provider requests have a 60-second process bound; assessment has a shared 120-second bound.
  Search may take up to five minutes. Leaving the view aborts the browser request;
  server work remains bounded and its result may populate the short-lived cache.

Local Firecrawl was restored with user authorization. Its CLI still points to
`http://localhost:3002`. The API is published only on loopback. Six containers now
run with `unless-stopped` restart policies: API, Playwright, Redis, RabbitMQ,
Postgres, and SearXNG. The upstream Firecrawl checkout remains unchanged.

The [Compose overlay and runbook](../ops/firecrawl/README.md) record startup and
recovery. Firecrawl uses private-network SearXNG with Google, Bing, and Brave,
because its standalone DuckDuckGo fallback blocked repeated queries during testing.
No hosted Firecrawl endpoint or cloud model was enabled.

## Verification

- 381 tests passed, including new ranking/parser and HTTP-to-CLI recorder coverage.
- `npm run verify` found no learning-data damage.
- Desktop and 390px mobile browser verification passed search submission, category
  filters, selection into the add form, explicit import, provider failure, and retry.
  Notebook requests were intercepted and learning data was copied to a scratch root.
- A real local Qwen assessment of a supplied test excerpt returned a source-specific
  reason, a missing-author/date caveat, and a validated verbatim excerpt.
- Live Firecrawl searches returned extracted documentation and training material,
  including Hugging Face, LangChain, Coursera, DeepLearning.AI, and Microsoft Learn.
- A recorded model omission initially changed the result from expected `assessed`
  to actual `preliminary`. The regression now passes with individual assessment.
  A second regression proves one invalid response does not discard valid sources.
- A 24-candidate run demonstrated that the original 60-second assessment budget
  was insufficient. The budget is now 120 seconds, with partial coverage disclosed.
- Final live browser acceptance passed for `retrieval augmented generation`:
  24 candidates produced 12 assessed recommendations spanning Website, Training,
  PDF, Vendor / documentation, Video, and Blog. Two candidates failed assessment
  and were explicitly excluded. Search output was visible in the real Sources
  screen; the notebook remained at zero sources because no import was performed.

## Search activity indicator

The search now shows an animated spinner, a live elapsed timer, and a Searching
button state for the full request. After one minute the message acknowledges the
longer wait. It displays elapsed time rather than an estimated completion percentage.
Motion stops for reduced-motion preferences. Completion, failure, and view disposal
clear the interval and hide the indicator; a repeated search starts a fresh timer.

Verified in an isolated browser fixture with a deliberately pending request: the
old view had only static text; the new timer advanced from 0:00 to 0:11. Success,
error, retry, and disposal paths passed. All 381 tests passed. Both updated static
files were verified byte-for-byte through the live server without restarting it or
interrupting the user's search. Already-open pages need a refresh to load the update.
