// WHAT: Pre-flight probe that proves Open Notebook's podcast worker picked up a render.
// WHY: ON's surreal_commands worker learns about new jobs through a SurrealDB LIVE query
//      created once at worker start. When that subscription goes stale the API still
//      accepts every generate request and writes the episode row — each job then sits at
//      `running` with no progress and no error message, forever, indistinguishable from a
//      slow render by its status alone. The one cheap discriminator is the worker's own
//      log: a healthy generate prints a pickup line within ~1s. Probing the FIRST render
//      of a batch turns "20 silently dead jobs" into one actionable error before the
//      other 19 are committed. This trap burned two sessions being misdiagnosed as memory
//      exhaustion — see CLAUDE.md "External services".
import { execFile } from 'node:child_process';

/**
 * The worker's pickup line, verified against live container logs on 2026-07-22:
 * `... | INFO | commands.podcast_commands:generate_podcast_command:75 - Starting podcast generation for episode: <name>`
 */
export const PICKUP_MARKER = 'Starting podcast generation for episode:';

/**
 * A healthy pickup lands in ~1s; 12s of 1.5s polls is generous to a busy worker without
 * making the stale verdict feel hung from the browser.
 */
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_POLL_MS = 1_500;
/**
 * Rolling window handed to `docker logs --since` on every poll. A RELATIVE duration,
 * not an RFC3339 stamp: docker resolves it against its own daemon clock, so a drifted
 * Docker Desktop VM (routine on macOS after sleep) cannot push the window off the
 * lines being searched for.
 */
const LOG_WINDOW = '120s';
const DOCKER_TIMEOUT_MS = 5_000;
// A render in progress logs steadily (per-clip TTS lines and LLM chatter); 8MB covers
// the window with wide margin, and overflow surfaces as 'unavailable', not a crash.
const DOCKER_MAX_BUFFER = 8 * 1024 * 1024;

/** Pure check: does this log text contain the pickup line for this episode? */
export function pickupSeen(logText, episodeName) {
  return logText.includes(`${PICKUP_MARKER} ${episodeName}`);
}

/**
 * The episode rows a failed pre-flight is allowed to clean up. Scoped hard: same name,
 * still in a running state, no audio, and created since the batch fired (minus a minute
 * of clock slack between this host and ON's container). An old stuck row, a finished
 * duplicate, or a row whose `created` is missing/unparseable is left alone — deleting
 * too little is recoverable in the ON UI; deleting the wrong render is not.
 */
export function stuckCanaryRows(episodes, { title, firedAtMs, runningStatuses }) {
  return episodes.filter((e) => e.name === title
    && !e.audio_available
    && runningStatuses.has(String(e.status).toLowerCase())
    && Boolean(e.created)
    && Date.parse(e.created) >= firedAtMs - 60_000);
}

/**
 * One `docker logs` read over the rolling window. Loguru writes to stderr, so both
 * streams are searched. Rejects when docker itself fails (CLI missing, wrong container
 * name, daemon down) — the caller maps that to 'unavailable', never to 'stale'.
 */
export function readWorkerLog(container) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'docker', ['logs', '--since', LOG_WINDOW, container],
      { timeout: DOCKER_TIMEOUT_MS, maxBuffer: DOCKER_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(err.message));
        resolvePromise(`${stdout}\n${stderr}`);
      },
    );
  });
}

/**
 * Poll the worker log until the pickup line for `episodeName` appears.
 *
 * Verdicts:
 *   'seen'        — the worker picked the job up; safe to commit the rest of the batch.
 *   'timeout'     — the log was READABLE but the line never appeared: the stale-LIVE-query
 *                   trap. Waiting will not help; the fix is a container restart.
 *   'unavailable' — every log read failed, so nothing was proven either way (docker not
 *                   installed, wrong container name, ON running remotely). Callers should
 *                   proceed as before this probe existed, with a warning — treating
 *                   "can't check" as "stale" would block legitimate setups.
 *
 * A same-name pickup line from an EARLIER render inside the 120s window can satisfy the
 * match. Any such false positive still proves the worker consumed a command within the
 * last two minutes, and the trap being guarded is a listener dead since worker start —
 * so the degraded claim ("alive moments ago") is accepted rather than paying for exact
 * job correlation ON's log does not offer.
 */
export async function probeWorkerPickup({
  container, episodeName, timeoutMs = PROBE_TIMEOUT_MS, pollMs = PROBE_POLL_MS, readLog,
} = {}) {
  if (!readLog) {
    if (!container) {
      return {
        status: 'unavailable',
        waited_ms: 0,
        detail: 'openNotebook.workerContainer is not set in cockpit.config.json',
      };
    }
    readLog = () => readWorkerLog(container);
  }

  const startedAt = Date.now();
  let readable = false;
  let lastError = null;
  for (;;) {
    try {
      const log = await readLog();
      readable = true;
      if (pickupSeen(log, episodeName)) {
        return { status: 'seen', waited_ms: Date.now() - startedAt };
      }
    } catch (err) {
      lastError = err.message;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return readable
        ? { status: 'timeout', waited_ms: Date.now() - startedAt }
        : { status: 'unavailable', waited_ms: Date.now() - startedAt, detail: lastError ?? 'log read failed' };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
