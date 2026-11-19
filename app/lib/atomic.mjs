// WHAT: Crash-safe file writes, last-known-good backups, and torn-append healing.
// WHY: Every sidecar and state.json write used to be a bare writeFileSync — a
//      truncate-then-write. A crash between those two steps leaves a half-written file,
//      and the sidecar reader degrades a corrupt file to an empty fallback, so the damage
//      shows up as "no cards" rather than as an error. Rename is atomic on POSIX, so
//      writing to a temp file and renaming it into place means a reader only ever sees
//      the whole old file or the whole new one.
//
// HONESTY NOTE on durability: fsync() here flushes to the device, but Node cannot issue
// macOS's F_FULLFSYNC, which is what actually forces a platter/NAND flush on Darwin. So
// this is crash-safe against process and OS death — the guarantee that matters for a
// single-user local app — not a guarantee against power loss mid-write.
import {
  closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const TEMP_SUFFIX = '.tmp';
export const BACKUP_SUFFIX = '.bak';

const backupPath = (path) => `${path}${BACKUP_SUFFIX}`;

/** A temp name beside the target, so the rename never crosses a filesystem. */
function tempPathFor(path) {
  const unique = `${process.pid}.${randomBytes(4).toString('hex')}`;
  return join(dirname(path), `.${basename(path)}.${unique}${TEMP_SUFFIX}`);
}

/** Best-effort directory fsync: makes the rename itself durable where supported. */
function syncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some platforms refuse to fsync a directory handle. The rename is still atomic;
    // only its durability across a hard crash is weakened, so this must not throw.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Write `data` so that a reader never observes a partial file. */
export function writeFileAtomicSync(path, data) {
  const tmp = tempPathFor(path);
  const fd = openSync(tmp, 'wx');

  // Every failure path unlinks the temp file. A handled error — ENOSPC, a permission
  // problem — that left one behind would be reported by staleTempFiles() as a crash
  // artifact, which is the one thing a temp file is supposed to mean.
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }

  syncDir(dirname(path));
}

function tryReadJson(path) {
  if (!existsSync(path)) return { ok: false, error: 'file does not exist' };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Keep the current contents as `<path>.bak` before they are replaced.
 *
 * Only a file that still PARSES is retained: after a corrupt primary has been recovered
 * from backup, copying that corrupt primary over the backup would destroy the only good
 * copy. The backup is written temp-then-rename too, so it is never itself partial.
 */
function retainBackup(path) {
  if (!existsSync(path)) return;
  if (!tryReadJson(path).ok) return;

  const bak = backupPath(path);
  const tmp = tempPathFor(bak);
  try {
    copyFileSync(path, tmp);
    renameSync(tmp, bak);
  } catch (err) {
    // A backup is a convenience; failing to make one must not block the real write.
    console.error(`[atomic] could not retain backup for ${path}: ${err.message}`);
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Atomic write of exact bytes, retaining the last good copy as `<path>.bak`.
 *
 * For a file published as staged bytes rather than a value: state.json, whose digest a
 * prepared mastery settlement records, so it must not be re-serialized on the way out.
 */
export function writeFileAtomicWithBackupSync(path, data) {
  retainBackup(path);
  writeFileAtomicSync(path, data);
}

/** Atomic JSON write, 2-space + trailing newline, retaining the last good copy. */
export function writeJsonAtomicSync(path, value) {
  retainBackup(path);
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// --- Reading JSON: one core, with or without a schema. ---
// readJsonValidated came first, for the chapter renderer's manifest (renderer-foundations,
// 2026-11-11). readJsonSafe is now that same reader with a validator that accepts
// anything (readjson-damage, James, 2026-11-11): its own copy decided "missing" with
// existsSync, which also says no on EPERM, and dropped an unusable backup's error, so
// damage read as an empty sidecar. One core means the two can't drift apart again.

const validationMessage = (errors) => errors.map((e) => `${e.path || 'root'}: ${e.message}`).join('; ');

function requireValidator(validate, name) {
  if (typeof validate !== 'function') throw new TypeError(`${name} needs a validate(value) function`);
}

/** Parse and validate; an I/O failure keeps its code so it can't pass for "missing". */
function tryReadValidated(path, validate) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const errors = validate(value) ?? [];
  return errors.length ? { ok: false, error: validationMessage(errors) } : { ok: true, value };
}

/**
 * Read JSON that must also pass `validate`. Like readJsonSafe, except that a copy which
 * parses but fails validation is unusable, an I/O failure carries its `code`, and a missing
 * primary beside an unusable backup is a fallback with an error rather than "missing".
 */
export function readJsonValidated(path, fallback, validate) {
  requireValidator(validate, 'readJsonValidated');
  const primary = tryReadValidated(path, validate);
  if (primary.ok) return { value: primary.value, source: 'primary', error: null };

  const backup = tryReadValidated(backupPath(path), validate);
  const primaryMissing = primary.code === 'ENOENT';
  if (backup.ok) return { value: backup.value, source: 'backup', error: primaryMissing ? 'primary file is missing' : primary.error };
  if (primaryMissing && backup.code === 'ENOENT') return { value: fallback, source: 'missing', error: null };
  if (primaryMissing) {
    return { value: fallback, source: 'fallback', error: `primary missing; backup unusable: ${backup.error}`, ...(backup.code ? { code: backup.code } : {}) };
  }
  return { value: fallback, source: 'fallback', error: primary.error, ...(primary.code ? { code: primary.code } : {}) };
}

const ACCEPT_ANY = () => [];

/**
 * Read JSON, falling back to the retained backup when the primary is unreadable.
 *
 * Returns the source it actually used rather than just the value: "recovered from
 * backup" is a fact the health endpoint has to be able to report, and the old behavior
 * of silently returning an empty object is exactly what made corruption invisible.
 * "missing" means ENOENT for the primary AND its backup; anything else is damage.
 */
export function readJsonSafe(path, fallback) {
  return readJsonValidated(path, fallback, ACCEPT_ANY);
}

/** Keep the current primary as `.bak` only when it parses AND validates. */
function retainValidatedBackup(path, validate) {
  if (!existsSync(path)) return;
  if (!tryReadValidated(path, validate).ok) return;
  const bak = backupPath(path);
  const tmp = tempPathFor(bak);
  try {
    copyFileSync(path, tmp);
    renameSync(tmp, bak);
  } catch (err) {
    console.error(`[atomic] could not retain backup for ${path}: ${err.message}`);
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/**
 * Atomic JSON write of a value that must pass `validate`. An invalid value is refused before
 * any file is touched, and an invalid primary is never kept as the backup.
 */
export function writeJsonValidated(path, value, validate) {
  requireValidator(validate, 'writeJsonValidated');
  const errors = validate(value) ?? [];
  if (errors.length) throw new Error(`refusing invalid JSON write: ${validationMessage(errors)}`);
  retainValidatedBackup(path, validate);
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Whether the file ends in a newline — false only when a previous append was torn. */
function endsWithNewline(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return true; // no file yet; the first append starts clean
  }
  if (size === 0) return true;

  const fd = openSync(path, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one JSONL record.
 *
 * A torn append leaves a line with no terminator. Appending straight onto it would fuse
 * the fragment and the new record into one unparseable line — losing the NEW record as
 * well as the old one. Healing the newline first bounds the damage to the torn record.
 */
export function appendLineSync(path, line) {
  const fd = openSync(path, 'a');
  try {
    if (!endsWithNewline(path)) writeSync(fd, '\n');
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Temp files left behind by a crashed write — a health signal, not an error. */
export function staleTempFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(TEMP_SUFFIX));
  } catch {
    return [];
  }
}
