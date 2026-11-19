// WHAT: The phone-width contract for the Observatory dialog.
// WHY:  Measured on 2026-11-10 at 390px, every rail view fit but the Observatory did not:
//       wheelSize() never goes below 360px and the dialog's 34px side padding left a 322px
//       stage, so the dialog scrolled sideways under any viewport narrower than 428px. DOM
//       and route tests stayed green because nothing there measures layout. This pins the
//       CSS rules that let the wheel shrink; it proves they exist, not how the browser draws
//       them, which is why the change's plan also records a browser check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');
const PHONE = '@media (max-width: 760px)';

/** The body of the first balanced block after `marker`, or null when the marker is absent. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

/** The declarations of the rule whose selector is exactly `selector`, or null. */
function rule(body, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*{([^}]*)}`).exec(body);
  return match ? match[1] : null;
}

const EXPECTED = [
  ['.observatory', /padding:\s*\d+px\s*;/, 'a phone-sized padding'],
  ['.obs-head', /flex-wrap:\s*wrap\s*;/, 'flex-wrap: wrap'],
  ['.obs-field', /min-width:\s*0\s*;/, 'min-width: 0'],
  ['.obs-field svg', /max-width:\s*100%\s*;/, 'max-width: 100%'],
  ['.obs-field svg', /height:\s*auto\s*;/, 'height: auto'],
];

test('at phone width the Observatory wheel shrinks to fit its dialog', () => {
  const phone = blockAfter(CSS, PHONE);
  assert.ok(phone !== null, `${PHONE} block is missing from app.css`);
  const misses = [];
  for (const [selector, pattern, wanted] of EXPECTED) {
    const body = rule(phone, selector);
    if (body === null) misses.push(`${selector}: no rule`);
    else if (!pattern.test(body)) misses.push(`${selector}: missing ${wanted}`);
  }
  assert.deepEqual(misses, [], `phone rules missing inside ${PHONE}`);
});

test('under 1100px the Observatory stacks its panels instead of hiding them', () => {
  const tablet = blockAfter(CSS, '@media (max-width: 1100px)');
  assert.ok(tablet !== null, '@media (max-width: 1100px) block is missing from app.css');
  assert.match(rule(tablet, '.obs-stage') ?? '', /flex-direction:\s*column\s*;/);
  // The legend comes first in the DOM; stacked as-is, a phone opens on a list, not the wheel.
  assert.match(rule(tablet, '.obs-field') ?? '', /order:\s*-1\s*;/, 'the wheel leads the stack');
  // The concept picker lives in the legend, so hiding it removes the only keyboard path.
  assert.doesNotMatch(tablet, /display:\s*none/);
});

// Measured 2026-11-10: the hub caption overlapped the inner ring at 390x844, at 800x800 and in a
// 1280x560 window. Its size follows wheelSize(), not the viewport width, so the rule hangs off
// the class observatory.mjs sets from that size, at the top level, not in a media query.
test('a compact wheel moves the hub out of the hole', () => {
  const body = rule(CSS, '.obs-field.compact .obs-hub');
  assert.ok(body !== null, '.obs-field.compact .obs-hub rule is missing from app.css');
  assert.match(body, /position:\s*static\s*;/);
});
