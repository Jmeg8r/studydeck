// WHAT: That a sketch at the advertised limit actually fits in a request.
// WHY:  Assessment finding F9. The sketch limit (8 MiB) and the request body cap
//       (1,000,000 bytes) were independent constants in different files, and they
//       contradicted each other: a sketch travels base64-encoded inside the JSON body, so
//       the request layer refused anything over roughly 750 KiB long before the 8 MiB
//       check could run. The advertised limit was unreachable, and the 413 quoted a
//       number that was not the one rejecting you.
//
// The assertion below is the one that was false before: encode a sketch of exactly
// MAX_SKETCH_BYTES, put it in the body it will travel in, and check it still fits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64Length, formatBytes, MAX_BODY_BYTES, MAX_SKETCH_BYTES } from '../lib/limits.mjs';
import { saveSketch } from '../lib/mindmap.mjs';

test('a sketch at exactly the limit still fits inside a request body', () => {
  const encoded = base64Length(MAX_SKETCH_BYTES);
  const envelope = 'data:image/jpeg;base64,'.length;

  assert.ok(
    encoded + envelope <= MAX_BODY_BYTES,
    `a ${formatBytes(MAX_SKETCH_BYTES)} sketch encodes to ${encoded} bytes, over the ${MAX_BODY_BYTES}-byte body cap`,
  );
});

test('the limit leaves room for the rest of the run, not just the image', () => {
  // A run also carries recalled concept slugs and a mutation id. Filling the body to the
  // last byte with the image would make a large topic fail on a sketch that "fits".
  const slack = MAX_BODY_BYTES - base64Length(MAX_SKETCH_BYTES);
  assert.ok(slack >= 16 * 1024, `only ${slack} bytes left for the rest of the payload`);
});

test('the limit is big enough to be worth having', () => {
  // Guards the other direction: deriving it from a smaller body cap one day should not
  // quietly shrink sketches to something useless. A legible downscaled whiteboard photo
  // is comfortably under 500 KB.
  assert.ok(MAX_SKETCH_BYTES >= 500 * 1024, `${formatBytes(MAX_SKETCH_BYTES)} is too small for a photo`);
});

test('an oversized sketch is refused with both real numbers', () => {
  // The old message read "limit is 8MB" while a 1,000,000-byte cap did the rejecting.
  const oversized = `data:image/png;base64,${'A'.repeat(base64Length(MAX_SKETCH_BYTES + 1024))}`;

  assert.throws(
    () => saveSketch('any-topic', oversized),
    (err) => {
      assert.equal(err.status, 413);
      assert.match(err.message, new RegExp(formatBytes(MAX_SKETCH_BYTES).replace('.', '\\.')));
      assert.match(err.message, /base64/, 'the message should say WHY the limit is what it is');
      return true;
    },
  );
});

test('formatBytes says something a person can picture', () => {
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});
