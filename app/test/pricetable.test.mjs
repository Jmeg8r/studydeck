// WHAT: A config file written before the one-hour cache price existed still prices a
//       one-hour cache write at the one-hour rate.
// WHY: The spending limit compares a sum of costs against a dollar cap. A price left
//      undefined makes every cost NaN, which never exceeds the cap; a price read with the
//      wrong meaning under-counts. The fixture is the price table as main had it before
//      the change ("cacheWrite": 5, the five-minute rate, and nothing else), not today's.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LEGACY_PRICES = Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
const ONE_MILLION = 1_000_000;

const root = mkdtempSync(join(tmpdir(), 'studydeck-pricetable-'));
const configPath = join(root, 'cockpit.config.json');
const legacyConfig = JSON.parse(readFileSync(new URL('../cockpit.config.json', import.meta.url), 'utf8'));
legacyConfig.claude.pricePerMTok = { ...LEGACY_PRICES };
writeFileSync(configPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
process.env.STUDYDECK_CONFIG_PATH = configPath;

const { config } = await import('../lib/config.mjs');
const { estimateCostUsd } = await import('../lib/claude.mjs');

after(() => rmSync(root, { recursive: true, force: true }));

test('a legacy price table keeps its five-minute rate and gains the one-hour one', () => {
  const prices = config.claude.pricePerMTok;
  assert.equal(prices.cacheWrite, LEGACY_PRICES.cacheWrite, 'the legacy value keeps its meaning');
  assert.equal(prices.cacheWrite1h, prices.input * 2, 'the one-hour rate falls back to the built-in one');
});

test('a one-hour cache write under a legacy config is charged the one-hour rate', () => {
  const oneHour = estimateCostUsd({
    cache_creation_input_tokens: ONE_MILLION,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: ONE_MILLION },
  });
  assert.equal(oneHour, config.claude.pricePerMTok.input * 2);
  const unsplit = estimateCostUsd({ cache_creation_input_tokens: ONE_MILLION });
  assert.equal(unsplit, oneHour, 'a total with no breakdown is never priced below one hour');
});
