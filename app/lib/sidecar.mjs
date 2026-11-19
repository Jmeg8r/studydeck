// WHAT: Read/write the cockpit/ sidecar files that live beside learn-anything's data.
// WHY: learn-anything's validators reject unknown fields, so every cockpit-owned
//      fact (schedule, attempts, cards, reviews) is stored here instead.
//
// Every write goes through lib/atomic.mjs — a reader never observes a half-written file,
// and the last parseable copy of each JSON sidecar is retained as `<name>.bak`.
//
// Append-only records carry a `mutation_id`. A response lost after a successful append
// used to make a retry record the same attempt or review twice; now the second append is
// recognised and skipped. Attempts additionally carry `attempt_id` + `revision`, so an
// attempt can be revised (a self-graded item finalised later) without mutating history:
// the file keeps every revision, and readers see only the newest one per attempt.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLineSync, readJsonSafe, staleTempFiles, writeJsonAtomicSync } from './atomic.mjs';
import { cockpitDir } from './learn.mjs';

const SCHEDULE = 'schedule.json';
const ATTEMPTS = 'attempts.jsonl';
const CARDS = 'cards.json';
const REVIEWS = 'reviews.jsonl';
// Added in M4: where you are in each ON source. Cockpit-owned, like the rest.
const READING = 'reading.json';
// Added in M6: generated fact-check claim sets, and recall sketches for the mind map.
const FACTCHECKS = 'factchecks.json';
const MINDMAPS = 'mindmaps.json';
// Added with the durability pass: what each walk debrief produced, so a retried
// submission replays instead of creating a second note and a second set of cards.
const DEBRIEFS = 'debriefs.jsonl';
// Every external write begins here before it crosses the process boundary. Its newest
// revision is the recovery authority: a completed row replays stored truth, while an
// unresolved row is deliberately visible rather than retried into a duplicate object.
const OPERATIONS = 'operations.jsonl';
// Added with the stage-completion pass: when you marked a study stage done, and when you
// walked that back. The calendar is a not-before date; only these events mean "done".
const STAGES = 'stages.jsonl';
// Learner characterizations of high-confidence errors. They reference attempts rather
// than copying answers, so correction/repair history stays append-only and auditable.
const MISCONCEPTIONS = 'misconceptions.jsonl';
// Durable learner-owned practice evidence and explicit answer reveals. This is deliberately
// separate from attempts: practice may inform reflection but never writes mastery directly.
const PRACTICE = 'practice.jsonl';
// Learner-owned teach-back records. These are observed activity/evidence only; they are
// intentionally not stage events and never write learn-anything mastery directly.
const TEACHBACKS = 'teachbacks.jsonl';
// Role sessions with the Claude API. This file holds OUTCOMES — that a session started
// and closed, what it cost, a confirmed interview summary — and is committed like every
// other sidecar. The conversation itself is in transcripts/, which git ignores: it can
// hold personal goals and answers, and it carries opaque model blocks nobody reads.
const SESSIONS = 'sessions.jsonl';
const TRANSCRIPTS = 'transcripts';
// What the Diagnostician proposed about recorded misses, and what the learner decided
// about each proposal. Hypotheses, not verdicts: nothing reads these into mastery.
const DIAGNOSES = 'diagnoses.jsonl';

const DEFAULT_SCHEDULE = { version: 1, started: null, step_overrides: {}, paused: true };

function ensureDir(slug) {
  const dir = cockpitDir(slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const sidecarPath = (slug, name) => join(cockpitDir(slug), name);

/**
 * Read a JSON sidecar, recovering from `<name>.bak` when the primary is corrupt.
 *
 * Loud, not silent: a corrupt sidecar is a real problem worth seeing, but it must not
 * blank out the whole cockpit. `/api/health` reports the same facts structurally, since
 * a terminal log line is invisible to someone using the browser UI.
 */
function readJson(slug, name, fallback) {
  const { value, source, error } = readJsonSafe(sidecarPath(slug, name), fallback);
  if (source === 'backup') {
    console.error(`[sidecar] ${slug}/${name} was unreadable (${error}) — recovered from ${name}.bak`);
  } else if (source === 'fallback') {
    console.error(`[sidecar] ${slug}/${name} is unreadable and has no usable backup: ${error}`);
  }
  return value;
}

function writeJson(slug, name, value) {
  ensureDir(slug);
  writeJsonAtomicSync(sidecarPath(slug, name), value);
}

/**
 * A JSONL sidecar that exists but can't be read. The message names the file and the
 * errno code only: it reaches the browser as a 500 body, so the absolute path stays in
 * the server log (jsonl-damage spec concern 3).
 */
function jsonlDamage(name, err) {
  return Object.assign(new Error(`${name} is unreadable (${err.code})`, { cause: err }), {
    status: 500, code: err.code, file: name,
  });
}

/**
 * Read a JSON Lines file, skipping unparseable lines.
 * Append-only by design: a bad line loses one record, never the history.
 *
 * Only ENOENT means "never written" (`missing: true`). Any other read error throws
 * jsonlDamage: existsSync said no on EACCES too, so damage used to read as empty history.
 */
function readJsonlDetailed(slug, name) {
  const path = sidecarPath(slug, name);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rows: [], skipped: 0, missing: true };
    console.error(`[sidecar] ${slug}/${name} is unreadable`, err);
    throw jsonlDamage(name, err);
  }

  const rows = [];
  let skipped = 0;
  for (const [i, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
      console.error(`[sidecar] ${slug}/${name}:${i + 1} is not valid JSON — skipped`);
    }
  }
  return { rows, skipped };
}

const readJsonl = (slug, name) => readJsonlDetailed(slug, name).rows;

/**
 * Append one record unless its `mutation_id` is already on file.
 *
 * Returns the stored record. A recognised replay comes back flagged `duplicate: true`
 * rather than as an error — the caller's request DID succeed, just not this time.
 */
function appendUnique(slug, name, record) {
  ensureDir(slug);
  if (record.mutation_id) {
    // Must stay before appendLineSync: a damaged file throws here, so no append runs
    // without a replay check (rule 9; jsonl-damage spec R3).
    const existing = readJsonl(slug, name).find((r) => r.mutation_id === record.mutation_id);
    if (existing) return { ...existing, duplicate: true };
  }
  appendLineSync(sidecarPath(slug, name), JSON.stringify(record));
  return record;
}

export function readSchedule(slug) {
  return { ...DEFAULT_SCHEDULE, ...readJson(slug, SCHEDULE, {}) };
}

export function writeSchedule(slug, schedule) {
  writeJson(slug, SCHEDULE, schedule);
}

/**
 * Collapse the raw attempt log into the current view of history.
 *
 * Two rules, applied in file order:
 *   - a repeated `mutation_id` is a retry of an append that already landed — first wins;
 *   - records sharing an `attempt_id` are revisions of one attempt — highest revision
 *     wins, and it keeps the position of the original so history stays chronological.
 *
 * Records predating both fields (everything written before this pass) have neither, so
 * they are passed through untouched, one entry each.
 */
export function foldAttempts(rows) {
  const seenMutations = new Set();
  const byKey = new Map();
  const order = [];

  for (const [i, row] of rows.entries()) {
    if (row.mutation_id) {
      if (seenMutations.has(row.mutation_id)) continue;
      seenMutations.add(row.mutation_id);
    }

    // A legacy row is keyed by a fresh Symbol rather than a stringified index: a string
    // key could in principle equal some future attempt_id and fold two unrelated rows.
    const key = row.attempt_id ?? Symbol(`legacy-${i}`);
    const current = byKey.get(key);
    if (!current) order.push(key);
    if (!current || (Number(row.revision) || 0) >= (Number(current.revision) || 0)) {
      byKey.set(key, row);
    }
  }

  return order.map((key) => byKey.get(key));
}

/** History as every reader should see it: deduplicated, newest revision per attempt. */
export const readAttempts = (slug) => foldAttempts(readJsonl(slug, ATTEMPTS));

/** Legacy rows predate assessment states and remain final; new model proposals do not. */
export const isFinalAttempt = (attempt) => !attempt.status || attempt.status === 'final';

/**
 * A final attempt whose mastery update is still owed and recoverable.
 *
 * `mastery_applied: false` alone is not enough. A fact-check never settles (it only makes
 * cards), an attempt with no concept has nothing to settle (settleMastery's own guard),
 * and an ambiguous settlement is owed but deliberately not retried: it is counted
 * separately. Counting any of those here put a permanent false alarm on health.
 */
export const owesMastery = (attempt) => isFinalAttempt(attempt) && attempt.mastery_applied === false
  && Boolean(attempt.concept_slug) && attempt.kind !== 'factcheck'
  && attempt.mastery_settlement?.stage !== 'ambiguous';

/**
 * A final fact-check whose corrective cards were never created. Cards are the second
 * durable effect after adjudication, so a crash between the two leaves this owed; making
 * them is idempotent (cards dedupe on source_ref), so finishing it can never duplicate.
 */
export const owesFactcheckCards = (attempt) => attempt.kind === 'factcheck' && isFinalAttempt(attempt)
  && Boolean(attempt.factcheck_proposal && attempt.factcheck_adjudication)
  && attempt.factcheck_cards?.status !== 'complete';

/** The unfolded log. For diagnostics and replay checks only — never for stats. */
export const readAttemptsRaw = (slug) => readJsonl(slug, ATTEMPTS);

export const readReviews = (slug) => readJsonl(slug, REVIEWS);
export const readCards = (slug) => readJson(slug, CARDS, []);

export const appendAttempt = (slug, attempt) => appendUnique(slug, ATTEMPTS, attempt);
export const appendReview = (slug, review) => appendUnique(slug, REVIEWS, review);

/** One attempt by id, at its newest revision. */
export function findAttempt(slug, attemptId) {
  return readAttempts(slug).find((a) => a.attempt_id === attemptId) ?? null;
}

export function writeCards(slug, cards) {
  writeJson(slug, CARDS, cards);
}

/** What each walk debrief produced. Keyed by mutation_id for replay. */
export const readDebriefs = (slug) => readJsonl(slug, DEBRIEFS);
export const appendDebrief = (slug, entry) => appendUnique(slug, DEBRIEFS, entry);

export function findDebriefByMutation(slug, mutationId) {
  if (!mutationId) return null;
  return readDebriefs(slug).find((d) => d.mutation_id === mutationId) ?? null;
}

/** Collapse append-only external-operation revisions to their newest durable state. */
export function foldOperations(rows) {
  const byId = new Map();
  const order = [];
  for (const row of rows) {
    if (!row?.operation_id) continue;
    if (!byId.has(row.operation_id)) order.push(row.operation_id);
    const current = byId.get(row.operation_id);
    if (!current || (Number(row.revision) || 0) >= (Number(current.revision) || 0)) {
      byId.set(row.operation_id, row);
    }
  }
  return order.map((id) => byId.get(id));
}

export const readOperationsRaw = (slug) => readJsonl(slug, OPERATIONS);
export const readOperations = (slug) => foldOperations(readOperationsRaw(slug));
export const appendOperation = (slug, operation) => appendUnique(slug, OPERATIONS, operation);

/**
 * Prepared: the request may have been sent. Ambiguous: it was, and the answer was lost.
 * Either way the outcome is unconfirmed, and the cockpit will not repeat it on its own.
 */
export const isUnresolvedOperation = (operation) => operation.stage === 'prepared' || operation.stage === 'ambiguous';

/** The originating browser mutation is stable across every operation revision. */
export function findOperationByMutation(slug, mutationId, kind = null) {
  if (!mutationId) return null;
  return readOperations(slug).find((operation) => operation.origin_mutation_id === mutationId
    && (!kind || operation.kind === kind)) ?? null;
}

/** Stage completion/undo events. Folded by lib/stages.mjs, never mutated in place. */
export const readStageEvents = (slug) => readJsonl(slug, STAGES);
export const appendStageEvent = (slug, event) => appendUnique(slug, STAGES, event);

export const readMisconceptionEvents = (slug) => readJsonl(slug, MISCONCEPTIONS);
export const appendMisconceptionEvent = (slug, event) => appendUnique(slug, MISCONCEPTIONS, event);

/** Practice evidence and answer reveals are append-only and replay-safe by mutation id. */
export const readPracticeEvents = (slug) => readJsonl(slug, PRACTICE);
export const appendPracticeEvent = (slug, event) => appendUnique(slug, PRACTICE, event);

/** Teach-back records are append-only and replay-safe by mutation id. */
export const readTeachbackEvents = (slug) => readJsonl(slug, TEACHBACKS);
export const appendTeachbackEvent = (slug, event) => appendUnique(slug, TEACHBACKS, event);

/** A solution stays readable only after this durable, topic- and artifact-specific event. */
export function hasPracticeReveal(slug, conceptSlug, artifactFile) {
  return readPracticeEvents(slug).some((event) => event?.event_type === 'answer_revealed'
    && event.concept_slug === conceptSlug && event.artifact_file === artifactFile);
}

/** Any answer reveal for the concept disqualifies a later claim of independent near transfer. */
export function hasPracticeAnswerRevealForConcept(slug, conceptSlug) {
  return readPracticeEvents(slug).some((event) => event?.event_type === 'answer_revealed'
    && event.concept_slug === conceptSlug);
}

/** Generated fact-check claim sets, keyed by `<source_id>#<section>`. */
export const readSessionEvents = (slug) => readJsonl(slug, SESSIONS);
export const appendSessionEvent = (slug, event) => appendUnique(slug, SESSIONS, event);

export const readDiagnosisEvents = (slug) => readJsonl(slug, DIAGNOSES);
export const appendDiagnosisEvent = (slug, event) => appendUnique(slug, DIAGNOSES, event);

const transcriptName = (sessionId) => join(TRANSCRIPTS, `${sessionId}.jsonl`);

/**
 * One session's transcript: a header line, then one line per turn.
 *
 * `sessionId` becomes part of a path. Callers validate it as a UUID first.
 */
export const readTranscript = (slug, sessionId) => readJsonl(slug, transcriptName(sessionId));

export function appendTranscript(slug, sessionId, line) {
  const dir = join(ensureDir(slug), TRANSCRIPTS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendLineSync(sidecarPath(slug, transcriptName(sessionId)), JSON.stringify(line));
}

export const readFactChecks = (slug) => readJson(slug, FACTCHECKS, {});

export function writeFactChecks(slug, all) {
  writeJson(slug, FACTCHECKS, all);
}

/** Mind-map recall runs: which concepts were recalled from memory, and when. */
export const readMindMaps = (slug) => readJson(slug, MINDMAPS, []);

export function writeMindMaps(slug, runs) {
  writeJson(slug, MINDMAPS, runs);
}

/** Reading positions, keyed by ON source id: { position: 0..1, updated }. */
export const readReading = (slug) => readJson(slug, READING, {});

export function writeReadingPosition(slug, sourceId, position, meta = {}) {
  const all = readReading(slug);
  all[sourceId] = {
    // Clamped: a stray value here would silently break scroll restore later.
    position: Math.min(1, Math.max(0, Number(position) || 0)),
    updated: new Date().toISOString(),
    ...meta,
  };
  writeJson(slug, READING, all);
  return all[sourceId];
}

/** Every JSON sidecar. Health, verify and `npm run recover` all read this one list. */
export const JSON_SIDECARS = [SCHEDULE, CARDS, READING, FACTCHECKS, MINDMAPS];
const JSONL_SIDECARS = [ATTEMPTS, REVIEWS, DEBRIEFS, OPERATIONS, STAGES, MISCONCEPTIONS, PRACTICE, TEACHBACKS, SESSIONS, DIAGNOSES];

/**
 * Integrity of one topic's sidecars, for `/api/health`.
 *
 * Re-reads rather than reporting a cached status: a health check that trusts whatever
 * the last request happened to load would go stale exactly when it matters. The files
 * are a few KB each, so this is cheap.
 */
export function inspectSidecars(slug) {
  const files = [];

  for (const name of JSON_SIDECARS) {
    // The reader decides, not existsSync: existsSync also says no on EACCES, which would
    // drop an unreachable file from the report instead of flagging it.
    const { source, error } = readJsonSafe(sidecarPath(slug, name), null);
    if (source === 'missing') continue;
    files.push({ file: name, source, error });
  }

  let attemptRows = [];
  let operationRows = [];
  for (const name of JSONL_SIDECARS) {
    // Same rule as the JSON loop: the reader decides, and damage is listed, not thrown —
    // health is the one route that must still answer when a sidecar can't be read.
    let read;
    try {
      read = readJsonlDetailed(slug, name);
    } catch (err) {
      if (!err.file) throw err;
      files.push({ file: name, source: 'fallback', error: err.message, code: err.code });
      continue;
    }
    if (read.missing) continue;
    const { rows, skipped } = read;
    // Reused below rather than re-read: the loop has already parsed this file.
    if (name === ATTEMPTS) attemptRows = rows;
    if (name === OPERATIONS) operationRows = rows;
    files.push({ file: name, source: 'primary', error: null, records: rows.length, skipped_lines: skipped });
  }

  const folded = foldAttempts(attemptRows);
  const operations = foldOperations(operationRows);
  const unresolved = operations.filter(isUnresolvedOperation);

  return {
    files,
    // A file recovered from backup, or lost entirely, is the signal worth acting on.
    degraded: files.filter((f) => f.source === 'backup' || f.source === 'fallback').map((f) => f.file),
    unparseable_lines: files.reduce((n, f) => n + (f.skipped_lines ?? 0), 0),
    // Left behind only by a write that died between temp file and rename.
    stale_temp_files: staleTempFiles(cockpitDir(slug)),
    attempts: {
      records: attemptRows.length,
      // A gap means replays or revisions were folded away — expected, not an error.
      distinct: folded.length,
      // Recorded and revealed, but its self-checked items were never marked, so mastery
      // never moved for it. Not an error — it just stays owed, and nothing else in the UI
      // would ever say so.
      pending_self_grade: folded.filter((a) => a.status === 'pending_self_grade').length,
      // A genuine partial commit: the attempt is complete but its mastery update did not
      // land (a rejected render, or the topic lock held by another process). Resubmitting
      // the same mutation id finishes it; this is how you find out one is waiting.
      mastery_unapplied: folded.filter(owesMastery).length,
      // A prepared row tells recovery exactly which state transition may still be safely
      // completed. Ambiguous is deliberately separate: it blocks automatic mastery until
      // the learner reconciles the authoritative state rather than guessing at a bump.
      mastery_prepared: folded.filter((a) => a.mastery_settlement?.stage === 'prepared').length,
      mastery_ambiguous: folded.filter((a) => a.mastery_settlement?.stage === 'ambiguous').length,
      factcheck_cards_owed: folded.filter(owesFactcheckCards).length,
    },
    operations: {
      records: operationRows.length,
      distinct: operations.length,
      unresolved: unresolved.length,
      // Listed, not just counted: the learner has to find each one in Open Notebook before
      // repeating it, and a count gives them nothing to look for.
      unresolved_list: unresolved.map((operation) => ({
        operation_id: operation.operation_id,
        kind: operation.kind,
        stage: operation.stage,
        ts: operation.ts ?? null,
        label: operation.local_result?.note_title ?? operation.local_result?.episode_name
          ?? operation.local_result?.title ?? operation.operation_id,
      })),
    },
  };
}
