// WHAT: The Podcast view's lifetime. A refresh keeps each player and its position, leaving
//       the view releases every player and request exactly once, and a player's position
//       is remembered only against a known version of its audio.
// WHY:  On main, a reload re-rendered the whole view and dropped the new render's cleanup,
//       so a finished render cut off playback and a reload's polls outlived the view.
//       Like the egress recorders, these assert what the view DOES (calls, requests,
//       storage writes), never the shape of an Open Notebook response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, tick } from './fixtures/dom.mjs';
import { renderPodcast } from '../web/js/views/podcast.mjs';

const EPISODE = { id: 'episode:one', name: 'Chapter 02', audio_available: true, status: 'completed' };

function setup({ etag = '"v1"', episodes = [EPISODE], route = () => null, topics } = {}) {
  installDom();
  const players = [];
  const create = document.createElement;
  document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'audio') {
      const player = { pauses: 0, loads: 0 };
      players.push(Object.assign(element, {
        currentTime: 123,
        duration: 600,
        ended: false,
        pause() { player.pauses += 1; },
        load() { player.loads += 1; },
        player,
      }));
    }
    return element;
  };
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  const requests = [];
  globalThis.fetch = async (path, init = {}) => {
    requests.push({ path: String(path), method: init.method ?? 'GET', signal: init.signal, cache: init.cache });
    const routed = route(String(path), init);
    if (routed) return routed;
    if (init.method === 'HEAD') return new Response(null, { headers: etag ? { etag } : {} });
    if (path === '/api/on/podcast') return Response.json({ tts_ready: false, tts_model_type: 'text_to_speech', profiles: [], episodes, notebooks: [] });
    if (path === '/api/on/speaker-profiles') return Response.json([]);
    return Response.json({ voices: [] });
  };
  const root = document.createElement('div');
  const cleanup = topics ? renderPodcast(root, { topics, topic: topics[0] }) : renderPodcast(root);
  return { root, cleanup, players, storage, requests };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
const refreshButton = (root) => root.querySelectorAll('button').find((button) => /refresh/i.test(button.text));

test('a refresh keeps the same player and its position, and pauses nothing', async () => {
  const { root, players } = setup();
  await settle();
  const audio = root.querySelector('audio');
  assert.ok(audio, 'the episode has a player');

  const refresh = refreshButton(root);
  assert.ok(refresh, 'the view offers a Refresh podcast status control');
  refresh.click();
  await settle();

  assert.equal(root.querySelector('audio'), audio, 'the refreshed list reuses the same <audio>');
  assert.equal(players.length, 1, 'no second player was built');
  assert.equal(audio.currentTime, 123);
  assert.equal(audio.player.pauses, 0);
  assert.equal(audio.player.loads, 0);
});

test('leaving the view pauses and unloads each player once; a second cleanup does nothing', async () => {
  const { root, cleanup } = setup();
  await settle();
  const audio = root.querySelector('audio');
  audio.setAttribute('src', '/api/on/episodes/episode%3Aone/audio');

  cleanup();
  cleanup();

  assert.equal(audio.player.pauses, 1);
  assert.equal(audio.player.loads, 1);
  assert.equal(audio.getAttribute('src'), null, 'the src is removed so the media resource is released');
});

test('after a refresh, leaving the view aborts every request either render started', async () => {
  const { root, cleanup, requests } = setup();
  await settle();
  refreshButton(root).click();
  await settle();
  assert.ok(requests.filter((r) => r.path === '/api/on/podcast').length >= 2, 'control: the refresh asked again');

  cleanup();
  const live = requests.filter((r) => r.signal && !r.signal.aborted);
  assert.deepEqual(live.map((r) => `${r.method} ${r.path}`), [], 'no request outlives the view');
  assert.ok(requests.every((r) => r.signal), 'every request carries a signal the view can abort');
});

test('a played episode remembers its position under its audio version', async () => {
  const { root, cleanup, storage, requests } = setup();
  await settle();
  const audio = root.querySelector('audio');
  audio.dispatchEvent(new Event('play'));
  await settle();
  assert.equal(requests.filter((r) => r.method === 'HEAD').length, 1, 'the version is read on first play');

  cleanup();
  assert.equal(storage.get('studydeck.audio.episode:one."v1"'), '123');
});

test('opening the view reads no audio versions until something plays', async () => {
  const { requests } = setup({ episodes: [EPISODE, { ...EPISODE, id: 'episode:two', name: 'Chapter 03' }] });
  await settle();
  assert.equal(requests.filter((r) => r.method === 'HEAD').length, 0);
});

test('with no ETag, nothing is remembered', async () => {
  const { root, cleanup, storage } = setup({ etag: null });
  await settle();
  root.querySelector('audio').dispatchEvent(new Event('play'));
  await settle();
  cleanup();
  assert.equal(storage.size, 0);
});

test('a remembered position is restored when the same version plays again', async () => {
  const { root, storage } = setup();
  storage.set('studydeck.audio.episode:one."v1"', '321');
  await settle();
  const audio = root.querySelector('audio');
  audio.currentTime = 0;
  audio.dispatchEvent(new Event('play'));
  await settle();
  assert.equal(audio.currentTime, 321);
});

// Codex review, run 1 (P2): a refresh must still bring new profiles into the forms, as
// main's full reload did, without killing a job poll that is running in one of them.
function readyRoutes(state) {
  return (path, init) => {
    if (path === '/api/on/podcast') {
      return Response.json({ tts_ready: true, profiles: [{ name: 'study-chapter' }], episodes: [EPISODE], notebooks: [{ notebook_id: 'notebook:x', slug: 'fixture' }] });
    }
    if (path === '/api/on/speaker-profiles') return Response.json(state.speakers);
    if (path === '/api/on/podcast/generate' && init.method === 'POST') return Response.json({ job_id: 'job:1' });
    if (path === '/api/on/podcast/jobs/job%3A1') return Response.json(state.job);
    return null;
  };
}
const BASE = { name: 'base', speakers: [{ name: 'Host', voice_id: 'af_nova' }] };
const CUSTOM = { name: 'custom', speakers: [{ name: 'Host', voice_id: 'am_adam' }] };
const offers = (root, name) => root.querySelectorAll('option').some((option) => option.getAttribute('value') === name);
const selectOffering = (root, value) => root.querySelectorAll('select').find((select) => select.children.some((o) => o.getAttribute?.('value') === value));

test('a refresh brings new speaker profiles into idle forms', async () => {
  const state = { speakers: [BASE] };
  const { root } = setup({ route: readyRoutes(state) });
  await settle();
  assert.equal(offers(root, 'custom'), false, 'control: not offered before it exists');

  state.speakers = [BASE, CUSTOM];
  refreshButton(root).click();
  await settle();
  assert.equal(offers(root, 'custom'), true, 'the refreshed forms offer the new profile');
});

test('a refresh during a running render keeps its poll, and the forms catch up when it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const state = { speakers: [BASE], job: { status: 'running', terminal: false } };
  const { root, cleanup, requests } = setup({ route: readyRoutes(state) });
  await settle();

  root.querySelectorAll('input').find((input) => input.getAttribute('placeholder') === 'Episode name').value = 'Chapter 09';
  selectOffering(root, 'base').value = 'base';
  selectOffering(root, 'notebook:x').value = 'notebook:x';
  const generate = root.querySelectorAll('button').find((button) => button.text === 'Generate');
  generate.click();
  await settle();
  t.mock.timers.tick(3_000);
  await settle();
  const poll = requests.findLast((r) => r.path === '/api/on/podcast/jobs/job%3A1');
  assert.ok(poll, 'control: the render is being polled');

  state.speakers = [BASE, CUSTOM];
  refreshButton(root).click();
  await settle();
  assert.equal(root.querySelectorAll('button').includes(generate), true, 'the busy form was not rebuilt');
  assert.equal(poll.signal.aborted, false, 'the running poll survives the refresh');

  state.job = { status: 'completed', terminal: true, successful: true };
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(offers(root, 'custom'), true, 'once the render ends, the forms pick up the new profile');
  cleanup();
});

// Codex review, run 2 (P2): playback starts before the version request returns, so a slow
// HEAD must not turn ordinary playback into a reason to drop, then overwrite, a saved spot.
function slowHead() {
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  return { route: (path, init) => (init.method === 'HEAD' ? pending : null), answer: () => answer(new Response(null, { headers: { etag: '"v1"' } })) };
}

test('a slow version request still restores the saved position', async () => {
  const head = slowHead();
  const { root, storage } = setup({ route: head.route });
  storage.set('studydeck.audio.episode:one."v1"', '321');
  await settle();
  const audio = root.querySelector('audio');
  audio.currentTime = 0;
  audio.dispatchEvent(new Event('play'));
  await settle();
  audio.currentTime = 3;
  audio.dispatchEvent(new Event('timeupdate'));
  head.answer();
  await settle();
  assert.equal(audio.currentTime, 321);
});

test('a seek made before the version is known is kept, not overridden', async () => {
  const head = slowHead();
  const { root, storage } = setup({ route: head.route });
  storage.set('studydeck.audio.episode:one."v1"', '321');
  await settle();
  const audio = root.querySelector('audio');
  audio.currentTime = 0;
  audio.dispatchEvent(new Event('play'));
  await settle();
  audio.currentTime = 90;
  audio.dispatchEvent(new Event('seeking'));
  head.answer();
  await settle();
  assert.equal(audio.currentTime, 90, 'control: the learner chose this spot');
});

// Codex review, run 3 (P2): a restore deferred to loadedmetadata is still owed, so nothing
// may save over it in the meantime.
test('leaving while a restore waits for metadata keeps the saved position', async () => {
  const { root, cleanup, storage } = setup();
  storage.set('studydeck.audio.episode:one."v1"', '321');
  await settle();
  const audio = root.querySelector('audio');
  Object.assign(audio, { currentTime: 0, duration: NaN });
  audio.dispatchEvent(new Event('play'));
  await settle();
  cleanup();
  assert.equal(storage.get('studydeck.audio.episode:one."v1"'), '321');
});

test('a restore deferred to metadata lands when the metadata does', async () => {
  const { root } = setup();
  localStorage.setItem('studydeck.audio.episode:one."v1"', '321');
  await settle();
  const audio = root.querySelector('audio');
  Object.assign(audio, { currentTime: 0, duration: NaN });
  audio.dispatchEvent(new Event('play'));
  await settle();
  audio.dispatchEvent(new Event('pause'));
  assert.equal(localStorage.getItem('studydeck.audio.episode:one."v1"'), '321', 'a pause while waiting saves nothing');
  audio.duration = 600;
  audio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(audio.currentTime, 321);
});

// Codex review, run 4 (P2): a refresh deferred by a busy form must not land on top of that
// form's own outcome. A preview's report is what the learner reads before a real run.
test('a refresh during a batch preview leaves the preview report and mode in place', async () => {
  let answerPreview;
  const preview = new Promise((resolve) => { answerPreview = resolve; });
  const state = { speakers: [BASE] };
  const ready = readyRoutes(state);
  const { root, requests } = setup({ route: (path, init) => (path === '/api/on/podcast/generate-batch' ? preview : ready(path, init)) });
  await settle();

  const dryRun = root.querySelectorAll('input').find((input) => input.getAttribute('type') === 'checkbox');
  dryRun.checked = true;
  dryRun.dispatchEvent(new Event('change'));
  selectOffering(root, 'fixture').value = 'fixture';
  root.querySelectorAll('button').find((button) => button.text === 'Preview: generate all chapters').click();
  await settle();
  assert.ok(requests.some((r) => r.path === '/api/on/podcast/generate-batch'), 'control: the preview was sent');

  state.speakers = [BASE, CUSTOM];
  refreshButton(root).click();
  await settle();
  answerPreview(Response.json({ dry_run: true, would_generate: 1, would_delete: 0, targets: [{ title: 'Chapter 09' }] }));
  await settle();

  assert.match(root.text, /PREVIEW — nothing was sent/, 'the preview report is still on screen');
  assert.equal(root.querySelectorAll('input').includes(dryRun) && dryRun.checked, true, 'Preview only is still on');
});

// Found in the browser check, not by a reviewer: at the start of playback Chrome holds the
// HTTP-cache entry for the audio URL while the stream fills it, and a cacheable HEAD for
// the same URL waits on that lock (measured: over 8 s, and 20 s in one run; no-store: 42 ms).
// The resume then lands long after playback began. This pins what the view SENDS.
test('the version request bypasses the HTTP cache, so it cannot queue behind the stream', async () => {
  const { root, requests } = setup();
  await settle();
  root.querySelector('audio').dispatchEvent(new Event('play'));
  await settle();
  const head = requests.find((r) => r.method === 'HEAD');
  assert.ok(head, 'control: a version request was sent');
  assert.equal(head.cache, 'no-store');
});

// ---- D5e step 8: the Checked chapters section loads on its own (spec concern 3) ----

const TOPICS = [{ slug: 'fastai', notebook_id: 'notebook:fastai' }];
const RENDITION = {
  id: 'render-aaaaaaaaaaaaaaaaaaaaaaaa', topic_slug: 'fastai', source_id: 'source:one', source_title: 'Chapter One',
  stage: 'qc_passed', status: 'qc_passed', progress: 'Ready for a full listen and publication review',
  audio_available: true, audio_url: '/api/podcast/renders/render-aaaaaaaaaaaaaaaaaaaaaaaa/audio?topic=fastai',
  interrupted: false, preferred: false, issues: [], repetitions: [], error: null,
};
const renditions = (path) => (path.startsWith('/api/podcast/renders?') ? Response.json({ renditions: [RENDITION] }) : null);

test('Open Notebook failing still paints Checked chapters, with its panel in its own place', async () => {
  const { root } = setup({ topics: TOPICS, route: (path) => {
    if (path === '/api/on/podcast') return Response.json({ error: 'Open Notebook unreachable at http://127.0.0.1:5055 (fetch failed)' }, { status: 503 });
    return renditions(path);
  } });
  await settle();
  assert.match(root.text, /Open Notebook is not answering/, 'the panel is still shown');
  const section = root.querySelector('.chapter-section');
  assert.ok(section, 'the section is painted beside it');
  assert.match(section.text, /Chapter One/, 'and lists the local recording');
  assert.match(section.text, /Rendering needs Open Notebook, which isn't answering/);
  assert.ok(section.querySelector('audio'), 'which can still be played');
});

test('the chapter list failing still paints the Open Notebook cards', async () => {
  const { root } = setup({ topics: TOPICS, route: (path) => (path.startsWith('/api/podcast/renders?') ? Response.json({ error: 'list failed' }, { status: 500 }) : null) });
  await settle();
  assert.match(root.text, /Rendered episodes/, 'the Open Notebook cards are there');
  assert.match(root.querySelector('.chapter-section').text, /list failed/, 'and the section says what went wrong');
});

test('leaving the view releases the section\'s players and requests too', async () => {
  const { root, cleanup, requests } = setup({ topics: TOPICS, route: renditions });
  await settle();
  const audio = root.querySelector('.chapter-section').querySelector('audio');
  assert.ok(audio, 'control: the section has a player');
  assert.ok(requests.some((r) => r.path.startsWith('/api/podcast/renders?')), 'control: the section asked for its list');
  cleanup();
  assert.equal(audio.player.pauses, 1);
  assert.equal(audio.player.loads, 1);
  assert.equal(audio.getAttribute('src'), null);
  assert.deepEqual(requests.filter((r) => r.signal && !r.signal.aborted).map((r) => r.path), []);
});
