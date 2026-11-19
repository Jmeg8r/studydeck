// WHAT: Regression tests for fact-check answer secrecy (assessment finding F2).
// WHY: Claim generation stripped its own response, but GET /api/factcheck returned the
//      stored records verbatim — so every truth value and correction, for every saved
//      set, reached the browser before any attempt. The frontend discarded them when
//      rendering, which is not secrecy: the payload had already crossed the wire and sat
//      in devtools. That defeats the whole exercise, since verification IS the active
//      ingredient here.
//
// The assertions walk the payload recursively rather than checking known keys, so a
// future field carrying the verdict cannot slip through a shape change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicateRun, parseClaims, stripAllClaimAnswers, stripClaimAnswers } from '../lib/factcheck.mjs';

const record = {
  source_id: 'source:abc',
  source_title: 'Chapter 1',
  section: null,
  generated: '2026-07-28T10:00:00Z',
  claims: [
    { id: 'c1', text: 'A validation set measures generalisation.', truth: true, correction: null },
    { id: 'c2', text: 'fine_tune freezes the head.', truth: false, correction: 'It freezes the BODY for one epoch.' },
  ],
};

/** Every key anywhere in the payload, at any depth. */
function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      allKeys(child, found);
    }
  }
  return found;
}

test('a stripped record carries no verdict at any depth', () => {
  const keys = allKeys(stripClaimAnswers(record));
  assert.equal(keys.has('truth'), false);
  assert.equal(keys.has('correction'), false);
});

test('stripping keeps everything the exercise actually needs', () => {
  const safe = stripClaimAnswers(record);
  assert.equal(safe.claims.length, 2);
  assert.deepEqual(safe.claims.map((c) => c.id), ['c1', 'c2']);
  assert.equal(safe.claims[1].text, 'fine_tune freezes the head.');
  // Metadata the UI shows on the list row must survive.
  assert.equal(safe.source_title, 'Chapter 1');
  assert.equal(safe.generated, '2026-07-28T10:00:00Z');
});

test('the stored record is untouched — the server still needs the verdicts to grade', () => {
  stripClaimAnswers(record);
  assert.equal(record.claims[0].truth, true);
  assert.equal(record.claims[1].correction, 'It freezes the BODY for one epoch.');
});

test('the whole-map form strips every set, not just the first', () => {
  const all = {
    'source:abc#all': record,
    'source:def#Chapter 2': { ...record, source_id: 'source:def' },
  };
  const keys = allKeys(stripAllClaimAnswers(all));
  assert.equal(keys.has('truth'), false);
  assert.equal(keys.has('correction'), false);
  assert.deepEqual(Object.keys(stripAllClaimAnswers(all)), Object.keys(all));
});

test('a false claim with no correction still loses its truth flag', () => {
  // parseClaims allows a FALSE line with no correction — the truth flag is the part the
  // exercise depends on, so it is the part that must not leak.
  const { claims } = parseClaims('FALSE | The head is frozen.');
  const safe = stripClaimAnswers({ claims });
  assert.equal('truth' in safe.claims[0], false);
  assert.equal('correction' in safe.claims[0], false);
});

test('adjudication accepts only own, bounded learner decisions', () => {
  const proposed = [{ id: 'c1', text: 'A claim.', truth: true, correction: null, marked: true, answered: true }];
  const inherited = Object.create({ c1: { action: 'accept' } });
  assert.equal(adjudicateRun(record, proposed, inherited).results[0].adjudication, 'pending');

  assert.throws(
    () => adjudicateRun(record, proposed, { c1: { action: 'dispute', rationale: 'x'.repeat(2_001) } }),
    /rationale/,
  );
  assert.throws(
    () => adjudicateRun(record, proposed, { c1: { action: 'correct', truth: false, correction: 'x'.repeat(4_001) } }),
    /correction/,
  );
  assert.throws(
    () => adjudicateRun(record, proposed, { c1: { action: 'accept', rationale: ['not text'] } }),
    /rationale/,
  );
});
