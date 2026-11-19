---
change: 2026-11-11-readjson-damage
status: accepted
track: T2
intent: ./intent.md
accepted_by: james
linear: pending
skills_in_force: []
claude_config_sha: bd5f5a9
---
# Spec: readJsonSafe reports damage, not "missing"

## Flagged concerns

1. **Error text can now carry an absolute path.** A `readFileSync` failure's message reads
   like `EACCES: permission denied, open '/Volumes/Projects/…/cards.json'`. Today
   `/api/health` only ever shows parse messages, which carry no path. After this change its
   `files[].error` can show an absolute local path.
   *Source:* hard rule 6's spirit (send the browser only what it needs) and
   `security-review`. *Recommendation:* accept. The path is the user's own repo. Rule 12
   lets only loopback, or the one tailnet user through the tailnet door, read
   `/api/health`. The text is what makes an EPERM diagnosable. The ON password and other
   secrets never enter this path.
   *James (2026-11-11):* accepted as recommended.

2. **An unreadable cockpit directory flags every JSON sidecar, including ones never
   written.** When the directory itself can't be stat'd, `EACCES` on a file says nothing
   about whether the file exists. So all `JSON_SIDECARS` report `fallback` and land in
   `degraded`. *Source:* the intent's own rule that only ENOENT means missing.
   *Recommendation:* accept. "Can't verify" is damage, and listing five files during an
   outage is louder than listing none, which is the point.
   *James (2026-11-11):* accepted as recommended.

3. **This deliberately reverses two in-code notes.** `atomic.mjs:145-149` says the
   validated pair stays separate "so nothing above this line changes".
   `atomiccharacter.test.mjs`'s header says that editing one of its assertions means "the
   change was not additive". Both were written for renderer-foundations and are correct for
   that slice. *Recommendation:* rewrite both notes in the same commits that change the
   behaviour, saying that readjson-damage merged the readers on purpose (James, 2026-11-11).
   Flip the `:47` assertion in a red commit of its own, so `git log` shows it was intended.
   *James (2026-11-11):* accepted as recommended.

4. **Policy skills.** `design:ux-copy` and `design:accessibility-review` don't apply,
   because nothing user-facing changes. `gstack-cso` doesn't apply either: no auth,
   secrets or migration is involved. `security-review` applies to the diff, and per James's
   standing rule it runs as a read-only subagent on `git diff origin/main` before the PR,
   not at spec time. So `skills_in_force` is empty here, and that is a statement, not an
   omission. *Recommendation:* accept.
   *James (2026-11-11):* accepted as recommended.

## Requirements

Each one traces to the intent's **Proposed outcome**.

- **R1.** `readJsonSafe` returns `{ value: fallback, source: 'missing', error: null }`
  only when reading the primary AND reading its `.bak` both fail with `ENOENT`.
- **R2.** A primary that fails with `ENOENT` beside a `.bak` that is unusable (parse
  error, or any I/O error other than ENOENT) returns `source: 'fallback'`. The `error`
  starts `primary missing; backup unusable:` and names the backup's problem. An I/O
  failure of the backup also adds `code`.
- **R3.** A primary that fails with any code other than `ENOENT` (`EACCES`, `EPERM`,
  `ENOTDIR`, `EISDIR` …) is unreadable, not missing. A usable `.bak` gives
  `source: 'backup'` with the primary's error. Otherwise the result is `source: 'fallback'`
  with the primary's error and its `code`.
- **R4.** The cases that already worked are unchanged, byte for byte: an intact primary;
  a corrupt primary with a good `.bak`; a corrupt primary with a corrupt `.bak`; a
  missing primary with a good `.bak` (`error: 'primary file is missing'`); and both
  missing. A parse failure carries no `code`, as today.
- **R5.** `readJsonSafe` is implemented on `readJsonValidated`'s core with a validator
  that accepts every value. `readJsonValidated`'s behaviour does not change:
  `atomicvalidated.test.mjs` stays untouched and green.
- **R6.** `inspectSidecars` decides whether to list a JSON sidecar from the read result,
  not from `existsSync`. It skips a file only when `source === 'missing'`. Its report
  shape (`{ file, source, error }`, `degraded`) does not change.
- **R7.** Video `get(id)` and Higgsfield `get(id)` throw their existing 500 "state is
  damaged" error when the job file is missing beside an unusable `.bak`. A job id with
  neither file still returns `null`, so its route still answers 404.
- **R8.** Nothing on the write path changes: `writeFileAtomicSync`, `retainBackup`,
  `writeJsonAtomicSync`, `writeFileAtomicWithBackupSync`, `appendLineSync`.

## Design

### `app/lib/atomic.mjs`

```js
const ACCEPT_ANY = () => [];
export function readJsonSafe(path, fallback) {
  return readJsonValidated(path, fallback, ACCEPT_ANY);
}
```

- `readJsonValidated` and `tryReadValidated` are hoisted above `readJsonSafe`, or
  `readJsonSafe` moves below them. Either way, the module reads top to bottom.
- `readJsonSafe`'s old body goes away. So does `tryReadJson`'s use as a reader, but
  `tryReadJson` itself stays, because `retainBackup` still uses it (R8). Its `existsSync`
  there decides only whether to make a backup, and that is out of scope.
- The `:145-149` comment is rewritten as concern 3 says. The doc comment on `readJsonSafe`
  keeps its "why the source is returned" paragraph and adds one line: missing means ENOENT
  for both copies, never "`existsSync` said no".
- The result gains an optional `code` only where `readJsonValidated` already adds one.
  All callers destructure `{ value, source, error }`, so an extra key changes nothing for
  them.

### `app/lib/sidecar.mjs`

```js
for (const name of JSON_SIDECARS) {
  const { source, error } = readJsonSafe(sidecarPath(slug, name), null);
  if (source === 'missing') continue;
  files.push({ file: name, source, error });
}
```

`readJson` (`:73-82`) needs no change. It already logs `backup` and `fallback`.

### Callers that inherit the fix with no edit

- `videogeneration.mjs:195-197` and `higgsfield.mjs:66-68` already throw on
  `source === 'fallback'`.
- `sidecar.mjs:375` already counts `fallback` as degraded.

### Answer to the intent's open question

The JSONL readers are carried forward, unchanged. See **Open questions**.

## Security and data

- No auth, routing, header, or CORS change. Rule 12's guard runs before any of this.
- No secret is read or written here. The ON password never reaches `atomic.mjs`.
- The new information exposure is local paths in health error text (concern 1).
- Data safety: this change reads only, apart from the write-path functions R8 leaves
  untouched. The worst failure mode is a false "damaged" report, which surfaces as a 500
  or a `degraded` entry, never as a deleted or overwritten file. The opposite failure
  (reporting healthy when damaged) is the bug being fixed.

## Acceptance checks

Each test is committed red before its code, and the run is recorded in the commit
message.

- **A1 (R2, flips `atomiccharacter.test.mjs:47`):** a `.bak` of `{` with no primary gives
  `source: 'fallback'`, value = fallback, and an `error` matching
  `/^primary missing; backup unusable:/`.
- **A2 (R3, portable):** the path `<dir>/notadir/data.json`, where `notadir` is a regular
  file, reads as `fallback` with `code: 'ENOTDIR'`, never `missing`. It runs as root and
  on Linux CI.
- **A3 (R3, permissions):** a parent directory at mode `000` gives `fallback` with
  `code: 'EACCES'`. It is skipped with a stated reason when `process.getuid?.() === 0`.
  Mode `700` is restored in `finally` so cleanup works.
- **A4 (R3, guard):** an unreadable primary beside a good `.bak` is served from the
  backup, with the primary's error. It is built with an `EISDIR` primary (a directory at
  the path), because a primary and its `.bak` share a parent, so `ENOTDIR` can't break
  one without the other. This passes today and is kept as a guard across the refactor.
- **A5 (R4):** the other `atomiccharacter.test.mjs` cases and `atomic.test.mjs:81-98`
  pass unchanged.
- **A6 (R5):** `atomicvalidated.test.mjs` shows no diff (`git diff origin/main --stat`
  doesn't list it) and passes.
- **A7 (R6):** in `sidecar.test.mjs`, a topic whose `cards.json` is missing beside a
  `cards.json.bak` of `{` has `report.degraded` containing `cards.json`. Red today.
- **A8 (R7):** in `videogeneration.test.mjs` and `higgsfield.test.mjs`, `get(id)` on a job
  whose JSON is missing beside a corrupt `.bak` throws with status 500. Red today, since
  it returns `null`. A control in the same test asserts that an id with neither file
  returns `null`.
- **A9 (R8):** `git diff origin/main -- app/lib/atomic.mjs` touches no write-path
  function body.
- **A10:** `npm test` passes with `node_modules` absent, and the count rises from 912 by
  the new cases.
- **A11 (live):** on a `/tmp/learn` copy served on 4320, remove one sidecar and write
  `{` to its `.bak`. `curl -s localhost:4320/api/health` then lists that file in that
  topic's `degraded`. Restoring the `.bak` clears it.

## Open questions

- **JSONL readers** (`sidecar.mjs:94`, `:360`), carried forward from the intent. They have
  the same `existsSync` blind spot: an EPERM `attempts.jsonl` reads as empty history.
  Recommended as the next slice, since they fold line by line and need their own tests.
  *Who answers:* James, after this slice merges.
