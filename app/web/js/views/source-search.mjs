import { el, clear } from '../dom.mjs';
import { requestJson } from '../api.mjs';

export function sourceSearch({ topic, onChoose }) {
  const panel = el('section', { class: 'card source-search', 'aria-label': 'Find sources on the internet' });
  const form = el('form', { class: 'source-form' });
  const input = el('input', { id: 'source-search-query', type: 'search', required: '', maxlength: '500', value: topic.name,
    placeholder: 'Enter a topic or a question' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Search the internet');
  const status = el('p', { class: 'source-search-status', role: 'status', 'aria-live': 'polite' });
  const elapsed = el('span', { class: 'source-search-elapsed', 'aria-hidden': 'true' });
  const waitingHint = el('p', { class: 'source-search-wait-hint' });
  const activity = el('div', { class: 'source-search-progress', hidden: '', role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'source-search-spinner', 'aria-hidden': 'true' }),
    el('div', { class: 'source-search-progress-copy' },
      el('strong', {}, 'Search in progress'), waitingHint), elapsed);
  const results = el('div');
  let timer = null;
  const stopWaiting = () => {
    clearInterval(timer);
    timer = null;
    activity.hidden = true;
    results.setAttribute('aria-busy', 'false');
    submit.disabled = false;
    submit.textContent = 'Search the internet';
    input.disabled = false;
  };
  let controller;
  let disposed = false;
  panel.append(el('h2', {}, 'Find the best sources'),
    el('p', { class: 'q-hint' }, 'Search websites, PDFs, YouTube, blogs, vendor documentation, and training sites. Review the shortlist, then choose what to add.'),
    form, activity, status, results);
  form.append(el('label', { for: 'source-search-query' }, 'Topic or sentence'), input, submit,
    el('p', { class: 'q-hint' }, 'Your search text goes to Firecrawl. Source assessment runs locally. Searches do not add anything to your notebook.'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (!input.value.trim()) { input.focus(); return; }
    submit.disabled = true;
    submit.textContent = 'Searching…';
    input.disabled = true;
    clear(results);
    results.setAttribute('aria-busy', 'true');
    status.textContent = '';
    activity.hidden = false;
    waitingHint.textContent = 'Finding sources and reviewing their quality. This can take a few minutes.';
    const started = performance.now();
    let longWait = false;
    const tick = () => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      elapsed.textContent = `Elapsed ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= 60 && !longWait) {
        longWait = true;
        waitingHint.textContent = 'Still waiting for results. Some pages and local source assessments take longer to finish.';
      }
    };
    tick();
    timer = setInterval(tick, 1000);
    controller = new AbortController();
    try {
      const data = await requestJson('/api/on/source-search', {
        method: 'POST', body: { query: input.value.trim() }, signal: controller.signal,
      });
      if (disposed) return;
      status.textContent = `${data.results.length} ${data.ranking === 'assessed' ? 'recommended sources' : 'preliminary matches'} from ${data.candidate_count} candidates. ${data.warnings.join(' ')}`;
      if (!data.results.length) {
        results.append(el('p', {}, 'No strong matches found. Try a more specific topic or a shorter question.'));
        return;
      }
      const filter = el('select', { class: 'source-search-filter', 'aria-label': 'Filter search results by source type' });
      const kinds = [...new Set(data.results.flatMap((r) => r.kinds))];
      filter.append(el('option', { value: '' }, 'All source types'), ...kinds.map((k) => el('option', { value: k }, k)));
      const list = el('div');
      results.append(filter, list);
      const draw = () => {
        clear(list);
        for (const [index, result] of data.results.entries()) {
          if (filter.value && !result.kinds.includes(filter.value)) continue;
          const card = el('article', { class: 'card source-search-result' });
          card.append(el('div', { class: 'cap' }, `${index + 1} · ${result.kinds.join(' · ')} · ${result.evidence}`),
            el('h3', {}, el('a', { href: result.url, target: '_blank', rel: 'noopener noreferrer' }, result.title)),
            el('p', { class: 'q-hint' }, new URL(result.url).hostname),
            el('p', {}, result.description), el('p', {}, result.reason),
            ...(result.quote ? [el('blockquote', {}, result.quote)] : []),
            el('p', { class: 'q-hint' }, result.caveat));
          const choose = el('button', { class: 'btn small', type: 'button' }, 'Use this source');
          choose.addEventListener('click', () => {
            onChoose(result);
            choose.textContent = 'Selected below';
          });
          card.append(choose); list.append(card);
        }
      };
      filter.addEventListener('change', draw); draw();
    } catch (err) {
      if (!disposed && err.name !== 'AbortError') status.textContent = err.message;
    } finally { if (!disposed) stopWaiting(); }
  });
  return { panel, dispose() { disposed = true; stopWaiting(); controller?.abort(); } };
}
