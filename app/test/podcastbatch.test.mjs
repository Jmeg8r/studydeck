// WHAT: Episode identity and the retry decision that rests on it.
// WHY:  Assessment finding F10. The batch matched episodes to sources by bare title,
//       globally, so two notebooks holding a chapter with the same name — "Introduction",
//       "Chapter 1" — could make a missing episode be skipped as done, or a terminally
//       failed row from the OTHER notebook be deleted.
//
// Pure-function tests, and that is the point: firing a real batch renders real episodes
// into a real notebook for roughly half an hour each. This decision is the part that must
// be right before anything is fired, so it is the part that lives outside the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayEpisodeName, dryRunReport, episodeNameFor, isLegacyName, planRetry } from '../lib/podcastbatch.mjs';
import { isActiveJobStatus as isRunning } from '../lib/podcastjob.mjs';

const TOPIC = 'practical-deep-learning-fastai';
const OTHER_TOPIC = 'ai-agent-design-patterns';

const source = (id, title) => ({ id, title });
const episode = (name, { audio = false, status = 'completed', id = `episode:${name}` } = {}) =>
  ({ id, name, audio_available: audio, status });

test('the same chapter title in two notebooks gets two different episode names', () => {
  const here = episodeNameFor(TOPIC, 'source:aaa', 'Introduction');
  const there = episodeNameFor(OTHER_TOPIC, 'source:bbb', 'Introduction');

  assert.notEqual(here, there);
  // Both still READ as the chapter, because a person sees this name in Open Notebook.
  assert.ok(here.startsWith('Introduction · sd-'));
  assert.ok(there.startsWith('Introduction · sd-'));
});

test('the same topic and source always produce the same name', () => {
  // Derived, not stored: this is what lets a retry find its own earlier attempt without
  // a manifest file that has to have been written, kept, and trusted.
  assert.equal(
    episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1'),
    episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1'),
  );
  // Different source, same title and topic — a book with two chapters called the same
  // thing is not a contradiction, and must not collapse into one episode.
  assert.notEqual(
    episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1'),
    episodeNameFor(TOPIC, 'source:bbb', 'Chapter 1'),
  );
});

test('display strips our tag and leaves every other name alone', () => {
  assert.equal(displayEpisodeName(episodeNameFor(TOPIC, 'source:aaa', 'Data Ethics')), 'Data Ethics');
  // Pre-F10 rows, and anything a person named by hand in Open Notebook.
  assert.equal(displayEpisodeName('fastbook 03 — Data Ethics'), 'fastbook 03 — Data Ethics');
  assert.equal(displayEpisodeName('model-test — qwen7b-32k-real'), 'model-test — qwen7b-32k-real');
  assert.equal(displayEpisodeName(null), '');
  // A name that merely looks tag-ish is not one: the digest is 8 hex characters.
  assert.equal(displayEpisodeName('Something · sd-nothex12'), 'Something · sd-nothex12');
  assert.equal(isLegacyName('Something · sd-nothex12'), true);
});

test('a chapter with rendered audio of its own is skipped', () => {
  const s = source('source:aaa', 'Chapter 1');
  const plan = planRetry({
    sources: [s],
    episodes: [episode(episodeNameFor(TOPIC, s.id, s.title), { audio: true })],
    topicSlug: TOPIC,
    isRunning,
  });

  assert.deepEqual(plan.targets, []);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.deletable, []);
});

test('a chapter still rendering is left alone, not re-fired', () => {
  const s = source('source:aaa', 'Chapter 1');
  const plan = planRetry({
    sources: [s],
    episodes: [episode(episodeNameFor(TOPIC, s.id, s.title), { status: 'running' })],
    topicSlug: TOPIC,
    isRunning,
  });

  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.deletable, []);
});

test("another notebook's identical chapter title neither skips nor gets deleted", () => {
  // The finding itself. A tagged row belonging to a DIFFERENT topic must be invisible
  // here: this chapter has never been generated, and that row is not ours to touch.
  const s = source('source:aaa', 'Introduction');
  const foreign = episode(episodeNameFor(OTHER_TOPIC, 'source:zzz', 'Introduction'), { audio: true });

  const plan = planRetry({ sources: [s], episodes: [foreign], topicSlug: TOPIC, isRunning });

  assert.equal(plan.targets.length, 1, 'a chapter with no episode of its own must be generated');
  assert.equal(plan.targets[0].episode_name, episodeNameFor(TOPIC, s.id, s.title));
  assert.deepEqual(plan.deletable, [], "another topic's row is never deleted");
  assert.deepEqual(plan.legacySkips, []);
});

test('a terminally failed row of ours is cleared before the retry', () => {
  const s = source('source:aaa', 'Chapter 1');
  const failed = episode(episodeNameFor(TOPIC, s.id, s.title), { status: 'failed' });
  const plan = planRetry({ sources: [s], episodes: [failed], topicSlug: TOPIC, isRunning });

  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.deletable, [failed]);
});

test('a pre-tag episode counts as done, and says so instead of silently skipping', () => {
  // The migration case, and it is not hypothetical: 21 fastbook episodes already exist
  // under bare titles. Treating them as missing would regenerate all 21 at roughly half
  // an hour each. The match is ambiguous by nature, so it is reported.
  const s = source('source:aaa', 'fastbook 03 — Data Ethics');
  const legacy = episode('fastbook 03 — Data Ethics', { audio: true, id: 'episode:legacy' });

  const plan = planRetry({ sources: [s], episodes: [legacy], topicSlug: TOPIC, isRunning });

  assert.deepEqual(plan.targets, []);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.legacySkips, [
    { source_id: 'source:aaa', title: 'fastbook 03 — Data Ethics', episode_ids: ['episode:legacy'] },
  ]);
});

test('a pre-tag row is never deleted, even when it is terminally failed and in the way', () => {
  // Asymmetry on purpose: skipping wrongly costs a re-run, deleting wrongly is the
  // cross-notebook data loss. An unattributable row is regenerated ALONGSIDE, not over.
  const s = source('source:aaa', 'Chapter 1');
  const legacyFailed = episode('Chapter 1', { status: 'failed', id: 'episode:legacy' });

  const plan = planRetry({ sources: [s], episodes: [legacyFailed], topicSlug: TOPIC, isRunning });

  assert.equal(plan.targets.length, 1, 'a failed legacy row does not count as done');
  assert.deepEqual(plan.deletable, [], 'and it is still not ours to delete');
  assert.deepEqual(plan.legacySkips, []);
});

test('our own row wins over a legacy row with the same title', () => {
  // Once a chapter has been regenerated under its tag, the old bare-title row stops
  // having a vote — otherwise a stale legacy failure would keep re-firing a good episode.
  const s = source('source:aaa', 'Chapter 1');
  const plan = planRetry({
    sources: [s],
    episodes: [
      episode('Chapter 1', { status: 'failed', id: 'episode:legacy' }),
      episode(episodeNameFor(TOPIC, s.id, s.title), { audio: true }),
    ],
    topicSlug: TOPIC,
    isRunning,
  });

  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.deletable, [], 'the legacy row is not swept up as collateral');
});

test('a whole book plans in one pass, mixing done, running, failed and never-generated', () => {
  const sources = [
    source('source:1', 'Chapter 1'),
    source('source:2', 'Chapter 2'),
    source('source:3', 'Chapter 3'),
    source('source:4', 'Chapter 4'),
  ];
  const failed = episode(episodeNameFor(TOPIC, 'source:3', 'Chapter 3'), { status: 'failed' });
  const plan = planRetry({
    sources,
    episodes: [
      episode(episodeNameFor(TOPIC, 'source:1', 'Chapter 1'), { audio: true }),
      episode(episodeNameFor(TOPIC, 'source:2', 'Chapter 2'), { status: 'running' }),
      failed,
    ],
    topicSlug: TOPIC,
    isRunning,
  });

  assert.deepEqual(plan.targets.map((t) => t.id), ['source:3', 'source:4']);
  assert.equal(plan.skipped, 2);
  assert.deepEqual(plan.deletable, [failed]);
});

// --- dry_run: the preview of a batch, and what makes it safe to trust ---------------
//
// The route's `dry_run: true` returns this body and nothing below its early return runs.
// These tests cover the half that is decidable without a notebook: that the report says
// what the same request would do, and that it cannot be mistaken for a run that happened.

test('a dry run reports the plan and answers in the future tense, with no run-shaped keys', () => {
  const sources = [source('source:1', 'Chapter 1'), source('source:2', 'Chapter 2')];
  const failed = episode(episodeNameFor(TOPIC, 'source:2', 'Chapter 2'), { status: 'failed' });
  const plan = planRetry({
    sources,
    episodes: [episode(episodeNameFor(TOPIC, 'source:1', 'Chapter 1'), { audio: true }), failed],
    topicSlug: TOPIC,
    isRunning,
  });

  const report = dryRunReport({ notebookId: 'notebook:xyz', retryOnly: true, ...plan });

  assert.equal(report.dry_run, true);
  assert.equal(report.retry_only, true);
  assert.equal(report.would_generate, 1);
  assert.equal(report.would_delete, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.targets, [{
    source_id: 'source:2',
    title: 'Chapter 2',
    episode_name: episodeNameFor(TOPIC, 'source:2', 'Chapter 2'),
  }]);

  // The real batch answers with `count` and `episodes`. A preview must not, so a client
  // reading the wrong field gets undefined rather than a plausible "0 fired, all done"
  // while a render is still owed.
  assert.equal(report.count, undefined);
  assert.equal(report.episodes, undefined);
});

test('a dry run never proposes deleting a row the real run would leave alone', () => {
  // The F10 asymmetry, restated at the reporting layer: a legacy row can be SKIPPED but
  // never deleted, so it must not appear in the destructive half of the preview either.
  const s = source('source:1', 'Chapter 1');
  const legacyFailed = episode('Chapter 1', { status: 'failed', id: 'episode:legacy' });
  const ownTerminal = episode(episodeNameFor(TOPIC, s.id, s.title), { status: 'failed', id: 'episode:ours' });
  const plan = planRetry({
    sources: [s],
    episodes: [legacyFailed, ownTerminal],
    topicSlug: TOPIC,
    isRunning,
  });

  const report = dryRunReport({ notebookId: 'notebook:xyz', retryOnly: true, ...plan });

  assert.deepEqual(report.would_delete_episodes, [
    { episode_id: 'episode:ours', name: ownTerminal.name, status: 'failed' },
  ]);
  assert.equal(report.would_delete, 1);
});

test('a dry run of a FULL batch counts every source and deletes nothing', () => {
  // No planRetry: a full batch's targets are its sources, and it has no delete step at all.
  const sources = [source('source:1', 'Chapter 1'), source('source:2', 'Chapter 2')];
  const targets = sources.map((s) => ({ ...s, episode_name: episodeNameFor(TOPIC, s.id, s.title) }));

  const report = dryRunReport({ notebookId: 'notebook:xyz', targets, skipped: 0, retryOnly: false });

  assert.equal(report.retry_only, false);
  assert.equal(report.would_generate, 2);
  assert.equal(report.would_delete, 0);
  assert.deepEqual(report.would_delete_episodes, []);
  assert.deepEqual(report.legacy_skips, []);
});

test('a dry run says the worker was not probed, rather than omitting the preflight', () => {
  // A pre-flight is a canary RENDER, so a preview cannot have one. An absent key would
  // read as a probe that passed.
  const report = dryRunReport({ notebookId: 'notebook:xyz', targets: [], skipped: 0, retryOnly: true });

  assert.equal(report.preflight.status, 'not_run');
  assert.match(report.preflight.detail, /fires nothing/);
});

// A rendition is the chapter's tagged name plus `-r-` and 16 hex characters, one per
// render request. Written out literally here so these tests do not depend on the helper
// that makes them.
const rendition = (topic, s, digest = 'a'.repeat(16)) => `${episodeNameFor(topic, s.id, s.title)}-r-${digest}`;

test('a finished rendition of a chapter counts as done, so a retry does not re-render it', () => {
  // Every render now carries its own rendition. If the planner still matched the bare
  // tagged name, every chapter rendered that way would look missing and the whole book
  // would render again, at roughly half an hour a chapter.
  const s = source('source:aaa', 'Chapter 1');
  const plan = planRetry({
    sources: [s], episodes: [episode(rendition(TOPIC, s), { audio: true })], topicSlug: TOPIC, isRunning,
  });

  assert.deepEqual(plan.targets, []);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.legacySkips, []);
});

test('a terminally failed rendition of ours is cleared before the retry', () => {
  const s = source('source:aaa', 'Chapter 1');
  const failed = episode(rendition(TOPIC, s), { status: 'failed' });
  const plan = planRetry({ sources: [s], episodes: [failed], topicSlug: TOPIC, isRunning });

  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.deletable, [failed]);
});

test("another notebook's rendition of the same chapter title is neither ours to skip nor to delete", () => {
  const s = source('source:aaa', 'Introduction');
  const theirs = episode(rendition(OTHER_TOPIC, source('source:bbb', 'Introduction')), { status: 'failed' });
  const plan = planRetry({ sources: [s], episodes: [theirs], topicSlug: TOPIC, isRunning });

  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.deletable, []);
});
