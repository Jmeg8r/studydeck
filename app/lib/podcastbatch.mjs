// WHAT: Durable identity for batch-generated podcast episodes, and the retry decision
//       that rests on it.
// WHY:  Assessment finding F10. The batch named an episode after its source's title and
//       then matched episodes back to sources by that title, globally. Two notebooks
//       holding a chapter with the same name — "Introduction", "Chapter 1", anything
//       generic — and a missing episode is skipped as already done, or a terminally
//       failed row belonging to the OTHER notebook is deleted.
//
// Why the name carries the identity, rather than an id: Open Notebook gives us nothing
// else to hold on to. Verified against the live service, not from notes —
// `PodcastEpisodeResponse` has no `notebook_id` and no `job_id` (id, name,
// episode_profile, speaker_profile, briefing, audio_file, audio_url, transcript, outline,
// created, job_status, error_message), and `PodcastGenerationResponse` answers a generate
// with `job_id` + `episode_name` and no episode id. There is no server-side handle
// linking the call to the row it creates. The name is the only field we choose.
//
// So the name is made unique by construction and DERIVED, not stored: a retry recomputes
// it from the topic and source it already has. A manifest file would have to be written,
// kept, and trusted — and a lost one would silently return us to matching by title.
//
// The tag names the chapter; a RENDITION suffix names the request. Every render of one
// chapter shares the tag, so the tag alone cannot say whether a lost generate was accepted:
// an older recording answers instead. Settling a request therefore needs its rendition.
import { createHash } from 'node:crypto';

/** ` · sd-xxxxxxxx[-r-yyyyyyyyyyyyyyyy]`. The tag is one topic+source; the rendition is one request. */
const SEPARATOR = ' · ';
const TAG_PREFIX = 'sd-';
const TAG_HEX_LENGTH = 8;
const RENDITION_PREFIX = '-r-';
const RENDITION_HEX_LENGTH = 16;
const TAG_PATTERN = new RegExp(
  `${SEPARATOR}${TAG_PREFIX}([0-9a-f]{${TAG_HEX_LENGTH}})(?:${RENDITION_PREFIX}([0-9a-f]{${RENDITION_HEX_LENGTH}}))?$`,
);

const hexDigest = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length);

/**
 * The episode name for one chapter of one topic, and with `mutation`, for one request.
 *
 * Deterministic: the same topic and source always produce the same tag, and the same
 * request the same rendition, which is what lets a retry find its own earlier attempt
 * without consulting any stored state. The digest covers topic_slug AND source_id, so the
 * same chapter title in two notebooks gets two different names — the collision F10 is about.
 */
export function episodeNameFor(topicSlug, sourceId, title, mutation = null) {
  const tag = hexDigest(`${topicSlug}\n${sourceId}`, TAG_HEX_LENGTH);
  const rendition = mutation
    ? `${RENDITION_PREFIX}${hexDigest(`${topicSlug}\n${sourceId}\n${mutation}`, RENDITION_HEX_LENGTH)}`
    : '';
  return `${title}${SEPARATOR}${TAG_PREFIX}${tag}${rendition}`;
}

/** The chapter tag (8 hex) a name carries, rendition or not; null for an untagged name. */
export const sourceTag = (name) => TAG_PATTERN.exec(String(name ?? ''))?.[1] ?? null;

export const hasRendition = (name) => Boolean(TAG_PATTERN.exec(String(name ?? ''))?.[2]);

/**
 * The one episode that IS this request, or null.
 *
 * A name without a rendition is shared by every render of its chapter (or typed by hand),
 * so an exact match on it is not evidence. Two rows with one rendition name are not either.
 */
export function matchRendition(episodes, name) {
  if (!hasRendition(name)) return null;
  const matches = episodes.filter((episode) => episode.name === name);
  return matches.length === 1 ? matches[0] : null;
}

/** A rendition name without its request suffix: the chapter name the sources produce. */
export const chapterName = (name) => String(name ?? '').replace(new RegExp(`${RENDITION_PREFIX}[0-9a-f]{${RENDITION_HEX_LENGTH}}$`), '');

/**
 * The name without our tag, for display. Open Notebook's own UI shows the real name; the
 * cockpit shows the chapter. A name that never carried a tag comes back untouched, which
 * is what makes this safe to apply to every episode including the pre-F10 ones.
 */
export const displayEpisodeName = (name) => String(name ?? '').replace(TAG_PATTERN, '');

/** Does this row belong to a batch that ran before episodes carried a tag? */
export const isLegacyName = (name) => !TAG_PATTERN.test(String(name ?? ''));

/**
 * Decide what a "retry failed / missing" run should do.
 *
 * Pure, and separated from the route for the reason workerhealth.mjs is: firing a real
 * batch renders real episodes into a real notebook for half an hour, so the decision has
 * to be testable without making one.
 *
 * The asymmetry between skipping and deleting is deliberate, and it is the whole design:
 *
 *   - SKIP is safe when wrong. You do not regenerate something; you notice and re-run.
 *     So a pre-F10 row matching only by bare title still counts as done — otherwise the
 *     21 fastbook episodes already rendered would all regenerate on the next retry, at
 *     roughly half an hour each. Those skips are REPORTED rather than silent, because a
 *     title match is exactly the ambiguity this finding is about.
 *
 *   - DELETE is not safe when wrong. It is the cross-notebook data loss in F10. So only
 *     a row whose tag says it belongs to this topic and this source is ever deleted, and
 *     a legacy row is left alone even when it is terminally failed and in the way.
 */
export function planRetry({ sources, episodes, topicSlug, isRunning }) {
  const byName = new Map();
  for (const episode of episodes) {
    if (!byName.has(episode.name)) byName.set(episode.name, []);
    byName.get(episode.name).push(episode);
  }

  const done = (rows) => rows.some((e) => e.audio_available);
  const inFlight = (rows) => rows.some((e) => !e.audio_available && isRunning(e.status));

  const targets = [];
  const legacySkips = [];
  const deletable = [];

  for (const source of sources) {
    const episodeName = episodeNameFor(topicSlug, source.id, source.title);
    // By tag, not exact name: every rendition of this chapter is ours, and a re-render's
    // new name must not make a finished chapter look missing.
    const tag = sourceTag(episodeName);
    const owned = episodes.filter((episode) => sourceTag(episode.name) === tag);

    if (done(owned) || inFlight(owned)) continue;

    // Nothing of ours to go on. A row under the bare title may be this chapter from
    // before tagging, or the same chapter title from another notebook — unknowable, so
    // treat it as done and say so.
    const legacy = (byName.get(source.title) ?? []).filter((e) => isLegacyName(e.name));
    if (done(legacy) || inFlight(legacy)) {
      legacySkips.push({
        source_id: source.id,
        title: source.title,
        episode_ids: legacy.map((e) => e.id),
      });
      continue;
    }

    targets.push({ ...source, episode_name: episodeName });
    // Terminal rows of OURS only: clearing them keeps retries from piling dead duplicates
    // beside the eventual success.
    deletable.push(...owned.filter((e) => !e.audio_available && !isRunning(e.status)));
  }

  return { targets, deletable, legacySkips, skipped: sources.length - targets.length };
}

/**
 * The body of a `dry_run: true` batch — what the same request WITHOUT the flag would do.
 *
 * Why the route grew a flag rather than leaving this to a script: the first live retry
 * (2026-07-29) was checked by a scratchpad file that imported `planRetry` and re-declared
 * `PODCAST_RUNNING`, because that set is module-private in the router. So the thing being
 * consulted before a half-hour-per-target action was a COPY of the decision, not the
 * decision. A flag on the route removes the copy: the preview and the real run reach
 * `planRetry` through the same call, with the same constants and the same live data.
 *
 * Every count is named for the future tense — `would_generate`, not `count`. The real batch
 * answers 202 with `count`/`episodes`; this answers 200 with neither. A client that reads
 * the wrong one gets `undefined` rather than a plausible number, which is the failure mode
 * worth engineering against: a preview mistaken for a run reads as "0 episodes fired, all
 * done" exactly when 20 renders are owed.
 */
export function dryRunReport({ notebookId, targets, deletable = [], legacySkips = [], skipped, retryOnly }) {
  return {
    dry_run: true,
    retry_only: Boolean(retryOnly),
    notebook_id: notebookId,
    would_generate: targets.length,
    would_delete: deletable.length,
    skipped,
    targets: targets.map((t) => ({ source_id: t.id, title: t.title, episode_name: t.episode_name })),
    // Named `would_delete_episodes` and carrying the name and status of each row, because
    // this is the destructive half — the one a reader needs to be able to disagree with
    // before it happens.
    would_delete_episodes: deletable.map((e) => ({ episode_id: e.id, name: e.name, status: e.status })),
    legacy_skips: legacySkips,
    // The worker pre-flight is a canary RENDER, so a dry run cannot have one. Said out
    // loud rather than omitted: a missing `preflight` key reads as a probe that passed.
    preflight: { status: 'not_run', detail: 'a dry run fires nothing, so the worker was never probed' },
  };
}
