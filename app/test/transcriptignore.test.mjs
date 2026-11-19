// WHAT: Proves git ignores role-session transcripts and does not ignore their outcomes.
// WHY:  `.learn/` sidecars are committed by convention, and a transcript is the one thing
//       under `cockpit/` that must never be. The whole guarantee is a single .gitignore
//       pattern; a typo in it, or a later "tidy-up" of that file, would put complete
//       conversations on two remotes without anything failing. So the rule is asked of
//       git itself, not read back out of the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/config.mjs';

const TOPIC_COCKPIT = '.learn/topics/any-topic/cockpit';

/** `git check-ignore -q` exits 0 when the path is ignored, 1 when it is not. */
function checkIgnore(path) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO_ROOT });
  assert.equal(result.error, undefined, 'git must be runnable for this check to mean anything');
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
  return result.status === 0;
}

test('a transcript is ignored by git', () => {
  assert.equal(checkIgnore(`${TOPIC_COCKPIT}/transcripts/00000000-0000-4000-8000-000000000000.jsonl`), true);
});

test('session outcomes and diagnoses are NOT ignored — the control', () => {
  // Without this, a pattern that swallowed the whole cockpit directory would pass above.
  assert.equal(checkIgnore(`${TOPIC_COCKPIT}/sessions.jsonl`), false);
  assert.equal(checkIgnore(`${TOPIC_COCKPIT}/diagnoses.jsonl`), false);
  assert.equal(checkIgnore(`${TOPIC_COCKPIT}/attempts.jsonl`), false);
});
