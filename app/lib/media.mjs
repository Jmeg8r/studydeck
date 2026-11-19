// WHAT: Fetch a media resource from an upstream we proxy (Open Notebook's episode audio),
//       with range and conditional requests passed through.
// WHY: docs/changes/2026-11-09-seekable-episode-audio. The proxy used to put one 15 s
//      AbortSignal.timeout on the whole fetch, which also aborted the BODY: any client
//      reading slower than "all at once" lost the end of the episode. And it dropped
//      Range, so a player could neither seek nor resume. This splits the deadline in two —
//      response headers must arrive in `headerTimeout`; after that only `idleTimeout`
//      without upstream bytes aborts — and never imposes a total download deadline.
//
// Ported from PR #98's snapshot (264547c), with a narrower header list: only what a player
// needs crosses to the browser.
import { Readable } from 'node:stream';

/** Browser headers worth sending upstream. Nothing else — cookies stay here. */
const REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
/** Upstream headers a player needs. Nothing else reaches the browser. */
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
/** Statuses with defined media semantics; anything else is an error, never streamed. */
const PASS_THROUGH = new Set([200, 206, 304, 416]);

/**
 * Returns `{ status, headers, body }`: `body` is a Node Readable, or null for HEAD and 304.
 * Throws with `.status` set for an upstream status outside PASS_THROUGH; network failures
 * and deadlines throw as they come from fetch, for the caller to map.
 *
 * `signal` aborts the upstream request (the route ties it to the client going away).
 */
export async function fetchMedia(url, {
  method = 'GET', headers = {}, authorization, signal,
  headerTimeout = 15_000, idleTimeout = 30_000,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', abort);

  const upstreamHeaders = new Headers();
  if (authorization) upstreamHeaders.set('authorization', authorization);
  const supplied = new Headers(headers);
  for (const name of REQUEST_HEADERS) if (supplied.has(name)) upstreamHeaders.set(name, supplied.get(name));
  // identity: a byte range of a compressed body would not be a range of the audio. fetch
  // appends it itself to any request carrying Range (Fetch standard), so only set it here
  // when there is none, or upstream receives it twice.
  if (!upstreamHeaders.has('range')) upstreamHeaders.set('accept-encoding', 'identity');

  const headerTimer = setTimeout(() => controller.abort(new Error('media response headers timed out')), headerTimeout);
  let response;
  let headProbe = false;
  try {
    response = await fetch(url, { method, headers: upstreamHeaders, signal: controller.signal });
    if (method === 'HEAD' && (response.status === 405 || response.status === 501)) {
      // Open Notebook answers HEAD with 405. A one-byte GET carries the same headers, and
      // its content-range names the full length.
      await response.body?.cancel();
      upstreamHeaders.set('range', 'bytes=0-0');
      upstreamHeaders.delete('if-range');
      response = await fetch(url, { method: 'GET', headers: upstreamHeaders, signal: controller.signal });
      headProbe = true;
    }
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    clearTimeout(headerTimer);
  }

  if (!PASS_THROUGH.has(response.status)) {
    await response.body?.cancel();
    cleanup();
    throw Object.assign(new Error(`media request → ${response.status}`), { status: response.status });
  }

  const forwarded = {};
  for (const name of RESPONSE_HEADERS) if (response.headers.has(name)) forwarded[name] = response.headers.get(name);
  let status = response.status;
  if (headProbe && status === 206) {
    const total = /\/(\d+)$/.exec(forwarded['content-range'] ?? '')?.[1];
    if (total) forwarded['content-length'] = total;
    else delete forwarded['content-length'];
    delete forwarded['content-range'];
    status = 200;
  }

  if (method === 'HEAD' || status === 304) {
    await response.body?.cancel();
    cleanup();
    return { status, headers: forwarded, body: null };
  }
  if (!response.body) {
    cleanup();
    throw Object.assign(new Error('upstream returned no media body'), { status: 502 });
  }

  const reader = response.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        // The idle clock runs only while waiting on upstream, never while a slow client
        // holds the yielded chunk under backpressure: slow listening is not a stall.
        const idle = setTimeout(() => controller.abort(new Error('media stream stalled')), idleTimeout);
        let part;
        try {
          part = await reader.read();
        } finally {
          clearTimeout(idle);
        }
        if (part.done) return;
        yield part.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      cleanup();
    }
  }
  return { status, headers: forwarded, body: Readable.from(chunks(), { objectMode: false }) };
}
