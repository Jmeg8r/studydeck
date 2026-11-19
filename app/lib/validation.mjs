// WHAT: Small, dependency-free validation primitives for every route boundary.
// WHY: Route handlers select sidecar paths and record durable learning evidence. Coercing
// untrusted JSON there makes malformed input look valid, and repeating ad-hoc checks makes
// a new route silently weaker than its neighbours.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const fail = (message) => { throw new ValidationError(message); };

/** A configured topic is an allowlist entry, never merely a plausible-looking path. */
export function assertKnownTopic(topics, value, name = 'topic_slug') {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    || value.includes('/') || value.includes('\\') || value.includes('\0')
    || !topics.some((topic) => topic.slug === value)) {
    fail(`${name} must be a known topic`);
  }
  return value;
}

export function assertString(value, name, { min = 1, max = 4_000, pattern = null } = {}) {
  if (typeof value !== 'string') fail(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) fail(`${name} must be ${min}-${max} characters`);
  if (pattern && !pattern.test(trimmed)) fail(`${name} has an invalid format`);
  return trimmed;
}

export function optionalString(value, name, options = {}) {
  if (value === undefined || value === null || value === '') return null;
  return assertString(value, name, { min: 1, ...options });
}

export function assertInteger(value, name, { min, max }) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) fail(`${name} bounds must be finite and ordered`);
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function assertFiniteNumber(value, name, { min, max }) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) fail(`${name} bounds must be finite and ordered`);
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be a finite number from ${min} to ${max}`);
  return value;
}

export function assertPlainObject(value, name, { maxKeys = 100 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${name} must be an object`);
  }
  if (Object.keys(value).length > maxKeys) fail(`${name} has too many entries`);
  return value;
}

export function assertArray(value, name, { max = 100 } = {}) {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be an array with at most ${max} entries`);
  return value;
}

/** IDs enter sidecar lookups and route paths; reject separators and control characters. */
export function assertIdentifier(value, name, { max = 300, pattern = /^[A-Za-z0-9:_-]+$/ } = {}) {
  return assertString(value, name, { min: 1, max, pattern });
}

/** A quiz deck is a filename beneath a known topic, never a relative path. */
export function assertFilename(value, name = 'deck_file') {
  const file = assertString(value, name, { min: 1, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/ });
  if (file.includes('..')) fail(`${name} has an invalid format`);
  return file;
}
