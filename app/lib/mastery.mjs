// WHAT: Applies learn-anything's own state-update table to state.json, then re-renders.
// WHY: An in-app quiz must leave state.json in exactly the state a Claude-session quiz
//      would. The thresholds below make the skill's prose criteria deterministic; the
//      deltas, cap, and status transitions are copied from the skill verbatim.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomicSync, writeFileAtomicWithBackupSync } from './atomic.mjs';
import { REPO_ROOT } from './config.mjs';
import { topicDir } from './learn.mjs';
import { withTopicLock } from './lock.mjs';
import { todayISO } from './schedule.mjs';

const execFileAsync = promisify(execFile);

// The skill grades Strong/Partial/Weak by judgement ("almost all correct", "core ideas
// right, some mistakes", "mostly wrong or blank"). An app has to be deterministic, so
// those bands are pinned to explicit ratios. Documented in implementation-notes.md.
const STRONG_RATIO = 0.85;
const PARTIAL_RATIO = 0.5;

// Verbatim from the skill's update table.
const CONFIDENCE_GAIN_STRONG = 0.12; // skill allows +0.1~0.15
const CONFIDENCE_GAIN_PARTIAL = 0.05;
const CONFIDENCE_CAP = 1.0; // schema rejects >1 and render.mjs fails validation
const MASTERED_MIN_CONFIDENCE = 0.7;
const MASTERED_MIN_PRACTICE = 2;

/** A render still gets killed at this ceiling — it just no longer takes the server with it. */
const RENDER_TIMEOUT_MS = 30_000;

/** Canonical render.mjs, deliberately NOT found by a bare scan. */
function resolveRenderScript() {
  // A detached git worktree under .claude/worktrees/ carries a second copy at a
  // different commit; `find . -print -quit` hits it first. Always prefer the
  // checkout's own skills directory.
  const canonical = join(REPO_ROOT, '.claude/skills/learn-anything-quiz/scripts/render.mjs');
  if (existsSync(canonical)) return canonical;

  for (const skill of ['learn-anything-explain', 'learn-anything-topic', 'learn-anything-practice']) {
    const candidate = join(REPO_ROOT, `.claude/skills/${skill}/scripts/render.mjs`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function performanceBand(score, max) {
  if (max === 0) return 'weak';
  const ratio = score / max;
  if (ratio >= STRONG_RATIO) return 'strong';
  if (ratio >= PARTIAL_RATIO) return 'partial';
  return 'weak';
}

/** Keep confidence a clean 2-decimal number so diffs stay readable. */
const bumpConfidence = (current, gain) =>
  Math.round(Math.min(current + gain, CONFIDENCE_CAP) * 100) / 100;

/**
 * Apply the update table to one concept. Returns the mutated concept plus a
 * before/after summary for the UI — the caller decides whether to persist.
 */
function applyBand(concept, band, today) {
  const before = masterySnapshot(concept);

  if (band === 'strong') {
    concept.confidence = bumpConfidence(concept.confidence, CONFIDENCE_GAIN_STRONG);
    concept.practice_count += 1;
    concept.last_practiced = today;
    concept.status =
      concept.confidence > MASTERED_MIN_CONFIDENCE && concept.practice_count >= MASTERED_MIN_PRACTICE
        ? 'mastered'
        : 'in_progress';
  } else if (band === 'partial') {
    concept.confidence = bumpConfidence(concept.confidence, CONFIDENCE_GAIN_PARTIAL);
    concept.practice_count += 1;
    concept.last_practiced = today;
    concept.status = 'needs_practice';
  } else {
    // Weak: the table changes status ONLY — confidence, practice_count and
    // last_practiced are all left alone. Matching that exactly matters, because
    // the verify criterion is a state.json diff identical to the manual flow.
    concept.status = 'needs_practice';
  }

  return { before, after: masterySnapshot(concept) };
}

/** The exact concept fields that a mastery transition is allowed to change. */
function masterySnapshot(concept) {
  return {
    status: concept.status,
    confidence: concept.confidence,
    practice_count: concept.practice_count,
    last_practiced: concept.last_practiced ?? null,
  };
}

/** sha256 of state or map bytes, as recorded in a settlement. restore.mjs matches against it. */
export const digest = (value) => createHash('sha256').update(value).digest('hex');

function readStateAndConcept(topicSlug, conceptSlug) {
  const dir = topicDir(topicSlug);
  const statePath = join(dir, 'state.json');
  const bytes = readFileSync(statePath, 'utf8');
  const state = JSON.parse(bytes);
  const concept = state.domains.flatMap((d) => d.concepts).find((c) => c.slug === conceptSlug);
  if (!concept) throw new Error(`concept "${conceptSlug}" not found in ${topicSlug}/state.json`);
  return { dir, statePath, state, concept, replacedDigest: digest(bytes) };
}

/** Read the authoritative fields used to reconcile a prepared settlement. */
export function readMasterySnapshot(topicSlug, conceptSlug) {
  return masterySnapshot(readStateAndConcept(topicSlug, conceptSlug).concept);
}

/** Deliberately structural: status and a zero confidence are meaningful values. */
export const sameMasterySnapshot = (left, right) =>
  Boolean(left) && Boolean(right) &&
  left.status === right.status &&
  left.confidence === right.confidence &&
  left.practice_count === right.practice_count &&
  (left.last_practiced ?? null) === (right.last_practiced ?? null);

/**
 * Stage a complete state/map pair without touching the live topic directory.
 *
 * Callers must already hold `withTopicLock`. The returned bytes are both the exact values
 * later published and the evidence recorded in the attempt's prepared settlement.
 */
async function stageAttemptUpdate(topicSlug, conceptSlug, { score, max }, { date = todayISO(), ...renderOptions } = {}) {
  const { state, concept, replacedDigest } = readStateAndConcept(topicSlug, conceptSlug);
  const band = performanceBand(score, max);
  const change = applyBand(concept, band, date);
  const nextState = `${JSON.stringify(state, null, 2)}\n`;
  const staging = mkdtempSync(join(tmpdir(), `studydeck-render-${topicSlug}-`));

  try {
    writeFileSync(join(staging, 'state.json'), nextState);
    const render = await renderTopic(topicSlug, { ...renderOptions, dir: staging });
    if (!render.ok) throw new Error(`render.mjs rejected the state update: ${render.output}`);
    const map = readFileSync(join(staging, 'knowledge-map.md'), 'utf8');
    return {
      band,
      concept_slug: conceptSlug,
      ...change,
      practice_date: date,
      state: nextState,
      map,
      state_digest: digest(nextState),
      // The bytes this update replaces: the state.json.bak it is about to leave behind.
      replaced_digest: replacedDigest,
      map_digest: digest(map),
      render: render.output,
    };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[mastery] could not remove staging directory ${staging}: ${err.message}`);
    }
  }
}

async function publishStagedUpdate(topicSlug, staged, { onStatePublished, onPublished } = {}) {
  const dir = topicDir(topicSlug);
  // state.json first: it is authoritative; map is the derived value recovery regenerates.
  // The replaced copy is kept as state.json.bak, the one thing `npm run recover` can
  // restore a damaged state.json from. The map needs none: it is rendered from state.
  writeFileAtomicWithBackupSync(join(dir, 'state.json'), staged.state);
  if (onStatePublished) await onStatePublished(staged);
  writeFileAtomicSync(join(dir, 'knowledge-map.md'), staged.map);
  if (onPublished) await onPublished(staged);
}

/** Regenerate the derived map from the live authoritative state under the topic lock. */
export function regenerateKnowledgeMap(topicSlug, renderOptions = {}) {
  return withTopicLock(topicSlug, async () => {
    const dir = topicDir(topicSlug);
    const statePath = join(dir, 'state.json');
    const state = readFileSync(statePath, 'utf8');
    const staging = mkdtempSync(join(tmpdir(), `studydeck-reconcile-${topicSlug}-`));
    try {
      writeFileSync(join(staging, 'state.json'), state);
      const render = await renderTopic(topicSlug, { ...renderOptions, dir: staging });
      if (!render.ok) throw new Error(`render.mjs rejected the state update: ${render.output}`);
      const map = readFileSync(join(staging, 'knowledge-map.md'), 'utf8');
      writeFileAtomicSync(join(dir, 'knowledge-map.md'), map);
      return { map_digest: digest(map), render: render.output };
    } finally {
      try { rmSync(staging, { recursive: true, force: true }); } catch (err) {
        console.warn(`[mastery] could not remove reconciliation staging directory ${staging}: ${err.message}`);
      }
    }
  });
}

/**
 * Record a graded attempt against state.json and re-render the knowledge map.
 *
 * Three things make this transactional enough to trust:
 *   - the whole read → modify → write → render runs under the topic's mutation lock,
 *     so two updates can never interleave and lose one another's concept change;
 *   - each write is atomic (temp + rename), so a crash mid-write cannot leave a
 *     half-written state.json for the next read to degrade into an empty fallback;
 *   - if render.mjs rejects the result, the original bytes — held in memory for the
 *     whole mutation — go back, so a validation failure can never leave state.json and
 *     knowledge-map.md disagreeing.
 *
 * Staging covers the publish itself: nothing is overwritten until the result is known good.
 * The `state.json.bak` that publishStagedUpdate keeps covers what staging cannot, damage
 * after the publish (a foreign writer under rule 4, or the disk), and is what
 * `npm run recover` restores from. It and the `.damaged-*` archives a restore leaves are
 * byte copies beside state.json, git-ignored and never fields in it, so rule 1 holds
 * (backup-restore spec, 2026-11-11).
 *
 * WHY STAGED, rather than write-then-roll-back: once the render is awaited (F13), requests
 * ARE served during it, and /api/state reads state.json without the topic lock. A write
 * published before the render therefore became briefly *observable* — a confidence bump a
 * reader could see and that a rejected render would then take away. Taking the lock on the
 * read path instead would serialise every /api/state behind a render, which is the outage
 * F13 exists to remove. So the mutation is prepared somewhere nobody is looking:
 * render.mjs reads only <dir>/state.json and writes only <dir>/knowledge-map.md (checked,
 * not assumed), so a scratch directory holding one file is a complete input for it.
 *
 * The live tree is touched only after the render has accepted the result, and then by two
 * atomic writes back to back. There is no rollback path any more, because there is nothing
 * to roll back.
 *
 * KNOWN WINDOW, much narrower than before: a crash between the two publishing writes leaves
 * a new state.json with the old knowledge-map.md. Microseconds, versus the render's whole
 * runtime previously — and it still self-heals, because render always regenerates the map
 * from the whole current state, so the next successful mutation fixes it.
 *
 * Two mutations of the same topic still cannot interleave: withTopicLock is a promise chain
 * and has always awaited this callback.
 */
export function applyAttemptToState(topicSlug, conceptSlug, graded, options = {}) {
  return withTopicLock(topicSlug, async () => {
    const { onPrepared, onStatePublished, onPublished, ...renderOptions } = options;
    const staged = await stageAttemptUpdate(topicSlug, conceptSlug, graded, renderOptions);
    // This runs after a staged render accepts but before the authoritative state changes.
    // A crash after it returns leaves a complete transition in attempts.jsonl to reconcile.
    if (onPrepared) await onPrepared(staged);
    await publishStagedUpdate(topicSlug, staged, { onStatePublished, onPublished });
    const { state, map, state_digest, map_digest, replaced_digest, practice_date, ...result } = staged;
    return result;
  });
}

/**
 * Regenerate the knowledge map from state.json, in a child process.
 *
 * Asynchronous deliberately (assessment finding F13). `execFileSync` held the single
 * event loop for the child's ENTIRE runtime, so nothing else was served — not a static
 * asset, not /api/health, which is the one endpoint you would reach for while the cockpit
 * appears hung. Measured with a 5ms interval as the probe, a timer being unable to fire
 * being the definition of the block:
 *
 *   renderTopic, sync            40ms wall, 0 ticks   (today's real render)
 *   applyAttemptToState, sync    57ms wall, 0 ticks
 *   a render rigged to take 2s   2044ms wall, 0 ticks   <- the stall tracks the child 1:1
 *   the same, async              2038ms wall, 363 ticks, max gap 6.0ms
 *
 * So the everyday saving is ~40ms nobody can feel; what this actually removes is the tail,
 * where the ceiling is the 30s timeout below and the whole server is dead for it.
 *
 * The rest of this file's filesystem work stays synchronous on the same evidence, NOT by
 * omission: buildState — the read behind /api/state — blocks for ~2.6ms warm. Converting it
 * would not make it faster (it is syscall-and-CPU work, not waiting), it would only let
 * other requests interleave inside those 2.6ms, at the cost of reworking the temp-then-
 * rename guarantee in atomic.mjs. Re-derive from measurement before reopening that.
 *
 * `dir` is how applyAttemptToState renders a STAGED copy instead of the live tree; it
 * defaults to the topic's own directory, which is what a plain re-render wants. `script`
 * and `timeoutMs` are test seams and nothing else: no request path reaches them, every
 * route goes through applyAttemptToState. They exist so a test can point this at a
 * deliberately slow render and assert the loop keeps ticking — an assertion the real 40ms
 * render is too quick and too variable to make honestly — and so the kill can be proved in
 * a fraction of a second instead of waiting out the real 30s ceiling.
 */
export async function renderTopic(
  topicSlug,
  { dir = topicDir(topicSlug), script = resolveRenderScript(), timeoutMs = RENDER_TIMEOUT_MS } = {},
) {
  if (!script) {
    return { ok: false, output: 'render.mjs not found under .claude/skills — is learn-anything installed?' };
  }
  try {
    // The directory is passed in, never a hardcoded ./.learn/topics/ path: otherwise a run
    // pointed at a different learnRoot writes state.json in one tree and renders the
    // knowledge map in another — a split state spread across two directories.
    const { stdout } = await execFileAsync(process.execPath, [script, dir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: `${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}`.trim() };
  }
}
