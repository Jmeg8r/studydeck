// WHAT: resolveTool's lookup order for operator tools such as ffmpeg and ffprobe.
// WHY:  launchd starts the cockpit with a minimal PATH that often omits Apple Silicon
//       Homebrew, so a bare `ffmpeg` can fail under the service while working in a
//       terminal. The order matches videogeneration.mjs's private tool(), which this does
//       not change: a configured path that exists, then known install directories, then
//       PATH. Driven with temporary directories, never the machine's real tools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'studydeck-executables-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const ENV = 'STUDYDECK_TEST_TOOL';

function dirs(...withTool) {
  const made = ['first', 'second'].map((name) => {
    const dir = join(ROOT, `${name}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir);
    if (withTool.includes(name)) writeFileSync(join(dir, 'tool'), '');
    return dir;
  });
  return made;
}

test('a configured path that exists wins over every directory', async () => {
  const { resolveTool } = await import('../lib/executables.mjs');
  const configured = join(ROOT, 'configured-tool');
  writeFileSync(configured, '');
  process.env[ENV] = configured;
  try {
    assert.equal(resolveTool(ENV, 'tool', dirs('first', 'second')), configured);
  } finally { delete process.env[ENV]; }
});

test('a configured path that does not exist is skipped, not trusted', async () => {
  const { resolveTool } = await import('../lib/executables.mjs');
  const searched = dirs('second');
  process.env[ENV] = join(ROOT, 'no-such-tool');
  try {
    assert.equal(resolveTool(ENV, 'tool', searched), join(searched[1], 'tool'));
  } finally { delete process.env[ENV]; }
});

test('the first directory that has the tool is used, in order', async () => {
  const { resolveTool } = await import('../lib/executables.mjs');
  const both = dirs('first', 'second');
  assert.equal(resolveTool(ENV, 'tool', both), join(both[0], 'tool'));
  const secondOnly = dirs('second');
  assert.equal(resolveTool(ENV, 'tool', secondOnly), join(secondOnly[1], 'tool'));
});

test('with nothing found, the bare name is left for PATH', async () => {
  const { resolveTool } = await import('../lib/executables.mjs');
  assert.equal(resolveTool(ENV, 'tool', dirs()), 'tool');
});

test('by default it searches Homebrew, then /usr/local/bin', async () => {
  const { TOOL_DIRS } = await import('../lib/executables.mjs');
  assert.deepEqual(TOOL_DIRS, ['/opt/homebrew/bin', '/usr/local/bin']);
});
