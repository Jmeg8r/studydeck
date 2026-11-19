import { sourceSearch } from './source-search.mjs';
// WHAT: Reading Room — sources from Open Notebook, rendered, with position and highlights.
// WHY: Step 5 of the pipeline is deep study, and the spec's rule is that annotations
//      get captured as notes. Selecting text and saving it round-trips straight back
//      into the notebook, so the reading and the note never drift apart.
import { clear, el } from '../dom.mjs';
import { requestJson as api } from '../api.mjs';
import { outline, renderMarkdown } from '../markdown.mjs';
import { withMutationId } from '../mutation.mjs';

const SAVE_DEBOUNCE_MS = 700;

function errorPanel(message, hint) {
  const panel = el('div', { class: 'error-panel' });
  panel.append(el('h2', {}, 'Open Notebook is not answering'), el('p', {}, hint), el('pre', {}, message));
  return panel;
}

// ---------- reader ----------

function reader(root, { topic, source, position }, onBack) {
  root.append(el('div', { class: 'crumb' }, `Studydeck / Reading Room / ${source.title}`));

  const bar = el('div', { class: 'card' });
  const flex = el('div', { class: 'filter-bar' });
  const progress = el('div', { class: 'cap' }, 'position 0%');
  const back = el('button', { class: 'btn small', type: 'button' }, '← All sources');
  back.addEventListener('click', onBack);
  flex.append(progress, back);
  bar.append(flex);
  root.append(bar);

  const layout = el('div', { class: 'read-layout' });

  // In-chapter outline, so a 31k-character chapter is navigable.
  const headings = outline(source.text);
  if (headings.length > 1) {
    const nav = el('aside', { class: 'read-outline' });
    nav.append(el('div', { class: 'cap' }, 'In this chapter'));
    for (const heading of headings) {
      const link = el('a', { class: `read-h${heading.level}`, href: `#${heading.id}` }, heading.text);
      link.addEventListener('click', (event) => {
        event.preventDefault();
        document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      nav.append(link);
    }
    layout.append(nav);
  }

  const article = el('article', { class: 'read-body', tabindex: '-1' });
  // Safe by construction: renderMarkdown escapes before it transforms.
  article.innerHTML = renderMarkdown(source.text);
  layout.append(article);
  root.append(layout);

  // Restore where you were. Deferred so layout has settled and heights are real.
  requestAnimationFrame(() => {
    if (position > 0) {
      const target = article.offsetTop + (article.scrollHeight - window.innerHeight) * position;
      window.scrollTo(0, Math.max(0, target));
    }
  });

  let timer = null;
  const onScroll = () => {
    const scrollable = article.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0
      ? Math.min(1, Math.max(0, (window.scrollY - article.offsetTop) / scrollable))
      : 0;
    progress.textContent = `position ${Math.round(ratio * 100)}%`;

    // Debounced: a write per scroll event would hammer the disk for no benefit.
    clearTimeout(timer);
    timer = setTimeout(() => {
      api('/api/reading', {
        method: 'POST',
        body: { topic_slug: topic.slug, source_id: source.id, position: ratio, title: source.title },
      }).catch((err) => console.error('[reading] position save failed', err));
    }, SAVE_DEBOUNCE_MS);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Selecting text offers to save it as a note.
  const popup = el('div', { class: 'highlight-pop' });
  const saveBtn = el('button', { class: 'btn small primary', type: 'button' }, 'Save highlight');
  const cancelBtn = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
  const status = el('span', { class: 'q-hint', style: 'margin:0' });
  popup.append(saveBtn, cancelBtn, status);
  document.body.append(popup);

  let selectedText = '';
  let hideTimer = null;
  const restoreFocus = () => article.focus({ preventScroll: true });
  const hidePopup = ({ restore = false } = {}) => {
    clearTimeout(hideTimer);
    popup.classList.remove('visible');
    if (restore) restoreFocus();
  };

  const onSelectionChange = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!text || !article.contains(selection?.anchorNode)) return hidePopup();
    showSelection();
  };

  const showSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!text || !article.contains(selection.anchorNode)) return hidePopup();

    selectedText = text;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    popup.style.left = `${Math.max(12, rect.left)}px`;
    popup.style.top = `${rect.bottom + window.scrollY + 8}px`;
    status.textContent = `${text.length} chars`;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save highlight';
    popup.classList.add('visible');
  };
  // pointerup covers mouse, touch, and pen. selectionchange covers keyboard selection;
  // both call the same action so no input mode has a hidden-only affordance.
  document.addEventListener('pointerup', showSelection);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('keyup', showSelection);

  // Preserve the range while pointer users activate the action. Keyboard focus is left
  // alone, so Tab then Enter works naturally from a keyboard-made selection.
  saveBtn.addEventListener('pointerdown', (event) => event.preventDefault());
  cancelBtn.addEventListener('click', () => {
    window.getSelection()?.removeAllRanges();
    hidePopup({ restore: true });
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const highlightKey = `reading-highlight:${topic.slug}:${source.id}:${selectedText}`;
      const request = {
        topic_slug: topic.slug,
        title: `Highlight — ${source.title}`,
        content: `> ${selectedText}\n\n— from ${source.title}, saved from the StudyDeck Reading Room.`,
      };
      await withMutationId(highlightKey, (mutationId) => api('/api/on/notes', {
        method: 'POST',
        body: { ...request, mutation_id: mutationId },
      }), { payload: request });
      saveBtn.textContent = 'Saved to notebook ✓';
      hideTimer = setTimeout(() => hidePopup({ restore: true }), 1400);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Retry';
      status.textContent = err.message;
    }
  });

  // Teardown: this view owns document-level listeners, so it must clean them up.
  // Every listener registered above has to appear here — a missed one leaks per
  // reader open and keeps firing against a detached article for the rest of the session.
  return () => {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('pointerup', showSelection);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('keyup', showSelection);
    popup.remove();
  };
}

// ---------- entry ----------

/**
 * Returns a cleanup function. This is the only view that registers document-level
 * listeners, so the router must be able to tear it down when navigating away —
 * otherwise each visit leaves another scroll/selection handler running.
 */
export function renderReading(root, state, { topic }) {
  let teardown = null;
  let addNotice = null;
  let searchCleanup = null;
  let viewVersion = 0;
  const cleanup = () => { viewVersion++; teardown?.(); teardown = null; searchCleanup?.(); searchCleanup = null; };

  const showList = async () => {
    cleanup();
    clear(root);
    root.append(el('div', { class: 'crumb' }, 'Studydeck / Reading Room'));
    const version = viewVersion;
    let chooseSource = () => {
      search.panel.append(el('p', { role: 'status' }, 'Open Notebook must be available before adding a source. You can open the source link above.'));
    };
    const search = sourceSearch({ topic, onChoose: (result) => chooseSource(result) });
    searchCleanup = search.dispose;
    root.append(search.panel);
    root.append(el('div', { class: 'loading' }, 'Loading sources from Open Notebook…'));

    // Topics without a mapped notebook simply have nothing to read.
    let payload;
    try {
      payload = await api(`/api/on/sources?topic=${encodeURIComponent(topic.slug)}`);
      if (version !== viewVersion) return;
    } catch (err) {
      if (version !== viewVersion) return;
      clear(root);
      root.append(search.panel);
      root.append(el('div', { class: 'crumb' }, 'Studydeck / Reading Room'));
      root.append(errorPanel(err.message,
        'The Reading Room reads from your local Open Notebook instance. Start it, then reload.'));
      return;
    }

    clear(root);
    root.append(el('div', { class: 'crumb' }, `Studydeck / Reading Room — ${topic.name}`));

    const card = el('div', { class: 'card' });
    const heading = el('div', { class: 'source-heading' });
    heading.append(el('div', { class: 'cap' }, `Sources · ${payload.sources.length}`));
    const addButton = el('button', { class: 'btn small primary', type: 'button',
      'aria-expanded': 'false' }, '+ Add source');
    heading.append(addButton);
    card.append(heading);

    const sourceForm = el('div', { class: 'source-form-wrap' });
    const form = el('form', { class: 'source-form' });
    const kindLabel = el('label', { for: 'source-kind' }, 'Source type');
    const kind = el('select', { id: 'source-kind', name: 'kind' },
      el('option', { value: 'link' }, 'Website or video link'),
      el('option', { value: 'text' }, 'Paste text'));
    const titleLabel = el('label', { for: 'source-title' }, 'Title');
    const title = el('input', { id: 'source-title', name: 'title', type: 'text',
      maxlength: '200', required: '', placeholder: 'What should this source be called?' });
    const urlLabel = el('label', { for: 'source-url' }, 'Link');
    const urlField = el('input', { id: 'source-url', name: 'url', type: 'url',
      maxlength: '2048', required: '', placeholder: 'https://…' });
    const textLabel = el('label', { for: 'source-content' }, 'Text');
    const textField = el('textarea', { id: 'source-content', name: 'content',
      rows: '7', maxlength: '100000', placeholder: 'Paste your source material here…' });
    const status = el('p', { class: 'source-add-status', 'aria-live': 'polite' });
    const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Add to notebook');
    const upload = el('a', { class: 'source-upload-link', href: 'http://127.0.0.1:8502/notebooks',
      target: '_blank', rel: 'noopener noreferrer' }, 'Upload a PDF or file in Open Notebook ↗');
    const syncFields = () => {
      const isLink = kind.value === 'link';
      urlLabel.hidden = !isLink;
      urlField.hidden = !isLink;
      urlField.required = isLink;
      textLabel.hidden = isLink;
      textField.hidden = isLink;
      textField.required = !isLink;
    };
    kind.addEventListener('change', syncFields);
    syncFields();
    form.append(kindLabel, kind, titleLabel, title, urlLabel, urlField,
      textLabel, textField, status,
      el('div', { class: 'source-form-actions' }, submit, upload));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = 'Adding source…';
      status.className = 'source-add-status';
      const body = {
        topic_slug: topic.slug, type: kind.value, title: title.value.trim(),
        ...(kind.value === 'link' ? { url: urlField.value.trim() } : { content: textField.value.trim() }),
      };
      const key = `source-add:${topic.slug}:${JSON.stringify(body)}`;
      try {
        await withMutationId(key, (mutationId) => api('/api/on/sources', {
          method: 'POST', body: { ...body, mutation_id: mutationId },
        }), { payload: body });
        addNotice = 'Source accepted. Processing may take a moment; refresh the list to check it.';
        showList();
      } catch (err) {
        status.textContent = err.message;
        status.className = 'source-add-status error';
        submit.disabled = false;
      }
    });
    sourceForm.append(form);
    sourceForm.hidden = true;
    addButton.addEventListener('click', () => {
      sourceForm.hidden = !sourceForm.hidden;
      addButton.setAttribute('aria-expanded', String(!sourceForm.hidden));
      if (!sourceForm.hidden) title.focus();
    });
    card.append(sourceForm);
    chooseSource = (result) => {
      sourceForm.hidden = false;
      addButton.setAttribute('aria-expanded', 'true');
      kind.value = 'link'; title.value = result.title; urlField.value = result.url;
      syncFields();
      status.textContent = 'Review this source, then add it to your notebook.';
      sourceForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      title.focus({ preventScroll: true });
    };
    root.append(search.panel);
    if (addNotice) card.append(el('p', { class: 'source-add-status', role: 'status' }, addNotice));
    const refresh = el('button', { class: 'btn small', type: 'button' }, 'Refresh sources');
    refresh.addEventListener('click', showList);
    card.append(refresh);

    if (payload.sources.length === 0) {
      card.append(el('p', { class: 'q-hint' },
        payload.reason === 'no notebook mapped for this topic'
          ? `No Open Notebook notebook is mapped to ${topic.name}. Add its id to app/cockpit.config.json.`
          : 'This notebook has no sources yet.'));
      root.append(card);
      return;
    }

    for (const source of payload.sources) {
      const saved = topic.reading?.[source.id];
      const row = el('div', { class: 'qrow' });
      const label = el('span', {}, source.title);
      if (saved) label.append(el('span', { class: 'who' }, ` · ${Math.round(saved.position * 100)}% read`));
      if (source.status && !['completed', 'ready', 'success'].includes(source.status.toLowerCase())) {
        label.append(el('span', { class: 'who' }, ` · ${source.status}`));
      }

      const open = el('button', { class: 'btn small', type: 'button' }, saved ? 'Resume' : 'Read');
      open.addEventListener('click', () => showReader(topic, source));
      row.append(label, open);
      card.append(row);
    }
    root.append(card);
  };

  const showReader = async (topic, source) => {
    cleanup();
    clear(root);
    root.append(el('div', { class: 'loading' }, `Loading ${source.title}…`));
    try {
      const full = await api(`/api/on/sources/${encodeURIComponent(source.id)}`);
      clear(root);
      teardown = reader(root, {
        topic, source: full, position: topic.reading?.[source.id]?.position ?? 0,
      }, showList);
    } catch (err) {
      clear(root);
      root.append(errorPanel(err.message, 'Could not load that source from Open Notebook.'));
    }
  };

  showList();
  return cleanup;
}
