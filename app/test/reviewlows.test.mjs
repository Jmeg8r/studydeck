// Regressions for the 2026-10-12 review lows: a no-findings diagnosis without a
// `findings` array, and the missed-concept cap keeping the most recent misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiagnosis } from '../lib/diagnosis.mjs';
import { missedConceptNames } from '../lib/sessions.mjs';
import { ROLE_LIMITS } from '../lib/roles.mjs';

test('a no-findings result without a findings array is still a diagnosis', () => {
  for (const result of ['no_shared_pattern', 'insufficient_evidence']) {
    const out = validateDiagnosis({ result }, []);
    assert.notEqual(out, null, result);
  }
  assert.equal(validateDiagnosis({ result: 'findings' }, []), null);
  assert.equal(validateDiagnosis({ result: 'no_shared_pattern', findings: 'x' }, []), null);
});

test('missed concepts keep the most recent misses when over the cap', () => {
  const n = ROLE_LIMITS.maxMissedConcepts + 5;
  const concepts = Array.from({ length: n }, (_, i) => ({ slug: `c${i}`, name: `C${i}` }));
  const attempts = concepts.map((c) => ({ concept_slug: c.slug, misses: [1] }));
  attempts.push({ concept_slug: 'c0', misses: [1] }); // c0: first missed long ago, missed again last
  const names = missedConceptNames('t', concepts, attempts);
  assert.equal(names.length, ROLE_LIMITS.maxMissedConcepts);
  assert.equal(names[0], 'C0');
  assert.ok(names.includes(`C${n - 1}`));
  assert.ok(!names.includes('C1'));
});
