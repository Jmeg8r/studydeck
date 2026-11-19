// The recorder checks our CLI arguments and HTTP behavior. Its result is only input
// to reach the ranking path; live provider compatibility requires a real search.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const scratch = mkdtempSync(join(tmpdir(), 'source-search-egress-'));
const log = join(scratch, 'calls');
const bin = join(scratch, 'search-recorder');
writeFileSync(bin, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(JSON.stringify({data:{web:[{url:'https://example.org/guide',title:'Vector retrieval',description:'Vector retrieval guide'}]}}));\n`, { mode: 0o700 });
process.env.STUDYDECK_FIRECRAWL_BIN = bin;
process.env.STUDYDECK_OLLAMA_BASE_URL = 'http://127.0.0.1:1';
const { handleRequest } = await import('../router.mjs');
const server = createServer(handleRequest);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(scratch, { recursive: true, force: true }); });
const search = (query) => fetch(`${base}/api/on/source-search`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
test('route sends bounded search arguments, caches replay and does not require a notebook', async () => {
 const res = await search('vector retrieval');
 assert.equal(res.status,200);
 const result = await res.json();
 assert.equal(result.ranking,'preliminary');assert.equal(result.results.length,1);
 const calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(calls.length,6);
 for(const args of calls) {
  assert.deepEqual(args.slice(0,8),['search','--limit','5','--scrape','--json','--timeout','45000','--']);
  assert.equal(args.length,9);
 }
 assert.equal((await search('vector retrieval')).status,200);
 assert.equal(readFileSync(log,'utf8').trim().split('\n').length,6);
 assert.equal((await search('')).status,400);
 assert.equal((await fetch(`${base}/api/on/source-search`,{method:'POST',headers:{'content-type':'application/json',origin:'https://other.example'},body:JSON.stringify({query:'vector retrieval'})})).status,403);
});
