// WHAT: The one request boundary for browser modules.
// WHY: Each view used to reimplement JSON headers and error parsing. Small differences
//      mattered: a 204 could throw, an HTML error became an opaque parse failure, and a
//      future retry helper could accidentally mint a second mutation id. Keeping the
//      boundary dependency-free makes those semantics testable in node:test.
import { withMutationId } from './mutation.mjs';

const MAX_ERROR_MESSAGE = 500;

/** A browser-safe HTTP failure, with enough context for a view to choose its state. */
export class ApiError extends Error {
  constructor({ status, message, payload }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function safeMessage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_ERROR_MESSAGE) : fallback;
}

/** Parse JSON when present; an empty or non-JSON response has an explicit null payload. */
export async function parseJsonBody(res) {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Send one request. This never retries: the caller decides whether the action is safe to
 * repeat, and mutation-bearing callers must retain their original id across that choice.
 */
export async function requestJson(path, { method = 'GET', body, headers, signal } = {}) {
  // This function serializes the body. A string here was already serialized, would be
  // sent as a JSON string rather than an object, and the server refuses that with a 400.
  if (typeof body === 'string') {
    throw new TypeError(`requestJson(${path}): pass the body as an object, not a string — it is serialized here`);
  }
  const requestHeaders = new Headers(headers ?? {});
  const init = { method, headers: requestHeaders, signal };
  if (body !== undefined) {
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);
  const payload = await parseJsonBody(res);
  if (!res.ok) {
    const fallback = `${path} → ${res.status}`;
    throw new ApiError({
      status: res.status,
      message: safeMessage(payload?.error, fallback),
      payload,
    });
  }
  return payload;
}

/**
 * Optional mutation integration for POST-like appends. `withMutationId` owns reuse after a
 * failed response and clearing after success; this helper only puts that id on the wire.
 */
export function requestJsonWithMutation(path, { mutationKey, body = {}, mutationField = 'mutation_id', ...options }) {
  if (!mutationKey) return requestJson(path, { ...options, body });
  return withMutationId(mutationKey, (mutationId) => requestJson(path, {
    ...options,
    body: { ...body, [mutationField]: mutationId },
  }), { payload: { path, body } });
}
