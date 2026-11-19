// WHAT: Tests for the podcast worker pre-flight probe in lib/workerhealth.mjs.
// WHY: The probe's verdict decides between committing a 20-render batch and a
//      503-with-instructions, so every verdict transition is pinned here. The docker
//      read is injected, which makes all of them provable without docker or a live
//      Open Notebook. Node stdlib only, matching the app's zero-dependency ethos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKUP_MARKER, pickupSeen, probeWorkerPickup, stuckCanaryRows } from '../lib/workerhealth.mjs';

// Captured verbatim from `docker logs quorum-open_notebook-1` on 2026-07-22 — the real
// loguru line the probe must recognise. If ON ever reformats this, the fixture (and the
// marker) need re-verifying against a live render.
const REAL_LINE = '2026-07-19 16:07:03.681 | INFO     '
  + '| commands.podcast_commands:generate_podcast_command:75 '
  + '- Starting podcast generation for episode: Cockpit smoke test';

test('pickupSeen matches the real worker log line for the exact episode', () => {
  assert.equal(pickupSeen(REAL_LINE, 'Cockpit smoke test'), true);
});

test('pickupSeen does not match a different episode name', () => {
  assert.equal(pickupSeen(REAL_LINE, 'fastbook 01 — Your Deep Learning Journey'), false);
});

test('pickupSeen treats regex metacharacters in a title as plain text', () => {
  const name = 'fastbook 19 (bonus) — What now? [draft]';
  assert.equal(pickupSeen(`prefix - ${PICKUP_MARKER} ${name}`, name), true);
});

test('probeWorkerPickup → seen on the first read, without sleeping a poll interval', async () => {
  const startedAt = Date.now();
  const verdict = await probeWorkerPickup({
    episodeName: 'Cockpit smoke test',
    timeoutMs: 5_000,
    pollMs: 1_000,
    readLog: async () => REAL_LINE,
  });
  assert.equal(verdict.status, 'seen');
  assert.ok(Date.now() - startedAt < 900, 'a first-read hit must return before the first poll sleep');
});

// A virtual clock for the probe's deadline. With the real clock, a loaded CI runner can
// spend the whole budget before the read a test depends on happens (forge CI run 222 got
// 'unavailable' where 'timeout' was due), so these tests let the reads, not the runner,
// decide when time passes. t.mock restores Date.now when the test ends.
function virtualClock(t) {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  return { advance: (ms) => { now += ms; } };
}

test('probeWorkerPickup → seen when the line only appears on a later poll', async (t) => {
  virtualClock(t);
  let reads = 0;
  const verdict = await probeWorkerPickup({
    episodeName: 'Cockpit smoke test',
    timeoutMs: 500,
    pollMs: 5,
    readLog: async () => {
      reads += 1;
      return reads >= 3 ? REAL_LINE : 'worker chatter without a pickup';
    },
  });
  assert.equal(verdict.status, 'seen');
  assert.equal(reads, 3, 'the hit came from the third read, not the first');
});

test('probeWorkerPickup → timeout when the log is readable but the line never appears', async () => {
  const verdict = await probeWorkerPickup({
    episodeName: 'fastbook 03 — Data Ethics',
    timeoutMs: 40,
    pollMs: 5,
    readLog: async () => 'healthy-looking chatter without a pickup',
  });
  assert.equal(verdict.status, 'timeout');
  assert.ok(verdict.waited_ms >= 40, 'the full timeout was waited out');
});

test('probeWorkerPickup → unavailable when every log read fails', async () => {
  const verdict = await probeWorkerPickup({
    episodeName: 'fastbook 03 — Data Ethics',
    timeoutMs: 40,
    pollMs: 5,
    readLog: async () => {
      throw new Error('docker: command not found');
    },
  });
  assert.equal(verdict.status, 'unavailable');
  assert.match(verdict.detail, /docker/);
});

test('probeWorkerPickup → timeout, not unavailable, when reads fail then recover', async (t) => {
  // One good read proves the log is reachable — a missing line after that is the
  // stale-worker verdict, not an infrastructure one. The budget runs out during the
  // second read, so that read is guaranteed to happen before the deadline check.
  const clock = virtualClock(t);
  const timeoutMs = 60;
  let reads = 0;
  const verdict = await probeWorkerPickup({
    episodeName: 'fastbook 03 — Data Ethics',
    timeoutMs,
    pollMs: 5,
    readLog: async () => {
      reads += 1;
      if (reads === 1) throw new Error('transient docker hiccup');
      clock.advance(timeoutMs);
      return 'no pickup line here';
    },
  });
  assert.equal(verdict.status, 'timeout');
  assert.equal(reads, 2, 'the verdict came after exactly one failed and one good read');
});

// --- stuckCanaryRows: what a failed pre-flight may delete -------------------------

const RUNNING = new Set(['pending', 'queued', 'running']);
const FIRED_AT = Date.parse('2026-07-22T18:00:00.000Z');
const row = (over) => ({
  id: 'podcast_episode:x',
  name: 'fastbook 03 — Data Ethics',
  audio_available: false,
  status: 'running',
  created: '2026-07-22T18:00:05.000Z',
  ...over,
});

test('stuckCanaryRows selects the row the batch just created', () => {
  const rows = stuckCanaryRows([row()], {
    title: 'fastbook 03 — Data Ethics', firedAtMs: FIRED_AT, runningStatuses: RUNNING,
  });
  assert.equal(rows.length, 1);
});

test('stuckCanaryRows never selects a different chapter, finished audio, or a failed row', () => {
  const episodes = [
    row({ name: 'fastbook 04 — Under the Hood' }),
    row({ audio_available: true }),
    row({ status: 'failed' }),
  ];
  const rows = stuckCanaryRows(episodes, {
    title: 'fastbook 03 — Data Ethics', firedAtMs: FIRED_AT, runningStatuses: RUNNING,
  });
  assert.equal(rows.length, 0);
});

test('stuckCanaryRows leaves an OLD stuck row from a previous incident alone', () => {
  // Same name, still "running" — but created long before this batch fired. Deleting it
  // here would hide evidence of an earlier stall the user may still be diagnosing.
  const rows = stuckCanaryRows([row({ created: '2026-07-22T16:00:00.000Z' })], {
    title: 'fastbook 03 — Data Ethics', firedAtMs: FIRED_AT, runningStatuses: RUNNING,
  });
  assert.equal(rows.length, 0);
});

test('stuckCanaryRows tolerates a minute of clock slack between host and container', () => {
  const rows = stuckCanaryRows([row({ created: '2026-07-22T17:59:10.000Z' })], {
    title: 'fastbook 03 — Data Ethics', firedAtMs: FIRED_AT, runningStatuses: RUNNING,
  });
  assert.equal(rows.length, 1, 'created 50s before fire time is within the slack window');
});

test('stuckCanaryRows skips rows with a missing or unparseable created stamp', () => {
  const episodes = [row({ created: null }), row({ created: 'not-a-date' })];
  const rows = stuckCanaryRows(episodes, {
    title: 'fastbook 03 — Data Ethics', firedAtMs: FIRED_AT, runningStatuses: RUNNING,
  });
  assert.equal(rows.length, 0, 'no timestamp means no proof it is ours — leave it');
});

test('probeWorkerPickup → unavailable immediately when no container is configured', async () => {
  const startedAt = Date.now();
  const verdict = await probeWorkerPickup({
    episodeName: 'anything',
    timeoutMs: 5_000,
    pollMs: 1_000,
  });
  assert.equal(verdict.status, 'unavailable');
  assert.match(verdict.detail, /workerContainer/);
  assert.ok(Date.now() - startedAt < 500, 'a missing container must not spend the probe budget');
});
