// WHAT: The Podcast view's Checked chapters section (D5e): pick a topic and a chapter,
//       render it, follow its progress, listen, read the transcript, resume, and publish
//       after a confirmed full listen.
// WHY:  Renditions are local. This section loads on its own, so the list, the player and
//       publish keep working while Open Notebook is down; only rendering needs it.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { abortableDelay, createViewScope, isAbortError } from '../lifecycle.mjs';
import { withMutationId } from '../mutation.mjs';

const STAGE_LABELS = {
  queued: 'Queued',
  transcript_ready: 'Voicing',
  audio_ready: 'Checking audio',
  qc_passed: 'Ready to review',
  published: 'Published',
  needs_review: 'Failed checks',
  failed: 'Stopped',
  needs_repair: 'Needs repair',
};
const ACTIVE_STAGES = new Set(['queued', 'transcript_ready', 'audio_ready']);
// How often the list re-reads while a render runs. A chapter takes about five minutes.
const POLL_MS = 5000;
const OUTAGE = 'Rendering needs Open Notebook, which isn\'t answering. Recordings below still play and can be published.';

/** The words a learner reads for a rendition's stage. */
export function stageLabel(rendition) {
  if (rendition.interrupted) return 'Interrupted — resume to continue';
  // A damaged manifest is listed with a status and no stage.
  const stage = rendition.stage ?? rendition.status;
  return STAGE_LABELS[stage] ?? stage;
}

/** Whether the list should keep polling for this rendition. */
export function isActive(rendition) {
  return ACTIVE_STAGES.has(rendition.stage) && !rendition.interrupted;
}

/** Seconds as m:ss, for the times a QC note asks the listener to check. */
export function formatOffset(seconds) {
  // Floored, so seeking to the time lands on or just before the spot, never after it.
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

let sequence = 0;
const uid = (name) => `chapter-${name}-${sequence += 1}`;

function labelled(text, control) {
  control.setAttribute('id', uid('control'));
  return el('div', { class: 'qrow gen-row' }, el('label', { for: control.getAttribute('id') }, text), control);
}

const titleOf = (r) => r.source_title ?? r.name ?? r.id;
// What a poll compares to decide whether a row's stage, and so its actions, changed.
const stageKey = (r) => `${r.stage ?? r.status}|${Boolean(r.interrupted)}`;

function notesFor(r) {
  const parts = [];
  if (r.error) parts.push(r.error);
  if (r.issues?.length) parts.push(r.issues.join('; '));
  if (r.repetitions?.length) parts.push(`Check ${r.repetitions.map((x) => formatOffset(x.repeated_at_seconds)).join(', ')}.`);
  return parts.join(' ');
}

/**
 * The Checked chapters section. `request` and `delay` default to the real ones and are
 * parameters so the tests can drive the section without a browser or timers.
 */
export function createChapterSection({
  request = requestJson, delay = abortableDelay, topics = [], topic = null, onAnnounce = () => {},
} = {}) {
  const scope = createViewScope();
  const rows = new Map();
  let listScope = null;
  // Whether the last list that arrived had a render in progress.
  let lastActive = false;

  const live = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const announce = (text) => { live.textContent = text; onAnnounce(text); };

  const topicSelect = el('select', { class: 'q-input' });
  for (const t of topics) topicSelect.append(el('option', { value: t.slug }, t.slug));
  topicSelect.value = (topic && topics.some((t) => t.slug === topic.slug) ? topic : topics.find((t) => t.notebook_id) ?? topics[0])?.slug ?? '';

  const listBody = el('div', { class: 'chapter-list' });
  const listMessage = el('p', { class: 'q-hint' }, 'Loading checked chapters…');
  const listCard = el('div', { class: 'card', style: 'margin-top:18px' },
    el('div', { class: 'cap' }, 'Checked chapters'), listMessage, listBody);

  // Open Notebook: null until the Podcast view reports on it, then true or false.
  let openNotebook = null;
  const outage = el('p', { class: 'q-hint chapter-outage', id: uid('outage') });
  const sourceSelect = el('select', { class: 'q-input' });
  const profileSelect = el('select', { class: 'q-input' });
  const speakerSelect = el('select', { class: 'q-input' });
  const render = el('button', { class: 'btn primary', type: 'button' }, 'Render chapter');
  render.disabled = true;
  const createMessage = el('p', { class: 'q-hint' });
  let sourcesReady = false;
  let creating = false;
  const createCard = el('div', { class: 'card', style: 'margin-top:18px' },
    el('div', { class: 'cap' }, 'Render a checked chapter'),
    el('p', { class: 'q-hint' }, 'Takes about 5 minutes. The transcript is checked before it\'s voiced, and the recording waits for your full listen before it\'s published. You can leave this view; the render keeps going.'),
    labelled('Chapter source', sourceSelect), labelled('Episode profile', profileSelect), labelled('Speaker profile', speakerSelect),
    render, outage, createMessage);

  const element = el('section', { class: 'chapter-section', 'aria-label': 'Checked chapters' },
    labelled('Topic', topicSelect), createCard, listCard, live);

  /** Render and every Resume render follow Open Notebook's availability (A4). */
  function applyAvailability() {
    const down = openNotebook === false;
    render.disabled = down || !sourcesReady || creating;
    const controls = [render, ...[...rows.values()].map((entry) => entry.resume).filter(Boolean)];
    for (const control of controls) {
      if (down) control.setAttribute('aria-describedby', outage.getAttribute('id'));
      else control.removeAttribute('aria-describedby');
    }
    for (const entry of rows.values()) if (entry.resume && !entry.resumeBusy) entry.resume.disabled = down;
  }

  let sourcesScope = null;
  scope.own(() => sourcesScope?.dispose());
  async function loadSources() {
    sourcesScope?.dispose();
    const current = sourcesScope = createViewScope();
    // A refresh of the same topic keeps the chosen chapter; another topic's ids never match.
    const chosen = sourceSelect.value;
    sourcesReady = false;
    clear(sourceSelect);
    applyAvailability();
    if (openNotebook !== true) return;
    try {
      const data = await request(`/api/on/sources?topic=${encodeURIComponent(topicSelect.value)}`, { signal: current.signal });
      if (current.signal.aborted) return;
      for (const source of data.sources ?? []) sourceSelect.append(el('option', { value: source.id }, source.title));
      const sources = data.sources ?? [];
      sourceSelect.value = sources.some((source) => source.id === chosen) ? chosen : sources[0]?.id ?? '';
      sourcesReady = (data.sources ?? []).length > 0;
      createMessage.textContent = sourcesReady ? '' : 'This topic has no chapter sources in Open Notebook yet.';
    } catch (error) {
      if (isAbortError(error) || current.signal.aborted) return;
      createMessage.textContent = error.message;
    }
    applyAvailability();
  }

  render.addEventListener('click', async () => {
    if (render.disabled) return;
    const input = {
      topic_slug: topicSelect.value, source_id: sourceSelect.value,
      episode_profile: profileSelect.value, speaker_profile: speakerSelect.value,
    };
    creating = true;
    applyAvailability();
    createMessage.textContent = 'Checking the source, models, voices and context…';
    const path = '/api/podcast/renders';
    // One id per intent, reused until the request succeeds (rule 9).
    const key = `chapter:${input.topic_slug}:${input.source_id}:${input.episode_profile}:${input.speaker_profile}`;
    try {
      await withMutationId(key, (mutationId) => request(path, { method: 'POST', body: { ...input, mutation_id: mutationId } }), { payload: { path, body: input } });
      createMessage.textContent = '';
      if (!scope.signal.aborted) reload();
    } catch (error) {
      createMessage.textContent = error.message;
    }
    creating = false;
    applyAvailability();
  });

  /**
   * Read a row's transcript once, while its disclosure is open. A stage change drops the
   * copy (updateRow), because one read mid-render is incomplete (Codex run 1).
   */
  async function loadTranscript(entry, r) {
    if (entry.transcriptLoaded) return;
    entry.transcriptLoaded = true;
    // Only the latest read may paint: an older one can resolve after it (Codex run 2).
    const generation = entry.transcriptGeneration = (entry.transcriptGeneration ?? 0) + 1;
    try {
      const data = await request(`/api/podcast/renders/${r.id}?topic=${encodeURIComponent(r.topic_slug)}`, { signal: scope.signal });
      if (scope.signal.aborted || generation !== entry.transcriptGeneration) return;
      // Model output: every line is a text node, never parsed as HTML (rule 12).
      const body = el('div', { class: 'chapter-transcript' },
        el('p', { class: 'q-hint' }, 'The plan records what each section covers. Check the explanations while you listen.'));
      for (const section of data.rendition?.plan?.segments ?? []) body.append(el('p', {}, `${section.id} · ${section.anchor}`));
      for (const left of data.rendition?.plan?.excluded ?? []) body.append(el('p', { class: 'q-hint' }, `Omitted: ${left.reason}.`));
      for (const turn of data.transcript ?? []) body.append(el('p', {}, `${turn.speaker}: ${turn.dialogue}`));
      entry.transcriptBody?.remove();
      entry.transcriptBody = body;
      entry.details.append(body);
    } catch (error) {
      if (generation !== entry.transcriptGeneration) return;
      entry.transcriptLoaded = false;
      if (!isAbortError(error) && !scope.signal.aborted) entry.message.textContent = error.message;
    }
  }

  function buildRow(r) {
    const status = el('p', { class: 'chapter-status', tabindex: '-1' });
    const notes = el('p', { class: 'q-hint' });
    const player = el('div');
    const actions = el('div', { class: 'podcast-actions' });
    // An action's error, kept apart from `notes` so the next poll does not erase it.
    const message = el('p', { class: 'q-hint chapter-message' });
    const node = el('article', { class: 'chapter-row', 'data-id': r.id },
      el('div', { class: 'chapter-title' }, titleOf(r)), status, notes, player, actions, message);
    const entry = { node, status, notes, player, actions, message, key: null, audio: null, details: null };
    if ((r.stage ?? r.status) !== 'needs_repair') {
      entry.details = el('details', {}, el('summary', {}, 'Transcript and coverage plan'));
      node.append(entry.details);
      entry.details.addEventListener('toggle', () => { if (entry.details.open) loadTranscript(entry, r); });
    }
    return entry;
  }

  function updateRow(entry, r) {
    const label = stageLabel(r);
    entry.status.textContent = r.progress && !r.interrupted ? `${label} · ${r.progress}` : label;
    entry.notes.textContent = `${r.preferred ? 'Preferred. ' : ''}${notesFor(r)}`;
    // One player per rendition, kept across polls so listening is never cut off (A2).
    if (r.audio_available && !entry.audio) {
      const audio = el('audio', { controls: '', preload: 'none', src: r.audio_url, 'aria-label': `Recording of ${titleOf(r)}` });
      entry.audio = audio;
      // Released with the section, as the view's other players are: pause, drop the source,
      // and load() so the browser lets go of the media resource.
      const release = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); };
      const forget = scope.own(release);
      entry.releaseAudio = () => { forget(); release(); };
      entry.player.append(audio);
    }
    const key = stageKey(r);
    if (entry.key !== key) {
      if (entry.key !== null) {
        announce(`${titleOf(r)}: ${label}`);
        if (entry.details) {
          entry.transcriptLoaded = false;
          if (entry.details.open) loadTranscript(entry, r);
        }
      }
      // Rebuilt only on a stage change, so a poll never resets a ticked checkbox.
      buildActions(entry, r);
    }
    entry.key = key;
  }

  /**
   * POST an action, then re-read the list and move focus to the row's status line (A5).
   * The POST carries no view signal: leaving the view must not cancel a write already sent.
   */
  async function act(entry, r, action, extra = {}) {
    entry.message.textContent = '';
    let done = true;
    try {
      await request(`/api/podcast/renders/${r.id}/${action}`, { method: 'POST', body: { topic_slug: r.topic_slug, ...extra } });
    } catch (error) {
      entry.message.textContent = error.message;
      done = false;
    }
    if (scope.signal.aborted) return done;
    await reload();
    entry.status.focus();
    return done;
  }

  function buildActions(entry, r) {
    clear(entry.actions);
    entry.resume = null;
    const stage = r.stage ?? r.status;
    if (stage === 'qc_passed' && !r.interrupted) {
      const box = el('input', { type: 'checkbox' });
      const publish = el('button', { class: 'btn small', type: 'button' }, 'Publish recording');
      publish.disabled = true;
      box.addEventListener('change', () => { publish.disabled = !box.checked; });
      publish.addEventListener('click', () => {
        if (!box.checked || publish.disabled) return;
        publish.disabled = true;
        // A refusal leaves the stage as it was, so the actions are not rebuilt: re-enable here.
        act(entry, r, 'publish', { full_listen_confirmed: true }).then((done) => { if (!done) publish.disabled = !box.checked; });
      });
      entry.actions.append(labelled('I listened to the full recording and checked its explanations and coverage', box), publish);
    }
    if (r.interrupted || stage === 'failed') {
      const resume = el('button', { class: 'btn small', type: 'button' }, 'Resume render');
      resume.addEventListener('click', () => {
        if (resume.disabled) return;
        entry.resumeBusy = true;
        resume.disabled = true;
        act(entry, r, 'resume').then(() => { entry.resumeBusy = false; applyAvailability(); });
      });
      entry.resume = resume;
      entry.actions.append(resume);
    }
  }

  function paint(renditions) {
    const seen = new Set(renditions.map((r) => r.id));
    for (const [id, entry] of rows) if (!seen.has(id)) { entry.releaseAudio?.(); entry.node.remove(); rows.delete(id); }
    renditions.forEach((r, index) => {
      if (!rows.has(r.id)) rows.set(r.id, buildRow(r));
      const entry = rows.get(r.id);
      updateRow(entry, r);
      // Moving an attached row detaches it, and the browser drops focus from inside it, so a
      // row already in its place is left alone (A2, Codex run 1).
      const at = listBody.children[index];
      if (at !== entry.node) listBody.insertBefore(entry.node, at ?? null);
    });
    listMessage.textContent = renditions.length ? '' : 'No checked chapters for this topic yet. Choose a chapter above and render it.';    applyAvailability();
  }

  scope.own(() => listScope?.dispose());

  async function reload() {
    listScope?.dispose();
    const current = listScope = createViewScope();
    try {
      const data = await request(`/api/podcast/renders?topic=${encodeURIComponent(topicSelect.value)}`, { signal: current.signal });
      if (current.signal.aborted) return;
      const renditions = data.renditions ?? [];
      paint(renditions);
      lastActive = renditions.some(isActive);
    } catch (error) {
      if (isAbortError(error) || current.signal.aborted) return;
      listMessage.textContent = error.message;
      // lastActive keeps the previous answer: one failed read must not stop progress.
    }
    // The poll belongs to this request's scope: the next reload, a topic change or leaving
    // the view disposes it, so there is only ever one loop. The delay rejects only on abort.
    if (lastActive) delay(POLL_MS, current.signal).then(reload, () => {});
  }

  topicSelect.addEventListener('change', () => {
    for (const entry of rows.values()) { entry.releaseAudio?.(); entry.node.remove(); }
    rows.clear();
    lastActive = false;
    listMessage.textContent = 'Loading checked chapters…';
    reload();
    loadSources();
  });

  reload();
  return {
    element,
    reload,
    /**
     * The Podcast view reports its own Open Notebook load: the profiles it found, or that it
     * failed. Profiles come from there rather than a second request.
     */
    setOpenNotebook(available, { profiles = [], speakerProfiles = [], reason = null } = {}) {
      openNotebook = available;
      outage.textContent = available ? '' : `${OUTAGE}${reason ? ` (${reason})` : ''}`;
      if (available) {
        // A profile with no transcript model fails at render time, so it is not offered.
        const ready = profiles.filter((profile) => profile.transcript_model);
        const chosenProfile = profileSelect.value;
        clear(profileSelect);
        for (const profile of ready) profileSelect.append(el('option', { value: profile.name }, profile.name));
        profileSelect.value = ready.some((p) => p.name === chosenProfile) ? chosenProfile : (ready.find((p) => p.name === 'study-chapter') ?? ready[0])?.name ?? '';
        const chosenSpeaker = speakerSelect.value;
        clear(speakerSelect);
        for (const speaker of speakerProfiles) speakerSelect.append(el('option', { value: speaker.name }, speaker.name));
        const syncSpeaker = () => { speakerSelect.value = ready.find((p) => p.name === profileSelect.value)?.speaker_config ?? speakerProfiles[0]?.name ?? ''; };
        // A refresh keeps speakers the learner chose; picking another profile resets them.
        if (speakerProfiles.some((speaker) => speaker.name === chosenSpeaker)) speakerSelect.value = chosenSpeaker;
        else syncSpeaker();
        profileSelect.onchange = syncSpeaker;
        loadSources();
      }
      applyAvailability();
    },
    dispose() { scope.dispose(); },
  };
}
