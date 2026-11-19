import test from 'node:test';
import assert from 'node:assert/strict';
import { initialStoryboardNotebook } from '../web/js/views/higgsfield.mjs';

test('a prepared storyboard is selected when the current topic has no storyboard', () => {
  const notebooks = [{ slug: 'empty' }, { slug: 'fastai' }];
  const jobs = [{ topic_slug: 'fastai', status: 'prepared' }];
  assert.equal(initialStoryboardNotebook(notebooks, jobs, '', 'empty'), 'fastai');
  assert.equal(initialStoryboardNotebook(notebooks, jobs, 'empty', 'empty'), 'empty');
});
