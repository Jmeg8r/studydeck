// WHAT: Tests for how config.mjs turns the two tailnet variables into config.tailnet.
// WHY: The tailnet door (docs/changes/2026-11-09-tailnet-access) is configured only from the
//      LaunchAgent's environment. A half-set or malformed pair must stop the server rather
//      than quietly leave the door shut or open it wider than intended, and the boot summary
//      must say which, without ever printing the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'studydeck-config-'));
process.env.STUDYDECK_LEARN_ROOT = FIXTURE_ROOT;
const { config, configSummary, parseTailnet } = await import('../lib/config.mjs');
rmSync(FIXTURE_ROOT, { recursive: true, force: true });

const CONFIG_MODULE = fileURLToPath(new URL('../lib/config.mjs', import.meta.url));
const ORIGIN = 'https://box.tail0000.ts.net:4310';
const USER = 'james@example.com';

const env = (origin, user) => ({
  ...(origin === undefined ? {} : { STUDYDECK_TAILSCALE_ORIGIN: origin }),
  ...(user === undefined ? {} : { STUDYDECK_TAILSCALE_USER: user }),
});

test('neither variable set means the tailnet door is off', () => {
  assert.equal(parseTailnet({}), null);
  assert.equal(parseTailnet(env('  ', '')), null, 'blank counts as unset');
});

test('one variable without the other is a configuration error', () => {
  assert.throws(() => parseTailnet(env(ORIGIN, undefined)), /STUDYDECK_TAILSCALE_ORIGIN and STUDYDECK_TAILSCALE_USER/);
  assert.throws(() => parseTailnet(env(undefined, USER)), /STUDYDECK_TAILSCALE_ORIGIN and STUDYDECK_TAILSCALE_USER/);
});

test('the origin must be a bare HTTPS origin', () => {
  for (const origin of [
    'http://box.tail0000.ts.net:4310',
    'https://box.tail0000.ts.net:4310/cockpit',
    'https://box.tail0000.ts.net:4310/?x=1',
    'https://box.tail0000.ts.net:4310/#x',
    'https://james:pw@box.tail0000.ts.net:4310',
    'box.tail0000.ts.net:4310',
    'not a url',
  ]) {
    assert.throws(() => parseTailnet(env(origin, USER)), /STUDYDECK_TAILSCALE_ORIGIN/, `${origin} should be refused`);
  }
});

test('a loopback origin is refused: it would put the local page behind the tailnet door', () => {
  // The guard checks the tailnet Host first, so a loopback value would demand the tailnet
  // header and an https Origin of the cockpit's own page.
  for (const origin of ['https://localhost:4310', 'https://127.0.0.1:4310', 'https://[::1]:4310', 'https://LOCALHOST:4310']) {
    assert.throws(() => parseTailnet(env(origin, USER)), /STUDYDECK_TAILSCALE_ORIGIN/, `${origin} should be refused`);
  }
});

test('a valid pair yields the origin, a lowercased host with its port, and the trimmed user', () => {
  assert.deepEqual(parseTailnet(env(' https://BOX.tail0000.ts.net:4310/ ', ` ${USER} `)), {
    origin: ORIGIN,
    host: 'box.tail0000.ts.net:4310',
    user: USER,
  });
});

test('the boot summary names the tailnet host and never the user', () => {
  const before = config.tailnet;
  try {
    config.tailnet = null;
    assert.equal(configSummary().tailnet, 'off');
    config.tailnet = { origin: ORIGIN, host: 'box.tail0000.ts.net:4310', user: USER };
    assert.equal(configSummary().tailnet, 'box.tail0000.ts.net:4310');
    assert.doesNotMatch(JSON.stringify(configSummary()), /james@example\.com/);
  } finally {
    config.tailnet = before;
  }
});

/** Import config.mjs in a fresh process with exactly these tailnet variables. */
function bootWith(tailnetEnv) {
  const childEnv = { ...process.env, STUDYDECK_LEARN_ROOT: tmpdir() };
  delete childEnv.STUDYDECK_TAILSCALE_ORIGIN;
  delete childEnv.STUDYDECK_TAILSCALE_USER;
  return spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(CONFIG_MODULE)})`], {
    env: { ...childEnv, ...tailnetEnv },
    encoding: 'utf8',
  });
}

test('a half-configured pair stops the server from loading its config', () => {
  // config.mjs loads at import, which is how server.mjs boots; a throw there is a refusal to
  // start, which is the point. A child process, because this one has already imported it.
  const half = bootWith(env(ORIGIN, undefined));
  assert.notEqual(half.status, 0);
  assert.match(half.stderr, /STUDYDECK_TAILSCALE_ORIGIN and STUDYDECK_TAILSCALE_USER/);

  assert.equal(bootWith({}).status, 0, 'neither set must still boot');
  assert.equal(bootWith(env(ORIGIN, USER)).status, 0, 'a valid pair must boot');
});
