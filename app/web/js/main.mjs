// WHAT: Cockpit boot — fetch state, paint the Command Rail shell, route between views.
// WHY: One state fetch feeds every view, so the numbers on screen can never disagree
//      with each other. Views re-render from the same payload.
import { clear, el } from './dom.mjs';
import { requestJson } from './api.mjs';
import { renderToday } from './views/today.mjs';
import { renderTestCenter } from './views/testcenter.mjs';
import { renderFlashcards } from './views/flashcards.mjs';
import { renderStats } from './views/stats.mjs';
import { renderReading } from './views/reading.mjs';
import { renderPodcast } from './views/podcast.mjs';
import { renderVideos } from './views/videos.mjs';
import { renderFactCheck } from './views/factcheck.mjs';
import { renderMindMap } from './views/mindmap.mjs';
import { renderPractice } from './views/practice.mjs';
import { renderTeachback } from './views/teachback.mjs';
import { renderRoles } from './views/roles.mjs';
import { renderRecovery } from './views/recovery.mjs';
import { schedulePosition, setWorkingTopic, workingTopic } from './topic.mjs';
import { renderIntegrityBanner, renderUnavailableTopics } from './integrity.mjs';
import { createWriteGate } from './writegate.mjs';

const THEME_KEY = 'studydeck.theme';

/** Nav order matches the approved comp. */
const VIEWS = [
  {
    id: 'today', label: 'Today',
    icon: '<path d="M3 12l9-9 9 9M5 10v10h14V10"/>',
  },
  {
    id: 'podcast', label: 'Podcast',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M10 9l6 3-6 3z"/>',
  },
  {
    id: 'reading', label: 'Reading Room',
    icon: '<path d="M4 5h7v14H4zM13 5h7v14h-7z"/>',
  },
  {
    id: 'mindmap', label: 'Mind Map',
    icon: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M12 8v4m0 0l-5 4m5-4l5 4"/>',
  },
  {
    id: 'factcheck', label: 'Fact-Check',
    icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/>',
  },
  {
    id: 'lab', label: 'Practice Lab',
    icon: '<path d="M5 4h14v16H5zM8 8h8M8 12h5M8 16h3"/><path d="M17 16l1.5 1.5L21 14"/>',
  },
  {
    id: 'teachback', label: 'Teachback',
    icon: '<path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  },
  {
    id: 'roles', label: 'Roles',
    icon: '<path d="M4 5h11v8H9l-3 3v-3H4z"/><path d="M17 9h3v8h-2v3l-3-3h-5"/>',
  },
  {
    id: 'flashcards', label: 'Flashcards',
    icon: '<rect x="3" y="7" width="14" height="11" rx="1"/><path d="M7 7V5a1 1 0 011-1h13v11h-2"/>',
    badge: (state) => state.badges.flashcards,
  },
  {
    id: 'testcenter', label: 'Test Center',
    icon: '<path d="M9 5h11M9 12h11M9 19h11M4 5h.5M4 12h.5M4 19h.5"/>',
    badge: (state) => state.badges.testcenter,
  },
  {
    id: 'stats', label: 'Stats',
    icon: '<path d="M4 20V9m6 11V4m6 16v-7"/>',
  },
  {
    id: 'videos', label: 'Videos',
    icon: '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
  },
  {
    id: 'recovery', label: 'Recovery',
    icon: '<path d="M5 8a8 8 0 111 10M5 3v5h5"/>',
  },
];

const SUN = '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
const MOON = '<path d="M20 13.5A8.5 8.5 0 1110.5 4a6.6 6.6 0 009.5 9.5z"/>';

let state = null;
// Recovery's writes outlive its view; the next render waits for them (writegate.mjs).
const recoveryWrites = createWriteGate();
let createNotebookOpen = false;

function currentView() {
  // `#practice` shipped in the first M4.6 slice. Keep it as an alias while the approved
  // public handoff becomes `#lab`; schedule records use the unprefixed functional id.
  const raw = location.hash.replace('#', '') || 'today';
  const id = raw === 'practice' ? 'lab' : raw;
  return VIEWS.find((v) => v.id === id) ?? VIEWS[0];
}

function navigate(viewId) {
  location.hash = viewId;
}

async function submitNewNotebook(form, status) {
  const field = form.elements.namedItem('name');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = 'Creating notebook…';
  status.className = 'new-notebook-status';
  try {
    const created = await requestJson('/api/notebooks', {
      method: 'POST', body: { name: field.value },
    });
    setWorkingTopic(created.slug);
    createNotebookOpen = false;
    await refreshState();
    render();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'new-notebook-status error';
    button.disabled = false;
    field.focus();
  }
}

function newNotebookForm() {
  const panel = el('div', { class: 'new-notebook-panel' });
  const form = el('form', { class: 'new-notebook-form' });
  const label = el('label', { for: 'new-notebook-name' }, 'Notebook name');
  const input = el('input', {
    id: 'new-notebook-name', name: 'name', type: 'text', required: '',
    maxlength: '80', autocomplete: 'off', placeholder: 'e.g. Linear Algebra',
  });
  const status = el('p', { class: 'new-notebook-status', 'aria-live': 'polite' });
  const cancel = el('button', { class: 'new-notebook-cancel', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => {
    createNotebookOpen = false;
    render();
  });
  const submit = el('button', { class: 'new-notebook-submit', type: 'submit' }, 'Create notebook');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitNewNotebook(form, status);
  });
  form.append(label, input,
    el('p', { class: 'new-notebook-help' },
      'Creates an empty StudyDeck topic and its Open Notebook notebook. Add sources in Reading Room, then build its study map with your learning agent.'),
    status, el('div', { class: 'new-notebook-actions' }, cancel, submit));
  panel.append(form);
  queueMicrotask(() => input.focus());
  return panel;
}

// ---------- theme ----------

function activeTheme() {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.documentElement.classList.toggle('dark', theme !== 'light');
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  applyTheme(activeTheme() === 'light' ? 'dark' : 'light');
  // SVG fills are resolved from CSS tokens at draw time, so the charts must be
  // redrawn — CSS alone can't restyle attributes that were already written.
  render();
}

/**
 * Report Open Notebook's reachability and version in the rail footer.
 *
 * The plan's risk register calls for surfacing a version mismatch rather than letting
 * ON drift break things quietly — its API is on a roadmap that includes a database
 * change. Failure here is cosmetic by design: the cockpit works without ON.
 */
async function reportOnStatus(node) {
  try {
    const info = await requestJson('/api/on/health');
    if (!info.reachable) {
      node.textContent = 'ON: offline';
      node.className = 'on-status offline';
      node.title = info.error ?? 'Open Notebook is not reachable';
      return;
    }
    node.textContent = `ON: ${info.version}${info.mismatch ? ' ⚠' : ''}`;
    node.className = `on-status${info.mismatch ? ' mismatch' : ' ok'}`;
    node.title = info.mismatch
      ? `Cockpit was built against Open Notebook ${info.expected}.x — running ${info.version}. Check the proxy in app/lib/opennotebook.mjs.`
      : `Open Notebook ${info.version}, database ${info.db ?? 'unknown'}`;
  } catch {
    node.textContent = 'ON: unknown';
    node.className = 'on-status offline';
  }
}

// ---------- shell ----------

// Open Notebook's own UI, where uploads, media, models and settings are managed. It is a
// separate origin, so these are plain new-tab links: no route here proxies it.
const ON_UI_URL = 'http://127.0.0.1:8502';

function openNotebookLinks(working) {
  const notebookPath = working?.notebook_id
    ? `/notebooks/${encodeURIComponent(working.notebook_id)}`
    : '/notebooks';
  const links = [
    ['This notebook', notebookPath],
    ['Sources', '/sources'],
    ['Podcasts', '/podcasts'],
    ['Settings', '/settings'],
  ];
  const section = el('nav', { class: 'on-links', 'aria-label': 'Open Notebook' });
  section.append(el('div', { class: 'rail-section-heading' }, 'Open Notebook ↗'));
  const row = el('div', { class: 'on-link-row' });
  for (const [label, path] of links) {
    row.append(el('a', {
      class: 'on-link', href: `${ON_UI_URL}${path}`, target: '_blank', rel: 'noopener noreferrer',
      title: `${label} in Open Notebook (new tab)`,
    }, label));
  }
  section.append(row);
  return section;
}

/** Keep every notebook visible without changing the cross-topic retrieval views. */
function notebookSection(working) {
  const section = el('section', { class: 'notebooks', 'aria-label': 'Notebooks' });
  const add = el('button', {
    class: 'new-notebook-trigger', type: 'button',
    'aria-expanded': String(createNotebookOpen),
  }, '+ New');
  add.addEventListener('click', () => {
    createNotebookOpen = !createNotebookOpen;
    render();
  });
  const heading = el('div', { class: 'rail-section-heading' },
    el('span', {}, 'Notebooks'),
    el('span', { class: 'notebook-heading-actions' },
      el('span', { class: 'section-count' }, String(state.topics.length)), add));
  const list = el('div', { class: 'notebook-list' });

  for (const topic of state.topics) {
    const selected = topic.slug === working?.slug;
    const recommended = topic.slug === state.today.topic_slug;
    const attrs = {
      class: `notebook-item${selected ? ' active' : ''}`,
      title: `${topic.name}${recommended ? ' · recommended today' : ''}`,
    };
    if (state.topics.length > 1) {
      attrs.type = 'button';
      attrs['aria-pressed'] = String(selected);
    }
    const item = el(state.topics.length > 1 ? 'button' : 'div', attrs,
      el('span', { class: 'notebook-name' }, topic.name),
      el('span', { class: 'notebook-meta' },
        schedulePosition(topic),
        recommended ? el('span', { class: 'notebook-recommended' }, ' · today’s pick') : null));
    if (state.topics.length > 1) item.addEventListener('click', () => {
      if (selected) return;
      setWorkingTopic(topic.slug);
      render();
    });
    list.append(item);
  }
  section.append(heading);
  if (createNotebookOpen) section.append(newNotebookForm());
  section.append(list,
    el('p', { class: 'notebook-scope' }, 'Today, Flashcards and Test Center still span topics.'));
  return section;
}

function renderRail() {
  const rail = document.getElementById('rail');
  clear(rail);

  const brand = el('div', { class: 'brand' });
  const h1 = el('h1');
  h1.append('STUDY', el('b', {}, 'DECK'));
  brand.append(h1, el('small', {}, 'Memory Command Center'));
  rail.append(brand);

  const working = workingTopic(state);
  rail.append(notebookSection(working));

  const toolsHeading = el('div', { class: 'rail-section-heading tools-heading' }, 'Study tools');
  const tools = el('nav', { class: 'rail-tools', 'aria-label': 'Study tools' });
  const active = currentView().id;
  for (const view of VIEWS) {
    const item = el('button', { class: `nav-item${view.id === active ? ' active' : ''}`, type: 'button' });
    item.innerHTML = `<svg viewBox="0 0 24 24">${view.icon}</svg>`;
    item.append(view.label);

    const count = view.badge?.(state) ?? 0;
    if (count > 0) item.append(el('span', { class: 'badge' }, String(count)));

    item.addEventListener('click', () => navigate(view.id));
    tools.append(item);
  }
  rail.append(toolsHeading, tools, openNotebookLinks(working));

  // The day counter follows the working notebook, not the schedule's nomination.
  // "Not started · 1/2 topics" may wrap in the 212px rail; the footer permits it.
  const dayLine = working
    ? `${schedulePosition(working)} · ${state.active_topics}/${state.topics.length} topics`
    : `No topic on the clock · ${state.topics.length} seeded`;

  const foot = el('div', { class: 'foot' });
  const lines = el('div', { class: 'lines' });
  lines.append(dayLine, el('br'), `interleave: ${state.active_topics > 1 ? 'on' : 'off'}`);

  // ON status, filled in asynchronously — the shell must never block or fail on it.
  const onStatus = el('span', { class: 'on-status' });
  lines.append(el('br'), onStatus);
  reportOnStatus(onStatus);

  const toggle = el('button', {
    class: 'theme-toggle', type: 'button',
    title: `Switch to ${activeTheme() === 'light' ? 'dark' : 'light'} theme`,
  });
  toggle.innerHTML = `<svg viewBox="0 0 24 24">${activeTheme() === 'light' ? MOON : SUN}</svg>`;
  toggle.addEventListener('click', toggleTheme);

  const row = el('div', { class: 'foot-row' });
  row.append(lines, toggle);
  foot.append(row);
  rail.append(foot);
}

// Views that own document-level listeners return a cleanup function. Holding it here
// and calling it on every re-render is what stops handlers accumulating across
// navigations — clearing the DOM alone does not unregister them.
let activeCleanup = null;

function render() {
  const main = document.getElementById('main');
  activeCleanup?.();
  activeCleanup = null;
  clear(main);
  renderRail();

  // Every render paints into a FRESH surface, and views are handed that rather than #main.
  //
  // Views load asynchronously and then `clear(root)` and repaint — unconditionally, because
  // when that code was written a view could only be replaced by navigating, and nobody
  // navigates mid-load on a local server. The topic picker broke that assumption: switching
  // topic while the Reading Room is fetching leaves the OLD request in flight, and when it
  // lands it wipes the newly-painted view and repaints the PREVIOUS topic's sources. The
  // picker then says one topic while the page shows another — reproduced, not theorised.
  //
  // A fresh surface fixes the whole class at one point: `clear(main)` above has already
  // detached the previous surface, so a stale continuation clears and repaints a node that
  // is no longer in the document. Nothing is visible, nothing leaks into the new view. The
  // alternative — a generation guard checked after every await in every async view — is a
  // check that has to be remembered at each of a dozen sites and silently fails where it is
  // forgotten. `main` is not a flex or grid container and no selector targets its direct
  // children, so the extra element is layout-neutral.
  //
  // The banners get their own container, above the surface and never handed to a view:
  // most views `clear(root)` once loaded, which took a banner painted into the surface
  // down with it, so Reading Room, Podcast and the rest showed no warning at all.
  const banners = el('div', { class: 'view-banners' });
  const surface = el('div', { class: 'view-surface' });
  main.append(banners, surface);

  // Async and never awaited: a damaged-storage warning must not delay the view, and if the
  // health endpoint is unreachable the cockpit still works. It prepends itself when it
  // has something to say (F12).
  renderIntegrityBanner(banners);
  // Synchronous, from the state already in hand: a topic /api/state had to skip.
  renderUnavailableTopics(banners, state);

  // Recovery reads its own ledgers through /api/recovery, not /api/state, so it still works
  // when every topic failed to load. Drawn before the guard below, or the banner's Open
  // Recovery link would dead-end on "No topic could be loaded".
  const view = currentView();
  if (view.id === 'recovery') {
    activeCleanup = renderRecovery(surface, { refresh: () => refreshAfterRecovery(banners), track: recoveryWrites.track });
    return;
  }

  // Every view below assumes at least one topic. With all of them unavailable, several
  // dereference the working topic and throw, and boot() would swap the banner naming the
  // causes for the generic "/api/state failed" panel. Stop here instead, banner in place.
  if (state.topics.length === 0) {
    surface.append(el('div', { class: 'error-panel' },
      el('h2', {}, 'No topic could be loaded'),
      el('p', {}, 'Every configured topic failed to load; the banner above says why. Fix the named files and reload.')));
    return;
  }

  // Resolved ONCE and handed down, rather than each view re-deriving it. Five copies of the
  // same fallback was the finding; five copies of the same lookup would be the same bug
  // waiting to diverge again. Today, Flashcards and Test Center are not passed it as a
  // filter — they interleave across topics by design — but their nested Essay and Debrief
  // panels need a topic, so it reaches them through their parents.
  const topic = workingTopic(state);

  if (view.id === 'today') renderToday(surface, state, { navigate, reload: boot });
  else if (view.id === 'testcenter') renderTestCenter(surface, state, { reload: boot, refreshState: refreshStateQuietly, topic });
  else if (view.id === 'flashcards') renderFlashcards(surface, state, { reload: boot, refreshState: refreshStateQuietly, topic });
  else if (view.id === 'stats') renderStats(surface, state, { reload: boot });
  else if (view.id === 'reading') activeCleanup = renderReading(surface, state, { topic });
  else if (view.id === 'podcast') activeCleanup = renderPodcast(surface, { topics: state.topics, topic });
  else if (view.id === 'videos') activeCleanup = renderVideos(surface, { topic });
  else if (view.id === 'factcheck') renderFactCheck(surface, state, { topic });
  else if (view.id === 'mindmap') renderMindMap(surface, state, { topic });
  else if (view.id === 'lab') renderPractice(surface, state, { topic, reload: boot });
  else if (view.id === 'teachback') renderTeachback(surface, state, { topic, reload: boot });
  else if (view.id === 'roles') activeCleanup = renderRoles(surface, state, { topic, refreshState: refreshStateQuietly });
  // currentView() only returns VIEWS entries, so this is reached only by a view added to
  // VIEWS without a branch above. Fail loudly rather than leave a blank page.
  else throw new Error(`no render branch for the "${view.id}" view`);
}

function renderError(err) {
  const main = document.getElementById('main');
  clear(main);
  const panel = el('div', { class: 'error-panel' });
  panel.append(
    el('h2', {}, 'Cockpit could not load its state'),
    el('p', {}, 'The server is reachable but /api/state failed. Check the server log — the stack is printed there.'),
    el('pre', {}, String(err?.message ?? err)),
  );
  main.append(panel);
}

async function refreshState() {
  state = await requestJson('/api/state');
  return state;
}

function refreshStateQuietly() {
  // A result panel has just told the learner what happened. Refresh the backing badges for
  // their next navigation without repainting that panel out from under them.
  return refreshState().catch((err) => console.error('Could not refresh cockpit state after a workflow result', err));
}

async function refreshAfterRecovery(banners) {
  // A settle changes what every other view and the banner count. Redraw the banners in
  // place so the one above Recovery stops naming work that is already done. The write can
  // finish after the learner has navigated away; the state still refreshes then, but the
  // old banners are no longer on the page, and the new view drew its own.
  await refreshStateQuietly();
  if (!banners.isConnected) return;
  clear(banners);
  renderIntegrityBanner(banners);
  renderUnavailableTopics(banners, state);
}

async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) ?? 'dark');
  try {
    await refreshState();
    render();
  } catch (err) {
    console.error(err);
    renderError(err);
  }
}

window.addEventListener('hashchange', () => recoveryWrites.afterWrites(() => state && render()));
boot();
