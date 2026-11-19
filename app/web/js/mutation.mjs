// WHAT: Minting the `mutation_id` that makes an append idempotent, once per intent.
// WHY: The server deduplicates appends by this id (AGENTS.md rule 9), but that protection
//      only exists if the CLIENT mints it once and reuses it across retries. A fresh id per
//      attempt makes every request unique by construction, so `appendUnique` still runs and
//      still protects nothing — dedupe that looks present in the route code and is inert in
//      practice. Three views did exactly that, and a double-clicked flashcard review could
//      be logged twice against a card whose rung is its consecutive-hit streak.
//
//      The rule was already written down and already violated in three places, which is the
//      argument for one helper rather than a fourth hand-rolled copy of it.
//
//      Ids live in this tab's sessionStorage too, so a reload after a lost response still
//      retries under the original id. A saved id is bound to a fingerprint of its request:
//      many keys name the action, not its content (`attempt:<topic>:<deck>` is every take of
//      a deck), and the server's dedupe is first-wins, so reusing an id for DIFFERENT input
//      would hand back the earlier result and silently drop the new one. Storage holds
//      hashes of the key and the request, never their text: some keys carry content (a
//      highlighted passage, a pasted source), and requests carry the learner's answers.

const STORAGE_KEY = 'studydeck.pending-intents.v1';
const STORAGE_VERSION = 1;
const MAX_SAVED_INTENTS = 50;

/** Intents that have not yet succeeded, keyed by the intent: `{ id, fp, kh, created }`. */
const inFlight = new Map();
/** Intents saved before this page loaded and not yet asked for again, keyed by key hash. */
const restored = new Map();
let storageWarned = false;

function warnStorage(err) {
  if (storageWarned) return;
  storageWarned = true;
  console.warn(`StudyDeck: this tab cannot keep retry ids across a reload (${err?.message ?? err}).`);
}

function restore() {
  let raw;
  try {
    raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
  } catch (err) {
    warnStorage(err);
    return;
  }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved?.version !== STORAGE_VERSION || !Array.isArray(saved.intents)) return;
    for (const item of saved.intents) {
      if (typeof item?.kh !== 'string' || typeof item.id !== 'string' || typeof item.fp !== 'string') continue;
      restored.set(item.kh, { id: item.id, fp: item.fp, kh: item.kh, created: item.created });
    }
  } catch (err) {
    warnStorage(err);
  }
}

/** Save the fingerprinted intents, newest first, capped. Unbound ids stay in memory only. */
function persist() {
  const intents = [...inFlight.values(), ...restored.values()]
    .filter((entry) => entry.fp)
    .map(({ kh, id, fp, created }) => ({ kh, id, fp, created }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, MAX_SAVED_INTENTS);
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, intents }));
  } catch (err) {
    warnStorage(err);
  }
}

/** JSON with object keys sorted, so field order never changes the fingerprint. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const BLOCK_BYTES = 64;
const LENGTH_BYTES = 8;
const TWO_TO_32 = 2 ** 32;

/**
 * SHA-256 of `text` as hex, computed synchronously.
 *
 * Not `crypto.subtle.digest`: that is async, and an `await` before the id is reserved lets
 * a double click's first request succeed and clear the id before the second reserves one,
 * so the two record twice (Codex review of PR #141). The test suite checks this against
 * `crypto.subtle` so the two can't drift.
 */
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil((bytes.length + 1 + LENGTH_BYTES) / BLOCK_BYTES) * BLOCK_BYTES;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / TWO_TO_32));
  view.setUint32(total - 4, bits >>> 0);

  const hash = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < total; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d;
    hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** Hash of the request without its own `mutation_id`, which is the thing being chosen. */
function fingerprint(payload) {
  const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : payload;
  if (request && typeof request === 'object') delete request.mutation_id;
  return sha256(canonical(request));
}

restore();

/**
 * Run `send(mutationId)` under a stable id for `key`.
 *
 * The id survives a rejection on purpose: a failed request is the case a retry has to be
 * deduplicated against, and the commonest failure is a response lost AFTER the write
 * landed. Clearing on success is what makes the next click a new intent rather than a
 * replay of the last one.
 *
 * `key` identifies the intent, not the request — "hit on card X" and "miss on card X" are
 * different intents and must not share an id, or the second would be swallowed as a replay
 * of the first.
 *
 * `payload` is the request body being sent. With it, the id is saved for this tab and
 * reused only for the same request; a different request under the same key is a new
 * intent. Without it, the id is kept in memory only and reused for any request under `key`.
 */
export function withMutationId(key, send, { payload } = {}) {
  const fp = payload === undefined ? null : fingerprint(payload);
  const kh = fp ? sha256(key) : null;
  let entry = inFlight.get(key);
  if (!entry && kh && restored.has(kh)) {
    entry = restored.get(kh);
    restored.delete(kh);
    inFlight.set(key, entry);
  }
  if (entry && fp && entry.fp && entry.fp !== fp) entry = null;
  if (!entry) {
    entry = { id: crypto.randomUUID(), fp, kh, created: new Date().toISOString() };
    inFlight.set(key, entry);
    if (fp) persist();
  }

  return Promise.resolve(send(entry.id)).then((result) => {
    // Concurrent calls share one entry, and an edit may have replaced it meanwhile.
    if (inFlight.get(key) === entry) {
      inFlight.delete(key);
      if (entry.fp) persist();
    }
    return result;
  });
}

/**
 * Start a deliberately new intent after the learner changes the submission.
 *
 * This is intentionally explicit: a transport or server failure must retain the id, but
 * an edit means the next click is no longer a retry of the already-submitted payload.
 */
export function resetMutationId(key) {
  const entry = inFlight.get(key);
  inFlight.delete(key);
  // An id saved before a reload is not in memory until it is asked for again.
  const savedBeforeReload = restored.delete(sha256(key));
  if (entry?.fp || savedBeforeReload) persist();
}
