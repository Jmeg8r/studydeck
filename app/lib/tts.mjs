// WHAT: The Speaches (local TTS) client. Only used to enumerate voices for the UI.
// WHY:  Voices are backend-specific — Kokoro's ids (af_nova, am_adam) are not
//       interchangeable with any other provider's, and Open Notebook does not expose
//       a voice list of its own. Keeping this in one file means swapping the TTS
//       backend touches one place, the same reason lib/opennotebook.mjs exists.
//
//       Synthesis itself never goes through here. Open Notebook renders episodes
//       server-to-server; the cockpit only needs to know which ids are selectable.
import { config } from './config.mjs';

const TIMEOUT_MS = 5_000;

export class TtsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Available voices for the configured model, split by gender so the UI can group them.
 *
 * Throws rather than returning [] when Speaches is unreachable. An empty list and a
 * dead server are different states: the first would silently offer no choices and look
 * like a bug in the form, the second is a fixable infrastructure problem the user
 * should be told about by name.
 */
export async function listVoices() {
  const { baseUrl, model } = config.tts;
  const url = `${baseUrl}/v1/audio/voices?model_id=${encodeURIComponent(model)}`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : err.message;
    throw new TtsError(`Speaches unreachable at ${baseUrl} (${reason})`, 503);
  }

  if (!res.ok) throw new TtsError(`Speaches voices → ${res.status}`, res.status);

  const payload = await res.json();
  // Speaches nests the array under `voices`; tolerate a bare array in case that changes.
  const raw = Array.isArray(payload) ? payload : (payload.voices ?? []);

  return {
    model,
    voices: raw.map((v) => ({
      id: v.id ?? v.voice_id ?? v.name,
      gender: v.gender ?? 'unknown',
      language: v.language ?? 'unknown',
    })).filter((v) => v.id),
  };
}

/** Boot/health probe — reports reachability without throwing, for the status line. */
export async function health() {
  try {
    const { voices, model } = await listVoices();
    return { ok: true, model, voices: voices.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
