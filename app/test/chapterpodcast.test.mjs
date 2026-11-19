// WHAT: The Checked chapters section of the Podcast view (D5e): its labels, its rows, its
//       poll, and what its controls send.
// WHY:  The section re-reads the list every 5 seconds while a render runs. Rebuilding it
//       each time would cut off audio, close a transcript and drop focus (spec concern 1),
//       so these pin that rows are updated in place, and that only stage changes are
//       announced. The section takes `request` and `delay` as parameters, so the DOM
//       recorder and a fake delay drive it with no browser and no timers. Loaded with
//       import() so missing exports fail only this file.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../web/js/views/chapterpodcast.mjs');

// ---- Step 2: the helpers (C2, C9, R9) ----

test('every stage reads as a word, and an interrupted render says how to continue', async () => {
  const { stageLabel } = await load();
  const labels = {
    queued: 'Queued', transcript_ready: 'Voicing', audio_ready: 'Checking audio', qc_passed: 'Ready to review',
    published: 'Published', needs_review: 'Failed checks', failed: 'Stopped',
  };
  for (const [stage, label] of Object.entries(labels)) assert.equal(stageLabel({ stage }), label, stage);
  assert.equal(stageLabel({ stage: 'transcript_ready', interrupted: true }), 'Interrupted — resume to continue');
  // A damaged manifest is listed with a status and no stage.
  assert.equal(stageLabel({ status: 'needs_repair' }), 'Needs repair');
  assert.equal(stageLabel({ stage: 'something-new' }), 'something-new', 'an unknown stage is shown, not hidden');
});

test('a render is active while it is queued or working and not interrupted', async () => {
  const { isActive } = await load();
  for (const stage of ['queued', 'transcript_ready', 'audio_ready']) {
    assert.equal(isActive({ stage }), true, stage);
    assert.equal(isActive({ stage, interrupted: true }), false, `${stage} interrupted`);
  }
  for (const stage of ['qc_passed', 'published', 'needs_review', 'failed']) assert.equal(isActive({ stage }), false, stage);
  assert.equal(isActive({ status: 'needs_repair' }), false);
});

test('a time in a QC note reads as m:ss', async () => {
  const { formatOffset } = await load();
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatOffset(102), '1:42');
  assert.equal(formatOffset(185.6), '3:05');
  assert.equal(formatOffset(3661), '61:01');
});

// ---- The harness for steps 3 to 7 ----

const TOPICS = [{ slug: 'fastai', notebook_id: 'notebook:fastai' }, { slug: 'empty', notebook_id: null }];
// The fields /api/on/podcast returns on main. A profile with no transcript model fails at
// render time (the stock ones since migration 22), so only those with one are offered.
const PROFILES = [
  { name: 'unfinished', transcript_model: null, outline_model: null, speaker_config: 'solo' },
  { name: 'study-chapter', transcript_model: 'model:language', outline_model: 'model:language', speaker_config: 'pair' },
];
const SPEAKER_PROFILES = [{ name: 'solo' }, { name: 'pair' }];

/**
 * A section on the DOM recorder. `lists` are the successive answers to the list route; the
 * last one repeats. `routes(path, options)` may answer anything else first. Every request
 * is recorded, and `delay` resolves only when the test calls `wake()`.
 */
async function harness({ lists = [{ renditions: [] }], routes = () => undefined, available = true } = {}) {
  const { installDom } = await import('./fixtures/dom.mjs');
  installDom();
  const { createChapterSection } = await load();
  const requests = [];
  const announced = [];
  let served = 0;
  const sleepers = [];
  const request = async (path, options = {}) => {
    requests.push({ path, method: options.method ?? 'GET', body: options.body });
    const routed = await routes(path, options);
    if (routed !== undefined) return routed;
    if (path.startsWith('/api/podcast/renders?')) {
      const answer = lists[Math.min(served++, lists.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.startsWith('/api/on/sources')) return { sources: [{ id: 'source:one', title: 'Chapter One' }] };
    throw new Error(`harness has no answer for ${path}`);
  };
  // A sleeper leaves the queue when its signal aborts, so `sleepers` is what is still pending.
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const sleeper = { ms, resolve };
    sleepers.push(sleeper);
    signal?.addEventListener('abort', () => {
      sleepers.splice(sleepers.indexOf(sleeper), 1);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  const section = createChapterSection({ request, delay, topics: TOPICS, topic: TOPICS[0], onAnnounce: (text) => announced.push(text) });
  // The Podcast view hands over what its own Open Notebook load found, or that it failed.
  section.setOpenNotebook(available, available
    ? { profiles: PROFILES, speakerProfiles: SPEAKER_PROFILES }
    : { reason: 'Open Notebook unreachable at http://127.0.0.1:5055 (fetch failed)' });
  await settle();
  const wake = async () => { const sleeper = sleepers.shift(); sleeper?.resolve(); await settle(); return Boolean(sleeper); };
  return { section, root: section.element, requests, announced, sleepers, wake };
}

async function settle() {
  const { tick } = await import('./fixtures/dom.mjs');
  for (let i = 0; i < 8; i += 1) await tick();
}

const row = (root, id) => root.querySelectorAll('.chapter-row').find((r) => r.getAttribute('data-id') === id);
const summary = (changes = {}) => ({
  id: 'render-aaaaaaaaaaaaaaaaaaaaaaaa', topic_slug: 'fastai', source_id: 'source:one', source_title: 'Chapter One',
  stage: 'qc_passed', status: 'qc_passed', progress: 'Ready for a full listen and publication review',
  audio_available: true, audio_url: '/api/podcast/renders/render-aaaaaaaaaaaaaaaaaaaaaaaa/audio?topic=fastai',
  interrupted: false, preferred: false, issues: [], repetitions: [], error: null, ...changes,
});

// ---- Step 3: rows, updated in place (R4, R5, A2, A3) ----

test('the list paints one row per rendition in the order given, and says so when there are none', async () => {
  const first = summary({ id: 'render-bbbbbbbbbbbbbbbbbbbbbbbb', source_title: 'Chapter Two' });
  const second = summary();
  const { root } = await harness({ lists: [{ renditions: [first, second] }] });
  assert.deepEqual(root.querySelectorAll('.chapter-row').map((r) => r.getAttribute('data-id')), [first.id, second.id]);
  assert.match(row(root, first.id).text, /Chapter Two/);
  assert.match(row(root, first.id).text, /Ready to review/);

  const empty = await harness({ lists: [{ renditions: [] }] });
  assert.match(empty.root.text, /No checked chapters for this topic yet\. Choose a chapter above and render it\./);
});

test('a poll that leaves the stage alone keeps the same player and transcript, open, and changes only progress', async () => {
  const before = summary({ stage: 'audio_ready', status: 'audio_ready', progress: 'Checking the assembled recording', audio_available: true });
  const after = { ...before, progress: 'Still checking the assembled recording' };
  const { root, section } = await harness({ lists: [{ renditions: [before] }, { renditions: [after] }] });
  const audio = row(root, before.id).querySelector('audio');
  const details = row(root, before.id).querySelector('details');
  assert.ok(audio, 'a row with audio has a player');
  assert.ok(details, 'every row has a transcript disclosure');
  details.open = true;
  await section.reload();
  await settle();
  assert.equal(row(root, before.id).querySelector('audio'), audio, 'the same <audio> element');
  assert.equal(row(root, before.id).querySelector('details'), details, 'the same <details> element');
  assert.equal(details.open, true, 'still open');
  assert.match(row(root, before.id).text, /Still checking the assembled recording/);
});

test('only a stage change is announced, once, and never a progress tick', async () => {
  const writing = summary({ stage: 'queued', status: 'queued', progress: 'Writing section-1 of 3', audio_available: false });
  const lists = [
    { renditions: [writing] },
    { renditions: [{ ...writing, progress: 'Writing section-2 of 3' }] },
    { renditions: [{ ...writing, stage: 'transcript_ready', status: 'transcript_ready', progress: 'Speaking turn 1 of 16' }] },
    { renditions: [{ ...writing, stage: 'transcript_ready', status: 'transcript_ready', progress: 'Speaking turn 2 of 16' }] },
  ];
  const { section, announced } = await harness({ lists });
  assert.deepEqual(announced, [], 'the first paint announces nothing');
  for (let i = 0; i < 3; i += 1) { await section.reload(); await settle(); }
  assert.deepEqual(announced, ['Chapter One: Voicing']);
});

test('a damaged manifest is listed as needing repair, with nothing to act on', async () => {
  const damaged = { id: 'render-cccccccccccccccccccccccc', topic_slug: 'fastai', name: 'render-cccccccccccccccccccccccc', status: 'needs_repair', error: 'Rendition metadata needs repair (bad json); original and backup retained', audio_available: false };
  const { root } = await harness({ lists: [{ renditions: [damaged] }] });
  const r = row(root, damaged.id);
  assert.match(r.text, /Needs repair/);
  assert.match(r.text, /original and backup retained/);
  assert.equal(r.querySelectorAll('button').length, 0);
  assert.equal(r.querySelector('audio'), null);
});

// ---- Step 4: polling (R9) ----

const listCalls = (requests) => requests.filter((r) => r.path.startsWith('/api/podcast/renders?')).length;
const working = (changes = {}) => summary({ stage: 'transcript_ready', status: 'transcript_ready', progress: 'Speaking turn 1 of 16', audio_available: false, ...changes });

test('while a render is active the list re-reads every 5 seconds, and stops once none is', async () => {
  const lists = [{ renditions: [working()] }, { renditions: [working()] }, { renditions: [summary()] }];
  const { requests, sleepers, wake } = await harness({ lists });
  assert.equal(listCalls(requests), 1);
  assert.deepEqual(sleepers.map((s) => s.ms), [5000], 'one poll pending, five seconds out');
  await wake();
  assert.equal(listCalls(requests), 2);
  assert.equal(sleepers.length, 1, 'still active, so another poll');
  await wake();
  assert.equal(listCalls(requests), 3);
  assert.equal(sleepers.length, 0, 'nothing active, so no poll');
});

test('nothing active means no poll at all, and an interrupted render does not count', async () => {
  const { sleepers } = await harness({ lists: [{ renditions: [summary(), working({ id: 'render-dddddddddddddddddddddddd', interrupted: true })] }] });
  assert.equal(sleepers.length, 0);
});

test('a manual reload replaces the pending poll instead of starting a second loop', async () => {
  const { section, sleepers, requests } = await harness({ lists: [{ renditions: [working()] }] });
  assert.equal(sleepers.length, 1);
  await section.reload();
  await settle();
  await section.reload();
  await settle();
  assert.equal(sleepers.length, 1, 'one loop, however many reloads');
  assert.equal(listCalls(requests), 3);
});

test('changing topic and leaving the view both stop the poll', async () => {
  const lists = [{ renditions: [working()] }, { renditions: [] }];
  const changed = await harness({ lists });
  assert.equal(changed.sleepers.length, 1);
  const select = changed.root.querySelector('select');
  select.value = 'empty';
  select.dispatchEvent(new Event('change'));
  await settle();
  assert.equal(changed.sleepers.length, 0, 'the other topic has nothing active');
  assert.match(changed.requests.at(-1).path, /topic=empty/);

  const left = await harness({ lists: [{ renditions: [working()] }] });
  assert.equal(left.sleepers.length, 1);
  const before = listCalls(left.requests);
  left.section.dispose();
  await settle();
  assert.equal(left.sleepers.length, 0, 'the pending poll was aborted');
  assert.equal(await left.wake(), false);
  assert.equal(listCalls(left.requests), before);
});

// ---- Step 5: resume and publish (R7, R8, A5) ----

const actionCalls = (requests, action) => requests.filter((r) => r.method === 'POST' && r.path.endsWith(`/${action}`));
const button = (node, label) => node.querySelectorAll('button').find((b) => b.text === label);

test('publish waits for the full-listen checkbox, then sends exactly that confirmation', async () => {
  const passed = summary();
  const published = { ...passed, stage: 'published', status: 'published' };
  const { root, requests } = await harness({ lists: [{ renditions: [passed] }, { renditions: [published] }], routes: (path, options) => (options.method === 'POST' ? { rendition: published } : undefined) });
  const r = row(root, passed.id);
  const publish = button(r, 'Publish recording');
  const box = r.querySelector('input');
  assert.ok(publish && box, 'a qc_passed row offers publish behind a checkbox');
  assert.match(r.text, /I listened to the full recording and checked its explanations and coverage/);
  assert.equal(publish.disabled, true);
  publish.click();
  await settle();
  assert.equal(actionCalls(requests, 'publish').length, 0, 'an unticked box sends nothing, even if the click arrives');

  box.checked = true;
  box.dispatchEvent(new Event('change'));
  assert.equal(publish.disabled, false);
  publish.click();
  await settle();
  const [sent] = actionCalls(requests, 'publish');
  assert.equal(sent.path, `/api/podcast/renders/${passed.id}/publish`);
  assert.deepEqual(sent.body, { topic_slug: 'fastai', full_listen_confirmed: true });
  assert.equal(document.activeElement, row(root, passed.id).querySelector('.chapter-status'), 'focus lands on the row status');
  assert.match(row(root, passed.id).text, /Published/);
});

test('resume is offered on an interrupted or stopped render and sends only the topic', async () => {
  for (const changes of [{ interrupted: true }, { stage: 'failed', status: 'failed', error: 'Speech service returned 500' }]) {
    const stuck = working(changes);
    const { root, requests } = await harness({ lists: [{ renditions: [stuck] }], routes: (path, options) => (options.method === 'POST' ? { rendition: { ...stuck, stage: 'queued', interrupted: false } } : undefined) });
    const resume = button(row(root, stuck.id), 'Resume render');
    assert.ok(resume, JSON.stringify(changes));
    const before = listCalls(requests);
    resume.click();
    await settle();
    const [sent] = actionCalls(requests, 'resume');
    assert.deepEqual(sent.body, { topic_slug: 'fastai' }, 'no mutation_id');
    assert.equal(listCalls(requests), before + 1, 'the list re-reads');
    assert.equal(document.activeElement, row(root, stuck.id).querySelector('.chapter-status'));
  }
});

test('each action appears only where it can work', async () => {
  const { root } = await harness({ lists: [{ renditions: [
    summary({ id: 'render-111111111111111111111111', stage: 'published', status: 'published' }),
    working({ id: 'render-222222222222222222222222' }),
    summary({ id: 'render-333333333333333333333333', stage: 'needs_review', status: 'needs_review', audio_available: false }),
  ] }] });
  for (const id of ['render-111111111111111111111111', 'render-222222222222222222222222', 'render-333333333333333333333333']) {
    assert.equal(row(root, id).querySelectorAll('button').length, 0, id);
  }
});

test('a refused action shows the server\'s reason in its row', async () => {
  const passed = summary();
  const refusal = 'Candidate changed after QC; it cannot be published';
  const { root } = await harness({ lists: [{ renditions: [passed] }], routes: (path, options) => { if (options.method === 'POST') throw Object.assign(new Error(refusal), { status: 409 }); return undefined; } });
  const r = row(root, passed.id);
  const box = r.querySelector('input');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  button(r, 'Publish recording').click();
  await settle();
  assert.match(row(root, passed.id).text, new RegExp(refusal));
  assert.equal(button(row(root, passed.id), 'Publish recording').disabled, false, 'a refused publish can be tried again');
});

// ---- Step 6: create, and Open Notebook down (R3, R10, A4) ----

const creates = (requests) => requests.filter((r) => r.method === 'POST' && r.path === '/api/podcast/renders');

test('render chapter sends the chosen chapter and profiles, defaulting to study-chapter and its speakers', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { root, requests } = await harness({ routes: async (path, options) => {
    if (options.method === 'POST' && path === '/api/podcast/renders') { await held; return { rendition: working() }; }
    return undefined;
  } });
  const render = button(root, 'Render chapter');
  assert.ok(render, 'the create card is there');
  assert.equal(render.disabled, false);
  assert.match(root.text, /Takes about 5 minutes\./);
  render.click();
  await settle();
  assert.equal(render.disabled, true, 'disabled while the request is in flight');
  const [sent] = creates(requests);
  assert.equal(sent.body.topic_slug, 'fastai');
  assert.equal(sent.body.source_id, 'source:one');
  assert.equal(sent.body.episode_profile, 'study-chapter', 'only profiles with a transcript model, study-chapter first');
  const offered = root.querySelectorAll('select')[2].querySelectorAll('option').map((o) => o.getAttribute('value'));
  assert.deepEqual(offered, ['study-chapter'], 'a profile with no transcript model is not offered');
  assert.equal(sent.body.speaker_profile, 'pair', 'the episode profile\'s own speakers');
  assert.match(sent.body.mutation_id, /^[0-9a-f-]{36}$/);
  const before = listCalls(requests);
  release();
  await settle();
  assert.equal(listCalls(requests), before + 1, 'the list re-reads to show the new render');
});

test('a failed create is retried under the same mutation_id, and the next render after success gets a new one', async () => {
  let fail = true;
  const { root, requests } = await harness({ routes: (path, options) => {
    if (options.method === 'POST' && path === '/api/podcast/renders') {
      if (fail) throw Object.assign(new Error('Open Notebook unreachable'), { status: 503 });
      return { rendition: working() };
    }
    return undefined;
  } });
  const render = button(root, 'Render chapter');
  render.click();
  await settle();
  assert.match(root.text, /Open Notebook unreachable/, 'the failure is shown');
  assert.equal(render.disabled, false, 'and can be retried');
  fail = false;
  render.click();
  await settle();
  render.click();
  await settle();
  const ids = creates(requests).map((r) => r.body.mutation_id);
  assert.equal(ids.length, 3);
  assert.equal(ids[1], ids[0], 'the retry is the same intent');
  assert.notEqual(ids[2], ids[1], 'a render after success is a new one');
});

test('with Open Notebook down, render and resume are disabled with the reason beside them, and the list still works', async () => {
  const stuck = working({ interrupted: true });
  const { root, requests } = await harness({ available: false, lists: [{ renditions: [stuck, summary({ id: 'render-eeeeeeeeeeeeeeeeeeeeeeee' })] }] });
  const reason = root.querySelectorAll('p').find((p) => /Rendering needs Open Notebook, which isn't answering\. Recordings below still play and can be published\./.test(p.text));
  assert.ok(reason, 'the outage is explained in visible text');
  const reasonId = reason.getAttribute('id');
  assert.ok(reasonId);
  for (const control of [button(root, 'Render chapter'), button(row(root, stuck.id), 'Resume render')]) {
    assert.equal(control.disabled, true, control.text);
    assert.equal(control.getAttribute('aria-describedby'), reasonId, control.text);
  }
  assert.equal(requests.filter((r) => r.path.startsWith('/api/on/')).length, 0, 'no Open Notebook request while it is down');
  assert.ok(button(row(root, 'render-eeeeeeeeeeeeeeeeeeeeeeee'), 'Publish recording'), 'publish does not need Open Notebook');
});

// ---- Step 7: the transcript (R6) ----

const openDetails = async (details) => { details.open = true; details.dispatchEvent(new Event('toggle')); await settle(); };
const reads = (requests, id) => requests.filter((r) => r.path.startsWith(`/api/podcast/renders/${id}?`));
const READ = {
  rendition: { plan: { segments: [{ id: 'section-1', anchor: 'Hello, and thank you for letting us join you' }], excluded: [{ reason: 'a code listing with no prose' }] } },
  transcript: [
    { speaker: 'Dr. Alex Chen', dialogue: 'Deep learning is for everyone.' },
    { speaker: 'Jamie Rodriguez', dialogue: 'Even <img src=x onerror=alert(1)> in a book?' },
  ],
  transcript_attempts: [],
};

test('the transcript loads once, on first open, with the plan, what was left out, and every turn', async () => {
  const passed = summary();
  const { root, requests } = await harness({ lists: [{ renditions: [passed] }], routes: (path) => (path.startsWith(`/api/podcast/renders/${passed.id}?`) ? READ : undefined) });
  const details = row(root, passed.id).querySelector('details');
  assert.equal(reads(requests, passed.id).length, 0, 'nothing is read until it is opened');
  await openDetails(details);
  assert.equal(reads(requests, passed.id).length, 1);
  assert.equal(reads(requests, passed.id)[0].path, `/api/podcast/renders/${passed.id}?topic=fastai`);
  assert.match(details.text, /section-1 · Hello, and thank you for letting us join you/);
  assert.match(details.text, /Omitted: a code listing with no prose\./);
  assert.match(details.text, /Dr\. Alex Chen: Deep learning is for everyone\./);
  details.open = false; details.dispatchEvent(new Event('toggle'));
  await openDetails(details);
  assert.equal(reads(requests, passed.id).length, 1, 'opened again, not read again');
});

test('markup in a transcript turn is shown as text, never parsed', async () => {
  const passed = summary();
  const { root } = await harness({ lists: [{ renditions: [passed] }], routes: (path) => (path.startsWith(`/api/podcast/renders/${passed.id}?`) ? READ : undefined) });
  const details = row(root, passed.id).querySelector('details');
  await openDetails(details);
  assert.match(details.text, /Jamie Rodriguez: Even <img src=x onerror=alert\(1\)> in a book\?/);
  assert.equal(details.querySelector('img'), null, 'no element was made from the model\'s text');
});

test('a transcript that fails to load says why, and is read again on the next open', async () => {
  const passed = summary();
  let fail = true;
  const { root, requests } = await harness({ lists: [{ renditions: [passed] }], routes: (path) => {
    if (!path.startsWith(`/api/podcast/renders/${passed.id}?`)) return undefined;
    if (fail) throw Object.assign(new Error('Rendition metadata needs repair (bad json); original and backup retained'), { status: 409 });
    return READ;
  } });
  const details = row(root, passed.id).querySelector('details');
  await openDetails(details);
  assert.match(row(root, passed.id).text, /needs repair/);
  fail = false;
  details.open = false; details.dispatchEvent(new Event('toggle'));
  await openDetails(details);
  assert.equal(reads(requests, passed.id).length, 2);
  assert.match(details.text, /Deep learning is for everyone/);
});

// ---- Codex run 1 ----

test('a poll that keeps the order moves no row, so focus inside a row survives (Codex run 1, P2)', async () => {
  // Re-appending an attached row removes and reinserts it, and the browser drops focus from
  // anything inside it. Same element instances are not enough; the rows must stay put.
  const a = working({ id: 'render-a1a1a1a1a1a1a1a1a1a1a1a1', source_title: 'A' });
  const b = summary({ id: 'render-b2b2b2b2b2b2b2b2b2b2b2b2', source_title: 'B' });
  const { root, section } = await harness({ lists: [{ renditions: [a, b] }] });
  const body = row(root, a.id).parentNode;
  let removals = 0;
  const removeChild = body.removeChild.bind(body);
  body.removeChild = (child) => { removals += 1; return removeChild(child); };
  await section.reload();
  await settle();
  assert.equal(removals, 0, 'no row was detached');
  assert.deepEqual(root.querySelectorAll('.chapter-row').map((r) => r.getAttribute('data-id')), [a.id, b.id]);

  // Control: a changed order does move rows, so the counter can see a move.
  const reordered = await harness({ lists: [{ renditions: [a, b] }, { renditions: [b, a] }] });
  const list = row(reordered.root, a.id).parentNode;
  let moved = 0;
  const remove = list.removeChild.bind(list);
  list.removeChild = (child) => { moved += 1; return remove(child); };
  await reordered.section.reload();
  await settle();
  assert.ok(moved > 0, 'control: a reorder is a move');
  assert.deepEqual(reordered.root.querySelectorAll('.chapter-row').map((r) => r.getAttribute('data-id')), [b.id, a.id]);
});

test('a transcript opened mid-render is read again when the stage moves on (Codex run 1, P2)', async () => {
  const early = working({ stage: 'queued', status: 'queued', progress: 'Writing section-1 of 1' });
  const done = summary({ id: early.id });
  let complete = false;
  const { root, requests, section } = await harness({
    lists: [{ renditions: [early] }, { renditions: [done] }],
    routes: (path) => {
      if (!path.startsWith(`/api/podcast/renders/${early.id}?`)) return undefined;
      return { ...READ, transcript: complete ? READ.transcript : [] };
    },
  });
  const details = row(root, early.id).querySelector('details');
  await openDetails(details);
  assert.doesNotMatch(details.text, /Deep learning is for everyone/, 'nothing written yet');
  complete = true;
  await section.reload();
  await settle();
  assert.equal(reads(requests, early.id).length, 2, 'the open transcript is read again on the stage change');
  assert.match(details.text, /Deep learning is for everyone/);
  assert.equal((details.text.match(/Deep learning is for everyone/g) ?? []).length, 1, 'the old copy was replaced, not added to');
});

// ---- Codex run 2 ----

test('a status refresh keeps the chapter and speakers chosen for the same topic (Codex run 2, P2)', async () => {
  const twoSources = (path) => (path.startsWith('/api/on/sources') ? { sources: [{ id: 'source:one', title: 'Chapter One' }, { id: 'source:two', title: 'Chapter Two' }] } : undefined);
  const { root, section } = await harness({ routes: twoSources });
  const [, source, , speaker] = root.querySelectorAll('select');
  assert.equal(source.value, 'source:one', 'the first chapter by default');
  source.value = 'source:two';
  speaker.value = 'solo';
  // What the Podcast view does on every refresh, including the one a finished job starts.
  section.setOpenNotebook(true, { profiles: PROFILES, speakerProfiles: SPEAKER_PROFILES });
  await settle();
  assert.equal(source.value, 'source:two', 'the chosen chapter is kept');
  assert.equal(speaker.value, 'solo', 'the chosen speakers are kept');
});

test('an older transcript read cannot replace a newer one (Codex run 2, P2)', async () => {
  const early = working({ stage: 'queued', status: 'queued', progress: 'Writing section-1 of 1' });
  const done = summary({ id: early.id });
  const pending = [];
  const { root, section } = await harness({
    lists: [{ renditions: [early] }, { renditions: [done] }],
    routes: (path) => {
      if (!path.startsWith(`/api/podcast/renders/${early.id}?`)) return undefined;
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  const details = row(root, early.id).querySelector('details');
  await openDetails(details);
  await section.reload();
  await settle();
  assert.equal(pending.length, 2, 'the stage change started a second read while the first was out');
  pending[1](READ);
  await settle();
  pending[0]({ ...READ, transcript: [] });
  await settle();
  assert.match(details.text, /Deep learning is for everyone/, 'the newer, complete transcript stays');
});

test('one failed poll does not stop polling while a render is still active (Codex run 2, P2)', async () => {
  const lists = [{ renditions: [working()] }, new Error('fetch failed'), { renditions: [summary()] }];
  const { root, requests, sleepers, wake } = await harness({ lists });
  assert.equal(sleepers.length, 1);
  await wake();
  assert.match(root.text, /fetch failed/, 'the failure is shown');
  assert.equal(sleepers.length, 1, 'and another poll is scheduled');
  await wake();
  assert.equal(listCalls(requests), 3);
  assert.match(row(root, summary().id).text, /Ready to review/);
  assert.equal(sleepers.length, 0, 'done, so polling stops');
});
