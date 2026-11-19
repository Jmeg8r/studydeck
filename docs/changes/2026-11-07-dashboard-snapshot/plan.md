---
change: 2026-11-07-dashboard-snapshot
track: T1
status: accepted
---

# Plan: dashboard snapshot export

1. Test first: `app/test/dashsnapshot.test.mjs` against a tmp fixture learn root.
   → verify: it fails because `app/lib/dashsnapshot.mjs` does not exist.
2. `app/lib/dashsnapshot.mjs`: `buildDashboardSnapshot(slugs, referenceISO)` returns the six
   row arrays, using `readTopicState`, `readSchedule`, `readStageEvents`, `stageStatesFor`,
   `readAttempts`, `readCards`, `readReviews`, `readPracticeEvents`, `readTeachbackEvents`,
   `readOperations` and `readReading`.
   → verify: the tests pass.
3. `app/dashboard-snapshot.mjs` CLI (`--out`, `--date`), each file written with
   `writeJsonAtomicSync` (hard rule 8); `npm run dashboard:snapshot`; `.gitignore` entry
   for `.dashboard-snapshot/` with its reason.
   → verify: a CLI test writes all six files to a tmp folder.
4. Run it against the real tree; compare with the first Python snapshot and explain every
   difference.
   → verify: `npm test` green with `node_modules` absent (hard rule 5).

## Risks

- Field names are the dashboard's contract. Renaming one breaks a chart silently, so the
  test asserts the column set of every file.
