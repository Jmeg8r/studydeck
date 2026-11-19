// WHAT: Tests for the in-process request-collapsing helper in lib/inflight.mjs.
// WHY: The debriefs ledger deduplicates a submission only once it has been RECORDED, and
//      a debrief spends two awaits (~15s of model time) getting there. Two requests
//      carrying one mutation id inside that window both found an empty ledger and both
//      created an Open Notebook note plus a card set — the exact duplicate the ledger
//      exists to prevent. This is the half of idempotency the ledger cannot cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareInFlight } from '../lib/inflight.mjs';

const defer = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('overlapping calls on one key run the work once and share the result', async () => {
  const map = new Map();
  let runs = 0;
  const factory = async () => {
    runs += 1;
    return defer(20, { note: 'created once' });
  };

  const [first, second] = await Promise.all([
    shareInFlight(map, 'topic:m1', factory),
    shareInFlight(map, 'topic:m1', factory),
  ]);

  assert.equal(runs, 1, 'the second request must not create its own note and cards');
  assert.equal(first.shared, false);
  assert.equal(second.shared, true, 'the joiner is reported as a replay, not a creation');
  assert.deepEqual(second.result, { note: 'created once' });
});

test('different keys are independent', async () => {
  const map = new Map();
  let runs = 0;
  const factory = async () => { runs += 1; return defer(10, runs); };

  await Promise.all([
    shareInFlight(map, 'topic:m1', factory),
    shareInFlight(map, 'topic:m2', factory),
    // Distinct topics with a shared mutation id must not collapse either.
    shareInFlight(map, 'other:m1', factory),
  ]);

  assert.equal(runs, 3);
});

test('a settled run leaves nothing behind, so the same key can run again', async () => {
  const map = new Map();
  let runs = 0;
  const factory = async () => { runs += 1; return 'ok'; };

  await shareInFlight(map, 'topic:m1', factory);
  assert.equal(map.size, 0, 'the entry is dropped once the run settles');

  // A genuine second debrief reusing the key (however unlikely) still runs — this map
  // only collapses CONCURRENT work; durable replay is the ledger's job.
  await shareInFlight(map, 'topic:m1', factory);
  assert.equal(runs, 2);
});

test('a failed run rejects both callers and does not wedge the key', async () => {
  const map = new Map();
  const boom = async () => { await defer(5); throw new Error('open notebook is down'); };

  const first = shareInFlight(map, 'topic:m1', boom);
  const second = shareInFlight(map, 'topic:m1', boom);

  await assert.rejects(first, /open notebook is down/);
  await assert.rejects(second, /open notebook is down/);
  assert.equal(map.size, 0);

  const after = await shareInFlight(map, 'topic:m1', async () => 'recovered');
  assert.equal(after.result, 'recovered');
});

test('a factory that throws synchronously is still cleaned up', async () => {
  const map = new Map();
  await assert.rejects(
    shareInFlight(map, 'topic:m1', () => { throw new Error('bad input'); }),
    /bad input/,
  );
  assert.equal(map.size, 0);
});
