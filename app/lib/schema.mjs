// WHAT: The shape a restorable file must have before a restore will write it.
// WHY:  A backup that parses can still be wrong, and restoring it would swap a damaged file
//       for a quietly broken one. Ported from the September snapshot (264547c), restore
//       validators only: its deck and event validators have no caller yet. state.json's
//       validator is learn-anything's own, imported by explicit path like render.mjs is,
//       so this repo never keeps a second opinion about that schema (rule 1).
import { validateStateV1 } from '../../.claude/skills/learn-anything-topic/scripts/utils.mjs';

export { validateStateV1 };

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const problem = (message) => [{ path: '', message }];

/** Return `value` if `validate` finds nothing; otherwise throw a 422 naming `label`. */
export function assertData(value, validate, label = 'data') {
  const errors = validate(value);
  if (errors.length) {
    const detail = errors.slice(0, 8).map((e) => `${e.path || 'root'} ${e.message}`).join('; ');
    throw Object.assign(new Error(`${label}: ${detail}`), { status: 422, kind: 'schema' });
  }
  return value;
}

const cardsErrors = (value) => {
  if (!Array.isArray(value) || value.some((c) => !plainObject(c) || !text(c.id) || !text(c.front) || !text(c.back) || !date(c.created))) {
    return problem('expected cards with id, front, back and created date');
  }
  return new Set(value.map((c) => c.id)).size === value.length ? [] : problem('duplicate card ids');
};

const scheduleErrors = (value) => (plainObject(value) && value.version === 1
  && (value.started === null || date(value.started)) && typeof value.paused === 'boolean'
  && plainObject(value.step_overrides) && Object.values(value.step_overrides).every(date)
  ? [] : problem('invalid schedule version, dates, pause flag or overrides'));

const readingErrors = (value) => (plainObject(value)
  && Object.values(value).every((v) => plainObject(v) && Number.isFinite(v.position) && v.position >= 0 && v.position <= 1)
  ? [] : problem(plainObject(value) ? 'invalid reading position' : 'expected an object'));

const factcheckErrors = (value) => (plainObject(value)
  && Object.values(value).every((v) => plainObject(v) && (v.version === undefined || [1, 2].includes(v.version))
    && text(v.source_id) && Array.isArray(v.claims)
    && v.claims.every((c) => plainObject(c) && text(c.id) && text(c.text) && typeof c.truth === 'boolean'))
  ? [] : problem(plainObject(value) ? 'invalid fact-check claim set' : 'expected an object'));

const mindmapErrors = (value) => (Array.isArray(value) && value.every(plainObject)
  ? [] : problem('expected an array of recall records'));

/**
 * One validator per JSON sidecar, keyed by file name. A test holds the keys equal to
 * sidecar.mjs's JSON_SIDECARS, so a new sidecar fails the suite until it has one here.
 */
export const SIDECAR_VALIDATORS = {
  'cards.json': cardsErrors,
  'schedule.json': scheduleErrors,
  'reading.json': readingErrors,
  'factchecks.json': factcheckErrors,
  'mindmaps.json': mindmapErrors,
};

/** Errors for a sidecar by file name; [] when it is well formed. A name with no validator never is. */
export function validateSidecar(name, value) {
  const validate = SIDECAR_VALIDATORS[name];
  return validate ? validate(value) : problem(`no validator for ${name}`);
}
