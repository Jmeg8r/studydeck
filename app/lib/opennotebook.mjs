// WHAT: The single Open Notebook client. Every ON call in the cockpit goes through here.
// WHY: ON's API churns (SurrealDB v3 and a possible Celery move are on its roadmap), so
//      the blast radius of an upstream change is deliberately one file. It is also the
//      only place the bearer token is ever attached — the browser never sees it.
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { fetchMedia } from './media.mjs';
import { listModelNames } from './ollama.mjs';
import { displayEpisodeName } from './podcastbatch.mjs';
import { episodeNotebookIndex, notebookForEpisode } from './podcastcatalog.mjs';
import { normalizePodcastJob } from './podcastjob.mjs';
import { readOperations } from './sidecar.mjs';
import { listVoices } from './tts.mjs';

const TIMEOUT_MS = 15_000;
// Local gemma4 takes ~60s even on a few sentences, so generation gets its own budget.
// Measured 2026-07-19: 62s for ~450 chars of input on gemma4:31b-mlx.
const GENERATE_TIMEOUT_MS = 420_000;

/**
 * Endpoint shapes verified against a live v1.13.0 instance on 2026-07-19, read from
 * its own /openapi.json rather than assumed.
 *
 * Note the HYPHENS in the podcast routes. Earlier notes recorded `/api/episode_profiles`
 * and `/api/podcasts`, both of which 404 — the underscore form is the profile *name*
 * convention, not the URL.
 */
const ROUTES = {
  config: '/api/config',
  notebooks: '/api/notebooks',
  sources: '/api/sources',
  notes: '/api/notes',
  models: '/api/models',
  episodeProfiles: '/api/episode-profiles',
  episodes: '/api/podcasts/episodes',
  speakerProfiles: '/api/speaker-profiles',
  podcastGenerate: '/api/podcasts/generate',
  podcastJobs: '/api/podcasts/jobs',
  transformations: '/api/transformations',
  transformationExecute: '/api/transformations/execute',
};

/** ON's model-type value for text-to-speech; podcast audio needs one registered. */
const TTS_MODEL_TYPE = 'text_to_speech';
const AUDIO_DATE_TIMEOUT_MS = 5_000;

export class OpenNotebookError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Fetch from ON with the bearer attached server-side.
 * Never include the token in a thrown message or a log line.
 */
async function onFetch(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const { baseUrl, password } = config.openNotebook;
  if (!password) {
    throw new OpenNotebookError('Open Notebook password is not configured on the server', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${password}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // A dead or slow ON is an expected condition, not a crash — say so plainly.
    const reason = err.name === 'AbortError' ? `timed out after ${timeout}ms` : err.message;
    throw new OpenNotebookError(`Open Notebook unreachable at ${baseUrl} (${reason})`, 503);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new OpenNotebookError(`Open Notebook ${method} ${path} → ${res.status}`, res.status);
  }
  return res.json();
}

/** Version + reachability. Surfaces a mismatch rather than failing silently on drift. */
export async function health() {
  const { expectedVersion, baseUrl } = config.openNotebook;
  try {
    const info = await onFetch(ROUTES.config);
    const version = info.version ?? 'unknown';
    return {
      reachable: true,
      version,
      expected: expectedVersion,
      // Compare on the major.minor prefix — patch releases are not worth alarming about.
      mismatch: !String(version).startsWith(expectedVersion),
      db: info.dbStatus ?? null,
    };
  } catch (err) {
    return { reachable: false, version: null, expected: expectedVersion, mismatch: false, error: err.message, baseUrl };
  }
}

/** The ON notebook backing a cockpit topic, or null when none is mapped. */
export function notebookForTopic(topicSlug) {
  return config.topics.find((t) => t.slug === topicSlug)?.notebookId ?? null;
}

/** Creation uses a stable marker so an uncertain POST can be reconciled on retry. */
export async function listNotebooks() {
  return onFetch(ROUTES.notebooks);
}

export async function createNotebook({ name, description }) {
  return onFetch(ROUTES.notebooks, { method: 'POST', body: { name, description } });
}

/**
 * Sources in a notebook, chapter-ordered.
 * The list endpoint omits body text — that arrives via readSource().
 */
export async function listSources(notebookId) {
  const sources = await onFetch(`${ROUTES.sources}?notebook_id=${encodeURIComponent(notebookId)}`);
  return sources
    .map((s) => ({
      id: s.id,
      title: s.title ?? '(untitled)',
      created: s.created ?? null,
      embedded: Boolean(s.embedded),
      insights: s.insights_count ?? 0,
      status: s.status ?? null,
    }))
    // ON returns them unordered; titles carry a leading chapter number, so sort
    // numerically on that and fall back to alphabetical when there isn't one.
    .sort((a, b) => {
      const na = Number(a.title.match(/\b(\d{1,3})\b/)?.[1] ?? NaN);
      const nb = Number(b.title.match(/\b(\d{1,3})\b/)?.[1] ?? NaN);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
      return a.title.localeCompare(b.title);
    });
}

/** Add learner-selected material to the mapped notebook without exposing the ON token. */
export async function createSource({ notebookId, type, title, url, content }) {
  return onFetch(`${ROUTES.sources}/json`, {
    method: 'POST',
    body: {
      notebooks: [notebookId], type, title,
      ...(type === 'link' ? { url } : { content }),
      async_processing: true,
    },
  });
}

/** Read all source identities for an uncertain-create reconciliation. */
export async function sourceIdentities(notebookId) {
  const found = [];
  for (let offset = 0; ; offset += 100) {
    const page = await onFetch(`${ROUTES.sources}?notebook_id=${encodeURIComponent(notebookId)}&limit=100&offset=${offset}`);
    if (!Array.isArray(page)) throw new OpenNotebookError('Open Notebook source list is unreadable', 503);
    found.push(...page.map(({ id, title, asset }) => ({ id, title, url: asset?.url ?? null })));
    if (page.length < 100) return found;
  }
}

/**
 * The `/api/sources` payload exactly as ON sent it, unmapped.
 *
 * Only the contract probe (`lib/oncontract.mjs`, `npm run verify:live`) uses this. Every
 * other caller wants `listSources` above — mapping is what protects the app from upstream
 * shape changes, so bypassing it anywhere else would reintroduce the coupling the mapping
 * exists to remove. The probe needs the raw payload precisely because it is looking FOR
 * that change.
 */
export async function fetchSourcesRaw(notebookId) {
  return onFetch(`${ROUTES.sources}?notebook_id=${encodeURIComponent(notebookId)}`);
}

/** One source with its markdown body. */
export async function readSource(sourceId) {
  const source = await onFetch(`${ROUTES.sources}/${encodeURIComponent(sourceId)}`);
  return {
    id: source.id,
    title: source.title ?? '(untitled)',
    text: source.full_text ?? '',
    created: source.created ?? null,
    updated: source.updated ?? null,
  };
}

export async function listNotes(notebookId) {
  const notes = await onFetch(`${ROUTES.notes}?notebook_id=${encodeURIComponent(notebookId)}`);
  return notes.map((n) => ({ id: n.id, title: n.title, created: n.created }));
}

/**
 * Everything the Podcast view needs, in one call: which episode profiles exist, which
 * episodes have been rendered, and whether audio can be produced at all.
 *
 * `tts_ready` is the honest gate. ON has no text-to-speech model registered, so
 * generation would fail — the view says exactly that instead of offering a dead button.
 */
async function audioCompletedAt(episodeId) {
  const { baseUrl, password } = config.openNotebook;
  let response;
  try {
    response = await fetch(`${baseUrl}${ROUTES.episodes}/${encodeURIComponent(episodeId)}/audio`, {
      headers: { authorization: `Bearer ${password}`, range: 'bytes=0-0' },
      signal: AbortSignal.timeout(AUDIO_DATE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const modified = Date.parse(response.headers.get('last-modified') ?? '');
    return Number.isFinite(modified) ? new Date(modified).toISOString() : null;
  } catch {
    return null;
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

async function episodeCompletionDates(episodes) {
  const dates = new Map();
  // A one-byte range request reads the audio file's modification time. Keep the
  // request count bounded when the library grows beyond the current few episodes.
  for (let start = 0; start < episodes.length; start += 8) {
    const batch = episodes.slice(start, start + 8).filter((episode) => episode.audio_file ?? episode.audio_path);
    const results = await Promise.all(batch.map((episode) => audioCompletedAt(episode.id)));
    batch.forEach((episode, index) => dates.set(episode.id, results[index]));
  }
  return dates;
}

export async function podcastStatus() {
  const [profiles, episodes, ttsModels, openNotebooks] = await Promise.all([
    onFetch(ROUTES.episodeProfiles),
    onFetch(ROUTES.episodes),
    onFetch(`${ROUTES.models}?type=${TTS_MODEL_TYPE}`),
    onFetch(ROUTES.notebooks).catch(() => []),
  ]);

  const configured = config.topics.filter((topic) => topic.notebookId);
  const [topicSources, completionDates] = await Promise.all([
    Promise.all(configured.map(async (topic) => {
      const sources = await sourceIdentities(topic.notebookId).catch(() => null);
      return {
        slug: topic.slug,
        notebookId: topic.notebookId,
        sources: sources ?? [],
        source_unavailable: sources === null,
        operations: readOperations(topic.slug),
      };
    })),
    episodeCompletionDates(Array.isArray(episodes) ? episodes : []),
  ]);
  const notebookByName = episodeNotebookIndex(topicSources);
  const notebookNames = new Map((Array.isArray(openNotebooks) ? openNotebooks : [])
    .map((notebook) => [notebook.id, notebook.name]));

  return {
    tts_ready: Array.isArray(ttsModels) && ttsModels.length > 0,
    tts_model_type: TTS_MODEL_TYPE,
    notebook_matching_incomplete: topicSources.some((topic) => topic.source_unavailable),
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      segments: p.num_segments ?? null,
      language: p.language ?? null,
      speaker_config: p.speaker_config_name ?? p.speaker_config ?? null,
      // Migration 22 cleared legacy model strings on some profiles; surface that
      // rather than letting a generate call fail with an opaque error later.
      outline_model: p.outline_llm ?? null,
      transcript_model: p.transcript_llm ?? null,
    })),
    episodes: (Array.isArray(episodes) ? episodes : []).map((e) => {
      const name = e.name ?? e.title ?? '(untitled)';
      return {
        id: e.id,
        // The real name, which carries the ` · sd-…` identity tag (F10) and is what Open
        // Notebook itself shows. Kept so a row stays traceable from this payload.
        name,
        // What the cockpit prints. Stripping happens here rather than in the browser
        // because lib/podcastbatch.mjs imports node:crypto and cannot be loaded there.
        display_name: displayEpisodeName(name),
        created: e.created ?? null,
        completed_at: completionDates.get(e.id) ?? null,
        notebook_id: notebookForEpisode(notebookByName, name),
        status: e.job_status ?? e.status ?? null,
        audio_available: Boolean(e.audio_file ?? e.audio_path),
      };
    }),
    // Which topics can be a generation source. A topic with no notebook mapped cannot
    // be one, so it is omitted rather than offered and failing at submit.
    notebooks: config.topics
      .filter((t) => t.notebookId)
      .map((t) => ({ slug: t.slug, notebook_id: t.notebookId,
        name: notebookNames.get(t.notebookId) ?? t.slug })),
  };
}

/**
 * Lean episode list — id, name, and whether audio rendered. Used by the batch retry
 * path to decide which chapters still need generating (matched to a source by name).
 * Cheaper than podcastStatus(), which also fetches profiles and TTS models.
 */
export async function listEpisodes() {
  const episodes = await onFetch(ROUTES.episodes);
  return (Array.isArray(episodes) ? episodes : []).map((e) => ({
    id: e.id,
    name: e.name ?? e.title ?? '(untitled)',
    audio_available: Boolean(e.audio_file ?? e.audio_path),
    // Distinguishes a terminally FAILED row (safe to delete + re-queue) from one that is
    // still rendering (must be left alone). ON gives content-generated episodes no
    // notebook_id, so name is the only link back to a source.
    status: e.job_status ?? e.status ?? null,
    // Lets the pre-flight cleanup scope a delete to rows created by THIS batch.
    created: e.created ?? null,
  }));
}

/**
 * Delete one episode. Used to clear a stale FAILED row before re-generating that chapter,
 * so retries don't pile up dead duplicates. Raw fetch, not onFetch: DELETE may answer with
 * an empty body, which onFetch's unconditional res.json() would choke on.
 */
export async function deleteEpisode(episodeId) {
  const { baseUrl, password } = config.openNotebook;
  if (!password) throw new OpenNotebookError('Open Notebook password is not configured', 503);
  let res;
  try {
    res = await fetch(`${baseUrl}${ROUTES.episodes}/${encodeURIComponent(episodeId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${password}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    throw new OpenNotebookError(`Open Notebook unreachable at ${baseUrl} (${reason})`, 503);
  }
  if (!res.ok) throw new OpenNotebookError(`delete episode → ${res.status}`, res.status);
  return { deleted: true };
}

/**
 * Audio for one episode, as `{ status, headers, body }` for the route to pass through.
 *
 * Range, conditional and HEAD requests reach Open Notebook through `fetchMedia`, so a
 * player can seek and resume, and only its header deadline is bounded: the body streams
 * for as long as the client keeps reading (lib/media.mjs says why). Failures keep the
 * shapes every other call here uses: unreachable is a 503 naming Open Notebook, an
 * upstream error status is passed on as that status, and no upstream body crosses.
 */
export async function episodeAudio(episodeId, { method = 'GET', headers = {}, signal } = {}) {
  const { baseUrl, password } = config.openNotebook;
  if (!password) throw new OpenNotebookError('Open Notebook password is not configured', 503);

  try {
    return await fetchMedia(`${baseUrl}${ROUTES.episodes}/${encodeURIComponent(episodeId)}/audio`, {
      method, headers, signal, authorization: `Bearer ${password}`, headerTimeout: TIMEOUT_MS,
    });
  } catch (err) {
    if (err.status) throw new OpenNotebookError(`episode audio → ${err.status}`, err.status);
    if (signal?.aborted) throw err;
    throw new OpenNotebookError(`Open Notebook unreachable at ${baseUrl} (${err.message})`, 503);
  }
}

/** Named transformations, resolved by name so ids don't have to be hard-coded. */
export async function findTransformation(name) {
  const all = await onFetch(ROUTES.transformations);
  return all.find((t) => t.name === name) ?? null;
}

/**
 * Run a transformation over text. Slow by nature — this is a local 31B model — so it
 * carries the long timeout rather than the default one.
 */
export async function runTransformation(transformationId, inputText) {
  const result = await onFetch(ROUTES.transformationExecute, {
    method: 'POST',
    body: { transformation_id: transformationId, input_text: inputText },
    timeout: GENERATE_TIMEOUT_MS,
  });
  return { output: result.output ?? '', model: result.model_id ?? null };
}

/** Create a note. Used to round-trip a highlight back into the notebook. */
export async function createNote({ notebookId, title, content }) {
  return onFetch(ROUTES.notes, {
    method: 'POST',
    body: { notebook_id: notebookId, title, content, note_type: 'human' },
  });
}

/**
 * Speaker profiles, each carrying its speakers' names, backstories and voice ids.
 *
 * Voices live here rather than on the generate call, which is why choosing a voice at
 * generation time means creating a profile — see createSpeakerProfile.
 */
export async function listSpeakerProfiles() {
  const profiles = await onFetch(ROUTES.speakerProfiles);
  return (Array.isArray(profiles) ? profiles : []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    speakers: (p.speakers ?? []).map((s) => ({
      name: s.name,
      voice_id: s.voice_id ?? null,
      backstory: s.backstory ?? '',
      personality: s.personality ?? '',
    })),
  }));
}

/**
 * Create a reusable speaker profile.
 *
 * Note the route asymmetry if you ever need to *edit* one: GET resolves a profile by
 * NAME (`/api/speaker-profiles/tech_experts`) and 404s on the real `speaker_profile:xxx`
 * id, while PUT wants the id and rejects the name. Creation is on the collection route
 * and sidesteps both.
 */
export async function createSpeakerProfile({ name, description, speakers, voiceModel }) {
  // ON happily creates a profile with no voice_model, then fails the RENDER minutes
  // later with "has no voice model configured" — a failure a long way from its cause.
  // There is exactly one TTS model registered, so resolve it here rather than making
  // the user pick. If several are ever registered this needs to become a real choice.
  const voice_model = voiceModel ?? await ttsModelId();
  return onFetch(ROUTES.speakerProfiles, {
    method: 'POST',
    body: { name, description: description ?? '', speakers, voice_model },
  });
}

/** Record id of the registered text-to-speech model, or null when none is registered. */
export async function ttsModelId() {
  const models = await onFetch(`${ROUTES.models}?type=${TTS_MODEL_TYPE}`);
  return Array.isArray(models) && models.length > 0 ? (models[0].id ?? null) : null;
}

/**
 * Read-only check that a render with these profiles can run, before anything is sent.
 *
 * Open Notebook accepts a generate for a profile with no outline model, an unregistered
 * voice or an unpulled local model, and the job then fails late in the worker or never
 * starts. Migration 22 left the stock profiles in exactly that state. So the profile, its
 * models, the speakers' voices and the local models are checked first, and a refusal
 * names every missing piece. Returns the models that would be used.
 */
// Model references (outline_llm, transcript_llm, voice_model) are Open Notebook ids. The models
// they resolve to are pinned by name, provider and type below, so re-registering one can't move it.
const EPISODE_RENDER_FIELDS = ['language', 'default_briefing', 'num_segments', 'max_tokens'];
const SPEAKER_RENDER_FIELDS = ['name', 'voice_id', 'personality', 'backstory'];
const pick = (source, fields) => Object.fromEntries(fields.map((f) => [f, source?.[f] ?? null]));

/** JSON with keys sorted at every level, so Open Notebook's key order can't move a hash. */
const stableJson = (value) => (Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
    : JSON.stringify(value));

/**
 * What a render is made of: an allowlist of the fields that change what is generated or
 * voiced (renderer-foundations, James 2026-11-11). Names, descriptions, ids and any
 * bookkeeping field Open Notebook adds are left out, so they can never block a resume.
 */
function renderShape(profile, speaker, selected) {
  const snapshot = {
    version: 1,
    episode_profile: pick(profile, EPISODE_RENDER_FIELDS),
    speaker_profile: { speakers: (speaker?.speakers ?? []).map((s) => pick(s, SPEAKER_RENDER_FIELDS)) },
    models: Object.fromEntries(Object.entries(selected).map(([label, m]) => [label, pick(m, ['name', 'provider', 'type'])])),
  };
  return { ...snapshot, fingerprint: createHash('sha256').update(stableJson(snapshot)).digest('hex'), checked_at: new Date().toISOString() };
}

export async function podcastPreflight({ episodeProfile, speakerProfile }) {
  const [profiles, speakers, models] = await Promise.all([
    onFetch(ROUTES.episodeProfiles), onFetch(ROUTES.speakerProfiles), onFetch(ROUTES.models),
  ]);
  const profile = profiles.find((p) => p.name === episodeProfile);
  const speaker = speakers.find((p) => p.name === speakerProfile);
  const errors = [];
  const selected = {};
  for (const [label, id, type] of [
    ['outline', profile?.outline_llm, 'language'],
    ['transcript', profile?.transcript_llm, 'language'],
    ['voice', speaker?.voice_model, TTS_MODEL_TYPE],
  ]) {
    const model = models.find((m) => m.id === id && m.type === type);
    if (model) selected[label] = { id: model.id, name: model.name, provider: model.provider, type: model.type };
    else errors.push(`${label} model is unset or not registered`);
  }
  if (!profile) errors.unshift(`episode profile ${episodeProfile} is missing`);
  if (!speaker?.speakers?.length) errors.push(`speaker profile ${speakerProfile} has no speakers`);
  if (errors.length) throw new OpenNotebookError(`Generation unavailable: ${errors.join('; ')}`, 422);

  // The voice ids can only be checked against the TTS service this app is configured for.
  if (selected.voice.name !== config.tts.model) {
    throw new OpenNotebookError('Generation unavailable: the selected voice model is not the configured voice service', 422);
  }
  let voices;
  try {
    voices = new Set((await listVoices()).voices.map((v) => v.id));
  } catch (err) {
    throw new OpenNotebookError(`Generation unavailable: ${err.message}`, 503);
  }
  const missingVoices = speaker.speakers.filter((s) => !voices.has(s.voice_id)).map((s) => `${s.name}: ${s.voice_id ?? 'unset'}`);
  if (missingVoices.length) {
    throw new OpenNotebookError(`Generation unavailable: voices not available (${missingVoices.join(', ')})`, 422);
  }

  const localModels = Object.values(selected).filter((m) => m.provider === 'ollama');
  if (localModels.length) {
    // Ollama resolves an untagged name to `:latest` and always lists the tag, so both
    // sides are compared in that form.
    const tagged = (name) => (name.includes(':') ? name : `${name}:latest`);
    let pulled;
    try {
      pulled = new Set((await listModelNames()).map(tagged));
    } catch (err) {
      throw new OpenNotebookError(`Generation unavailable: ${err.message}`, 503);
    }
    const unpulled = [...new Set(localModels.map((m) => m.name))].filter((name) => !pulled.has(tagged(name)));
    if (unpulled.length) {
      throw new OpenNotebookError(`Generation unavailable: ${unpulled.join(', ')} not present in Ollama`, 422);
    }
  }
  return renderShape(profile, speaker, selected);
}

/**
 * Kick off an episode render. Returns a job id — ON does the work asynchronously, so
 * this resolves in about a second and the caller polls podcastJob for the outcome.
 *
 * `episodeProfile` and `speakerProfile` are NAMES, not ids.
 *
 * Material comes from EITHER `notebookId` (ON uses every source in the notebook) OR
 * `content` (a raw text blob ON uses verbatim). `content` is how a per-chapter episode
 * is scoped to one source instead of the whole notebook — pass the chapter's text and
 * leave notebookId null.
 */
export async function generatePodcast({
  episodeProfile, speakerProfile, episodeName, notebookId, content, briefingSuffix,
}) {
  const result = await onFetch(ROUTES.podcastGenerate, {
    method: 'POST',
    body: {
      episode_profile: episodeProfile,
      speaker_profile: speakerProfile,
      episode_name: episodeName,
      ...(notebookId ? { notebook_id: notebookId } : {}),
      ...(content ? { content } : {}),
      ...(briefingSuffix ? { briefing_suffix: briefingSuffix } : {}),
    },
  });
  return { job_id: result.job_id ?? null, status: result.status ?? null, message: result.message ?? '' };
}

/** Poll one render job. `status` drives the UI; `error_message` explains a failure. */
export async function podcastJob(jobId) {
  const job = await onFetch(`${ROUTES.podcastJobs}/${encodeURIComponent(jobId)}`);
  return normalizePodcastJob(job, jobId);
}
