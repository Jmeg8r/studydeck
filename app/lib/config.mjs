// WHAT: Loads cockpit.config.json and resolves paths + the Open Notebook secret.
// WHY: One boot-time load keeps the secret server-side and off every request path;
//      nothing here is ever serialized into an API response.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(APP_DIR);

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * Parse a dotenv-style file for one key. Returns null when the file or key is
 * absent — a missing ON password degrades the proxy, it does not stop boot.
 */
function readEnvValue(envPath, key) {
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Used when a config file has no `claude` block — a fixture config written before the
 * roles existed, or one supplied through STUDYDECK_CONFIG_PATH. Prices are US dollars per
 * million tokens and only feed the per-session spending estimate.
 */
const DEFAULT_CLAUDE = Object.freeze({
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5-5',
  effort: Object.freeze({ interviewer: 'low', socratic: 'low', sparring: 'low', diagnostician: 'medium' }),
  // cacheWrite is the five-minute rate (1.25x input) and keeps that meaning, so a config file
  // written before the one-hour lifetime still means what it says. cacheWrite1h (2x input)
  // prices one-hour writes, which is the lifetime sessions now ask for.
  pricePerMTok: Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }),
});

/**
 * A key is sent as an HTTP header value, so it has to be one: printable ASCII, no spaces.
 *
 * Checked by us rather than left to fetch, because the runtime's complaint about a header
 * it will not send quotes the header VALUE — a key pasted with a trailing newline would be
 * read back to the browser in the error. A key that fails this is treated as absent.
 */
const USABLE_API_KEY = /^[\x21-\x7e]+$/;
export const isUsableApiKey = (value) => typeof value === 'string' && USABLE_API_KEY.test(value);

/**
 * Host names that mean "this machine, addressed literally".
 *
 * A rebinding attack has to put an attacker-controlled DOMAIN in `Host` — that is the whole
 * mechanism, a name whose A record flips to 127.0.0.1 after the page loads. Accepting only
 * literals defeats it without pinning a port, which matters because the test suite attaches
 * this handler to an ephemeral one and a config-derived port would make the tests prove
 * something the browser never exercises. Here rather than in guard.mjs, which imports this
 * module, so that parseTailnet can refuse the same names.
 */
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The one tailnet name the cockpit also answers on, from the LaunchAgent's environment.
 *
 * Tailscale Serve terminates HTTPS on the tailnet and proxies to this loopback port with the
 * tailnet name in Host and the signed-in user in Tailscale-User-Login; guard.mjs admits that
 * Host only with that user. Deployment state, so it comes from the environment and never
 * from the committed config (rule 6). Neither variable set means the door is off. One
 * without the other, or an origin that is not a bare HTTPS origin, throws: a half-configured
 * boundary must stop the server, not quietly stay shut or open wider than intended.
 * docs/changes/2026-11-09-tailnet-access.
 */
export function parseTailnet(env) {
  const rawOrigin = env.STUDYDECK_TAILSCALE_ORIGIN?.trim();
  const user = env.STUDYDECK_TAILSCALE_USER?.trim();
  if (!rawOrigin && !user) return null;
  if (!rawOrigin || !user) {
    throw new Error('STUDYDECK_TAILSCALE_ORIGIN and STUDYDECK_TAILSCALE_USER must be set together');
  }
  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error('STUDYDECK_TAILSCALE_ORIGIN must be an HTTPS origin such as https://host.tailnet.ts.net:4310');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('STUDYDECK_TAILSCALE_ORIGIN must be an HTTPS origin with no path, query, fragment or credentials');
  }
  // guard.mjs checks the tailnet Host before loopback, so a loopback name here would demand
  // the tailnet header of the cockpit's own local page.
  if (LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new Error('STUDYDECK_TAILSCALE_ORIGIN must be the tailnet name, not a loopback address');
  }
  return { origin: url.origin, host: url.host.toLowerCase(), user };
}

function load() {
  const configPath = process.env.STUDYDECK_CONFIG_PATH || join(APP_DIR, 'cockpit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  const onEnvPath = expandHome(config.openNotebook.envFile);
  const onPassword = readEnvValue(onEnvPath, config.openNotebook.passwordKey);

  return {
    ...config,
    configPath,
    appDir: APP_DIR,
    webDir: join(APP_DIR, 'web'),
    // STUDYDECK_LEARN_ROOT exists so the app can be driven end to end against a COPY of
    // the learning data. Verifying a mutation path against the real .learn/ tree writes
    // attempts and confidence bumps that were never earned.
    learnRoot: process.env.STUDYDECK_LEARN_ROOT
      ? resolve(expandHome(process.env.STUDYDECK_LEARN_ROOT))
      : resolve(REPO_ROOT, config.learnRoot),
    // Secret stays on this object, server-side only. Never include it in an
    // /api/state payload or a log line.
    //
    // The two overrides mirror STUDYDECK_LEARN_ROOT above and exist for the same reason:
    // so behaviour can be exercised without the real service. STUDYDECK_ON_BASE_URL points
    // the client at an address nothing is listening on, which is the only way to test that
    // an unreachable Open Notebook degrades honestly instead of inventing a result — the
    // claim the README makes and nothing checked. STUDYDECK_ON_PASSWORD supplies a value
    // from the environment instead of the dotenv file, because without one the client
    // short-circuits before it ever tries to connect and the test would prove the wrong
    // thing. An env var is still server-side, still uncommitted, still never sent to the
    // browser, so rule 6 holds.
    openNotebook: {
      ...config.openNotebook,
      baseUrl: process.env.STUDYDECK_ON_BASE_URL || config.openNotebook.baseUrl,
      password: process.env.STUDYDECK_ON_PASSWORD || onPassword,
    },
    // STUDYDECK_OLLAMA_BASE_URL is the same seam as STUDYDECK_ON_BASE_URL above, for the
    // routes that call the local model instead of Open Notebook. Pointed at nothing, it
    // proves /api/grade and /api/debrief degrade to the "do it in a Claude session"
    // fallback; pointed at a recorder, it proves what those routes SEND — which is ours to
    // assert, unlike what a model returns (AGENTS.md, "Being DOWN is our behaviour").
    // Without it the only way to reach the success path of either route was to run the
    // real model, so neither had ever executed under test.
    ollama: {
      ...config.ollama,
      baseUrl: process.env.STUDYDECK_OLLAMA_BASE_URL || config.ollama.baseUrl,
    },
    // The same seam for the local TTS service, whose voice list the podcast preflight
    // reads before any render. A recorder here keeps that check off the real Speaches.
    tts: {
      ...config.tts,
      baseUrl: process.env.STUDYDECK_TTS_BASE_URL || config.tts?.baseUrl,
    },
    // The role sessions are the only part of the cockpit that leaves the machine. The key
    // is read from STUDYDECK_ANTHROPIC_API_KEY and from nowhere else: ANTHROPIC_API_KEY is
    // exported in many shells for other tools, and reading it would let this app start
    // spending on a key nobody chose to give it. Unset means the roles are off, and say so.
    // Like the ON password it stays on this object — never in a response, never in a log.
    // STUDYDECK_CLAUDE_BASE_URL is the same seam as the two above: a recorder for what the
    // client SENDS, or a dead port for how the routes degrade.
    claude: {
      ...DEFAULT_CLAUDE,
      ...config.claude,
      // Merged key by key: a config file written before a price existed must not leave
      // that price undefined, which would make every cost NaN and the spending limit inert.
      pricePerMTok: { ...DEFAULT_CLAUDE.pricePerMTok, ...config.claude?.pricePerMTok },
      baseUrl: process.env.STUDYDECK_CLAUDE_BASE_URL || config.claude?.baseUrl || DEFAULT_CLAUDE.baseUrl,
      apiKey: isUsableApiKey(process.env.STUDYDECK_ANTHROPIC_API_KEY) ? process.env.STUDYDECK_ANTHROPIC_API_KEY : null,
      // Set-but-unusable is a different mistake from unset, and the banner says which.
      apiKeyMalformed: Boolean(process.env.STUDYDECK_ANTHROPIC_API_KEY) && !isUsableApiKey(process.env.STUDYDECK_ANTHROPIC_API_KEY),
    },
    tailnet: parseTailnet(process.env),
  };
}

export const config = load();

/** Boot-time banner data — reports whether the secret resolved, never its value. */
export function configSummary() {
  return {
    port: config.server.port,
    topics: config.topics.map((t) => t.slug),
    onPassword: config.openNotebook.password ? 'loaded' : 'MISSING',
    ollamaModel: config.ollama.model,
    claudeKey: config.claude.apiKey ? 'loaded' : config.claude.apiKeyMalformed ? 'MALFORMED' : 'MISSING',
    claudeModel: config.claude.model,
    // The host only: the user is not a secret, but nothing needs it in a log.
    tailnet: config.tailnet?.host ?? 'off',
  };
}
