// WHAT: Explicit restore of a damaged state.json or sidecar from its `.bak`, and the report
//       that says what could be restored.
// WHY:  The cockpit reads a damaged sidecar from its backup but never repairs the primary,
//       and a damaged state.json takes its topic out of every view. A restore is never a
//       side effect of reading, booting or verifying: "a repair tool that runs
//       automatically is how one bad file becomes a bad backup too" (verify.mjs). It runs
//       from `npm run recover` only (backup-restore spec).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_SUFFIX, writeFileAtomicSync } from './atomic.mjs';
import { cockpitDir, topicDir } from './learn.mjs';
import { withTopicLock } from './lock.mjs';
import { digest, renderTopic } from './mastery.mjs';
import { assertData, validateSidecar, validateStateV1 } from './schema.mjs';
import { JSON_SIDECARS, readAttempts, readAttemptsRaw } from './sidecar.mjs';

/** The only files a restore may touch. Append-only *.jsonl history needs record-level review. */
export const RESTORABLE = ['state.json', ...JSON_SIDECARS];

export function restorablePath(slug, file) {
  return join(file === 'state.json' ? topicDir(slug) : cockpitDir(slug), file);
}

const validatorFor = (file) => (file === 'state.json' ? validateStateV1 : (value) => validateSidecar(file, value));

/** missing | unparseable | invalid | valid, with the first reason when it is not valid. */
function classify(path, file) {
  if (!existsSync(path)) return { status: 'missing', reason: null };
  // Read outside the try: an I/O failure (EISDIR, EACCES) means "could not look", and must
  // reach the caller as an error, never be reported as damage.
  const text = readFileSync(path, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { status: 'unparseable', reason: err.message };
  }
  const errors = validatorFor(file)(value);
  if (errors.length) return { status: 'invalid', reason: `${errors[0].path || 'root'} ${errors[0].message}` };
  return { status: 'valid', reason: null };
}

const PRIMARY = { valid: 'intact', unparseable: 'damaged', invalid: 'invalid', missing: 'missing' };

/** One row per restorable file. Reads only. */
export function inspectRestorable(slug) {
  return RESTORABLE.map((file) => {
    const path = restorablePath(slug, file);
    const primary = classify(path, file);
    const backup = classify(`${path}${BACKUP_SUFFIX}`, file);
    const primaryState = PRIMARY[primary.status];
    return {
      file,
      primary: primaryState,
      backup: backup.status,
      // A configured topic can't load without state.json, so its absence is always damage.
      // A sidecar missing beside a backup is what readJsonSafe is serving from; a sidecar
      // never written at all is not damage.
      damaged: primaryState === 'damaged' || primaryState === 'invalid'
        || (primaryState === 'missing' && (file === 'state.json' || backup.status !== 'missing')),
      restorable: backup.status === 'valid',
      reason: primary.reason ?? backup.reason,
    };
  });
}

/**
 * A restore that declined to write anything; the CLI reports it as exit 1, not 2. `code`
 * says which refusal, and `primary_intact` whether the file being replaced was fine, so the
 * caller picks the next step from data rather than from the wording:
 * not_restorable, intact, intact_newer, backup_unusable, already_matches.
 */
const refusal = (code, primaryIntact, message) =>
  Object.assign(new Error(message), { refused: true, code, primary_intact: primaryIntact });

/** `<path>.damaged-20261111T153000Z-a3f9`: sorts by time; the suffix keeps two in one second apart. */
function archivePath(path) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${path}.damaged-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** The backup's exact bytes, or a backup_unusable refusal saying why. */
function readValidBackup(path, file, primaryIntact) {
  const name = `${file}${BACKUP_SUFFIX}`;
  const unusable = (message) => refusal('backup_unusable', primaryIntact, message);
  if (!existsSync(`${path}${BACKUP_SUFFIX}`)) throw unusable(`${name} doesn't exist, so there is nothing to restore from.`);
  const bytes = readFileSync(`${path}${BACKUP_SUFFIX}`);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw unusable(`${name} doesn't parse (${err.message}).`);
  }
  try {
    assertData(value, validatorFor(file), name);
  } catch (err) {
    throw unusable(err.message);
  }
  return bytes;
}

/** knowledge-map.md rendered from `bytes` in a staging directory, or a refusal. */
async function renderInStaging(slug, bytes, renderOptions, primaryIntact) {
  const staging = mkdtempSync(join(tmpdir(), `studydeck-restore-${slug}-`));
  try {
    writeFileSync(join(staging, 'state.json'), bytes);
    const render = await renderTopic(slug, { ...renderOptions, dir: staging });
    if (!render.ok) throw refusal('backup_unusable', primaryIntact, `state.json${BACKUP_SUFFIX} doesn't render: ${render.output}`);
    return readFileSync(join(staging, 'knowledge-map.md'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Attempts whose mastery the restored state.json no longer contains. Reported, never acted
 * on: re-applying from this evidence alone would be inferring, and whether to re-take is
 * the learner's call.
 *
 * Every settlement records `replaced_digest`, the bytes it published over, so the backup is
 * placed exactly: the attempt that replaced it, and every attempt applied after it in the
 * log. That needs append order, so it reads the raw log, the diagnostic use rule 9 allows.
 * A backup no settlement replaced (none since this field existed, or a write from outside
 * the cockpit since) can't be placed, and says so rather than returning an empty list that
 * would read as "nothing was lost". There is no timestamp fallback: copyFileSync stamps a
 * .bak at the publish, after the attempt's own ts, so a ts rule misses exactly this case.
 */
function masteryDrift(slug, backupBytes) {
  const raw = readAttemptsRaw(slug);
  const anchor = raw.findIndex((row) => row.mastery_settlement?.replaced_digest === digest(backupBytes));
  if (anchor < 0) return { drift: [], unplaced: readAttempts(slug).some((a) => a.mastery_applied === true) };
  const after = new Set(raw.slice(anchor).map((row) => row.attempt_id));
  const drift = readAttempts(slug)
    .filter((a) => a.mastery_applied === true && after.has(a.attempt_id))
    .map(({ attempt_id, concept_slug, kind, ts }) => ({ attempt_id, concept_slug, kind, ts }));
  return { drift, unplaced: false };
}

/** Write the staged map, saying plainly that state.json already changed if it fails. */
function publishMap(slug, map) {
  try {
    writeFileAtomicSync(join(topicDir(slug), 'knowledge-map.md'), map);
  } catch (err) {
    throw new Error(`state.json was restored, but knowledge-map.md was not written (${err.message}). `
      + 'Run the same restore again to regenerate the map.');
  }
}

/**
 * Restore one file from its `.bak`, under the topic lock. Validates (and for state.json
 * renders) before writing, archives the primary, then writes the backup's exact bytes and
 * the staged map. The `.bak` is left in place. A state.json that already matches its backup
 * is the rerun after a failed map write: only the map is regenerated. `renderOptions` is a
 * test seam only.
 */
export async function restoreBackup(slug, file, { force = false, renderOptions = {} } = {}) {
  if (!RESTORABLE.includes(file)) {
    throw refusal('not_restorable', false,
      `${file} can't be restored. Only ${RESTORABLE.join(', ')} can; *.jsonl history needs record-level review.`);
  }
  return withTopicLock(slug, async () => {
    const path = restorablePath(slug, file);
    const primaryIntact = classify(path, file).status === 'valid';
    // An intact file with no backup has nothing to restore, and must never be sent to git.
    if (primaryIntact && !force && !existsSync(`${path}${BACKUP_SUFFIX}`)) {
      throw refusal('intact', true, `${file} is intact. There is nothing to restore.`);
    }
    const bytes = readValidBackup(path, file, primaryIntact);

    if (existsSync(path) && readFileSync(path).equals(bytes)) {
      if (file !== 'state.json') throw refusal('already_matches', primaryIntact, `${file} already matches its backup. There is nothing to restore.`);
      publishMap(slug, await renderInStaging(slug, bytes, renderOptions, primaryIntact));
      // Recomputed, not skipped: when the first run's map write failed, it threw before
      // anyone saw which attempts the restore leaves out.
      const { drift, unplaced } = masteryDrift(slug, bytes);
      return { archived_primary: null, map_regenerated: true, already_matched: true, drift, drift_unplaced: unplaced };
    }
    if (primaryIntact && !force) {
      throw refusal('intact_newer', true, `${file} is intact and newer than its backup. Restoring would replace it with an older copy.`);
    }

    const map = file === 'state.json' ? await renderInStaging(slug, bytes, renderOptions, primaryIntact) : null;
    const { drift, unplaced } = file === 'state.json' ? masteryDrift(slug, bytes) : { drift: [], unplaced: false };

    const archived = existsSync(path) ? archivePath(path) : null;
    if (archived) writeFileAtomicSync(archived, readFileSync(path));
    // Plain write, never the backup-keeping one: a forced restore must not copy the intact
    // primary over the very backup it is restoring.
    writeFileAtomicSync(path, bytes);
    if (map) publishMap(slug, map);
    return { archived_primary: archived, map_regenerated: Boolean(map), already_matched: false, drift, drift_unplaced: unplaced };
  });
}
