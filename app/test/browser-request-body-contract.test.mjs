// WHAT: Browser views pass request bodies to requestJson as objects.
// WHY:  requestJson serializes the body itself. A view passing JSON.stringify(...) sends it
//       twice-encoded: the server receives a JSON string, not an object, and refuses it
//       with 400. Four call sites did that from 5ba3371 (2026-08-13) until 2026-11-10, so
//       Test Center could not record an attempt for three months. requestJson now throws on
//       a string body, but only when a learner clicks; this scan fails in CI instead.
//       It is a text match, so it cannot see a string built elsewhere and passed in. The
//       run-time guard in api.mjs covers that case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';

const WEB_ROOT = new URL('../web/js/', import.meta.url);
const STRINGIFIED_BODY = /\bbody\s*:\s*JSON\.stringify\s*\(/;

test('no view passes a pre-serialized JSON body to requestJson', () => {
  const offenders = [];
  for (const file of globSync('**/*.mjs', { cwd: WEB_ROOT.pathname })) {
    if (file === 'api.mjs') continue;
    readFileSync(new URL(file, WEB_ROOT), 'utf8').split('\n').forEach((line, index) => {
      if (STRINGIFIED_BODY.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
