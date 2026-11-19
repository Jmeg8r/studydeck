// Create a real Open Notebook notebook and a valid, empty learn-anything topic.
// A marker in ON lets a retry reconcile a POST whose response was lost.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { writeFileAtomicSync, writeJsonAtomicSync } from './atomic.mjs';
import { createNotebook, listNotebooks } from './opennotebook.mjs';
import { render } from '../../.claude/skills/learn-anything-topic/scripts/render.mjs';
import { validateStateV1 } from '../../.claude/skills/learn-anything-topic/scripts/utils.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
let queue = Promise.resolve();

function slugFor(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '');
}

function create(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
    throw Object.assign(new Error('Notebook name must be 1–80 characters'), { status: 400 });
  }
  const title = name.trim();
  const slug = slugFor(title);
  if (!slug) throw Object.assign(new Error('Use at least one letter or number in the notebook name'), { status: 400 });
  if (config.topics.some((topic) => topic.slug === slug)) throw conflict('A notebook with this name already exists');

  // Do not overwrite an external config edit made while this server was running.
  const saved = JSON.parse(readFileSync(config.configPath, 'utf8'));
  if (JSON.stringify(saved.topics) !== JSON.stringify(config.topics)) {
    throw conflict('Notebook configuration changed on disk; restart StudyDeck and try again');
  }

  return createAfterPreflight(title, slug, saved);
}

async function createAfterPreflight(title, slug, saved) {
  const dir = join(config.learnRoot, slug);
  const statePath = join(dir, 'state.json');
  const draft = { version: 1, topic: title, slug, created: new Date().toISOString().slice(0, 10), domains: [] };
  if (existsSync(statePath)) {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    if (current.slug !== slug || current.topic !== title || current.domains?.length) {
      throw conflict('A different study topic already uses this notebook name');
    }
  } else if (existsSync(dir)) {
    throw conflict('A study topic directory already uses this notebook name');
  }
  if (validateStateV1(draft).length) throw new Error('New topic failed learn-anything validation');

  const marker = `StudyDeck topic: ${slug}`;
  const notebooks = await listNotebooks();
  if (!Array.isArray(notebooks)) throw Object.assign(new Error('Open Notebook notebook list is unreadable'), { status: 503 });
  const matches = notebooks.filter((notebook) => notebook.description === marker);
  if (matches.length > 1) throw conflict('Multiple Open Notebook notebooks carry this StudyDeck marker');
  const notebook = matches[0] ?? await createNotebook({ name: title, description: marker });
  if (typeof notebook?.id !== 'string' || !notebook.id) {
    throw Object.assign(new Error('Open Notebook did not return a notebook id; retry to reconcile'), { status: 503 });
  }

  mkdirSync(join(dir, 'sessions'), { recursive: true });
  if (!existsSync(statePath)) writeJsonAtomicSync(statePath, draft);
  // This is learn-anything's own render.mjs, applied immediately after state.json.
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileAtomicSync(join(dir, 'knowledge-map.md'), render(state));
  const topic = { slug, ring: 'outer', notebookId: notebook.id };
  writeJsonAtomicSync(config.configPath, { ...saved, topics: [...saved.topics, topic] });
  config.topics.push(topic);
  return { slug, name: title, notebook_id: notebook.id, draft: true };
}

/** Serialize creations so two requests cannot lose each other's config update. */
export function createStudyNotebook(name) {
  const result = queue.then(() => create(name));
  queue = result.catch(() => {});
  return result;
}
