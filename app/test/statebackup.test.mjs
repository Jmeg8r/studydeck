// WHAT: The cockpit keeps the previous state.json as state.json.bak on every mastery write.
// WHY:  Sidecars always had a backup; state.json never did, because mastery publishes it
//       with writeFileAtomicSync, so a damaged state.json had nothing to restore from and
//       the topic dropped out of every view (backup-restore spec R1). The backup must not
//       change what is published: the bytes on disk stay exactly the staged bytes whose
//       digest the settlement records.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-statebackup-'));
// Before config.mjs loads: it resolves the learn root once, at import time.
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;

const { config } = await import('../lib/config.mjs');
const { applyAttemptToState } = await import('../lib/mastery.mjs');

const TOPIC = config.topics[0].slug;
const CONCEPT = 'backup-fixture-concept';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

function seedTopic() {
  const dir = join(FIXTURE_ROOT, TOPIC);
  mkdirSync(join(dir, 'cockpit'), { recursive: true });
  const state = {
    version: 1, slug: TOPIC, topic: 'Backup Fixture', created: '2026-11-11', last_updated: null,
    domains: [{
      slug: 'fixture-domain', name: 'Fixture Domain',
      concepts: [{
        name: 'Fixture Concept', slug: CONCEPT, status: 'unexplored', confidence: 0.1,
        practice_count: 0, explain_count: 0, last_explained: null, last_practiced: null,
        details: ['a detail'],
      }],
    }],
  };
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return dir;
}

test('a mastery write keeps the state.json it replaced, and publishes exactly what it staged', async () => {
  const dir = seedTopic();
  const before = readFileSync(join(dir, 'state.json'));
  let stagedDigest = null;

  await applyAttemptToState(TOPIC, CONCEPT, { score: 2, max: 2 }, {
    onPrepared: (staged) => { stagedDigest = staged.state_digest; },
  });

  const published = readFileSync(join(dir, 'state.json'));
  assert.notDeepEqual(published, before, 'the write changed state.json');
  assert.ok(existsSync(join(dir, 'state.json.bak')), 'state.json.bak exists');
  assert.deepEqual(readFileSync(join(dir, 'state.json.bak')), before, 'the backup is the replaced copy, byte for byte');
  assert.equal(sha256(published), stagedDigest, 'the published bytes are exactly the staged bytes');
});

test('a primary that does not parse never overwrites a good backup', async () => {
  const { writeFileAtomicWithBackupSync } = await import('../lib/atomic.mjs');
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'retain-'));
  const path = join(dir, 'state.json');
  writeFileSync(`${path}.bak`, '{"good":true}\n');
  writeFileSync(path, '{');

  writeFileAtomicWithBackupSync(path, '{"next":true}\n');

  assert.equal(readFileSync(path, 'utf8'), '{"next":true}\n');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), '{"good":true}\n', 'the damaged primary was not kept');
});
