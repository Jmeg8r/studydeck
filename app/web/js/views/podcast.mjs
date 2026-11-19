// WHAT: Podcast — generate an episode with per-speaker voice choice, and play what
//       has already rendered.
// WHY: Open Notebook binds voices to a *speaker profile*, and its generate call takes
//      that profile by name. So "pick a voice" cannot be a passthrough parameter: if the
//      chosen voices differ from the base profile, this view creates a new named profile
//      and generates against that. Existing profiles are never mutated — a silent
//      rewrite would change the voices of every future episode using them.
import { clear, el } from '../dom.mjs';
import { requestJson } from '../api.mjs';
import { abortableDelay, createViewScope, isAbortError } from '../lifecycle.mjs';
import { withMutationId } from '../mutation.mjs';
import { createChapterSection } from './chapterpodcast.mjs';

/** English first: the study content is English, so those voices lead the list. */
const LANG_ORDER = ['en-us', 'en-gb'];

const POLL_MS = 3_000;
/**
 * Rendering a full episode is slow (LLM outline, then transcript, then TTS). Cap the
 * wait anyway — but generously: a 31B model doing outline + multi-speaker transcript on
 * local hardware ran past 30 minutes without finishing, so the first guess of 20 was
 * simply wrong. Hitting this ceiling stops the polling, not the render.
 */
const POLL_CEILING_MS = 60 * 60 * 1_000;
const episodeView = { notebook: '', sort: 'completed-desc' };
/** localStorage prefix for a player's position: `<prefix>.<episode id>.<ETag>`. */
const POSITION_KEY = 'studydeck.audio';
const SAVE_EVERY_S = 10;
/** Within this many seconds of either end, start from the top rather than resume. */
const RESUME_TAIL_S = 2;
const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The blocker, stated exactly — including where to fix it. */
function ttsBlockedCard(status) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'cap' }, 'Audio not available yet'));
  card.append(el('p', { class: 'q-hint' },
    `Open Notebook has no “${status.tts_model_type}” model registered, so episodes cannot be ` +
    'rendered to audio. The profiles below are real and ready — only the voice is missing.'));
  card.append(el('p', { class: 'q-hint' },
    'Fix: Open Notebook → Settings → Providers, add a TTS provider key (ElevenLabs or ' +
    'similar), then register a text-to-speech model. This view will pick it up on reload.'));
  return card;
}

/** One <select> of every voice, grouped by language so 54 options stay navigable. */
function voiceSelect(speakerName, voices, selectedId) {
  const select = el('select', { class: 'q-input gen-control', 'data-speaker': speakerName });
  const byLang = new Map();
  for (const voice of voices) {
    if (!byLang.has(voice.language)) byLang.set(voice.language, []);
    byLang.get(voice.language).push(voice);
  }

  const langs = [...byLang.keys()].sort((a, b) => {
    const ia = LANG_ORDER.indexOf(a);
    const ib = LANG_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  let matched = false;
  for (const lang of langs) {
    const group = el('optgroup', { label: lang });
    for (const voice of byLang.get(lang)) {
      const isSel = voice.id === selectedId;
      if (isSel) matched = true;
      group.append(el('option', { value: voice.id, selected: isSel ? '' : null },
        `${voice.id} · ${voice.gender}`));
    }
    select.append(group);
  }

  // A profile can reference a voice this backend doesn't have (e.g. an ElevenLabs id
  // left over from another provider). Surface it as a selectable-but-flagged option
  // rather than silently snapping to the first voice in the list.
  if (!matched && selectedId) {
    const orphan = el('optgroup', { label: 'not available in this model' });
    orphan.append(el('option', { value: selectedId, selected: '' }, `${selectedId} · unknown`));
    select.prepend(orphan);
  }
  return select;
}

function labelledRow(labelText, control, hint) {
  const row = el('div', { class: 'qrow gen-row' });
  const label = el('span', {}, labelText);
  if (hint) label.append(el('span', { class: 'who' }, ` · ${hint}`));
  row.append(label, control);
  return row;
}

/**
 * The generate form. Rebuilds its voice rows whenever the speaker profile changes,
 * because the speakers themselves change with it.
 */
function generateCard(status, speakerProfiles, voiceData, reload, signal, busy) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Generate episode'));

  if (speakerProfiles.length === 0 || status.profiles.length === 0) {
    card.append(el('p', { class: 'q-hint' },
      'Needs at least one episode profile and one speaker profile in Open Notebook.'));
    return card;
  }

  const voices = voiceData?.voices ?? [];
  if (voices.length === 0) {
    card.append(el('p', { class: 'q-hint' },
      `Voice list unavailable${voiceData?.error ? ` — ${voiceData.error}` : ''}. ` +
      'Each profile\'s existing voices will be used as-is.'));
  }

  const episodeSelect = el('select', { class: 'q-input gen-control' });
  for (const profile of status.profiles) {
    episodeSelect.append(el('option', { value: profile.name }, profile.name));
  }

  const speakerSelect = el('select', { class: 'q-input gen-control' });
  for (const profile of speakerProfiles) {
    speakerSelect.append(el('option', { value: profile.name },
      `${profile.name} (${profile.speakers.length})`));
  }

  const nameInput = el('input', { class: 'q-input', type: 'text', placeholder: 'Episode name' });

  const notebookSelect = el('select', { class: 'q-input gen-control' });
  notebookSelect.append(el('option', { value: '', selected: '' }, 'Select a StudyDeck topic'));
  for (const nb of status.notebooks ?? []) {
    notebookSelect.append(el('option', { value: nb.notebook_id }, nb.slug));
  }

  const saveAsInput = el('input', { class: 'q-input', type: 'text', placeholder: 'New profile name' });
  const saveAsRow = labelledRow('Save voices as', saveAsInput, 'required — voices changed');
  saveAsRow.style.display = 'none';

  const voicesHost = el('div', {});
  const message = el('p', { class: 'q-hint' }, '');
  const errorLine = el('p', { class: 'q-error' }, '');
  const button = el('button', { class: 'btn primary' }, 'Generate');

  const baseProfile = () => speakerProfiles.find((p) => p.name === speakerSelect.value);

  /** True when any dropdown differs from the base profile — the trigger for a new profile. */
  function voicesChanged() {
    const base = baseProfile();
    if (!base) return false;
    return base.speakers.some((s, i) => {
      const control = voicesHost.querySelectorAll('select')[i];
      return control && control.value !== s.voice_id;
    });
  }

  function syncSaveAsVisibility() {
    saveAsRow.style.display = voicesChanged() ? '' : 'none';
  }

  function renderVoiceRows() {
    clear(voicesHost);
    const base = baseProfile();
    if (!base) return;
    for (const speaker of base.speakers) {
      const control = voices.length > 0
        ? voiceSelect(speaker.name, voices, speaker.voice_id)
        : el('span', { class: 'who' }, speaker.voice_id ?? 'unset');
      if (control.tagName === 'SELECT') control.addEventListener('change', syncSaveAsVisibility);
      voicesHost.append(labelledRow(speaker.name, control));
    }
    syncSaveAsVisibility();
  }

  speakerSelect.addEventListener('change', renderVoiceRows);
  renderVoiceRows();

  card.append(
    labelledRow('Episode profile', episodeSelect),
    labelledRow('Speaker profile', speakerSelect, 'supplies the speakers'),
    voicesHost,
    saveAsRow,
    labelledRow('Notebook', notebookSelect, 'source material'),
    labelledRow('Episode name', nameInput),
    el('div', { class: 'q-actions' }, button),
    message,
    errorLine,
  );

  /** Poll one job to a terminal state, narrating progress. */
  async function followJob(jobId) {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - startedAt > POLL_CEILING_MS) {
        // Derived, not written twice: a hardcoded duration here goes stale the moment
        // the ceiling moves, which is exactly how this line came to claim 20 minutes.
        const mins = Math.round(POLL_CEILING_MS / 60_000);
        message.textContent =
          `Still running after ${mins} minutes — job ${jobId}. The render continues in ` +
          'Open Notebook; reload this page later to pick it up.';
        return false;
      }
      await abortableDelay(POLL_MS, signal);
      let job;
      try {
        job = await requestJson(`/api/on/podcast/jobs/${encodeURIComponent(jobId)}`, { signal });
      } catch (err) {
        if (isAbortError(err)) return false;
        // A transient poll failure shouldn't kill a render that's still going.
        message.textContent = `Polling hiccup (${err.message}) — retrying…`;
        continue;
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      message.textContent = `${job.status}${job.progress ? ` · ${job.progress}` : ''} · ${elapsed}s`;
      if (!job.terminal) continue;
      if (!job.successful) {
        errorLine.textContent = `Render failed: ${job.error}`;
        return false;
      }
      message.textContent = `Finished in ${elapsed}s.`;
      return true;
    }
  }

  button.addEventListener('click', async () => {
    errorLine.textContent = '';
    message.textContent = '';
    const base = baseProfile();
    const episodeName = nameInput.value.trim();
    if (!episodeName) {
      errorLine.textContent = 'Episode name is required.';
      return;
    }
    if (!notebookSelect.value) {
      errorLine.textContent = 'Select a mapped StudyDeck topic for this render.';
      return;
    }

    let speakerProfileName = base.name;
    button.disabled = true;
    busy.start();
    try {
      if (voicesChanged()) {
        const newName = saveAsInput.value.trim();
        if (!newName) {
          errorLine.textContent = 'Voices changed — give the new speaker profile a name.';
          return;
        }
        const controls = voicesHost.querySelectorAll('select');
        message.textContent = `Creating speaker profile “${newName}”…`;
        await requestJson('/api/on/speaker-profiles', { method: 'POST', body: {
          name: newName,
          description: `Derived from ${base.name} with custom voices.`,
          speakers: base.speakers.map((s, i) => ({
            name: s.name,
            voice_id: controls[i].value,
            backstory: s.backstory,
            personality: s.personality,
          })),
        }});
        speakerProfileName = newName;
      }

      message.textContent = 'Queuing render…';
      const key = `podcast:${notebookSelect.value}:${episodeSelect.value}:${speakerProfileName}:${episodeName}`;
      const request = {
        episode_profile: episodeSelect.value,
        speaker_profile: speakerProfileName,
        episode_name: episodeName,
        notebook_id: notebookSelect.value,
      };
      const job = await withMutationId(key, (mutationId) => requestJson('/api/on/podcast/generate', { method: 'POST', body: {
        ...request, mutation_id: mutationId,
      }}), { payload: request });
      if (!job.job_id) {
        errorLine.textContent = 'Open Notebook accepted the request but returned no job id.';
        return;
      }
      message.textContent = `Queued as ${job.job_id}. This takes a few minutes.`;
      const ok = await followJob(job.job_id);
      if (ok) reload();
    } catch (err) {
      if (isAbortError(err)) return;
      errorLine.textContent = err.message;
    } finally {
      button.disabled = false;
      busy.end();
    }
  });

  return card;
}

/**
 * Poll one job to a terminal state, writing each update into `statusEl`. Resolves to
 * true on success, false on failure/timeout — the caller tallies the batch outcome.
 * A standalone helper (not generateCard's followJob) because many run at once here.
 */
async function pollJobInto(jobId, statusEl, signal) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > POLL_CEILING_MS) {
      statusEl.textContent = `still running after ${Math.round(POLL_CEILING_MS / 60_000)}m — reload later`;
      return false;
    }
    await abortableDelay(POLL_MS, signal);
    let job;
    try {
      job = await requestJson(`/api/on/podcast/jobs/${encodeURIComponent(jobId)}`, { signal });
    } catch (err) {
      if (isAbortError(err)) return false;
      statusEl.textContent = 'polling…';
      continue;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (!job.terminal) {
      statusEl.textContent = `${job.status} · ${elapsed}s`;
      continue;
    }
    if (!job.successful) {
      statusEl.textContent = `failed: ${job.error}`;
      return false;
    }
    statusEl.textContent = `done · ${elapsed}s`;
    return true;
  }
}

/**
 * Per-chapter batch: one episode per source in the topic's notebook, each scoped to that
 * source's own text. The server fires the first chapter as a canary and commits the rest
 * only after the worker's log proves it was picked up (result.preflight carries the
 * verdict); every job is then tracked in a live grid.
 */
function batchCard(status, speakerProfiles, reload, signal, busy) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, 'Generate per-chapter batch'));

  const notebooks = status.notebooks ?? [];
  if (notebooks.length === 0 || speakerProfiles.length === 0 || status.profiles.length === 0) {
    card.append(el('p', { class: 'q-hint' },
      'Needs a topic with a mapped notebook, plus an episode profile and a speaker profile.'));
    return card;
  }

  card.append(el('p', { class: 'q-hint' },
    'One episode per source in the notebook, each scoped to that source alone — built for ' +
    'whole-book coverage. Uses the speaker profile’s voices as-is. The renders run one at a ' +
    'time in Open Notebook, so a full book takes a while.'));

  const episodeSelect = el('select', { class: 'q-input gen-control' });
  for (const profile of status.profiles) {
    // study-chapter is the profile built for this — default to it when present.
    const isDefault = profile.name === 'study-chapter';
    episodeSelect.append(el('option', { value: profile.name, selected: isDefault ? '' : null }, profile.name));
  }

  const speakerSelect = el('select', { class: 'q-input gen-control' });
  for (const profile of speakerProfiles) {
    speakerSelect.append(el('option', { value: profile.name }, `${profile.name} (${profile.speakers.length})`));
  }

  const topicSelect = el('select', { class: 'q-input gen-control' });
  for (const nb of notebooks) {
    topicSelect.append(el('option', { value: nb.slug }, nb.slug));
  }

  const grid = el('div', { style: 'margin-top:12px' });
  const message = el('p', { class: 'q-hint' }, '');
  const errorLine = el('p', { class: 'q-error' }, '');
  const genButton = el('button', { class: 'btn primary' }, 'Generate all chapters');
  const retryButton = el('button', { class: 'btn' }, 'Retry failed / missing');

  // Preview is a MODE rather than a third and fourth button, because the thing worth
  // previewing is "what would this exact button do" — and a Preview-generate plus a
  // Preview-retry alongside the originals is four controls doing two things.
  //
  // A mode you can forget you are in is the obvious hazard, and the dangerous direction is
  // only one way round: believing you generated when you previewed is recoverable (click
  // again), believing you previewed when you generated is a half-hour render and, on the
  // retry path, deleted episodes. So the labels change with the checkbox — the buttons say
  // what they will do, and the result panel says PREVIEW again on the way back.
  const dryRun = el('input', { type: 'checkbox', id: 'batch-dry-run' });
  const dryRunLabel = el('label', { class: 'q-hint', for: 'batch-dry-run' },
    ' Preview only — show what would happen, send nothing');

  const syncLabels = () => {
    genButton.textContent = dryRun.checked ? 'Preview: generate all chapters' : 'Generate all chapters';
    retryButton.textContent = dryRun.checked ? 'Preview: retry failed / missing' : 'Retry failed / missing';
    genButton.classList.toggle('primary', !dryRun.checked);
  };
  dryRun.addEventListener('change', syncLabels);
  syncLabels();

  card.append(
    labelledRow('Episode profile', episodeSelect),
    labelledRow('Speaker profile', speakerSelect, 'supplies the speakers'),
    labelledRow('Topic', topicSelect, 'every source becomes an episode'),
    el('div', { class: 'q-actions' }, dryRun, dryRunLabel),
    el('div', { class: 'q-actions' }, genButton, retryButton),
    message,
    errorLine,
    grid,
  );

  /**
   * Render a dry-run report.
   *
   * Deliberately leads with the DESTRUCTIVE half. `would_delete_episodes` is the reason a
   * preview exists at all — generating something unwanted costs render time, but deleting
   * an episode you meant to keep is not undoable, and the point of a preview is to be able
   * to disagree with that list before it happens.
   */
  function renderPreview(result) {
    const parts = [`Would generate ${result.would_generate} chapter${result.would_generate === 1 ? '' : 's'}`];
    if (result.skipped) parts.push(`skip ${result.skipped} already done`);
    if (result.legacy_skips?.length) parts.push(`${result.legacy_skips.length} untagged legacy episode(s) left alone`);
    message.textContent = `PREVIEW — nothing was sent. ${parts.join(', ')}.`;

    if (result.would_delete > 0) {
      grid.append(el('div', { class: 'cap' },
        `Would DELETE ${result.would_delete} episode${result.would_delete === 1 ? '' : 's'} first — this is the irreversible half`));
      for (const ep of result.would_delete_episodes) {
        grid.append(el('div', { class: 'qrow' },
          el('span', {}, ep.name),
          el('span', { class: 'pill owed' }, ep.status ?? 'no status')));
      }
    }

    if (result.targets?.length) {
      grid.append(el('div', { class: 'cap' }, 'Would generate'));
      for (const t of result.targets) {
        grid.append(el('div', { class: 'qrow' },
          el('span', {}, t.title),
          el('span', { class: 'pill' }, 'would queue')));
      }
    }

    if (result.would_generate === 0 && result.would_delete === 0) {
      grid.append(el('div', { class: 'qrow' },
        el('span', { class: 'empty' }, 'Nothing to do — every chapter this run would touch already has audio.')));
    }
  }

  /**
   * Shared runner for both buttons. `extra` carries retry_only for the retry path;
   * `busyText` narrates while the request is in flight. The transcript model is
   * non-deterministic, so a chapter can fail on one run and render on the next — that's
   * what the retry button is for: it regenerates only the chapters still missing audio.
   */
  async function run(extra, busyText) {
    errorLine.textContent = '';
    message.textContent = '';
    clear(grid);
    genButton.disabled = true;
    retryButton.disabled = true;
    // Locked for the duration, not cosmetics. Toggling mid-flight repaints the labels while
    // the in-flight request still carries the old mode — and the dangerous direction is the
    // one that reads "Preview:" over a real generate that is already deleting and queueing.
    dryRun.disabled = true;
    busy.start();
    try {
      message.textContent = busyText;
      const payload = {
        topic_slug: topicSelect.value,
        episode_profile: episodeSelect.value,
        speaker_profile: speakerSelect.value,
        ...(dryRun.checked ? { dry_run: true } : {}),
        ...extra,
      };
      const key = `podcast-batch:${payload.topic_slug}:${payload.episode_profile}:${payload.speaker_profile}:${Boolean(payload.retry_only)}`;
      const result = payload.dry_run
        ? await requestJson('/api/on/podcast/generate-batch', { method: 'POST', body: payload })
        : await withMutationId(key, (mutationId) => requestJson('/api/on/podcast/generate-batch', { method: 'POST', body: {
          ...payload, mutation_id: mutationId,
        }}), { payload });

      // Checked BEFORE the empty-episodes branch below: a dry run carries no `episodes` at
      // all, so falling through would report a preview as "nothing to do" or iterate
      // undefined. Trusting the server's own flag rather than the checkbox — if they ever
      // disagree, the response is the one that describes what actually happened.
      if (result.dry_run) {
        renderPreview(result);
        return;
      }

      // Retry with everything already rendered: nothing queued, just say so.
      if ((!result.episodes || result.episodes.length === 0) && result.message) {
        message.textContent = result.message;
        return;
      }

      // A stale worker came back as a 503 and threw above. 'unavailable' means the
      // pre-flight could not read the worker log at all — the batch was still fired,
      // but nothing was proven, so say what to watch for.
      const preflight = result.preflight ?? {};
      if (preflight.status === 'unavailable') {
        errorLine.textContent =
          `Worker pre-flight inconclusive (${preflight.detail ?? 'log unreadable'}) — chapters were ` +
          'queued anyway. If the first one sits at “running” with no progress, restart Open Notebook.';
      }

      const polls = [];
      for (const ep of result.episodes) {
        const st = el('span', { class: 'pill' }, ep.job_id ? 'queued' : `error: ${ep.error ?? 'not started'}`);
        const row = el('div', { class: 'qrow' }, el('span', {}, ep.title), st);
        grid.append(row);
        if (ep.job_id) polls.push(pollJobInto(ep.job_id, st, signal));
      }

      const queued = polls.length;
      const skipped = result.skipped ?? 0;
      const confirmed = preflight.status === 'seen'
        ? `Worker pickup confirmed in ${(preflight.waited_ms / 1000).toFixed(1)}s. `
        : '';
      message.textContent =
        `${confirmed}Queued ${queued} chapter${queued === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already done` : ''}. ` +
        'They render one at a time — you can leave this page and come back.';

      if (queued > 0) {
        const outcomes = await Promise.all(polls);
        const ok = outcomes.filter(Boolean).length;
        message.textContent = `Finished: ${ok}/${queued} chapter${queued === 1 ? '' : 's'} rendered. Reloading episodes…`;
        reload();
      }
    } catch (err) {
      if (isAbortError(err)) return;
      errorLine.textContent = err.message;
    } finally {
      genButton.disabled = false;
      retryButton.disabled = false;
      dryRun.disabled = false;
      busy.end();
    }
  }

  genButton.addEventListener('click', () => run(
    {},
    dryRun.checked
      ? 'Working out what a full batch would do — sending nothing…'
      : 'Queuing chapter renders — confirming the worker picks the first one up…',
  ));
  retryButton.addEventListener('click', () => run(
    { retry_only: true },
    dryRun.checked
      ? 'Working out what a retry would generate and delete — sending nothing…'
      : 'Finding chapters that still need audio and confirming the worker is alive…',
  ));

  return card;
}

function profilesCard(status) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Episode profiles · ${status.profiles.length}`));

  // The two the study flow depends on, called out from the stock ones.
  const studyProfiles = new Set(['study-overview', 'study-deep-dive']);

  for (const profile of status.profiles) {
    const row = el('div', { class: 'qrow' });
    const label = el('span', {}, profile.name);
    const bits = [
      profile.segments ? `${profile.segments} segments` : null,
      profile.speaker_config ? 'speakers set' : 'no speakers',
      // Migration 22 wiped legacy model strings; a profile missing them would fail
      // at generate time, so say so now rather than at the point of failure.
      profile.transcript_model ? null : 'transcript model unset',
    ].filter(Boolean);
    label.append(el('span', { class: 'who' }, ` · ${bits.join(' · ')}`));

    row.append(label, el('span', { class: `pill${studyProfiles.has(profile.name) ? ' hot' : ''}` },
      studyProfiles.has(profile.name) ? 'study flow' : 'stock'));
    card.append(row);
  }
  return card;
}

function sortEpisodes(episodes, order) {
  return [...episodes].sort((a, b) => {
    const title = titleOrder.compare(a.display_name ?? a.name, b.display_name ?? b.name);
    if (order === 'title-asc') return title || a.id.localeCompare(b.id);
    if (order === 'title-desc') return -title || a.id.localeCompare(b.id);

    const aDate = Date.parse(a.completed_at ?? '');
    const bDate = Date.parse(b.completed_at ?? '');
    const aKnown = Number.isFinite(aDate);
    const bKnown = Number.isFinite(bDate);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && aDate !== bDate) {
      return order === 'completed-asc' ? aDate - bDate : bDate - aDate;
    }
    return title || a.id.localeCompare(b.id);
  });
}

function episodeDate(date) {
  const parsed = new Date(date.replace(' ', 'T'));
  if (!Number.isFinite(parsed.getTime())) return 'date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(parsed);
}

function episodesCard(status, playerFor) {
  const card = el('div', { class: 'card', style: 'margin-top:18px' });
  card.append(el('div', { class: 'cap' }, `Rendered episodes · ${status.episodes.length}`));

  if (status.episodes.length === 0) {
    card.append(el('p', { class: 'q-hint' },
      'None yet. Generate one above, or run a profile against a notebook in Open Notebook.'));
    return card;
  }

  const notebooks = status.notebooks ?? [];
  if (episodeView.notebook && episodeView.notebook !== 'unassigned'
      && !notebooks.some((notebook) => notebook.notebook_id === episodeView.notebook)) {
    episodeView.notebook = '';
  }
  const notebookNames = new Map(notebooks.map((notebook) => [notebook.notebook_id, notebook.name ?? notebook.slug]));
  const notebookSelect = el('select', { class: 'episode-select', 'aria-label': 'Filter episodes by notebook' });
  notebookSelect.append(el('option', { value: '' }, 'All notebooks'));
  for (const notebook of notebooks) {
    notebookSelect.append(el('option', { value: notebook.notebook_id }, notebook.name ?? notebook.slug));
  }
  if (status.episodes.some((episode) => !episode.notebook_id)) {
    notebookSelect.append(el('option', { value: 'unassigned' }, 'Unassigned'));
  }
  notebookSelect.value = episodeView.notebook;

  const sortSelect = el('select', { class: 'episode-select', 'aria-label': 'Sort episodes' });
  for (const [value, label] of [
    ['completed-desc', 'Completed: newest first'],
    ['completed-asc', 'Completed: oldest first'],
    ['title-asc', 'Title: A to Z'],
    ['title-desc', 'Title: Z to A'],
  ]) sortSelect.append(el('option', { value }, label));
  sortSelect.value = episodeView.sort;

  const controls = el('div', { class: 'episode-controls' },
    el('label', { class: 'episode-control' }, 'Notebook', notebookSelect),
    el('label', { class: 'episode-control' }, 'Sort by', sortSelect));
  const matchingNote = status.notebook_matching_incomplete
    ? el('p', { class: 'q-hint' }, 'Some notebook sources are unavailable. Episodes without a clear match appear under Unassigned.')
    : null;
  const count = el('p', { class: 'episode-count', 'aria-live': 'polite' });
  const list = el('div', { class: 'episode-list' });
  const empty = el('p', { class: 'q-hint episode-empty', hidden: '' }, 'No episodes match this notebook.');
  const items = new Map();

  for (const episode of status.episodes) {
    const item = el('div', { class: 'episode-item', 'data-episode-id': episode.id });
    const row = el('div', { class: 'qrow' });
    // display_name drops the ` · sd-…` identity tag (F10). The tag makes an episode
    // attributable to one topic and source; it is not something to read a chapter list by.
    const notebookName = notebookNames.get(episode.notebook_id) ?? 'Unassigned';
    const date = episode.completed_at
      ? `Completed ${episodeDate(episode.completed_at)}`
      : episode.created ? `Added ${episodeDate(episode.created)}` : 'Date unavailable';
    row.append(
      el('span', { class: 'episode-details' },
        el('span', { class: 'episode-title' }, episode.display_name ?? episode.name),
        el('span', { class: 'episode-meta' }, `${notebookName} · ${date}`)),
      el('span', { class: 'pill' }, episode.status ?? 'unknown'),
    );
    item.append(row);

    if (episode.audio_available) item.append(playerFor(episode));
    items.set(episode.id, item);
    list.append(item);
  }

  let currentSort = null;
  const update = () => {
    episodeView.notebook = notebookSelect.value;
    episodeView.sort = sortSelect.value;
    const ordered = sortEpisodes(status.episodes, episodeView.sort);
    if (currentSort !== episodeView.sort) {
      for (const episode of ordered) list.append(items.get(episode.id));
      currentSort = episodeView.sort;
    }
    let visible = 0;
    for (const episode of ordered) {
      const item = items.get(episode.id);
      const show = !episodeView.notebook || (episodeView.notebook === 'unassigned'
        ? !episode.notebook_id : episode.notebook_id === episodeView.notebook);
      item.hidden = !show;
      if (!show) item.querySelector('audio')?.pause();
      if (show) visible += 1;
    }
    count.textContent = `${visible} of ${status.episodes.length} episodes shown`;
    count.hidden = visible === 0 || visible === status.episodes.length;
    empty.hidden = visible !== 0;
  };
  notebookSelect.addEventListener('change', update);
  sortSelect.addEventListener('change', update);
  card.append(controls, matchingNote, count, list, empty);
  update();
  return card;
}

/**
 * One player per episode for the life of the view. A refresh rebuilds the episode list
 * around the SAME element, so playback and position survive it; leaving the view
 * releases the media resource, which closes the stream proxied from Open Notebook.
 */
function episodePlayer(episode, scope) {
  const src = `/api/on/episodes/${encodeURIComponent(episode.id)}/audio`;
  const audio = el('audio', { controls: '', preload: 'none', class: 'episode-audio', src });

  // A position is only meaningful for the exact audio it was heard in: a re-rendered
  // episode keeps its id and gets new audio. So the key carries the ETag, read with one
  // HEAD on first play rather than one per episode on every visit. No ETag, no memory.
  let key = null;
  let versionAsked = false;
  let lastSaved = 0;
  let sought = false;
  // A restore waiting for metadata is still owed: saving now would write the pre-restore
  // position (usually 0) over the one it is about to restore.
  let restoreOwed = false;
  const save = () => {
    if (!key || restoreOwed || !Number.isFinite(audio.currentTime)) return;
    try {
      localStorage.setItem(key, String(audio.ended ? 0 : audio.currentTime));
      lastSaved = audio.currentTime;
    } catch { /* storage disabled or full: the player still works, it just forgets */ }
  };
  const restore = () => {
    let saved = 0;
    try { saved = Number(localStorage.getItem(key)); } catch { return; }
    if (!(saved > 0)) return;
    const seek = () => { if (saved < audio.duration - RESUME_TAIL_S) audio.currentTime = saved; };
    if (Number.isFinite(audio.duration)) return seek();
    restoreOwed = true;
    audio.addEventListener('loadedmetadata', () => {
      if (!restoreOwed) return;
      restoreOwed = false;
      seek();
    }, { once: true, signal: scope.signal });
  };
  audio.addEventListener('play', () => {
    if (versionAsked) return;
    versionAsked = true;
    // Decided from where playback STARTED: it runs on while the HEAD is in flight, so the
    // position when it answers says nothing about intent. A seek in between does.
    const fromTop = audio.currentTime < RESUME_TAIL_S;
    // The learner's own seek supersedes a restore, whether still waiting on the version
    // or on metadata. (Its own seek fires this too, after restoreOwed is already clear.)
    audio.addEventListener('seeking', () => { sought = true; restoreOwed = false; }, { once: true, signal: scope.signal });
    // no-store: a cacheable HEAD waits on the cache entry the starting stream holds.
    fetch(src, { method: 'HEAD', cache: 'no-store', signal: scope.signal })
      .then((res) => {
        const etag = res.ok ? res.headers.get('etag') : null;
        if (!etag || scope.signal.aborted) return;
        key = `${POSITION_KEY}.${episode.id}.${etag}`;
        if (fromTop && !sought) restore();
      })
      .catch((err) => {
        if (!isAbortError(err)) console.warn(`podcast: no position memory for ${episode.id}: ${err.message}`);
      });
  }, { signal: scope.signal });
  audio.addEventListener('pause', save, { signal: scope.signal });
  audio.addEventListener('ended', save, { signal: scope.signal });
  audio.addEventListener('timeupdate', () => {
    if (Math.abs(audio.currentTime - lastSaved) >= SAVE_EVERY_S) save();
  }, { signal: scope.signal });

  const release = () => {
    save();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };
  const forget = scope.own(release);
  return { audio, release: () => { forget(); release(); } };
}

/** A child scope that its parent disposes, and that stops being owned once disposed. */
function childScope(parent) {
  const child = createViewScope();
  child.own(parent.own(() => child.dispose()));
  return child;
}

export function renderPodcast(root, { topics = [], topic = null } = {}) {
  // Every request, poll and player below belongs to this scope, and main.mjs holds the
  // one cleanup that disposes it. A reload never calls renderPodcast again: a nested
  // render's cleanup had nowhere to go, so its polls outlived the view.
  const scope = createViewScope();
  // Open Notebook's cards and the local Checked chapters load separately, so either one
  // failing leaves the other on the page (D5e).
  const onSlot = el('div');
  const chapterSlot = el('div');
  const chapters = topics.length ? createChapterSection({ topics, topic }) : null;
  if (chapters) {
    scope.own(() => chapters.dispose());
    chapterSlot.append(chapters.element);
  }
  const players = new Map();
  let refreshing = null;
  let forms = null;
  let paintedReady = null;
  let painted = false;

  const refresh = el('button', { class: 'btn small', type: 'button' }, 'Refresh podcast status');
  const notice = el('p', { class: 'q-hint', 'aria-live': 'polite' });
  const formsSlot = el('div');
  const profilesSlot = el('div');
  const episodesSlot = el('div');

  const playerFor = (episode) => {
    if (!players.has(episode.id)) players.set(episode.id, episodePlayer(episode, scope));
    return players.get(episode.id).audio;
  };

  // Form operations in flight. Rebuilding a form aborts its job poll, so a refresh that
  // finds one running leaves the forms alone. Nothing re-applies that refresh when the
  // operation ends: doing so would erase the outcome it just showed (a preview's report).
  // A finished render refreshes by itself; otherwise the next refresh picks the lists up.
  const busy = {
    count: 0,
    start() { this.count += 1; },
    end() { this.count -= 1; },
  };

  // Every refresh rebuilds the forms from the new profile, speaker and voice lists, unless
  // one is mid-operation and the TTS gate is unchanged.
  function paint(status, speakerProfiles, voiceData) {
    if (busy.count === 0 || status.tts_ready !== paintedReady) {
      forms?.dispose();
      forms = childScope(scope);
      clear(formsSlot);
      if (!status.tts_ready) formsSlot.append(ttsBlockedCard(status));
      else formsSlot.append(
        generateCard(status, speakerProfiles, voiceData, load, forms.signal, busy),
        batchCard(status, speakerProfiles, load, forms.signal, busy),
      );
      paintedReady = status.tts_ready;
    }
    clear(profilesSlot);
    profilesSlot.append(profilesCard(status));
    clear(episodesSlot);
    episodesSlot.append(episodesCard(status, playerFor));

    const playable = new Set(status.episodes.filter((ep) => ep.audio_available).map((ep) => ep.id));
    for (const [id, player] of players) {
      if (!playable.has(id)) { player.release(); players.delete(id); }
    }
  }

  function showError(err) {
    clear(onSlot);
    const panel = el('div', { class: 'error-panel' });
    panel.append(
      el('h2', {}, 'Open Notebook is not answering'),
      el('p', {}, 'Podcast profiles and episodes live in your local Open Notebook instance.'),
      el('pre', {}, err.message),
    );
    onSlot.append(el('div', { class: 'q-actions' }, refresh), panel);
  }

  function load() {
    if (scope.signal.aborted) return;
    refreshing?.dispose();
    const current = refreshing = childScope(scope);
    const { signal } = current;
    refresh.disabled = true;

    // Voices come from Speaches, a different service than ON — its being down must not
    // take the whole view with it, so that one failure is caught and degraded separately.
    Promise.all([
      requestJson('/api/on/podcast', { signal }),
      requestJson('/api/on/speaker-profiles', { signal }),
      requestJson('/api/tts/voices', { signal }).catch((err) => ({ voices: [], error: err.message })),
    ])
      .then(([status, speakerProfiles, voiceData]) => {
        if (signal.aborted) return;
        if (!painted) {
          clear(onSlot);
          onSlot.append(el('div', { class: 'q-actions' }, refresh), notice, formsSlot, profilesSlot, episodesSlot);
          painted = true;
        }
        notice.textContent = '';
        paint(status, speakerProfiles, voiceData);
        chapters?.setOpenNotebook(true, { profiles: status.profiles ?? [], speakerProfiles });
      })
      .catch((err) => {
        if (isAbortError(err) || signal.aborted) return;
        chapters?.setOpenNotebook(false, { reason: err.message });
        // Once the view has painted, a failed refresh keeps it (and its players) in place.
        if (painted) notice.textContent = `Could not refresh podcast status: ${err.message}`;
        else showError(err);
      })
      .finally(() => { if (!signal.aborted) refresh.disabled = false; });
  }

  refresh.addEventListener('click', () => { load(); chapters?.reload(); });
  clear(root);
  onSlot.append(el('div', { class: 'loading' }, 'Reading podcast state from Open Notebook…'));
  root.append(el('div', { class: 'crumb' }, 'Studydeck / Podcast'), onSlot, chapterSlot);
  load();

  return () => scope.dispose();
}
