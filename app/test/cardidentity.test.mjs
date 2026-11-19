import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatedCardId } from '../lib/cardidentity.mjs';

test('v2 generated card ids preserve distinctions punctuation-normalisation lost', () => {
  const colon = generatedCardId('quiz-miss', 'lesson:1/q1');
  const slash = generatedCardId('quiz-miss', 'lesson-1:q1');
  assert.notEqual(colon, slash);
  assert.match(colon, /^card-v2-quiz-miss-[A-Za-z0-9_-]{22}$/);
});

test('a generated card id is stable for the complete source reference', () => {
  const ref = 'source:abc#section/1:claim.2';
  assert.equal(generatedCardId('factcheck', ref), generatedCardId('factcheck', ref));
  assert.notEqual(generatedCardId('factcheck', ref), generatedCardId('quiz-miss', ref));
});
