import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeNameFor } from '../lib/podcastbatch.mjs';
import { episodeNotebookIndex } from '../lib/podcastcatalog.mjs';

test('a tagged chapter belongs to its notebook even when another notebook has the same title', () => {
  const topics = [
    { slug: 'one', notebookId: 'notebook:one', sources: [{ id: 'source:a', title: 'Introduction' }] },
    { slug: 'two', notebookId: 'notebook:two', sources: [{ id: 'source:b', title: 'Introduction' }] },
  ];
  const index = episodeNotebookIndex(topics);

  assert.equal(index.get(episodeNameFor('one', 'source:a', 'Introduction')), 'notebook:one');
  assert.equal(index.get(episodeNameFor('two', 'source:b', 'Introduction')), 'notebook:two');
  assert.equal(index.get('Introduction'), null, 'an untagged title must not be assigned across notebooks');
});

test('a unique legacy chapter and a recorded standalone episode can be filtered by notebook', () => {
  const index = episodeNotebookIndex([
    {
      slug: 'fastai', notebookId: 'notebook:fastai',
      sources: [{ id: 'source:one', title: 'fastbook 01' }],
      operations: [{ kind: 'podcast_standalone', local_result: { episode_name: 'Fastai overview' } }],
    },
  ]);

  assert.equal(index.get('fastbook 01'), 'notebook:fastai');
  assert.equal(index.get('Fastai overview'), 'notebook:fastai');
  assert.equal(index.get('Unrelated episode'), undefined);
});
