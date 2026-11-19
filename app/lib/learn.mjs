// WHAT: Read-only access to learn-anything's own files.
// WHY: Rule zero — state.json keeps its exact upstream schema. This module only
//      reads; every cockpit-specific field lives in the cockpit/ sidecars.
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  readFileSync, readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config } from './config.mjs';

export function topicDir(slug) {
  return join(config.learnRoot, slug);
}

export function cockpitDir(slug) {
  return join(topicDir(slug), 'cockpit');
}

/**
 * Names of real subdirectories in `dir`, skipping dotfiles and non-directory
 * entries.
 *
 * WHY: macOS Finder drops a .DS_Store file into any directory it browses. The
 * concept-directory scans below assume every entry under quizzes/ is itself a
 * directory; readdirSync on that stray file throws ENOTDIR, which bubbles up
 * through buildTopic → buildState and turns GET /api/state into a 500 — blanking
 * the entire cockpit shell. Filtering to real directories makes the scan robust.
 */
function subdirNames(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/** Load one topic's state.json. Throws if absent — a configured topic must exist. */
export function readTopicState(slug) {
  return JSON.parse(readFileSync(join(topicDir(slug), 'state.json'), 'utf8'));
}

/** Flatten a topic's domains into concept records tagged with their domain. */
export function flattenConcepts(state) {
  return state.domains.flatMap((domain) =>
    domain.concepts.map((concept) => ({
      ...concept,
      domain_name: domain.name,
      domain_slug: domain.slug,
    })),
  );
}

/** Per-status counts for a topic, always including every status key. */
export function statusCounts(state) {
  const counts = { unexplored: 0, in_progress: 0, needs_practice: 0, mastered: 0 };
  for (const concept of flattenConcepts(state)) {
    if (concept.status in counts) counts[concept.status] += 1;
  }
  return counts;
}

const PRACTICE_CONCEPT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRACTICE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|txt|js|mjs|ts|py|json)$/;
const PROTECTED_PRACTICE_ARTIFACT = /(?:^|[._-])(?:solutions?|answers?|hints?)(?:[._-]|$)/i;
const MAX_PRACTICE_ARTIFACT_BYTES = 256 * 1024;

const practiceNotFound = () => Object.assign(new Error('practice artifact not found'), { status: 404 });

function pathIsWithin(root, candidate) {
  const distance = relative(root, candidate);
  return distance !== '' && distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

/** Derive every practice path from the configured topic root, never from a URL path. */
function practicePaths(slug, conceptSlug = null, file = null) {
  const learnRoot = resolve(config.learnRoot);
  const root = resolve(learnRoot, slug);
  if (!pathIsWithin(learnRoot, root)) throw practiceNotFound();
  const exercises = resolve(root, 'exercises');
  if (!pathIsWithin(root, exercises)) throw practiceNotFound();
  if (conceptSlug === null) return { root, exercises };

  const concept = resolve(exercises, conceptSlug);
  if (!pathIsWithin(exercises, concept)) throw practiceNotFound();
  if (file === null) return { root, exercises, concept };

  const artifact = resolve(concept, file);
  if (!pathIsWithin(concept, artifact)) throw practiceNotFound();
  return { root, exercises, concept, artifact };
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function isPlainDirectory(path) {
  const info = lstatOrNull(path);
  return Boolean(info && !info.isSymbolicLink() && info.isDirectory());
}

/** Conventional answer-bearing exercise artifacts need a committed reveal before content can leave the server. */
export function isProtectedPracticeArtifact(file) {
  return PROTECTED_PRACTICE_ARTIFACT.test(file);
}

/** A file name that can be resolved beneath one mapped practice concept. */
export function isPracticeArtifactFilename(file) {
  return typeof file === 'string' && PRACTICE_ARTIFACT_NAME.test(file) && !file.includes('..');
}

function assertReadablePracticeDirectory(path) {
  if (!isPlainDirectory(path)) throw practiceNotFound();
}

/**
 * Index practice artifacts that belong to the CURRENT knowledge map.
 *
 * Exercises are learning artifacts, so they live beside their topic rather than inside
 * cockpit/.  This is intentionally metadata-only: the browser gets enough to show which
 * mapped concepts have work without treating arbitrary local files as web content or
 * inventing progress from an unfinished starter file.
 */
export function listPracticeArtifacts(slug, concepts) {
  const mapped = new Map(concepts
    .filter((concept) => PRACTICE_CONCEPT_SLUG.test(concept?.slug ?? ''))
    .map((concept) => [concept.slug, concept]));
  let root;
  try {
    ({ exercises: root } = practicePaths(slug));
  } catch {
    return [];
  }
  // State must keep rendering if a local artifact root is malformed. In particular,
  // readdir follows a root symlink, so reject it before listing anything.
  if (!isPlainDirectory(root)) return [];

  let conceptDirs;
  try {
    conceptDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (err) {
    // A file named exercises is not a practice library. Treat it as absent rather than
    // letting one local artifact blank /api/state; genuine readable directories still
    // use the normal path above.
    if (err.code === 'ENOTDIR') return [];
    throw err;
  }

  const artifacts = [];
  for (const conceptSlug of conceptDirs) {
    if (!mapped.has(conceptSlug)) continue;
    const conceptRoot = join(root, conceptSlug);
    if (!isPlainDirectory(conceptRoot)) continue;

    let files;
    let lockedFiles;
    try {
      const candidates = readdirSync(conceptRoot, { withFileTypes: true })
        // The preview route has a strict text-name allowlist. Index the same set so a
        // browser never gets a link it cannot safely open (and no exotic local file is
        // silently represented as a practice artifact).
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isPracticeArtifactFilename(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
      files = candidates.filter((file) => !isProtectedPracticeArtifact(file));
      lockedFiles = candidates.filter((file) => isProtectedPracticeArtifact(file));
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
      throw err;
    }
    if (files.length === 0 && lockedFiles.length === 0) continue;
    const concept = mapped.get(conceptSlug);
    const artifact = {
      concept_slug: conceptSlug,
      concept_name: concept.name ?? conceptSlug,
      files,
    };
    // A lock label is metadata, not a preview. Its presence gives the learner a clear,
    // deliberate reveal affordance instead of hiding a solution file so completely that
    // they work around the cockpit with Finder.
    if (lockedFiles.length > 0) artifact.locked_files = lockedFiles;
    artifacts.push(artifact);
  }
  return artifacts;
}

/** Read one mapped text artifact for the local Practice Lab, never an arbitrary path. */
export function readPracticeArtifact(slug, conceptSlug, file, { allowProtected = false } = {}) {
  if (typeof conceptSlug !== 'string' || !PRACTICE_CONCEPT_SLUG.test(conceptSlug)
    || !isPracticeArtifactFilename(file)) {
    throw Object.assign(new Error('invalid practice artifact path'), { status: 400 });
  }
  const state = readTopicState(slug);
  const mapped = flattenConcepts(state).some((concept) => concept.slug === conceptSlug);
  if (!mapped) throw Object.assign(new Error('practice artifact concept is not mapped for this topic'), { status: 404 });
  // `allowProtected` is an internal capability used only by the router after it has
  // committed a reveal event. It is never chosen from a URL or browser-provided flag.
  if (isProtectedPracticeArtifact(file) && !allowProtected) throw practiceNotFound();
  const { root, exercises, concept, artifact } = practicePaths(slug, conceptSlug, file);
  try {
    assertReadablePracticeDirectory(root);
    assertReadablePracticeDirectory(exercises);
    assertReadablePracticeDirectory(concept);
    const listedInfo = lstatOrNull(artifact);
    if (!listedInfo || listedInfo.isSymbolicLink() || !listedInfo.isFile()) throw practiceNotFound();

    // lstat rejects existing links; O_NOFOLLOW closes the final-component race between
    // that check and opening the file. O_NONBLOCK means a raced special file cannot hang
    // the loopback server while fstat below rejects it.
    let descriptor;
    try {
      descriptor = openSync(artifact, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const openedInfo = fstatSync(descriptor);
      if (!openedInfo.isFile()) throw practiceNotFound();
      if (openedInfo.size > MAX_PRACTICE_ARTIFACT_BYTES) {
        throw Object.assign(new Error('practice artifact is too large to preview'), { status: 413 });
      }
      return { file, content: readFileSync(descriptor, 'utf8') };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } catch (err) {
    if (err.status) throw err;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP') throw practiceNotFound();
    throw err;
  }
}

/**
 * Locate and read one deck by its file name.
 *
 * The file name arrives from a URL, so it is treated as hostile: anything with a
 * path separator or a dot-segment is rejected outright rather than normalized,
 * and the match is made by scanning known deck directories rather than by
 * building a path out of user input.
 */
export function readDeck(topicSlugArg, fileName) {
  if (!/^[\w.\- ]+\.json$/.test(fileName) || fileName.includes('..')) {
    throw Object.assign(new Error('invalid deck file name'), { status: 400 });
  }
  const quizRoot = join(topicDir(topicSlugArg), 'quizzes');
  if (!existsSync(quizRoot)) throw Object.assign(new Error('no decks for topic'), { status: 404 });

  for (const conceptSlug of subdirNames(quizRoot)) {
    const candidate = join(quizRoot, conceptSlug, fileName);
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (err) {
      // Read first and let ENOENT mean "not in this concept directory", rather than
      // `existsSync` then read: between those two calls the file can be removed, and that
      // race turned a vanished deck into "unreadable" — a corruption report for a file
      // that is simply gone. The scan continues instead, and the loop's own 404 stands.
      if (err.code === 'ENOENT') continue;
      // Present but unreadable — a different fact from "no such deck", and the caller must
      // be able to tell them apart. Unguarded this was a 500, which reads as the cockpit
      // being broken rather than one file being corrupt.
      throw Object.assign(
        new Error(`deck ${fileName} is unreadable: ${err.message}`),
        { status: 422 },
      );
    }
  }
  throw Object.assign(new Error(`deck not found: ${fileName}`), { status: 404 });
}

/**
 * List persisted quiz decks for a topic: .learn/topics/<slug>/quizzes/<concept>/<file>.json
 * Returns metadata only — never question content, and never answers.
 */
export function listDecks(slug) {
  const quizRoot = join(topicDir(slug), 'quizzes');
  if (!existsSync(quizRoot)) return [];

  const decks = [];
  for (const conceptSlug of subdirNames(quizRoot)) {
    const conceptDir = join(quizRoot, conceptSlug);
    for (const file of readdirSync(conceptDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const deck = JSON.parse(readFileSync(join(conceptDir, file), 'utf8'));
        decks.push({
          file,
          topic_slug: slug,
          concept_slug: deck.concept_slug ?? conceptSlug,
          concept_name: deck.concept_name ?? conceptSlug,
          created: deck.created ?? null,
          question_count: deck.questions?.length ?? 0,
        });
      } catch (err) {
        // Gone between the directory scan and the read. That is a race, not damage, and
        // listing it would be a false positive about a file that no longer exists.
        if (err.code === 'ENOENT') continue;

        // Assessment finding F12. A malformed deck must not take down the whole state
        // payload — but it must not vanish either, which is what used to happen. A deck
        // that silently disappears is indistinguishable from one you never made, so a
        // corrupted file reads to the user as "I have fewer decks than I remember" and the
        // real condition is never suspected. It is listed, marked, and left unopenable.
        decks.push({
          file,
          topic_slug: slug,
          concept_slug: conceptSlug,
          concept_name: conceptSlug,
          created: null,
          question_count: null,
          unreadable: err.message,
          // A parse failure means the CONTENT is damaged; an I/O failure (EACCES, EIO)
          // means we could not look at all. Calling the second one "cannot be parsed" is a
          // false diagnosis, and it sends `verify` to exit 1 — "damage found" — when the
          // honest answer is exit 2, "I could not check". They also call for different
          // actions: one needs the file repaired, the other needs the disk or permissions
          // looked at.
          //
          // Classified rather than rethrown, deliberately: `listDecks` feeds `buildState`,
          // so throwing would turn one unreadable permission bit into a 500 on /api/state
          // and blank the whole cockpit. Loud is the goal; total outage is not.
          unreadable_kind: err instanceof SyntaxError ? 'parse' : 'io',
        });
      }
    }
  }
  return decks;
}
