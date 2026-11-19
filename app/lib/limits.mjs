// WHAT: The request body ceiling, and every limit that has to fit inside it.
// WHY: Assessment finding F9. These were two independent magic numbers in two files —
//      a 1,000,000-byte body cap in the router and an 8 MiB sketch limit in mindmap.mjs —
//      and they contradicted each other. A sketch travels as a base64 data URL inside the
//      JSON body, and base64 costs a third more than the bytes it carries, so the request
//      layer rejected anything over roughly 750 KiB long before the 8 MiB check could run.
//      The documented limit was one you could never reach: a phone photo of a whiteboard
//      is 2-4 MB, so every real sketch failed, and the error named a limit that was not
//      the one doing the rejecting.
//
// The fix is not a bigger number. It is deriving one limit from the other, so the
// relationship is stated once and cannot drift back apart.

/**
 * Ceiling on a JSON request body. Deliberately small: this server buffers a body in
 * memory before parsing, and every route here is a local single user posting a form.
 */
export const MAX_BODY_BYTES = 1_000_000;

/** base64 encodes 3 bytes as 4 characters. */
const BASE64_EXPANSION = 4 / 3;

/**
 * Room for everything in a mind-map run that is NOT the image: the recalled concept
 * slugs, the mutation id, the data-URL prefix, JSON punctuation. 32 KiB is far more than
 * the largest real payload (a 24-concept topic runs about 1 KiB) — the margin is there so
 * that a sketch exactly at the limit is still comfortably accepted rather than sitting on
 * the boundary of a 413.
 */
const ENVELOPE_BYTES = 32 * 1024;

/**
 * The largest sketch, measured in DECODED bytes — which is what the server checks after
 * base64-decoding it, and what the browser can measure on a Blob before uploading.
 *
 * Derived, so the two numbers cannot disagree again: `app/test/limits.test.mjs` asserts
 * that a sketch of exactly this size still fits inside MAX_BODY_BYTES once encoded.
 */
export const MAX_SKETCH_BYTES = Math.floor((MAX_BODY_BYTES - ENVELOPE_BYTES) / BASE64_EXPANSION);

/** How many base64 characters `bytes` becomes, padding included. */
export const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

/** For error messages and UI copy — "708 KB", never a byte count nobody can picture. */
export const formatBytes = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.round(bytes / 1024)} KB`);
