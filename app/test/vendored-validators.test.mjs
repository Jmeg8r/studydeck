// WHAT: Guards a LOCAL PATCH to vendored learn-anything validator code.
// WHY: `mastery.mjs` shells out to the skills' `render.mjs` on every mastery update, and
//      that script validates state.json through `utils.mjs`. So this is not third-party
//      code the app merely sits next to — it runs inside the write path that PR #18 built
//      the rollback for.
//
//      `checkFields` used to return silently when an entry was null, recording no error,
//      after which the caller dereferenced it: validation CRASHED with a TypeError where it
//      should have reported invalid input. Found in PR #24's review, reproduced, and
//      patched in all ten copies.
//
// The last test is the point of this file. Rule 1 says `learn-anything-cli update`
// overwrites these generated files, so the patch is one upgrade away from vanishing — and
// it would vanish silently, restoring a crash nothing else here would notice. This suite
// fails loudly if that happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globSync } from 'node:fs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The copy render.mjs actually loads — mastery.mjs resolves .claude/skills by an explicit
// path, never a scan, so this is the one whose behaviour reaches state.json.
const { validateStateV1, validateQuizDeck } = await import(
  join(REPO_ROOT, '.claude/skills/learn-anything-quiz/scripts/utils.mjs')
);

const VALID_STATE = {
  version: 1,
  topic: 'T',
  slug: 't',
  created: '2026-07-28',
  domains: [
    {
      name: 'D',
      slug: 'd',
      concepts: [
        {
          name: 'C',
          slug: 'c',
          status: 'unexplored',
          confidence: 0,
          practice_count: 0,
          explain_count: 0,
          last_explained: null,
          last_practiced: null,
          details: ['x'],
        },
      ],
    },
  ],
};

test('a null domain is reported, not thrown', () => {
  // Previously: TypeError "Cannot read properties of null (reading 'concepts')", which
  // reached the caller as a crashed subprocess rather than a validation failure.
  const errors = validateStateV1({ ...VALID_STATE, domains: [null] });
  assert.ok(errors.length > 0, 'invalid input must produce an error, not an exception');
  assert.equal(errors[0].path, 'domains[0]');
});

test('a null concept inside a real domain is reported, not thrown', () => {
  const errors = validateStateV1({
    ...VALID_STATE,
    domains: [{ name: 'D', slug: 'd', concepts: [null] }],
  });
  assert.ok(errors.some((e) => e.path === 'domains[0].concepts[0]'));
});

test('a null question is reported, not thrown', () => {
  // Same defect on the deck side: checkFields no-oped, then `rec.type` dereferenced null.
  const errors = validateQuizDeck({
    version: 1,
    topic: 'T',
    topic_slug: 't',
    concept_slug: 'c',
    concept_name: 'C',
    created: '2026-07-28',
    questions: [null],
  });
  assert.ok(errors.some((e) => e.path === 'questions[0]'));
});

test('valid input still validates clean', () => {
  // The patch must not have turned a working state into a rejected one — mastery.mjs rolls
  // state.json back when render fails, so a false positive here would block every update.
  assert.deepEqual(validateStateV1(VALID_STATE), []);
});

test('all ten vendored copies are byte-identical, so the patch cannot half-exist', () => {
  const copies = [
    ...globSync('.claude/skills/*/scripts/utils.mjs', { cwd: REPO_ROOT }),
    ...globSync('.agents/skills/*/scripts/utils.mjs', { cwd: REPO_ROOT }),
  ].sort();

  assert.equal(copies.length, 10, 'expected five skills in each of .claude and .agents');

  const contents = copies.map((p) => readFileSync(join(REPO_ROOT, p), 'utf8'));
  const distinct = new Set(contents);
  assert.equal(distinct.size, 1, `copies have drifted: ${copies.join(', ')}`);

  // Named explicitly: a `learn-anything-cli update` regenerates these files (rule 1) and
  // would drop the patch without any other test noticing.
  assert.ok(contents[0].includes('LOCAL PATCH (studydeck)'), 'the local patch is gone — an upstream update likely overwrote it');
});
