// Reviewable Higgsfield storyboard preparation. No request in this module goes
// to Higgsfield; private source excerpts reach only the configured local model.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, config } from './config.mjs';
import { readJsonSafe, writeJsonAtomicSync } from './atomic.mjs';
import { collectSources, listJobs } from './videogeneration.mjs';
import { higgsfieldStoryboardFromSources } from './ollama.mjs';

const DEFAULT_DIR = resolve(process.env.STUDYDECK_VIDEO_DIR || join(REPO_ROOT, 'docs'), '.higgsfield-prep');
const HIGGSFIELD_JOB_DAMAGED = 'Higgsfield storyboard state is damaged';
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const tidy = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (value) => tidy(value).split(/\s+/).filter(Boolean).length;

export function normalizeStoryboard(value, knownSources) {
  const scenes = value?.scenes;
  if (!Array.isArray(scenes) || scenes.length < 3 || scenes.length > 5) {
    throw fail('The local model did not return 3 to 5 Higgsfield scenes');
  }
  return scenes.map((scene, index) => {
    const title = tidy(scene?.title);
    const visualPrompt = tidy(scene?.visual_prompt);
    const narration = tidy(scene?.narration);
    const sourceIds = scene?.source_ids;
    if (!title || title.length > 72 || visualPrompt.length < 40 || visualPrompt.length > 500
      || words(narration) < 10 || words(narration) > 100) {
      throw fail(`The local model returned an incomplete or oversized scene ${index + 1}`);
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0
      || sourceIds.some((id) => !knownSources.has(id))) {
      throw fail(`The local model returned an invalid source anchor on scene ${index + 1}`);
    }
    return { title, visual_prompt: visualPrompt, narration, source_ids: [...new Set(sourceIds)] };
  });
}

export function higgsfieldPrompt(topicName, scenes) {
  const header = `Create a 16:9 educational video about ${topicName}. Follow the scene order below. ` +
    'Use the narration text as the factual script. Do not add factual claims, readable on-screen text, logos, or copyrighted characters. ' +
    'Make the visual style and lighting consistent across scenes. Keep transitions clear and calm for a learner.';
  const shots = scenes.map((scene, index) => [
    `Scene ${index + 1}: ${scene.title}`,
    `Visual: ${scene.visual_prompt}`,
    `Narration: ${scene.narration}`,
  ].join('\n'));
  return [header, ...shots].join('\n\n');
}

async function prepare(job, update) {
  update('Reading notebook sources');
  const { sources, total } = await collectSources(job.notebook_id);
  update('Writing a Higgsfield storyboard with the local model');
  const scenes = normalizeStoryboard(await higgsfieldStoryboardFromSources(job.topic_name, sources),
    new Set(sources.map((source) => source.id)));
  return { scenes, prompt: higgsfieldPrompt(job.topic_name, scenes),
    source_count: total, used_sources: sources.map((source) => ({ id: source.id, title: source.title })),
    omitted_sources: total - sources.length, model: config.ollama.model };
}

export function createHiggsfieldService({ dir = DEFAULT_DIR, prepare: prepareJob = prepare } = {}) {
  mkdirSync(dir, { recursive: true });
  const active = new Set();
  const pathFor = (id) => join(dir, `${id}.json`);
  // Damage is a value, not an exception: get() refuses it, list() reports it and lists the
  // rest. A thrown error from anywhere else still propagates from both.
  const read = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const { value, source } = readJsonSafe(pathFor(id), null);
    if (source === 'fallback') return { damaged: true };
    if (!value) return null;
    return { job: value.status === 'running' && !active.has(id)
      ? { ...value, status: 'failed', error: 'Preparation was interrupted by a server restart. Start a new storyboard.' }
      : value };
  };
  const get = (id) => {
    const found = read(id);
    if (found?.damaged) throw fail(HIGGSFIELD_JOB_DAMAGED, 500);
    return found?.job ?? null;
  };
  const list = () => listJobs(readdirSync(dir).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
    .map((file) => file.slice(0, -5)), read, HIGGSFIELD_JOB_DAMAGED);
  const start = ({ topicSlug, topicName, notebookId, mutationId }) => {
    // A damaged storyboard file can't be read, so a replay whose mutation_id is inside one
    // prepares a second storyboard. Accepted: local compute only (job-list-damage spec F2).
    const replay = list().find((job) => job.status !== 'damaged' && job.mutation_id === mutationId);
    if (replay) {
      if (replay.topic_slug !== topicSlug || replay.notebook_id !== notebookId) {
        throw fail('mutation_id was already used for a different notebook', 409);
      }
      return replay;
    }
    if (active.size) throw fail('A Higgsfield storyboard is already being prepared.', 409);
    const id = randomUUID();
    const job = { id, topic_slug: topicSlug, topic_name: topicName ?? topicSlug,
      notebook_id: notebookId, mutation_id: mutationId,
      status: 'running', progress: 'Queued', created_at: new Date().toISOString() };
    writeJsonAtomicSync(pathFor(id), job);
    active.add(id);
    const update = (progress) => writeJsonAtomicSync(pathFor(id), { ...get(id), progress });
    Promise.resolve().then(async () => {
      try {
        const result = await prepareJob(job, update);
        writeJsonAtomicSync(pathFor(id), { ...get(id), ...result, status: 'prepared', progress: 'Ready',
          completed_at: new Date().toISOString() });
      } catch (err) {
        writeJsonAtomicSync(pathFor(id), { ...get(id), status: 'failed', error: tidy(err.message).slice(0, 350),
          completed_at: new Date().toISOString() });
      } finally {
        active.delete(id);
      }
    });
    return job;
  };
  return { start, get, list };
}

export const higgsfieldService = createHiggsfieldService();
