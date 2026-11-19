// A local model can return just one assessment despite receiving multiple sources.
// This recorder checks StudyDeck preserves coverage when the model behaves that way.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
let failSecond = false;
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const { sources } = JSON.parse(body.messages[1].content);
    const source = sources[0];
    if (failSecond && source.id === 's2') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: { content: '{\"sources\":[]}' } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify({ sources: [
      { id: source.id, keep: true, score: 85, reason: 'A worked retrieval example.',
        caveat: 'Date missing.', quote: source.description },
    ] }) } }));
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
process.env.STUDYDECK_OLLAMA_BASE_URL = `http://127.0.0.1:${model.address().port}`;
const { discoverSources } = await import('../lib/sourcesearch.mjs');
after(() => model.close());
test('a model returning one item per response still assesses every candidate', async () => {
  const results = await discoverSources('vector retrieval', { search: async () => [
    { url: 'https://first.example.org/guide', title: 'Vector retrieval guide', description: 'A worked vector retrieval example.', content: '' },
    { url: 'https://second.example.org/lecture', title: 'Vector retrieval lecture', description: 'A lecture on vector retrieval.', content: '' },
  ] });
  assert.equal(results.ranking, 'assessed');
  assert.equal(results.results.length, 2);
  assert(results.results.every((r) => r.quote));
});

test('one incomplete assessment does not discard another source with verified evidence', async () => {
  failSecond = true;
  const results = await discoverSources('vector retrieval', { search: async () => [
    { url: 'https://first.example.org/guide', title: 'Vector retrieval guide', description: 'A worked vector retrieval example.', content: '' },
    { url: 'https://second.example.org/lecture', title: 'Vector retrieval lecture', description: 'A lecture on vector retrieval.', content: '' },
  ] });
  assert.equal(results.ranking, 'assessed');
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].url, 'https://first.example.org/guide');
  assert.match(results.warnings.join(), /1 candidate.*could not be assessed/);
});
