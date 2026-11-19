// WHAT: `npm run dashboard:snapshot` — write the progress dashboard's six JSON files.
// WHY: The dashboard is a claude.ai artifact that can't reach .learn/; this is the one
//      command that refreshes its data. Read-only on the learn tree (STUDYDECK_LEARN_ROOT
//      is honoured); output goes to a git-ignored folder, each file written atomically
//      (rule 8). Replace the dashboard's attached files from its Sources panel afterwards.
//
//   node app/dashboard-snapshot.mjs [--out <dir>] [--date YYYY-MM-DD] [--topics a,b]
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeJsonAtomicSync } from './lib/atomic.mjs';
import { REPO_ROOT, config } from './lib/config.mjs';
import { SNAPSHOT_FILES, buildDashboardSnapshot } from './lib/dashsnapshot.mjs';
import { todayISO } from './lib/schedule.mjs';
import { isDateString } from './lib/stages.mjs';

const DEFAULT_OUT = join(REPO_ROOT, '.dashboard-snapshot');

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: DEFAULT_OUT },
    date: { type: 'string', default: todayISO() },
    topics: { type: 'string' },
  },
});

if (!isDateString(values.date)) {
  console.error(`--date must be a real YYYY-MM-DD date, got "${values.date}"`);
  process.exit(2);
}

const configured = config.topics.map((t) => t.slug);
const slugs = values.topics ? values.topics.split(',').map((s) => s.trim()).filter(Boolean) : configured;
if (slugs.length === 0) {
  console.error('No topics to snapshot: cockpit.config.json lists none and --topics was empty.');
  process.exit(2);
}
const rings = Object.fromEntries(config.topics.map((t) => [t.slug, t.ring ?? null]));

const snapshot = buildDashboardSnapshot(slugs, values.date, rings);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
for (const [key, file] of Object.entries(SNAPSHOT_FILES)) {
  writeJsonAtomicSync(join(out, file), snapshot[key]);
  console.log(`${file}  ${snapshot[key].length} rows`);
}
console.log(`Snapshot as of ${values.date} written to ${out}`);
