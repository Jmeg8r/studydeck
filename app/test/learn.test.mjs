// WHAT: Regression tests for file-backed learn artifacts in lib/learn.mjs.
// WHY: A stray .DS_Store (or any file/dotfile) dropped into a topic's quizzes/
//      directory by macOS Finder used to make readdirSync throw ENOTDIR, which
//      bubbled up through buildTopic -> buildState and turned GET /api/state into
//      a 500 — blanking the whole cockpit shell. Practice artifacts need the same
//      resilience without treating a symlink as an approved local-content boundary.
//
// Node stdlib only, matching the app's zero-dependency ethos. Run with `npm test`
// (node --test). The suite points config.learnRoot at a throwaway tmp fixture —
// config is a live, mutable export and topicDir() reads it at call time — so the
// real .learn/ tree is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { listDecks, listPracticeArtifacts, readDeck, readPracticeArtifact } from '../lib/learn.mjs';

const SLUG = 'ds-store-fixture';
let fixtureRoot;
let originalLearnRoot;

before(() => {
  originalLearnRoot = config.learnRoot;
  fixtureRoot = mkdtempSync(join(tmpdir(), 'learn-test-'));
  config.learnRoot = fixtureRoot;

  const quizRoot = join(fixtureRoot, SLUG, 'quizzes');
  const conceptDir = join(quizRoot, 'your-first-model');
  mkdirSync(conceptDir, { recursive: true });
  writeFileSync(
    join(fixtureRoot, SLUG, 'state.json'),
    `${JSON.stringify({
      version: 1, topic: 'Fixture', slug: SLUG, created: '2026-01-01', domains: [{
        name: 'Fixture domain', slug: 'fixture-domain', concepts: [{
          name: 'Your First Model', slug: 'your-first-model', status: 'unexplored', confidence: 0,
          practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null, details: [],
        }, {
          name: 'Scaffold Concept', slug: 'scaffold-concept', status: 'unexplored', confidence: 0,
          practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null, details: [],
        }],
      }],
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(conceptDir, 'deck-001.json'),
    JSON.stringify({
      concept_slug: 'your-first-model',
      concept_name: 'Your First Model',
      created: '2026-07-21',
      questions: [{ id: 1 }, { id: 2 }],
    }),
  );

  // The bug's trigger: a non-directory entry sitting directly inside quizzes/,
  // alongside the real concept directory. Pre-fix, the scan tried to readdirSync
  // this file and threw ENOTDIR.
  writeFileSync(join(quizRoot, '.DS_Store'), '');
});

after(() => {
  config.learnRoot = originalLearnRoot;
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

/** A small, isolated mapped topic for practice-boundary regression tests. */
function writePracticeTopic(slug, conceptSlug) {
  const root = join(fixtureRoot, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'state.json'),
    `${JSON.stringify({
      version: 1, topic: 'Practice boundary fixture', slug, created: '2026-01-01', domains: [{
        name: 'Fixture domain', slug: 'fixture-domain', concepts: [{
          name: 'Bounded concept', slug: conceptSlug, status: 'unexplored', confidence: 0,
          practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null, details: [],
        }],
      }],
    }, null, 2)}\n`,
  );
  return root;
}

test('listDecks skips a stray .DS_Store in quizzes/ instead of throwing ENOTDIR', () => {
  const decks = listDecks(SLUG);
  assert.equal(decks.length, 1, 'the one real concept deck should be listed');
  assert.equal(decks[0].concept_slug, 'your-first-model');
  assert.equal(decks[0].question_count, 2);
});

test('readDeck resolves a deck by name past a stray .DS_Store', () => {
  const deck = readDeck(SLUG, 'deck-001.json');
  assert.equal(deck.concept_name, 'Your First Model');
});

test('listPracticeArtifacts reports real files for mapped concepts only', () => {
  const exercises = join(fixtureRoot, SLUG, 'exercises');
  mkdirSync(join(exercises, 'your-first-model'), { recursive: true });
  mkdirSync(join(exercises, 'empty-mapped-concept'), { recursive: true });
  mkdirSync(join(exercises, 'removed-concept'), { recursive: true });
  writeFileSync(join(exercises, 'your-first-model', 'README.md'), '# Exercise');
  writeFileSync(join(exercises, 'your-first-model', 'starter.js'), '// TODO');
  writeFileSync(join(exercises, 'your-first-model', '.DS_Store'), 'ignored');
  writeFileSync(join(exercises, 'removed-concept', 'README.md'), '# Old exercise');

  assert.deepEqual(listPracticeArtifacts(SLUG, [
    { slug: 'your-first-model', name: 'Your First Model' },
    { slug: 'empty-mapped-concept', name: 'Empty Mapped Concept' },
  ]), [{
    concept_slug: 'your-first-model', concept_name: 'Your First Model', files: ['README.md', 'starter.js'],
  }]);
});

test('listPracticeArtifacts treats a file named exercises as no practice library', () => {
  const fileTopic = 'exercise-file-fixture';
  mkdirSync(join(fixtureRoot, fileTopic), { recursive: true });
  writeFileSync(join(fixtureRoot, fileTopic, 'exercises'), 'not a directory');
  assert.deepEqual(listPracticeArtifacts(fileTopic, [{ slug: 'anything', name: 'Anything' }]), []);
});

test('readPracticeArtifact stays under a mapped concept and returns text only', () => {
  assert.deepEqual(readPracticeArtifact(SLUG, 'your-first-model', 'README.md'), {
    file: 'README.md', content: '# Exercise',
  });
  assert.throws(() => readPracticeArtifact(SLUG, 'removed-concept', 'README.md'), /not mapped/);
  assert.throws(() => readPracticeArtifact(SLUG, 'your-first-model', '../state.json'), /invalid practice artifact path/);
});

test('answer-bearing artifacts stay locked in the index until the reveal route records consent', () => {
  const slug = 'practice-solution-boundary';
  const conceptSlug = 'bounded-concept';
  const root = writePracticeTopic(slug, conceptSlug);
  const dir = join(root, 'exercises', conceptSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'solution.py'), 'answer = 42\n');

  assert.throws(
    () => readPracticeArtifact(slug, conceptSlug, 'solution.py'),
    (err) => err.status === 404,
  );
  // The filename is useful navigation metadata, but its answer-bearing contents never
  // cross the boundary until the router has committed an explicit reveal event.
  assert.deepEqual(listPracticeArtifacts(slug, [{ slug: conceptSlug, name: 'Bounded concept' }]), [{
    concept_slug: conceptSlug,
    concept_name: 'Bounded concept',
    files: [],
    locked_files: ['solution.py'],
  }]);
  assert.deepEqual(
    readPracticeArtifact(slug, conceptSlug, 'solution.py', { allowProtected: true }),
    { file: 'solution.py', content: 'answer = 42\n' },
  );
});

test('practice artifact reads reject symlink escapes instead of following them', () => {
  const slug = 'practice-symlink-read-boundary';
  const conceptSlug = 'bounded-concept';
  const root = writePracticeTopic(slug, conceptSlug);
  const dir = join(root, 'exercises', conceptSlug);
  const outside = join(fixtureRoot, 'practice-read-escape.txt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outside, 'outside the approved practice root\n');
  symlinkSync(outside, join(dir, 'outside.txt'));

  assert.throws(
    () => readPracticeArtifact(slug, conceptSlug, 'outside.txt'),
    (err) => err.status === 404,
  );
  assert.deepEqual(listPracticeArtifacts(slug, [{ slug: conceptSlug, name: 'Bounded concept' }]), []);
});

test('practice artifact reads reject a symlinked exercises root instead of listing or following it', () => {
  const slug = 'practice-symlink-root-boundary';
  const conceptSlug = 'bounded-concept';
  const root = writePracticeTopic(slug, conceptSlug);
  const outside = join(fixtureRoot, 'practice-root-escape');
  mkdirSync(join(outside, conceptSlug), { recursive: true });
  writeFileSync(join(outside, conceptSlug, 'README.md'), 'outside the approved practice root\n');
  symlinkSync(outside, join(root, 'exercises'), 'dir');

  assert.throws(
    () => readPracticeArtifact(slug, conceptSlug, 'README.md'),
    (err) => err.status === 404,
  );
  assert.deepEqual(listPracticeArtifacts(slug, [{ slug: conceptSlug, name: 'Bounded concept' }]), []);
});

// ---------- F12: a corrupt deck is reported, not silently dropped ----------

test('listDecks reports an unreadable deck instead of hiding it', () => {
  // The old behaviour swallowed the parse error and returned only the good decks, so a
  // corrupted file was indistinguishable from one that never existed — the user reads it
  // as "I have fewer decks than I remember" and never suspects corruption.
  const conceptDir = join(fixtureRoot, SLUG, 'quizzes', 'your-first-model');
  writeFileSync(join(conceptDir, 'deck-broken.json'), '{"concept_slug": "broken",');

  const decks = listDecks(SLUG);
  assert.equal(decks.length, 2, 'the broken deck must still be listed');

  const broken = decks.find((d) => d.file === 'deck-broken.json');
  assert.ok(broken, 'the unreadable deck is missing from the listing');
  assert.match(broken.unreadable, /JSON/, 'it should carry the parse error');
  // Null rather than 0: nothing is known about its contents, and 0 would read as a real
  // count and let the UI render it as an empty-but-valid deck.
  assert.equal(broken.question_count, null);

  const good = decks.find((d) => d.file === 'deck-001.json');
  assert.equal(good.unreadable, undefined, 'a readable deck must not be marked');
  assert.equal(good.question_count, 2);

  rmSync(join(conceptDir, 'deck-broken.json'), { force: true });
});

test('readDeck tells an unreadable deck apart from a missing one', () => {
  // 422 not 500: the file exists and is corrupt, which is a fact about the data, not the
  // cockpit failing. Unguarded this threw out of JSON.parse and surfaced as a 500.
  const conceptDir = join(fixtureRoot, SLUG, 'quizzes', 'your-first-model');
  writeFileSync(join(conceptDir, 'deck-broken.json'), 'not json');

  assert.throws(
    () => readDeck(SLUG, 'deck-broken.json'),
    (err) => err.status === 422 && /unreadable/.test(err.message),
  );
  assert.throws(
    () => readDeck(SLUG, 'deck-absent.json'),
    (err) => err.status === 404,
  );

  rmSync(join(conceptDir, 'deck-broken.json'), { force: true });
});

test('listDecks tells a damaged deck apart from one it could not read', () => {
  // Different findings needing different actions: repair the file, versus look at the disk
  // or permissions. Calling an I/O failure "cannot be parsed" is a false diagnosis, and it
  // sends `npm run verify` to exit 1 ("damage found") when the honest answer is exit 2.
  //
  // A directory where a deck file should be gives EISDIR from readFileSync — deterministic,
  // unlike a chmod trigger, which does nothing when the suite runs as root.
  const conceptDir = join(fixtureRoot, SLUG, 'quizzes', 'your-first-model');
  writeFileSync(join(conceptDir, 'deck-parse.json'), '{"truncated":');
  mkdirSync(join(conceptDir, 'deck-io.json'), { recursive: true });

  try {
    const decks = listDecks(SLUG);
    const parse = decks.find((d) => d.file === 'deck-parse.json');
    const io = decks.find((d) => d.file === 'deck-io.json');

    assert.equal(parse.unreadable_kind, 'parse', 'a JSON syntax error is damaged content');
    assert.equal(io.unreadable_kind, 'io', 'an EISDIR is a failure to read, not damage');
    assert.match(io.unreadable, /EISDIR|directory/i);
  } finally {
    rmSync(join(conceptDir, 'deck-parse.json'), { force: true });
    rmSync(join(conceptDir, 'deck-io.json'), { recursive: true, force: true });
  }
});
