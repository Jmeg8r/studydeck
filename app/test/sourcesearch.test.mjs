import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceUrl, parseSearchResults, shortlist, applyAssessment, discoverSources, sourceKinds } from '../lib/sourcesearch.mjs';

const row = (url, title = 'Vector retrieval tutorial') => ({ url, title,
  description: 'Vector retrieval with examples', content: 'Page evidence about vector retrieval.' });

test('only public web links survive; tracking and YouTube aliases deduplicate', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'http://127.0.0.1', 'http://[::1]', 'https://user:pass@example.com', 'http://printer.local']) assert.equal(sourceUrl(url), null);
  assert.equal(sourceUrl('https://example.com/a?utm_source=x&id=1#part'), 'https://example.com/a?id=1');
  assert.equal(sourceUrl('https://youtu.be/abc?si=x'), sourceUrl('https://www.youtube.com/watch?v=abc&t=10'));
});

test('provider errors and malformed responses are distinct from empty searches', () => {
  assert.throws(() => parseSearchResults({ error: 'denied' }));
  assert.throws(() => parseSearchResults({ success: false, data: [] }));
  assert.deepEqual(parseSearchResults({ data: { web: [] } }), []);
  const parsed = parseSearchResults({ data: { web: [
    { url: 'https://example.com/a', title: '<b>Title</b>', markdown: 'Evidence' },
    { url: 'javascript:alert(1)', title: 'Bad' },
  ] } });
  assert.equal(parsed.length, 1); assert.equal(parsed[0].title, 'Title');
});

test('ranking drops unrelated results and duplicate URLs, and includes requested formats', () => {
  const rows = shortlist('vector retrieval', [[row('https://docs.example.com/reference'),
    row('https://example.com/blog/a'), row('https://example.com/course/a.pdf'),
    row('https://www.youtube.com/watch?v=abc'),
    { ...row('https://noise.example.com'), title: 'Gardening', description: 'Roses', content: '' }],
  [row('https://docs.example.com/reference')]]);
  assert.equal(rows.length, 4);
  assert.deepEqual(sourceKinds(rows.find((r) => r.url.endsWith('.pdf'))), ['PDF', 'Training']);
  assert(rows.some((r) => r.kinds.includes('Video')));
  assert(rows.some((r) => r.kinds.includes('Blog')));
  assert(rows.some((r) => r.kinds.includes('Vendor / documentation')));
});

test('model cannot introduce a URL, skip candidates, or duplicate ids', () => {
  const candidates = shortlist('vector retrieval', [[row('https://a.example.com'), row('https://b.example.com')]]);
  const sources = candidates.map((c) => ({ id: c.id, keep: true, score: 80, reason: 'Worked retrieval example', quote: c.description, caveat: 'Date not supplied', url: 'https://invented.example.com' }));
  assert.deepEqual(applyAssessment(candidates, { sources }).map((r) => r.url), candidates.map((r) => r.url));
  assert.equal(applyAssessment(candidates, { sources: [{ ...sources[0], quote: 'Invented quote with no supporting evidence' }, sources[1]] }), null);
  assert.equal(applyAssessment(candidates, { sources: sources.slice(1) }), null);
  assert.equal(applyAssessment(candidates, { sources: [sources[0], sources[0]] }), null);
  assert.equal(applyAssessment(candidates, { sources: [{ ...sources[0], id: 'unknown' }, sources[1]] }), null);
  assert.deepEqual(applyAssessment(candidates, { sources: sources.map((s) => ({ ...s, keep: false })) }), []);
});

test('search covers all six categories, assesses evidence, and reports partial coverage', async () => {
  const sent = [];
  const result = await discoverSources('vector retrieval', {
    search: async (query) => {
      sent.push(query);
      if (query.includes('filetype:pdf')) throw new Error('offline');
      return [row('https://example.com/course')];
    },
    review: async (query, candidates) => ({ sources: candidates.map((c) => ({ id: c.id, keep: true, score: 90, reason: 'Concrete examples', quote: c.description, caveat: 'Date missing' })) }),
  });
  assert.equal(sent.length, 6);
  for (const term of ['filetype:pdf', 'site:youtube.com/watch', 'blog', 'official documentation', 'training']) assert(sent.some((q) => q.includes(term)));
  assert.equal(result.ranking, 'assessed'); assert.equal(result.results.length, 1);
  assert.match(result.warnings[0], /1 of 6/); assert.equal(result.results[0].content, undefined);
});

test('assessment failure is labeled preliminary; total provider failure is an error', async () => {
  const result = await discoverSources('vector retrieval', { search: async () => [row('https://example.com')], review: async () => { throw new Error('offline'); } });
  assert.equal(result.ranking, 'preliminary'); assert.match(result.warnings.join(), /not a vetted/);
  await assert.rejects(discoverSources('vector retrieval', { search: async () => { throw new Error('private credential must not escape'); } }), /Internet search is unavailable/);
  for (const query of ['', ' ', 'a'.repeat(501), null]) await assert.rejects(discoverSources(query), (e) => e.status === 400);
});
