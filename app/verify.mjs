#!/usr/bin/env node
// WHAT: Read-only integrity check over every configured topic. `npm run verify`.
// WHY: Assessment finding F12. The cockpit's banner tells you something is damaged while
//      you are studying; this tells you BEFORE you start, and without a server running.
//      Every corruption path in this app degrades quietly into less data, so the failure
//      you actually experience is "I have fewer cards than I remember" — a check you can
//      run in one second is the difference between noticing that and not.
//
//      Read-only, deliberately: it opens files, parses them, and writes nothing. A repair
//      tool that runs automatically is how one bad file becomes a bad backup too.
//
//      Exit codes, and the third one is the point: 0 clean, 1 damage found, 2 the check
//      itself could not complete. Without 2, an unreadable directory throws, node exits 1,
//      and "I could not look" is reported as "I looked and found damage" — a checker that
//      cannot distinguish those is worse than none, because you act on a wrong diagnosis.
//
//      `--live` (npm run verify:live) adds one check that talks to Open Notebook: whether
//      `/api/sources` still has the shape this app maps. It is OPT-IN because everything
//      else here is local, offline and instant, and a default that needs a running service
//      would turn "ON is down" into a failed integrity check. See lib/oncontract.mjs for
//      why that check cannot live in the test suite.
import { existsSync } from 'node:fs';
import { config } from './lib/config.mjs';
import { inspectSidecars } from './lib/sidecar.mjs';
import { listDecks, readTopicState } from './lib/learn.mjs';
import { fetchSourcesRaw } from './lib/opennotebook.mjs';
import { probeSources } from './lib/oncontract.mjs';

const LIVE = process.argv.includes('--live');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

let problems = 0;
let unchecked = 0;
const note = (colour, line) => console.log(`${colour}${line}${OFF}`);

/**
 * Run one check. A throw means the check did not complete — which is NOT the same as
 * finding damage, and is counted separately so the exit code can say so.
 */
function check(label, fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    unchecked++;
    note(YELLOW, `  ${label.padEnd(15)} COULD NOT CHECK — ${err.message}`);
    return { ok: false };
  }
}

console.log(`\nStudyDeck integrity check — ${config.topics.length} topic(s), learn root ${config.learnRoot}\n`);

for (const topic of config.topics) {
  console.log(`${topic.slug}`);

  // state.json first: everything else is derived from it, so a failure here makes the rest
  // meaningless rather than merely incomplete.
  try {
    const state = readTopicState(topic.slug);
    const concepts = (state.domains ?? []).reduce((n, d) => n + (d.concepts?.length ?? 0), 0);
    note(DIM, `  state.json      ok — ${state.domains?.length ?? 0} domains, ${concepts} concepts`);
  } catch (err) {
    // A parse error is damage; an I/O error other than "missing" is a failure to look.
    // ENOENT counts as damage: a configured topic whose state.json is absent is broken,
    // not unexaminable.
    if (err.code && err.code !== 'ENOENT') {
      unchecked++;
      note(YELLOW, `  state.json      COULD NOT CHECK — ${err.message}`);
    } else {
      problems++;
      note(RED, `  state.json      UNREADABLE — ${err.message}`);
      note(DIM, '                  everything below is derived from this file; treat it as unknown');
    }
  }

  const sidecars = check('sidecars', () => inspectSidecars(topic.slug));
  if (sidecars.ok) {
    for (const file of sidecars.value.degraded) {
      problems++;
      note(RED, `  ${file.padEnd(15)} recovered from backup — the last write before the crash is gone`);
    }
    if (sidecars.value.unparseable_lines > 0) {
      problems++;
      note(RED, `  ${'history'.padEnd(15)} ${sidecars.value.unparseable_lines} unreadable line(s) skipped — append-only history is incomplete`);
    }
    for (const temp of sidecars.value.stale_temp_files) {
      problems++;
      note(YELLOW, `  ${'temp file'.padEnd(15)} ${temp} left by a write that died — the data it held never landed`);
    }
  }

  const decks = check('decks', () => listDecks(topic.slug));
  if (decks.ok) {
    for (const deck of decks.value.filter((d) => d.unreadable)) {
      // Damaged content and an unreadable disk are different findings with different exit
      // codes. `listDecks` cannot throw for the I/O case (it feeds buildState, and throwing
      // would blank the cockpit), so the distinction arrives as data and is honoured here.
      if (deck.unreadable_kind === 'io') {
        unchecked++;
        note(YELLOW, `  ${'deck'.padEnd(15)} ${deck.file} COULD NOT BE READ — ${deck.unreadable}`);
      } else {
        problems++;
        note(RED, `  ${'deck'.padEnd(15)} ${deck.file} cannot be parsed — ${deck.unreadable}`);
      }
    }
    const usable = decks.value.filter((d) => !d.unreadable).length;
    note(DIM, `  decks           ${usable} readable of ${decks.value.length}`);
  }

  // A missing cockpit/ is normal for a topic you have not studied yet — reported as fact,
  // not as damage. Calling an empty tree corrupt would train you to ignore this output.
  if (!existsSync(`${config.learnRoot}/${topic.slug}/cockpit`)) {
    note(DIM, '  cockpit/        absent — nothing recorded for this topic yet');
  }

  // The only check here that leaves this machine, and only with --live. Drift counts as a
  // problem; unreachable counts as unchecked. That is not a detail — an outage reported as
  // damage sends you looking for a corrupt file that does not exist.
  if (LIVE) {
    if (!topic.notebookId) {
      note(DIM, '  ON sources      no notebook mapped — nothing to probe');
    } else {
      const probe = await probeSources(topic.notebookId, fetchSourcesRaw);
      if (probe.status === 'drifted' || probe.status === 'degraded') {
        // `degraded` counts as a problem, not as clean. It is the SILENT half of drift —
        // `listSources` falls back to '(untitled)', so nothing throws, chapter ordering
        // collapses and episode names stop being unique while every screen still renders.
        // Reporting that as ok, under a line claiming id and title are present, would make
        // this checker assert something false about the exact damage it exists to surface.
        problems++;
        const headline = probe.status === 'drifted'
          ? 'SHAPE DRIFTED — the suite cannot see this'
          : 'SHAPE DEGRADED — nothing throws, which is why this needs saying';
        note(RED, `  ${'ON sources'.padEnd(15)} ${headline}`);
        for (const f of probe.findings) note(RED, `                  ${f}`);
      } else if (probe.status === 'indeterminate') {
        unchecked++;
        note(YELLOW, `  ${'ON sources'.padEnd(15)} COULD NOT CHECK — ${probe.findings[0]}`);
      } else {
        note(DIM, '  ON sources      ok — id and title present on every source');
      }
    }
  }
  console.log('');
}

// Order matters: an incomplete run is reported even when damage was also found, because
// "some checks did not run" changes what the rest of the output is worth.
if (unchecked > 0) {
  note(YELLOW, `${unchecked} check(s) could not complete${problems > 0 ? `, and ${problems} problem(s) were found in the ones that did` : ''}.`);
  note(YELLOW, 'This run is INCOMPLETE — a clean result here would not mean clean. Nothing has been modified.\n');
  process.exit(2);
}
if (problems === 0) {
  note(GREEN, 'No damage found. Counts in the cockpit reflect everything on disk.\n');
  process.exit(0);
}
note(RED, `${problems} problem(s) found. Cockpit counts are derived from what could still be read,`);
note(RED, 'so they may understate your work. Nothing here has been modified.\n');
process.exit(1);
