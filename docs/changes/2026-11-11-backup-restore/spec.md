---
change: 2026-11-11-backup-restore
status: accepted
track: T3
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: [design:ux-copy]
claude_config_sha: d0fbd0f
---
# Spec: restore a damaged state.json or sidecar from its backup, on purpose

## Flagged concerns

1. **Restoring `state.json` can quietly undo mastery the attempt log says was applied.**
   - Source: intent, *Constraints* (rule 8, one write behind) and CLAUDE.md rule 7.
   - The `.bak` is the copy from before the latest write. If that write was a mastery
     update, its attempt carries `mastery_applied: true`, but the restored `state.json`
     no longer contains the bump. Health would show nothing owed, and the confidence
     would simply be lower than the record says.
   - **Recommended:** before writing, the restore lists every attempt for the topic
     whose mastery was applied after the backup was taken. "After" means a `ts` later
     than the `.bak`'s modification time. The output names those attempts as "applied
     to the copy being replaced, not to the backup", and nothing is changed for them.
     Re-applying them automatically would be inferring from partial evidence (rule 11's
     reasoning). Deciding to re-take or re-apply stays James's.
   - **Resolution:** James, 2026-11-11: take the recommendation.
2. **Sidecar writes don't take the topic lock.** Only `app/lib/mastery.mjs` uses
   `withTopicLock`, so it covers `state.json`.
   - Source: intent, *Constraints* (rule 10).
   - A cockpit sidecar write can land between the restore's archive step and its own
     write. The restore would then overwrite that one change. The damage is bounded:
     the cockpit reads a damaged sidecar from its `.bak`, so its own write is the
     backup plus one change, and losing it is the same "one write behind" as the
     restore itself.
   - **Recommended:** take the lock anyway, which covers `state.json` fully. Print one
     line telling James to leave the cockpit idle (or stopped) during a sidecar
     restore. Don't extend the lock to every sidecar write in this slice: that touches
     every write route, for a race measured in milliseconds on a single-user app.
   - **Resolution:** James, 2026-11-11: take the recommendation.
3. **Restoring over a primary that is still good.** Intent open question 1.
   - Source: intent, *Open questions*.
   - A primary that parses and validates is newer than its backup. Restoring over it
     loses data on purpose. The September code allowed it.
   - **Recommended:** refuse unless `--force` is given. The refusal says the primary is
     intact, and that the restore would replace it with an older copy.
   - **Resolution:** James, 2026-11-11: take the recommendation.
4. **Exit codes.** Intent open question 2.
   - Source: intent; `app/verify.mjs`'s 0, 1, 2 convention.
   - **Recommended:**
     - Report mode: 0 nothing damaged; 1 damage found; 2 the check could not complete.
     - Restore mode: 0 restored; 1 refused (bad backup, intact primary without
       `--force`, unknown file); 2 could not complete after starting, with the live
       files left as they were.
   - **Resolution:** James, 2026-11-11: take the recommendation.
5. **Archive name and git.** Intent open question 3.
   - Source: intent; CLAUDE.md's `.gitignore` convention, which names each path with a
     comment.
   - **Recommended:** `<file>.damaged-<UTC timestamp>-<4 hex>`, for example
     `state.json.damaged-20261111T153000Z-a3f9`. It sorts by time, and the suffix keeps
     two restores in one second apart. Add `.learn/**/*.damaged-*` to `.gitignore`
     with a comment saying the archives are local evidence, like the `.bak` they came
     from.
   - **Resolution:** James, 2026-11-11: take the recommendation.
6. **Recording a restore.** Intent open question 4.
   - Source: intent.
   - **Recommended:** no new ledger. The command output and the archive file are the
     record, and a restore is rare and run by hand. A new append-only file would need
     its own `mutation_id` story (rule 9) for an event that can't usefully replay.
   - **Resolution:** James, 2026-11-11: take the recommendation.
7. **Policy not applied: `gstack-cso` at spec time.**
   - Source: `/spec` step 2. This change touches stored data, which is `gstack-cso`'s
     remit.
   - Its audit works on code, and no code exists yet. R1 used `security-review` on the
     diff.
   - **Recommended:** run `security-review` on the finished diff, plus the T3
     adversarial review (`/doubt-driven-development` or a pstack panel) in plan step
     order, before the PR. No `gstack-cso` pass at spec time.
   - **Resolution:** James, 2026-11-11: take the recommendation.

## Requirements

- **R1. `state.json` keeps a backup.** Every cockpit write that replaces an existing
  `state.json` first copies it to `state.json.bak`, if it still parses. That is the same
  rule `atomic.mjs`'s `retainBackup` applies to sidecars. A copy that does not parse is
  never kept, so a good backup is never overwritten by a damaged primary. (Intent:
  *Proposed outcome*, first bullet.)
- **R2. Report.** `npm run recover -- --topic <slug>` lists, for `state.json` and each of
  `cards.json`, `schedule.json`, `reading.json`, `factchecks.json` and `mindmaps.json`:
  - whether the primary is intact, damaged, missing, or read from its backup;
  - whether a `.bak` exists, and whether it parses and validates;
  - for each restorable file, the exact command that restores it.

  It writes nothing. (Intent: second bullet.)
- **R3. Restore.** Adding `--file <name> --restore-backup` restores that one file from
  its `.bak`. The order is:
  1. validate the backup;
  2. archive the primary;
  3. write the backup's exact bytes;
  4. for `state.json`, write the map rendered in staging.

  The whole sequence runs under `withTopicLock`. (Intent: third bullet.)
- **R4. Nothing changes on refusal.** A backup that is missing, unparseable, invalid, or
  (for `state.json`) unrenderable is refused, and every live file is left
  byte-identical. So is an unknown `--file`, an unknown `--topic`, or a `.jsonl` name.
- **R5. Nothing is destroyed.** The primary, damaged or not, is archived before it is
  replaced (concern 5 sets the name). The `.bak` is left in place.
- **R6. Rule 3.** A restored `state.json` is followed by a regenerated
  `knowledge-map.md`. The map is rendered in a staging directory first, so a failed
  render changes nothing.
- **R7. Mastery drift is reported.** It is not acted on (concern 1).
- **R8. An intact primary is protected** (concern 3).
- **R9. Exit codes** (concern 4).
- **R10. Rule 5.** No dependencies. Validators are ported from the snapshot's
  `schema.mjs` (`validateSidecar`, `assertData`) and checked against the real files.
  All real primaries and both existing backups pass today (checked read-only on
  2026-11-11).

## Design

### Backup retention (R1)

- `app/lib/atomic.mjs` exports `writeFileAtomicWithBackupSync(path, data)`. It runs the
  existing private `retainBackup(path)` and then `writeFileAtomicSync`. `state.json`
  is published as exact staged bytes, not as a value, so `writeJsonAtomicSync` can't
  be used. It would re-serialize the state and break the digest that mastery records
  in each prepared settlement.
- `publishStagedUpdate` in `app/lib/mastery.mjs` uses it for `state.json`. Nothing else
  changes: `knowledge-map.md` is derived and gets no backup.
- `app/lib/notebooks.mjs` writes `state.json` only when none exists, so there is nothing
  to keep.
- **Recovery after a crash.** A prepared settlement records the staged `state_digest`.
  Keeping a backup does not change what is published, so the digest still matches.

### Report and restore (`app/lib/restore.mjs`, `app/recover.mjs`)

- `inspectRestorable(slug)` gives one row per file:
  `{ file, primary: 'intact'|'damaged'|'missing'|'invalid', backup: 'valid'|'invalid'|'unparseable'|'missing', restorable, reason }`.
  - "Damaged" means it does not parse. "Invalid" means it parses but fails its
    validator.
  - It reuses `readJsonSafe`'s parse and the ported validators: `validateStateV1` for
    `state.json`, `validateSidecar(name, value)` for the rest.
- `restoreBackup(slug, file, { force })` mirrors the September code, with these changes:
  - The allowlist is `state.json` plus main's five sidecars. `recordings.json` is gone.
  - It refuses an intact, valid primary without `force`.
  - Before writing, it computes the mastery-drift list (concern 1) from `readAttempts`.
  - It returns `{ restored, archived_primary, backup, map_regenerated, drift: [...] }`.
- `app/recover.mjs` is the CLI. It uses `parseArgs`, validates `--topic` against
  `config.topics`, and maps outcomes to concern 4's exit codes. `package.json` gains
  `"recover": "node app/recover.mjs"`.
- `STUDYDECK_LEARN_ROOT` works as it does for the server, so every live check runs
  against a `/tmp/learn` copy.

### Output copy (`design:ux-copy`)

- Each line is built as what happened, then why it matters, then what to run next. Terms
  stay the same throughout: **primary**, **backup**, **archive**.
- **Report, damaged:**
  `state.json: damaged (doesn't parse). Its backup is valid. Restore it with: npm run recover -- --topic <slug> --file state.json --restore-backup`
- **Restored:**
  `Restored state.json from its backup. The damaged copy is kept at <path>. The knowledge map was regenerated.`
- **Drift:**
  `1 attempt applied mastery after this backup was taken, so the restored state.json doesn't include it: <concept> · <kind> from <date>. Nothing was changed for it.`
- **Refused, intact primary:**
  `state.json is intact and newer than its backup. Restoring would replace it with an older copy. Nothing was changed. Add --force to restore anyway.`
- **Refused, bad backup:**
  `state.json.bak doesn't validate (<first reason>). Nothing was changed. Restore this topic from git instead.`
- **Sidecar restore:** one line before the write, saying to leave the cockpit idle
  (concern 2).

## Security and data

- **No new surface.** There is no HTTP route and no UI. Rule 12's browser guard is not
  involved, and no other tab can trigger a restore.
- **Paths come from an allowlist.** `--topic` must be a configured slug, and `--file`
  must be one of six fixed names. Neither is ever joined into a path otherwise, so a
  `../` input cannot reach a file outside the topic.
- **Secrets.** None are read or printed. Open Notebook is not contacted.
- **Data loss is bounded and visible.** Every replaced primary is archived. Drift is
  printed. Refusals change nothing.
- **Git.** `.bak` files are already ignored. `.damaged-*` archives become ignored too
  (concern 5), so damaged bytes are never committed by accident.

## Acceptance checks

Each check runs on a `/tmp/learn` copy with `STUDYDECK_LEARN_ROOT` set, except the
last.

- **R1.** One mastery settle, then `cmp <topic>/state.json.bak <copy of state.json taken before>`
  prints nothing. A unit test makes the primary unparseable and shows the `.bak` is not
  overwritten.
- **R2.** Reduce `state.json` to `{`, then run `npm run recover -- --topic <slug>`.
  - It exits 1, names `state.json` as damaged with a valid backup, and prints the
    restore command.
  - `find <copy> -type f | sort | xargs shasum` is identical before and after.
- **R3, R5, R6.** On the same copy, add `--file state.json --restore-backup`.
  - It exits 0.
  - `cmp state.json state.json.bak` is silent.
  - A `state.json.damaged-*` archive holds `{`.
  - `knowledge-map.md` is regenerated.
  - Every `cockpit/*.jsonl` file is unchanged.
  - The topic is back in `/api/state`.
- **R3, sidecar.** Damage `cards.json`, restore it, and `/api/health` no longer lists
  the file as recovered from backup.
- **R4.** Run the restore with each of a `{}` backup, an unparseable backup, a missing
  backup, `--file attempts.jsonl` and `--file ../x`.
  - Each exits 1 and names its reason.
  - Checksums of the whole copy are unchanged.
- **R7.** Plant one applied attempt with a `ts` later than the backup's mtime. The
  restore output names it, and `attempts.jsonl` is unchanged.
- **R8.** On an intact `state.json`, the restore exits 1 and changes nothing. With
  `--force`, it exits 0 and archives the primary.
- **Tests.** `npm test` passes with `node_modules` absent, and each behaviour has a red
  commit first.
- **Real tree, read-only.** `npm run recover -- --topic <slug>` for each topic exits 0
  and reports nothing damaged.

## Open questions

- None carried from intent.md. Its four are concerns 3 to 6 above, each with a
  recommendation, waiting on James.
