// WHAT: The read-only provider answers StudyDeck's podcast preflight needs, for a recorder stub.
// WHY:  The preflight runs before every render. A stub must serve something profile-shaped
//       to get a route as far as the code under test. These are INPUTS that let a request
//       through, never an assertion about Open Notebook's contract (.claude/rules/testing.md).
//       `incomplete` unsets the outline model, which is the state migration 22 left on the
//       stock profiles. `languageModelName` is the name ON registers; Ollama always lists
//       a pulled model with its tag, so registering it untagged means `:latest`.
export function podcastProviderFixture(req, res, { incomplete = false, languageModelName = 'fixture-language:latest' } = {}) {
  const path = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
  const data = {
    '/api/episode-profiles': [{ name: 'study-chapter', outline_llm: incomplete ? null : 'model:language', transcript_llm: 'model:language', speaker_config: 'tech_experts' }],
    '/api/speaker-profiles': ['tech_experts', 'fixture-voices'].map((name) => ({ name, voice_model: 'model:tts', speakers: [{ name: 'Reader', voice_id: 'af_nova' }] })),
    '/api/models': [
      { id: 'model:language', type: 'language', provider: 'ollama', name: languageModelName },
      { id: 'model:tts', type: 'text_to_speech', provider: 'openai_compatible', name: 'speaches-ai/Kokoro-82M-v1.0-ONNX' },
    ],
    '/api/tags': { models: [{ name: 'fixture-language:latest' }] },
    '/v1/audio/voices': { voices: [{ id: 'af_nova' }] },
  };
  if (req.method !== 'GET' || !(path in data)) return false;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data[path]));
  return true;
}
