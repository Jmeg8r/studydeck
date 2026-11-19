// WHAT: The pure halves of podcast profile restore: model identity and the write plan.
// WHY:  restore.mjs writes global Open Notebook config. A model matched by name alone, or a
//       reference checked only after the first write, leaves profiles half-rewritten or
//       with their LLM cleared. These inputs are plain arrays handed to pure functions;
//       nothing here calls ON or pins the shape of anything ON returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelIndex } from '../podcast/on.mjs';

// Imported per test so a missing module fails these tests, not the modelIndex ones above.
const loadPlan = async () => (await import('../podcast/restoreplan.mjs')).planRestore;

const SHARED = [
  { id: 'model:one', type: 'language', name: 'shared', provider: 'ollama' },
  { id: 'model:two', type: 'language', name: 'shared', provider: 'openai_compatible' },
];

test('modelIndex matches a model by provider as well as type and name', () => {
  const index = modelIndex(SHARED);
  assert.equal(index.refToId('language', 'shared', 'ollama'), 'model:one');
  assert.equal(
    index.refToId('language', { type: 'language', provider: 'openai_compatible', name: 'shared' }),
    'model:two',
  );
});

test('modelIndex refuses a name two providers share instead of picking the last one', () => {
  assert.throws(() => modelIndex(SHARED).refToId('language', 'shared'), /ambiguous/i);
});

test('modelIndex refuses a portable ref whose type disagrees with the slot it fills', () => {
  const ref = { type: 'text_to_speech', provider: 'ollama', name: 'shared' };
  assert.throws(() => modelIndex(SHARED).refToId('language', ref), /type/i);
});

test('modelIndex still resolves a unique legacy plain name, and idToRef names the provider', () => {
  const index = modelIndex([SHARED[0]]);
  assert.equal(index.refToId('language', 'shared'), 'model:one');
  assert.equal(index.refToId('language', 'absent'), null);
  assert.deepEqual(index.idToRef('model:one'), { provider: 'ollama', type: 'language', name: 'shared' });
});

const VOICE = { id: 'model:voice', type: 'text_to_speech', name: 'voice', provider: 'local' };
const LLM = { id: 'model:llm', type: 'language', name: 'llm', provider: 'ollama' };
const portable = ({ type, name, provider }) => ({ type, name, provider });
const want = (episodes, extra = {}) => ({
  models: [portable(VOICE), portable(LLM)],
  speakers: [{ name: 'Ada', speakers: [{ name: 'Ada', voice_id: 'af_nova' }], voice_model: 'voice' }],
  episodes,
  ...extra,
});

test('planRestore refuses an episode whose speaker is neither planned nor existing', async () => {
  const planRestore = await loadPlan();
  assert.throws(
    () => planRestore(want([{ name: 'chapter', speaker_config: 'missing' }]), [VOICE, LLM]),
    /missing speaker/i,
  );
});

test('planRestore accepts a speaker that already exists in ON but is not in the JSON', async () => {
  const planRestore = await loadPlan();
  const plan = planRestore(want([{ name: 'chapter', speaker_config: 'Bob' }]), [VOICE, LLM], [{ id: 's:bob', name: 'Bob' }]);
  assert.equal(plan.episodes[0].speaker_config, 'Bob');
});

test('planRestore refuses a models.json entry that is not registered', async () => {
  const planRestore = await loadPlan();
  assert.throws(() => planRestore(want([]), [VOICE]), /not registered|missing registered model/i);
});

test('planRestore refuses an episode model that is neither in models.json nor registered', async () => {
  const planRestore = await loadPlan();
  const episode = { name: 'chapter', speaker_config: 'Ada', outline_llm: 'llm', transcript_llm: 'gone' };
  assert.throws(() => planRestore(want([episode]), [VOICE, LLM]), /gone/);
});

test('planRestore refuses duplicate profile names', async () => {
  const planRestore = await loadPlan();
  const ep = { name: 'chapter', speaker_config: 'Ada' };
  assert.throws(() => planRestore(want([ep, ep]), [VOICE, LLM]), /duplicate/i);
});

test('planRestore refuses a legacy name that models.json lists under two providers', async () => {
  const planRestore = await loadPlan();
  const plan = want([{ name: 'chapter', speaker_config: 'Ada', outline_llm: 'shared' }], {
    models: [portable(VOICE), portable(SHARED[0]), portable(SHARED[1])],
  });
  assert.throws(() => planRestore(plan, [VOICE, ...SHARED]), /ambiguous/i);
});

test('planRestore refuses a speaker profile with an empty voice', async () => {
  const planRestore = await loadPlan();
  const plan = want([], { speakers: [{ name: 'Ada', speakers: [{ name: 'Ada', voice_id: '' }] }] });
  assert.throws(() => planRestore(plan, [VOICE, LLM]), /Ada/);
});

test('a valid plan resolves every model ref to an id and leaves an unset model unset', async () => {
  const planRestore = await loadPlan();
  const plan = planRestore(
    want([
      { name: 'chapter', speaker_config: 'Ada', outline_llm: 'llm', transcript_llm: portable(LLM) },
      { name: 'stock', speaker_config: 'Ada' },
    ]),
    [VOICE, LLM],
  );
  assert.equal(plan.speakers[0].voice_model, 'model:voice');
  assert.equal(plan.episodes[0].outline_llm, 'model:llm');
  assert.equal(plan.episodes[0].transcript_llm, 'model:llm');
  // Absent means "do not touch": null would clear a model ON already has.
  assert.equal(plan.episodes[1].outline_llm, undefined);
  assert.equal(plan.episodes[1].transcript_llm, undefined);
});
