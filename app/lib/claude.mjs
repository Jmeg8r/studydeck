// WHAT: Direct client for the Claude Messages API, used by the role sessions.
// WHY: Built on Node's own fetch rather than the official SDK, on purpose: `app/` has zero
//      runtime dependencies and CI proves it by running with no install step (AGENTS.md
//      rule 5). The cost is that retry, error mapping and refusal handling live here.
//
// This is the one module through which a secret and learner content leave the machine.
// Three things follow from that, and each is pinned in claudeegress.test.mjs:
//   - The key travels in the `x-api-key` header and nowhere else. A ClaudeError carries a
//     message and a status only, because router.mjs logs the error object on a 5xx.
//   - When the API is unreachable or the key is absent the caller gets a 503 naming the
//     service — the same contract as ollama.mjs, so a study flow is never left guessing.
//   - A response is read by block type and checked for shape. Anything else is a 502,
//     never a reply invented from whatever came back.
import { config, isUsableApiKey as usableKey } from './config.mjs';

const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 4_000;

/** Retries after the first attempt. Two matches what the official SDKs do by default. */
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 529]);
const RETRY_BASE_MS = 500;
/** A `retry-after` longer than this is reported to the learner instead of slept through. */
const MAX_RETRY_AFTER_MS = 20_000;

/** Upstream statuses that mean "the service will not serve us", as opposed to "we sent it wrong". */
const UNAVAILABLE_STATUSES = new Set([401, 402, 403, 429, 500, 529]);

const MAX_UPSTREAM_MESSAGE = 300;
const TOKENS_PER_MTOK = 1_000_000;

export class ClaudeError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

/**
 * Whether the account has refused the fallback beta header.
 *
 * Process-wide on purpose: the refusal is a property of the account, so once it is known
 * every later request skips the header instead of paying for the same 400 each turn. A
 * restart asks again, which is how a newly enabled beta gets picked up.
 */
let fallbacksRefused = false;

/** For tests: forget a downgrade learned from an earlier case. */
export function resetFallbackState() {
  fallbacksRefused = false;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip the key from text that came from somewhere this module does not control. */
function redact(text, apiKey) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (apiKey ? clean.split(apiKey).join('[redacted]') : clean).slice(0, MAX_UPSTREAM_MESSAGE);
}

const NOT_CONFIGURED =
  'The Claude API is not configured: give the process that starts the cockpit STUDYDECK_ANTHROPIC_API_KEY, ' +
  "as a single line with no spaces (see the README's External services section).";

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const upstreamMessage = (response, apiKey) => redact(parseJson(response.text)?.error?.message, apiKey);

function retryDelayMs(response, attempt) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  return RETRY_BASE_MS * 2 ** attempt;
}

/** A system error code such as ECONNRESET — a fixed vocabulary, safe to show. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * One HTTP exchange, body included, under a single deadline.
 *
 * The body is read here on purpose. fetch() resolves as soon as headers arrive, so a
 * deadline that ended there would leave the body read unbounded, and a response that
 * stalls halfway would hang the turn long past the timeout.
 *
 * A failure is described by its error code and never by the runtime's message, which is
 * not ours to vouch for: it can quote request headers.
 */
async function send(url, { method, headers, body, timeoutMs, hint = '' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
  } catch (err) {
    const code = err.cause?.code;
    const reason = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : typeof code === 'string' && ERROR_CODE.test(code) ? code : 'connection failed';
    throw new ClaudeError(`The Claude API is unreachable (${reason}).${hint}`);
  } finally {
    clearTimeout(timer);
  }
}

const numberOrZero = (value) => (Number.isFinite(value) ? value : 0);

function normalizeUsage(usage) {
  return {
    input_tokens: numberOrZero(usage?.input_tokens),
    output_tokens: numberOrZero(usage?.output_tokens),
    cache_read_input_tokens: numberOrZero(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: numberOrZero(usage?.cache_creation_input_tokens),
    // Kept because a cache write's price depends on its lifetime, and a session saved
    // before the one-hour change still asks for five minutes.
    cache_creation: {
      ephemeral_5m_input_tokens: numberOrZero(usage?.cache_creation?.ephemeral_5m_input_tokens),
      ephemeral_1h_input_tokens: numberOrZero(usage?.cache_creation?.ephemeral_1h_input_tokens),
    },
  };
}

/**
 * Dollars for one response, from token counts and a per-million price table.
 *
 * Cache writes are priced by the lifetime the API reports for them. Any part of the total
 * it does not break down is priced at the one-hour rate, so the spending meter can
 * over-report against the limit but never under-report.
 */
export function estimateCostUsd(usage, prices = config.claude.pricePerMTok) {
  const u = normalizeUsage(usage);
  const total = u.cache_creation_input_tokens;
  const fiveMinute = Math.min(u.cache_creation.ephemeral_5m_input_tokens, total);
  const oneHour = total - fiveMinute;
  return (
    u.input_tokens * prices.input +
    u.output_tokens * prices.output +
    u.cache_read_input_tokens * prices.cacheRead +
    fiveMinute * prices.cacheWrite +
    oneHour * prices.cacheWrite1h
  ) / TOKENS_PER_MTOK;
}

/**
 * Send one Messages request and return the reply.
 *
 * `content` is the API's block array, untouched. Callers that continue a conversation
 * must store and replay it as-is: the model's thinking blocks are bound to the exact
 * conversation that produced them, so a transcript holding only `text` cannot be resumed.
 *
 * No `thinking` field is sent. On the configured model thinking is always on and every
 * explicit setting other than adaptive is rejected; `effort` is the control.
 */
export async function createMessage({
  system,
  messages,
  maxTokens,
  effort,
  model = config.claude.model,
  apiKey = config.claude.apiKey,
  baseUrl = config.claude.baseUrl,
  timeoutMs = TIMEOUT_MS,
  sleep = defaultSleep,
}) {
  if (!usableKey(apiKey)) throw new ClaudeError(NOT_CONFIGURED);

  for (let attempt = 0; ; attempt += 1) {
    const withFallbacks = !fallbacksRefused;
    const res = await send(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        ...(withFallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: { effort },
        ...(withFallbacks ? { fallbacks: 'default' } : {}),
      }),
      timeoutMs,
      // Said only where it is true: this path carries something the learner wrote. The
      // health probe shares `send` and carries nothing.
      hint: ' Your text is kept; try again.',
    });

    if (res.ok) return readMessage(res, withFallbacks);

    const detail = upstreamMessage(res, apiKey);

    // A beta header the account does not have is a 400 naming the header. Drop it once and
    // resend; this does not count against the retry budget, which is for a busy service.
    if (res.status === 400 && withFallbacks && detail.includes('anthropic-beta')) {
      fallbacksRefused = true;
      attempt -= 1;
      continue;
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      const delay = retryDelayMs(res, attempt);
      if (delay <= MAX_RETRY_AFTER_MS) {
        await sleep(delay);
        continue;
      }
    }

    const status = UNAVAILABLE_STATUSES.has(res.status) ? 503 : 502;
    throw new ClaudeError(`The Claude API returned ${res.status}${detail ? `: ${detail}` : ''}.`, status);
  }
}

function readMessage(response, fallbacksEnabled) {
  const body = parseJson(response.text);
  if (body?.type !== 'message' || !Array.isArray(body.content)) {
    throw new ClaudeError('The Claude API answered with something that is not a message.', 502);
  }

  const refusal = body.stop_reason === 'refusal';
  return {
    content: body.content,
    // Read by type, never by position: a reply can open with thinking blocks.
    text: refusal ? '' : body.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim(),
    stopReason: body.stop_reason ?? null,
    refusal,
    model: typeof body.model === 'string' ? body.model : null,
    usage: normalizeUsage(body.usage),
    fallbacksEnabled,
  };
}

/**
 * Whether the roles can run: a key is present, the API answers, and it accepts the key.
 *
 * Probes the Models endpoint, which costs nothing. Reporting an outage is this function's
 * success, so it never throws — the route serving it answers 200 either way.
 */
export async function health({
  model = config.claude.model,
  apiKey = config.claude.apiKey,
  baseUrl = config.claude.baseUrl,
} = {}) {
  if (!usableKey(apiKey)) return { configured: false, reachable: false, authorized: false, model };
  try {
    const res = await send(`${baseUrl}/v1/models/${encodeURIComponent(model)}`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    if (res.ok) return { configured: true, reachable: true, authorized: true, model };
    // The API's own reason is passed on (key redacted). A bare status cannot tell a bad
    // key from a bad model name from a malformed request, and those need different fixes.
    const detail = upstreamMessage(res, apiKey);
    return {
      configured: true,
      reachable: true,
      authorized: false,
      model,
      error: `The Claude API returned ${res.status}${detail ? `: ${detail}` : ''}.`,
    };
  } catch (err) {
    return { configured: true, reachable: false, authorized: false, model, error: err.message };
  }
}
