// WHAT: New notebook creation crosses two systems: Open Notebook and learn-anything.
// WHY: A pretty rail button is useless if it leaves either side absent or creates a
//      duplicate after a retry. This drives the real HTTP route against disposable files
//      and an outbound recorder, then proves the new topic is immediately renderable.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'studydeck-notebooks-'));
const learnRoot = join(root, 'topics');
const configPath = join(root, 'cockpit.config.json');
mkdirSync(learnRoot, { recursive: true });

const baseConfig = JSON.parse(readFileSync(new URL('../cockpit.config.json', import.meta.url), 'utf8'));
baseConfig.topics = [];
writeFileSync(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`);

const sent = [];
const notebooks = [];
const onStub = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://stub').pathname;
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && pathname === '/api/notebooks') {
    sent.push({ method: 'GET' });
    return json(200, notebooks);
  }
  if (req.method === 'POST' && pathname === '/api/notebooks') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      sent.push({ method: 'POST', body });
      const notebook = { id: 'notebook:new-fixture', ...body };
      notebooks.push(notebook);
      json(200, notebook);
    });
    return;
  }
  return json(404, { detail: 'unhandled recorder route' });
});
await new Promise((resolve) => onStub.listen(0, '127.0.0.1', resolve));

process.env.STUDYDECK_LEARN_ROOT = learnRoot;
process.env.STUDYDECK_CONFIG_PATH = configPath;
process.env.STUDYDECK_ON_BASE_URL = `http://127.0.0.1:${onStub.address().port}`;
process.env.STUDYDECK_ON_PASSWORD = 'notebooks-recorder-password';

const { handleRequest } = await import('../router.mjs');
const app = createServer(handleRequest);
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const appBase = `http://127.0.0.1:${app.address().port}`;

after(() => {
  app.close();
  onStub.close();
  rmSync(root, { recursive: true, force: true });
});

test('creates, maps, renders and immediately serves a blank study notebook', async () => {
  const created = await fetch(`${appBase}/api/notebooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Linear Algebra' }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    slug: 'linear-algebra', name: 'Linear Algebra', notebook_id: 'notebook:new-fixture', draft: true,
  });

  assert.deepEqual(sent, [
    { method: 'GET' },
    { method: 'POST', body: { name: 'Linear Algebra', description: 'StudyDeck topic: linear-algebra' } },
  ]);
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.topics, [{ slug: 'linear-algebra', ring: 'outer', notebookId: 'notebook:new-fixture' }]);
  const state = JSON.parse(readFileSync(join(learnRoot, 'linear-algebra', 'state.json'), 'utf8'));
  assert.equal(state.topic, 'Linear Algebra');
  assert.deepEqual(state.domains, []);
  assert.match(readFileSync(join(learnRoot, 'linear-algebra', 'knowledge-map.md'), 'utf8'), /0\/0 mastered/);

  const current = await fetch(`${appBase}/api/state`);
  assert.equal(current.status, 200);
  const payload = await current.json();
  assert.equal(payload.topics[0].slug, 'linear-algebra');
  assert.equal(payload.topics[0].concept_count, 0);

  const duplicate = await fetch(`${appBase}/api/notebooks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Linear Algebra' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(sent.filter((request) => request.method === 'POST').length, 1);
});
