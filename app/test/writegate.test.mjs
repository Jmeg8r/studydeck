// WHAT: Navigation waits for a Recovery write in flight, and never waits forever.
// WHY:  A settle that finishes after the learner has moved on refreshes the shared state, but
//       the view they moved to was already drawn from the old one: Flashcards could say "No
//       cards yet" beside cards that exist (Codex, run 3). Redrawing whatever view is open
//       would throw away a quiz in progress, so the next view waits instead. A separate
//       file, loaded with import(), so a missing module fails only this.
import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('with nothing in flight, navigation does not wait', async () => {
  const { createWriteGate } = await import('../web/js/writegate.mjs');
  const gate = createWriteGate();
  let done = false;
  gate.settled().then(() => { done = true; });
  await tick();
  assert.equal(done, true);
});

test('navigation waits until the write in flight has finished', async () => {
  const { createWriteGate } = await import('../web/js/writegate.mjs');
  const gate = createWriteGate();
  let finish;
  const write = new Promise((resolve) => { finish = resolve; });
  assert.equal(gate.track(write), write, 'track hands the write back unchanged');

  let done = false;
  gate.settled().then(() => { done = true; });
  await tick();
  assert.equal(done, false, 'still waiting while the write is open');
  finish();
  await tick();
  assert.equal(done, true);

  let again = false;
  gate.settled().then(() => { again = true; });
  await tick();
  assert.equal(again, true, 'a finished write no longer holds anything up');
});

test('a failed write releases navigation without throwing into it', async () => {
  const { createWriteGate } = await import('../web/js/writegate.mjs');
  const gate = createWriteGate();
  const failed = Promise.reject(new Error('boom'));
  failed.catch(() => {});
  gate.track(failed);
  await assert.doesNotReject(gate.settled());
});

test('a write that never answers holds navigation only for the wait limit', async () => {
  const { createWriteGate, WRITE_GATE_WAIT_MS } = await import('../web/js/writegate.mjs');
  assert.ok(WRITE_GATE_WAIT_MS > 0 && WRITE_GATE_WAIT_MS <= 10_000, 'a bounded default');
  const gate = createWriteGate({ waitMs: 20 });
  gate.track(new Promise(() => {}));
  const started = Date.now();
  await gate.settled();
  assert.ok(Date.now() - started < 1000, 'released by the limit, not by the write');
});

test('only the latest navigation renders, so a superseded wait cannot redraw over new work', async () => {
  // Stats, then Test Center two seconds later, while a write hangs: each waited on its own
  // and each rendered, so the first timeout opened Test Center and the second redrew it,
  // discarding answers typed in between (Codex, run 4).
  const { createWriteGate } = await import('../web/js/writegate.mjs');
  const gate = createWriteGate({ waitMs: 30 });
  gate.track(new Promise(() => {}));
  const rendered = [];
  const first = gate.afterWrites(() => rendered.push('stats'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = gate.afterWrites(() => rendered.push('testcenter'));
  await Promise.all([first, second]);
  assert.deepEqual(rendered, ['testcenter']);

  await gate.afterWrites(() => rendered.push('today'));
  assert.deepEqual(rendered, ['testcenter', 'today'], 'a navigation with no rival still renders');
});

test('Recovery refuses to render without a way to hold navigation for its writes', async () => {
  const { renderRecovery } = await import('../web/js/views/recovery.mjs');
  assert.throws(() => renderRecovery(null, { refresh: () => {} }), TypeError);
});
