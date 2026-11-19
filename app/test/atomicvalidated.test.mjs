// WHAT: readJsonValidated and writeJsonValidated, the validated JSON pair the chapter
//       renderer's manifest will use (renderer-foundations, step 2).
// WHY:  A manifest that parses can still be wrong, and a wrong one must neither be served
//       nor kept as the backup. These are new exports beside readJsonSafe and
//       writeJsonAtomicSync, which stay exactly as atomiccharacter.test.mjs pins them.
//       Loaded with import() so the missing exports fail only this file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-atomicvalidated-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const validate = (v) => (v && typeof v === 'object' && typeof v.ok === 'boolean' ? [] : [{ path: 'ok', message: 'must be a boolean' }]);
const GOOD = '{"ok":true}';
const OLDER = '{"ok":false}';
const INVALID = '{"ok":"yes"}';

let n = 0;
function file({ primary, backup } = {}) {
  const dir = mkdtempSync(join(ROOT, `case-${n += 1}-`));
  const path = join(dir, 'manifest.json');
  if (primary === 'DIR') mkdirSync(path);
  else if (primary !== undefined) writeFileSync(path, primary);
  if (backup !== undefined) writeFileSync(`${path}.bak`, backup);
  return path;
}
const listing = (path) => Object.fromEntries(readdirSync(join(path, '..')).map((f) => [f, readFileSync(join(path, '..', f), 'utf8')]));

test('read: a valid primary is primary', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  assert.deepEqual(readJsonValidated(file({ primary: GOOD }), null, validate), { value: { ok: true }, source: 'primary', error: null });
});

test('read: a primary that parses but fails validation falls to a valid backup, saying why', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  const r = readJsonValidated(file({ primary: INVALID, backup: OLDER }), null, validate);
  assert.deepEqual(r.value, { ok: false });
  assert.equal(r.source, 'backup');
  assert.match(r.error, /ok: must be a boolean/);
});

test('read: both missing is missing; a missing primary with a valid backup is the backup', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  assert.deepEqual(readJsonValidated(file(), 'fb', validate), { value: 'fb', source: 'missing', error: null });
  assert.deepEqual(readJsonValidated(file({ backup: GOOD }), null, validate),
    { value: { ok: true }, source: 'backup', error: 'primary file is missing' });
});

test('read: a missing primary beside an unusable backup is a fallback with an error, not missing', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  for (const backup of ['{', INVALID]) {
    const r = readJsonValidated(file({ backup }), 'fb', validate);
    assert.equal(r.value, 'fb', backup);
    assert.equal(r.source, 'fallback', backup);
    assert.match(r.error, /primary missing; backup unusable/, backup);
  }
});

test('read: an invalid primary and an invalid backup are the fallback, never served', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  const r = readJsonValidated(file({ primary: INVALID, backup: INVALID }), 'fb', validate);
  assert.equal(r.value, 'fb');
  assert.equal(r.source, 'fallback');
  assert.match(r.error, /must be a boolean/);
});

test('read: an I/O failure carries its code instead of passing for missing', async () => {
  const { readJsonValidated } = await import('../lib/atomic.mjs');
  const r = readJsonValidated(file({ primary: 'DIR' }), 'fb', validate);
  assert.equal(r.source, 'fallback');
  assert.equal(r.code, 'EISDIR');
});

test('write: an invalid value is refused and no file changes', async () => {
  const { writeJsonValidated } = await import('../lib/atomic.mjs');
  const path = file({ primary: GOOD, backup: OLDER });
  const before = listing(path);
  assert.throws(() => writeJsonValidated(path, { ok: 'nope' }, validate), /refusing invalid JSON write: ok: must be a boolean/);
  assert.deepEqual(listing(path), before);
});

test('write: a valid primary becomes the backup; an invalid one never does', async () => {
  const { writeJsonValidated } = await import('../lib/atomic.mjs');
  const kept = file({ primary: GOOD, backup: OLDER });
  writeJsonValidated(kept, { ok: false }, validate);
  assert.equal(readFileSync(kept, 'utf8'), '{\n  "ok": false\n}\n');
  assert.equal(readFileSync(`${kept}.bak`, 'utf8'), GOOD);

  const notKept = file({ primary: INVALID, backup: OLDER });
  writeJsonValidated(notKept, { ok: true }, validate);
  assert.equal(readFileSync(`${notKept}.bak`, 'utf8'), OLDER, 'an invalid primary must not replace a good backup');
  assert.equal(existsSync(`${notKept}.tmp`), false);
});

test('both refuse to run without a validator, so a caller cannot forget it', async () => {
  const { readJsonValidated, writeJsonValidated } = await import('../lib/atomic.mjs');
  assert.throws(() => readJsonValidated(file({ primary: GOOD }), null), TypeError);
  assert.throws(() => writeJsonValidated(file(), { ok: true }), TypeError);
});
