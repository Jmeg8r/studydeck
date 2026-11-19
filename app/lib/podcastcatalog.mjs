// Open Notebook episodes have no notebook id. Match names only when one configured
// notebook owns the source or a recorded StudyDeck generation operation.
import { chapterName, episodeNameFor } from './podcastbatch.mjs';

export function episodeNotebookIndex(topics) {
  const candidates = new Map();
  const add = (name, notebookId) => {
    if (!name) return;
    if (!candidates.has(name)) candidates.set(name, new Set());
    candidates.get(name).add(notebookId);
  };

  for (const { slug, notebookId, sources = [], operations = [] } of topics) {
    for (const source of sources) {
      add(episodeNameFor(slug, source.id, source.title), notebookId);
      // Episodes made before the identity tag can be assigned by title only when
      // that title belongs to exactly one notebook.
      add(source.title, notebookId);
    }
    for (const operation of operations) {
      if (operation.kind === 'podcast_episode' || operation.kind === 'podcast_standalone') {
        add(operation.local_result?.episode_name, notebookId);
      }
    }
  }

  return new Map([...candidates].map(([name, owners]) => [
    name, owners.size === 1 ? owners.values().next().value : null,
  ]));
}

/**
 * The notebook an episode belongs to, or null.
 *
 * A rendition the ledger does not record (made elsewhere, or before it was kept) is still
 * that chapter's recording, so it falls back to the chapter name its sources produce.
 */
export function notebookForEpisode(index, name) {
  return index.get(name) ?? index.get(chapterName(name)) ?? null;
}
