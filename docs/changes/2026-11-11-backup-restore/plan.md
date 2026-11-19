---
change: 2026-11-11-backup-restore
status: accepted
track: T3
intent: ./intent.md
spec: ./spec.md
linear: pending
---
# Plan: restore a damaged state.json or sidecar from its backup, on purpose

## Files that change

- **`app/lib/atomic.mjs`:** export `writeFileAtomicWithBackupSync(path, data)`, which
  runs the existing `retainBackup` and then `writeFileAtomicSync` (spec R1).
- **`app/lib/mastery.mjs`:** `publishStagedUpdate` writes `state.json` through it.
  Nothing else in mastery changes.
- **`app/lib/schema.mjs`** (new): `assertData` and `validateSidecar`, ported from
  `264547c`. `validateStateV1` is re-exported from learn-anything's utils. The
  snapshot's `validateDeck` and `validateEvent` are not ported, because nothing in R2
  uses them (R10).
- **`app/lib/restore.mjs`** (new): `inspectRestorable(slug)` and
  `restoreBackup(slug, file, { force })`. Covers R2 to R8.
- **`app/recover.mjs`** (new): the CLI and its exit codes (R9).
- **`package.json`:** `"recover": "node app/recover.mjs"`.
- **`.gitignore`:** `.learn/**/*.damaged-*`, with a comment (concern 5).
- **New tests:**
  - `app/test/statebackup.test.mjs`: retention, through a real settle.
  - `app/test/restore.test.mjs`: the library.
  - `app/test/recovercli.test.mjs`: the CLI, spawned, checking exit codes and output.
  - `app/test/damagedignore.test.mjs`: asks git whether an archive is ignored, with a
    control.

## Order of work

The decisions most likely to change come first, and the mechanical work last. Each step
is red, then green, in separate commits.

1. **`state.json` keeps a backup (R1).** This goes first because it changes the write
   path every mastery update takes.
   - Red, `statebackup.test.mjs`, through `applyAttemptToState` (`app/lib/mastery.mjs`)
     and `settleMastery` (`app/lib/settlement.mjs`), on a fixture root:
     - After one settle, `state.json.bak` is byte-identical to the pre-settle
       `state.json`.
     - The settlement's recorded `state_digest` still matches the published file.
     - With the primary made unparseable, a publish leaves an existing good `.bak`
       untouched.
   - Then the `atomic.mjs` export and the one-line `mastery.mjs` change.
2. **Validators (R10).**
   - Red: `restore.test.mjs` imports `schema.mjs` with `import()`, in its own test, so
     a missing module fails only that test. It checks:
     - a good fixture for each sidecar passes;
     - one broken field per sidecar is refused with its reason;
     - `assertData` throws a 422 that carries the label.
   - Then port `schema.mjs`.
3. **Report (R2).**
   - Red: `inspectRestorable` on a fixture with each primary state (intact, damaged,
     missing, invalid) against each backup state. It returns the right row, and a
     checksum of the fixture tree is unchanged.
   - Then the function.
4. **Restore `state.json` (R3 to R8).**
   - Red:
     - A damaged primary is restored. Its archive holds the damaged bytes, the map is
       regenerated, and `*.jsonl` files are unchanged.
     - Each bad backup is refused, with every live file byte-identical: `{}`,
       unparseable, missing, and unrenderable.
     - An intact primary is refused, then restored with `force`.
     - One applied attempt newer than the `.bak`'s mtime appears in `drift`, and
       `attempts.jsonl` is unchanged.
     - The restore holds the topic lock: a held lock makes it wait.
   - Then `restoreBackup`.
5. **Restore a sidecar (R3).**
   - Red: `cards.json` damaged, then restored. `inspectSidecars` stops reporting it as
     recovered from backup. `--file attempts.jsonl` and `--file ../x` are refused.
   - Then the allowlist branch.
6. **The CLI (R9, copy).**
   - Red: `recovercli.test.mjs` spawns `node app/recover.mjs` with
     `STUDYDECK_LEARN_ROOT` set to a fixture root. It checks:
     - exit 0, 1 and 2 in report mode;
     - exit 0 and 1 in restore mode;
     - the copy lines from the spec;
     - the idle-cockpit line before a sidecar restore.
   - Then `recover.mjs` and the npm script.
7. **Archives stay out of git (concern 5).**
   - Red: `git check-ignore` on a `.damaged-` path under `.learn` fails today.
   - Control: a plain `state.json` path is not ignored.
   - Then add the `.gitignore` line.
8. **Verify, review, ship:**
   - `npm test` with no `node_modules`, and `npm run verify`.
   - A live drive on `/tmp/learn` copies for every acceptance check in the spec.
   - A read-only `recover` run on the real tree.
   - The T3 adversarial review: a `pstack:interrogate` panel on the diff, with the panel's
     own models, under the `pstack-models.md` exception.
   - `security-review`.
   - Codex until `NO_FINDINGS`.
   - Then the PR, with every review posted.

## Risks

- **The backup change breaks a settlement's crash recovery.** Recovery matches a staged
  `state_digest` against the published file. Step 1's red test pins the digest, and
  the existing `mastery.test.mjs` crash cases must stay green.
- **`retainBackup` swallows its own failure** and logs to the console, by design. A
  missing `state.json.bak` is therefore possible after a failed copy. The report shows
  the backup as missing, so the gap stays visible.
- **The restore runs while the cockpit is up.** The lock covers `state.json`. A sidecar
  write can race, which concern 2 accepted. The CLI asks for an idle cockpit.
- **Drift uses the `.bak`'s mtime as "when the backup was taken".** Copying the tree
  with `cp -R` without `-p` changes mtimes, so drift on a copy may over-report.
  Over-reporting is the safe direction: it never hides an attempt. The live drive uses
  `cp -Rp`, and the test sets mtimes explicitly.
- **`learn-anything-cli` or `/learn:quiz` writes `state.json` without a backup.** That
  is out of scope by intent. The report then shows "no backup", which is accurate.

## Proof

- **Red runs:** recorded in each red commit and here.
- **Green:** `npm test` with `node_modules` absent; `npm run verify` clean.
- **Live, on `/tmp/learn` copies:** every acceptance check in the spec, using `cmp` and
  `shasum` over the copy before and after.
- **Real tree:** a read-only `npm run recover -- --topic <slug>` for each topic exits 0.
- **Reviews:**
  - the `pstack:interrogate` panel;
  - `security-review`;
  - `/gstack-codex review origin/main` until `NO_FINDINGS`.

  All of them are posted on the PR.

### Green and live, 2026-11-11

- **Green:** `npm test` with `node_modules` absent, 748 of 748 at `5b61820`.
  `npm run verify`: no damage found.
- **Live, on `/tmp/learn` copies made with `cp -Rp`:**
  - **R1.** No `state.json.bak` before. After one settle, the `.bak` equals the
    pre-settle `state.json` (`cmp` silent).
  - **R2.**
    - With `state.json` reduced to `{`, the report exits 1 and prints the restore
      command, and a checksum of the whole copy is unchanged.
    - A missing `state.json` with no backup exits 1 and points at git.
  - **R3, R5, R6.** The restore exits 0.
    - `state.json` equals its `.bak`.
    - The archive holds `{`.
    - The map is rewritten.
    - The topic returns to `/api/state` on the scratch server; it was in
      `unavailable_topics` before.
  - **Sidecar.** `cards.json` was restored. `/api/health` went from `degraded` to `ok`,
    and `attempts.jsonl` is unchanged.
  - **R4.** Intact with no backup, invalid backup, `attempts.jsonl` and `../x` each exit 1,
    and checksums of the copy are unchanged.
  - **R8.** `--force` over an intact primary archives it and restores.
  - **R7.** After an outside write, one real `settleMastery`, damage, then restore: drift
    names that attempt (`live-r2`). A rerun over the identical primary says it already
    matches and regenerates the map.
- **Real tree, read-only:** `recover` on all three topics prints `Nothing is damaged.`,
  exit 0. `git status` of the checkout is unchanged.
- **Reviews:**
  - **The T3 panel.** Four seats: correctness (Opus), design (Sonnet), evidence (Sonnet)
    and mechanics (Haiku). It raised one critical: drift missed the undone attempt. Two
    seats reproduced it. Every act-on finding was fixed test-first. See Deviations; the
    verdict is in the PR.
  - **`security-review`:** no findings.
  - **Codex:** run 1 found one P2, fixed test-first. Run 2 returned `NO_FINDINGS` at
    `5b61820`.

## Options not taken

- **Restoring from git.** The intent rules it out. A bad backup's refusal points at git
  instead.
- **Locking every sidecar write.** Concern 2: a bounded, millisecond race on a
  single-user app doesn't justify touching every write route.
- **A restore ledger.** Concern 6: the output and the archive are the record.
- **Porting `validateEvent` and `validateDeck`.** Nothing in R2 calls them. They belong
  with whatever slice validates history or decks.

## Deviations

- **Validator tests live in `app/test/schema.test.mjs`, not `restore.test.mjs`.** They
  get a file of their own so that a missing or broken `schema.mjs` fails only them, the
  pattern R1 used for new exports. The assertions are the ones step 2 lists.
- **Drift is placed by `replaced_digest`, with no timestamp rule.** Concern 1 said "a
  `ts` later than the backup's mtime". The panel (correctness and evidence seats) showed
  that this never fires in real use. `copyFileSync` stamps a `.bak` at the publish,
  after the attempt's own `ts`, so after any write from outside the cockpit the attempt
  a restore undoes went unreported. A first fix that unioned a `state_digest` anchor
  with the `ts` rule had the same gap.

  Every prepared settlement now records `replaced_digest`: the sha256 of the
  `state.json` bytes it published over. A restore reports the attempt whose replaced
  bytes are the backup, plus every attempt applied after it in the raw log. A backup no
  settlement replaced is reported as `drift_unplaced`, never as an empty list. James
  chose this on 2026-11-11, over keeping the source mtime on the `.bak`. This adds one
  field to new settlement records in `attempts.jsonl`. Pinned in `restore.test.mjs`
  through a real `settleMastery`.
- **Crash recovery does not match `state_digest`.** The spec's "Recovery after a crash"
  bullet and this plan's first risk say recovery matches the staged `state_digest`
  against the published file. The evidence seat found that `reconcilePrepared`
  compares mastery snapshots and never reads the digest. Keeping the published bytes
  identical still matters, but for a different reason: drift is placed by
  `replaced_digest`, which must equal the bytes the next publish reads. The code
  comments were corrected. The accepted spec and plan text are left as written, and
  this entry corrects them.
- **Fixes from the T3 panel**, each red then green. The panel had four seats:
  correctness, design, evidence and mechanics.
  - Drift by `replaced_digest`: see above.
  - A missing `state.json` is damage.
  - Refusals carry a code, so the CLI no longer matches message text.
  - A rerun over an identical `state.json` regenerates the map.
  - A failed map write says that `state.json` was already restored.
  - The idle line prints only before a sidecar restore that will write.
  - A failure while loading modules exits 2.
  - There is one sidecar list, with a validator table.
  - The verdict, and the findings left as Consider, are in the PR.
