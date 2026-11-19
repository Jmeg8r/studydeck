// WHAT: The validators a restore checks a backup against before it writes anything.
// WHY:  A backup that parses can still be wrong — an empty object, a card with no back, a
//       schedule with no version. Restoring one would replace a damaged file with a quietly
//       broken one (backup-restore spec R4, R10). Ported from the September snapshot, and
//       checked read-only against every real file on 2026-11-11 before porting. A separate
//       file, loaded with import(), so a missing module fails only this.
import test from 'node:test';
import assert from 'node:assert/strict';

const good = {
  'cards.json': [{ id: 'c1', front: 'Q', back: 'A', created: '2026-11-11' }],
  'schedule.json': { version: 1, started: '2026-11-01', paused: false, step_overrides: {} },
  'reading.json': { 'source:1': { position: 0.5 } },
  'factchecks.json': { 'source:1': { source_id: 'source:1', claims: [{ id: 'k1', text: 'claim', truth: true }] } },
  'mindmaps.json': [{ concept: 'x' }],
};

const broken = {
  'cards.json': [[{ id: 'c1', front: 'Q', created: '2026-11-11' }], /front, back and created/],
  'schedule.json': [{ started: '2026-11-01', paused: false, step_overrides: {} }, /schedule version/],
  'reading.json': [{ 'source:1': { position: 2 } }, /reading position/],
  'factchecks.json': [{ 'source:1': { source_id: 'source:1', claims: [{ id: 'k1', text: 'claim' }] } }, /fact-check claim set/],
  'mindmaps.json': [{ concept: 'x' }, /array of recall records/],
};

test('a well-formed copy of every restorable sidecar validates', async () => {
  const { validateSidecar } = await import('../lib/schema.mjs');
  for (const [name, value] of Object.entries(good)) assert.deepEqual(validateSidecar(name, value), [], name);
});

test('one broken field per sidecar is refused, with a reason that names it', async () => {
  const { validateSidecar } = await import('../lib/schema.mjs');
  for (const [name, [value, reason]] of Object.entries(broken)) {
    const errors = validateSidecar(name, value);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0].message, reason, name);
  }
  assert.match(validateSidecar('cards.json', [good['cards.json'][0], good['cards.json'][0]])[0].message, /duplicate card ids/);
});

test('assertData throws a labelled 422 and returns valid data unchanged', async () => {
  const { assertData, validateSidecar, validateStateV1 } = await import('../lib/schema.mjs');
  const value = good['cards.json'];
  assert.equal(assertData(value, (v) => validateSidecar('cards.json', v), 'cards.json.bak'), value);
  assert.throws(() => assertData({}, validateStateV1, 'state.json.bak'), (err) => {
    assert.equal(err.status, 422);
    assert.match(err.message, /^state\.json\.bak: /);
    return true;
  });
});

test('every JSON sidecar has exactly one validator, and an unknown name never validates', async () => {
  // Two lists of sidecars drift: a seventh added to health and verify would be silently
  // missing from recover, and one added to the restore list without a validator would
  // accept any object as a valid backup (panel: design seat).
  const { SIDECAR_VALIDATORS, validateSidecar } = await import('../lib/schema.mjs');
  const { JSON_SIDECARS } = await import('../lib/sidecar.mjs');
  assert.ok(Array.isArray(JSON_SIDECARS), 'sidecar.mjs exports its list');
  assert.deepEqual(Object.keys(SIDECAR_VALIDATORS).sort(), [...JSON_SIDECARS].sort());
  assert.match(validateSidecar('notes.json', {})[0].message, /no validator for notes\.json/);
});

test('the restorable files are state.json plus exactly the sidecars health reports', async () => {
  const { RESTORABLE } = await import('../lib/restore.mjs');
  const { JSON_SIDECARS } = await import('../lib/sidecar.mjs');
  assert.deepEqual(RESTORABLE, ['state.json', ...JSON_SIDECARS]);
});
