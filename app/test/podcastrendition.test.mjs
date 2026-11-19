// WHAT: The rendition: one episode name per render request, and the only evidence that
//       settles a request whose outcome was lost.
// WHY:  Open Notebook answers a generate with no episode id, so a lost response leaves
//       the name we chose as the only way back to the row. When every render of a chapter
//       shared one name, an older recording answered for a newer request. A rendition adds
//       the request to the name, and settling demands exactly one exact match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayEpisodeName, episodeNameFor, hasRendition, matchRendition, sourceTag } from '../lib/podcastbatch.mjs';
import { episodeNotebookIndex, notebookForEpisode } from '../lib/podcastcatalog.mjs';

const TOPIC = 'practical-deep-learning-fastai';
const RENDITION = /-r-[0-9a-f]{16}$/;

test('each request gets its own rendition of the chapter name, derived again on retry', () => {
  const chapter = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1');
  const first = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-one');

  assert.match(first, RENDITION);
  assert.ok(first.startsWith(`${chapter}-r-`), 'a rendition still carries the chapter tag');
  assert.equal(first, episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-one'));
  assert.notEqual(first, episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-two'));
  assert.equal(episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', null), chapter,
    'with no request, names stay exactly what they were before renditions');
});

test('a rendition keeps its chapter tag and says that it is a rendition', () => {
  const chapter = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1');
  const rendition = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-one');

  assert.equal(sourceTag(rendition), sourceTag(chapter));
  assert.match(sourceTag(chapter), /^[0-9a-f]{8}$/);
  assert.equal(sourceTag('fastbook 03 — Data Ethics'), null);
  assert.equal(hasRendition(rendition), true);
  assert.equal(hasRendition(chapter), false);
  assert.equal(displayEpisodeName(rendition), 'Chapter 1');
});

test('only a single exact rendition match settles a request', () => {
  const mine = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-new');
  const older = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1', 'mutation-old');
  const row = (id, name) => ({ id, name });

  assert.deepEqual(matchRendition([row('episode:1', older), row('episode:2', mine)], mine), row('episode:2', mine));
  assert.equal(matchRendition([row('episode:1', older)], mine), null, 'an older rendition is not this request');
  assert.equal(matchRendition([row('episode:1', mine), row('episode:2', mine)], mine), null, 'two matches are not evidence');
});

test('a name without a rendition never settles anything, even on an exact match', () => {
  const chapter = episodeNameFor(TOPIC, 'source:aaa', 'Chapter 1');
  assert.equal(matchRendition([{ id: 'episode:1', name: chapter }], chapter), null);
  assert.equal(matchRendition([{ id: 'episode:1', name: 'Fixture standalone episode' }], 'Fixture standalone episode'), null);
});

test("a chapter's rendition is attributed to that chapter's notebook", () => {
  const index = episodeNotebookIndex([
    { slug: 'one', notebookId: 'notebook:one', sources: [{ id: 'source:a', title: 'Introduction' }] },
    { slug: 'two', notebookId: 'notebook:two', sources: [{ id: 'source:b', title: 'Introduction' }] },
  ]);

  assert.equal(notebookForEpisode(index, episodeNameFor('one', 'source:a', 'Introduction', 'm1')), 'notebook:one');
  assert.equal(notebookForEpisode(index, episodeNameFor('two', 'source:b', 'Introduction', 'm1')), 'notebook:two');
  assert.equal(notebookForEpisode(index, episodeNameFor('one', 'source:a', 'Introduction')), 'notebook:one');
  assert.equal(notebookForEpisode(index, 'Introduction'), null, 'an untagged shared title stays unattributed');
  assert.equal(notebookForEpisode(index, 'Unrelated episode'), null);
});
