// WHAT: Snapshot Open Notebook's podcast config into version-controlled JSON.
// WHY:  The working config — episode profiles, speaker profiles, the models they wire to —
//       lives only in ON's SurrealDB, so a rebuild loses it and the repo can't reproduce a
//       render. This dumps all of it to app/podcast/profiles/*.json with model record ids
//       resolved to portable { provider, type, name } refs, so the snapshot survives an ON
//       rebuild. Each file is replaced atomically: a crash mid-write leaves the old file
//       whole, not a truncated tracked file.
//
// Usage: node app/podcast/export.mjs
//
// Re-run this after changing any profile in ON, then commit the diff — the JSON is the
// source of truth the repo keeps; ON's SurrealDB is the live copy.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomicSync } from '../lib/atomic.mjs';
import {
  listModels, modelIndex, listEpisodeProfiles, listSpeakerProfiles, baseUrl,
} from './on.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(HERE, 'profiles');

/** Drop instance-specific and generated fields; ON assigns them fresh on restore. */
const VOLATILE = ['id', 'created', 'updated'];
const stripVolatile = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!VOLATILE.includes(k)) out[k] = v;
  }
  return out;
};

/**
 * Stable JSON: keys sorted so re-exports produce clean, reviewable diffs. Not
 * writeJsonAtomicSync: it keeps a .bak beside each file, and this directory is committed.
 */
function writeJson(name, data) {
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  writeFileAtomicSync(join(PROFILES_DIR, name), `${JSON.stringify(sortKeys(data), null, 2)}\n`);
}

async function main() {
  mkdirSync(PROFILES_DIR, { recursive: true });

  const models = await listModels();
  const { idToRef } = modelIndex(models);

  const episodesRaw = await listEpisodeProfiles();
  const speakersRaw = await listSpeakerProfiles();

  // Which models the profiles actually reference — the set a fresh ON must have registered.
  const usedModelIds = new Set();
  for (const e of episodesRaw) {
    if (e.outline_llm) usedModelIds.add(e.outline_llm);
    if (e.transcript_llm) usedModelIds.add(e.transcript_llm);
  }
  for (const s of speakersRaw) {
    if (s.voice_model) usedModelIds.add(s.voice_model);
  }

  // Episode profiles: model ids → portable refs, speaker reference kept by NAME (portable
  // across rebuilds), the redundant speaker_config id dropped.
  const episodes = episodesRaw.map((e) => {
    const clean = stripVolatile(e);
    clean.speaker_config = e.speaker_config_name ?? e.speaker_config; // store the name
    delete clean.speaker_config_name;
    clean.outline_llm = idToRef(e.outline_llm) ?? null;
    clean.transcript_llm = idToRef(e.transcript_llm) ?? null;
    return clean;
  });

  // Speaker profiles: voice_model id → portable ref.
  const speakers = speakersRaw.map((s) => {
    const clean = stripVolatile(s);
    clean.voice_model = idToRef(s.voice_model) ?? null;
    return clean;
  });

  const referencedModels = models
    .filter((m) => usedModelIds.has(m.id))
    .map(({ type, provider, name }) => ({ type, provider, name }))
    .sort((a, b) => `${a.type} ${a.name}`.localeCompare(`${b.type} ${b.name}`));

  writeJson('episode-profiles.json', episodes);
  writeJson('speaker-profiles.json', speakers);
  writeJson('models.json', referencedModels);

  console.log(`Exported from ${baseUrl}:`);
  console.log(`  ${episodes.length} episode profiles`);
  console.log(`  ${speakers.length} speaker profiles`);
  console.log(`  ${referencedModels.length} referenced models`);
  console.log(`Wrote app/podcast/profiles/*.json — review the diff and commit.`);
}

main().catch((err) => {
  console.error(`Export failed: ${err.message}`);
  process.exit(1);
});
