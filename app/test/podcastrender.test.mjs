// WHAT: The chapter render pipeline's manifest, refusals and state machine, with every
//       outside service replaced by a fake passed through `deps`.
// WHY:  A render spends minutes of local model and speech time per chapter and must survive
//       a restart without redoing that work or losing the evidence of a rejected section.
//       The fakes stand in for Open Notebook, Ollama, Speaches and ffmpeg so the real state
//       machine runs here with none of them installed; what this app SENDS to them is pinned
//       in podcastrenderegress.test.mjs. Loaded with import() so missing exports fail only
//       this file. Each test builds its own renditions under a fixture learn root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-podcastrender-'));
// Before config.mjs loads: it resolves the learn root once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { config } = await import('../lib/config.mjs');
const { digest } = await import('../lib/podcastquality.mjs');
const load = () => import('../lib/podcastrender.mjs');
const TOPIC = config.topics[0].slug;
const AUDIO = join(FIXTURE_ROOT, TOPIC, 'cockpit', 'audio');

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

let counter = 0;
/** A fresh, valid rendition id. */
const nextId = () => `render-${digest(['fixture', counter += 1]).slice(0, 24)}`;

/** A manifest that passes validation; `changes` override any field. */
function manifest(changes = {}) {
  const text = 'A chapter about agents. '.repeat(40);
  return {
    version: 1, id: nextId(), topic_slug: TOPIC, mutation_id: `m-${counter}`, input_hash: 'h'.repeat(64),
    input: { source_id: 'source:one', episode_profile: 'study-chapter', speaker_profile: 'study-pair' },
    created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:00:00.000Z',
    stage: 'queued', source: { id: 'source:one', title: 'Chapter One', text, sha256: digest(text) },
    configuration: { version: 1, fingerprint: 'f'.repeat(64) }, runtime: {},
    plan: { version: 1, segments: [], word_budget: 600 },
    transcript: [], transcript_attempts: [], clips: [], timings: {}, progress: 'Queued',
    ...changes,
  };
}

/** Write a manifest straight to disk, as a fixture; returns its directory. */
function plant(m, { raw } = {}) {
  const dir = join(AUDIO, m.id);
  mkdirSync(join(dir, 'clips'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), raw ?? `${JSON.stringify(m, null, 2)}\n`);
  return dir;
}

/** sha256 of every file under `dir`, so a refusal can be shown to have written nothing. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex') + statSync(p).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

// --- Step 2: the manifest -----------------------------------------------------------

test('renditionDir accepts only render-<24 hex> ids, under the topic\'s cockpit/audio', async () => {
  const { renditionDir } = await load();
  const id = nextId();
  assert.equal(renditionDir(TOPIC, id), join(AUDIO, id));
  for (const bad of ['render-xyz', `render-${'A'.repeat(24)}`, '../manifest', `render-${'a'.repeat(25)}`, '']) {
    assert.throws(() => renditionDir(TOPIC, bad), (err) => err.status === 400 && /Invalid rendition id/.test(err.message), bad);
  }
});

test('readRendition returns null when the rendition has no manifest', async () => {
  const { readRendition } = await load();
  assert.equal(readRendition(TOPIC, nextId()), null);
});

test('readRendition returns a valid manifest as written', async () => {
  const { readRendition } = await load();
  const m = manifest();
  plant(m);
  assert.deepEqual(readRendition(TOPIC, m.id), m);
});

test('readRendition refuses a damaged manifest with 409 and leaves every file as it was', async () => {
  const { readRendition } = await load();
  const cases = {
    'transcript digest mismatch': (m) => plant({ ...m, transcript: [{ speaker: 'A', dialogue: 'x' }], transcript_sha256: 'e'.repeat(64) }),
    'unknown stage': (m) => plant({ ...m, stage: 'sideways' }),
    'source text altered after hashing': (m) => plant({ ...m, source: { ...m.source, text: 'changed' } }),
    'missing input profile names': (m) => plant({ ...m, input: { source_id: 'source:one' } }),
    'unparseable primary': (m) => plant(m, { raw: '{"version":1,' }),
    'valid backup beside a broken primary': (m) => {
      const dir = plant(m, { raw: 'not json' });
      writeFileSync(join(dir, 'manifest.json.bak'), `${JSON.stringify(m, null, 2)}\n`);
      return dir;
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    const m = manifest();
    const dir = make(m);
    const before = snapshot(dir);
    assert.throws(() => readRendition(TOPIC, m.id), (err) => err.status === 409 && /needs repair/.test(err.message), name);
    assert.deepEqual(snapshot(dir), before, `${name}: nothing on disk may change`);
  }
});

test('listRenditions: an absent audio folder lists nothing', async () => {
  const { listRenditions } = await load();
  assert.deepEqual(listRenditions('topic-with-no-audio'), []);
});

test('listRenditions shows a damaged manifest as a needs_repair row and skips stray names', async () => {
  const { listRenditions } = await load();
  const damaged = manifest();
  plant(damaged, { raw: 'not json' });
  mkdirSync(join(AUDIO, 'not-a-rendition'), { recursive: true });
  const rows = listRenditions(TOPIC);
  const row = rows.find((r) => r.id === damaged.id);
  assert.equal(row.status, 'needs_repair');
  assert.equal(row.audio_available, false);
  assert.match(row.error, /needs repair/);
  assert.equal(rows.some((r) => r.id === 'not-a-rendition'), false);
});

test('listRenditions marks only the newest published rendition of each source preferred', async () => {
  const { listRenditions } = await load();
  const older = manifest({ stage: 'published', updated_at: '2026-11-11T11:00:00.000Z', source: { ...manifest().source, id: 'source:pref' } });
  const newer = manifest({ stage: 'published', updated_at: '2026-11-11T12:00:00.000Z', source: { ...older.source } });
  const draft = manifest({ stage: 'qc_passed', updated_at: '2026-11-11T13:00:00.000Z', source: { ...older.source } });
  const other = manifest({ stage: 'published', updated_at: '2026-11-11T09:00:00.000Z', source: { ...older.source, id: 'source:other' } });
  for (const m of [older, newer, draft, other]) plant(m);
  const byId = Object.fromEntries(listRenditions(TOPIC).map((r) => [r.id, r]));
  assert.equal(byId[newer.id].preferred, true);
  assert.equal(byId[older.id].preferred, false);
  assert.equal(byId[draft.id].preferred, false);
  assert.equal(byId[other.id].preferred, true);
});

// --- Fakes for steps 3–5 ------------------------------------------------------------

const SPEAKERS = [{ name: 'Ada', voice_id: 'af_bella' }, { name: 'Ben', voice_id: 'am_adam' }];
const MODEL = 'gemma4:31b-mlx';
const VOICE_MODEL = 'speaches-ai/Kokoro-82M-v1.0-ONNX';

/** What D5b's renderShape returns, for these fixtures. */
function configuration(changes = {}) {
  return {
    version: 1, episode_profile: { language: 'en', default_briefing: null, num_segments: 3, max_tokens: null },
    speaker_profile: { speakers: SPEAKERS.map((s) => ({ ...s, personality: null, backstory: null })) },
    models: {
      outline: { name: MODEL, provider: 'ollama', type: 'language' },
      transcript: { name: MODEL, provider: 'ollama', type: 'language' },
      voice: { name: VOICE_MODEL, provider: 'openai_compatible', type: 'text_to_speech' },
    },
    fingerprint: 'c'.repeat(64), checked_at: '2026-11-11T10:00:00.000Z', ...changes,
  };
}

const CHAPTER = 'Agents plan, act and observe. '.repeat(60);

/**
 * Every outside service, faked. `calls` records what each was asked. Ollama's /api/chat
 * answers `chat(request)`; by default it returns text that is not JSON, so a render this
 * file does not care about ends quickly at needs_review without speaking.
 */
function fakeDeps(changes = {}) {
  const calls = { preflight: [], chat: [], speech: [], listSources: 0, readSource: 0 };
  const deps = {
    notebookForTopic: () => 'notebook:fixture',
    listSources: async () => { calls.listSources += 1; return [{ id: 'source:one' }, { id: 'source:big' }]; },
    readSource: async (id) => {
      calls.readSource += 1;
      return { id, title: id === 'source:big' ? 'Huge' : 'Chapter One', text: id === 'source:big' ? 'x'.repeat(150_001) : CHAPTER };
    },
    podcastPreflight: async (names) => { calls.preflight.push(names); return configuration(); },
    audioTools: async () => {},
    show: { model_info: { 'gemma3.context_length': 32768 } },
    tags: { models: [{ name: MODEL, digest: 'd'.repeat(64) }] },
    chat: async () => ({ message: { content: 'not json' } }),
    ...changes,
  };
  deps.fetchJson = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/show') return deps.show;
    if (path === '/api/tags') return deps.tags;
    if (path === '/api/chat') { const request = JSON.parse(init.body); calls.chat.push(request); return deps.chat(request); }
    throw new Error(`unexpected fetchJson ${url}`);
  };
  return { deps, calls };
}

const input = (changes = {}) => ({
  topic_slug: TOPIC, mutation_id: `mutation-${counter += 1}`, source_id: 'source:one',
  episode_profile: 'study-chapter', speaker_profile: 'study-pair', ...changes,
});

// --- Step 3: prepare ----------------------------------------------------------------

test('prepare records the source, configuration, runtime, plan and requested profile names', async () => {
  const { prepareRendition, readRendition, idle } = await load();
  const { deps, calls } = fakeDeps();
  const request = input();
  const summary = await prepareRendition(request, deps);
  assert.match(summary.id, /^render-[a-f0-9]{24}$/);
  assert.equal(summary.id, `render-${digest([TOPIC, request.mutation_id]).slice(0, 24)}`);
  const m = readRendition(TOPIC, summary.id);
  assert.deepEqual(m.input, { source_id: 'source:one', episode_profile: 'study-chapter', speaker_profile: 'study-pair' });
  assert.equal(m.source.sha256, digest(CHAPTER));
  assert.equal(m.configuration.fingerprint, 'c'.repeat(64));
  assert.deepEqual({ model: m.runtime.model, digest: m.runtime.digest, capacity: m.runtime.capacity, context_tokens: m.runtime.context_tokens },
    { model: MODEL, digest: 'd'.repeat(64), capacity: 32768, context_tokens: 16384 });
  assert.ok(m.plan.segments.length >= 1);
  assert.deepEqual(calls.preflight, [{ episodeProfile: 'study-chapter', speakerProfile: 'study-pair' }]);
  await idle();
});

test('prepare refuses, writing nothing, when the source or the model is unusable', async () => {
  const { prepareRendition, idle } = await load();
  const cases = [
    ['a source outside the topic\'s notebook', input({ source_id: 'source:elsewhere' }), {}, 400, /does not belong/],
    ['a topic with no notebook', input(), { notebookForTopic: () => null }, 400, /does not belong/],
    ['a source over 150,000 characters', input({ source_id: 'source:big' }), {}, 422, /150,000/],
    ['a transcript model not served by Ollama', input(), { podcastPreflight: async () => configuration({ models: { ...configuration().models, transcript: { name: 'gpt', provider: 'openai', type: 'language' } } }) }, 422, /local Ollama/],
    ['a context window under 4,096 tokens', input(), { show: { model_info: { 'gemma3.context_length': 2048 } } }, 422, /context window/],
    ['no context window reported', input(), { show: { model_info: {} } }, 422, /context window/],
    ['no installed model digest', input(), { tags: { models: [{ name: MODEL }] } }, 422, /digest/],
  ];
  for (const [name, request, changes, status, message] of cases) {
    const { deps } = fakeDeps(changes);
    const id = `render-${digest([TOPIC, request.mutation_id]).slice(0, 24)}`;
    await assert.rejects(prepareRendition(request, deps), (err) => err.status === status && message.test(err.message), name);
    assert.equal(statSync(join(AUDIO, id), { throwIfNoEntry: false }), undefined, `${name}: no rendition folder`);
  }
  await idle();
});

test('a replayed mutation_id returns the same rendition; with different input it is refused', async () => {
  const { prepareRendition, idle } = await load();
  const { deps, calls } = fakeDeps();
  const request = input();
  const first = await prepareRendition(request, deps);
  const again = await prepareRendition({ ...request }, deps);
  assert.equal(again.id, first.id);
  assert.equal(calls.preflight.length, 1, 'a replay re-runs nothing');
  await assert.rejects(prepareRendition({ ...request, speaker_profile: 'other-pair' }, deps),
    (err) => err.status === 409 && /different generation input/.test(err.message));
  await idle();
});

test('two concurrent prepares of one mutation_id share a single preparation', async () => {
  const { prepareRendition, idle } = await load();
  const { deps, calls } = fakeDeps();
  const request = input();
  const [a, b] = await Promise.all([prepareRendition(request, deps), prepareRendition({ ...request }, deps)]);
  assert.equal(a.id, b.id);
  assert.equal(calls.preflight.length, 1);
  await idle();
});

test('prepare refuses a seventh rendition while six are queued or running', async () => {
  const { prepareRendition, idle } = await load();
  await idle();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deps } = fakeDeps({ chat: async () => { await gate; return { message: { content: 'not json' } }; } });
  const accepted = [];
  for (let i = 0; i < 6; i += 1) accepted.push(await prepareRendition(input(), deps));
  const seventh = input();
  await assert.rejects(prepareRendition(seventh, deps), (err) => err.status === 409 && /queue is full/.test(err.message));
  assert.equal(statSync(join(AUDIO, `render-${digest([TOPIC, seventh.mutation_id]).slice(0, 24)}`), { throwIfNoEntry: false }), undefined);
  release();
  await idle();
  assert.equal(accepted.length, 6);
});

// --- Step 4: the render state machine, with fakes -----------------------------------

const { planChapter } = await import('../lib/podcastquality.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Six turns of unique words, anchored to the section's first passage: passes D5a's gates. */
function goodTurns(request) {
  const brief = JSON.parse(request.messages[1].content);
  const anchor = brief.source_passages[0].id;
  return Array.from({ length: 6 }, (_, turn) => ({
    speaker: brief.speakers[turn % brief.speakers.length],
    dialogue: `${Array.from({ length: 45 }, (__, k) => `${brief.section}t${turn}w${k}`).join(' ')}.`,
    source_anchor: anchor,
  }));
}

/** Fakes for a full render: a model that writes good turns, a speech service, ffmpeg. */
function renderDeps(changes = {}) {
  const made = fakeDeps({ chat: async (request) => ({ message: { content: `\`\`\`json\n${JSON.stringify({ turns: goodTurns(request) })}\n\`\`\`` } }) });
  const { calls } = made;
  Object.assign(made.deps, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.speech.push(body);
      return new Response(Buffer.from(`mp3:${body.voice}:${body.input}`), { status: 200 });
    },
    probeAudio: async (file) => {
      const bytes = readFileSync(file);
      return { duration: 2, bytes: bytes.length, sha256: sha(bytes) };
    },
    assembleAudio: async (dir) => {
      writeFileSync(join(dir, 'candidate.mp3'), 'assembled');
      return { version: 1, target_lufs: -16, target_true_peak_db: -1.5, measured: {} };
    },
    checkAudio: async (file) => ({
      version: 1, passed: true, issues: [], repetitions: [],
      asset: { duration: 24, bytes: 9, sha256: sha(readFileSync(file)) },
    }),
    ...changes,
  });
  return made;
}

/** A queued manifest, planted on disk, ready for renderRendition. */
function queued(changes = {}) {
  const runtime = { model: MODEL, digest: 'd'.repeat(64), capacity: 32768, context_tokens: 16384, prompt_version: 'chapter-dialogue-v5' };
  const m = manifest({
    source: { id: 'source:one', title: 'Chapter One', text: CHAPTER, sha256: digest(CHAPTER) },
    configuration: configuration(), runtime, plan: planChapter(CHAPTER, { contextTokens: 16384 }), ...changes,
  });
  plant(m);
  return m;
}

test('a clean render reaches qc_passed with its transcript, ordered clips and both QC results', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps, calls } = renderDeps();
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'qc_passed', saved.error ?? '');
  assert.equal(saved.transcript_sha256, digest(saved.transcript));
  assert.equal(saved.transcript.length, 6 * saved.plan.segments.length);
  assert.deepEqual(saved.clips.map((c) => c.order), saved.transcript.map((_, i) => i));
  assert.equal(calls.speech.length, saved.transcript.length);
  assert.equal(saved.normalization.target_lufs, -16);
  assert.equal(saved.audio_qc.passed, true);
  assert.equal(saved.error, null);
});

test('a section that fails QC three times stops at needs_review, keeping every rejected response', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps, calls } = renderDeps({ chat: async () => ({ message: { content: '{"turns":[{"speaker":"Nobody","dialogue":"hi","source_anchor":"p1"}]}' } }) });
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'needs_review');
  assert.equal(calls.chat.length, 3);
  assert.equal(saved.transcript_attempts.length, 3);
  for (const attempt of saved.transcript_attempts) {
    assert.equal(attempt.qc.passed, false);
    assert.match(attempt.rejected_response, /Nobody/);
  }
  assert.equal(calls.speech.length, 0, 'nothing is voiced from a rejected transcript');
});

test('an unparseable reply is a failed try; nothing is made up in its place', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps } = renderDeps({ chat: async () => ({ message: { content: 'Sure! Here is a podcast about agents.' } }) });
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'needs_review');
  assert.deepEqual(saved.transcript, []);
  assert.equal(saved.transcript_attempts[0].rejected_response, 'Sure! Here is a podcast about agents.');
});

test('the retry budget is durable: after a restart with two failed tries, only one more is made', async () => {
  const { renderRendition } = await load();
  const { deps, calls } = renderDeps({ chat: async () => ({ message: { content: 'not json' } }) });
  const m = queued();
  const section = m.plan.segments[0].id;
  m.transcript_attempts = [1, 2].map(() => ({ section_id: section, at: '2026-11-11T10:00:00.000Z', qc: { passed: false, issues: ['earlier run'] } }));
  plant(m);
  await renderRendition(m, deps);
  assert.equal(calls.chat.length, 1);
});

test('a resume reuses intact clips and re-voices only a damaged one', async () => {
  const { renderRendition, readRendition } = await load();
  const first = renderDeps();
  const m = queued();
  await renderRendition(m, first.deps);
  const done = readRendition(TOPIC, m.id);
  writeFileSync(join(AUDIO, m.id, 'clips', `${done.clips[2].key}.mp3`), 'damaged bytes');
  const second = renderDeps();
  await renderRendition(readRendition(TOPIC, m.id), second.deps);
  assert.equal(second.calls.chat.length, 0, 'an accepted transcript is not rewritten');
  assert.equal(second.calls.speech.length, 1);
  assert.equal(second.calls.speech[0].input, done.transcript[2].dialogue);
  assert.equal(readRendition(TOPIC, m.id).stage, 'qc_passed');
});

test('a speech failure ends the render at failed, with the error recorded', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps } = renderDeps({ fetch: async () => new Response('busy', { status: 503 }) });
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'failed');
  assert.match(saved.error, /Speech service returned 503/);
});

test('two clips with identical audio end the render at failed', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps } = renderDeps({ fetch: async () => new Response(Buffer.from('same audio'), { status: 200 }) });
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'failed');
  assert.match(saved.error, /Duplicate synthesized clips/);
});

test('failed audio QC ends the render at needs_review, with the checks kept', async () => {
  const { renderRendition, readRendition } = await load();
  const { deps } = renderDeps({
    checkAudio: async () => ({ version: 1, passed: false, issues: ['Clipping detected'], repetitions: [], asset: { duration: 24, bytes: 9, sha256: 'a'.repeat(64) } }),
  });
  const m = queued();
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'needs_review');
  assert.deepEqual(saved.audio_qc.issues, ['Clipping detected']);
});

// --- Step 5: resume and publish -----------------------------------------------------

test('resume refuses a missing rendition (404) and one that failed QC (409)', async () => {
  const { resumeRendition } = await load();
  const { deps } = renderDeps();
  await assert.rejects(resumeRendition(TOPIC, nextId(), deps), (err) => err.status === 404);
  const m = queued({ stage: 'needs_review' });
  const before = snapshot(join(AUDIO, m.id));
  await assert.rejects(resumeRendition(TOPIC, m.id, deps), (err) => err.status === 409 && /failed QC/.test(err.message));
  assert.deepEqual(snapshot(join(AUDIO, m.id)), before);
});

test('resume refuses when the model digest, prompt version or render fingerprint changed', async () => {
  const { resumeRendition } = await load();
  const cases = {
    'model digest': [{}, { tags: { models: [{ name: MODEL, digest: 'e'.repeat(64) }] } }],
    'prompt version': [{ runtime: { model: MODEL, digest: 'd'.repeat(64), capacity: 32768, context_tokens: 16384, prompt_version: 'chapter-dialogue-v4' } }, {}],
    'render fingerprint': [{}, { podcastPreflight: async () => configuration({ fingerprint: 'b'.repeat(64) }) }],
  };
  for (const [name, [manifestChanges, depChanges]] of Object.entries(cases)) {
    const { deps, calls } = renderDeps(depChanges);
    const m = queued({ stage: 'failed', error: 'earlier', ...manifestChanges });
    const before = snapshot(join(AUDIO, m.id));
    await assert.rejects(resumeRendition(TOPIC, m.id, deps), (err) => err.status === 409 && /settings changed/.test(err.message), name);
    assert.deepEqual(snapshot(join(AUDIO, m.id)), before, `${name}: nothing on disk may change`);
    assert.equal(calls.chat.length, 0, name);
  }
});

test('resume re-runs the preflight with the profile names the rendition was created with', async () => {
  const { resumeRendition, idle } = await load();
  const { deps, calls } = renderDeps();
  const m = queued({ stage: 'queued', input: { source_id: 'source:one', episode_profile: 'deep-dive', speaker_profile: 'trio' } });
  await resumeRendition(TOPIC, m.id, deps);
  await idle();
  assert.deepEqual(calls.preflight, [{ episodeProfile: 'deep-dive', speakerProfile: 'trio' }]);
});

test('an interrupted or failed rendition is queued again and finishes', async () => {
  const { resumeRendition, readRendition, idle } = await load();
  for (const stage of ['queued', 'transcript_ready', 'failed']) {
    const { deps } = renderDeps();
    const m = queued({ stage, error: stage === 'failed' ? 'earlier' : undefined });
    const summary = await resumeRendition(TOPIC, m.id, deps);
    assert.equal(summary.stage, 'queued', stage);
    assert.equal(summary.error, null, stage);
    await idle();
    assert.equal(readRendition(TOPIC, m.id).stage, 'qc_passed', stage);
  }
});

test('resume returns a finished or running rendition as it is, without queueing it again', async () => {
  const { resumeRendition, prepareRendition, idle } = await load();
  await idle();
  for (const stage of ['qc_passed', 'published']) {
    const { deps, calls } = renderDeps();
    const m = queued({ stage });
    const before = snapshot(join(AUDIO, m.id));
    assert.equal((await resumeRendition(TOPIC, m.id, deps)).stage, stage);
    assert.equal(calls.preflight.length, 0, stage);
    assert.deepEqual(snapshot(join(AUDIO, m.id)), before, stage);
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deps, calls } = fakeDeps({ chat: async () => { await gate; return { message: { content: 'not json' } }; } });
  const running = await prepareRendition(input(), deps);
  const resumed = await resumeRendition(TOPIC, running.id, deps);
  assert.equal(resumed.running, true);
  assert.equal(calls.preflight.length, 1, 'only prepare ran the preflight');
  release();
  await idle();
});

/** A rendition that passed QC, with its candidate on disk. */
async function passed() {
  const { renderRendition } = await load();
  const { deps } = renderDeps();
  const m = queued();
  await renderRendition(m, deps);
  return m.id;
}

test('publish needs qc_passed and an explicit confirmation of a full listen', async () => {
  const { publishRendition, readRendition } = await load();
  const { deps } = renderDeps();
  await assert.rejects(publishRendition(TOPIC, nextId(), true, deps), (err) => err.status === 404);
  for (const stage of ['queued', 'audio_ready', 'needs_review', 'failed']) {
    const m = queued({ stage });
    await assert.rejects(publishRendition(TOPIC, m.id, true, deps), (err) => err.status === 409, stage);
  }
  const id = await passed();
  for (const reviewed of [undefined, false, 'true', 1]) {
    await assert.rejects(publishRendition(TOPIC, id, reviewed, deps), (err) => err.status === 409 && /full listen/.test(err.message), String(reviewed));
  }
  assert.equal(readRendition(TOPIC, id).stage, 'qc_passed');
});

test('publish refuses a candidate that changed after QC', async () => {
  const { publishRendition, readRendition } = await load();
  const id = await passed();
  writeFileSync(join(AUDIO, id, 'candidate.mp3'), 'swapped after the listen');
  const { deps } = renderDeps();
  await assert.rejects(publishRendition(TOPIC, id, true, deps), (err) => err.status === 409 && /changed after QC/.test(err.message));
  assert.equal(readRendition(TOPIC, id).stage, 'qc_passed');
});

test('publish records the review once; publishing again changes nothing', async () => {
  const { publishRendition, readRendition } = await load();
  const id = await passed();
  const { deps } = renderDeps();
  const summary = await publishRendition(TOPIC, id, true, deps);
  assert.equal(summary.stage, 'published');
  const saved = readRendition(TOPIC, id);
  assert.equal(saved.review.full_listen_confirmed, true);
  assert.equal(saved.review.asset_sha256, saved.audio_qc.asset.sha256);
  const before = snapshot(join(AUDIO, id));
  assert.equal((await publishRendition(TOPIC, id, true, deps)).stage, 'published');
  assert.deepEqual(snapshot(join(AUDIO, id)), before);
});

// --- Codex review run 1 -------------------------------------------------------------

test('an untagged model name finds its installed :latest digest, as the preflight resolves it', async () => {
  const { prepareRendition, readRendition, idle } = await load();
  const { deps } = fakeDeps({
    podcastPreflight: async () => configuration({ models: { ...configuration().models, transcript: { name: 'llama3', provider: 'ollama', type: 'language' } } }),
    tags: { models: [{ name: 'llama3:latest', digest: '9'.repeat(64) }] },
  });
  const { id } = await prepareRendition(input(), deps);
  assert.equal(readRendition(TOPIC, id).runtime.digest, '9'.repeat(64));
  await idle();
});

test('a reply whose turns are not objects is a recorded, failed try, not a crash', async () => {
  const { renderRendition, readRendition } = await load();
  for (const content of ['{"turns":[null]}', '{"turns":["Ada says hello"]}', '{"turns":[[1,2]]}']) {
    const { deps, calls } = renderDeps({ chat: async () => ({ message: { content } }) });
    const m = queued();
    await renderRendition(m, deps);
    const saved = readRendition(TOPIC, m.id);
    assert.equal(saved.stage, 'needs_review', `${content}: ${saved.error ?? ''}`);
    assert.equal(calls.chat.length, 3, content);
    assert.equal(saved.transcript_attempts.length, 3, content);
    assert.equal(saved.transcript_attempts[0].rejected_response, content);
  }
});

test('a section rejected by the whole-transcript check keeps its response and hash as evidence', async () => {
  const { renderRendition, readRendition } = await load();
  const long = 'Agents plan, act and observe in a loop that repeats. '.repeat(400);
  const plan = planChapter(long, { contextTokens: 16384 });
  assert.ok(plan.segments.length >= 2, 'the fixture needs two sections');
  // Every section gets the same dialogue: each passes alone, the second repeats the first.
  const { deps } = renderDeps({
    chat: async (request) => {
      const turns = goodTurns(request).map((t, turn) => ({ ...t, dialogue: `${Array.from({ length: 45 }, (_, k) => `same${turn}w${k}`).join(' ')}.` }));
      return { message: { content: JSON.stringify({ turns }) } };
    },
  });
  const m = queued({ source: { id: 'source:one', title: 'Long', text: long, sha256: digest(long) }, plan });
  await renderRendition(m, deps);
  const saved = readRendition(TOPIC, m.id);
  assert.equal(saved.stage, 'needs_review');
  const second = saved.transcript_attempts.filter((a) => a.section_id === plan.segments[1].id);
  assert.equal(second.length, 3);
  for (const attempt of second) {
    assert.match(attempt.qc.issues.join(' '), /Repeated passage/);
    assert.match(attempt.rejected_response, /same0w0/);
    assert.match(attempt.response_hash, /^[a-f0-9]{64}$/);
  }
});

// --- Codex review run 2 -------------------------------------------------------------

test('a resume never saves over a manifest that moved on while it waited', async () => {
  const { resumeRendition, renderRendition, readRendition, idle } = await load();
  await idle();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = renderDeps({ podcastPreflight: async () => { await gate; return configuration(); } });
  const m = queued({ stage: 'failed', error: 'earlier' });
  const pending = resumeRendition(TOPIC, m.id, waiting.deps);
  const elsewhere = renderDeps();
  await renderRendition(readRendition(TOPIC, m.id), elsewhere.deps);
  const finished = readRendition(TOPIC, m.id);
  assert.equal(finished.stage, 'qc_passed');
  release();
  const summary = await pending;
  await idle();
  assert.equal(summary.stage, 'qc_passed');
  assert.deepEqual(readRendition(TOPIC, m.id), finished, 'the finished manifest is untouched');
  assert.equal(waiting.calls.chat.length, 0);
  assert.equal(waiting.calls.speech.length, 0);
});
