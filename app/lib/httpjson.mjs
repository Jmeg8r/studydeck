// WHAT: fetchJson, a bounded JSON request: a size cap, a deadline that covers the body, an
//       external abort, and a result that must be a JSON object.
// WHY:  A POST whose response becomes unusable may already have committed upstream, so a
//       broken response is reported as 502, never as a definite rejection. Media bodies are
//       long and go through media.mjs instead. Ported from 264547c for the chapter renderer
//       (D5d); ollama, tts and onFetch keep their own transport (renderer-foundations).
export async function fetchJson(url, { timeout = 15_000, maxBytes = 16 * 1024 * 1024, ...init } = {}) {
  const controller = new AbortController();
  const external = init.signal;
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeout}ms`)), timeout);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    if (response.status === 204) return null;
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('JSON response too large');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('JSON response too large');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('provider returned invalid JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('provider returned invalid JSON object');
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // A protocol failure must not masquerade as a definite upstream rejection:
    // a POST may have committed before its response became unusable.
    if (!error.status) error.status = 502;
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}
