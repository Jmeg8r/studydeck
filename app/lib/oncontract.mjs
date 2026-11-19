// WHAT: Does Open Notebook still return sources in the shape this app maps?
// WHY:  Roadmap A6 — the one gap in workstream A that a test cannot close, and saying so
//       in three different file headers was not the same as being able to check it.
//
//       `batchegress.test.mjs` says it plainly: if ON's `/api/sources` shape drifts, every
//       stub in the suite keeps feeding well-formed sources, every test keeps passing, and
//       the REAL route 400s on what looks like an empty notebook. The suite cannot catch
//       that without pinning a stub of an API this repo does not control — which is the
//       thing the convention forbids, for the good reason that ON's routes have already
//       churned twice.
//
//       So this is not a test and must never become one. It is a live diagnostic whose
//       ENTIRE JOB is to notice that upstream changed. That inverts the convention rather
//       than breaking it — the same way `/api/on/health` is the deliberate exception to the
//       503 rule, because reporting the outage IS its success condition.
//
// The functions here are pure so the drift logic itself can be unit-tested. The payloads in
// those tests are INPUTS to our checker, not claims about what ON returns: if ON changes
// tomorrow, the checker still behaves correctly — it reports drift, which is the point.

/**
 * Fields `listSources` reads, and what goes wrong downstream when each is malformed.
 *
 * `missing` and `wrongType` are separate severities because they fail differently, and the
 * difference is not cosmetic. An ABSENT title takes `?? '(untitled)'` and degrades in
 * silence. A title that is present but not a string sails past that fallback — `??` only
 * catches null and undefined — and then `listSources` calls `.match()` on it while sorting,
 * which THROWS. `{ id: 'x', title: 42 }` is therefore worse than a missing title, not
 * milder, and reporting it as a degradation would understate an outage.
 */
const FIELDS = [
  {
    key: 'id',
    // No fallback in listSources, and every downstream use — readSource, episode naming,
    // the batch's retry identity — is keyed on it. An undefined id does not throw; it
    // propagates as a source nothing can open.
    missing: { severity: 'drifted', why: 'every source becomes unopenable and unnameable' },
    wrongType: { severity: 'drifted', why: 'ids are used as opaque keys everywhere; a non-string breaks every lookup' },
  },
  {
    key: 'title',
    missing: {
      severity: 'degraded',
      why: 'sources fall back to "(untitled)" — chapter order and episode names are lost silently',
    },
    wrongType: {
      severity: 'drifted',
      why: 'the "(untitled)" fallback only catches null/undefined, so listSources calls .match() on it and throws',
    },
  },
];

/** Severity ranking — a hard drift must never be downgraded by a cosmetic finding. */
const RANK = { ok: 0, degraded: 1, drifted: 2 };

/**
 * Inspect a raw `/api/sources` payload.
 *
 * Three outcomes, and the third is the one that matters most:
 *   - `ok`            — the shape this app maps is intact
 *   - `drifted`       — it is not, and something is or will be broken
 *   - `indeterminate` — nothing could be concluded (an empty notebook proves nothing about
 *                       the shape of a source). Reporting that as `ok` would be the exact
 *                       lie this file exists to prevent: a green check meaning "I looked
 *                       and there was nothing to look at".
 */
export function inspectSourcesPayload(payload) {
  if (!Array.isArray(payload)) {
    return {
      status: 'drifted',
      findings: [
        `/api/sources returned ${payload === null ? 'null' : typeof payload}, not an array — listSources calls .map on this and throws`,
      ],
    };
  }

  if (payload.length === 0) {
    return {
      status: 'indeterminate',
      findings: ['the notebook returned no sources, so the shape of a source could not be checked'],
    };
  }

  const findings = [];
  let status = 'ok';
  const raise = (severity) => {
    if (RANK[severity] > RANK[status]) status = severity;
  };

  for (const { key, missing, wrongType } of FIELDS) {
    const absent = payload.filter((s) => s == null || s[key] === undefined || s[key] === null);
    // Checked only on entries that HAVE the field, so one source is never counted twice.
    const mistyped = payload.filter((s) => s != null && s[key] !== undefined && s[key] !== null && typeof s[key] !== 'string');

    if (absent.length > 0) {
      findings.push(`${absent.length} of ${payload.length} source(s) have no \`${key}\` — ${missing.why}`);
      raise(missing.severity);
    }
    if (mistyped.length > 0) {
      findings.push(`${mistyped.length} of ${payload.length} source(s) have a non-string \`${key}\` — ${wrongType.why}`);
      raise(wrongType.severity);
    }
  }

  return { status, findings };
}

/**
 * The same check for one notebook, against a live service.
 *
 * `fetchSources` is injected rather than imported so this stays callable with a recorder,
 * and so the module has no import-time dependency on a reachable ON.
 *
 * An unreachable service is `indeterminate`, never `drifted`: "I could not look" and "I
 * looked and it changed" are different findings that call for different actions, and
 * verify.mjs already models exactly that distinction in its exit codes.
 */
export async function probeSources(notebookId, fetchSources) {
  try {
    return inspectSourcesPayload(await fetchSources(notebookId));
  } catch (err) {
    return {
      status: 'indeterminate',
      findings: [`could not reach Open Notebook — ${err.message}`],
    };
  }
}
