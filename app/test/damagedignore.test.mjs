// WHAT: Proves git ignores the damaged copies a restore archives, and not the files restored.
// WHY:  `npm run recover` keeps every replaced primary as `<file>.damaged-<stamp>-<hex>`
//       beside it, under `.learn/`, which is committed. Unignored, the first restore would
//       leave damaged bytes one `git add -A` away from both remotes. The guarantee is one
//       .gitignore pattern, so it is asked of git itself (backup-restore spec, concern 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/config.mjs';

const TOPIC = '.learn/topics/any-topic';

/** `git check-ignore -q` exits 0 when the path is ignored, 1 when it is not. */
function checkIgnore(path) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO_ROOT });
  assert.equal(result.error, undefined, 'git must be runnable for this check to mean anything');
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
  return result.status === 0;
}

test('an archived damaged copy is ignored by git, beside state.json and in cockpit/', () => {
  assert.equal(checkIgnore(`${TOPIC}/state.json.damaged-20261111T153000Z-a3f9`), true);
  assert.equal(checkIgnore(`${TOPIC}/cockpit/cards.json.damaged-20261111T153000Z-a3f9`), true);
});

test('the restored files themselves are NOT ignored — the control', () => {
  // Without this, a pattern that swallowed the topic directory would pass above.
  assert.equal(checkIgnore(`${TOPIC}/state.json`), false);
  assert.equal(checkIgnore(`${TOPIC}/cockpit/cards.json`), false);
});
