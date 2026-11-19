// WHAT: Re-apply the version-controlled podcast config to an Open Notebook instance.
// WHY:  The inverse of export.mjs — rebuilds ON's episode and speaker profiles from
//       app/podcast/profiles/*.json so a fresh (or drifted) ON reproduces the working
//       study-flow render. Portable model refs are resolved back to this instance's record
//       ids; profiles that already exist are updated in place, not duplicated.
//
// Usage:
//   node app/podcast/restore.mjs --dry-run   # show what would change, touch nothing
//   node app/podcast/restore.mjs             # apply
//
// Models are VERIFIED, not created: registering an ollama/openai_compatible model needs
// provider credentials and is environment-specific. If a referenced model is missing,
// restore stops and names it — register it in ON (or `/api/models/sync/<provider>`) first.
//
// Every reference is checked before the first write (restoreplan.mjs), and a dry run
// runs that same check, so a bad profile set changes nothing in ON.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as on from './on.mjs';
import { planRestore } from './restoreplan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(HERE, 'profiles');

const readJson = (name) => JSON.parse(readFileSync(join(PROFILES_DIR, name), 'utf8'));
const byName = (list) => new Map((list ?? []).map((p) => [p.name, p]));
const refLabel = (ref) => (ref && typeof ref === 'object' ? `${ref.provider}/${ref.name}` : ref);

/**
 * Restore `want` ({ episodes, speakers, models }) through `client` (on.mjs's functions,
 * injected so a test can record what is sent). Plans everything first; writes only when
 * the whole plan is valid, and never in a dry run.
 */
export async function runRestore(want, client, { dryRun = false, log = console.log } = {}) {
  const models = await client.listModels();
  const speakersNow = (await client.listSpeakerProfiles()) ?? [];
  const episodesNow = (await client.listEpisodeProfiles()) ?? [];
  const plan = planRestore(want, models, speakersNow, episodesNow);
  log(`Models: all ${want.models.length} referenced models are registered ✓`);

  // Speaker profiles first — episode profiles reference them by id, so they must exist
  // before we can resolve those references.
  const existingSpeakers = byName(speakersNow);
  for (const sp of plan.speakers) {
    const body = {
      name: sp.name,
      description: sp.description ?? '',
      speakers: sp.speakers,
      voice_model: sp.voice_model,
    };
    const existing = existingSpeakers.get(sp.name);
    log(`Speaker profile ${existing ? 'update' : 'create'}: ${sp.name}  (voices: ${sp.speakers.map((s) => s.voice_id).join(', ')})`);
    if (dryRun) continue;
    if (existing) await client.updateSpeakerProfile(existing.id, body);
    else await client.createSpeakerProfile(body);
  }

  // Re-read so episode profiles can resolve speaker_config NAME → the id ON just assigned.
  const speakerIdByName = new Map(
    (dryRun ? speakersNow : (await client.listSpeakerProfiles()) ?? []).map((p) => [p.name, p.id]),
  );

  const existingEpisodes = byName(episodesNow);
  for (const [i, ep] of plan.episodes.entries()) {
    const asWritten = want.episodes[i].outline_llm;
    const speakerId = speakerIdByName.get(ep.speaker_config);
    // The plan proved the speaker exists or was just written; ON not listing it now means
    // the write did not take, and sending its name instead of an id would be refused.
    if (!speakerId && !dryRun) {
      throw new Error(`episode profile "${ep.name}" references speaker "${ep.speaker_config}", which ON does not list after the speaker writes`);
    }
    const body = {
      name: ep.name,
      description: ep.description ?? '',
      speaker_config: speakerId ?? ep.speaker_config, // a dry run may not have its id yet
      default_briefing: ep.default_briefing,
      num_segments: ep.num_segments ?? null,
      // Preserve exactly what the snapshot holds — do NOT default null to "en". The stock
      // profiles ship with a null language and a faithful mirror keeps it that way.
      language: ep.language ?? null,
      max_tokens: ep.max_tokens ?? null,
      outline_llm: ep.outline_llm,
      transcript_llm: ep.transcript_llm,
    };
    const existing = existingEpisodes.get(ep.name);
    const modelNote = asWritten ? `outline/transcript: ${refLabel(asWritten)}` : 'no model set';
    log(`Episode profile ${existing ? 'update' : 'create'}: ${ep.name}  (speaker: ${ep.speaker_config}, ${modelNote})`);
    if (dryRun) continue;
    if (existing) await client.updateEpisodeProfile(existing.id, body);
    else await client.createEpisodeProfile(body);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const want = {
    episodes: readJson('episode-profiles.json'),
    speakers: readJson('speaker-profiles.json'),
    models: readJson('models.json'),
  };
  console.log(`${dryRun ? '[dry-run] ' : ''}Restoring podcast config to ${on.baseUrl}\n`);
  await runRestore(want, on, { dryRun });
  console.log(`\n${dryRun ? '[dry-run] no changes made. Re-run without --dry-run to apply.' : 'Restore complete.'}`);
}

// Run only as a CLI: a test imports runRestore and must start nothing.
const realOrNull = (path) => {
  try { return path ? realpathSync(path) : null; } catch { return null; }
};
if (realOrNull(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`Restore failed: ${err.message}`);
    process.exit(1);
  });
}
