// Drive source creation over real HTTP with disposable learning data and an outbound
// recorder. The assertions pin what StudyDeck sends and how it handles a lost response;
// the recorder's payload is only enough to reach those paths.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'studydeck-source-create-'));
const learnRoot = join(root, 'topics');
const configPath = join(root, 'cockpit.config.json');
mkdirSync(join(learnRoot, 'fixture'), { recursive: true });
const config = JSON.parse(readFileSync(new URL('../cockpit.config.json', import.meta.url), 'utf8'));
config.topics = [{ slug: 'fixture', ring: 'inner', notebookId: 'notebook:fixture' }];
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const posts = [];
const sources = [];
let loseResponse = false;
const onStub = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://stub').pathname;
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && pathname === '/api/sources') return json(sources);
  if (req.method === 'POST' && pathname === '/api/sources/json') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      posts.push(body);
      const source = {
        id: `source:fixture-${posts.length}`, title: body.title,
        asset: { url: body.url ?? null },
      };
      sources.push(source);
      if (loseResponse) {
        loseResponse = false;
        req.socket.destroy();
      } else json(source);
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

process.env.STUDYDECK_LEARN_ROOT = learnRoot;
process.env.STUDYDECK_CONFIG_PATH = configPath;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'source-create-recorder';
const { handleRequest } = await import('../router.mjs');
const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close(); onStub.close(); rmSync(root, { recursive: true, force: true });
});

const add = (body) => fetch(`${base}/api/on/sources`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('adds a link only to the selected notebook and replays without another POST', async () => {
  const intent = {
    topic_slug: 'fixture', mutation_id: 'source-link-1', type: 'link',
    title: 'A lesson', url: 'https://example.org/lesson',
  };
  const created = await add(intent);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { id: 'source:fixture-1', replayed: false });
  assert.deepEqual(posts[0], {
    notebooks: ['notebook:fixture'], type: 'link', title: 'A lesson',
    url: 'https://example.org/lesson', async_processing: true,
  });

  const replay = await add(intent);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: 'source:fixture-1', replayed: true });
  assert.equal(posts.length, 1);

  const badTopic = await add({ ...intent, topic_slug: 'other', mutation_id: 'source-link-2' });
  assert.equal(badTopic.status, 400);
  assert.equal(posts.length, 1);
});

test('recovers a text source after Open Notebook committed but its response was lost', async () => {
  loseResponse = true;
  const intent = {
    topic_slug: 'fixture', mutation_id: 'source-text-1', type: 'text',
    title: 'My notes', content: 'A learner curated passage.',
  };
  const uncertain = await add(intent);
  assert.equal(uncertain.status, 503);
  const before = posts.length;
  const recovered = await add(intent);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { id: 'source:fixture-2', replayed: true });
  assert.equal(posts.length, before);
  assert.deepEqual(posts.at(-1), {
    notebooks: ['notebook:fixture'], type: 'text', title: 'My notes',
    content: 'A learner curated passage.', async_processing: true,
  });
});

test('concurrent different payloads cannot share one mutation result', async () => {
  const before = posts.length;
  const first = {
    topic_slug: 'fixture', mutation_id: 'source-conflict-1', type: 'link',
    title: 'First link', url: 'https://example.org/first',
  };
  const [a, b] = await Promise.all([
    add(first), add({ ...first, title: 'Another link', url: 'https://example.org/other' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(posts.length, before + 1);
});
