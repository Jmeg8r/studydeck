// WHAT: Text contrast, computed from the stylesheets themselves, in both themes.
// WHY:  A colour that is a little too faint fails nothing and looks fine on the screen it
//       was picked on. Measured on 2026-11-10, most secondary text in the light theme sat
//       near 3.5:1. Reading the ratios out of tokens.css means a later token edit that
//       drops below the floor fails here, not in someone's eyes. The parser handles this
//       repo's token format (one declaration per line, hex or var() of another token), not
//       CSS in general.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = (name) => readFileSync(new URL(`../web/css/${name}`, import.meta.url), 'utf8');
const TOKENS = css('tokens.css');
const APP = css('app.css');

/** WCAG 2.x minimum for body text. */
const TEXT_FLOOR = 4.5;
const TEXT_TOKENS = ['--txt', '--dim', '--faint', '--accent-text', '--error-text', '--success-text'];
const FIELDS = ['--bg', '--bg-rail', '--panel', '--panel-hi'];
/** Translucent surfaces laid over a field: the selected rail item, hot pills, learner turns. */
const WASHES = ['--accent-wash'];

function block(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} block not found`);
  return source.slice(start, source.indexOf('}', start));
}

function declarations(text) {
  const out = {};
  for (const [, name, value] of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

function theme(name) {
  const tokens = { ...declarations(block(TOKENS, ':root')), ...declarations(block(TOKENS, `html.${name}`)) };
  const resolve = (value) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) return value;
    assert.ok(tokens[ref[1]], `${name}: ${ref[1]} is not defined`);
    return resolve(tokens[ref[1]]);
  };
  return (token) => {
    assert.ok(tokens[token], `${name}: ${token} is not defined`);
    return resolve(tokens[token]);
  };
}

function rgba(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  assert.match(h, /^([0-9a-f]{6}|[0-9a-f]{8})$/i, `not a hex colour: ${hex}`);
  const channel = (i) => parseInt(h.slice(i, i + 2), 16);
  return [channel(0), channel(2), channel(4), h.length === 8 ? channel(6) / 255 : 1];
}

const composite = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(textHex, fieldHex, washHex) {
  let field = rgba(fieldHex);
  if (washHex) field = [...composite(rgba(washHex), field), 1];
  const [hi, lo] = [luminance(composite(rgba(textHex), field)), luminance(field)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

for (const name of ['dark', 'light']) {
  test(`${name} theme: every text token reaches ${TEXT_FLOOR}:1 on every field it is drawn on`, () => {
    const get = theme(name);
    const failures = [];
    for (const text of TEXT_TOKENS) {
      // A missing token is one failure in the list, not an exception that hides the others.
      try { get(text); } catch { failures.push(`${text} is not defined`); continue; }
      for (const field of FIELDS) {
        const r = ratio(get(text), get(field));
        if (r < TEXT_FLOOR) failures.push(`${text} on ${field} ${r.toFixed(2)}`);
        for (const wash of WASHES) {
          const w = ratio(get(text), get(field), get(wash));
          if (w < TEXT_FLOOR) failures.push(`${text} on ${wash} over ${field} ${w.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  test(`${name} theme: the rail's count badge text is readable on its fill`, () => {
    const rule = /\.nav-item \.badge \{([^}]*)\}/.exec(APP);
    assert.ok(rule, '.nav-item .badge rule not found');
    const decl = (prop) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`).exec(rule[1])?.[1].trim();
    const get = theme(name);
    const value = (v) => (v.startsWith('var(') ? get(/var\((--[\w-]+)\)/.exec(v)[1]) : v);
    const r = ratio(value(decl('color')), value(decl('background')));
    assert.ok(r >= TEXT_FLOOR, `badge text ${r.toFixed(2)}:1`);
  });
}

test('no text colour reads the brand coral or teal; those are fills, text has its own tokens', () => {
  // `color:` only. Borders, backgrounds and fills keep the brand hues by design.
  const offenders = APP.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /(?:^|[;{\s])color\s*:\s*var\(--(coral|teal)\)/.test(line))
    .map(([n, line]) => `app.css:${n} ${line.trim()}`);
  assert.deepEqual(offenders, []);
});
