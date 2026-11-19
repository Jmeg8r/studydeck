// WHAT: Validate and resolve a podcast profile restore completely, before any write.
// WHY:  restore.mjs rewrites global Open Notebook config. Checking references while writing
//       left ON with new speakers and old episodes when a later episode was bad, and sent
//       null for a model it could not resolve, which clears that profile's LLM. Planning
//       first means a bad profile set stops the run before its first POST or PUT, and a dry
//       run fails exactly where the real run would.
import { modelIndex } from './on.mjs';

const isName = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Resolve every reference in `want` ({ episodes, speakers, models }) against the models
 * registered in ON (`available`) and the profiles ON already holds. Returns the speakers
 * and episodes with model refs replaced by record ids; throws, naming the problem, before
 * returning anything if any reference is missing, ambiguous or malformed. A model ref the
 * JSON leaves unset stays undefined, so restore sends no key and ON keeps what it has.
 */
export function planRestore(want, available, existingSpeakers = [], existingEpisodes = []) {
  const { episodes, speakers, models: required } = want;
  const lists = { episodes, speakers, models: required, available, existingSpeakers, existingEpisodes };
  for (const [label, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) throw new Error(`${label} must be an array`);
  }
  for (const [label, list] of Object.entries({ episodes, speakers, existingSpeakers, existingEpisodes })) {
    const names = list.map((p) => p.name);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dupes.length) throw new Error(`${label} has duplicate names: ${dupes.join(', ')}`);
  }

  const { refToId } = modelIndex(available);
  const unregistered = required.filter((m) => !refToId(m.type, m));
  if (unregistered.length) {
    throw new Error(
      `these referenced models are not registered in ON: ${unregistered.map((m) => `${m.type} ${m.provider}/${m.name}`).join('; ')}. `
      + 'Register them in ON first (Models page, or POST /api/models/sync/<provider>), then re-run.',
    );
  }

  // A legacy plain name is read through models.json, which records its provider. A name
  // listed there under two providers cannot say which one it meant.
  const resolveModel = (type, ref, owner) => {
    if (!ref) return undefined;
    let portable = ref;
    if (typeof ref === 'string') {
      const listed = required.filter((m) => m.type === type && m.name === ref);
      if (listed.length > 1) {
        throw new Error(`${owner}: ambiguous model ${type}/${ref}, listed in models.json under ${listed.map((m) => m.provider).join(', ')}`);
      }
      portable = listed[0] ?? ref;
    }
    const id = refToId(type, portable);
    if (!id) throw new Error(`${owner}: model ${type}/${typeof ref === 'string' ? ref : `${ref.provider}/${ref.name}`} is not registered in ON`);
    return id;
  };

  const plannedSpeakers = speakers.map((s) => {
    const voicesOk = Array.isArray(s.speakers) && s.speakers.length > 0
      && s.speakers.every((v) => isName(v?.name) && isName(v?.voice_id));
    if (!isName(s.name) || !voicesOk) {
      throw new Error(`speaker profile ${JSON.stringify(s.name)} needs a name and speakers that each have a name and a voice_id`);
    }
    return { ...s, voice_model: resolveModel('text_to_speech', s.voice_model, `speaker profile ${s.name}`) };
  });

  const speakerNames = new Set([...speakers, ...existingSpeakers].map((s) => s.name));
  const plannedEpisodes = episodes.map((e) => {
    if (!isName(e.name)) throw new Error(`episode profile ${JSON.stringify(e.name)} needs a name`);
    if (!speakerNames.has(e.speaker_config)) {
      throw new Error(`episode profile ${e.name} references missing speaker ${e.speaker_config}`);
    }
    const owner = `episode profile ${e.name}`;
    return {
      ...e,
      outline_llm: resolveModel('language', e.outline_llm, owner),
      transcript_llm: resolveModel('language', e.transcript_llm, owner),
    };
  });

  return { speakers: plannedSpeakers, episodes: plannedEpisodes };
}
