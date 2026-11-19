# Notebook video overviews

For user instructions, see [Sources and media](../docs/sources-and-media.md).

## Local version implemented first

The Videos page now offers a notebook selector and Generate video action. One local background job reads up to 20 ordered Open Notebook sources, using at most 1,000 characters per source and 18,000 characters in all. Gemma writes a three to five slide script with explicit source IDs. The app rejects malformed slides and unknown IDs. Kokoro narrates each slide; librsvg makes the slide images; FFmpeg assembles the MP4. The page shows progress and adds the completed video to the shelf under its notebook. Existing tutorial recordings remain available.

The render writes no Open Notebook notes and changes no `.learn` study state. Temporary media, the script, source IDs, and hashes of the excerpts live in the ignored `docs/.video-renders/` directory. The completed MP4 lives in `docs/` and remains local. A request's `mutation_id` resolves to one job, including after a lost response. An interrupted job is reported as failed; a partial file is never listed as a completed video.

This is a short orientation, not a comprehensive treatment of a book or course. The source cap and excerpt cap are visible in the UI, and the shelf reports how many sources each video used. The current output is narrated slides without captions. Source titles on each slide point back to the notebook for checking details.

## Higgsfield is the preferred visual path

James prefers Higgsfield's video options and quality. He reports an Ultra subscription with 3,000 monthly credits. Keep the local renderer as a fallback and as a way to preview the source-grounded script. The Higgsfield workflow starts with a locally generated, reviewable storyboard. Send only the approved storyboard and visual direction; never upload raw notebook sources by default. Save the result with its notebook and script revision so the video shelf remains organized.

The access route changes what the subscription covers. [Higgsfield's help center](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api) says its website uses the subscription, while its API is a separate prepaid product. Its [CLI](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-access-higgsfield-via-cli) and MCP connect to the subscription account but deduct plan credits for every generation; website-only Unlimited/free generations do not carry over. The [credits guide](https://higgsfield.ai/creator-hub/help-center/credits/how-credits-work) confirms this. Do not wire the API merely because the user has a website subscription.

The first shipped route hands off an editable storyboard for Higgsfield's visual tools. James can download the result into `docs/` using the notebook filename shown in the app, which groups it on the video shelf. An automated CLI route should use his plan credits after sign-in and model selection. Higgsfield's [video explainer skill](https://github.com/higgsfield-ai/skills/blob/main/higgsfield-video-explainer/SKILL.md) describes matched ten-second narration and visual blocks followed by assembly; use its live preset and voice catalog rather than assuming one model call will make a faithful multi-scene video. Before a paid render, show the exact prompts, model, duration, credit cost, and the material being sent. The CLI is not on the Mac's normal PATH yet; its public `generate cost` command can estimate credits without creating a job. Compare one Higgsfield draft with the local narration for source fidelity and usefulness before making it the normal study flow.

## Follow-up improvements

- Offer source selection or a hierarchical summary for notebooks with more than 20 sources.
- Add captions from the validated narration text and verify sync on a real notebook render.
- Add a script review step if overviews are used as durable learning material rather than quick previews.
