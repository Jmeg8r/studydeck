// WHAT: What prepareRendition reports when Ollama is down, or answers with an HTTP error,
//       through the REAL fetchJson.
// WHY:  Being down is our behaviour (CLAUDE.md): a route that needs a service answers 503
//       naming it. fetchJson turns a refused connection into a 502 with fetch's own words,
//       so the boundary that must name Ollama is modelRuntime's handling of what fetchJson
//       throws. A fake fetchJson would only test what a hand-made error looks like, so this
//       file points the real one at a stub, then at the same port closed. Open Notebook and
//       the audio tools are still fakes: they are not the boundary under test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcastrenderollama-'));
const stub = createServer((req, res) => {
  // A real HTTP answer that is not a success: the model is not known to this Ollama.
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'model not found' }));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${stub.address().port}`;
// Before config.mjs loads: it resolves both once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
process.env.STUDYDECK_OLLAMA_BASE_URL = BASE;

const { config } = await import('../lib/config.mjs');
const { prepareRendition } = await import('../lib/podcastrender.mjs');
const TOPIC = config.topics[0].slug;
after(() => { stub.close(); rmSync(FIXTURE_ROOT, { recursive: true, force: true }); });

const MODEL = 'gemma4:31b-mlx';
const deps = {
  notebookForTopic: () => 'notebook:fixture',
  listSources: async () => [{ id: 'source:one' }],
  readSource: async (id) => ({ id, title: 'Chapter One', text: 'Agents plan, act and observe. '.repeat(60) }),
  podcastPreflight: async () => ({
    version: 1, fingerprint: 'c'.repeat(64), speaker_profile: { speakers: [] },
    models: { transcript: { name: MODEL, provider: 'ollama', type: 'language' } },
  }),
  audioTools: async () => {},
};
let counter = 0;
const input = () => ({
  topic_slug: TOPIC, mutation_id: `ollama-${counter += 1}`, source_id: 'source:one',
  episode_profile: 'study-chapter', speaker_profile: 'study-pair',
});

// Runs first, while the stub is listening: an answer is not an outage.
test('an HTTP error from Ollama keeps its own status and is not called an outage', async () => {
  await assert.rejects(prepareRendition(input(), deps), (error) => {
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /unreachable/);
    return true;
  });
});

test('Ollama refusing connections is a 503 that names Ollama and where it was looked for', async () => {
  await new Promise((resolve) => stub.close(resolve));
  await assert.rejects(prepareRendition(input(), deps), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, new RegExp(`^Ollama unreachable at ${BASE.replace(/\./g, '\\.')} \\(`));
    return true;
  });
});
