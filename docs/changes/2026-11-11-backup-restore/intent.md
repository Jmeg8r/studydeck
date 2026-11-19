---
change: 2026-11-11-backup-restore
status: accepted
track: T3
risk: high
risk_reason: A restore overwrites the primary copy of a topic's learning data, state.json or a sidecar, with an older one. A wrong restore loses everything written since the backup, and the confidence history has no undo. It also changes the state.json write path that every mastery update goes through. The restore runs only from the command line, so no HTTP route or browser tab can start one.
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: restore a damaged state.json or sidecar from its backup, on purpose

Track: T3. It repairs learning data by overwriting it, which is closer to a data
migration than to a feature, and its risk is high.

## Problem

This is slice R2 of porting PR #98's September snapshot (`264547c`). R1, the Recovery
view, merged as PR #149.

James's framing for R2: an explicit `.bak` restore of `state.json` or a sidecar. On
`main`, `readJsonSafe` serves the `.bak` on read but never repairs the primary.

What that means today, found on `main` at `951a201`:

- **A damaged sidecar** (`cards.json`, `schedule.json`, `reading.json`,
  `factchecks.json`, `mindmaps.json`) is read from its `.bak`. The cockpit keeps working
  on that copy, and `/api/health` and `npm run verify` report the file as recovered from
  backup. Nothing repairs the primary on disk until that sidecar's next write happens
  to overwrite it, which may be days away. The warning stays up until then, and there
  is no way to finish it on purpose.
- **A damaged `state.json` has no backup at all.** The cockpit publishes it with
  `writeFileAtomicSync`, which keeps no `.bak`, and the real tree has no
  `state.json.bak` in any topic. `readTopicState` is a plain `JSON.parse`, so the topic
  drops out of every view ("could not be read"). The only way back is restoring the
  committed copy from git by hand, which loses every mastery change since the last
  commit.
- The September `restoreBackup('state.json')` assumed a `state.json.bak` existed. Ported
  as written, it would always fail with "file not found".

## Proposed outcome

- **The cockpit keeps a backup of `state.json`.** Every cockpit write of `state.json`
  first keeps the current copy as `state.json.bak`, the way sidecar writes already do,
  and only when that copy still parses. This is James's decision of 2026-11-11.
- **A command reports what can be restored.** `npm run recover -- --topic <slug>` prints,
  for that topic, which files are damaged or were read from backup, whether each `.bak`
  is present and valid, and the exact command that would restore it. It writes nothing.
- **The same command restores, on purpose.** Adding `--file <name> --restore-backup`
  restores that one file from its `.bak`, after checking that the backup is valid. It:
  - archives the current primary as `<file>.damaged-<id>` first, and never deletes it;
  - runs under the topic lock (rule 10);
  - for `state.json`, re-renders the knowledge map (rule 3), staged first so that a
    backup that won't render changes nothing.
- **It runs from the command line only.** This is James's decision of 2026-11-11. There
  is no button, no HTTP route, and nothing another browser tab could trigger.

## Affected users and systems

- James, the only user. He runs it after `npm run verify` or the health banner reports
  damage.
- `app/lib/mastery.mjs`: the `state.json` publish path that every mastery update uses.
  `app/lib/notebooks.mjs` already writes through `writeJsonAtomicSync`.
- `app/lib/atomic.mjs`: backup retention is reused, not reinvented.
- New: a restore module, a `recover` CLI entry and npm script, and schema checks for
  sidecars (the snapshot's `validateSidecar` and `assertData`).
  `validateStateV1` already exists in learn-anything's utils.
- `.gitignore`: `.learn/**/*.bak` is already ignored, but `<file>.damaged-<id>` archives
  are not, so they would show up as untracked files under `.learn/`.

## Constraints

- **Rule 1.** `state.json` keeps learn-anything's schema exactly. `state.json.bak` is a
  byte copy, not a new field. It sits beside `state.json`, and `.learn/**/*.bak` is
  already ignored by git.
- **Rule 3.** A restored `state.json` is rendered before it counts as done. A backup
  that does not render leaves the live files untouched.
- **Rule 8.** Writes go through `atomic.mjs`. A backup is the last copy that parsed, one
  write behind. That is the promise, not zero data loss.
- **Rule 10.** The restore takes `withTopicLock`. A `/learn:quiz` CLI session does not
  take the lock, so rule 4's single-writer convention still applies.
- **Explicit only.** Nothing restores on read, at boot, or from verify. `verify.mjs`
  says why: "A repair tool that runs automatically is how one bad file becomes a bad
  backup too."
- **Never destroy a copy.** The damaged primary is archived before anything is
  overwritten, and the `.bak` is never consumed or rotated by a restore.
- **Validate before writing.** A `.bak` that fails to parse or fails its schema check is
  refused, and nothing is written.
- **Append-only history is out of reach.** `*.jsonl` files can't be restored this way.
  They need record-level review, as in the September design.
- **Rule 5.** No dependencies.

## Out of scope

- A Restore button or HTTP route in the Recovery view, or anywhere in the browser.
- Restoring `*.jsonl` history: attempts, reviews, operations, stages, sessions.
- Restoring from git, or any source other than the file's own `.bak`.
- Keeping a `state.json.bak` for writes made outside the cockpit: `/learn:quiz` CLI
  sessions and `learn-anything-cli update`. Those tools are learn-anything's, not this
  repo's.
- Automatic repair of any kind.
- Merging the data written after the backup back in. A restore is one write behind.

## Success signals

- **A backup appears.** After one mastery update on a `/tmp/learn` copy,
  `ls <topic>/state.json.bak` exists, and it equals the `state.json` from before that
  update, byte for byte.
- **The report writes nothing.** `npm run recover -- --topic <slug>` on a copy with
  `state.json` reduced to `{` names `state.json` as damaged and its `.bak` as valid, and
  prints the restore command. A file listing and checksums taken before and after are
  identical.
- **A restore brings the topic back.**
  `npm run recover -- --topic <slug> --file state.json --restore-backup` on that copy:
  - exits 0;
  - leaves `state.json` byte-identical to the `.bak`;
  - leaves a `state.json.damaged-<id>` holding `{`;
  - regenerates `knowledge-map.md` from the restored state;
  - leaves every `cockpit/*.jsonl` byte-identical;
  - brings the topic back in `/api/state`.
- **The same works for a sidecar.** On `cards.json`, health stops reporting the file
  as recovered from backup.
- **A bad backup changes nothing.** If the `.bak` fails to parse, fails validation or
  won't render, the command exits non-zero, names the reason, and leaves every live
  file byte-identical.
- **Tests.** `npm test` passes with `node_modules` absent. Each behaviour has a red
  commit before its fix.

## Open questions

1. **Restoring over an intact primary.** Should a restore be refused when the primary
   still parses and validates? The September code restored anyway, after archiving. A
   good primary is newer than its backup, so restoring over it loses data on purpose.
   `--force` is one option.
2. **Exit codes.** Should `recover` follow `verify`'s 0, 1, 2: clean, damage found, and
   could not check?
3. **Archive naming.** Should the damaged copy be called `<file>.damaged-<id>`, as in
   September, or `<file>.damaged-<timestamp>`, so that several archives sort by time?
   Either way it needs a `.gitignore` entry with a comment (repo convention).
4. **Recording the restore.** Should a restore leave a line somewhere, in a cockpit
   ledger or only in the command output? A ledger line would make a restore auditable
   and would be a new append-only file.
