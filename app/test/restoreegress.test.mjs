// WHAT: What podcast profile restore SENDS: no write at all unless the whole plan is valid.
// WHY:  Restore rewrites global Open Notebook config. On main it wrote speakers before it
//       checked episodes, and sent null for an episode model it could not resolve, which
//       clears that profile's LLM. This recorder pins what restore sends through the client
//       it is given, never the shape of anything ON returns. Every "nothing was written"
//       assertion has a control that runs the same fixture made valid and requires writes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Importing restore.mjs must start nothing. Point config at a recorder before the import,
// so an unguarded entry point reaches this stub and never the real ON.
const reached = [];
const onStub = createServer((req, res) => {
  reached.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end('{"detail":"restore recorder: nothing should call ON over HTTP"}');
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'restore-egress-password-never-real';
after(() => onStub.close());

// The stub alone cannot prove the guard: an unguarded main() reaches it only after the
// tests ran. What main() prints before its first await is synchronous, so capture that too.
const printed = [];
const { log: realLog, error: realError } = console;
console.log = console.error = (...args) => printed.push(args.join(' '));
let runRestore;
try {
  ({ runRestore } = await import('../podcast/restore.mjs'));
} finally {
  console.log = realLog;
  console.error = realError;
}

const MODELS = [
  { id: 'model:voice', type: 'text_to_speech', provider: 'openai_compatible', name: 'kokoro' },
  { id: 'model:llm', type: 'language', provider: 'ollama', name: 'qwen' },
];

/** A client that records every call. ON already holds both profiles, so writes are updates. */
function recorder() {
  const calls = [];
  const write = (fn) => async (...args) => { calls.push([fn, ...args]); return { id: 'x' }; };
  return {
    calls,
    writes: () => calls.filter(([fn]) => /^(create|update)/.test(fn)),
    client: {
      listModels: async () => { calls.push(['listModels']); return MODELS; },
      listSpeakerProfiles: async () => { calls.push(['listSpeakerProfiles']); return [{ id: 'speaker_profile:ada', name: 'Ada' }]; },
      listEpisodeProfiles: async () => { calls.push(['listEpisodeProfiles']); return [{ id: 'episode_profile:ch', name: 'chapter' }, { id: 'episode_profile:st', name: 'stock' }]; },
      createSpeakerProfile: write('createSpeakerProfile'),
      updateSpeakerProfile: write('updateSpeakerProfile'),
      createEpisodeProfile: write('createEpisodeProfile'),
      updateEpisodeProfile: write('updateEpisodeProfile'),
    },
  };
}

const want = (episodes) => ({
  models: MODELS.map(({ type, provider, name }) => ({ type, provider, name })),
  speakers: [
    { name: 'Ada', description: '', speakers: [{ name: 'Ada', voice_id: 'af_nova' }], voice_model: 'kokoro' },
    { name: 'Bea', description: '', speakers: [{ name: 'Bea', voice_id: 'af_bella' }], voice_model: 'kokoro' },
  ],
  episodes,
});
const VALID = [
  { name: 'chapter', speaker_config: 'Ada', outline_llm: 'qwen', transcript_llm: 'qwen' },
  { name: 'stock', speaker_config: 'Ada' },
];
const MISSING_SPEAKER = [...VALID, { name: 'broken', speaker_config: 'Nobody' }];
const UNKNOWN_MODEL = [{ ...VALID[0], transcript_llm: 'unregistered' }, VALID[1]];
const quiet = { log: () => {} };

test('importing restore.mjs starts no restore', () => {
  assert.deepEqual(printed, []);
  assert.deepEqual(reached, []);
});

for (const [label, episodes, pattern] of [
  ['an episode naming a missing speaker', MISSING_SPEAKER, /Nobody/],
  ['an episode model that is not registered', UNKNOWN_MODEL, /unregistered/],
]) {
  for (const dryRun of [false, true]) {
    test(`${label}: ${dryRun ? 'dry run' : 'real run'} fails and sends no write`, async () => {
      const r = recorder();
      await assert.rejects(runRestore(want(episodes), r.client, { dryRun, ...quiet }), pattern);
      assert.deepEqual(r.writes(), []);
    });
  }
}

test('control: the same fixture made valid sends every write, with ids resolved', async () => {
  const r = recorder();
  await runRestore(want(VALID), r.client, quiet);
  const writes = r.writes();
  assert.deepEqual(writes.map(([fn, id]) => [fn, typeof id === 'string' ? id : '(body)']), [
    ['updateSpeakerProfile', 'speaker_profile:ada'],
    ['createSpeakerProfile', '(body)'],
    ['updateEpisodeProfile', 'episode_profile:ch'],
    ['updateEpisodeProfile', 'episode_profile:st'],
  ]);
  assert.equal(writes[0][2].voice_model, 'model:voice');
  const [, , chapter] = writes[2];
  assert.equal(chapter.outline_llm, 'model:llm');
  assert.equal(chapter.transcript_llm, 'model:llm');
});

test('control: an episode with no model sends no model key, so ON keeps the one it has', async () => {
  const r = recorder();
  await runRestore(want(VALID), r.client, quiet);
  const stock = r.writes().find(([fn, id]) => fn === 'updateEpisodeProfile' && id === 'episode_profile:st')[2];
  assert.equal(JSON.parse(JSON.stringify(stock)).outline_llm, undefined);
  assert.equal(JSON.parse(JSON.stringify(stock)).transcript_llm, undefined);
});

test('control: a valid dry run plans the same profiles and sends no write', async () => {
  const r = recorder();
  const lines = [];
  await runRestore(want(VALID), r.client, { dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(r.writes(), []);
  for (const name of ['Ada', 'Bea', 'chapter', 'stock']) {
    assert.ok(lines.some((l) => l.includes(name)), `dry run did not report ${name}`);
  }
});
