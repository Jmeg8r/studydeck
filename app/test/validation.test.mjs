import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFiniteNumber, assertInteger, assertKnownTopic, assertPlainObject, assertString,
} from '../lib/validation.mjs';

const TOPICS = [{ slug: 'deep-learning' }];

test('topic validation rejects path-shaped and non-string values before a path can be selected', () => {
  for (const value of ['../outside', 'deep/learning', 'deep%2Flearning', 'deep\\learning', 'deep\0learning', 7, null]) {
    assert.throws(() => assertKnownTopic(TOPICS, value), { status: 400 });
  }
  assert.equal(assertKnownTopic(TOPICS, 'deep-learning'), 'deep-learning');
});

test('numeric and structural validators reject the values JSON routes must not coerce', () => {
  for (const value of [0, -1, 2.5, 21, '5', NaN, Infinity]) {
    assert.throws(() => assertInteger(value, 'max', { min: 1, max: 20 }), { status: 400 });
  }
  assert.equal(assertInteger(5, 'max', { min: 1, max: 20 }), 5);
  assert.throws(() => assertFiniteNumber(1.01, 'position', { min: 0, max: 1 }), { status: 400 });
  assert.throws(() => assertPlainObject([], 'responses'), { status: 400 });
  assert.throws(() => assertString('x'.repeat(9), 'title', { max: 8 }), { status: 400 });
});

test('numeric validators reject invalid bounds instead of silently making them unbounded', () => {
  assert.throws(() => assertInteger(3, 'score', { min: 0, max: undefined }), /bounds/);
  assert.throws(() => assertFiniteNumber(0.5, 'position', { min: NaN, max: 1 }), /bounds/);
});
