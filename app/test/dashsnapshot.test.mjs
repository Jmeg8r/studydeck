// WHAT: Tests for the dashboard snapshot export (lib/dashsnapshot.mjs + dashboard-snapshot.mjs).
// WHY: The first snapshot came from a throwaway script that re-derived stage state and got
//      it wrong — it dated a paused topic's stages and ignored the reschedule clamp. These
//      tests pin that the export goes through the cockpit's own readers, that it never
//      carries deck content (rule 7), and that its columns, which the dashboard reads by
//      name, stay put.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, REPO_ROOT } from '../lib/config.mjs';
import { SNAPSHOT_FILES, buildDashboardSnapshot } from '../lib/dashsnapshot.mjs';

const TODAY = '2026-11-07';
const SECRET_FRONT = 'FRONT-TEXT-MUST-NOT-LEAK';
const SECRET_MISS = 'q-secret-miss';
let root;
let originalLearnRoot;

const concept = (name, status, confidence) => ({
  name, slug: name.toLowerCase(), status, confidence, practice_count: status === 'unexplored' ? 0 : 1,
  explain_count: 0, last_explained: null, last_practiced: status === 'unexplored' ? null : '2026-10-01', details: [],
});

function writeTopic(slug, { topic, domains, schedule, files = {} }) {
  mkdirSync(join(root, slug, 'cockpit'), { recursive: true });
  writeFileSync(join(root, slug, 'state.json'), JSON.stringify({ version: 1, topic, slug, created: '2026-09-01', domains }));
  writeFileSync(join(root, slug, 'cockpit', 'schedule.json'), JSON.stringify({ version: 1, step_overrides: {}, ...schedule }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, slug, 'cockpit', name), body);
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

beforeEach(() => {
  originalLearnRoot = config.learnRoot;
  root = mkdtempSync(join(tmpdir(), 'dashsnapshot-test-'));
  config.learnRoot = root;

  writeTopic('paused-topic', {
    topic: 'Paused Topic',
    domains: [{ name: 'Basics', slug: 'basics', concepts: [concept('Alpha', 'needs_practice', 0.2), concept('Beta', 'unexplored', 0)] }],
    schedule: { started: '2026-07-18', paused: true, step_overrides: { prime: '2026-07-30' } },
    files: {
      'attempts.jsonl': jsonl([
        { ts: '2026-10-02T10:00:00', kind: 'quiz', concept_slug: 'alpha', attempt_id: 'a1', revision: 0, score: 2, max: 5, misses: [SECRET_MISS] },
        { ts: '2026-10-02T10:05:00', kind: 'quiz', concept_slug: 'alpha', attempt_id: 'a1', revision: 1, score: 3, max: 5, misses: [SECRET_MISS] },
      ]),
      'cards.json': JSON.stringify([{ id: 'c1', front: SECRET_FRONT, back: 'BACK', concept_slug: 'alpha', created: '2026-10-02' }]),
      'reading.json': JSON.stringify({ 'source:x': { position: 0.25, updated: '2026-10-03T12:00:00.000Z', title: 'Chapter 1' } }),
    },
  });
  writeTopic('running-topic', {
    topic: 'Running Topic',
    domains: [],
    schedule: { started: '2026-10-28', paused: false },
    files: {
      'stages.jsonl': jsonl([{ ts: '2026-10-28T09:00:00Z', milestone_key: 'prime', action: 'complete' }]),
      'attempts.jsonl': jsonl([
        { ts: '2026-11-01T10:00:00', kind: 'essay', concept_slug: 'x', attempt_id: 'e1', revision: 0, status: 'grading_pending', score: null, max: 10 },
      ]),
      'operations.jsonl': jsonl([
        { operation_id: 'op-src', mutation_id: 'm1', revision: 0, ts: '2026-11-02T10:00:00', kind: 'open_notebook_source', stage: 'complete' },
        { operation_id: 'op-del', mutation_id: 'm2', revision: 0, ts: '2026-11-03T10:00:00', kind: 'podcast_delete', stage: 'complete' },
        { operation_id: 'op-pod', mutation_id: 'm3', revision: 0, ts: '2026-11-04T10:00:00', kind: 'podcast_episode', stage: 'complete' },
      ]),
      'practice.jsonl': jsonl([
        { ts: '2026-11-05T10:00:00', event_type: 'answer_revealed', mutation_id: 'p1' },
        { ts: '2026-11-05T11:00:00', event_type: 'evidence_recorded', outcome: 'rejected', mutation_id: 'p2' },
        { ts: '2026-11-05T12:00:00', event_type: 'evidence_recorded', outcome: 'confirmed', mutation_id: 'p3' },
      ]),
      'teachbacks.jsonl': jsonl([
        { ts: '2026-11-06T10:00:00', event_type: 'teachback_recorded', outcome: 'rejected', mutation_id: 't1' },
        { ts: '2026-11-06T11:00:00', event_type: 'teachback_recorded', outcome: 'confirmed', mutation_id: 't2' },
      ]),
    },
  });
});

afterEach(() => {
  config.learnRoot = originalLearnRoot;
  rmSync(root, { recursive: true, force: true });
});

const SLUGS = ['paused-topic', 'running-topic'];

test('a paused topic has no stage dates, even with an override on file', () => {
  const { stages } = buildDashboardSnapshot(SLUGS, TODAY);
  const paused = stages.filter((s) => s.topic === 'Paused Topic');
  assert.equal(paused.length, 9);
  assert.ok(paused.every((s) => s.state === 'paused' && s.not_before === null));
});

test('a running topic is done only where an event says so, and owes the rest in order', () => {
  const { stages, topics } = buildDashboardSnapshot(SLUGS, TODAY);
  const running = stages.filter((s) => s.topic === 'Running Topic');
  const state = Object.fromEntries(running.map((s) => [s.key, s.state]));
  assert.equal(state.prime, 'done');
  assert.equal(state.study, 'now');
  assert.equal(state.quiz, 'owed');
  assert.equal(state.teach, 'ahead');
  const row = topics.find((t) => t.slug === 'running-topic');
  assert.equal(row.stages_done, 1);
  assert.equal(row.next_stage, 'Study');
  assert.equal(row.avg_confidence, null, 'no concepts means no average, not zero');
});

test('each operation kind keeps its own label, and a podcast deletion is not activity', () => {
  const { activity } = buildDashboardSnapshot(SLUGS, TODAY);
  const kinds = activity.filter((a) => a.topic === 'Running Topic').map((a) => `${a.day} ${a.kind}`);
  assert.ok(kinds.includes('2026-11-02 Source imported'));
  assert.ok(kinds.includes('2026-11-04 Podcast requested'), 'a completed operation means accepted, not rendered');
  assert.ok(!kinds.some((k) => k.startsWith('2026-11-03')), 'deleting an episode is not study activity');
});

test('only confirmed practice and teach-back evidence counts, as in the cockpit', () => {
  const { activity } = buildDashboardSnapshot(SLUGS, TODAY);
  const on = (day) => activity.filter((a) => a.topic === 'Running Topic' && a.day === day).map((a) => a.kind);
  assert.deepEqual(on('2026-11-05'), ['Practice'], 'a revealed answer or a rejected task is not practice');
  assert.deepEqual(on('2026-11-06'), ['Teach-back']);
});

test('an attempt still awaiting a grade is not counted as a graded attempt', () => {
  const { activity } = buildDashboardSnapshot(SLUGS, TODAY);
  const running = activity.filter((a) => a.topic === 'Running Topic' && a.day === '2026-11-01').map((a) => a.kind);
  assert.deepEqual(running, ['Attempt awaiting grade']);
});

test('attempts are folded to the newest revision', () => {
  const attempts = buildDashboardSnapshot(SLUGS, TODAY).attempts.filter((a) => a.topic === 'Paused Topic');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].score, 3);
  assert.equal(attempts[0].pct, 0.6);
  assert.equal(attempts[0].misses, 1);
});

test('no deck content reaches the snapshot', () => {
  const text = JSON.stringify(buildDashboardSnapshot(SLUGS, TODAY));
  assert.ok(!text.includes(SECRET_FRONT));
  assert.ok(!text.includes('BACK'));
  assert.ok(!text.includes(SECRET_MISS));
});

test('every file keeps the columns the dashboard reads', () => {
  const snapshot = buildDashboardSnapshot(SLUGS, TODAY);
  const expected = {
    topics: ['topic', 'slug', 'ring', 'created', 'schedule', 'day_n', 'concepts', 'touched', 'mastered',
      'avg_confidence', 'attempts', 'cards', 'stages_done', 'stages_owed', 'next_stage', 'last_activity'],
    stages: ['topic', 'key', 'stage', 'day', 'not_before', 'state', 'owed_days', 'completed_on'],
    concepts: ['topic', 'domain', 'concept', 'status', 'confidence', 'practice_count', 'explain_count', 'last_activity'],
    attempts: ['topic', 'ts', 'kind', 'status', 'concept', 'score', 'max', 'pct', 'misses'],
    activity: ['day', 'topic', 'kind'],
    reading: ['topic', 'source', 'position', 'updated'],
  };
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(SNAPSHOT_FILES).sort());
  for (const [name, columns] of Object.entries(expected)) {
    assert.ok(snapshot[name].length > 0, `${name} has rows in the fixture`);
    for (const row of snapshot[name]) assert.deepEqual(Object.keys(row), columns, name);
  }
});

test('the CLI writes all six files and leaves the learn tree alone', () => {
  const out = mkdtempSync(join(tmpdir(), 'dashsnapshot-out-'));
  const before = readdirSync(join(root, 'paused-topic', 'cockpit')).sort();
  try {
    const run = spawnSync(process.execPath, ['app/dashboard-snapshot.mjs', '--out', out, '--date', TODAY, '--topics', SLUGS.join(',')], {
      cwd: REPO_ROOT, env: { ...process.env, STUDYDECK_LEARN_ROOT: root }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    for (const file of Object.values(SNAPSHOT_FILES)) {
      assert.ok(Array.isArray(JSON.parse(readFileSync(join(out, file), 'utf8'))), file);
    }
    assert.deepEqual(readdirSync(join(root, 'paused-topic', 'cockpit')).sort(), before);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
