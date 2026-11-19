import test from 'node:test';
import assert from 'node:assert/strict';
import { planChapter, checkTranscript, checkGrounding, clipKey, repeatedEnvelope, sourcePassages } from '../lib/podcastquality.mjs';

const prose = (prefix, n = 100) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
test('the chapter plan covers the complete source with distinct, bounded responsibilities', () => {
  const text = `${prose('first', 900)}\n\n${prose('second', 900)}`;
  const plan = planChapter(text, { contextTokens: 8192 });
  assert.equal(plan.segments.map(s => text.slice(s.start, s.end)).join(''), text);
  assert.equal(new Set(plan.segments.map(s => s.id)).size, plan.segments.length);
  assert.ok(plan.segments.every(s => s.end - s.start <= plan.max_source_chars));
  assert.throws(() => planChapter(text, { contextTokens: 2048 }), /context/i);
});
test('chapter review questions are explicitly excluded, and claimed source anchors must exist', () => {
  const source = 'A real source paragraph explains how to deploy a trained model.\n## Questionnaire\nWhat is deployment?';
  const plan = planChapter(source, { contextTokens: 8192 });
  assert.equal(plan.excluded[0].start, source.indexOf('## Questionnaire'));
  assert.equal(plan.segments.at(-1).end, source.indexOf('## Questionnaire'));
  assert.equal(checkGrounding([{ source_quote: 'A real source paragraph explains how to deploy a trained model.' }], source).passed, true);
  assert.equal(checkGrounding([{ source_quote: 'An invented source passage supports this incorrect explanation.' }], source).passed, false);
});
test('empty dialogue and long repeated passages are refused before speech synthesis', () => {
  const turns = [{ speaker: 'Ada', dialogue: prose('one') }];
  assert.equal(checkTranscript(turns, ['Ada']).passed, true);
  assert.equal(checkTranscript([...turns, { speaker: 'Ada', dialogue: '' }], ['Ada']).passed, false);
  assert.equal(checkTranscript([...turns, ...turns], ['Ada']).passed, false);
  assert.equal(checkTranscript(turns, ['Other']).passed, false);
  assert.equal(checkTranscript([{ speaker: 'Ada', dialogue: 'too short' }], ['Ada']).passed, false);
});
test('a cached clip belongs to exact text, voice, model and order', () => {
  const value = { rendition: 'r1', order: 0, dialogue: 'Hello.', voice: 'af_nova', model: 'kokoro' };
  assert.equal(clipKey(value), clipKey({ ...value }));
  for (const change of [{ order: 1 }, { dialogue: 'Hello again.' }, { voice: 'am_adam' }, { model: 'other' }]) {
    assert.notEqual(clipKey(value), clipKey({ ...value, ...change }));
  }
});

test('reworded low-information turns produce a review signal without claiming a factual verdict', () => {
  const vocabulary = Array.from({ length: 60 }, (_, i) => `subject${i}`);
  const variants = [vocabulary, [...vocabulary].reverse(), [...vocabulary.filter((_, i) => i % 2), ...vocabulary.filter((_, i) => !(i % 2))]];
  const qc = checkTranscript(variants.map(v => ({ speaker: 'Ada', dialogue: v.join(' '), section_id: 'section-1' })), ['Ada']);
  assert.equal(qc.passed, true);
  assert.equal(qc.warnings.length, 1);
});
test('a seeded two-minute waveform loop is detected without flagging distinct speech envelopes', () => {
  let seed = 21;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const first = Array.from({ length: 1200 }, random);
  assert.ok(repeatedEnvelope([...first, ...first]).length);
  assert.equal(repeatedEnvelope(Array.from({ length: 2400 }, random)).length, 0);
});

test('a turn with no dialogue fails the transcript and adds nothing to its vocabulary', async () => {
  // Read in the September code, not seen in a run: words(undefined?.toLowerCase()) is
  // words('undefined'), so a turn with no dialogue taught the novelty check the word
  // "undefined". Here that one word turns a single low-novelty turn into two, and a
  // warning appears that the real dialogue never earned.
  const w = Array.from({ length: 12 }, (_, i) => `concept${i}`);
  const turn = (dialogue) => ({ speaker: 'Ada', section_id: 'section-1', ...(dialogue === undefined ? {} : { dialogue }) });
  const turns = [
    turn([...w, ...Array.from({ length: 40 }, (_, i) => `filler${i}`)].join(' ')),
    turn(undefined),
    turn([...w.slice(0, 9), 'undefined', 'fresh1', 'fresh2'].join(' ')),
    turn([...w.slice(0, 9), 'undefined', 'fresh3', 'fresh4'].join(' ')),
  ];
  const qc = checkTranscript(turns, ['Ada']);
  assert.equal(qc.passed, false, 'the empty turn is still an issue');
  assert.ok(qc.issues.some((i) => /Turn 2: empty dialogue/.test(i)));
  assert.deepEqual(qc.warnings, [], 'only one turn adds little; the missing dialogue must not make it two');
});

test('source passages cover the text exactly, break at a line past 600 characters, and absorb a short tail', async () => {
  const line = (n) => `${'x'.repeat(70)} line${n}\n`;
  const text = Array.from({ length: 60 }, (_, i) => line(i)).join('');
  const passages = sourcePassages(text);
  assert.equal(passages.map((p) => p.text).join(''), text, 'nothing lost, nothing repeated');
  assert.deepEqual(passages.map((p) => p.id), passages.map((_, i) => `p${i + 1}`));
  for (const p of passages.slice(0, -1)) {
    assert.ok(p.text.endsWith('\n'), 'a passage ends at a line break when one is available');
    assert.ok(p.text.length > 600 && p.text.length <= 1600, `bounded passage of ${p.text.length}`);
  }
  const tail = sourcePassages(`${'y'.repeat(1590)}\n${'z'.repeat(100)}`);
  assert.equal(tail.length, 1, 'a tail under 160 characters joins the passage before it');
});

test('a source too long for twelve sections is refused, never truncated', async () => {
  const unit = `${'word '.repeat(300)}\n`; // 1501 bytes per line, under the 1696-byte section at 4096 tokens
  assert.equal(planChapter(unit.repeat(11), { contextTokens: 4096 }).segments.length <= 12, true);
  assert.throws(() => planChapter(unit.repeat(20), { contextTokens: 4096 }), /exceeds the chapter context budget/);
});

test('malformed model output gets a failed verdict, never a throw and never a pass', async () => {
  // Codex run 1: the gates exist to judge model output, so the shapes a model gets wrong
  // must fail QC rather than crash the render or slip through.
  for (const turns of [[null], [{ speaker: 'Ada', dialogue: 42 }], [{ speaker: 'Ada', dialogue: ['a', 'list'] }]]) {
    let qc;
    assert.doesNotThrow(() => { qc = checkTranscript(turns, ['Ada']); }, JSON.stringify(turns));
    assert.equal(qc.passed, false, JSON.stringify(turns));
  }
  for (const turns of ['not a transcript', { length: 3 }, 7, null]) {
    const verdict = checkGrounding(turns, 'A real source paragraph explains how to deploy a trained model.');
    assert.equal(verdict.passed, false, JSON.stringify(turns));
    assert.ok(verdict.issues.length > 0, JSON.stringify(turns));
  }
});

test('a review heading inside a fenced code example does not end the chapter', async () => {
  // Codex run 2: the heading search matched "## References" in a markdown example, and
  // everything after it, real explanation included, was silently excluded.
  const example = 'Here is how a README is laid out:\n```markdown\n## References\n- a link\n```\n';
  const after = 'The prose after the example still explains how references support a claim.\n';
  const source = `${example}${after}`;
  const plan = planChapter(source, { contextTokens: 8192 });
  assert.deepEqual(plan.excluded, [], 'nothing is excluded');
  assert.equal(plan.segments.map((s) => source.slice(s.start, s.end)).join(''), source);

  // The control: a real heading after the example still ends the chapter there.
  const withReal = `${source}## References\nA real reference list.\n`;
  const real = planChapter(withReal, { contextTokens: 8192 });
  assert.equal(real.excluded[0].start, withReal.lastIndexOf('## References'));
});

test('a longer outer fence stays open across an inner fence, so its heading is not the chapter end', async () => {
  // Codex run 3: fences close only on the same character, at least as long as the opener,
  // with nothing after it. A four-backtick example holding a three-backtick block stayed
  // "closed" from the inner opener on, and its "## References" ended the chapter.
  const source = [
    'A markdown example that shows a fenced README:',
    '````markdown',
    '```markdown',
    '## References',
    '- a link',
    '```',
    '````',
    'The explanation after the example must survive.',
    '',
  ].join('\n');
  const plan = planChapter(source, { contextTokens: 8192 });
  assert.deepEqual(plan.excluded, []);

  // A fence line with text after it is an opener, never a closer.
  const infoNotClose = ['```text', '## References', '```python', 'more example', '```', 'Prose after.', ''].join('\n');
  assert.deepEqual(planChapter(infoNotClose, { contextTokens: 8192 }).excluded, []);
});
