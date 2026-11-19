// WHAT: createViewScope — one owner for a view's requests, child scopes and players.
// WHY:  Kept apart from lifecycle.test.mjs so a missing export fails this file alone and
//       cannot hide the delay tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewScope } from '../web/js/lifecycle.mjs';

test('dispose aborts the signal and runs each owned cleanup once', () => {
  const scope = createViewScope();
  let runs = 0;
  scope.own(() => { runs += 1; });
  scope.dispose();
  scope.dispose();
  assert.equal(scope.signal.aborted, true);
  assert.equal(runs, 1);
});

test('a cleanup owned after dispose runs at once', () => {
  const scope = createViewScope();
  scope.dispose();
  let runs = 0;
  scope.own(() => { runs += 1; });
  assert.equal(runs, 1);
});

test('an un-owned cleanup does not run on dispose', () => {
  const scope = createViewScope();
  let runs = 0;
  const forget = scope.own(() => { runs += 1; });
  forget();
  scope.dispose();
  assert.equal(runs, 0);
});
