// WHAT: A tiny Open Notebook admin client for the export/restore CLI scripts.
// WHY:  The request-path client (app/lib/opennotebook.mjs) is deliberately minimal and
//       browser-safe — it never writes episode profiles or lists models with provider
//       metadata. These offline admin scripts need both, so they get their own client
//       rather than widening the request-path one's blast radius. The bearer token is
//       still resolved server-side via the shared config loader and never printed.
import { config } from '../lib/config.mjs';

const TIMEOUT_MS = 15_000;

export class OnError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Fetch from ON with the bearer attached. Never put the token in a message or a log. */
export async function onFetch(path, { method = 'GET', body } = {}) {
  const { baseUrl, password } = config.openNotebook;
  if (!password) {
    throw new OnError(
      `Open Notebook password not configured — check ${config.openNotebook.envFile} for ${config.openNotebook.passwordKey}`,
      503,
    );
  }
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${password}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    throw new OnError(`Open Notebook unreachable at ${baseUrl} (${reason})`, 503);
  }
  if (!res.ok) {
    // Include the response body — ON's validation errors (400/422) name the bad field,
    // and losing that turns a two-minute fix into a guessing game.
    let detail = '';
    try {
      detail = ` — ${(await res.text()).slice(0, 500)}`;
    } catch {
      /* body already consumed or empty; the status alone still tells the story */
    }
    throw new OnError(`ON ${method} ${path} → ${res.status}${detail}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const baseUrl = config.openNotebook.baseUrl;

// ---- Models ---------------------------------------------------------------------------
// Profiles reference models by SurrealDB record id (model:xxx), which is instance-specific
// and drifts across rebuilds. The portable identity is (provider, type, name) — e.g.
// (ollama, language, qwen2.5:7b-instruct) — so every export resolves ids OUT to that triple
// and every restore resolves them back IN against the target instance's own models.
// Provider is part of it because two providers can register the same model name.

/** All registered models as {id, type, provider, name}. */
export async function listModels() {
  const models = await onFetch('/api/models');
  return (Array.isArray(models) ? models : []).map((m) => ({
    id: m.id,
    type: m.type,
    provider: m.provider,
    name: m.name,
  }));
}

/** Build id→{provider,type,name} and portable-ref→id lookups from a model list. */
export function modelIndex(models) {
  const byId = new Map(models.map((m) => [m.id, m]));
  return {
    /** Record id → portable { provider, type, name }, or null for a null/absent id. */
    idToRef: (id) => {
      if (!id) return null;
      const m = byId.get(id);
      if (!m) throw new OnError(`model id ${id} is referenced by a profile but not registered in ON`, 404);
      return { provider: m.provider, type: m.type, name: m.name };
    },
    /**
     * A plain name (legacy) or a portable { provider, type, name } → record id, or null
     * when nothing registered here matches. A name more than one provider registers is
     * refused rather than resolved to whichever was listed last.
     */
    refToId: (type, ref, provider = null) => {
      let name = ref;
      if (ref && typeof ref === 'object') {
        if (ref.type && ref.type !== type) {
          throw new OnError(`model ${ref.provider}/${ref.name} has type ${ref.type}, but this slot needs type ${type}`, 422);
        }
        ({ name, provider = null } = ref);
      }
      const matches = models.filter(
        (m) => m.type === type && m.name === name && (!provider || m.provider === provider),
      );
      if (matches.length > 1) {
        throw new OnError(
          `ambiguous model ${type}/${name}: registered by ${matches.map((m) => m.provider).join(', ')}; name the provider`,
          422,
        );
      }
      return matches[0]?.id ?? null;
    },
  };
}

// ---- Profiles -------------------------------------------------------------------------

export const listEpisodeProfiles = () => onFetch('/api/episode-profiles');
export const listSpeakerProfiles = () => onFetch('/api/speaker-profiles');

/** Create (POST collection) or update (PUT by id) — restore uses whichever fits. */
export const createEpisodeProfile = (body) => onFetch('/api/episode-profiles', { method: 'POST', body });
export const updateEpisodeProfile = (id, body) =>
  onFetch(`/api/episode-profiles/${encodeURIComponent(id)}`, { method: 'PUT', body });
export const createSpeakerProfile = (body) => onFetch('/api/speaker-profiles', { method: 'POST', body });
export const updateSpeakerProfile = (id, body) =>
  onFetch(`/api/speaker-profiles/${encodeURIComponent(id)}`, { method: 'PUT', body });
