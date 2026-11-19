// WHAT: Proves git ignores a chapter rendition's audio and keeps its manifest.
// WHY:  A rendered chapter is 15–30 MB of MP3 clips and a candidate; committed, every
//       render would grow the repo's history for good. The manifest is the provenance and
//       QC evidence, and is committed like every other cockpit sidecar (James, 2026-11-11).
//       Both halves rest on .gitignore patterns, so the rule is asked of git itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/config.mjs';

const COCKPIT = '.learn/topics/any-topic/cockpit';
const RENDITION = `${COCKPIT}/audio/render-0123456789abcdef01234567`;

/** `git check-ignore -q` exits 0 when the path is ignored, 1 when it is not. */
function checkIgnore(path) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO_ROOT });
  assert.equal(result.error, undefined, 'git must be runnable for this check to mean anything');
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed: ${result.stderr}`);
  return result.status === 0;
}

test('a rendition\'s audio and concat list are ignored by git', () => {
  for (const file of [`clips/${'a'.repeat(64)}.mp3`, 'candidate.mp3', 'candidate.part.mp3', 'concat.txt']) {
    assert.equal(checkIgnore(`${RENDITION}/${file}`), true, file);
  }
});

test('the manifest is NOT ignored, nor is the cockpit beside it — the control', () => {
  // Without this, a pattern that swallowed the whole audio folder, or the cockpit, would pass above.
  // The manifest's .bak is ignored, like every backup under .learn/ (`.learn/**/*.bak`).
  assert.equal(checkIgnore(`${RENDITION}/manifest.json`), false);
  assert.equal(checkIgnore(`${COCKPIT}/attempts.jsonl`), false);
});
