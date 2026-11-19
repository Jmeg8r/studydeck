// WHAT: Characterization of readJsonSafe and writeJsonAtomicSync as they behave on main.
// WHY:  Rule 8 routes every JSON write through these two functions, so their behaviour is
//       pinned here case by case. renderer-foundations pinned them unchanged beside the new
//       validated pair. readjson-damage (James, 2026-11-11) then moved one case on purpose:
//       a missing primary beside an unusable backup is damage, not "missing", and only
//       ENOENT on both copies means missing. Any other edit here is a behaviour change and
//       needs its own intent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomicSync } from '../lib/atomic.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-atomiccharacter-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
/** A fresh path in its own directory, with an optional primary and backup. */
function file({ primary, backup } = {}) {
  const dir = mkdtempSync(join(ROOT, `case-${n += 1}-`));
  const path = join(dir, 'data.json');
  if (primary !== undefined) writeFileSync(path, primary);
  if (backup !== undefined) writeFileSync(`${path}.bak`, backup);
  return path;
}

test('readJsonSafe: an intact primary is read as primary', () => {
  const r = readJsonSafe(file({ primary: '{"a":1}' }), null);
  assert.deepEqual(r, { value: { a: 1 }, source: 'primary', error: null });
});

test('readJsonSafe: a corrupt primary with a good backup is read from the backup', () => {
  const r = readJsonSafe(file({ primary: '{', backup: '{"a":2}' }), null);
  assert.deepEqual(r.value, { a: 2 });
  assert.equal(r.source, 'backup');
  assert.equal(typeof r.error, 'string');
});

test('readJsonSafe: both missing is missing, with the fallback and no error', () => {
  assert.deepEqual(readJsonSafe(file(), 'fallback'), { value: 'fallback', source: 'missing', error: null });
});

test('readJsonSafe: a missing primary with a good backup is read from the backup', () => {
  assert.deepEqual(readJsonSafe(file({ backup: '{"a":3}' }), null),
    { value: { a: 3 }, source: 'backup', error: 'primary file is missing' });
});

test('readJsonSafe: a missing primary with a bad backup is damage, not missing', () => {
  const r = readJsonSafe(file({ backup: '{' }), 'fallback');
  assert.equal(r.value, 'fallback');
  assert.equal(r.source, 'fallback');
  assert.match(r.error, /^primary missing; backup unusable:/);
});

// existsSync answers false for ANY stat failure, so these primaries used to read as missing.
// ENOTDIR fails the stat on every platform, root included; EACCES is the real-world case.
const ROOT_IGNORES_MODES = process.getuid?.() === 0 && 'root ignores directory permissions';

test('readJsonSafe: a primary whose parent is a file is damage, not missing', () => {
  const dir = mkdtempSync(join(ROOT, 'notdir-'));
  writeFileSync(join(dir, 'notadir'), 'a file, not a directory');
  const r = readJsonSafe(join(dir, 'notadir', 'data.json'), 'fallback');
  assert.equal(r.value, 'fallback');
  assert.equal(r.source, 'fallback');
  assert.equal(r.code, 'ENOTDIR');
});

test('readJsonSafe: a primary in a directory it cannot search is damage, not missing', { skip: ROOT_IGNORES_MODES }, () => {
  const dir = join(mkdtempSync(join(ROOT, 'eacces-')), 'locked');
  mkdirSync(dir);
  writeFileSync(join(dir, 'data.json'), '{"a":4}');
  chmodSync(dir, 0o000);
  try {
    const r = readJsonSafe(join(dir, 'data.json'), 'fallback');
    assert.equal(r.value, 'fallback');
    assert.equal(r.source, 'fallback');
    assert.equal(r.code, 'EACCES');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('readJsonSafe: an unreadable primary beside a good backup is read from the backup (guard)', () => {
  const path = file({ backup: '{"a":5}' });
  mkdirSync(path);
  const r = readJsonSafe(path, null);
  assert.deepEqual(r.value, { a: 5 });
  assert.equal(r.source, 'backup');
  assert.equal(typeof r.error, 'string');
});

test('readJsonSafe: a corrupt primary with a corrupt backup is the fallback, with the primary error', () => {
  const r = readJsonSafe(file({ primary: '{', backup: '{' }), 'fallback');
  assert.equal(r.value, 'fallback');
  assert.equal(r.source, 'fallback');
  assert.equal(typeof r.error, 'string');
});

test('writeJsonAtomicSync: a write keeps the previous primary as .bak, and writes 2-space JSON', () => {
  const path = file({ primary: '{"old":true}\n' });
  writeJsonAtomicSync(path, { next: 1 });
  assert.equal(readFileSync(path, 'utf8'), '{\n  "next": 1\n}\n');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{"old":true}\n');
});

test('writeJsonAtomicSync: a write over a corrupt primary leaves the old .bak alone', () => {
  const path = file({ primary: '{', backup: '{"good":true}\n' });
  writeJsonAtomicSync(path, { next: 2 });
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{"good":true}\n');
});

test('writeJsonAtomicSync: a first write makes no .bak, and takes no validator today', () => {
  const path = file();
  writeJsonAtomicSync(path, { first: true }, () => [{ path: '', message: 'ignored' }]);
  assert.equal(existsSync(`${path}.bak`), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { first: true }, 'a third argument is ignored');
});
