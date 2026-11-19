// WHAT: Tests for the crash-safe write layer in lib/atomic.mjs.
// WHY: The failure this module exists to prevent is invisible in normal use — a bare
//      writeFileSync only corrupts a file if the process dies mid-write, and the sidecar
//      reader then degrades the corrupt file to an empty fallback. So the properties are
//      pinned here directly: no partial file is ever visible, the last parseable copy is
//      retained, a corrupt primary is recovered from it, and a torn append cannot eat the
//      record that follows it.
//
// Node stdlib only, matching the app's zero-dependency ethos.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_SUFFIX, appendLineSync, readJsonSafe, staleTempFiles, writeFileAtomicSync,
  writeJsonAtomicSync,
} from '../lib/atomic.mjs';

let dir;
let target;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-test-'));
  target = join(dir, 'cards.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomicSync leaves no temp file behind', () => {
  writeFileAtomicSync(target, 'hello');
  assert.equal(readFileSync(target, 'utf8'), 'hello');
  assert.deepEqual(staleTempFiles(dir), []);
  assert.deepEqual(readdirSync(dir), ['cards.json']);
});

test('writeJsonAtomicSync keeps learn-anything formatting: 2-space, trailing newline', () => {
  writeJsonAtomicSync(target, { a: 1 });
  assert.equal(readFileSync(target, 'utf8'), '{\n  "a": 1\n}\n');
});

test('writeJsonAtomicSync retains the previous contents as .bak', () => {
  writeJsonAtomicSync(target, [{ id: 'one' }]);
  writeJsonAtomicSync(target, [{ id: 'one' }, { id: 'two' }]);

  assert.equal(JSON.parse(readFileSync(target, 'utf8')).length, 2);
  assert.equal(JSON.parse(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8')).length, 1);
});

test('readJsonSafe recovers a corrupt primary from the backup, and says so', () => {
  writeJsonAtomicSync(target, [{ id: 'one' }]);
  writeJsonAtomicSync(target, [{ id: 'one' }, { id: 'two' }]);

  // What a crash mid-write used to leave: a truncated object.
  writeFileSync(target, '[{"id": "one"}, {"id": "tw');

  const result = readJsonSafe(target, []);
  assert.equal(result.source, 'backup');
  assert.equal(result.value.length, 1, 'the last known-good copy, not the empty fallback');
  assert.match(result.error, /JSON/i);
});

test('a corrupt primary never overwrites the good backup', () => {
  writeJsonAtomicSync(target, [{ id: 'one' }]);
  writeJsonAtomicSync(target, [{ id: 'one' }, { id: 'two' }]); // .bak now holds ["one"]
  writeFileSync(target, '[{"id": "one"}, {"id": "tw');

  // The recovery path: read the backup, then write the repaired value back out. If the
  // write had copied the corrupt primary over .bak first, the only good copy would be
  // gone — which is how a backup scheme turns one bad file into two.
  const recovered = readJsonSafe(target, []).value;
  writeJsonAtomicSync(target, [...recovered, { id: 'two' }]);

  const backup = JSON.parse(readFileSync(`${target}${BACKUP_SUFFIX}`, 'utf8'));
  assert.deepEqual(backup, [{ id: 'one' }], 'the backup must not have been replaced by the corrupt file');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).length, 2, 'the repaired write landed');
});

test('readJsonSafe reports missing vs unrecoverable distinctly', () => {
  assert.equal(readJsonSafe(target, 'FALLBACK').source, 'missing');

  writeFileSync(target, 'not json');
  const unrecoverable = readJsonSafe(target, 'FALLBACK');
  assert.equal(unrecoverable.source, 'fallback');
  assert.equal(unrecoverable.value, 'FALLBACK');
});

test('readJsonSafe uses an orphan backup when the primary file is gone', () => {
  writeJsonAtomicSync(target, [{ id: 'one' }]);
  writeJsonAtomicSync(target, [{ id: 'one' }, { id: 'two' }]);
  rmSync(target);

  const result = readJsonSafe(target, []);
  assert.equal(result.source, 'backup');
  assert.equal(result.value.length, 1);
});

test('appendLineSync heals a torn line instead of fusing it to the next record', () => {
  const log = join(dir, 'attempts.jsonl');
  writeFileSync(log, '{"id":"a"}\n{"id":"b"'); // second append died mid-write

  appendLineSync(log, JSON.stringify({ id: 'c' }));

  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  // The torn record is still unparseable — it was lost when it was torn. What matters is
  // that the NEW record survived rather than being swallowed by the fragment.
  assert.throws(() => JSON.parse(lines[1]));
  assert.deepEqual(JSON.parse(lines[2]), { id: 'c' });
});

test('appendLineSync writes one terminated line per record on a clean file', () => {
  const log = join(dir, 'reviews.jsonl');
  appendLineSync(log, JSON.stringify({ n: 1 }));
  appendLineSync(log, JSON.stringify({ n: 2 }));

  assert.equal(readFileSync(log, 'utf8'), '{"n":1}\n{"n":2}\n');
});

test('a failed write leaves no temp file to be misread as a crash artifact', () => {
  // Stands in for the real cases (ENOSPC, permissions): a failure INSIDE the write,
  // before the rename. That path used to leak a .tmp, because only the rename had
  // cleanup — and staleTempFiles then reports a handled error as a crash.
  assert.throws(() => writeFileAtomicSync(target, { not: 'writable data' }));

  assert.deepEqual(staleTempFiles(dir), []);
  assert.equal(readdirSync(dir).length, 0, 'nothing at all was left behind');
});

test('staleTempFiles surfaces a temp file left by a crashed write', () => {
  writeFileSync(join(dir, '.cards.json.999.abcd1234.tmp'), 'partial');
  assert.deepEqual(staleTempFiles(dir), ['.cards.json.999.abcd1234.tmp']);
});
