// WHAT: Mind-map recall runs — sketch storage, and the diff between what you recalled
//       and the topic's real concept map.
// WHY: Step 4 of the spec is retrieval-first: sketch from memory BEFORE seeing the real
//      map, then diff. The gaps are tomorrow's study targets.
//
// HONESTY NOTE: this app cannot read your sketch — there is no vision model here. So the
// diff is self-marked: you tick what you actually recalled, and the app computes what you
// missed against state.json. Pretending to parse the image would be a lie; asking you to
// mark your own recall is both truthful and better retrieval practice.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic.mjs';
import { cockpitDir, flattenConcepts, readTopicState } from './learn.mjs';
import { formatBytes, MAX_SKETCH_BYTES } from './limits.mjs';
import { readMindMaps, writeMindMaps } from './sidecar.mjs';

/**
 * The sketch ceiling, derived from the request body ceiling rather than picked (F9).
 *
 * It used to be a flat 8 MiB, which the request layer made unreachable: a sketch travels
 * base64-encoded inside the JSON body, and 8 MiB of image is ~11 MB of body against a
 * 1,000,000-byte cap. Every real phone photo was refused by a limit that never named
 * itself, while the error quoted a limit that was not doing the rejecting.
 */
export { MAX_SKETCH_BYTES };

/**
 * Raster only, on purpose (assessment finding F8).
 *
 * SVG is a document, not a picture: it carries script, and it was being stored and then
 * served back as `image/svg+xml` from the cockpit's OWN origin, where anything inside it
 * runs with the same rights as the app. Sanitizing it properly needs a parser, and rule 5
 * says no dependencies — so the surface goes instead of being defended. A phone photo of a
 * sketch is a JPEG; nothing about the retrieval-practice flow wanted vector art.
 */
const SKETCH_TYPES = Object.freeze(Object.assign(Object.create(null), {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}));

function hasRasterMagic(mime, bytes) {
  if (mime === 'image/png') {
    // Signature alone accepts an eight-byte truncated upload. A complete PNG terminates
    // in the fixed zero-length IEND chunk; this is still not image decoding, but it
    // rejects the mislabeled and torn payloads this boundary is responsible for.
    return bytes.length >= 45
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && bytes.subarray(-12, -4).equals(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]));
  }
  if (mime === 'image/jpeg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  if (mime !== 'image/webp') return false;
  return bytes.length >= 12
    && bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
    && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
    && bytes.readUInt32LE(4) + 8 === bytes.length;
}

/** The true map: exactly what learn-anything says the topic contains. */
export function trueMap(topicSlug) {
  const state = readTopicState(topicSlug);
  return {
    topic: state.topic,
    domains: state.domains.map((d) => ({
      name: d.name,
      slug: d.slug,
      concepts: d.concepts.map((c) => ({ name: c.name, slug: c.slug, status: c.status })),
    })),
    concept_count: flattenConcepts(state).length,
  };
}

/**
 * Store an uploaded sketch from a data URL.
 * Returns a web path under /media/sketches/, or null when there is no sketch.
 */
export function saveSketch(topicSlug, dataUrl) {
  if (!dataUrl) return null;

  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw Object.assign(new Error('sketch must be a base64 data URL'), { status: 400 });

  const [, mime, base64] = match;
  const ext = SKETCH_TYPES[mime];
  if (!ext) {
    throw Object.assign(new Error(`unsupported sketch type: ${mime}`), { status: 400 });
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_SKETCH_BYTES) {
    // Both numbers real, and the limit read from the constant rather than repeated as
    // prose: the old message said "limit is 8MB" while a different limit did the
    // rejecting, which is the part of F9 that wasted the most time.
    throw Object.assign(
      new Error(
        `sketch is ${formatBytes(bytes.length)}; limit is ${formatBytes(MAX_SKETCH_BYTES)} ` +
        '(it is sent inside a JSON request, and base64 costs a third more than the image)',
      ),
      { status: 413 },
    );
  }
  if (!hasRasterMagic(mime, bytes)) {
    throw Object.assign(new Error(`sketch bytes do not match declared type: ${mime}`), { status: 400 });
  }

  const dir = join(cockpitDir(topicSlug), 'sketches');
  mkdirSync(dir, { recursive: true });
  // Timestamped name, generated server-side — no client string reaches the filesystem.
  const file = `sketch-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  writeFileAtomicSync(join(dir, file), bytes);
  return { file, bytes: bytes.length };
}

/**
 * Record a recall run: which concept slugs were recalled, what that missed, and where
 * the sketch (if any) lives.
 */
export function recordRun(topicSlug, { recalled = [], sketchDataUrl = null, note = null, mutationId = null }) {
  const map = trueMap(topicSlug);
  const all = map.domains.flatMap((d) => d.concepts.map((c) => ({ ...c, domain: d.name })));
  const runs = readMindMaps(topicSlug);

  // Replay check first, and it matters more here than elsewhere: a retried run used to
  // append a SECOND run and — because the caller pushes the diff onward — create a second
  // Open Notebook note, so one recall session showed up twice in the study record.
  // `missed` is rebuilt from the stored slugs rather than recomputed from this request's
  // payload: the reply must describe the run that was actually recorded.
  const existing = mutationId ? runs.find((r) => r.mutation_id === mutationId) : null;
  if (existing) {
    const missedSlugs = new Set(existing.missed ?? []);
    return { run: { ...existing, duplicate: true }, missed: all.filter((c) => missedSlugs.has(c.slug)), total: all.length };
  }

  // Only now, once this is known to be a genuinely new run, does the sketch reach disk.
  // The filename is timestamped, so saving before the check above wrote a fresh file on
  // every retry that no run ever referenced — up to 8MB of orphan per replay, and the
  // same class of repeated expensive side effect as the duplicate Open Notebook note.
  const sketch = saveSketch(topicSlug, sketchDataUrl);

  // A default only covers `undefined`; an explicit null would reach `new Set(null)`
  // and throw. Guard the shape rather than trusting the caller.
  const recalledSet = new Set(Array.isArray(recalled) ? recalled : []);

  const missed = all.filter((c) => !recalledSet.has(c.slug));
  const run = {
    ts: new Date().toISOString(),
    ...(mutationId ? { mutation_id: mutationId } : {}),
    recalled: all.filter((c) => recalledSet.has(c.slug)).map((c) => c.slug),
    missed: missed.map((c) => c.slug),
    recall_rate: all.length > 0 ? (all.length - missed.length) / all.length : 0,
    sketch: sketch?.file ?? null,
    note,
  };

  runs.push(run);
  writeMindMaps(topicSlug, runs);

  return { run, missed, total: all.length };
}

/** Human-readable diff, for saving back to Open Notebook as a note. */
export function diffNote(topicSlug, run, missed, total) {
  const recalledCount = total - missed.length;
  const byDomain = new Map();
  for (const concept of missed) {
    if (!byDomain.has(concept.domain)) byDomain.set(concept.domain, []);
    byDomain.get(concept.domain).push(concept.name);
  }

  const lines = [
    `Recalled ${recalledCount} of ${total} concepts from memory (${Math.round(run.recall_rate * 100)}%).`,
    '',
    '## Gaps — tomorrow’s study targets',
  ];
  if (byDomain.size === 0) {
    lines.push('', 'Nothing missed on this pass.');
  } else {
    for (const [domain, names] of byDomain) {
      lines.push('', `**${domain}**`, ...names.map((n) => `- ${n}`));
    }
  }
  lines.push('', `_Recorded from the StudyDeck Mind Map studio, ${run.ts.slice(0, 10)}._`);
  return lines.join('\n');
}
