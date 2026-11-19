import { cachedSourceSearch } from './lib/sourcesearch.mjs';
// WHAT: The StudyDeck cockpit's request handler — every route, Node stdlib only.
// WHY: Zero dependencies matches this repo's from-scratch ethos and means there is
//      no supply chain to audit for a tool that reads personal learning data.
//      No auth, no cloud, no telemetry. 127.0.0.1 keeps other machines out; keeping other
//      TABS out is lib/guard.mjs, applied to every request below.
//
//      This module deliberately does NOT listen. server.mjs owns the socket, so a
//      test can import the handler, attach it to its own server on an ephemeral
//      port, and drive real HTTP — importing this file used to bind port 4310,
//      which is why route-level tests did not exist (assessment finding F6).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config, configSummary } from './lib/config.mjs';
import { assertBrowserBoundary, SECURITY_HEADERS } from './lib/guard.mjs';
import { pipeFile, pipeStream } from './lib/stream.mjs';
import { sendLocalMedia } from './lib/localmedia.mjs';
import { buildState } from './lib/derive.mjs';
import { createStudyNotebook } from './lib/notebooks.mjs';
import { addSource } from './lib/sourcecreate.mjs';
import {
  cockpitDir, isPracticeArtifactFilename, isProtectedPracticeArtifact,
  listDecks, readDeck, readPracticeArtifact, readTopicState,
} from './lib/learn.mjs';
import { gradeDeck, stripAnswers } from './lib/grading.mjs';
import { applyAttemptToState } from './lib/mastery.mjs';
import { syncCardsFromAttempts } from './lib/cards.mjs';
import {
  appendAttempt, appendDebrief, appendMisconceptionEvent, appendOperation, appendPracticeEvent, appendReview, appendStageEvent,
  appendTeachbackEvent,
  findAttempt, findDebriefByMutation, findOperationByMutation, hasPracticeAnswerRevealForConcept, hasPracticeReveal,
  inspectSidecars, isFinalAttempt, isUnresolvedOperation, owesFactcheckCards, owesMastery,
  readAttempts, readAttemptsRaw, readCards, readFactChecks, readMisconceptionEvents, readOperations,
  readSchedule, readStageEvents, writeCards, writeReadingPosition, writeSchedule,
} from './lib/sidecar.mjs';
import { CHECKABLE_KINDS, projectAttempt, projectOperation, recoveryList } from './lib/recovery.mjs';
import { lockStatus } from './lib/lock.mjs';
import { MILESTONES, todayISO } from './lib/schedule.mjs';
import { foldStageEvents, reanchorOverrides, stageStatesFor } from './lib/stages.mjs';
import {
  createNote, createSpeakerProfile, deleteEpisode, episodeAudio, generatePodcast,
  health as onHealth, listEpisodes, listNotes, listSources, listSpeakerProfiles, notebookForTopic,
  podcastJob, podcastPreflight, podcastStatus, readSource,
} from './lib/opennotebook.mjs';
import { listVoices } from './lib/tts.mjs';
import { probeWorkerPickup, stuckCanaryRows } from './lib/workerhealth.mjs';
import { chapterName, dryRunReport, episodeNameFor, matchRendition, planRetry, sourceTag } from './lib/podcastbatch.mjs';
import { ACTIVE_JOB_STATUSES, isActiveJobStatus } from './lib/podcastjob.mjs';
import { MAX_BODY_BYTES, MAX_SKETCH_BYTES } from './lib/limits.mjs';
import { listVideos, resolveVideo } from './lib/videos.mjs';
import { videoService } from './lib/videogeneration.mjs';
import { higgsfieldService } from './lib/higgsfield.mjs';
import {
  adjudicateRun, cardsFromAdjudication, generateClaims, getClaims, proposeRun,
  stripAllClaimAnswers, stripClaimAnswers,
} from './lib/factcheck.mjs';
import { diffNote, recordRun, trueMap } from './lib/mindmap.mjs';
import { buildDebriefCards, shortDebriefId } from './lib/debrief.mjs';
import { shareInFlight } from './lib/inflight.mjs';
import { healUnappliedMastery, settleMastery } from './lib/settlement.mjs';
import { cardsFromDebrief, gradeEssay, health as ollamaHealth } from './lib/ollama.mjs';
import { health as claudeHealth } from './lib/claude.mjs';
import { ROLE_LIMITS } from './lib/roles.mjs';
import { decideHypothesis, listDiagnoses, runDiagnosis } from './lib/diagnosis.mjs';
import {
  BACK_ORIGINS, closeSession, createSessionCards, draftSessionCard, draftSummary, getSession, listSessions, reviseSummary,
  resumeSession, sendTurn, startSession,
} from './lib/sessions.mjs';
import {
  EVIDENCE_POLICY, finalizeRetrievalEvidence, isConfidenceBand, misconceptionCandidates, retrievalEvidenceForQuiz,
} from './lib/evidence.mjs';
import {
  assertArray, assertFilename, assertFiniteNumber, assertIdentifier, assertInteger,
  assertKnownTopic, assertPlainObject, assertString, optionalString,
} from './lib/validation.mjs';
import {
  listRenditions, prepareRendition, publishRendition, readRendition, renditionDir, renderSummary, resumeRendition,
} from './lib/podcastrender.mjs';
import { PRACTICE_VOCABULARY, qualificationForPracticeEvidence } from './lib/practice.mjs';
import { TEACHBACK_VOCABULARY, qualificationForTeachback } from './lib/teachback.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', // repo assets under web/ only — UPLOADED svg is refused, see guard.mjs
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

/**
 * How much of a REFUSED body we will read and throw away before hanging up.
 *
 * Discarding is not buffering — the bytes are dropped as they arrive, so this is not a
 * second memory ceiling and does not weaken `MAX_BODY_BYTES`. It bounds patience, not
 * memory: a client that keeps sending after a refusal is not owed an open socket forever.
 */
const MAX_DISCARD_BYTES = 8 * 1024 * 1024;

/**
 * Throw away the rest of a request body we refused to read, then let the connection close
 * on its own terms.
 *
 * Why not `req.destroy()`: destroying sends a TCP RST, and an RST discards whatever the
 * peer has not yet read — including a response already written. Doing it on `res.on
 * ('finish')` looks safe and is not, because `finish` means "handed to the socket", never
 * "the client read it". The client is also still uploading, so it takes an EPIPE on the
 * write side at the same moment. Measured on the 413 path: **17 of 200 refusals never
 * reached the client**, split between EPIPE and ECONNRESET — a refusal indistinguishable
 * from the network dropping, which is the exact failure #21 set out to remove and did not.
 *
 * Draining instead keeps the socket healthy in both directions: the client finishes its
 * upload, reads the refusal, and the connection ends normally. The cap is what keeps that
 * from being an open-ended promise.
 */
function discardBody(req) {
  let discarded = 0;
  req.on('data', (chunk) => {
    discarded += chunk.length;
    if (discarded > MAX_DISCARD_BYTES) req.destroy();
  });
  req.resume();
}

/**
 * The replay key for a mutation.
 *
 * A client that sends the same id twice — the usual cause being a response lost after
 * the write already landed, and the user clicking again — gets the first result back
 * instead of a second record.
 *
 * REQUIRED on every appending route, and a 400 when it is missing. It used to fall back to
 * a fresh UUID, which reads as tolerant and is worse than no protection: every request
 * became unique by construction, so `appendUnique` ran on each one and deduplicated
 * nothing. Three views relied on that fallback and none of them had working replay
 * protection — a double-clicked flashcard review could be logged twice, lengthening the
 * interval of a card whose rung is its consecutive-hit streak. A route cannot tell a
 * missing id from a client that simply never retries, so the only way the guarantee is
 * real is to refuse the request that cannot be protected.
 *
 * Routes that merely SET a value (`/api/schedule/start`, `/pause`, `/api/reading`, the
 * card suspend toggle) still carry none, and `/api/cards/sync` is idempotent by
 * `source_ref` rather than by id — see rule 9.
 */
function mutationId(body) {
  try {
    return assertIdentifier(body.mutation_id, 'mutation_id', { max: 300 });
  } catch {
    throw Object.assign(
      new Error('mutation_id is required: mint one per action and reuse it until it succeeds'),
      { status: 400 },
    );
  }
}

/** A stable identity lets an interrupted note write be reconciled without re-posting it. */
const noteIdentity = (topicSlug, mutation) => createHash('sha256')
  .update(`${topicSlug}\0${mutation}`)
  .digest('hex');

const noteInputHash = (notebookId, title, content) => createHash('sha256')
  .update(JSON.stringify({ notebook_id: notebookId, title, content }))
  .digest('hex');

function newNoteOperation(topicSlug, notebookId, mutation, inputHash, title) {
  const identity = noteIdentity(topicSlug, mutation);
  // ON does not expose an idempotency key. Keep the marker in its title so a later list
  // call can identify a note whose POST succeeded but whose response was lost.
  const noteTitle = `${title} [StudyDeck ${identity.slice(0, 12)}]`;
  return appendOperation(topicSlug, {
    operation_id: `open-notebook-note-${identity}`,
    origin_mutation_id: mutation,
    mutation_id: `${mutation}:note:started`,
    revision: 0,
    ts: new Date().toISOString(),
    kind: 'open_notebook_note',
    topic_slug: topicSlug,
    input_hash: inputHash,
    stage: 'started',
    local_result: { notebook_id: notebookId, note_title: noteTitle },
  });
}

function reviseNoteOperation(topicSlug, operation, changes) {
  const revision = (Number(operation.revision) || 0) + 1;
  return appendOperation(topicSlug, {
    ...operation,
    ...changes,
    revision,
    ts: new Date().toISOString(),
    mutation_id: `${operation.origin_mutation_id}:note:${revision}:${changes.stage ?? operation.stage}`,
    local_result: { ...(operation.local_result ?? {}), ...(changes.local_result ?? {}) },
  });
}

/**
 * The one note whose title carries this operation's marker, or null. The marker is unique
 * per learner action, so two matches mean a duplicate already exists: completing against
 * either would hide it, so the operation stays ambiguous.
 */
async function markedNote(notebookId, noteTitle) {
  if (!noteTitle) return null;
  const matches = (await listNotes(notebookId)).filter((candidate) => candidate.title === noteTitle);
  return matches.length === 1 && matches[0].id ? matches[0] : null;
}

async function reconcileNoteOperation(topicSlug, notebookId, operation) {
  const note = await markedNote(notebookId, operation.local_result?.note_title);
  if (!note) return null;
  return reviseNoteOperation(topicSlug, operation, {
    stage: 'complete', external: { note_id: note.id }, error: null,
  });
}

function newMindmapNoteOperation(topicSlug, notebookId, mutation, run, missed) {
  const identity = noteIdentity(topicSlug, mutation);
  const noteTitle = `Mind map diff — ${run.ts.slice(0, 10)} [StudyDeck ${identity.slice(0, 12)}]`;
  return appendOperation(topicSlug, {
    operation_id: `mindmap-note-${identity}`,
    origin_mutation_id: mutation,
    mutation_id: `${mutation}:mindmap-note:started`,
    revision: 0,
    ts: new Date().toISOString(),
    kind: 'mindmap_note',
    topic_slug: topicSlug,
    input_hash: createHash('sha256').update(JSON.stringify({
      notebook_id: notebookId, run_ts: run.ts, recalled: run.recalled, missed: missed.map((concept) => concept.slug),
    })).digest('hex'),
    stage: 'started',
    local_result: { mindmap_ts: run.ts, note_title: noteTitle },
  });
}

function reviseMindmapNoteOperation(topicSlug, operation, changes) {
  const revision = (Number(operation.revision) || 0) + 1;
  return appendOperation(topicSlug, {
    ...operation,
    ...changes,
    revision,
    ts: new Date().toISOString(),
    mutation_id: `${operation.origin_mutation_id}:mindmap-note:${revision}:${changes.stage ?? operation.stage}`,
    local_result: { ...(operation.local_result ?? {}), ...(changes.local_result ?? {}) },
  });
}

async function reconcileMindmapNoteOperation(topicSlug, notebookId, operation) {
  const note = await markedNote(notebookId, operation.local_result?.note_title);
  if (!note) return null;
  return reviseMindmapNoteOperation(topicSlug, operation, {
    stage: 'complete', external: { note_id: note.id }, error: null,
  });
}

async function writeMindmapNote(topicSlug, notebookId, mutation, run, missed, total, operation = null) {
  let current = operation ?? newMindmapNoteOperation(topicSlug, notebookId, mutation, run, missed);
  if (current.stage === 'complete') return { operation: current, note: { id: current.external.note_id }, noteError: null };
  if (current.stage === 'prepared' || current.stage === 'ambiguous') {
    const reconciled = await reconcileMindmapNoteOperation(topicSlug, notebookId, current);
    if (reconciled) return { operation: reconciled, note: { id: reconciled.external.note_id }, noteError: null };
    return {
      operation: current, note: null,
      noteError: 'the previous Open Notebook note outcome is ambiguous; inspect recovery before retrying it',
    };
  }

  current = reviseMindmapNoteOperation(topicSlug, current, { stage: 'prepared' });
  try {
    const note = await createNote({
      notebookId, title: current.local_result.note_title, content: diffNote(topicSlug, run, missed, total),
    });
    if (!note?.id) throw Object.assign(new Error('Open Notebook created a note without an id'), { status: 503 });
    current = reviseMindmapNoteOperation(topicSlug, current, {
      stage: 'complete', external: { note_id: note.id }, error: null,
    });
    return { operation: current, note: { id: note.id }, noteError: null };
  } catch (err) {
    const knownFailure = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
    current = reviseMindmapNoteOperation(topicSlug, current, {
      stage: knownFailure ? 'failed_known' : 'ambiguous',
      error: { classification: knownFailure ? 'open_notebook_note_rejected' : 'open_notebook_note_outcome_unknown' },
    });
    return { operation: current, note: null, noteError: err.message };
  }
}

function sameSpeakerProfile(profile, intent) {
  if (!profile || profile.name !== intent.name || profile.description !== intent.description) return false;
  if (!Array.isArray(profile.speakers) || profile.speakers.length !== intent.speakers.length) return false;
  return profile.speakers.every((speaker, index) => {
    const wanted = intent.speakers[index];
    return speaker.name === wanted.name
      && speaker.voice_id === wanted.voice_id
      && (speaker.backstory ?? '') === wanted.backstory
      && (speaker.personality ?? '') === wanted.personality;
  });
}

async function findSpeakerProfile(intent) {
  return (await listSpeakerProfiles()).find((profile) => sameSpeakerProfile(profile, intent)) ?? null;
}

const podcastOperationIdentity = (topicSlug, mutation, sourceId) => createHash('sha256')
  .update(`${topicSlug}\0${mutation}\0${sourceId}`)
  .digest('hex');

/** A child operation at one of these stages replays or settles without another generate. */
const PODCAST_SENT_STAGES = new Set(['complete', 'prepared', 'ambiguous']);

function podcastOperationFor(topicSlug, mutation, sourceId) {
  const identity = podcastOperationIdentity(topicSlug, mutation, sourceId);
  return readOperations(topicSlug).find((operation) => operation.operation_id === `podcast-episode-${identity}`) ?? null;
}

function revisePodcastOperation(topicSlug, operation, changes) {
  const revision = (Number(operation.revision) || 0) + 1;
  return appendOperation(topicSlug, {
    ...operation,
    ...changes,
    revision,
    ts: new Date().toISOString(),
    mutation_id: `${operation.origin_mutation_id}:podcast:${operation.local_result.source_id}:${revision}:${changes.stage ?? operation.stage}`,
    local_result: { ...(operation.local_result ?? {}), ...(changes.local_result ?? {}) },
  });
}

/**
 * Settle a sent podcast request by its rendition name: exactly one listed episode with that
 * name completes it. A chapter name without a rendition never matches (matchRendition), so
 * an older recording of the same chapter cannot answer for this request.
 */
async function reconcilePodcastEpisode(topicSlug, operation, episodeName = operation.local_result?.episode_name) {
  const episode = matchRendition(await listEpisodes(), episodeName);
  if (!episode) return null;
  return revisePodcastOperation(topicSlug, operation, {
    stage: 'complete', external: { ...(operation.external ?? {}), episode_id: episode.id, status: episode.status ?? null }, error: null,
  });
}

const podcastEpisodesInFlight = new Map();

async function runPodcastEpisodeOperation({ topicSlug, mutation, source, episodeProfile, speakerProfile, briefingSuffix }) {
  const key = `${topicSlug}:${mutation}:${source.id}`;
  const { result } = await shareInFlight(podcastEpisodesInFlight, key, async () => {
    let operation = podcastOperationFor(topicSlug, mutation, source.id);
    // A render recorded before renditions is named for its chapter, and its input_hash
    // covers that name. Replaying under the recorded name lets an accepted render replay;
    // a chapter name still never settles an ambiguous one (matchRendition refuses it).
    if (operation?.local_result?.episode_name === chapterName(source.episode_name)) {
      source = { ...source, episode_name: operation.local_result.episode_name };
    }
    const identity = {
      source_id: source.id, title: source.title, episode_name: source.episode_name,
    };
    const { text } = await readSource(source.id);
    if (!text.trim()) return { ...identity, job_id: null, accepted: false, error: 'source has no text' };
    const inputHash = createHash('sha256').update(JSON.stringify({
      source_id: source.id, episode_name: source.episode_name, episode_profile: episodeProfile,
      speaker_profile: speakerProfile, briefing_suffix: briefingSuffix ?? null, content_hash: sha256(text),
    })).digest('hex');

    if (operation) {
      if (operation.input_hash !== inputHash) {
        return { ...identity, job_id: null, accepted: false, error: 'mutation_id belongs to this source with different generation input' };
      }
      if (operation.stage === 'complete') {
        return { ...identity, job_id: operation.external?.job_id ?? null, status: operation.external?.status ?? null, accepted: true, replayed: true };
      }
      if (operation.stage === 'prepared' || operation.stage === 'ambiguous') {
        const settled = await reconcilePodcastEpisode(topicSlug, operation, source.episode_name);
        if (settled) {
          operation = settled;
          return { ...identity, job_id: operation.external.job_id ?? null, status: operation.external.status, accepted: true, replayed: true };
        }
        return { ...identity, job_id: null, accepted: false, ambiguous: true, error: 'the previous podcast request outcome is ambiguous; inspect recovery before retrying it' };
      }
    } else {
      const opIdentity = podcastOperationIdentity(topicSlug, mutation, source.id);
      operation = appendOperation(topicSlug, {
        operation_id: `podcast-episode-${opIdentity}`,
        origin_mutation_id: mutation,
        mutation_id: `${mutation}:podcast:${source.id}:started`,
        revision: 0,
        ts: new Date().toISOString(),
        kind: 'podcast_episode',
        topic_slug: topicSlug,
        input_hash: inputHash,
        stage: 'started',
        local_result: { source_id: source.id, title: source.title, episode_name: source.episode_name },
      });
    }

    operation = revisePodcastOperation(topicSlug, operation, { stage: 'prepared' });
    try {
      const job = await generatePodcast({
        episodeProfile, speakerProfile, episodeName: source.episode_name, content: text, briefingSuffix,
      });
      operation = revisePodcastOperation(topicSlug, operation, {
        stage: 'complete', external: { job_id: job.job_id, status: job.status }, error: null,
      });
      return { ...identity, job_id: job.job_id, status: job.status, accepted: true };
    } catch (err) {
      const knownFailure = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
      operation = revisePodcastOperation(topicSlug, operation, {
        stage: knownFailure ? 'failed_known' : 'ambiguous',
        error: { classification: knownFailure ? 'podcast_request_rejected' : 'podcast_request_outcome_unknown' },
      });
      return { ...identity, job_id: null, accepted: false, ambiguous: !knownFailure, error: err.message };
    }
  });
  return result;
}

const standalonePodcastInFlight = new Map();

async function runStandalonePodcastOperation({ topicSlug, mutation, notebookId, episodeProfile, speakerProfile, title, renditionName, briefingSuffix }) {
  const { result } = await shareInFlight(standalonePodcastInFlight, `${topicSlug}:${mutation}`, async () => {
    let operation = findOperationByMutation(topicSlug, mutation, 'podcast_standalone');
    // A request recorded before renditions is named with the caller's plain title, and its
    // input_hash covers that name. Replaying under the recorded name lets an accepted
    // request replay; a plain title still never settles an ambiguous one.
    const episodeName = operation?.local_result?.episode_name === title ? title : renditionName;
    const inputHash = createHash('sha256').update(JSON.stringify({
      notebook_id: notebookId, episode_profile: episodeProfile, speaker_profile: speakerProfile,
      episode_name: episodeName, briefing_suffix: briefingSuffix ?? null,
    })).digest('hex');
    if (operation) {
      if (operation.input_hash !== inputHash) {
        return { error: 'mutation_id belongs to a podcast request with different input', status: 409 };
      }
      if (operation.stage === 'complete') {
        return { job_id: operation.external?.job_id ?? null, status: operation.external?.status ?? null, replayed: true };
      }
      if (operation.stage === 'prepared' || operation.stage === 'ambiguous') {
        const settled = await reconcilePodcastEpisode(topicSlug, operation, episodeName);
        if (!settled) {
          return { error: 'the previous podcast request outcome is ambiguous; inspect recovery before retrying it', status: 409 };
        }
        operation = settled;
        return { job_id: operation.external.job_id ?? null, status: operation.external.status, replayed: true };
      }
    }
    // Before anything is written, so a refused profile leaves no operation behind.
    await podcastPreflight({ episodeProfile, speakerProfile });
    if (!operation) {
      const identity = createHash('sha256').update(`${topicSlug}\0${mutation}`).digest('hex');
      operation = appendOperation(topicSlug, {
        operation_id: `podcast-standalone-${identity}`,
        origin_mutation_id: mutation,
        mutation_id: `${mutation}:podcast-standalone:started`,
        revision: 0,
        ts: new Date().toISOString(),
        kind: 'podcast_standalone',
        topic_slug: topicSlug,
        input_hash: inputHash,
        stage: 'started',
        local_result: { source_id: `notebook:${notebookId}`, episode_name: episodeName },
      });
    }

    operation = revisePodcastOperation(topicSlug, operation, { stage: 'prepared' });
    try {
      const job = await generatePodcast({ episodeProfile, speakerProfile, episodeName, notebookId, briefingSuffix });
      operation = revisePodcastOperation(topicSlug, operation, {
        stage: 'complete', external: { job_id: job.job_id, status: job.status }, error: null,
      });
      return { ...job };
    } catch (err) {
      const knownFailure = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
      revisePodcastOperation(topicSlug, operation, {
        stage: knownFailure ? 'failed_known' : 'ambiguous',
        error: { classification: knownFailure ? 'podcast_request_rejected' : 'podcast_request_outcome_unknown' },
      });
      return { error: err.message, status: err.status ?? 503 };
    }
  });
  return result;
}

async function deletePodcastEpisodeOperation(topicSlug, mutation, episode) {
  const identity = createHash('sha256').update(`${topicSlug}\0${mutation}\0delete\0${episode.id}`).digest('hex');
  const operationId = `podcast-delete-${identity}`;
  let operation = readOperations(topicSlug).find((entry) => entry.operation_id === operationId) ?? null;
  if (operation?.stage === 'complete') return { deleted: true };
  if (operation?.stage === 'prepared' || operation?.stage === 'ambiguous') {
    const exists = (await listEpisodes()).some((candidate) => candidate.id === episode.id);
    if (!exists) {
      revisePodcastOperation(topicSlug, operation, { stage: 'complete', error: null });
      return { deleted: true, reconciled: true };
    }
    return { deleted: false, ambiguous: true, error: 'stale episode deletion outcome is ambiguous' };
  }
  if (!operation) {
    operation = appendOperation(topicSlug, {
      operation_id: operationId, origin_mutation_id: mutation,
      mutation_id: `${mutation}:podcast-delete:${episode.id}:started`, revision: 0, ts: new Date().toISOString(),
      kind: 'podcast_delete', topic_slug: topicSlug,
      input_hash: sha256(JSON.stringify({ episode_id: episode.id, name: episode.name })), stage: 'started',
      local_result: { source_id: `episode:${episode.id}`, episode_id: episode.id, episode_name: episode.name },
    });
  }
  operation = revisePodcastOperation(topicSlug, operation, { stage: 'prepared' });
  try {
    await deleteEpisode(episode.id);
    revisePodcastOperation(topicSlug, operation, { stage: 'complete', error: null });
    return { deleted: true };
  } catch (err) {
    if (err.status === 404) {
      const exists = (await listEpisodes()).some((candidate) => candidate.id === episode.id);
      if (!exists) {
        revisePodcastOperation(topicSlug, operation, { stage: 'complete', error: null });
        return { deleted: true, reconciled: true };
      }
    }
    const knownFailure = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
    revisePodcastOperation(topicSlug, operation, {
      stage: knownFailure ? 'failed_known' : 'ambiguous',
      error: { classification: knownFailure ? 'podcast_delete_rejected' : 'podcast_delete_outcome_unknown' },
    });
    return { deleted: false, ambiguous: !knownFailure, error: err.message };
  }
}

/**
 * Read and parse a JSON request body, with a hard size ceiling.
 *
 * Over the ceiling the stream is PAUSED, not destroyed. Destroying here tore the socket
 * down in the same tick the rejection was raised, so the 413 never flushed and the caller
 * saw ECONNRESET instead — a refusal it could not tell apart from the network dropping,
 * and could not explain to the user. The body is discarded instead; see `discardBody`.
 *
 * `resolveBody` rather than `resolve`: the executor's parameter would otherwise shadow
 * node:path's `resolve`, imported at the top of this file.
 */
function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let refused = false;
    const chunks = [];
    req.on('data', (chunk) => {
      // Once refused, this listener must do NOTHING. It stays attached — there is no way
      // to detach it from inside itself without racing the emit — and it used to re-`pause`
      // on every subsequent chunk. That made `discardBody`'s single `resume()` last exactly
      // one chunk, so the drain deadlocked and the request hung until the client gave up.
      // The old `destroy()` hid this perfectly: a drain cannot be seen to stall on a socket
      // that was already torn down.
      if (refused) return;

      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        req.pause();
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolveBody({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(Object.assign(new Error('body is not valid JSON'), { status: 400 }));
      }
      try {
        resolveBody(assertPlainObject(parsed, 'request body', { maxKeys: 500 }));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Percent-decode one URL segment.
 *
 * `decodeURIComponent` throws URIError on a malformed escape (`%`, `%ZZ`, a lone
 * surrogate). Every route here decodes something, so unguarded that turns a malformed
 * request into a 500 — the server reporting its own fault for what is plainly a bad
 * request, and a stack trace in the log for a class of noise that deserves one line.
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error('malformed percent-escape in URL'), { status: 400 });
  }
}

/**
 * Serve a file from app/web.
 *
 * The resolved path is checked against the web root before anything is opened —
 * without that, a request like /../../.env would walk straight out of the app.
 */
function sendStatic(res, urlPath) {
  const relative = normalize(safeDecode(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(config.webDir, `.${relative === '/' ? '/index.html' : relative}`);

  if (filePath !== config.webDir && !filePath.startsWith(config.webDir + sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: 'not found', path: relative });
  }

  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store', // hackable single files — always serve the edit on disk
  });
  pipeFile(res, filePath);
}

/**
 * Deck routes. `/api/decks/:topic/:file` serves a deck with every answer stripped.
 *
 * There is deliberately no dry-run grade route. One used to grade and reveal without
 * writing anything, and the results screen then offered "Record attempt" or "Discard" —
 * so a failed pretest could be revealed, discarded, and retaken with the answers already
 * known. That makes the attempt history incomplete and the pretest baseline worthless.
 * Answers are now revealed only by POST /api/attempts, which records first.
 */
async function handleDeckRoute(req, res, url, segments) {
  const [topicSlug, file, action] = segments;

  if (!knownTopic(topicSlug)) {
    return sendJson(res, 404, { error: 'unknown topic', topic: topicSlug });
  }

  if (!action && req.method === 'GET') {
    // Answer-free by construction — this is what makes a retake an honest measurement.
    return sendJson(res, 200, stripAnswers(readDeck(topicSlug, file)));
  }

  return sendJson(res, 405, { error: 'method not allowed', route: url.pathname });
}

/** Text-only practice preview, constrained to files beneath one mapped concept. */
function handlePracticeRoute(res, segments) {
  const [topicSlug, conceptSlug, file] = segments;
  if (!knownTopic(topicSlug)) return sendJson(res, 404, { error: 'unknown topic', topic: topicSlug });
  // A URL is never a reveal mechanism. Only the dedicated POST can create the durable
  // consent event that makes a conventional solution/answer/hint file readable later.
  if (isPracticeArtifactFilename(file) && isProtectedPracticeArtifact(file)
    && !hasPracticeReveal(topicSlug, conceptSlug, file)) {
    return sendJson(res, 404, { error: 'practice artifact not found' });
  }
  return sendJson(res, 200, readPracticeArtifact(topicSlug, conceptSlug, file, { allowProtected: true }));
}

function practiceChoice(value, name, choices) {
  const selected = assertString(value, name, { max: 40 });
  if (!choices.includes(selected)) {
    throw Object.assign(new Error(`${name} must be one of: ${choices.join(', ')}`), { status: 400 });
  }
  return selected;
}

function optionalPracticeArtifactFile(value) {
  const file = optionalString(value, 'artifact_file', { max: 200 });
  if (file !== null && !isPracticeArtifactFilename(file)) {
    throw Object.assign(new Error('artifact_file has an invalid format'), { status: 400 });
  }
  return file;
}

/** Commit an explicit answer reveal, then and only then return the protected content. */
async function handlePracticeReveal(req, res) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const conceptSlug = assertIdentifier(body.concept_slug, 'concept_slug', {
    max: 150, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  });
  if (!knownConcept(topicSlug, conceptSlug)) {
    return sendJson(res, 400, { error: 'concept_slug must belong to the selected topic' });
  }
  const file = assertString(body.file, 'file', { max: 200 });
  if (!isPracticeArtifactFilename(file)) {
    throw Object.assign(new Error('file has an invalid practice artifact format'), { status: 400 });
  }
  if (!isProtectedPracticeArtifact(file)) {
    throw Object.assign(new Error('only answer-bearing practice artifacts can be revealed'), { status: 400 });
  }
  if (body.confirmed !== true) {
    throw Object.assign(new Error('confirmed must be true before revealing answer-bearing content'), { status: 400 });
  }
  const mutation = mutationId(body);

  // Read safely into server memory first so a missing or unsafe file never produces a
  // false "revealed" history row. No response has been written at this point.
  const artifact = readPracticeArtifact(topicSlug, conceptSlug, file, { allowProtected: true });
  const appended = appendPracticeEvent(topicSlug, {
    ts: new Date().toISOString(),
    event_type: 'answer_revealed',
    topic_slug: topicSlug,
    concept_slug: conceptSlug,
    artifact_file: file,
    confirmed: true,
    mutation_id: mutation,
  });
  const { duplicate, ...event } = appended;
  // The append above is deliberately before this one response that carries content. If it
  // throws, the catch sends only an error, never the artifact held in local memory.
  return sendJson(res, duplicate ? 200 : 201, { event, artifact });
}

/** Record learner-confirmed practice evidence without touching learn-anything state.json. */
async function handlePracticeEvidence(req, res) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const conceptSlug = assertIdentifier(body.concept_slug, 'concept_slug', {
    max: 150, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  });
  if (!knownConcept(topicSlug, conceptSlug)) {
    return sendJson(res, 400, { error: 'concept_slug must belong to the selected topic' });
  }
  const mode = practiceChoice(body.mode, 'mode', PRACTICE_VOCABULARY.modes);
  const outcome = practiceChoice(body.outcome, 'outcome', PRACTICE_VOCABULARY.outcomes);
  const evidenceKind = practiceChoice(body.evidence_kind, 'evidence_kind', PRACTICE_VOCABULARY.evidenceKinds);
  const ownership = practiceChoice(body.ownership, 'ownership', PRACTICE_VOCABULARY.ownership);
  const aiContribution = practiceChoice(body.ai_contribution, 'ai_contribution', PRACTICE_VOCABULARY.aiContributions);
  const hintUse = practiceChoice(body.hint_use, 'hint_use', PRACTICE_VOCABULARY.hintUse);
  const artifactFile = optionalPracticeArtifactFile(body.artifact_file);

  // A positive practice/transfer claim needs its criteria and observable result captured
  // in the same durable event. A rejected activity records the reflection/next action
  // instead of pretending that an unfinished task has evidence behind it.
  const required = outcome === 'confirmed';
  const rubric = required
    ? assertString(body.rubric, 'rubric', { min: 3, max: 2_000 })
    : optionalString(body.rubric, 'rubric', { max: 2_000 });
  const observable = required
    ? assertString(body.observable, 'observable', { min: 3, max: 2_000 })
    : optionalString(body.observable, 'observable', { max: 2_000 });
  const reflection = assertString(body.reflection, 'reflection', { min: 3, max: 2_000 });
  const nextAction = assertString(body.next_action, 'next_action', { min: 3, max: 800 });
  const mutation = mutationId(body);

  if (mode === 'project' && artifactFile === null) {
    throw Object.assign(new Error('artifact_file is required for project-mode evidence'), { status: 400 });
  }
  if (artifactFile !== null) {
    // It is a reference, not content to return. Still resolve it through the same safe
    // reader so a ledger record cannot claim a path outside the mapped exercise root.
    if (isProtectedPracticeArtifact(artifactFile) && !hasPracticeReveal(topicSlug, conceptSlug, artifactFile)) {
      return sendJson(res, 404, { error: 'practice artifact not found' });
    }
    readPracticeArtifact(topicSlug, conceptSlug, artifactFile, { allowProtected: true });
  }

  const answerRevealed = hasPracticeAnswerRevealForConcept(topicSlug, conceptSlug);
  const record = {
    ts: new Date().toISOString(),
    event_type: 'evidence_recorded',
    topic_slug: topicSlug,
    concept_slug: conceptSlug,
    mode,
    outcome,
    evidence_kind: evidenceKind,
    artifact_file: artifactFile,
    rubric,
    observable,
    reflection,
    next_action: nextAction,
    ownership,
    ai_contribution: aiContribution,
    hint_use: hintUse,
    answer_revealed: answerRevealed,
    qualification: null,
    mutation_id: mutation,
  };
  record.qualification = qualificationForPracticeEvidence(record, { answerRevealed });
  const appended = appendPracticeEvent(topicSlug, record);
  const { duplicate, ...event } = appended;
  return sendJson(res, duplicate ? 200 : 201, { event });
}

function teachbackRemediationTarget(topicSlug, value) {
  const target = assertString(value, 'remediation_target', { min: 3, max: 800 });

  // A finite blacklist of vague phrases only teaches callers which wording to evade.
  // Instead, make the handoff a typed, inspectable target. We can verify configured
  // concepts locally; source and criterion references stay inert text because their
  // authority lives outside this cockpit.
  const concept = target.match(/^concept:([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (concept && knownConcept(topicSlug, concept[1])) return `concept:${concept[1]}`;

  const practice = target.match(/^\/learn-practice\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (practice && knownConcept(topicSlug, practice[1])) return `/learn-practice ${practice[1]}`;

  const source = target.match(/^source:([A-Za-z0-9][A-Za-z0-9._:/-]{2,})$/);
  if (source) return `source:${source[1]}`;

  const criterion = target.match(/^criterion:\s*(.+)$/);
  if (criterion) return `criterion: ${assertString(criterion[1], 'remediation criterion', { min: 3, max: 760 })}`;

  throw Object.assign(
    new Error('remediation_target must be source:<id>, criterion:<specific criterion>, concept:<known-concept>, or /learn-practice <known-concept>'),
    { status: 400 },
  );
}

/** Record a teach-back as durable observed activity, never a stage or mastery mutation. */
async function handleTeachback(req, res) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const outcome = practiceChoice(body.outcome, 'outcome', TEACHBACK_VOCABULARY.outcomes);
  const artifactType = practiceChoice(body.artifact_type, 'artifact_type', TEACHBACK_VOCABULARY.artifactTypes);
  const ownership = practiceChoice(body.ownership, 'ownership', TEACHBACK_VOCABULARY.ownership);
  const aiContribution = practiceChoice(body.ai_contribution, 'ai_contribution', TEACHBACK_VOCABULARY.aiContributions);
  const audience = assertString(body.audience, 'audience', { min: 3, max: 500 });
  const artifactReference = assertString(body.artifact_reference, 'artifact_reference', { min: 3, max: 2_000 });
  const questions = assertString(body.questions, 'questions', { min: 3, max: 2_000 });
  const reflection = assertString(body.reflection, 'reflection', { min: 3, max: 2_000 });
  const resultingActions = assertString(body.resulting_actions, 'resulting_actions', { min: 3, max: 2_000 });
  if (typeof body.rubric_predeclared !== 'boolean') {
    throw Object.assign(new Error('rubric_predeclared must be true or false'), { status: 400 });
  }
  if (typeof body.no_gap_found !== 'boolean') {
    throw Object.assign(new Error('no_gap_found must be true or false'), { status: 400 });
  }

  const rubric = body.rubric_predeclared
    ? assertString(body.rubric, 'rubric', { min: 3, max: 2_000 })
    : optionalString(body.rubric, 'rubric', { max: 2_000 });
  const rubricReference = body.rubric_predeclared
    ? assertString(body.rubric_reference, 'rubric_reference', { min: 3, max: 2_000 })
    : optionalString(body.rubric_reference, 'rubric_reference', { max: 2_000 });
  const observable = optionalString(body.observable, 'observable', { max: 2_000 });
  const gaps = body.no_gap_found
    ? optionalString(body.gaps, 'gaps', { max: 2_000 })
    : assertString(body.gaps, 'gaps', { min: 3, max: 2_000 });
  const requestedRemediationTarget = optionalString(body.remediation_target, 'remediation_target', { max: 800 });
  const mutation = mutationId(body);

  const evidence = {
    ts: new Date().toISOString(),
    event_type: 'teachback_recorded',
    topic_slug: topicSlug,
    outcome,
    audience,
    artifact_type: artifactType,
    artifact_reference: artifactReference,
    rubric_predeclared: body.rubric_predeclared,
    rubric,
    rubric_reference: rubricReference,
    observable,
    questions,
    no_gap_found: body.no_gap_found,
    gaps,
    reflection,
    resulting_actions: resultingActions,
    ownership,
    ai_contribution: aiContribution,
  };
  const qualification = qualificationForTeachback(evidence);
  if (!qualification.qualifying_teachback && !requestedRemediationTarget) {
    throw Object.assign(new Error('remediation_target is required for activity-only teach-back evidence'), { status: 400 });
  }
  const remediationTarget = requestedRemediationTarget === null
    ? null
    : teachbackRemediationTarget(topicSlug, requestedRemediationTarget);
  const record = {
    ...evidence,
    remediation_target: remediationTarget,
    qualification,
    mutation_id: mutation,
  };
  const appended = appendTeachbackEvent(topicSlug, record);
  const { duplicate, ...event } = appended;
  return sendJson(res, duplicate ? 200 : 201, { event });
}

/**
 * Apply learn-anything's update table for a graded attempt.
 *
 * A mastery failure must not be able to turn a SAVED attempt into a 500. Letting it
 * throw told the client the request failed when the attempt had already landed — so a
 * retry appended a second copy and skewed the reconciliation totals. The partial outcome
 * is reported instead, and the caller decides.
 */
async function applyMastery(topicSlug, conceptSlug, graded, options) {
  try {
    return await applyAttemptToState(topicSlug, conceptSlug, graded, options);
  } catch (err) {
    console.error(`[attempts] ${topicSlug} recorded but mastery not applied`, err);
    return { error: err.message, attempt_recorded: true };
  }
}

// Bound to this server's mastery function; the sequencing itself lives in lib/settlement.
const settle = (topicSlug, attempt, graded) => settleMastery(topicSlug, attempt, graded, applyMastery);
const heal = (topicSlug, attemptId, deck) => healUnappliedMastery(topicSlug, attemptId, deck, applyMastery);

/**
 * Commit an attempt: grade server-side from the raw responses, append it, and only then
 * reveal the answers in the response.
 *
 * Recording BEFORE revealing is the whole point (assessment finding F3). The old flow
 * graded without writing, showed every answer, and then offered "Record attempt" or
 * "Discard" — so a bad pretest could be seen and thrown away, and retaken knowing the
 * answers. There is no longer any way to see an answer without the attempt being on disk.
 *
 * The client never supplies a score — it posts what it answered, and the server decides
 * what that was worth. A forged payload can't inflate mastery.
 *
 * Self-checked (ai_only) items cannot be graded here, so the attempt is left
 * `pending_self_grade` and mastery waits for /finalize. Applying it now and again at
 * finalize would double the confidence gain; applying it once, on the completed attempt,
 * keeps the state.json diff identical to the manual /learn:quiz flow. Abandoning the
 * screen therefore leaves a recorded attempt with no mastery movement — which is honest,
 * and visible in /api/health.
 */
async function handleAttempts(req, res) {
  const body = await readJsonBody(req);
  // Preserve the established 404 contract for an unknown quiz topic while using the
  // same allowlist before the deck path is ever resolved.
  if (body.topic_slug === undefined || body.topic_slug === null || body.topic_slug === '') {
    assertKnownTopic(config.topics, body.topic_slug);
  }
  if (!knownTopic(body.topic_slug)) return sendJson(res, 404, { error: 'unknown topic', topic: body.topic_slug });
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const deckFile = assertFilename(body.deck_file);
  const responses = assertPlainObject(body.responses ?? {}, 'responses', { maxKeys: 100 });
  const notes = optionalString(body.notes, 'notes', { max: 4_000 });

  const deck = readDeck(topicSlug, deckFile);
  const confidence = assertPlainObject(body.confidence ?? {}, 'confidence', { maxKeys: 100 });
  const questionIds = new Set(deck.questions.map((question) => question.id));
  for (const [questionId, band] of Object.entries(confidence)) {
    if (!questionIds.has(questionId)) return sendJson(res, 400, { error: 'confidence must reference a question in this deck' });
    const response = responses[questionId];
    const answered = Array.isArray(response) ? response.length > 0 : response !== undefined && response !== null && response !== '';
    if (!answered) return sendJson(res, 400, { error: 'confidence requires a submitted answer' });
    if (!isConfidenceBand(band)) {
      return sendJson(res, 400, { error: `confidence must be one of: ${EVIDENCE_POLICY.confidenceBands.join(', ')}` });
    }
  }
  const graded = gradeDeck(deck, responses, {}, confidence);
  const pending = graded.pending.length > 0;

  const attempt = appendAttempt(topicSlug, {
    ts: new Date().toISOString(),
    kind: 'quiz',
    attempt_id: randomUUID(),
    mutation_id: mutationId(body),
    revision: 0,
    concept_slug: deck.concept_slug,
    deck_file: deckFile,
    score: graded.score,
    max: graded.max,
    misses: graded.misses,
    // Kept so /finalize re-grades from what was actually submitted, rather than trusting
    // a second client payload to repeat it faithfully.
    responses,
    confidence,
    evidence_policy: EVIDENCE_POLICY.version,
    retrieval_evidence: retrievalEvidenceForQuiz(deckFile, deck, graded),
    status: pending ? 'pending_self_grade' : 'final',
    // Never true at append time — see settleMastery.
    mastery_applied: false,
    ...(graded.pending.length ? { pending: graded.pending } : {}),
    ...(notes ? { notes } : {}),
  });

  // A recognised replay must not apply mastery a second time — the attempt, its cards
  // and its confidence bump all landed on the first request. The reveal is re-derived
  // from the STORED responses rather than reusing this request's grading: if a retry ever
  // carried a different payload under the same mutation id, showing results graded from
  // it would contradict the score on the attempt it just returned.
  if (attempt.duplicate) {
    const stored = gradeDeck(deck, attempt.responses ?? {}, {}, attempt.confidence ?? {});
    // ...unless mastery never landed the first time, in which case the retry finishes it.
    const healed = await heal(topicSlug, attempt.attempt_id, deck);
    return sendJson(res, 200, { attempt, replayed: true, mastery: healed, results: stored.results });
  }

  const mastery = pending ? null : await settle(topicSlug, attempt, graded);

  // Error routing: every miss becomes a card, immediately.
  const queued = syncCardsFromAttempts(topicSlug);

  return sendJson(res, 201, { attempt, mastery, queued_cards: queued, results: graded.results });
}

/**
 * Finalise a pending attempt with the learner's own verdict on its self-checked items.
 *
 * History is append-only, so this does not rewrite the original record: it appends the
 * next revision under the same attempt_id, and readAttempts folds to the newest. Both
 * records stay on disk, which is what makes the log auditable.
 */
async function handleFinalizeAttempt(req, res, attemptId) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  attemptId = assertIdentifier(attemptId, 'attempt_id');
  const selfGrades = assertPlainObject(body.self_grades ?? {}, 'self_grades', { maxKeys: 100 });

  const attempt = findAttempt(topicSlug, attemptId);
  if (!attempt) return sendJson(res, 404, { error: 'unknown attempt', attempt_id: attemptId });

  const deck = readDeck(topicSlug, attempt.deck_file);

  if (attempt.status === 'final') {
    // Already graded. Idempotent rather than an error: the usual cause is a double click.
    // But "final" is not the same as "finished" — if mastery never landed, this retry is
    // the only thing that will ever finish it, so the heal runs before returning.
    const healed = await heal(topicSlug, attemptId, deck);
    return sendJson(res, 200, { attempt: findAttempt(topicSlug, attemptId), already_final: true, mastery: healed });
  }

  const graded = gradeDeck(deck, attempt.responses ?? {}, selfGrades, attempt.confidence ?? {});
  const stillPending = graded.pending.length > 0;

  const next = {
    ...attempt,
    ts: new Date().toISOString(),
    mutation_id: mutationId(body),
    revision: (Number(attempt.revision) || 0) + 1,
    score: graded.score,
    max: graded.max,
    misses: graded.misses,
    retrieval_evidence: finalizeRetrievalEvidence(attempt.retrieval_evidence, graded),
    status: stillPending ? 'pending_self_grade' : 'final',
    // Never true at append time — see settleMastery.
    mastery_applied: false,
    ...(graded.self_graded.length ? { self_graded: graded.self_graded } : {}),
  };
  // Carried over from the spread, so it has to go when nothing is pending any more.
  if (stillPending) next.pending = graded.pending;
  else delete next.pending;

  const revised = appendAttempt(topicSlug, next);

  if (revised.duplicate) {
    const healed = await heal(topicSlug, attemptId, deck);
    return sendJson(res, 200, { attempt: revised, replayed: true, mastery: healed, results: graded.results });
  }

  const mastery = stillPending ? null : await settle(topicSlug, revised, graded);
  const queued = syncCardsFromAttempts(topicSlug);

  return sendJson(res, 201, { attempt: revised, mastery, queued_cards: queued, results: graded.results });
}

const VALID_RESULTS = new Set(['hit', 'miss']);

/** Log one card review. The interval it earns is derived, never stored. */
async function handleReviews(req, res) {
  const body = await readJsonBody(req);
  const { result } = body;
  // Preserve this route's established 404 contract for an unknown topic while still
  // rejecting it before any sidecar path is touched.
  if (!knownTopic(body.topic_slug)) return sendJson(res, 404, { error: 'unknown topic', topic: body.topic_slug });
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const cardId = assertIdentifier(body.card_id, 'card_id');

  if (!VALID_RESULTS.has(result)) {
    return sendJson(res, 400, { error: 'topic_slug, card_id and result (hit|miss) are required' });
  }
  if (!readCards(topicSlug).some((c) => c.id === cardId)) {
    return sendJson(res, 404, { error: 'unknown card', card_id: cardId });
  }

  const review = appendReview(topicSlug, {
    ts: new Date().toISOString(),
    mutation_id: mutationId(body),
    card_id: cardId,
    result,
  });
  // A replayed review comes back as-is: logging the same review twice would corrupt the
  // interval, since a card's rung is its consecutive-hit streak.
  return sendJson(res, review.duplicate ? 200 : 201, review);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Self-reported answer time is capped at a day: anything longer is a forgotten tab, not a turn. */
const MAX_TURN_ELAPSED_MS = 86_400_000;
const MAX_SESSION_CARDS = 30;
const FINDING_ID = /^f\d{1,3}$/;

/**
 * A session id becomes part of a transcript path, so it is a UUID or it is refused.
 * Diagnosis ids are minted the same way and take the same check.
 */
const sessionIdFrom = (value) => assertString(value, 'id', { max: 36, pattern: SESSION_ID });

function turnTiming(value) {
  if (value == null) return null;
  const timing = assertPlainObject(value, 'timing', { maxKeys: 4 });
  return {
    elapsed_ms: assertInteger(timing.elapsed_ms, 'timing.elapsed_ms', { min: 0, max: MAX_TURN_ELAPSED_MS }),
    tab_hidden: Boolean(timing.tab_hidden),
  };
}

/**
 * Role sessions with the Claude API.
 *
 * Only starting a session, sending a turn and drafting a summary need the provider; when
 * it is down those answer 503 naming it (the ClaudeError carries the status and the
 * handler's catch renders it). Listing, reading, closing, revising a summary and creating
 * cards are local and keep working.
 */
async function handleRoles(req, res, url) {
  const [, , , resource, id, action] = url.pathname.split('/');

  if (req.method === 'GET' && resource === 'sessions') {
    const topicSlug = assertKnownTopic(config.topics, url.searchParams.get('topic'), 'topic');
    if (!id) return sendJson(res, 200, listSessions(topicSlug));
    return sendJson(res, 200, getSession(topicSlug, sessionIdFrom(id)));
  }

  if (req.method === 'GET' && resource === 'diagnoses' && !id) {
    return sendJson(res, 200, listDiagnoses(assertKnownTopic(config.topics, url.searchParams.get('topic'), 'topic')));
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);

  // Before the mutation id is read, deliberately: resume appends nothing of the caller's
  // and is idempotent by what is on disk, so an id here would be one the server ignores
  // (rule 9).
  if (resource === 'sessions' && id && action === 'resume') {
    return sendJson(res, 200, await resumeSession(topicSlug, sessionIdFrom(id)));
  }

  // Also without a mutation id: a draft is returned and stored nowhere, so there is
  // nothing for a replay to duplicate.
  if (resource === 'sessions' && id && action === 'card-draft') {
    return sendJson(res, 200, await draftSessionCard(topicSlug, sessionIdFrom(id), {
      turnIndex: assertInteger(body.turn_index, 'turn_index', { min: 1, max: 10_000 }),
      front: body.front === undefined ? undefined : assertString(body.front, 'front', { min: 0, max: 8_000 }),
    }));
  }

  const mutation = mutationId(body);

  if (resource === 'diagnoses' && !id) {
    const diagnosis = await runDiagnosis(topicSlug, { mutation });
    // 201 only when something was recorded: a topic with nothing eligible, and a replay,
    // both answer 200.
    return sendJson(res, diagnosis.recorded && !diagnosis.replayed ? 201 : 200, diagnosis);
  }

  if (resource === 'diagnoses' && action === 'decisions') {
    return sendJson(res, 200, decideHypothesis(topicSlug, sessionIdFrom(id), {
      findingId: assertString(body.finding_id, 'finding_id', { max: 8, pattern: FINDING_ID }),
      decision: assertString(body.decision, 'decision', { max: 20 }),
      note: optionalString(body.note, 'note', { max: ROLE_LIMITS.maxDecisionNoteChars }),
      mutation,
    }));
  }

  if (resource === 'summaries' && !id) {
    const summary = assertString(body.summary, 'summary', { max: ROLE_LIMITS.maxSummaryChars });
    return sendJson(res, 200, reviseSummary(topicSlug, { summary, mutation }));
  }

  if (resource !== 'sessions') return sendJson(res, 404, { error: 'unknown roles route' });

  if (!id) {
    const role = assertString(body.role, 'role', { max: 40 });
    const timerSeconds = body.timer_seconds == null ? null : assertInteger(body.timer_seconds, 'timer_seconds', {
      min: ROLE_LIMITS.timerMinSeconds, max: ROLE_LIMITS.timerMaxSeconds,
    });
    if (!knownConcept(topicSlug, body.concept_slug)) {
      return sendJson(res, 400, { error: 'concept_slug must belong to the selected topic' });
    }
    const session = await startSession({
      topicSlug,
      role,
      conceptSlug: body.concept_slug || null,
      counterpart: optionalString(body.counterpart, 'counterpart', { max: ROLE_LIMITS.maxCounterpartChars }),
      timerSeconds,
      mutation,
    });
    return sendJson(res, 201, session);
  }

  const sessionId = sessionIdFrom(id);

  if (action === 'turns') {
    return sendJson(res, 200, await sendTurn(topicSlug, sessionId, {
      index: assertInteger(body.index, 'index', { min: 1, max: 10_000 }),
      text: assertString(body.text, 'text', { max: ROLE_LIMITS.maxReplyChars }),
      mutation,
      timing: turnTiming(body.timing),
    }));
  }

  if (action === 'summary') {
    return sendJson(res, 200, await draftSummary(topicSlug, sessionId, { mutation }));
  }

  if (action === 'close') {
    const summary = optionalString(body.summary, 'summary', { max: ROLE_LIMITS.maxSummaryChars });
    return sendJson(res, 200, await closeSession(topicSlug, sessionId, { mutation, summary }));
  }

  if (action === 'cards') {
    const cards = assertArray(body.cards, 'cards', { max: MAX_SESSION_CARDS }).map((card, i) => {
      const entry = assertPlainObject(card, `cards[${i}]`, { maxKeys: 4 });
      if (entry.back_origin !== undefined && !BACK_ORIGINS.includes(entry.back_origin)) {
        throw Object.assign(new Error(`cards[${i}].back_origin must be one of: ${BACK_ORIGINS.join(', ')}`), { status: 400 });
      }
      return {
        ...(entry.back_origin ? { back_origin: entry.back_origin } : {}),
        turn_index: assertInteger(entry.turn_index, `cards[${i}].turn_index`, { min: 1, max: 10_000 }),
        front: assertString(entry.front, `cards[${i}].front`, { max: 8_000 }),
        back: assertString(entry.back, `cards[${i}].back`, { max: 8_000 }),
      };
    });
    return sendJson(res, 200, createSessionCards(topicSlug, sessionId, { cards, mutation }));
  }

  return sendJson(res, 404, { error: 'unknown roles route' });
}

/** Create a card by hand, or suspend/unsuspend an existing one. */
async function handleCards(req, res) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const cards = readCards(topicSlug);

  if (body.card_id) {
    const cardId = assertIdentifier(body.card_id, 'card_id');
    const card = cards.find((c) => c.id === cardId);
    if (!card) return sendJson(res, 404, { error: 'unknown card', card_id: body.card_id });
    card.suspended = Boolean(body.suspended);
    writeCards(topicSlug, cards);
    return sendJson(res, 200, card);
  }

  const front = assertString(body.front, 'front', { max: 8_000 });
  const back = assertString(body.back, 'back', { max: 8_000 });
  if (!knownConcept(topicSlug, body.concept_slug)) {
    return sendJson(res, 400, { error: 'concept_slug must belong to the selected topic' });
  }

  // Keyed by mutation id rather than the clock: a retried create used to mint a second
  // card because Date.now() had moved on.
  const mutation = mutationId(body);
  const existing = cards.find((c) => c.mutation_id === mutation);
  if (existing) return sendJson(res, 200, { ...existing, duplicate: true });

  // Hashed, not a prefix of the raw id: mutation_id is arbitrary client text, so two
  // distinct ids sharing their first 8 characters would produce ONE card id for two
  // cards — and /api/reviews resolves a card by id, so reviews would land on whichever
  // came first.
  const card = {
    id: `card-manual-${createHash('sha256').update(mutation).digest('hex').slice(0, 12)}`,
    mutation_id: mutation,
    front,
    back,
    concept_slug: body.concept_slug ?? null,
    source: optionalString(body.source, 'source', { max: 500 }) ?? 'manual',
    created: todayISO(),
  };
  cards.push(card);
  writeCards(topicSlug, cards);
  return sendJson(res, 201, card);
}

/**
 * Remove the canary episode row a failed pre-flight leaves behind — a worker restart
 * does NOT drain jobs queued while its listener was dead, so the row would otherwise
 * sit at `running` forever. Which rows qualify is decided by stuckCanaryRows (pure,
 * tested); this wrapper only fetches and deletes. Best-effort by design; the caller
 * reports the outcome either way.
 */
async function deleteStuckCanary(topicSlug, mutation, title, firedAtMs) {
  let rows;
  try {
    rows = stuckCanaryRows(await listEpisodes(), {
      title, firedAtMs, runningStatuses: ACTIVE_JOB_STATUSES,
    });
  } catch (err) {
    return { deleted: 0, error: err.message };
  }
  // Per-row, continue on error (same stance as the retry path's per-delete catch):
  // the 503 message repeats this count verbatim, so it must reflect what actually
  // happened, not collapse to zero because one delete out of several failed.
  let deleted = 0;
  let error = null;
  for (const row of rows) {
    const outcome = await deletePodcastEpisodeOperation(topicSlug, mutation, row);
    if (outcome.deleted) {
      deleted += 1;
    } else {
      error = outcome.error;
    }
  }
  return error ? { deleted, error } : { deleted };
}

/**
 * Open Notebook proxy. Every route here forwards through lib/opennotebook.mjs so the
 * bearer stays server-side — the browser never holds a credential.
 */
async function handleOnRoute(req, res, url) {
  const path = url.pathname.slice('/api/on/'.length);

  if (path === 'source-search' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await cachedSourceSearch(body.query));
  }

  if (path === 'health' && req.method === 'GET') {
    return sendJson(res, 200, await onHealth());
  }

  if (path === 'sources' && req.method === 'GET') {
    const topicSlug = url.searchParams.get('topic');
    if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic is required' });
    const notebookId = notebookForTopic(topicSlug);
    if (!notebookId) {
      // Honest empty state: a topic with no notebook mapped isn't an error.
      return sendJson(res, 200, { notebook_id: null, sources: [], reason: 'no notebook mapped for this topic' });
    }
    return sendJson(res, 200, { notebook_id: notebookId, sources: await listSources(notebookId) });
  }

  if (path === 'sources' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
    const notebookId = notebookForTopic(topicSlug);
    if (!notebookId) return sendJson(res, 400, { error: 'no notebook mapped for this topic' });
    const mutation = assertIdentifier(body.mutation_id, 'mutation_id', { max: 200 });
    const type = assertString(body.type, 'type', { pattern: /^(link|text)$/ });
    const title = assertString(body.title, 'title', { max: 200 });
    const input = { notebookId, type, title };
    if (type === 'link') {
      input.url = assertString(body.url, 'url', { max: 2_048 });
      let parsed;
      try { parsed = new URL(input.url); } catch { /* handled below */ }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        return sendJson(res, 400, { error: 'url must be an HTTP or HTTPS link' });
      }
    } else {
      input.content = assertString(body.content, 'content', { max: 100_000 });
    }
    const result = await addSource(topicSlug, mutation, input);
    return sendJson(res, result.replayed ? 200 : 201, result);
  }

  if (path.startsWith('sources/') && req.method === 'GET') {
    return sendJson(res, 200, await readSource(safeDecode(path.slice('sources/'.length))));
  }

  if (path === 'podcast' && req.method === 'GET') {
    return sendJson(res, 200, await podcastStatus());
  }

  if (path.startsWith('episodes/') && path.endsWith('/audio') && (req.method === 'GET' || req.method === 'HEAD')) {
    const episodeId = safeDecode(path.slice('episodes/'.length, -'/audio'.length));
    // A client that leaves (every seek abandons a request) stops the upstream fetch too.
    const departed = new AbortController();
    const abort = () => departed.abort();
    res.once('close', abort);
    let audio;
    try {
      audio = await episodeAudio(episodeId, { method: req.method, headers: req.headers, signal: departed.signal });
    } catch (err) {
      res.removeListener('close', abort);
      if (departed.signal.aborted) return;
      throw err;
    }
    if (res.destroyed) return audio.body?.destroy();
    // Status and media headers come from Open Notebook (206, 304, 416 included); the
    // security headers set before routing merge in. The bearer never leaves this process.
    res.writeHead(audio.status, audio.headers);
    if (!audio.body) return res.end();
    return pipeStream(res, audio.body, `episode ${episodeId}`);
  }

  if (path === 'notes' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
    const notebookId = notebookForTopic(topicSlug);
    if (!notebookId) return sendJson(res, 400, { error: 'no notebook mapped for this topic' });
    const title = assertString(body.title, 'title', { max: 450 });
    const content = assertString(body.content, 'content', { max: 40_000 });
    const mutation = mutationId(body);
    const inputHash = noteInputHash(notebookId, title, content);
    let operation = findOperationByMutation(topicSlug, mutation, 'open_notebook_note');

    if (operation) {
      if (operation.input_hash !== inputHash) {
        return sendJson(res, 409, { error: 'mutation_id belongs to a note with different input' });
      }
      if (operation.stage === 'complete') {
        return sendJson(res, 200, { id: operation.external.note_id, replayed: true });
      }

      // Once a POST may have reached ON, the only safe retry is reconciliation. A second
      // POST would create an externally-visible duplicate, so find the deterministic
      // title marker first and ask the learner to recover manually when it is absent.
      if (operation.stage === 'prepared' || operation.stage === 'ambiguous') {
        const reconciled = await reconcileNoteOperation(topicSlug, notebookId, operation);
        if (reconciled) return sendJson(res, 200, { id: reconciled.external.note_id, replayed: true });
        return sendJson(res, 409, {
          error: 'the previous Open Notebook note outcome is ambiguous; inspect recovery before retrying it',
          replayed: true,
        });
      }
    } else {
      operation = newNoteOperation(topicSlug, notebookId, mutation, inputHash, title);
    }

    // `started` and a known 4xx failure are safe to resume: neither has begun a request
    // whose remote outcome might be unknown. Persist `prepared` immediately before POST.
    operation = reviseNoteOperation(topicSlug, operation, { stage: 'prepared' });
    try {
      const note = await createNote({ notebookId, title: operation.local_result.note_title, content });
      if (!note?.id) throw Object.assign(new Error('Open Notebook created a note without an id'), { status: 503 });
      operation = reviseNoteOperation(topicSlug, operation, {
        stage: 'complete', external: { note_id: note.id },
      });
      return sendJson(res, 201, { id: operation.external.note_id });
    } catch (err) {
      const knownFailure = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
      operation = reviseNoteOperation(topicSlug, operation, {
        stage: knownFailure ? 'failed_known' : 'ambiguous',
        error: { classification: knownFailure ? 'open_notebook_note_rejected' : 'open_notebook_note_outcome_unknown' },
      });
      return sendJson(res, err.status ?? 503, { error: err.message });
    }
  }

  if (path === 'speaker-profiles' && req.method === 'GET') {
    return sendJson(res, 200, await listSpeakerProfiles());
  }

  if (path === 'speaker-profiles' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = assertString(body.name, 'name', { max: 160 });
    const description = optionalString(body.description, 'description', { max: 2_000 }) ?? '';
    const rawSpeakers = assertArray(body.speakers, 'speakers', { max: 20 });
    if (rawSpeakers.length === 0) return sendJson(res, 400, { error: 'speakers must be a non-empty array' });
    // Every speaker needs a voice: ON accepts a profile with one missing and only
    // fails much later, mid-render, where the cause is far from the mistake.
    const speakers = rawSpeakers.map((speaker, index) => {
      assertPlainObject(speaker, `speakers[${index}]`, { maxKeys: 5 });
      return {
        name: assertString(speaker.name, `speakers[${index}].name`, { max: 160 }),
        voice_id: assertString(speaker.voice_id, `speakers[${index}].voice_id`, { max: 300 }),
        backstory: optionalString(speaker.backstory, `speakers[${index}].backstory`, { max: 4_000 }) ?? '',
        personality: optionalString(speaker.personality, `speakers[${index}].personality`, { max: 4_000 }) ?? '',
      };
    });
    const intent = { name, description, speakers };
    const profiles = await listSpeakerProfiles();
    const existing = profiles.find((profile) => sameSpeakerProfile(profile, intent)) ?? null;
    if (existing) return sendJson(res, 200, { ...existing, replayed: true });
    if (profiles.some((profile) => profile.name === name)) {
      return sendJson(res, 409, { error: `a speaker profile named "${name}" already exists with different settings` });
    }

    // Speaker profiles are global ON configuration, not learner-topic data, so a
    // topic-local operation ledger would misrepresent their ownership. Their unique name
    // and normalized payload instead provide deterministic read-before-write recovery:
    // after an uncertain POST, list by name before ever issuing another create.
    try {
      return sendJson(res, 201, await createSpeakerProfile(intent));
    } catch (err) {
      const reconciled = await findSpeakerProfile(intent).catch(() => null);
      if (reconciled) return sendJson(res, 200, { ...reconciled, replayed: true });
      throw err;
    }
  }

  if (path === 'podcast/generate' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const episodeProfile = assertString(body.episode_profile, 'episode_profile', { max: 200 });
    const speakerProfile = assertString(body.speaker_profile, 'speaker_profile', { max: 200 });
    const title = assertString(body.episode_name, 'episode_name', { max: 300 });
    const notebookId = assertIdentifier(body.notebook_id, 'notebook_id', { max: 300 });
    const topicSlug = config.topics.find((topic) => topic.notebookId === notebookId)?.slug ?? null;
    if (!topicSlug) {
      return sendJson(res, 400, { error: 'notebook_id must be a configured StudyDeck topic notebook' });
    }
    const mutation = mutationId(body);
    const briefingSuffix = optionalString(body.briefing_suffix, 'briefing_suffix', { max: 4_000 });
    // The caller's title, tagged for the whole notebook and this request, so a lost
    // generate can be settled only by the episode it made.
    const renditionName = episodeNameFor(topicSlug, `notebook:${notebookId}`, title, mutation);
    const result = await runStandalonePodcastOperation({
      topicSlug, mutation, notebookId, episodeProfile, speakerProfile, title, renditionName, briefingSuffix,
    });
    if (result.error) return sendJson(res, result.status ?? 503, { error: result.error });
    return sendJson(res, 202, result);
  }

  if (path === 'podcast/generate-batch' && req.method === 'POST') {
    const body = await readJsonBody(req);
    for (const field of ['topic_slug', 'episode_profile', 'speaker_profile']) {
      if (!body[field]?.trim()) return sendJson(res, 400, { error: `${field} is required` });
    }
    if (!knownTopic(body.topic_slug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });
    const notebookId = notebookForTopic(body.topic_slug);
    if (!notebookId) return sendJson(res, 400, { error: 'no notebook mapped for this topic' });

    const sources = await listSources(notebookId);
    if (sources.length === 0) {
      return sendJson(res, 400, { error: 'the mapped notebook has no sources to generate from' });
    }

    const episodeProfile = body.episode_profile.trim();
    const speakerProfile = body.speaker_profile.trim();
    const briefingSuffix = body.briefing_suffix ?? null;
    // A preview remains entirely read-only and deliberately carries no mutation. Every
    // real batch has one stable origin id; each source gets a deterministic child record.
    const mutation = body.dry_run ? null : mutationId(body);

    // Every episode is named `<chapter> · sd-<hash of topic+source>` (lib/podcastbatch),
    // so a row is attributable to one topic and one source rather than to a title two
    // notebooks might share — assessment finding F10. ON gives us nothing else to hold:
    // no notebook_id on an episode, and no episode id back from a generate.
    let targets = sources.map((s) => ({ ...s, episode_name: episodeNameFor(body.topic_slug, s.id, s.title) }));
    let skipped = 0;
    let legacySkips = [];
    let deletable = [];
    if (body.retry_only) {
      // retry_only: regenerate just the chapters that failed or were never generated,
      // leaving alone the ones that already rendered OR are still rendering.
      const plan = planRetry({
        sources,
        episodes: await listEpisodes(),
        topicSlug: body.topic_slug,
        isRunning: isActiveJobStatus,
      });
      ({ targets, skipped, legacySkips, deletable } = plan);
    }

    // Read-only, so a preview runs it too: a dry run that answers 200 says the real batch
    // would not be refused for its profile either. A replay whose children are all recorded
    // as sent sends nothing new, and needs no preflight: requiring one would strand the
    // accepted job ids behind an outage of a service the replay never calls.
    const replayOnly = Boolean(mutation) && deletable.length === 0 && targets.every((source) =>
      PODCAST_SENT_STAGES.has(podcastOperationFor(body.topic_slug, mutation, source.id)?.stage));
    if (!replayOnly) await podcastPreflight({ episodeProfile, speakerProfile });

    // dry_run: answer with the plan and touch nothing. This return sits ABOVE the first
    // statement that is not read-only, and that placement IS the guarantee — every line
    // below it either deletes an episode or starts a render. Validation deliberately
    // happens first and identically, so a preview that answers 200 also tells you the real
    // request would not 400.
    if (body.dry_run) {
      return sendJson(res, 200, dryRunReport({
        notebookId, targets, deletable, legacySkips, skipped, retryOnly: Boolean(body.retry_only),
      }));
    }

    // Only rows this topic+source produced — never one matched by bare title, which is
    // the cross-notebook delete F10 is about. A deletion with an unknown outcome blocks
    // its source from generation; otherwise an uncertain DELETE could become a duplicate
    // render beside the row it may not actually have removed.
    const blockedTags = new Set();
    const deleteErrors = [];
    for (const episode of deletable) {
      const outcome = await deletePodcastEpisodeOperation(body.topic_slug, mutation, episode);
      if (!outcome.deleted) {
        blockedTags.add(sourceTag(episode.name));
        deleteErrors.push({ episode_id: episode.id, name: episode.name, error: outcome.error, ambiguous: Boolean(outcome.ambiguous) });
      }
    }
    targets = targets.filter((source) => !blockedTags.has(sourceTag(source.episode_name)));
    // From here each render is named for this request: its rendition. A lost generate is
    // then settled only by the row it made, never by an earlier recording of the chapter.
    targets = targets.map((source) => ({ ...source, episode_name: episodeNameFor(body.topic_slug, source.id, source.title, mutation) }));

    // Only reachable under retry_only: a full batch's targets are its sources, and an
    // empty notebook was refused above.
    if (targets.length === 0) {
      return sendJson(res, 200, {
        notebook_id: notebookId, count: 0, skipped, legacy_skips: legacySkips, episodes: [], delete_errors: deleteErrors,
        message: deleteErrors.length > 0
          ? 'a stale episode deletion needs recovery before its chapter can be generated'
          : 'every chapter already has audio or is still rendering — nothing to retry',
      });
    }

    // One episode per target source, each scoped to that source's own text via `content`
    // (not the whole notebook). ON accepts each request in ~1s and its worker renders
    // them serially. Per-source try/catch: a single unreadable source or rejected
    // request must not abort the rest.
    const fireOne = async (source) => {
      // Both names travel: `episode_name` is the identity every later match uses — the
      // worker-log probe and the canary cleanup included, since ON logs and stores the
      // name we sent — while `title` stays the chapter, for anything a person reads.
      const identity = { source_id: source.id, title: source.title, episode_name: source.episode_name };
      try {
        return await runPodcastEpisodeOperation({
          topicSlug: body.topic_slug, mutation, source, episodeProfile, speakerProfile, briefingSuffix,
        });
      } catch (err) {
        return { ...identity, job_id: null, accepted: false, error: err.message };
      }
    };

    // Worker pre-flight. ON accepts a generate even when its worker's LIVE-query
    // subscription has gone stale — every job would then sit at `running` forever (see
    // CLAUDE.md "External services"). So the batch is NOT fired all at once: the first
    // chapter ON accepts becomes a canary, and the remaining chapters are committed only
    // once the worker's own log proves it picked the canary up. On a 20-chapter book
    // that turns 20 silently dead rows into one actionable error.
    const firedAtMs = Date.now();
    const episodes = [];
    let canary = null;
    for (const source of targets) {
      const entry = await fireOne(source);
      episodes.push(entry);
      if (entry.accepted) {
        canary = entry;
        break;
      }
    }

    let preflight = { status: 'skipped', detail: 'no render was accepted, so there was nothing to probe' };
    if (canary) {
      preflight = await probeWorkerPickup({
        container: config.openNotebook.workerContainer,
        episodeName: canary.episode_name,
      });
    }

    if (preflight.status === 'timeout') {
      const cleanup = await deleteStuckCanary(body.topic_slug, mutation, canary.episode_name, firedAtMs);
      const secs = Math.round(preflight.waited_ms / 1000);
      return sendJson(res, 503, {
        error:
          `Open Notebook accepted the render but its worker never picked it up within ${secs}s — ` +
          'its command listener is likely stale. Fix: restart the container ' +
          `(docker restart ${config.openNotebook.workerContainer}), wait for it to come back, ` +
          'then use "Retry failed / missing". ' +
          (cleanup.deleted > 0
            ? 'The stuck canary episode row was deleted.'
            : `The stuck row for "${canary.title}" could not be confirmed deleted` +
              `${cleanup.error ? ` (${cleanup.error})` : ''} — if it still shows "running" ` +
              'with no progress, delete it in Open Notebook.'),
        preflight,
        canary: { ...canary, cleanup },
      });
    }

    // 'seen' commits the rest; 'unavailable' (log unreadable — docker missing, ON
    // remote) also proceeds, exactly as before this probe existed, and the UI surfaces
    // the warning: an unprobeable setup is not a stale one.
    const rest = await Promise.all(targets.slice(episodes.length).map(fireOne));
    episodes.push(...rest);

    return sendJson(res, 202, {
      notebook_id: notebookId, count: episodes.length, skipped, legacy_skips: legacySkips, episodes, preflight, delete_errors: deleteErrors,
    });
  }

  if (path.startsWith('podcast/jobs/') && req.method === 'GET') {
    const jobId = safeDecode(path.slice('podcast/jobs/'.length));
    if (!jobId) return sendJson(res, 400, { error: 'job id is required' });
    return sendJson(res, 200, await podcastJob(jobId));
  }

  return sendJson(res, 404, { error: 'not found', route: url.pathname });
}

// Route values that select a topic must be a configured slug, never merely a string that
// happens to be handed to a sidecar path. The allowlist is the authority; the shape check
// makes traversal-shaped values visibly invalid rather than indistinguishable from a typo.
const knownTopic = (slug) => {
  try {
    assertKnownTopic(config.topics, slug);
    return true;
  } catch {
    return false;
  }
};

function knownConcept(topicSlug, conceptSlug) {
  if (conceptSlug == null || conceptSlug === '') return true;
  if (typeof conceptSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(conceptSlug)) return false;
  return readTopicState(topicSlug).domains.some((domain) =>
    domain.concepts.some((concept) => concept.slug === conceptSlug));
}

/**
 * Fact-check. Generation is a slow local-model call, so claim sets are persisted and
 * a run reads from the stored set — you pay the minute once, not on every attempt.
 */
async function handleFactcheck(req, res, url) {
  const path = url.pathname.slice('/api/factcheck'.length).replace(/^\//, '');

  if (path === '' && req.method === 'GET') {
    const topicSlug = url.searchParams.get('topic');
    if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic is required' });
    // Stripped server-side. The browser used to receive every truth value and correction
    // for every stored set, and only discard them when rendering.
    return sendJson(res, 200, stripAllClaimAnswers(readFactChecks(topicSlug)));
  }

  if (path === 'generate' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!knownTopic(body.topic_slug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });
    if (!body.source_id || !body.text?.trim()) {
      return sendJson(res, 400, { error: 'source_id and text are required' });
    }
    const record = await generateClaims(body.topic_slug, {
      sourceId: body.source_id,
      sourceTitle: body.source_title ?? body.source_id,
      section: body.section ?? null,
      text: body.text,
    });
    // Claims are sent WITHOUT truth values — same principle as answer-free decks.
    return sendJson(res, 201, stripClaimAnswers(record));
  }

  if (path === 'run' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!knownTopic(body.topic_slug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });

    const record = getClaims(body.topic_slug, body.source_id, body.section);
    if (!record) return sendJson(res, 404, { error: 'no generated claims for that source/section' });

    // Replay check BEFORE recording: a lost response must return the same model proposal
    // rather than produce a new claim verdict or card side effect.
    const mutation = mutationId(body);
    const alreadyRun = readAttemptsRaw(body.topic_slug).find((a) => a.mutation_id === mutation);
    if (alreadyRun) {
      const stored = findAttempt(body.topic_slug, alreadyRun.attempt_id) ?? alreadyRun;
      return sendJson(res, 200, {
        attempt: { ...stored, duplicate: true }, results: stored.factcheck_proposal?.results ?? [], replayed: true,
      });
    }

    const marks = assertPlainObject(body.marks ?? {}, 'marks', { maxKeys: 200 });
    const confidence = assertPlainObject(body.confidence ?? {}, 'confidence', { maxKeys: 200 });
    const claimIds = new Set(record.claims.map((claim) => claim.id));
    for (const [claimId, band] of Object.entries(confidence)) {
      if (!claimIds.has(claimId)) return sendJson(res, 400, { error: 'confidence must reference a claim in this run' });
      if (typeof marks[claimId] !== 'boolean') return sendJson(res, 400, { error: 'confidence requires a submitted true/false mark' });
      if (!isConfidenceBand(band)) {
        return sendJson(res, 400, { error: `confidence must be one of: ${EVIDENCE_POLICY.confidenceBands.join(', ')}` });
      }
    }
    const proposed = proposeRun(record, marks, confidence);
    // Marks are durable before any model verdict crosses the response boundary. This is
    // answer-secrecy's fact-check counterpart: seeing a proposal always implies an
    // append-only attempt exists, but proposals remain outside learning evidence.
    const attempt = appendAttempt(body.topic_slug, {
      ts: new Date().toISOString(),
      kind: 'factcheck',
      // Same identity contract as a quiz attempt. Without these, foldAttempts falls
      // through to its legacy-row branch and findAttempt can never resolve the record —
      // rule 9 half-applied, in a path that appends to the same log.
      attempt_id: randomUUID(),
      revision: 0,
      mutation_id: mutation,
      concept_slug: body.concept_slug ?? null,
      deck_file: `${record.source_id}#${record.section || 'all'}`,
      notes: `Fact-check on ${record.source_title}${record.section ? ` § ${record.section}` : ''}.`,
      status: 'pending_confirmation',
      mastery_applied: false,
      assessor_type: 'local_model',
      prompt_version: record.prompt_version ?? 'fact-check-claims-v1',
      source_hash: record.source_hash ?? null,
      confidence,
      evidence_policy: EVIDENCE_POLICY.version,
      factcheck_proposal: {
        source_id: record.source_id,
        source_title: record.source_title,
        section: record.section,
        results: proposed.results,
      },
    });
    return sendJson(res, 201, { attempt, results: proposed.results, created_cards: [], pending_confirmation: true });
  }

  const adjudicateMatch = /^runs\/([^/]+)\/adjudicate$/.exec(path);
  if (adjudicateMatch && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topicSlug = body.topic_slug;
    if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });
    const attemptId = assertIdentifier(safeDecode(adjudicateMatch[1]), 'attempt_id');
    const mutation = mutationId(body);
    const rawReplay = readAttemptsRaw(topicSlug).find((row) => row.mutation_id === mutation);
    if (rawReplay) {
      if (rawReplay.attempt_id !== attemptId) {
        return sendJson(res, 409, { error: 'mutation_id belongs to a different attempt' });
      }
      const replay = await completeFactcheckCards(topicSlug, findAttempt(topicSlug, rawReplay.attempt_id) ?? rawReplay);
      return sendJson(res, 200, { attempt: { ...replay, duplicate: true }, ...factcheckResponse(topicSlug, replay), replayed: true });
    }

    const attempt = findAttempt(topicSlug, attemptId);
    if (!attempt || attempt.kind !== 'factcheck' || !attempt.factcheck_proposal) {
      return sendJson(res, 404, { error: 'unknown fact-check attempt', attempt_id: attemptId });
    }
    if (attempt.status === 'final') {
      const complete = await completeFactcheckCards(topicSlug, attempt);
      return sendJson(res, 200, { attempt: complete, ...factcheckResponse(topicSlug, complete), already_final: true });
    }
    if (attempt.status !== 'pending_confirmation') {
      return sendJson(res, 409, { error: `fact-check attempt is ${attempt.status}; it cannot be adjudicated` });
    }

    const proposal = attempt.factcheck_proposal;
    const record = getClaims(topicSlug, proposal.source_id, proposal.section);
    // The full source/claim set is stored in the attempt, so a changed source cannot turn
    // an old proposal into current evidence. Keep it visible for repair, never erase it.
    // Continue from the newest per-claim adjudications. Replaying only the original
    // proposals here would erase a learner decision made in an earlier resume action.
    const priorResults = attempt.factcheck_adjudication?.results ?? proposal.results;
    const decisions = assertPlainObject(body.decisions ?? {}, 'decisions', { maxKeys: 200 });
    const adjudicated = adjudicateRun({ ...proposal, claims: proposal.results }, priorResults, decisions);
    const next = appendAttempt(topicSlug, {
      ...attempt,
      ts: new Date().toISOString(),
      revision: (Number(attempt.revision) || 0) + 1,
      mutation_id: mutation,
      score: adjudicated.score,
      max: adjudicated.max,
      misses: adjudicated.wrong,
      status: adjudicated.complete ? 'final' : 'pending_confirmation',
      factcheck_adjudication: adjudicated,
      factcheck_source_stale: Boolean(record && attempt.source_hash && record.source_hash && record.source_hash !== attempt.source_hash),
    });
    const complete = await completeFactcheckCards(topicSlug, next);
    return sendJson(res, 201, { attempt: complete, ...factcheckResponse(topicSlug, complete) });
  }

  return sendJson(res, 404, { error: 'not found', route: url.pathname });
}

function factcheckResponse(topicSlug, attempt) {
  const adjudicated = attempt.factcheck_adjudication;
  const proposal = attempt.factcheck_proposal;
  const record = proposal ? getClaims(topicSlug, proposal.source_id, proposal.section) : null;
  const stale = Boolean(record && attempt.source_hash && record.source_hash && record.source_hash !== attempt.source_hash);
  const createdCards = factcheckCardsFor(topicSlug, attempt);
  return {
    results: adjudicated?.results ?? proposal?.results ?? [],
    score: adjudicated?.score ?? null,
    max: adjudicated?.max ?? null,
    pending: adjudicated?.pending ?? proposal?.results.map((result) => result.id) ?? [],
    disputed: adjudicated?.disputed ?? [],
    created_cards: createdCards,
    source_stale: stale || Boolean(attempt.factcheck_source_stale),
  };
}

/**
 * Corrective cards are a second durable effect after the final adjudication revision.
 * Keep that boundary explicit: if the process dies after either write, the next read or
 * replay resumes the missing half and source_ref dedupe guarantees exactly one card.
 */
const factcheckCardsInFlight = new Map();

async function completeFactcheckCards(topicSlug, attempt) {
  if (attempt.status !== 'final' || !attempt.factcheck_proposal || !attempt.factcheck_adjudication) return attempt;

  const { result } = await shareInFlight(factcheckCardsInFlight, `${topicSlug}:${attempt.attempt_id}`, () => {
    const current = findAttempt(topicSlug, attempt.attempt_id) ?? attempt;
    if (current.factcheck_cards?.status === 'complete') return current;

    const proposal = current.factcheck_proposal;
    cardsFromAdjudication(topicSlug, { ...proposal, concept_slug: current.concept_slug }, current.factcheck_adjudication);
    const cards = factcheckCardsFor(topicSlug, current);
    return appendAttempt(topicSlug, {
      ...current,
      ts: new Date().toISOString(),
      revision: (Number(current.revision) || 0) + 1,
      mutation_id: `${current.mutation_id}:factcheck-cards`,
      factcheck_cards: { status: 'complete', card_ids: cards.map((card) => card.id) },
    });
  });
  return result;
}

/**
 * Recovery's settle: finish one owed result, once. Settlement and card creation are both
 * idempotent, so a replay finds nothing owed and answers already_done without writing.
 * Ambiguous mastery is refused: it may already be in state.json, and applying it again
 * would be a confidence bump nobody earned.
 */
async function settleRecoveryItem(topicSlug, attemptId) {
  const attempt = findAttempt(topicSlug, attemptId);
  if (!attempt) return { status: 404, body: { error: 'There is no such attempt in this topic.' } };

  if (owesMastery(attempt)) {
    const result = await heal(topicSlug, attemptId, null);
    const settled = findAttempt(topicSlug, attemptId);
    if (!result?.error && settled?.mastery_applied === true) {
      return { status: 200, body: { outcome: result ? 'applied' : 'already_done', item: projectAttempt('mastery_owed', settled) } };
    }
    return {
      status: 503,
      body: { error: `Mastery was not updated (${result?.error ?? 'the update did not land'}). Nothing was applied, so it is safe to try again.` },
    };
  }

  if (owesFactcheckCards(attempt)) {
    const completed = await completeFactcheckCards(topicSlug, attempt);
    return { status: 200, body: { outcome: 'applied', item: projectAttempt('factcheck_cards_owed', completed) } };
  }

  if (isFinalAttempt(attempt) && (attempt.mastery_applied === true || attempt.factcheck_cards?.status === 'complete')) {
    return { status: 200, body: { outcome: 'already_done', item: projectAttempt('done', attempt) } };
  }
  const error = attempt.mastery_settlement?.stage === 'ambiguous'
    ? 'Mastery may or may not have been updated for this attempt, so Recovery will not apply it.'
    : !isFinalAttempt(attempt)
      ? 'This attempt is not finished yet. Resume it where it started.'
      : 'This attempt has nothing left to finish.';
  return { status: 409, body: { error } };
}

/**
 * Recovery's reconcile: look in Open Notebook for what an unconfirmed write would have
 * made, and complete the operation only on exactly one match. Only GETs leave here; a
 * create or delete is never retried to find out, because ON cannot recognise a repeat.
 * Each kind completes through its own revise helper, so the revision's mutation id is
 * derived the same way as everywhere else and a replayed append dedupes.
 */
async function reconcileRecoveryOperation(topicSlug, operationId) {
  const operation = readOperations(topicSlug).find((candidate) => candidate.operation_id === operationId);
  if (!operation) return { status: 404, body: { error: 'There is no such operation in this topic.' } };
  const item = projectOperation(operation);
  if (operation.stage === 'complete') return { status: 200, body: { outcome: 'already_done', item } };
  if (!isUnresolvedOperation(operation)) {
    return { status: 409, body: { error: `This write is not waiting on an unknown outcome (it is ${operation.stage}). Retry it from where it started.` } };
  }
  if (!CHECKABLE_KINDS.has(operation.kind)) {
    return { status: 409, body: { error: `The cockpit can't check this kind of write. Look in Open Notebook for "${item.label}" before doing it again.` } };
  }

  let settled = null;
  if (operation.kind === 'open_notebook_note') {
    settled = await reconcileNoteOperation(topicSlug, operation.local_result?.notebook_id ?? notebookForTopic(topicSlug), operation);
  } else if (operation.kind === 'mindmap_note') {
    const notebookId = notebookForTopic(topicSlug);
    settled = notebookId ? await reconcileMindmapNoteOperation(topicSlug, notebookId, operation) : null;
  } else if (operation.kind === 'podcast_delete') {
    const episodeId = operation.local_result?.episode_id;
    const listed = (await listEpisodes()).some((episode) => episode.id === episodeId);
    if (episodeId && !listed) settled = revisePodcastOperation(topicSlug, operation, { stage: 'complete', error: null });
  } else {
    settled = await reconcilePodcastEpisode(topicSlug, operation);
  }
  return settled
    ? { status: 200, body: { outcome: 'confirmed', item: projectOperation(settled) } }
    : { status: 200, body: { outcome: 'still_unknown', item } };
}

function factcheckCardsFor(topicSlug, attempt) {
  const proposal = attempt.factcheck_proposal;
  const adjudicated = attempt.factcheck_adjudication;
  if (attempt.status !== 'final' || !proposal || !adjudicated) return [];

  const wanted = new Set(adjudicated.results
    .filter((result) => (result.adjudication === 'accepted' || result.adjudication === 'corrected') && !result.correct)
    .map((result) => `factcheck:${proposal.source_id}#${proposal.section || 'all'}:${result.id}`));
  return readCards(topicSlug).filter((card) => wanted.has(card.source_ref));
}

// Render MP3s are git-ignored, so a manifest can arrive (a clone, another machine) without
// the candidate it describes.
const CANDIDATE_MISSING = 'Candidate audio is not on this machine; re-render to listen';

/**
 * The chapter renderer (D5d): list, create, read, play, resume and publish renditions.
 * Library errors carry their status, and handleRequest's catch sends it. The item pattern takes any one segment so a
 * malformed id reaches readRendition's 400 instead of looking like an unknown route. Every
 * other path in the group is a 404 naming it, never the /api/ catch-all's 501.
 */
async function handlePodcastRenders(req, res, url) {
  // Local manifests only: the list keeps working while Open Notebook is down.
  if (url.pathname === '/api/podcast/renders' && req.method === 'GET') {
    const topic = assertKnownTopic(config.topics, url.searchParams.get('topic'), 'topic');
    return sendJson(res, 200, { renditions: listRenditions(topic) });
  }
  if (url.pathname === '/api/podcast/renders' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const input = {
      topic_slug: assertKnownTopic(config.topics, body.topic_slug),
      source_id: assertIdentifier(body.source_id, 'source_id'),
      mutation_id: assertIdentifier(body.mutation_id, 'mutation_id', { max: 120 }),
      episode_profile: assertString(body.episode_profile, 'episode_profile', { max: 200 }),
      speaker_profile: assertString(body.speaker_profile, 'speaker_profile', { max: 200 }),
    };
    return sendJson(res, 202, { rendition: await prepareRendition(input) });
  }
  const [, id, action] = /^\/api\/podcast\/renders\/([^/]+)(?:\/(audio|resume|publish))?$/.exec(url.pathname) ?? [];
  if (id && !action && req.method === 'GET') {
    const topic = assertKnownTopic(config.topics, url.searchParams.get('topic'), 'topic');
    const m = readRendition(topic, id);
    if (!m) return sendJson(res, 404, { error: 'Rendition not found' });
    return sendJson(res, 200, { rendition: renderSummary(m), transcript: m.transcript, transcript_attempts: m.transcript_attempts });
  }
  if (id && action === 'audio' && (req.method === 'GET' || req.method === 'HEAD')) {
    const topic = assertKnownTopic(config.topics, url.searchParams.get('topic'), 'topic');
    const m = readRendition(topic, id);
    if (!m) return sendJson(res, 404, { error: 'Rendition not found' });
    if (!m.audio_qc?.asset) return sendJson(res, 404, { error: 'This rendition has no checked audio yet' });
    const path = join(renditionDir(topic, id), 'candidate.mp3');
    if (!existsSync(path)) return sendJson(res, 404, { error: CANDIDATE_MISSING });
    return sendLocalMedia(req, res, { path, type: 'audio/mpeg', sha256: m.audio_qc.asset.sha256 });
  }
  // No mutation_id (rule 9): a replayed resume changes nothing while the rendition is
  // queued, running or finished, and after `failed` it is a fresh resume.
  if (id && action === 'resume' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topic = assertKnownTopic(config.topics, body.topic_slug);
    return sendJson(res, 200, { rendition: await resumeRendition(topic, id) });
  }
  // No mutation_id (rule 9): a replayed publish returns the published rendition unchanged.
  if (id && action === 'publish' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topic = assertKnownTopic(config.topics, body.topic_slug);
    // Only a qc_passed rendition is probed before publishing; a missing file there is named,
    // not left to surface as ffprobe's failure.
    const m = readRendition(topic, id);
    if (m?.stage === 'qc_passed' && !existsSync(join(renditionDir(topic, id), 'candidate.mp3'))) {
      return sendJson(res, 409, { error: CANDIDATE_MISSING });
    }
    return sendJson(res, 200, { rendition: await publishRendition(topic, id, body.full_listen_confirmed) });
  }
  return sendJson(res, 404, { error: 'Podcast render route not found', route: url.pathname });
}

/** Mind map: the true map, and recall runs diffed against it. */
async function handleMindmap(req, res, url) {
  const path = url.pathname.slice('/api/mindmap'.length).replace(/^\//, '');

  if (path === '' && req.method === 'GET') {
    const topicSlug = url.searchParams.get('topic');
    if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic is required' });
    // This is a retrieval preflight, not a reference map. The concept list is authoritative
    // feedback and must not reach the browser until a recall run is on disk.
    return sendJson(res, 200, {
      topic: trueMap(topicSlug).topic,
      sketch_limit_bytes: MAX_SKETCH_BYTES,
      instructions: 'Sketch from memory, then name the concepts you recalled before submitting.',
    });
  }

  if (path === 'run' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
    let recalled = assertArray(body.recalled ?? [], 'recalled', { max: 200 });
    for (const slug of recalled) {
      assertIdentifier(slug, 'recalled concept_slug', { max: 150, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
    }
    if (body.recalled_names !== undefined) {
      const names = assertArray(body.recalled_names, 'recalled_names', { max: 200 })
        .map((name) => assertString(name, 'recalled concept name', { max: 200 }));
      const concepts = trueMap(topicSlug).domains.flatMap((domain) => domain.concepts);
      const byName = new Map(concepts.map((concept) => [concept.name.trim().toLocaleLowerCase(), concept.slug]));
      recalled = names.map((name) => byName.get(name.trim().toLocaleLowerCase()));
      if (recalled.some((slug) => !slug)) {
        return sendJson(res, 400, { error: 'each recalled concept must exactly name a concept you recalled' });
      }
    }

    const mutation = mutationId(body);
    // The sketch is handed over RAW: recordRun writes it only after it has established
    // that this is not a replay, so a retry cannot leave an orphaned copy on disk.
    const { run, missed, total } = recordRun(topicSlug, {
      recalled,
      sketchDataUrl: body.sketch,
      mutationId: mutation,
    });

    const notebookId = notebookForTopic(topicSlug);
    const wantsNote = Boolean(notebookId && body.save_note !== false);

    // A replay can be a lost HTTP response after a successful external write. Rebuild the
    // stored result rather than pretending nothing happened. An ambiguous write is first
    // reconciled by its deterministic title marker; it is never blindly posted again.
    if (run.duplicate) {
      const operation = wantsNote ? findOperationByMutation(topicSlug, mutation, 'mindmap_note') : null;
      if (operation) {
        const outcome = await writeMindmapNote(topicSlug, notebookId, mutation, run, missed, total, operation);
        if (outcome.noteError?.includes('ambiguous')) {
          return sendJson(res, 409, {
            run, missed, total, replayed: true, note: null, error: outcome.noteError,
          });
        }
        return sendJson(res, 200, {
          run, missed, total, replayed: true, note: outcome.note, note_error: outcome.noteError,
        });
      }
      return sendJson(res, 200, { run, missed, total, replayed: true, note: null, note_error: null });
    }

    // The local recall run is already durable. Its optional external note now has its own
    // write-ahead operation so known rejections can resume and unknown outcomes reconcile.
    let note = null;
    let noteError = null;
    if (wantsNote) {
      ({ note, noteError } = await writeMindmapNote(topicSlug, notebookId, mutation, run, missed, total));
    }

    return sendJson(res, 201, { run, missed, total, note, note_error: noteError });
  }

  return sendJson(res, 404, { error: 'not found', route: url.pathname });
}

/**
 * Grade a written answer on the local model and record it.
 *
 * A grading failure is reported as 503 with the "do it in a Claude session" fallback
 * rather than blocking the flow — the study pipeline must survive a cold local model.
 */
const ESSAY_SOURCE_EXCERPT_MAX_CHARS = 12_000;
const ESSAY_SOURCE_ID_MAX_CHARS = 500;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Resolve source evidence on the server, so a browser cannot claim an unrelated source. */
async function resolveEssaySource(topicSlug, sourceId) {
  if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > ESSAY_SOURCE_ID_MAX_CHARS) {
    throw Object.assign(new Error('source_id is required and must name a selected topic source'), { status: 400 });
  }
  const notebookId = notebookForTopic(topicSlug);
  if (!notebookId) {
    throw Object.assign(new Error('this topic has no mapped source notebook for a source-grounded essay'), { status: 400 });
  }
  const listed = await listSources(notebookId);
  const selected = listed.find((source) => source.id === sourceId);
  if (!selected) {
    throw Object.assign(new Error('source_id must belong to the selected topic notebook'), { status: 400 });
  }
  const source = await readSource(sourceId);
  const fullText = source.text.trim();
  if (!fullText) throw Object.assign(new Error('the selected source has no readable text'), { status: 400 });
  const excerpt = fullText.slice(0, ESSAY_SOURCE_EXCERPT_MAX_CHARS);
  return {
    passage: excerpt,
    evidence: {
      source_id: source.id,
      source_title: source.title,
      source_hash: sha256(fullText),
      excerpt_hash: sha256(excerpt),
      excerpt_chars: excerpt.length,
      verification: 'open_notebook',
    },
  };
}

/** Bound user-supplied fallback evidence explicitly when ON is unavailable after recording. */
function normalizeManualSourceEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const reference = typeof item.reference === 'string' ? item.reference.trim().slice(0, 500) : '';
    const passage = typeof item.passage === 'string' ? item.passage.trim().slice(0, ESSAY_SOURCE_EXCERPT_MAX_CHARS) : '';
    if (!reference || !passage) return [];
    return [{
      reference,
      excerpt_hash: sha256(passage),
      excerpt_chars: passage.length,
      verification: 'learner_supplied_offline',
    }];
  });
}

async function handleGrade(req, res) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const question = assertString(body.question, 'question', { max: 4_000 });
  const rubric = assertString(body.rubric, 'rubric', { max: 8_000 });
  const answer = assertString(body.answer, 'answer', { max: 20_000 });
  const max = body.max === undefined ? 5 : assertInteger(body.max, 'max', { min: 1, max: 20 });
  const confidence = body.confidence === undefined ? null : body.confidence;
  if (confidence !== null && !isConfidenceBand(confidence)) {
    return sendJson(res, 400, { error: `confidence must be one of: ${EVIDENCE_POLICY.confidenceBands.join(', ')}` });
  }
  const conceptSlug = optionalString(body.concept_slug, 'concept_slug', { max: 150, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ });
  const sourceId = assertIdentifier(body.source_id, 'source_id', { max: ESSAY_SOURCE_ID_MAX_CHARS });

  if (!knownConcept(topicSlug, conceptSlug)) {
    return sendJson(res, 400, { error: 'concept_slug must belong to the selected topic' });
  }

  const mutation = mutationId(body);
  const alreadyGraded = readAttemptsRaw(topicSlug).find((a) => a.mutation_id === mutation);
  // Checked before the model call: re-grading the same submission burns ~15s of local
  // model time and would record a second, differently-scored attempt for one answer.
  if (alreadyGraded) {
    const stored = findAttempt(topicSlug, alreadyGraded.attempt_id) ?? alreadyGraded;
    if (stored.status === 'grading_pending') {
      return sendJson(res, 409, {
        attempt: { ...stored, duplicate: true }, replayed: true, pending_assessment: true,
        error: 'your answer is recorded but still awaits a manual or external proposed grade',
      });
    }
    return sendJson(res, 200, {
      attempt: { ...findAttempt(topicSlug, stored.attempt_id), duplicate: true },
      grade: gradeForAttempt(stored),
      mastery: stored.status === 'final' ? await heal(topicSlug, stored.attempt_id, null) : null,
      replayed: true,
    });
  }

  const rubricProvenance = {
    prompt_version: 'essay-grade-source-rubric-v2',
    rubric_hash: sha256(rubric),
    grading_method: 'learner-rubric-validated-against-source',
  };

  // Resolve before the model call, but never let an unavailable external service erase
  // the answer the learner has just committed. A semantic source error (unknown source,
  // empty source, unmapped topic) is still rejected before a row exists; an outage
  // records a plainly unverified pending attempt that can later receive bounded manual
  // source evidence. It must not be sent to the model without grounding.
  let source = null;
  let sourceError = null;
  try {
    source = await resolveEssaySource(topicSlug, sourceId);
  } catch (err) {
    if ((err.status ?? 500) < 500) throw err;
    sourceError = err;
  }

  // A model outage must not erase work the learner has committed. This initial row is
  // intentionally ungraded: it cannot affect confidence, stats, cards, or recommendations.
  const attempt = appendAttempt(topicSlug, {
    ts: new Date().toISOString(),
    kind: 'essay',
    attempt_id: randomUUID(),
    revision: 0,
    mutation_id: mutation,
    concept_slug: conceptSlug ?? null,
    question,
    rubric,
    answer,
    max,
    confidence,
    ...(confidence ? { evidence_policy: EVIDENCE_POLICY.version } : {}),
    status: 'grading_pending',
    mastery_applied: false,
    assessor_type: 'local_model',
    prompt_version: rubricProvenance.prompt_version,
    source_evidence: source ? [source.evidence] : [],
    ...(source ? {} : { source_request: { source_id: sourceId, verification: 'pending_open_notebook' } }),
    rubric_provenance: rubricProvenance,
  });

  // Concurrent requests can both pass the raw-log check above before either append. The
  // second append returns the durable first row; do not send a second model request.
  if (attempt.duplicate) {
    const stored = findAttempt(topicSlug, attempt.attempt_id) ?? attempt;
    if (stored.status === 'grading_pending') {
      return sendJson(res, 409, {
        attempt: { ...stored, duplicate: true }, replayed: true, pending_assessment: true,
        error: 'your answer is recorded but still awaits a manual or external proposed grade',
      });
    }
    return sendJson(res, 200, { attempt: { ...stored, duplicate: true }, grade: gradeForAttempt(stored), replayed: true });
  }

  if (sourceError) {
    return sendJson(res, sourceError.status ?? 503, {
      error: `${sourceError.message}. Your answer was recorded; add bounded source evidence and a manual or external proposed grade to resume.`,
      attempt: { attempt_id: attempt.attempt_id, kind: attempt.kind, status: attempt.status },
    });
  }

  let graded;
  try {
    graded = await gradeEssay({
      question, rubric, answer, max,
      sourcePassage: source.passage,
      sourceReference: source.evidence.source_title,
    });
  } catch (err) {
    // The answer commit is durable even when the model is not. Return only its resumable
    // identity, not the stored answer or rubric, so the browser can offer a manual or
    // external proposal without fabricating a grade or needing to rediscover the row.
    return sendJson(res, err.status ?? 502, {
      error: err.message,
      attempt: { attempt_id: attempt.attempt_id, kind: attempt.kind, status: attempt.status },
    });
  }
  const provisional = appendAttempt(topicSlug, {
    ...attempt,
    ts: new Date().toISOString(),
    revision: 1,
    mutation_id: `${mutation}:proposal`,
    score: graded.score,
    max: graded.max,
    misses: [],
    grade_feedback: graded.feedback,
    grading_model: graded.model,
    provisional_grade: graded,
    criterion_feedback: graded.criterion_feedback,
    status: 'pending_confirmation',
  });

  return sendJson(res, 201, { attempt: provisional, grade: graded, mastery: null });
}

function gradeForAttempt(attempt) {
  const grade = attempt.provisional_grade;
  if (!grade && attempt.score === undefined) return null;
  return {
    score: attempt.score,
    max: attempt.max,
    feedback: attempt.grade_feedback ?? grade?.feedback ?? '',
    model: attempt.grading_model ?? grade?.model ?? null,
  };
}

function assessmentMutationReplay(topicSlug, mutation, attemptId) {
  const raw = readAttemptsRaw(topicSlug).find((row) => row.mutation_id === mutation);
  if (raw && raw.attempt_id !== attemptId) {
    throw Object.assign(new Error('mutation_id belongs to a different attempt'), { status: 409 });
  }
  return raw ? findAttempt(topicSlug, raw.attempt_id) ?? raw : null;
}

/** Accept, correct, or dispute an essay's model proposal. Only final records may settle. */
async function handleConfirmGrade(req, res, attemptId) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  attemptId = assertIdentifier(attemptId, 'attempt_id');
  const { action } = body;
  const mutation = mutationId(body);
  const replay = assessmentMutationReplay(topicSlug, mutation, attemptId);
  if (replay) return sendJson(res, 200, { attempt: { ...replay, duplicate: true }, grade: gradeForAttempt(replay), replayed: true });

  const attempt = findAttempt(topicSlug, attemptId);
  if (!attempt || attempt.kind !== 'essay') return sendJson(res, 404, { error: 'unknown essay attempt', attempt_id: attemptId });
  if (attempt.status === 'final') {
    return sendJson(res, 200, { attempt, grade: gradeForAttempt(attempt), already_final: true, mastery: await heal(topicSlug, attemptId, null) });
  }
  if (attempt.status !== 'pending_confirmation') {
    return sendJson(res, 409, { error: `essay attempt is ${attempt.status}; it has no model proposal to confirm` });
  }
  if (!['accept', 'correct', 'dispute'].includes(action)) {
    return sendJson(res, 400, { error: "action must be 'accept', 'correct', or 'dispute'" });
  }

  const rationale = optionalString(body.rationale, 'rationale', { max: 2_000 }) ?? '';
  if (action === 'correct' && !rationale) return sendJson(res, 400, { error: 'a correction rationale is required' });
  if (action === 'dispute') {
    const disputed = appendAttempt(topicSlug, {
      ...attempt, ts: new Date().toISOString(), revision: (Number(attempt.revision) || 0) + 1,
      mutation_id: mutation, status: 'disputed', mastery_applied: false,
      learner_confirmation: { action, rationale: rationale || null, ts: new Date().toISOString() },
    });
    return sendJson(res, 201, { attempt: disputed, grade: gradeForAttempt(disputed), mastery: null });
  }

  let score = attempt.score;
  if (action === 'correct') {
    score = assertInteger(body.score, 'score', { min: 0, max: attempt.max });
  }
  const final = appendAttempt(topicSlug, {
    ...attempt, ts: new Date().toISOString(), revision: (Number(attempt.revision) || 0) + 1,
    mutation_id: mutation, score, status: 'final', mastery_applied: false,
    learner_confirmation: { action, rationale: rationale || null, ts: new Date().toISOString() },
  });
  if (final.duplicate) {
    const stored = findAttempt(topicSlug, attemptId) ?? final;
    return sendJson(res, 200, { attempt: { ...stored, duplicate: true }, grade: gradeForAttempt(stored), replayed: true });
  }
  const mastery = final.concept_slug ? await settle(topicSlug, final, { score: final.score, max: final.max }) : null;
  return sendJson(res, 201, { attempt: final, grade: gradeForAttempt(final), mastery });
}

/** Record a bounded manual/external proposal when the local model is unavailable. */
async function handleProposeGrade(req, res, attemptId) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  attemptId = assertIdentifier(attemptId, 'attempt_id');
  const mutation = mutationId(body);
  const replay = assessmentMutationReplay(topicSlug, mutation, attemptId);
  if (replay) return sendJson(res, 200, { attempt: { ...replay, duplicate: true }, grade: gradeForAttempt(replay), replayed: true });
  const attempt = findAttempt(topicSlug, attemptId);
  if (!attempt || attempt.kind !== 'essay') return sendJson(res, 404, { error: 'unknown essay attempt', attempt_id: attemptId });
  if (attempt.status !== 'grading_pending') return sendJson(res, 409, { error: `essay attempt is ${attempt.status}; it cannot receive a new proposal` });
  const score = assertInteger(body.score, 'score', { min: 0, max: attempt.max });
  const feedback = assertString(body.feedback, 'feedback', { max: 4_000 });
  const assessorType = body.assessor_type === 'external_agent' ? 'external_agent' : 'manual';
  const suppliedEvidence = normalizeManualSourceEvidence(body.source_evidence);
  const sourceEvidence = Array.isArray(attempt.source_evidence) && attempt.source_evidence.length > 0
    ? attempt.source_evidence
    : suppliedEvidence;
  if (sourceEvidence.length === 0) {
    return sendJson(res, 400, { error: 'bounded source_evidence is required when the recorded attempt has no verified source' });
  }
  const proposed = appendAttempt(topicSlug, {
    ...attempt, ts: new Date().toISOString(), revision: (Number(attempt.revision) || 0) + 1,
    mutation_id: mutation, score, misses: [], status: 'pending_confirmation',
    grade_feedback: feedback, grading_model: null, assessor_type: assessorType,
    provisional_grade: { score, max: attempt.max, feedback, model: null, criterion_feedback: [] },
    criterion_feedback: [],
    source_evidence: sourceEvidence,
  });
  return sendJson(res, 201, { attempt: proposed, grade: gradeForAttempt(proposed), mastery: null });
}

/**
 * Walk debrief: capture-back text becomes an ON note and a set of cards.
 *
 * The note is saved FIRST and independently. The spec makes capture-back mandatory, so
 * losing the text because a model was cold would be the worst possible failure.
 *
 * Identity is per SUBMISSION, not per day. Card ids used to be
 * `card-debrief-<date>-<position>` with positions restarting at 1 every time, so a second
 * debrief on the same day collided with the first one's ids and its cards were silently
 * skipped — losing exactly the misconceptions this step exists to capture. Each debrief
 * now gets its own id, and a repeated `mutation_id` replays the recorded outcome instead
 * of creating a second note and a second set of cards.
 */
async function handleDebrief(req, res) {
  const body = await readJsonBody(req);
  const { topic_slug: topicSlug, text } = body;

  if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });
  if (!text?.trim()) return sendJson(res, 400, { error: 'text is required' });

  const mutation = mutationId(body);
  const normalizedText = text.trim();
  const inputHash = debriefInputHash(normalizedText, body.concept_slug ?? null);
  let operation = findOperationByMutation(topicSlug, mutation, 'debrief');
  if (operation) {
    if (operation.input_hash !== inputHash) {
      return sendJson(res, 409, { error: 'mutation_id belongs to a debrief with different input' });
    }
    if (operation.stage === 'complete') {
      return sendJson(res, 200, { replayed: true, ...replayedDebriefOperation(topicSlug, operation) });
    }
    if ((operation.stage === 'prepared' || operation.stage === 'ambiguous')
      && !debriefsInFlight.has(`${topicSlug}:${mutation}`)) {
      return sendJson(res, 409, {
        replayed: true,
        ...replayedDebriefOperation(topicSlug, operation),
        error: 'the previous Open Notebook note outcome is ambiguous; inspect recovery before retrying it',
      });
    }
  } else {
    // Pre-operation-ledger history is a completed, immutable result. Keep its established
    // replay contract instead of treating it as an unfinished transaction.
    const replay = findDebriefByMutation(topicSlug, mutation);
    if (replay) return sendJson(res, 200, { replayed: true, ...replayedDebrief(topicSlug, replay) });
  }

  // The durable operation begins before the first external write. The in-flight share is
  // still needed for two tabs in this process; the operation is what survives a restart.
  const { result, shared } = await shareInFlight(debriefsInFlight, `${topicSlug}:${mutation}`, () =>
    runDebrief(topicSlug, {
      text: normalizedText, mutation, conceptSlug: body.concept_slug ?? null, inputHash, operation,
    }));

  const status = shared || operation ? 200 : result.status ?? 201;
  return sendJson(res, status, shared || operation ? { replayed: true, ...result } : result);
}

/** In-flight debrief submissions, keyed `topic:mutation`. */
const debriefsInFlight = new Map();

/** The stored outcome of a debrief that already ran, rebuilt from the ledger. */
function replayedDebrief(topicSlug, entry) {
  const cards = readCards(topicSlug);
  return {
    debrief_id: entry.debrief_id,
    note: entry.note_id ? { id: entry.note_id } : null,
    note_error: entry.note_error ?? null,
    created_cards: cards.filter((c) => entry.card_ids.includes(c.id)),
    cards_error: entry.cards_error ?? null,
  };
}

const debriefInputHash = (text, conceptSlug) => createHash('sha256')
  .update(JSON.stringify({ text, concept_slug: conceptSlug ?? null }))
  .digest('hex');

// Stable across process restarts, but not a copy of the learner's capture-back text.
const debriefIdentity = (topicSlug, mutation) => createHash('sha256')
  .update(`${topicSlug}\0${mutation}`)
  .digest('hex');

function newDebriefOperation(topicSlug, mutation, inputHash) {
  const identity = debriefIdentity(topicSlug, mutation);
  return appendOperation(topicSlug, {
    operation_id: `debrief-operation-${identity}`,
    origin_mutation_id: mutation,
    mutation_id: `${mutation}:debrief:started`,
    revision: 0,
    ts: new Date().toISOString(),
    kind: 'debrief',
    topic_slug: topicSlug,
    input_hash: inputHash,
    stage: 'started',
    local_result: {
      debrief_id: identity.slice(0, 24),
      date: todayISO(),
      card_ids: [],
      note_error: null,
      cards_error: null,
    },
  });
}

/** Append the next durable revision; operation state is never rewritten in place. */
function reviseDebriefOperation(topicSlug, operation, changes) {
  const revision = (Number(operation.revision) || 0) + 1;
  const next = {
    ...operation,
    ...changes,
    revision,
    ts: new Date().toISOString(),
    mutation_id: `${operation.origin_mutation_id}:debrief:${revision}:${changes.stage ?? operation.stage}`,
    local_result: { ...(operation.local_result ?? {}), ...(changes.local_result ?? {}) },
  };
  return appendOperation(topicSlug, next);
}

function debriefCardsOnDisk(topicSlug, debriefId, ids = []) {
  const byId = new Set(ids);
  const prefix = `debrief:${debriefId}:`;
  return readCards(topicSlug).filter((card) => byId.has(card.id) || card.source_ref?.startsWith(prefix));
}

function replayedDebriefOperation(topicSlug, operation) {
  const local = operation.local_result ?? {};
  const cards = debriefCardsOnDisk(topicSlug, local.debrief_id, local.card_ids);
  const ambiguous = operation.stage === 'prepared' || operation.stage === 'ambiguous';
  return {
    debrief_id: local.debrief_id,
    note: operation.external?.note_id ? { id: operation.external.note_id } : null,
    note_error: local.note_error ?? (ambiguous ? 'Open Notebook note outcome is ambiguous' : null),
    created_cards: cards,
    cards_error: local.cards_error ?? null,
  };
}

async function runDebrief(topicSlug, { text, mutation, conceptSlug, inputHash, operation }) {
  let current = operation ?? newDebriefOperation(topicSlug, mutation, inputHash);
  const local = current.local_result;
  const debriefId = local.debrief_id;

  if (current.stage === 'complete') return replayedDebriefOperation(topicSlug, current);
  if (current.stage === 'prepared' || current.stage === 'ambiguous') {
    return { status: 409, ...replayedDebriefOperation(topicSlug, current) };
  }

  const notebookId = notebookForTopic(topicSlug);
  if (notebookId && !current.external?.note_id) {
    // Once this revision exists, the next POST may have reached ON even if this process
    // dies before it observes the response. A later retry must reconcile, never POST again.
    current = reviseDebriefOperation(topicSlug, current, { stage: 'prepared' });
    try {
      const note = await createNote({
        notebookId,
        title: `Walk debrief ${local.date} · ${shortDebriefId(debriefId)}`,
        content: text,
      });
      current = reviseDebriefOperation(topicSlug, current, {
        stage: 'external_created', external: { note_id: note.id }, error: null,
      });
    } catch {
      current = reviseDebriefOperation(topicSlug, current, {
        stage: 'ambiguous',
        error: { classification: 'open_notebook_note_outcome_unknown' },
        local_result: { note_error: 'Open Notebook note outcome is ambiguous' },
      });
      // The local card work is safe and still useful. It is recorded beneath the ambiguous
      // state, but cannot make the operation complete or make its note retryable.
      return await finishDebriefCards(topicSlug, current, { text, conceptSlug, status: 503 });
    }
  } else if (!notebookId && !current.external?.note_id) {
    current = reviseDebriefOperation(topicSlug, current, {
      local_result: { note_error: 'no Open Notebook notebook is mapped to this topic' },
    });
  }

  return await finishDebriefCards(topicSlug, current, { text, conceptSlug });
}

async function finishDebriefCards(topicSlug, operation, { text, conceptSlug, status = null }) {
  let current = operation;
  const local = current.local_result;
  const existing = debriefCardsOnDisk(topicSlug, local.debrief_id, local.card_ids);
  let created = existing;

  if (existing.length === 0) {
    try {
      const drafted = await cardsFromDebrief(text);
      const cards = readCards(topicSlug);
      created = buildDebriefCards(drafted, {
        debriefId: local.debrief_id,
        date: local.date,
        existingIds: new Set(cards.map((card) => card.id)),
        conceptSlug,
      });
      if (created.length > 0) writeCards(topicSlug, [...cards, ...created]);
    } catch {
      current = reviseDebriefOperation(topicSlug, current, {
        // An ambiguous note stays ambiguous: the note may exist in ON with its response lost,
        // and a failed_known retry with no note id would post it again.
        stage: current.stage === 'ambiguous' ? 'ambiguous' : 'failed_known',
        error: { classification: 'debrief_card_draft_failed' },
        local_result: { cards_error: 'card drafting failed; retry can resume this known-missing local stage' },
      });
      return { status: 503, ...replayedDebriefOperation(topicSlug, current) };
    }
  }

  current = reviseDebriefOperation(topicSlug, current, {
    // An ambiguous note stays ambiguous even when card work succeeds.
    stage: current.stage === 'ambiguous' ? 'ambiguous' : 'local_written',
    local_result: { card_ids: created.map((card) => card.id), cards_error: null },
  });

  if (current.stage === 'ambiguous') return { status: status ?? 503, ...replayedDebriefOperation(topicSlug, current) };

  current = reviseDebriefOperation(topicSlug, current, { stage: 'complete', error: null });
  appendDebrief(topicSlug, {
    mutation_id: current.origin_mutation_id,
    debrief_id: current.local_result.debrief_id,
    ts: new Date().toISOString(),
    date: current.local_result.date,
    note_id: current.external?.note_id ?? null,
    note_error: current.local_result.note_error ?? null,
    card_ids: current.local_result.card_ids,
    cards_error: current.local_result.cards_error ?? null,
  });
  return replayedDebriefOperation(topicSlug, current);
}

/**
 * Schedule control: mark a stage done, walk that back, start a topic, pause/resume it.
 *
 * Completion is RECORDED, never inferred (assessment finding F1). The calendar decides
 * when a stage becomes available and nothing else; before this existed, the cockpit read
 * "done" off the date and an unfinished stage silently disappeared once a later one came
 * due. Undo is an event rather than a deletion, so a stage marked done in error leaves a
 * trace instead of a gap.
 *
 * Nothing here touches state.json, so no topic lock is involved.
 */
/**
 * A calendar date that exists: the shape parses AND survives a round trip.
 *
 * The NaN guard is not decoration — `new Date('2026-13-01T00:00:00Z').toISOString()`
 * throws RangeError, so checking the round trip alone turns a bad request into a 500.
 */
function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function handleSchedule(req, res, url) {
  const path = url.pathname.slice('/api/schedule/'.length);
  const body = await readJsonBody(req);
  const topicSlug = body.topic_slug;

  if (!knownTopic(topicSlug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });

  if (path === 'stage' && req.method === 'POST') {
    const key = body.milestone_key;
    if (!MILESTONES.some((m) => m.key === key)) {
      return sendJson(res, 400, { error: 'unknown milestone_key', milestone_key: key });
    }
    if (body.action !== 'complete' && body.action !== 'undo') {
      return sendJson(res, 400, { error: "action must be 'complete' or 'undo'" });
    }

    const event = appendStageEvent(topicSlug, {
      ts: new Date().toISOString(),
      mutation_id: mutationId(body),
      milestone_key: key,
      action: body.action,
      ...(body.note?.trim() ? { note: body.note.trim() } : {}),
    });
    return sendJson(res, event.duplicate ? 200 : 201, event);
  }

  if (path === 'start' && req.method === 'POST') {
    const started = body.started ?? todayISO();
    // Round-tripped, not just shape-checked: 2026-02-31 matches the pattern but is not a
    // date, so dateForDay would return null for every milestone and the topic would look
    // "not running" while schedule.started was set — a state with no visible cause.
    if (!isRealDate(started)) {
      return sendJson(res, 400, { error: 'started must be a real YYYY-MM-DD date' });
    }
    const schedule = { ...readSchedule(topicSlug), started, paused: false };
    writeSchedule(topicSlug, schedule);
    return sendJson(res, 200, schedule);
  }

  // Restarts the pipeline on the same notebook: a new day 0, no reschedules, and every
  // completed stage reopened. Unlike start, this carries a mutation_id, because reopening
  // APPENDS undo events (rule 9). Attempts, reviews and mastery are history, not schedule,
  // and are deliberately left alone.
  //
  // A finished reset ends with a `reset` marker under the request's own id; the fold skips
  // it because it names no milestone. A replay that finds the marker changes nothing: by
  // then a stage may have been completed or a date moved, and re-running would undo that
  // work. A replay of an INTERRUPTED reset (no marker yet) re-runs it, and the per-stage
  // ids keep the undos it already wrote from landing twice.
  if (path === 'reset' && req.method === 'POST') {
    const mutation = mutationId(body);
    const started = body.started ?? todayISO();
    if (!isRealDate(started)) {
      return sendJson(res, 400, { error: 'started must be a real YYYY-MM-DD date' });
    }

    const finished = readStageEvents(topicSlug).find((e) => e.mutation_id === mutation && e.action === 'reset');
    if (finished) {
      const schedule = readSchedule(topicSlug);
      const states = stageStatesFor(schedule, readStageEvents(topicSlug));
      return sendJson(res, 200, {
        schedule,
        reopened: finished.reopened ?? [],
        duplicate: true,
        stages: states.map((s) => ({ key: s.key, due_date: s.due_date, state: s.state, complete: s.complete })),
      });
    }

    const reopened = [];
    for (const [key, stage] of foldStageEvents(readStageEvents(topicSlug))) {
      if (!stage.complete) continue;
      appendStageEvent(topicSlug, {
        ts: new Date().toISOString(),
        mutation_id: `${mutation}:${key}`,
        milestone_key: key,
        action: 'undo',
        note: 'schedule reset',
      });
      reopened.push(key);
    }

    const schedule = { ...readSchedule(topicSlug), started, paused: false, step_overrides: {} };
    writeSchedule(topicSlug, schedule);
    appendStageEvent(topicSlug, {
      ts: new Date().toISOString(), mutation_id: mutation, action: 'reset', started, reopened,
    });
    const states = stageStatesFor(schedule, readStageEvents(topicSlug));
    return sendJson(res, 200, {
      schedule,
      reopened,
      stages: states.map((s) => ({ key: s.key, due_date: s.due_date, state: s.state, complete: s.complete })),
    });
  }

  // Moves a NOT-BEFORE date. Carries no mutation_id, like start and pause and for the same
  // reason (rule 9): it sets a value rather than appending a record, so a replay rewrites
  // the identical file. It emphatically does not record progress — see the guard below.
  if (path === 'reschedule' && req.method === 'POST') {
    const existing = readSchedule(topicSlug);
    if (!existing.started || existing.paused) {
      return sendJson(res, 409, { error: 'the topic is not running — start it before rescheduling' });
    }

    let overrides;
    if (body.from) {
      // Re-anchor the whole remaining pipeline. The case this exists for: come back from a
      // fortnight away and every stage is owed at once, which is honest but tells you to do
      // nine things today.
      if (!isRealDate(body.from)) return sendJson(res, 400, { error: 'from must be a real YYYY-MM-DD date' });
      overrides = reanchorOverrides(existing, readStageEvents(topicSlug), body.from);
    } else if (body.milestone_key) {
      if (!MILESTONES.some((m) => m.key === body.milestone_key)) {
        return sendJson(res, 400, { error: 'unknown milestone_key', milestone_key: body.milestone_key });
      }
      // null clears an override and restores the stage to the spec's own date.
      if (body.date === null) {
        overrides = { ...(existing.step_overrides ?? {}) };
        delete overrides[body.milestone_key];
      } else {
        if (!isRealDate(body.date)) return sendJson(res, 400, { error: 'date must be a real YYYY-MM-DD date' });
        overrides = { ...(existing.step_overrides ?? {}), [body.milestone_key]: body.date };
      }
    } else {
      return sendJson(res, 400, { error: 'either from, or milestone_key with a date, is required' });
    }

    const schedule = { ...existing, step_overrides: overrides };
    writeSchedule(topicSlug, schedule);
    // Returned so the caller can see that moving a date changed no completion: a
    // reschedule that appeared to tick something off would be hard rule 11 inverted.
    const states = stageStatesFor(schedule, readStageEvents(topicSlug));
    return sendJson(res, 200, {
      schedule,
      stages: states.map((s) => ({
        key: s.key,
        due_date: s.due_date,
        scheduled_date: s.scheduled_date,
        rescheduled: s.rescheduled,
        state: s.state,
        complete: s.complete,
      })),
    });
  }

  if (path === 'pause' && req.method === 'POST') {
    if (typeof body.paused !== 'boolean') {
      return sendJson(res, 400, { error: 'paused must be true or false' });
    }
    // Resuming a topic that was never started puts it on the clock from today; otherwise
    // the original start date stands, so the stages it owes stay owed.
    const existing = readSchedule(topicSlug);
    const schedule = {
      ...existing,
      paused: body.paused,
      started: existing.started ?? (body.paused ? null : todayISO()),
    };
    writeSchedule(topicSlug, schedule);
    return sendJson(res, 200, schedule);
  }

  return sendJson(res, 404, { error: 'not found', route: url.pathname });
}

/** Learner-only characterization; it never changes the source attempt or mastery. */
async function handleMisconceptionCharacterization(req, res, candidateId) {
  const body = await readJsonBody(req);
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  candidateId = assertIdentifier(candidateId, 'candidate_id');
  const action = body.action;
  const allowed = ['confirmed_misconception', 'classified_slip', 'dismissed_item_defect', 'dismissed_grading_defect'];
  if (!allowed.includes(action)) return sendJson(res, 400, { error: `action must be one of: ${allowed.join(', ')}` });
  const rationale = assertString(body.rationale, 'rationale', { max: 2_000 });
  const candidate = misconceptionCandidates(readAttempts(topicSlug), readMisconceptionEvents(topicSlug))
    .find((item) => item.id === candidateId);
  if (!candidate) return sendJson(res, 404, { error: 'unknown misconception candidate', candidate_id: candidateId });
  const event = appendMisconceptionEvent(topicSlug, {
    ts: new Date().toISOString(),
    mutation_id: mutationId(body),
    candidate_id: candidate.id,
    attempt_id: candidate.attempt_id,
    question_id: candidate.question_id,
    concept_slug: candidate.concept_slug,
    action,
    rationale,
    policy: EVIDENCE_POLICY.version,
  });
  return sendJson(res, event.duplicate ? 200 : 201, event);
}

/** Where you are in a source. Cockpit-owned state, not ON's. */
async function handleReading(req, res) {
  const body = await readJsonBody(req);
  if (!knownTopic(body.topic_slug)) return sendJson(res, 400, { error: 'a known topic_slug is required' });
  const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
  const sourceId = assertIdentifier(body.source_id, 'source_id');
  const position = assertFiniteNumber(body.position, 'position', { min: 0, max: 1 });
  const title = optionalString(body.title, 'title', { max: 500 });
  return sendJson(res, 200, writeReadingPosition(topicSlug, sourceId, position, { title }));
}

function parseTarget(req) {
  try {
    return new URL(req.url, `http://${config.server.host}:${config.server.port}`);
  } catch {
    throw Object.assign(new Error('request target is not a valid URL'), { status: 400 });
  }
}

/**
 * The path a request asked for, for the log line of one that never got a parsed URL: the
 * guard refused it, or its target is not a URL. pathname only, never the query string, and
 * URL strips CR/LF and percent-encodes other controls, so a target cannot forge a log line.
 * Never throws: it runs inside the handler's catch, where a throw would lose the refusal.
 */
function loggedPath(req) {
  try {
    return new URL(req.url, `http://${config.server.host}:${config.server.port}`).pathname;
  } catch {
    return '(unparsed)';
  }
}

/**
 * Route one request. Shaped exactly as `http.createServer` wants, so it is both the
 * live server's handler and the unit under test — there is no second, test-only code
 * path that could drift from what actually serves the browser.
 */
export const handleRequest = async (req, res) => {
  // Parsed inside the try, after the guard: a target that is not a URL is a 400 for a caller
  // the boundary admitted, never an unhandled rejection reachable by any caller at all.
  let url;

  // Before the try, and before any routing: set once here and every response carries them,
  // including the ones written by the catch below and by routes that do not exist yet.
  // `writeHead(status, {...})` merges with what setHeader already staged, so no call site
  // has to know about this.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  try {
    // Loopback is a network boundary, not an identity — see lib/guard.mjs.
    assertBrowserBoundary(req);
    url = parseTarget(req);

    if (url.pathname === '/api/recovery' && req.method === 'GET') return sendJson(res, 200, recoveryList());
    if (url.pathname === '/api/recovery/settle' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
      const attemptId = assertIdentifier(body.attempt_id, 'attempt_id');
      const outcome = await settleRecoveryItem(topicSlug, attemptId);
      return sendJson(res, outcome.status, outcome.body);
    }
    if (url.pathname === '/api/recovery/reconcile' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
      const operationId = assertIdentifier(body.operation_id, 'operation_id');
      const outcome = await reconcileRecoveryOperation(topicSlug, operationId);
      return sendJson(res, outcome.status, outcome.body);
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      // The `date` override exists so schedule math can be exercised for any day
      // without touching the clock — used by the M0 verification script.
      const override = url.searchParams.get('date');
      return sendJson(res, 200, buildState(override ?? undefined));
    }

    if (url.pathname === '/api/notebooks' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const notebook = await createStudyNotebook(body.name);
      return sendJson(res, 201, notebook);
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      // Storage integrity is reported here, not just logged. A sidecar recovered from
      // backup, a torn JSONL line, or a temp file left by a crashed write all look like
      // "no data" in the UI; a terminal log line nobody is watching is not a diagnostic.
      const integrity = config.topics.map((t) => ({
        topic_slug: t.slug,
        lock: lockStatus(t.slug),
        ...inspectSidecars(t.slug),
        // Decks live in `.learn/`, not the cockpit sidecar, so inspectSidecars cannot see
        // them — and a corrupt deck was the one corruption with no report at all (F12).
        unreadable_decks: listDecks(t.slug)
          .filter((d) => d.unreadable)
          .map((d) => ({
            file: d.file, concept_slug: d.concept_slug, error: d.unreadable,
            // 'parse' (the content is damaged) or 'io' (we could not read it at all) — the
            // banner words them differently because they need different actions.
            kind: d.unreadable_kind,
          })),
      }));
      const degraded = integrity.filter(
        (t) => t.degraded.length > 0 || t.unparseable_lines > 0
          || t.stale_temp_files.length > 0 || t.unreadable_decks.length > 0
          // Partial commits: counted in inspectSidecars long before anything acted on them.
          || t.operations.unresolved > 0
          || t.attempts.mastery_unapplied > 0 || t.attempts.mastery_ambiguous > 0
          || t.attempts.factcheck_cards_owed > 0,
      );
      return sendJson(res, 200, {
        status: degraded.length > 0 ? 'degraded' : 'ok',
        ...configSummary(),
        integrity,
      });
    }

    if (url.pathname === '/api/decks' && req.method === 'GET') {
      return sendJson(res, 200, config.topics.flatMap((t) => listDecks(t.slug)));
    }

    if (url.pathname.startsWith('/api/decks/')) {
      const segments = url.pathname.slice('/api/decks/'.length).split('/').map(safeDecode);
      if (segments.length < 2) return sendJson(res, 404, { error: 'not found', route: url.pathname });
      return await handleDeckRoute(req, res, url, segments);
    }

    if (url.pathname.startsWith('/api/practice/') && req.method === 'GET') {
      const segments = url.pathname.slice('/api/practice/'.length).split('/').map(safeDecode);
      if (segments.length !== 3) return sendJson(res, 404, { error: 'not found', route: url.pathname });
      return handlePracticeRoute(res, segments);
    }

    if (url.pathname === '/api/practice/reveal' && req.method === 'POST') {
      return await handlePracticeReveal(req, res);
    }

    if (url.pathname === '/api/practice/evidence' && req.method === 'POST') {
      return await handlePracticeEvidence(req, res);
    }

    if (url.pathname === '/api/teachbacks' && req.method === 'POST') {
      return await handleTeachback(req, res);
    }

    if (url.pathname === '/api/practice/scaffold') {
      // Project-mode artifact creation belongs to the external learn-anything harness.
      // Leaving a convenient browser writer here would make the index a second, divergent
      // author of exercise files and re-open the symlink/write boundary it no longer needs.
      return sendJson(res, 404, { error: 'practice scaffolding is performed by /learn-practice outside the browser' });
    }

    if (url.pathname === '/api/attempts' && req.method === 'POST') {
      return await handleAttempts(req, res);
    }

    if (url.pathname.startsWith('/api/attempts/') && req.method === 'POST') {
      const [attemptId, action] = url.pathname.slice('/api/attempts/'.length).split('/').map(safeDecode);
      if (!attemptId) {
        return sendJson(res, 404, { error: 'not found', route: url.pathname });
      }
      if (action === 'finalize') return await handleFinalizeAttempt(req, res, attemptId);
      if (action === 'confirm-grade') return await handleConfirmGrade(req, res, attemptId);
      if (action === 'propose-grade') return await handleProposeGrade(req, res, attemptId);
      return sendJson(res, 404, { error: 'not found', route: url.pathname });
    }

    const misconceptionMatch = /^\/api\/misconceptions\/([^/]+)\/characterize$/.exec(url.pathname);
    if (misconceptionMatch && req.method === 'POST') {
      return await handleMisconceptionCharacterization(req, res, safeDecode(misconceptionMatch[1]));
    }

    if (url.pathname === '/api/cards/sync' && req.method === 'POST') {
      // Explicit backfill for misses recorded before cards existed. Deliberately a
      // POST the user triggers, not a side effect of reading state.
      const body = await readJsonBody(req);
      const slugs = Object.hasOwn(body, 'topic_slug')
        ? [assertKnownTopic(config.topics, body.topic_slug)]
        : config.topics.map((t) => t.slug);
      const created = slugs.flatMap((slug) => syncCardsFromAttempts(slug));
      return sendJson(res, 201, { created });
    }

    if (url.pathname === '/api/cards' && req.method === 'POST') {
      return await handleCards(req, res);
    }

    if (url.pathname === '/api/reviews' && req.method === 'POST') {
      return await handleReviews(req, res);
    }

    if (url.pathname.startsWith('/api/on/')) {
      return await handleOnRoute(req, res, url);
    }

    if (url.pathname === '/api/tts/voices' && req.method === 'GET') {
      // Not under /api/on/ — these come from Speaches, a different service. Routing
      // them together would imply Open Notebook knows about voices, and it does not.
      return sendJson(res, 200, await listVoices());
    }

    if (url.pathname.startsWith('/api/schedule/') && req.method === 'POST') {
      return await handleSchedule(req, res, url);
    }

    if (url.pathname === '/api/reading' && req.method === 'POST') {
      return await handleReading(req, res);
    }

    if (url.pathname === '/api/grade' && req.method === 'POST') {
      return await handleGrade(req, res);
    }

    if (url.pathname === '/api/debrief' && req.method === 'POST') {
      return await handleDebrief(req, res);
    }

    if (url.pathname === '/api/grader/health' && req.method === 'GET') {
      return sendJson(res, 200, await ollamaHealth());
    }

    // 200 whether or not the Claude API is there: reporting the outage is this probe's
    // success, exactly as /api/on/health does.
    if (url.pathname === '/api/roles/health' && req.method === 'GET') {
      return sendJson(res, 200, await claudeHealth());
    }

    if (url.pathname.startsWith('/api/roles/')) {
      return await handleRoles(req, res, url);
    }

    if (url.pathname.startsWith('/api/factcheck')) {
      return await handleFactcheck(req, res, url);
    }

    if (url.pathname.startsWith('/api/mindmap')) {
      return await handleMindmap(req, res, url);
    }

    if (url.pathname === '/api/podcast/renders' || url.pathname.startsWith('/api/podcast/renders/')) {
      return await handlePodcastRenders(req, res, url);
    }

    if (url.pathname.startsWith('/media/sketches/')) {
      // Sketches live per topic; the request carries topic + file, both matched
      // against real directory contents rather than concatenated blindly.
      const [topicSlug, file] = url.pathname.slice('/media/sketches/'.length).split('/').map(safeDecode);
      // No .svg — active content served from this origin. saveSketch refuses to store one,
      // and no SVG sketch was ever written, so nothing on disk is orphaned by dropping it.
      if (!knownTopic(topicSlug) || !file || !/^sketch-[\w.-]+\.(png|jpg|webp)$/.test(file)) {
        return sendJson(res, 404, { error: 'no such sketch' });
      }
      const path = join(cockpitDir(topicSlug), 'sketches', file);
      if (!existsSync(path)) return sendJson(res, 404, { error: 'no such sketch' });
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return pipeFile(res, path);
    }

    if (url.pathname === '/api/videos/higgsfield' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: higgsfieldService.list() });
    }

    if (url.pathname === '/api/videos/higgsfield/prepare' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
      const notebookId = notebookForTopic(topicSlug);
      if (!notebookId) return sendJson(res, 400, { error: 'this topic has no mapped notebook' });
      const job = higgsfieldService.start({ topicSlug, topicName: readTopicState(topicSlug)?.topic ?? topicSlug,
        notebookId, mutationId: mutationId(body) });
      return sendJson(res, 202, job);
    }

    if (url.pathname.startsWith('/api/videos/higgsfield/') && req.method === 'GET') {
      const job = higgsfieldService.get(safeDecode(url.pathname.slice('/api/videos/higgsfield/'.length)));
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'no such Higgsfield storyboard' });
    }

    if (url.pathname === '/api/videos/jobs' && req.method === 'GET') {
      return sendJson(res, 200, {
        notebooks: config.topics.filter((topic) => topic.notebookId).map((topic) => ({
          slug: topic.slug, name: readTopicState(topic.slug)?.topic ?? topic.slug,
        })),
        jobs: videoService.list(),
      });
    }

    if (url.pathname === '/api/videos/generate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const topicSlug = assertKnownTopic(config.topics, body.topic_slug);
      const notebookId = notebookForTopic(topicSlug);
      if (!notebookId) return sendJson(res, 400, { error: 'this topic has no mapped notebook' });
      const job = videoService.start({ topicSlug, topicName: readTopicState(topicSlug)?.topic ?? topicSlug,
        notebookId, mutationId: mutationId(body) });
      return sendJson(res, 202, job);
    }

    if (url.pathname.startsWith('/api/videos/jobs/') && req.method === 'GET') {
      const job = videoService.get(safeDecode(url.pathname.slice('/api/videos/jobs/'.length)));
      return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'no such video job' });
    }

    if (url.pathname === '/api/videos' && req.method === 'GET') {
      return sendJson(res, 200, listVideos());
    }

    // HEAD as well as GET: players and proxies probe with it, and without this branch it
    // fell through to the static handler and answered 404.
    if (url.pathname.startsWith('/media/videos/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = safeDecode(url.pathname.slice('/media/videos/'.length));
      const video = resolveVideo(name);
      if (!video) return sendJson(res, 404, { error: 'no such video', name });
      return sendLocalMedia(req, res, video);
    }

    if (url.pathname.startsWith('/api/')) {
      // Routes land here as their slices ship (M2 flashcards, M4 reading, ...).
      return sendJson(res, 501, { error: 'not implemented yet', route: url.pathname });
    }

    return sendStatic(res, url.pathname);
  } catch (err) {
    // Never swallow — but a rejected request is not a server fault. Client errors
    // get one line; only genuine 5xx faults are worth a stack trace, otherwise the
    // log cries wolf and real failures get lost in the noise.
    const status = err.status ?? 500;
    const path = url?.pathname ?? loggedPath(req);
    if (status >= 500) console.error(`[server] ${req.method} ${path} failed`, err);
    else console.warn(`[server] ${req.method} ${path} → ${status}: ${err.message}`);

    // A rejected request may still have body in flight, and every reason wants the same
    // handling: discard it and let the connection close normally. Tearing the socket down
    // instead throws away the response that explains the refusal — see `discardBody`. That
    // is the difference between "you are being blocked, and here is why" and "the cockpit
    // is down", for a guard refusal and an oversized body alike.
    if (!req.readableEnded) discardBody(req);

    return sendJson(res, status, { error: err.message });
  }
};
