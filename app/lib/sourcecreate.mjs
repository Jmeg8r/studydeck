// A source POST may succeed even when its response is lost. Record the intent first,
// then reconcile from Open Notebook's source list before any retry can send again.
import { createHash } from 'node:crypto';
import { appendOperation, findOperationByMutation } from './sidecar.mjs';
import { createSource, sourceIdentities } from './opennotebook.mjs';
import { shareInFlight } from './inflight.mjs';

const KIND = 'open_notebook_source';
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const inFlight = new Map();
const identityFor = (topicSlug, mutation) => createHash('sha256')
  .update(`${topicSlug}\0${mutation}`).digest('hex');
const inputHash = (input) => createHash('sha256')
  .update(JSON.stringify(input)).digest('hex');

function revise(topicSlug, operation, changes) {
  const revision = operation.revision + 1;
  return appendOperation(topicSlug, {
    ...operation, ...changes, revision, ts: new Date().toISOString(),
    mutation_id: `${operation.origin_mutation_id}:source:${revision}:${changes.stage ?? operation.stage}`,
  });
}

async function reconcile(topicSlug, operation, input) {
  const candidates = (await sourceIdentities(input.notebookId)).filter((source) =>
    !operation.baseline_ids.includes(source.id)
    && (input.type === 'link' ? source.url === input.url : source.title === input.title));
  if (candidates.length !== 1) return null;
  return revise(topicSlug, operation, {
    stage: 'complete', external: { source_id: candidates[0].id }, error: null,
  });
}

async function create(topicSlug, mutation, input) {
  const hash = inputHash(input);
  let operation = findOperationByMutation(topicSlug, mutation, KIND);
  if (operation) {
    if (operation.input_hash !== hash) throw failure('mutation_id belongs to a different source');
    if (operation.stage === 'complete') return { id: operation.external.source_id, replayed: true };
    if (operation.stage === 'prepared' || operation.stage === 'ambiguous') {
      const recovered = await reconcile(topicSlug, operation, input);
      if (recovered) return { id: recovered.external.source_id, replayed: true };
      throw failure('Source creation outcome is uncertain. Check this notebook in Open Notebook before trying again.');
    }
  } else {
    const identity = identityFor(topicSlug, mutation);
    operation = appendOperation(topicSlug, {
      operation_id: `open-notebook-source-${identity}`,
      origin_mutation_id: mutation,
      mutation_id: `${mutation}:source:started`,
      revision: 0,
      ts: new Date().toISOString(),
      kind: KIND, topic_slug: topicSlug, input_hash: hash,
      stage: 'started', external: null,
      baseline_ids: [],
    });
  }

  const baseline = await sourceIdentities(input.notebookId);
  operation = revise(topicSlug, operation, {
    stage: 'prepared', baseline_ids: baseline.map((source) => source.id),
  });
  try {
    const source = await createSource(input);
    if (typeof source?.id !== 'string' || !source.id) {
      throw failure('Open Notebook did not return a source id', 503);
    }
    operation = revise(topicSlug, operation, {
      stage: 'complete', external: { source_id: source.id }, error: null,
    });
    return { id: source.id, replayed: false };
  } catch (err) {
    const known = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
    revise(topicSlug, operation, {
      stage: known ? 'failed_known' : 'ambiguous',
      error: { classification: known ? 'source_rejected' : 'source_outcome_unknown' },
    });
    throw err;
  }
}

export function addSource(topicSlug, mutation, input) {
  return shareInFlight(inFlight, `source:${topicSlug}:${mutation}:${inputHash(input)}`, () => create(topicSlug, mutation, input))
    .then(({ result, shared }) => ({ ...result, replayed: result.replayed || shared }));
}
