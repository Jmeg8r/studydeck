// Prepare a source-grounded storyboard locally, then let the learner decide what
// to send through their Higgsfield subscription. No automatic cloud request.
import { clear, el } from '../dom.mjs';
import { requestJson, requestJsonWithMutation } from '../api.mjs';

let rememberedNotebook = '';

export function initialStoryboardNotebook(notebooks, jobs, remembered, current) {
  const exists = (slug) => notebooks.some((item) => item.slug === slug);
  if (exists(remembered)) return remembered;
  const prepared = jobs.find((job) => job.status === 'prepared' && exists(job.topic_slug));
  if (prepared) return prepared.topic_slug;
  return exists(current) ? current : notebooks[0]?.slug ?? '';
}

export function renderHiggsfield(root, { topic } = {}) {
  const controller = new AbortController();
  let timer = null;
  let selected = '';
  let sourceCount = null;
  let sourceError = '';
  let initialized = false;
  let submitting = false;
  let featuredJob = null;

  const readyNotice = el('button', { class: 'video-ready-notice', type: 'button', hidden: '' });
  const card = el('section', { class: 'card higgsfield-maker' });
  card.append(el('span', { class: 'cap' }, 'Preferred · Higgsfield'),
    el('h2', {}, 'Direct the visual overview'),
    el('p', { class: 'q-hint' },
      'Prepare a source-referenced storyboard on this Mac. Review and edit it before copying anything to Higgsfield. ' +
      'Your Ultra plan credits can be used on the website or through Higgsfield’s CLI.'));
  const form = el('form', { class: 'video-form' });
  const notebook = el('select', { class: 'episode-select', 'aria-label': 'Notebook for Higgsfield storyboard' });
  const prepare = el('button', { class: 'btn primary', type: 'submit', disabled: '' }, 'Prepare storyboard');
  form.append(el('label', {}, 'Notebook', notebook), prepare);
  const status = el('p', { class: 'video-progress', role: 'status', 'aria-live': 'polite' });
  const packagePanel = el('div', { class: 'higgsfield-package' });
  card.append(form, el('p', { class: 'q-hint' },
    'Uses up to 20 ordered sources. Preparation uses the local model and spends no Higgsfield credits. ' +
    'StudyDeck does not submit a Higgsfield job yet. Review the model and credit cost on Higgsfield before generating.'),
  status, packagePanel);
  root.append(readyNotice, card);

  const showPackage = (job) => {
    clear(packagePanel);
    if (job?.status !== 'prepared') return;
    const titles = new Map((job.used_sources ?? []).map((source) => [source.id, source.title]));
    packagePanel.append(el('div', { class: 'higgsfield-package-heading' },
      el('h3', {}, 'Storyboard ready'),
      el('span', { class: 'pill' }, `${job.scenes.length} scenes · ${job.used_sources.length} of ${job.source_count} sources`)));
    for (const [index, scene] of job.scenes.entries()) {
      const sceneCard = el('article', { class: 'higgsfield-scene' });
      sceneCard.append(el('span', { class: 'higgsfield-scene-number' }, `SCENE ${String(index + 1).padStart(2, '0')}`),
        el('h4', {}, scene.title),
        el('p', {}, scene.visual_prompt),
        el('p', { class: 'higgsfield-narration' }, `Narration · ${scene.narration}`),
        el('small', {}, `Source · ${scene.source_ids.map((id) => titles.get(id) ?? id).join(' · ')}`));
      const copyScene = el('button', { class: 'btn small', type: 'button' }, 'Copy visual prompt');
      copyScene.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(scene.visual_prompt);
          copyScene.textContent = 'Copied';
        } catch {
          copyScene.textContent = 'Select the visual text to copy';
        }
      });
      sceneCard.append(copyScene);
      packagePanel.append(sceneCard);
    }
    packagePanel.append(el('label', { class: 'higgsfield-prompt-label' }, 'Edit the handoff prompt'));
    const prompt = el('textarea', { class: 'higgsfield-prompt', 'aria-label': 'Higgsfield handoff prompt', rows: '11' });
    prompt.value = job.prompt;
    const copy = el('button', { class: 'btn', type: 'button' }, 'Copy prompt');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt.value);
        copy.textContent = 'Copied';
      } catch {
        prompt.focus();
        prompt.select();
        copy.textContent = 'Select and copy the prompt';
      }
    });
    const open = el('a', { class: 'btn primary', href: 'https://higgsfield.ai/', target: '_blank',
      rel: 'noopener noreferrer' }, 'Open Higgsfield');
    packagePanel.append(prompt, el('div', { class: 'higgsfield-actions' }, copy, open),
      el('p', { class: 'q-hint' },
        'Review the price on Higgsfield before generating. Download the MP4, then save it in StudyDeck’s docs/ folder as ',
        el('code', {}, `${job.topic_slug}-higgsfield-1.mp4`),
        ' to place it under this notebook on the video shelf.'));
  };

  const refresh = async () => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    try {
      const [catalog, prepared] = await Promise.all([
        requestJson('/api/videos/jobs', { signal: controller.signal }),
        requestJson('/api/videos/higgsfield', { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const notebooks = catalog.notebooks ?? [];
      const jobs = prepared.jobs ?? [];
      featuredJob = jobs.find((job) => job.status === 'prepared'
        && notebooks.some((item) => item.slug === job.topic_slug)) ?? null;
      readyNotice.hidden = !featuredJob;
      if (featuredJob) {
        const name = notebooks.find((item) => item.slug === featuredJob.topic_slug)?.name ?? featuredJob.topic_name;
        clear(readyNotice);
        readyNotice.append(el('span', { class: 'cap' }, 'Ready to review'),
          el('strong', {}, `${name} · ${featuredJob.scenes.length} scenes`),
          el('span', {}, 'View storyboard ↓'));
      }
      if (!initialized) {
        selected = initialStoryboardNotebook(notebooks, jobs, rememberedNotebook, topic?.slug);
        for (const item of notebooks) notebook.append(el('option', { value: item.slug }, item.name));
        notebook.value = selected;
        initialized = true;
        if (selected) checkSources(selected);
      }
      const running = jobs.find((job) => job.status === 'running');
      const latest = jobs.find((job) => job.topic_slug === selected);
      prepare.disabled = submitting || Boolean(running) || !selected || sourceCount === null || sourceCount === 0;
      if (running) status.textContent = `${running.topic_name}: ${running.progress}. You can leave this page while it prepares.`;
      else if (sourceError) status.textContent = `Could not check sources: ${sourceError}`;
      else if (sourceCount === 0) {
        status.textContent = 'This notebook has no sources yet. ';
        status.append(el('a', { href: '#reading' }, 'Add one in Reading Room'));
      } else if (sourceCount === null) status.textContent = 'Checking notebook sources…';
      else if (latest?.status === 'failed') status.textContent = `${latest.topic_name}: ${latest.error} You can try again.`;
      else status.textContent = '';
      showPackage(latest);
      if (running) timer = setTimeout(refresh, 4000);
    } catch (err) {
      if (err.name !== 'AbortError' && !controller.signal.aborted) status.textContent = `Could not load storyboard: ${err.message}`;
    }
  };

  readyNotice.addEventListener('click', () => {
    if (!featuredJob) return;
    if (selected !== featuredJob.topic_slug) {
      selected = featuredJob.topic_slug;
      rememberedNotebook = selected;
      notebook.value = selected;
      showPackage(featuredJob);
      checkSources(selected);
    }
    packagePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const checkSources = async (slug) => {
    sourceCount = null;
    sourceError = '';
    prepare.disabled = true;
    try {
      const result = await requestJson(`/api/on/sources?topic=${encodeURIComponent(slug)}`, { signal: controller.signal });
      if (selected !== slug || controller.signal.aborted) return;
      sourceCount = result.sources?.length ?? 0;
    } catch (err) {
      if (selected !== slug || controller.signal.aborted) return;
      sourceError = err.message;
    }
    refresh();
  };

  notebook.addEventListener('change', () => {
    selected = notebook.value;
    rememberedNotebook = selected;
    checkSources(selected);
    refresh();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !selected || sourceCount === null || sourceCount === 0) return;
    submitting = true;
    prepare.disabled = true;
    status.textContent = 'Starting local storyboard preparation…';
    try {
      await requestJsonWithMutation('/api/videos/higgsfield/prepare', {
        mutationKey: `higgsfield:${selected}`, method: 'POST', body: { topic_slug: selected },
      });
      await refresh();
    } catch (err) {
      status.textContent = `Could not prepare storyboard: ${err.message}`;
      prepare.disabled = false;
    } finally {
      submitting = false;
    }
  });
  refresh();

  return () => { controller.abort(); clearTimeout(timer); };
}
