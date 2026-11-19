// WHAT: Versioned identities for cards generated from durable learning evidence.
// WHY: A human-readable source reference is the semantic duplicate key, but it is not a
// safe filesystem-style id: normalising punctuation made distinct references collide.
// New cards therefore carry a compact hash of the complete, unmodified reference.
import { createHash } from 'node:crypto';

/**
 * Deterministic v2 id for a generated card.
 *
 * `kind` deliberately remains visible for diagnosis while the digest includes it, so a
 * quiz miss and a fact-check claim cannot collide even if a future source format overlaps.
 * Existing legacy ids are never rewritten; callers continue to dedupe by source_ref.
 */
export function generatedCardId(kind, sourceRef) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(kind)) {
    throw new TypeError('card kind must be a short lowercase identifier');
  }
  if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
    throw new TypeError('card source_ref is required');
  }
  const digest = createHash('sha256').update(`${kind}\0${sourceRef}`).digest('base64url').slice(0, 22);
  return `card-v2-${kind}-${digest}`;
}
