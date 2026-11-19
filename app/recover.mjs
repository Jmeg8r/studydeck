#!/usr/bin/env node
// WHAT: `npm run recover -- --topic <slug>` reports which of a topic's state.json and
//       sidecars are damaged and whether each backup can replace it. Adding
//       `--file <name> --restore-backup` restores that one file.
// WHY:  The cockpit reads a damaged sidecar from its backup but never repairs it, and a
//       damaged state.json takes its topic out of every view. Restoring is deliberate and
//       run by hand, never by the server: there is no route, so no browser tab can start
//       one (backup-restore spec). Exit codes follow verify.mjs.
import { parseArgs } from 'node:util';

const EXIT_OK = 0;
const EXIT_ATTENTION = 1; // damage found, or a restore refused with nothing changed
const EXIT_INCOMPLETE = 2; // the command could not look, or could not finish

const USAGE = 'Usage: npm run recover -- --topic <slug> [--file <name> --restore-backup [--force]]';
const IDLE = 'Leave the cockpit idle until this finishes. A study action during the restore could be overwritten.';

const restoreCommand = (topic, file) => `npm run recover -- --topic ${topic} --file ${file} --restore-backup`;
const plural = (n, one, many) => (n === 1 ? one : many);
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function primaryWords(row) {
  if (row.primary === 'intact') return 'intact.';
  if (row.primary === 'damaged') return "damaged (doesn't parse).";
  if (row.primary === 'invalid') return `invalid (${row.reason}).`;
  // The cockpit never reads state.json.bak, so its absence is never softened.
  if (row.file === 'state.json') return "missing. The topic can't load without it.";
  if (row.backup === 'missing') return 'not written yet.';
  return row.backup === 'valid' ? 'missing; the cockpit is reading its backup.' : 'missing.';
}

function reportLine(topic, row) {
  const line = `${row.file}: ${primaryWords(row)}`;
  if (!row.damaged) return line;
  if (row.restorable) return `${line} Its backup is valid. Restore it with: ${restoreCommand(topic, row.file)}`;
  const backup = row.backup === 'missing' ? 'It has no backup' : `Its backup is ${row.backup} too`;
  return `${line} ${backup}, so it can't be restored from here. Restore it from git instead.`;
}

function report(lib, topic) {
  let rows;
  try {
    rows = lib.inspectRestorable(topic);
  } catch (err) {
    console.error(`Couldn't check ${topic}: ${sentence(err.message)} Nothing was changed.`);
    return EXIT_INCOMPLETE;
  }
  for (const row of rows) console.log(reportLine(topic, row));
  const damaged = rows.filter((r) => r.damaged).length;
  if (damaged === 0) {
    console.log('Nothing is damaged.');
    return EXIT_OK;
  }
  console.log(`${damaged} ${plural(damaged, 'file needs', 'files need')} attention.`);
  return EXIT_ATTENTION;
}

/** The way forward after a refusal, chosen from its code, never from its wording. */
function nextStep(err) {
  if (err.code === 'intact_newer') return ' Add --force to restore anyway.';
  if (err.code === 'backup_unusable' && !err.primary_intact) return ' Restore it from git instead.';
  return '';
}

/** Only a sidecar restore that will actually write races the cockpit (spec concern 2). */
function willWriteSidecar(lib, topic, file, force) {
  if (file === 'state.json' || !lib.RESTORABLE.includes(file)) return false;
  try {
    const row = lib.inspectRestorable(topic).find((r) => r.file === file);
    return row.restorable && (row.primary !== 'intact' || force);
  } catch {
    return false; // the restore itself will report what could not be read
  }
}

async function restore(lib, topic, file, force) {
  if (willWriteSidecar(lib, topic, file, force)) console.log(IDLE);
  let result;
  try {
    result = await lib.restoreBackup(topic, file, { force });
  } catch (err) {
    if (!err.refused) {
      console.error(`Couldn't complete the restore: ${sentence(err.message)} Run npm run recover -- --topic ${topic} to see where things stand.`);
      return EXIT_INCOMPLETE;
    }
    console.error(`${sentence(err.message)} Nothing was changed.${nextStep(err)}`);
    return EXIT_ATTENTION;
  }
  if (result.already_matched) {
    console.log(`${file} already matches its backup, so it was left as it is. The knowledge map was regenerated.`);
  } else {
    const kept = result.archived_primary ? `The damaged copy is kept at ${result.archived_primary}.` : 'There was no primary to keep.';
    console.log(`Restored ${file} from its backup. ${kept}${result.map_regenerated ? ' The knowledge map was regenerated.' : ''}`);
  }
  if (result.drift_unplaced) {
    console.log("This backup doesn't match any recorded mastery update, so it can't tell which attempts it leaves out. "
      + 'Compare recent results with the restored confidence before studying on.');
  }
  const n = result.drift.length;
  if (n) {
    const them = plural(n, 'it', 'them');
    console.log(`${n} ${plural(n, 'attempt', 'attempts')} applied mastery after this backup was taken, `
      + `so the restored state.json doesn't include ${them}. Nothing was changed for ${them}:`);
    for (const d of result.drift) {
      console.log(`  ${d.concept_slug ?? 'no concept'} · ${d.kind ?? 'attempt'} from ${(d.ts ?? '').slice(0, 10) || 'an unknown date'} (${d.attempt_id})`);
    }
  }
  return EXIT_OK;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        topic: { type: 'string' },
        file: { type: 'string' },
        'restore-backup': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    console.error(`${sentence(err.message)} ${USAGE}`);
    return EXIT_INCOMPLETE;
  }
  // Loaded here, not at the top: config throws at import on a bad environment, and that is
  // "could not complete" (2), not the "damage found" (1) an uncaught error would exit with.
  let config;
  let lib;
  try {
    ({ config } = await import('./lib/config.mjs'));
    lib = await import('./lib/restore.mjs');
  } catch (err) {
    console.error(`Couldn't start: ${sentence(err.message)} Nothing was changed.`);
    return EXIT_INCOMPLETE;
  }
  const slugs = config.topics.map((t) => t.slug);
  if (!slugs.includes(values.topic)) {
    console.error(`--topic must name a configured topic: ${slugs.join(', ')}.`);
    return EXIT_INCOMPLETE;
  }
  if (values['restore-backup']) {
    if (!values.file) {
      console.error('--restore-backup needs --file <name>. Nothing was changed.');
      return EXIT_ATTENTION;
    }
    return restore(lib, values.topic, values.file, values.force);
  }
  if (values.file) {
    console.error(`Add --restore-backup to restore ${values.file} from its backup. Nothing was changed.`);
    return EXIT_ATTENTION;
  }
  return report(lib, values.topic);
}

process.exitCode = await main();
