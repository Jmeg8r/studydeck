// Local video generation and playback for each notebook.
import { clear, el } from '../dom.mjs';
import { requestJson, requestJsonWithMutation } from '../api.mjs';
import { renderHiggsfield } from './higgsfield.mjs';

let selectedNotebook = '';
let shelfFilter = '';

export function renderVideos(root, { topic } = {}) {
  const controller = new AbortController();
  let player = null;
  let timer = null;
  let submitting = false;
  let initialized = false;
  let sourceCheck = { slug: '', count: null, error: null };

  root.append(el('div', { class: 'crumb' }, 'Studydeck / Videos'));
  const cleanupHiggsfield = renderHiggsfield(root, { topic });
  const maker = el('section', { class: 'card video-maker' });
  maker.append(el('span', { class: 'cap' }, 'Also available · Local render'),
    el('h2', {}, 'Make narrated slides on this Mac'),
    el('p', { class: 'q-hint' },
      'Create a short narrated slide video from notebook sources. The local model writes the script, Kokoro narrates it, and the MP4 stays on this Mac.'));
  const form = el('form', { class: 'video-form' });
  const select = el('select', { class: 'episode-select', 'aria-label': 'Notebook to make a video from' });
  const button = el('button', { class: 'btn', type: 'submit', disabled: '' }, 'Generate local video');
  form.append(el('label', {}, 'Notebook', select), button);
  const progress = el('p', { class: 'video-progress', role: 'status', 'aria-live': 'polite' });
  maker.append(form,
    el('p', { class: 'q-hint' }, 'Uses up to 20 ordered sources, with a short excerpt from each. Rendering can take several minutes.'),
    progress);
  root.append(maker);

  const shelf = el('section', { class: 'card video-shelf' });
  const shelfHeading = el('div', { class: 'video-shelf-heading' });
  const count = el('span', { class: 'cap' }, 'Video shelf');
  const filter = el('select', { class: 'episode-select', 'aria-label': 'Filter videos by notebook' },
    el('option', { value: '' }, 'All videos'), el('option', { value: 'tutorials' }, 'Tutorials'));
  shelfHeading.append(count, filter);
  const rows = el('div');
  shelf.append(shelfHeading, rows);
  root.append(shelf);

  const refresh = async () => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    try {
      const [catalog, videos] = await Promise.all([
        requestJson('/api/videos/jobs', { signal: controller.signal }),
        requestJson('/api/videos', { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const notebooks = catalog.notebooks ?? [];
      const jobs = catalog.jobs ?? [];
      if (!initialized) {
        selectedNotebook = notebooks.some((item) => item.slug === selectedNotebook)
          ? selectedNotebook : (notebooks.some((item) => item.slug === topic?.slug)
            ? topic.slug : notebooks[0]?.slug ?? '');
        for (const item of notebooks) {
          select.append(el('option', { value: item.slug }, item.name));
          filter.append(el('option', { value: item.slug }, item.name));
        }
        select.value = selectedNotebook;
        filter.value = shelfFilter;
        initialized = true;
      }
      const running = jobs.find((job) => job.status === 'running');
      const recent = jobs.find((job) => job.topic_slug === selectedNotebook);
      button.disabled = submitting || Boolean(running) || !selectedNotebook
        || sourceCheck.slug !== selectedNotebook || sourceCheck.count === null || sourceCheck.count === 0;
      if (running) progress.textContent = `${running.topic_name}: ${running.progress}. You can leave this page while it renders.`;
      else if (sourceCheck.slug === selectedNotebook && sourceCheck.error) progress.textContent = sourceCheck.error;
      else if (sourceCheck.slug === selectedNotebook && sourceCheck.count === 0) {
        progress.textContent = 'This notebook has no sources yet. ';
        progress.append(el('a', { href: '#reading' }, 'Add one in Reading Room'));
      }
      else if (sourceCheck.slug === selectedNotebook && sourceCheck.count === null) progress.textContent = 'Checking notebook sources…';
      else if (recent?.status === 'failed') progress.textContent = `${recent.topic_name}: ${recent.error} You can try again.`;
      else if (recent?.status === 'completed') progress.textContent = `${recent.topic_name}: video ready below.`;
      else if (!notebooks.length) progress.textContent = 'Create a notebook and add sources to get started.';
      else progress.textContent = '';

      const byFile = new Map(jobs.filter((job) => job.status === 'completed').map((job) => [job.file, job]));
      const names = new Map(notebooks.map((item) => [item.slug, item.name]));
      const higgsfieldNotebook = (file) => notebooks.find((item) => file.startsWith(`${item.slug}-higgsfield`));
      const visible = videos.filter((video) => {
        const job = byFile.get(video.file);
        const imported = higgsfieldNotebook(video.file);
        if (!shelfFilter) return true;
        return shelfFilter === 'tutorials' ? !job && !imported
          : job?.topic_slug === shelfFilter || imported?.slug === shelfFilter;
      });
      count.textContent = `Video shelf · ${visible.length}`;
      clear(rows);
      if (!visible.length) rows.append(el('p', { class: 'q-hint' }, 'No videos in this selection yet.'));
      for (const video of visible) {
        const job = byFile.get(video.file);
        const imported = higgsfieldNotebook(video.file);
        const title = job ? `${names.get(job.topic_slug) ?? job.topic_name} · Local video overview`
          : imported ? `${imported.name} · Higgsfield video` : video.title;
        const detail = job
          ? `${job.slides ?? '—'} slides · ${job.duration_seconds ?? '—'} sec · ${job.used_sources?.length ?? '—'} of ${job.source_count ?? '—'} sources · ${video.modified}`
          : `${imported ? 'Higgsfield' : 'Tutorial'} · ${video.size_mb} MB · ${video.modified}`;
        const row = el('div', { class: 'qrow' });
        row.append(el('span', {}, title, el('span', { class: 'who' }, ` · ${detail}`)));
        const play = el('button', { class: 'btn small', type: 'button' }, 'Play');
        play.addEventListener('click', () => {
          player?.remove();
          player = el('video', { class: 'video-player', controls: '', preload: 'metadata', autoplay: '' });
          player.src = `/media/videos/${encodeURIComponent(video.file)}`;
          shelf.append(player);
          player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        row.append(play);
        rows.append(row);
      }
      if (running) timer = setTimeout(refresh, 4000);
      if (!sourceCheck.slug && selectedNotebook) checkSources(selectedNotebook);
    } catch (err) {
      if (err.name !== 'AbortError' && !controller.signal.aborted) progress.textContent = `Could not load videos: ${err.message}`;
    }
  };

  const checkSources = async (slug) => {
    sourceCheck = { slug, count: null, error: null };
    button.disabled = true;
    try {
      const result = await requestJson(`/api/on/sources?topic=${encodeURIComponent(slug)}`, { signal: controller.signal });
      if (selectedNotebook !== slug || controller.signal.aborted) return;
      sourceCheck = { slug, count: result.sources?.length ?? 0, error: null };
    } catch (err) {
      if (selectedNotebook !== slug || controller.signal.aborted) return;
      sourceCheck = { slug, count: null, error: `Could not check notebook sources: ${err.message}` };
    }
    refresh();
  };
  select.addEventListener('change', () => { selectedNotebook = select.value; checkSources(selectedNotebook); refresh(); });
  filter.addEventListener('change', () => {
    player?.pause();
    player?.remove();
    player = null;
    shelfFilter = filter.value;
    refresh();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !selectedNotebook || sourceCheck.count === 0) return;
    submitting = true;
    button.disabled = true;
    progress.textContent = 'Starting local video render…';
    try {
      await requestJsonWithMutation('/api/videos/generate', {
        mutationKey: `video:${selectedNotebook}`, method: 'POST', body: { topic_slug: selectedNotebook },
      });
      await refresh();
    } catch (err) {
      progress.textContent = `Could not start video: ${err.message}`;
      button.disabled = false;
    } finally {
      submitting = false;
    }
  });
  refresh();

  return () => {
    cleanupHiggsfield();
    controller.abort();
    clearTimeout(timer);
    player?.pause();
    player?.remove();
  };
}
