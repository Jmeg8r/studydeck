// WHAT: The drift checker's own logic.
// WHY:  Roadmap A6. This does NOT pin Open Notebook's response shape — read
//       lib/oncontract.mjs's header for why that distinction is load-bearing. The payloads
//       below are INPUTS to our checker, the way a string is an input to a parser. If ON
//       changes tomorrow, nothing here goes stale: the checker still has to classify a
//       payload correctly, and "classifies a changed payload as drifted" is precisely the
//       behaviour under test.
//
// The case worth the file is `indeterminate`. An empty notebook and an unreachable service
// both prove NOTHING about the shape, and reporting either as ok would make a green run
// mean "I looked and there was nothing to look at" — the exact failure `verify.mjs` was
// built to avoid, and the reason it has a third exit code at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSourcesPayload, probeSources } from '../lib/oncontract.mjs';

const source = (over = {}) => ({ id: 'source:1', title: '1. Chapter One', ...over });

test('a payload carrying id and title is ok', () => {
  const result = inspectSourcesPayload([source(), source({ id: 'source:2', title: '2. Two' })]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.findings, []);
});

test('a non-array is drift, because listSources calls .map on it and throws', () => {
  for (const payload of [null, undefined, {}, 'sources', 42]) {
    assert.equal(inspectSourcesPayload(payload).status, 'drifted', `${JSON.stringify(payload)} was not drift`);
  }
  assert.match(inspectSourcesPayload({ items: [] }).findings[0], /not an array/);
});

test('an empty notebook is INDETERMINATE, never ok', () => {
  // The whole reason this distinction exists. An empty list is what a drifted `/api/sources`
  // looks like from the outside AND what a genuinely empty notebook looks like. Calling it
  // ok would report "no drift" on the exact payload that drift produces.
  const result = inspectSourcesPayload([]);
  assert.equal(result.status, 'indeterminate');
  assert.match(result.findings[0], /could not be checked/);
});

test('a missing id is drift — every source becomes unopenable', () => {
  const result = inspectSourcesPayload([source(), source({ id: undefined })]);
  assert.equal(result.status, 'drifted');
  assert.match(result.findings[0], /1 of 2 source\(s\) have no `id`/);
});

test('a missing title is degradation — the fallback hides it', () => {
  // Reported precisely BECAUSE listSources has a fallback: '(untitled)' means nothing
  // throws, chapter ordering silently collapses, and episode names stop being unique.
  const result = inspectSourcesPayload([source({ title: null }), source({ id: 'source:2' })]);
  assert.equal(result.status, 'degraded');
  assert.match(result.findings[0], /have no `title`/);
});

test('a hard drift outranks a degradation, never the other way round', () => {
  const result = inspectSourcesPayload([source({ id: undefined, title: undefined })]);
  assert.equal(result.status, 'drifted', 'a cosmetic finding downgraded a breaking one');
  assert.equal(result.findings.length, 2, 'both findings should still be reported');
});

test('a null entry in the list counts as missing every field, not as a crash', () => {
  const result = inspectSourcesPayload([source(), null]);
  assert.equal(result.status, 'drifted');
});

test('an unreachable service is indeterminate, not drift', () => {
  // "I could not look" and "I looked and it changed" call for different actions, and
  // verify.mjs turns them into different exit codes. Collapsing them would send you
  // hunting for a corrupt file during an outage.
  return probeSources('notebook:x', async () => {
    throw new Error('fetch failed');
  }).then((result) => {
    assert.equal(result.status, 'indeterminate');
    assert.match(result.findings[0], /could not reach Open Notebook/);
  });
});

test('probeSources passes the notebook id through and classifies what comes back', async () => {
  let asked = null;
  const result = await probeSources('notebook:studydeck', async (id) => {
    asked = id;
    return [source()];
  });
  assert.equal(asked, 'notebook:studydeck');
  assert.equal(result.status, 'ok');
});

test('a non-string title is DRIFT, not degradation — it throws rather than degrading', () => {
  // CodeRabbit on #45, and the severity it suggested was too mild. `listSources` maps
  // `s.title ?? '(untitled)'`, and `??` only catches null/undefined — so a title of 42
  // survives the fallback and the chapter sort then calls `.match()` on a number and
  // THROWS. Verified against the real expression. That makes a mistyped title worse than
  // an absent one, which is the opposite of what field order would suggest.
  const result = inspectSourcesPayload([source(), source({ id: 'source:2', title: 42 })]);
  assert.equal(result.status, 'drifted');
  assert.match(result.findings[0], /non-string `title`/);
});

test('a non-string id is drift too', () => {
  const result = inspectSourcesPayload([source({ id: { nested: 'object' } })]);
  assert.equal(result.status, 'drifted');
  assert.match(result.findings[0], /non-string `id`/);
});

test('absent and mistyped are counted separately, never twice for one source', () => {
  // One source with no title, one with a numeric title: two findings, two different
  // causes, and neither count inflated by the other.
  const result = inspectSourcesPayload([source({ title: null }), source({ id: 'source:2', title: 7 })]);
  const [absent, mistyped] = result.findings;
  assert.match(absent, /1 of 2 source\(s\) have no `title`/);
  assert.match(mistyped, /1 of 2 source\(s\) have a non-string `title`/);
  assert.equal(result.status, 'drifted', 'the throwing case must set the severity');
});

test('severity escalates in BOTH discovery orders', () => {
  // Discovery order is FIELDS order, then absent-before-mistyped within a field — NOT the
  // order of the payload array. An earlier version of this comment said otherwise, which
  // mattered: a test that thinks it controls discovery order via the fixture is not
  // actually testing what it claims, and would stop exercising escalation the moment
  // FIELDS was reordered. Both directions are pinned here so neither can rot silently.

  // drift first, then degradation: `id` (drifted) precedes `title` (degraded) in FIELDS.
  assert.equal(
    inspectSourcesPayload([source({ id: undefined }), source({ id: 'source:2', title: null })]).status,
    'drifted',
    'a later degradation pulled the verdict down',
  );

  // degradation first, then drift: within `title`, absent (degraded) is checked before
  // mistyped (drifted). This direction is the one a naive `if (status === 'ok')` assignment
  // gets wrong, and it does not depend on FIELDS ordering at all.
  assert.equal(
    inspectSourcesPayload([source({ title: null }), source({ id: 'source:2', title: 42 })]).status,
    'drifted',
    'a drift discovered after a degradation failed to escalate',
  );
});

test('every non-ok status has a verify.mjs branch that is not the clean one', () => {
  // The gap this closes: `verify.mjs` routed `degraded` through the success branch and
  // printed "id and title present on every source" — a false statement about the precise
  // damage the probe exists to surface, with exit 0 to match. A status the checker can
  // return and the reporter does not handle is the shape of that bug, so the set of
  // statuses is pinned here rather than left to be re-derived at the call site.
  const statuses = new Set([
    inspectSourcesPayload([source()]).status,
    inspectSourcesPayload([]).status,
    inspectSourcesPayload([source({ title: null })]).status,
    inspectSourcesPayload([source({ id: undefined })]).status,
    inspectSourcesPayload('nonsense').status,
  ]);
  assert.deepEqual([...statuses].sort(), ['degraded', 'drifted', 'indeterminate', 'ok']);
});
