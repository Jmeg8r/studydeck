// WHAT: podcastPreflight's render snapshot and fingerprint.
// WHY:  The chapter renderer (D5d) records what a rendition was made with and refuses to
//       resume when it changes. The fingerprint covers only the fields that shape a render,
//       an allowlist James chose on 2026-11-11, so a profile rename, a description edit or a
//       bookkeeping field Open Notebook adds later never blocks a resume.
//       The stub serves profile-shaped INPUTS, with the field names read live on 2026-11-11.
//       It asserts what this app computes from them, never Open Notebook's contract
//       (.claude/rules/testing.md): if Open Notebook's shape moves, these keep passing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const episode = () => ({
  id: 'episode_profile:1', name: 'study-chapter', description: 'for humans',
  speaker_config: 'speaker_profile:1', speaker_config_name: 'tech_experts',
  outline_llm: 'model:language', transcript_llm: 'model:language', language: null,
  default_briefing: 'Explain the chapter.', num_segments: 4, max_tokens: null,
});
const speaker = () => ({
  id: 'speaker_profile:1', name: 'tech_experts', description: 'for humans', voice_model: 'model:tts',
  speakers: [{ name: 'Reader', voice_id: 'af_nova', personality: 'calm', backstory: 'a teacher' }],
});
const models = () => [
  { id: 'model:language', type: 'language', provider: 'ollama', name: 'fixture-language:latest' },
  { id: 'model:tts', type: 'text_to_speech', provider: 'openai_compatible', name: 'speaches-ai/Kokoro-82M-v1.0-ONNX' },
];
let served;
const reset = () => { served = { episodes: [episode()], speakers: [speaker()], models: models() }; };
reset();

const stub = createServer((req, res) => {
  const path = new URL(req.url, 'http://stub').pathname;
  const data = {
    '/api/episode-profiles': served.episodes,
    '/api/speaker-profiles': served.speakers,
    '/api/models': served.models,
    '/api/tags': { models: [{ name: 'fixture-language:latest' }] },
    '/v1/audio/voices': { voices: [{ id: 'af_nova' }, { id: 'am_adam' }] },
  }[path];
  if (req.method !== 'GET' || data === undefined) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'preflight-fingerprint-not-real';
process.env.STUDYDECK_TTS_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;
process.env.STUDYDECK_OLLAMA_BASE_URL = process.env.STUDYDECK_ON_BASE_URL;
const { podcastPreflight } = await import('../lib/opennotebook.mjs');
after(async () => { stub.closeAllConnections(); await new Promise((resolve) => stub.close(resolve)); });

const check = (episodeProfile = 'study-chapter', speakerProfile = 'tech_experts') =>
  podcastPreflight({ episodeProfile, speakerProfile });

test('the result carries the picked render fields, a fingerprint and when it was checked', async () => {
  reset();
  const result = await check();
  assert.equal(result.version, 1);
  assert.deepEqual(result.episode_profile, {
    language: null, default_briefing: 'Explain the chapter.', num_segments: 4, max_tokens: null,
  }, 'model references are ids; the models themselves are pinned by name below');
  assert.deepEqual(result.speaker_profile, {
    speakers: [{ name: 'Reader', voice_id: 'af_nova', personality: 'calm', backstory: 'a teacher' }],
  });
  assert.deepEqual(result.models.voice, { name: 'speaches-ai/Kokoro-82M-v1.0-ONNX', provider: 'openai_compatible', type: 'text_to_speech' });
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(result.checked_at)));
});

test('the fingerprint changes when a field that shapes the render changes', async () => {
  reset();
  const base = (await check()).fingerprint;
  served.episodes[0].num_segments = 6;
  assert.notEqual((await check()).fingerprint, base, 'num_segments');
  reset();
  served.speakers[0].speakers[0].voice_id = 'am_adam';
  assert.notEqual((await check()).fingerprint, base, 'a speaker voice');
  reset();
  served.models[0].name = 'fixture-language:latest';
  served.models[0].provider = 'openai_compatible';
  assert.notEqual((await check()).fingerprint, base, 'a model provider');
});

test('the fingerprint holds through renames, descriptions, ids, key order and new bookkeeping fields', async () => {
  reset();
  const base = (await check()).fingerprint;

  served.episodes[0] = { ...episode(), name: 'renamed-chapter', description: 'edited', id: 'episode_profile:9', created: '2026-11-11T00:00:00Z' };
  served.speakers[0] = { ...speaker(), name: 'renamed-voices', description: 'edited', id: 'speaker_profile:9', updated: '2026-11-11T00:00:00Z' };
  served.models = models().map((m) => ({ ...m, id: `${m.id}-reregistered` }));
  served.episodes[0].outline_llm = 'model:language-reregistered';
  served.episodes[0].transcript_llm = 'model:language-reregistered';
  served.speakers[0].voice_model = 'model:tts-reregistered';
  const renamed = await check('renamed-chapter', 'renamed-voices');
  assert.equal(renamed.fingerprint, base, 'the same models under new ids, and renamed profiles, are the same render');

  reset();
  served.episodes[0] = Object.fromEntries(Object.entries({ ...episode(), created: 'x' }).reverse());
  served.speakers[0] = { ...speaker(), name: 'renamed-voices', description: 'edited', updated: 'y' };
  served.models = models().map((m) => ({ ...m, created: 'z' }));
  assert.equal((await check('study-chapter', 'renamed-voices')).fingerprint, base);
});

test('the refusals keep their messages and statuses', async () => {
  reset();
  await assert.rejects(check('no-such-profile'), (err) => {
    assert.equal(err.status, 422);
    assert.match(err.message, /^Generation unavailable: episode profile no-such-profile is missing/);
    return true;
  });
  served.speakers[0].speakers[0].voice_id = 'not_a_voice';
  await assert.rejects(check(), (err) => err.status === 422 && /voices not available \(Reader: not_a_voice\)/.test(err.message));
});
