# Local TTS for Open Notebook, without a paid service

**Date:** 2026-07-19
**Context:** StudyDeck cockpit — podcast audio was blocked on a missing `text_to_speech` model.

## The problem

Open Notebook could not render podcast audio because no `text_to_speech` model was
registered, and it was unclear whether that required a paid remote service or could be
satisfied by something local.

## The approach

1. **Ask the service what it supports, don't infer it.** `GET /api/providers` returns a
   modality matrix for every provider ON knows. That single call answered the whole
   question: `ollama` is `["language","embedding"]` — it can *never* do TTS — while
   `openai_compatible` is `["language","embedding","speech_to_text","text_to_speech"]`.
   The local path existed and was documented; no amount of reading the cockpit's code
   would have shown that, because the constraint lived in the external service.
2. **Confirm the gate is real before building on it.** `?type=text_to_speech` returned
   `[]`, but so would an *ignored* query param. Probing with a nonsense type
   (`?type=total_nonsense_value`) also returned `[]`, proving ON applies the filter. Only
   then was `tts_ready` trustworthy as a signal.
3. **Check the image architecture before pulling.** `docker manifest inspect` showed
   `ghcr.io/speaches-ai/speaches:latest-cpu` publishes arm64. On Apple Silicon this is the
   difference between a five-minute setup and an hour discovering a CUDA-only image.
4. **Follow the target service's own integration guide.** ON documents Speaches
   specifically, with the exact model id (`speaches-ai/Kokoro-82M-v1.0-ONNX`) and port.
   Picking the server its docs are written against removed all guesswork from the ON side.
5. **Verify by synthesizing, not by reading config.** Registering the model flipped
   `tts_ready`, but the *speaker profile* still referenced voices the new backend rejects.
   Only an actual `POST /v1/audio/speech` per configured voice surfaced that.

## The judgment calls

- **Joined the existing Docker network instead of `host.docker.internal`.** ON's docs
  prescribe `host.docker.internal:8969`, which requires binding the TTS port to `0.0.0.0`
  and exposing it to the LAN. Attaching the container to ON's existing network lets ON
  reach it as `http://speaches:8000/v1` with nothing published beyond `127.0.0.1`. Chose
  the more private option because both work and only one has a downside.
- **Did not modify the host project's `docker-compose.yml`.** Speaches lives in its own
  compose file that declares the shared network `external: true`. The other project stays
  unmodified and independently upgradeable.
- **Did not build the generate path.** Registering a TTS model unblocks *playback*; making
  episodes still needs a `POST /api/podcasts/generate` wrapper. Kept the scope to what was
  asked and documented the boundary rather than quietly expanding.
- **Remapped voices faithfully rather than choosing new ones.** `nova → af_nova`,
  `alloy → af_alloy` preserves the author's stated intent exactly. Voice selection is a
  taste decision belonging to the user, so the fix made no aesthetic choice.

## The gotcha that cost the most

`alloy` **silently resolved** to `af_alloy` and returned valid audio, while `nova` returned
a `422`. One inconsistent success is more dangerous than two clean failures: testing only
the working voice would have shipped a config that breaks at generate time. Test *every*
configured value, not a representative one.

## The reusable rule

> When a feature is blocked by an external service, query the service's own capability
> endpoint before deciding what's possible — and once configured, exercise every value the
> config actually contains, because a partial alias match will fake success for the subset
> you happen to test.
